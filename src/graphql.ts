import type { ServerConfig } from "./config.js";
import type { ToolDefinition } from "./tools.js";

/**
 * A single passthrough tool for HubSpot's **CRM GraphQL API**
 * (`POST /collector/graphql`), which sits alongside the REST API and lets you
 * fetch exactly the fields and associations you want in one round-trip —
 * often replacing several REST calls (e.g. a contact, its company, and that
 * company's deals in a single query).
 *
 * HubSpot's public GraphQL endpoint is **query-only** — it exposes no
 * mutations — so unlike a generic GraphQL passthrough this tool is genuinely
 * read-only and stays available in HUBSPOT_READ_ONLY mode. It requires the
 * `collector.graphql_query.execute` scope and a *Content Hub or Marketing Hub
 * Professional/Enterprise* subscription (HubSpot gates the GraphQL collector
 * behind those plans).
 */
export const GRAPHQL_TOOL_NAME = "hubspot_graphql_query";

export function graphqlTool(cfg: ServerConfig): ToolDefinition {
  const description = [
    "🟢 READ-ONLY · query · CRM GraphQL · POST /collector/graphql",
    "Run a GraphQL query against HubSpot's CRM data graph and return the JSON result. Fetches records, properties and associations across objects in one round-trip — use it when a REST tool would need several calls or returns too much.",
    "HubSpot's GraphQL endpoint supports queries only (no mutations), so this cannot change account data. " +
      `Endpoint: ${cfg.graphqlUrl}. ` +
      "Plan: Marketing Hub or Content Hub Professional/Enterprise. Scopes: collector.graphql_query.execute. " +
      "Not available with a HubSpot service key; it needs a private app or OAuth token. " +
      'Example: {"query": "query { CRM { contact_collection(limit: 3) { items { email firstname associations { company_collection__primary { items { name } } } } } } }"}',
  ].join("\n\n");

  return {
    name: GRAPHQL_TOOL_NAME,
    description,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The GraphQL query document (queries only — HubSpot exposes no mutations)." },
        variables: {
          type: "object",
          description: "Optional variables object referenced by the query.",
          additionalProperties: true,
        },
        operationName: {
          type: "string",
          description: "Optional operation name when the document defines several.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: {
      title: "Run a HubSpot CRM GraphQL query",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    operation: null,
  };
}

export async function callGraphql(
  cfg: ServerConfig,
  rawArgs: unknown,
): Promise<{ status: number; ok: boolean; body: unknown }> {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const query = args.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error('The "query" argument is required and must be a non-empty GraphQL string.');
  }
  const fetchImpl = cfg.fetchImpl ?? fetch;

  const payload: Record<string, unknown> = { query };
  if (args.variables !== undefined) payload.variables = args.variables;
  if (typeof args.operationName === "string") payload.operationName = args.operationName;

  if (cfg.rateLimiter) await cfg.rateLimiter.acquire();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetchImpl(cfg.graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${cfg.accessToken}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw text */
    }
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(timer);
  }
}
