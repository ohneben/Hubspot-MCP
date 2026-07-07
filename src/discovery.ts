import type { ServerConfig } from "./config.js";
import type { ToolDefinition } from "./tools.js";

/**
 * Discovery mode (`HUBSPOT_TOOL_MODE=discovery`).
 *
 * The full tool surface is ~1,000 tools. Most MCP hosts handle that fine —
 * and group filtering trims it — but some clients (or very long sessions)
 * prefer a tiny tool list. Discovery mode exposes the SAME registry through
 * three meta-tools instead of one tool per endpoint:
 *
 *   1. hubspot_search_endpoints — find endpoints by keyword/group/category
 *   2. hubspot_get_endpoint     — read one endpoint's full schema
 *   3. hubspot_invoke_endpoint  — call it
 *
 * Every include/exclude/read-only filter still applies: in read-only mode the
 * registry only contains 🟢 tools, so `invoke` physically cannot reach a
 * write. Three tools, zero coverage lost.
 */
export const SEARCH_ENDPOINTS_TOOL = "hubspot_search_endpoints";
export const GET_ENDPOINT_TOOL = "hubspot_get_endpoint";
export const INVOKE_ENDPOINT_TOOL = "hubspot_invoke_endpoint";

const DEFAULT_PAGE_SIZE = 40;
const MAX_PAGE_SIZE = 100;

export function discoveryTools(cfg: ServerConfig, registrySize: number): ToolDefinition[] {
  const search: ToolDefinition = {
    name: SEARCH_ENDPOINTS_TOOL,
    description: [
      "🟢 READ-ONLY · endpoint catalog search",
      `Search this server's registry of ${registrySize} HubSpot endpoints by keyword, group, area or safety category. Returns one compact line per endpoint (name, method+path, category, plan tier).`,
      `Workflow: search here → ${GET_ENDPOINT_TOOL} for the input schema → ${INVOKE_ENDPOINT_TOOL} to call it.`,
    ].join("\n\n"),
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: 'Keywords matched against name, path, API name and summary (e.g. "create deal", "hubdb rows").',
        },
        group: { type: "string", description: 'Exact group key filter (e.g. "contacts", "marketing-emails").' },
        area: { type: "string", description: 'HubSpot area filter (e.g. "CRM", "CMS", "Marketing").' },
        category: {
          type: "string",
          enum: ["read", "query", "create", "upsert", "update", "link", "unlink", "send", "import", "delete", "bulk_delete", "merge", "purge"],
          description: "Safety-category filter.",
        },
        limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE, description: `Page size (default ${DEFAULT_PAGE_SIZE}).` },
        offset: { type: "integer", minimum: 0, description: "Pagination offset (default 0)." },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Search the HubSpot endpoint catalog",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    operation: null,
  };

  const get: ToolDefinition = {
    name: GET_ENDPOINT_TOOL,
    description: [
      "🟢 READ-ONLY · endpoint details",
      `Return one endpoint's full description, safety category, plan/scope requirements and JSON input schema. Use the exact tool name from ${SEARCH_ENDPOINTS_TOOL}.`,
    ].join("\n\n"),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: `Endpoint tool name exactly as returned by ${SEARCH_ENDPOINTS_TOOL}.` },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: {
      title: "Get a HubSpot endpoint's schema",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    operation: null,
  };

  const invoke: ToolDefinition = {
    name: INVOKE_ENDPOINT_TOOL,
    description: [
      cfg.readOnly ? "🟢 READ-ONLY · invoke a catalog endpoint" : "🟡 WRITE-CAPABLE · invoke a catalog endpoint",
      `Call any endpoint in the registry by name with arguments matching its input schema (fetch it first via ${GET_ENDPOINT_TOOL}).`,
      cfg.readOnly
        ? "The server runs in read-only mode, so only 🟢 read-only endpoints exist in the registry — this tool cannot change account data."
        : "The registry includes 🟡 write and 🔴 destructive endpoints. Check the endpoint's banner first and confirm with the user before any destructive call (delete / merge / GDPR purge / send).",
    ].join("\n\n"),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Endpoint tool name from the catalog." },
        arguments: {
          type: "object",
          description: "Arguments matching the endpoint's input schema.",
          additionalProperties: true,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: {
      title: "Invoke a HubSpot endpoint by name",
      readOnlyHint: cfg.readOnly,
      destructiveHint: !cfg.readOnly,
      idempotentHint: false,
      openWorldHint: true,
    },
    operation: null,
  };

  return [search, get, invoke];
}

/* ───────────────────────── handlers ───────────────────────── */

function summaryLine(t: ToolDefinition): string {
  const op = t.operation;
  if (!op) return t.name;
  const plan = op.entry.beta ? " · beta" : "";
  return `${t.name} — ${op.method.toUpperCase()} ${op.path} — ${t.category} — ${op.entry.name} (${op.entry.area})${plan}`;
}

export function handleSearchEndpoints(registry: ToolDefinition[], rawArgs: unknown): string {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const query = typeof args.query === "string" ? args.query.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const group = typeof args.group === "string" ? args.group.toLowerCase() : undefined;
  const area = typeof args.area === "string" ? args.area.toLowerCase() : undefined;
  const category = typeof args.category === "string" ? args.category : undefined;
  const limit = Math.min(Math.max(Number(args.limit) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const offset = Math.max(Number(args.offset) || 0, 0);

  const matches = registry.filter((t) => {
    const op = t.operation;
    if (!op) return false;
    if (group && op.group.toLowerCase() !== group) return false;
    if (area && op.entry.area.toLowerCase() !== area) return false;
    if (category && t.category !== category) return false;
    if (query.length > 0) {
      const haystack = `${t.name} ${op.method} ${op.path} ${op.entry.name} ${op.summary ?? ""}`.toLowerCase();
      if (!query.every((q) => haystack.includes(q))) return false;
    }
    return true;
  });

  const page = matches.slice(offset, offset + limit);
  const lines = page.map(summaryLine);
  const header = `${matches.length} endpoint(s) matched; showing ${offset + 1}–${offset + page.length}.`;
  const footer =
    matches.length > offset + page.length
      ? `\n…more available — repeat with offset=${offset + page.length}.`
      : "";
  return `${header}\n\n${lines.join("\n")}${footer}\n\nNext: call ${GET_ENDPOINT_TOOL} with a name to see its input schema.`;
}

export function handleGetEndpoint(registry: Map<string, ToolDefinition>, rawArgs: unknown): string {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const name = String(args.name ?? "");
  const tool = registry.get(name);
  if (!tool || !tool.operation) {
    throw new Error(`Unknown endpoint "${name}". Find valid names with ${SEARCH_ENDPOINTS_TOOL}.`);
  }
  return [
    `# ${tool.name}`,
    tool.description,
    `Input schema (JSON Schema):`,
    JSON.stringify(tool.inputSchema, null, 2),
  ].join("\n\n");
}
