import type { ServerConfig } from "./config.js";
import type { Operation } from "./openapi.js";
import { formatRequirements } from "./specs.js";

export interface CallResult {
  status: number;
  ok: boolean;
  contentType: string | null;
  body: unknown;
  rawBody: string;
  /** Number of retries performed before this response was returned. */
  attempts: number;
  /** A HubSpot-specific troubleshooting hint for error responses. */
  hint?: string;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}

/** Exponential backoff with full jitter, capped, so retries don't thunder. */
function backoffDelay(attempt: number, base = 500, cap = 8000): number {
  const ceiling = Math.min(cap, base * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

/** The input-schema key a parameter's value arrives under (see ParameterSpec.argName). */
const argKey = (p: { name: string; argName?: string }): string => p.argName ?? p.name;

function expandPath(op: Operation, args: Record<string, unknown>, consumed: Set<string>): string {
  const pathParams = new Map(op.parameters.filter((p) => p.in === "path").map((p) => [p.name, p]));
  return op.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const key = pathParams.has(name) ? argKey(pathParams.get(name)!) : name;
    if (!(key in args)) throw new Error(`Missing required path parameter "${key}".`);
    consumed.add(key);
    const v = args[key];
    if (v === null || v === undefined) throw new Error(`Path parameter "${key}" cannot be null/undefined.`);
    return encodeURIComponent(String(v));
  });
}

function buildQueryString(op: Operation, args: Record<string, unknown>, consumed: Set<string>): string {
  const usp = new URLSearchParams();
  for (const p of op.parameters) {
    if (p.in !== "query") continue;
    const key = argKey(p);
    if (consumed.has(key)) continue;
    const value = args[key];
    if (value === undefined || value === null) continue;
    consumed.add(key);
    if (p.dynamicPrefix && typeof value === "object" && !Array.isArray(value)) {
      // Template params (`objectProperty.{propname}`): one pair per entry.
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined || v === null) continue;
        usp.append(`${p.dynamicPrefix}${k}`, String(v));
      }
    } else if (Array.isArray(value)) {
      // HubSpot list params (properties, associations, …) repeat the key.
      const explode = p.explode !== false;
      if (explode) for (const v of value) usp.append(p.name, String(v));
      else usp.append(p.name, value.map((v) => String(v)).join(","));
    } else if (typeof value === "object") {
      usp.append(p.name, JSON.stringify(value));
    } else {
      usp.append(p.name, String(value));
    }
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

function collectExtraHeaders(op: Operation, args: Record<string, unknown>, consumed: Set<string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const p of op.parameters) {
    if (p.in !== "header") continue;
    const key = argKey(p);
    if (consumed.has(key)) continue;
    const value = args[key];
    if (value === undefined || value === null) continue;
    consumed.add(key);
    headers[p.name] = String(value);
  }
  return headers;
}

/** A multipart field carrying binary/file content. */
interface FilePart {
  fileName?: string;
  contentBase64?: string;
  content?: string;
  contentType?: string;
}

function isFilePart(v: unknown): v is FilePart {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (typeof (v as FilePart).contentBase64 === "string" || typeof (v as FilePart).content === "string") &&
    ((v as FilePart).fileName === undefined || typeof (v as FilePart).fileName === "string")
  );
}

/**
 * Encode a tool's `body` argument for the operation's content type. Returns
 * the fetch body plus the Content-Type header to send (FormData sets its own
 * multipart boundary, so its content type is `undefined`).
 */
export function encodeBody(
  contentType: string,
  body: unknown,
): { payload: BodyInit; contentTypeHeader?: string } {
  if (contentType === "multipart/form-data") {
    const form = new FormData();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        if (value === undefined || value === null) continue;
        if (isFilePart(value)) {
          const part = value;
          const bytes = part.contentBase64 !== undefined
            ? Buffer.from(part.contentBase64, "base64")
            : Buffer.from(part.content ?? "", "utf8");
          const blob = new Blob([bytes], { type: part.contentType ?? "application/octet-stream" });
          form.append(key, blob, part.fileName ?? key);
        } else if (typeof value === "object") {
          // HubSpot expects JSON-valued form fields (e.g. `options`) as strings.
          form.append(key, JSON.stringify(value));
        } else {
          form.append(key, String(value));
        }
      }
    }
    return { payload: form };
  }

  if (contentType === "application/x-www-form-urlencoded") {
    const usp = new URLSearchParams();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        if (value === undefined || value === null) continue;
        usp.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
    }
    return { payload: usp.toString(), contentTypeHeader: contentType };
  }

  if (contentType.startsWith("text/")) {
    return { payload: typeof body === "string" ? body : JSON.stringify(body), contentTypeHeader: contentType };
  }

  return {
    payload: typeof body === "string" ? body : JSON.stringify(body),
    contentTypeHeader: contentType,
  };
}

async function fetchWithResilience(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  cfg: ServerConfig,
  useSearchLimiter: boolean,
): Promise<{ response: Response; attempts: number }> {
  const maxRetries = cfg.maxRetries;
  const timeoutMs = cfg.timeoutMs;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (cfg.rateLimiter) await cfg.rateLimiter.acquire();
    if (useSearchLimiter && cfg.searchRateLimiter) await cfg.searchRateLimiter.acquire();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
        const wait = parseRetryAfter(response.headers.get("retry-after")) ?? backoffDelay(attempt);
        await response.text().catch(() => undefined); // drain so the socket is reusable
        await sleep(wait);
        continue;
      }

      return { response, attempts: attempt };
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === "AbortError";
      lastError = isAbort ? new Error(`Request timed out after ${timeoutMs}ms.`) : err;
      if (attempt < maxRetries) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error("Request failed after exhausting retries.");
}

/** Pull HubSpot's error `category` / `message` out of a parsed error body. */
function errorCategory(body: unknown): { category?: string; message?: string } {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  return {
    category: typeof b.category === "string" ? b.category : undefined,
    message: typeof b.message === "string" ? b.message : undefined,
  };
}

/**
 * Turn common HubSpot error responses into an actionable hint. HubSpot's raw
 * errors say *what* failed; these add *how to fix it* (which scope to grant,
 * which plan the API needs, how tokens expire) so the model can help instead
 * of flailing.
 */
export function buildHint(op: Operation | null, status: number, body: unknown): string | undefined {
  const { category } = errorCategory(body);

  if (status === 401) {
    return (
      "Your HUBSPOT_ACCESS_TOKEN was rejected. Service keys and private app tokens (pat-…) come from " +
      "Settings → Integrations → Service Keys (or Private Apps) and only stop working when " +
      "rotated past their grace period or revoked; " +
      "OAuth access tokens expire after ~30 minutes and must be refreshed. Also check you are " +
      "pointing at the right region base URL (api.hubapi.com vs api-eu1.hubapi.com)."
    );
  }

  if (status === 403 && category === "MISSING_SCOPES") {
    const alts = op?.scopeAlternatives ?? [];
    const scopeText =
      alts.length > 0
        ? `This endpoint needs ${alts.map((a) => a.join(" + ")).join(", or ")}.`
        : "Check the endpoint's required scopes in the tool description.";
    return (
      `The token is valid but missing a required scope. ${scopeText} ` +
      "For a service key: HubSpot → Settings → Integrations → Service Keys → your key, add the scope. " +
      "For a private app: Settings → Integrations → Private Apps → your app → Scopes, add the scope " +
      "and re-copy the token. For OAuth: add the scope to the app and re-authorize. " +
      "The hubspot_get_capabilities tool shows which scopes this token has."
    );
  }

  if (status === 403) {
    const plan = op ? formatRequirements(op.entry.requirements) : undefined;
    const planText = plan && !plan.startsWith("any") ? ` This API requires ${plan} — your portal's subscription may not include it.` : "";
    return (
      `HubSpot refused the call (${category ?? "403"}).${planText} ` +
      "Run hubspot_get_capabilities to see your portal's plan, granted scopes and API usage."
    );
  }

  if (status === 404 && op?.entry.beta) {
    return (
      "This is a beta/developer-preview API — a 404 can mean the feature is not enabled for " +
      "your portal (some betas require opt-in) or the route changed. Check the tool description's docs link."
    );
  }

  if (status === 429) {
    return (
      "Rate limited even after automatic retries. HubSpot burst limits are per 10 s per app " +
      "(plus a separate ~5 req/s cap on search endpoints) and daily caps apply per plan. " +
      "Lower HUBSPOT_MAX_REQUESTS or wait — hubspot_get_capabilities reports today's API usage."
    );
  }

  if (status === 400 && category === "VALIDATION_ERROR") {
    return "HubSpot rejected the payload. Compare the arguments against the tool's input schema — property names are case-sensitive and enum values must match exactly.";
  }

  return undefined;
}

/** Resolve the full request URL for an operation. */
export function buildUrl(cfg: ServerConfig, op: Operation, expandedPath: string, query: string): string {
  return `${cfg.baseUrl}${op.serverPath}${expandedPath}${query}`;
}

const isSearchPath = (path: string) => /\/search$/i.test(path);

export async function callOperation(cfg: ServerConfig, op: Operation, rawArgs: unknown): Promise<CallResult> {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const fetchImpl = cfg.fetchImpl ?? fetch;

  const consumed = new Set<string>();
  const expandedPath = expandPath(op, args, consumed);
  const query = buildQueryString(op, args, consumed);
  const extraOpHeaders = collectExtraHeaders(op, args, consumed);

  const headers: Record<string, string> = {
    Accept: "application/json, */*;q=0.8",
    Authorization: `Bearer ${cfg.accessToken}`,
    ...extraOpHeaders,
  };

  let body: BodyInit | undefined;
  if (op.requestBodySchema && args.body !== undefined) {
    const { payload, contentTypeHeader } = encodeBody(op.requestBodyContentType ?? "application/json", args.body);
    body = payload;
    if (contentTypeHeader) headers["Content-Type"] = contentTypeHeader;
  }

  const url = buildUrl(cfg, op, expandedPath, query);

  const { response, attempts } = await fetchWithResilience(
    fetchImpl,
    url,
    { method: op.method.toUpperCase(), headers, body },
    cfg,
    isSearchPath(op.path),
  );

  const rawBody = await response.text();
  const contentType = response.headers.get("content-type");
  let parsedBody: unknown = rawBody;
  if (contentType && contentType.includes("application/json") && rawBody.length > 0) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = rawBody;
    }
  }

  return {
    status: response.status,
    ok: response.ok,
    contentType,
    body: parsedBody,
    rawBody,
    attempts,
    hint: response.ok ? undefined : buildHint(op, response.status, parsedBody),
  };
}

// Exposed for unit tests.
export const __test = { parseRetryAfter, backoffDelay, buildQueryString, expandPath, isSearchPath, RETRYABLE_STATUS };
