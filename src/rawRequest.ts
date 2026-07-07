import type { ServerConfig } from "./config.js";
import type { ToolDefinition } from "./tools.js";

/**
 * The escape hatch: call ANY path under the configured HubSpot API host, with
 * the server still injecting auth, throttling, timing out and retrying.
 *
 * The ~1,000 generated tools cover every documented endpoint, but HubSpot
 * ships new APIs and betas continuously — this tool means the assistant is
 * never stuck waiting for a spec refresh. It can perform any method including
 * DELETE, so it carries `destructiveHint: true` (hosts should confirm before
 * running it) and it is hidden entirely in HUBSPOT_READ_ONLY mode.
 */
export const RAW_REQUEST_TOOL_NAME = "hubspot_api_request";

export function rawRequestTool(cfg: ServerConfig): ToolDefinition {
  const description = [
    "🔴 ADVANCED · raw HubSpot API request",
    "Perform an arbitrary HTTP request against the HubSpot API host — the escape hatch for brand-new or beta endpoints that don't have a dedicated tool (yet). Auth, rate limiting, timeouts and retries are still handled server-side.",
    `Host is fixed to ${cfg.baseUrl}; pass only the path (e.g. "/crm/v3/objects/contacts"). ` +
      "PREFER the dedicated tools: they carry accurate schemas and safety categories. " +
      "This tool can execute ANY method, including destructive ones — state the method and path clearly and get user confirmation for writes/deletes.",
  ].join("\n\n");

  return {
    name: RAW_REQUEST_TOOL_NAME,
    description,
    inputSchema: {
      type: "object",
      properties: {
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "HTTP method.",
        },
        path: {
          type: "string",
          description: 'API path starting with "/", e.g. "/crm/v3/objects/contacts". The host is fixed server-side.',
        },
        query: {
          type: "object",
          description: "Optional query parameters. Array values are repeated (properties=a&properties=b).",
          additionalProperties: true,
        },
        body: {
          description: "Optional request body. Objects are sent as JSON (or as form fields for form content types).",
        },
        contentType: {
          type: "string",
          description: "Request body content type (default application/json).",
        },
      },
      required: ["method", "path"],
      additionalProperties: false,
    },
    annotations: {
      title: "Raw HubSpot API request (any endpoint)",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    operation: null,
  };
}

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function callRawRequest(
  cfg: ServerConfig,
  rawArgs: unknown,
): Promise<{ status: number; ok: boolean; body: unknown }> {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;

  const method = String(args.method ?? "").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`"method" must be one of ${[...ALLOWED_METHODS].join(", ")}.`);
  }

  const path = String(args.path ?? "");
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) {
    throw new Error('"path" must be an absolute API path starting with "/" (no host, no "..").');
  }

  const url = new URL(cfg.baseUrl + path);
  if (url.origin !== cfg.baseUrl) {
    throw new Error(`Path escapes the configured HubSpot host (${cfg.baseUrl}).`);
  }
  if (args.query && typeof args.query === "object") {
    for (const [key, value] of Object.entries(args.query as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) for (const v of value) url.searchParams.append(key, String(v));
      else if (typeof value === "object") url.searchParams.append(key, JSON.stringify(value));
      else url.searchParams.append(key, String(value));
    }
  }

  const headers: Record<string, string> = {
    Accept: "application/json, */*;q=0.8",
    Authorization: `Bearer ${cfg.accessToken}`,
  };
  let body: string | undefined;
  if (args.body !== undefined && method !== "GET") {
    const contentType = typeof args.contentType === "string" ? args.contentType : "application/json";
    headers["Content-Type"] = contentType;
    body =
      contentType === "application/x-www-form-urlencoded" && typeof args.body === "object" && args.body !== null
        ? new URLSearchParams(
            Object.entries(args.body as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          ).toString()
        : typeof args.body === "string"
          ? args.body
          : JSON.stringify(args.body);
  }

  const fetchImpl = cfg.fetchImpl ?? fetch;
  const isSearch = /\/search$/i.test(url.pathname);

  let lastError: unknown;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (cfg.rateLimiter) await cfg.rateLimiter.acquire();
    if (isSearch && cfg.searchRateLimiter) await cfg.searchRateLimiter.acquire();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetchImpl(url.toString(), { method, headers, body, signal: controller.signal });
      clearTimeout(timer);
      if (RETRYABLE_STATUS.has(res.status) && attempt < cfg.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await res.text().catch(() => undefined);
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep raw text */
      }
      return { status: res.status, ok: res.ok, body: parsed };
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === "AbortError";
      lastError = isAbort ? new Error(`Request timed out after ${cfg.timeoutMs}ms.`) : err;
      if (attempt < cfg.maxRetries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error("Request failed after exhausting retries.");
}
