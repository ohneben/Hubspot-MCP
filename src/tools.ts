import { categoryForOperation, safetyBucket, type CategoryId } from "./categories.js";
import type { JsonSchema, Operation, ParameterSpec } from "./openapi.js";
import { formatRequirements } from "./specs.js";

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  /** The REST operation this tool proxies, or `null` for special tools. */
  operation: Operation | null;
  group?: string;
  category?: CategoryId;
}

export interface ToolFilterOptions {
  includeGroups?: Set<string>;
  excludeGroups?: Set<string>;
  readOnly?: boolean;
  includeBeta?: boolean;
}

const MCP_TOOL_NAME_MAX = 64;

export function snakeCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

/* ────────────────────────── tool naming ──────────────────────────
 *
 * HubSpot's generated operationIds look like
 *   `get-/crm/v3/objects/calls_getPage`
 * — method + full path, sometimes followed by `_<sdkMethodName>`. Using them
 * verbatim would produce miserable tool names, so we derive our own:
 *
 *   <api-slug> + <distinguishing path segments> + <action verb>
 *   e.g.  contacts_list, contacts_batch_read, hubdb_tables_rows_get,
 *         pages_landing_pages_publish? → pages_landing_pages_push_live
 *
 * The verb comes from (in order): a trailing action segment in the path
 * (`/search`, `/merge`, `/gdpr-delete`, …), the operationId's SDK suffix
 * (`getPage` → list, `getById` → get), or an HTTP-method default. Noise
 * segments (product area, versions, `objects`, numeric object-type IDs, the
 * API's own name) are dropped — the slug prefix already carries them.
 */

/** Trailing path segments that ARE the action (non-GET only). */
const ACTION_SEGMENTS = new Set([
  "search",
  "merge",
  "gdpr-delete",
  "cancel",
  "revoke",
  "introspect",
  "add",
  "remove",
  "add-and-remove",
  "upsert",
  "archive",
  "read",
  "create",
  "update",
  "clone",
  "publish",
  "unpublish",
  "push-live",
  "reset",
  "restore",
  "restore-to-draft",
  "send",
  "single-send",
  "validate",
  "subscribe",
  "unsubscribe",
  "import",
  "purge",
]);

/** SDK-style suffix → friendlier verb. */
const SUFFIX_NORMALIZE: Record<string, string> = {
  get_page: "list",
  get_all: "list",
  get_by_id: "get",
  do_search: "search",
};

/** Param names that read as record identifiers (trailing `{param}` ⇒ "get"). */
const ID_PARAM = /(id|ids|token|key|name|slug|path|date|guid|url)s?$/i;

function parseSuffix(operationId: string, path: string): string | undefined {
  const at = operationId.lastIndexOf("_");
  if (at === -1) return undefined;
  const tail = operationId.slice(at + 1);
  if (!tail || tail.includes("/") || tail === path) return undefined;
  return tail;
}

/** Letters-only form for fuzzy segment-vs-slug comparison. */
const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const singular = (s: string) => s.replace(/s$/, "");

function isNoiseSegment(seg: string, slugTokens: string[], first: boolean): boolean {
  if (first) return true; // leading product area (crm, cms, marketing, …)
  if (/^v\d+$/i.test(seg)) return true; // version segments
  if (/^\d{4}-\d{2}(-beta)?$/.test(seg)) return true; // dated versions
  if (seg === "objects") return true;
  if (/^\d+-\d+$/.test(seg)) return true; // numeric object type ids (0-3 = deals)
  const l = letters(seg);
  if (slugTokens.some((t) => singular(letters(t)) === singular(l))) return true;
  // e.g. "videoconferencing" == "video"+"conferencing" from the slug
  let prefix = "";
  for (const t of slugTokens) {
    prefix += letters(t);
    if (singular(l) === singular(prefix)) return true;
  }
  return false;
}

export function toolNameForOperation(op: Operation): string {
  const slugTokens = op.entry.slug.split("-").filter(Boolean);
  const rawSegments = op.path.split("/").filter(Boolean);

  const staticSegments: string[] = [];
  let trailingParam: string | undefined;
  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i];
    if (seg.startsWith("{")) {
      if (i === rawSegments.length - 1) trailingParam = seg.slice(1, -1);
      continue;
    }
    if (!isNoiseSegment(seg, slugTokens, i === 0)) staticSegments.push(seg);
  }

  // 1) trailing action segment (non-GET) dictates the verb
  let verb: string | undefined;
  const last = rawSegments[rawSegments.length - 1];
  if (op.method !== "get" && last && !last.startsWith("{") && ACTION_SEGMENTS.has(last.toLowerCase())) {
    verb = snakeCase(last);
    const idx = staticSegments.lastIndexOf(last);
    if (idx !== -1) staticSegments.splice(idx, 1);
  }

  // 2) SDK suffix from the operationId
  if (!verb) {
    const suffix = parseSuffix(op.operationId, op.path);
    if (suffix) {
      const snaked = snakeCase(suffix);
      verb = SUFFIX_NORMALIZE[snaked] ?? snaked;
      // Drop a trailing segment the suffix already describes (batch/read + `read`).
      const lastStatic = staticSegments[staticSegments.length - 1];
      if (lastStatic && snakeCase(lastStatic) === verb) staticSegments.pop();
    }
  }

  // 3) HTTP-method default
  if (!verb) {
    switch (op.method) {
      case "get":
        if (trailingParam) {
          verb = ID_PARAM.test(trailingParam) ? "get" : "list";
        } else {
          // Trailing static segment: `/…/{id}/memberships` reads as a
          // collection (plural), `/…/{id}/download` as a single resource.
          const tail = staticSegments[staticSegments.length - 1];
          verb = !tail || /s$/i.test(tail) ? "list" : "get";
        }
        break;
      case "post":
        verb = "create";
        break;
      case "put":
      case "patch":
        verb = "update";
        break;
      case "delete":
        verb = "delete";
        break;
      default:
        verb = op.method;
    }
  }

  // Flatten to word tokens and drop repeats (keep first occurrence) — the SDK
  // suffix often restates path segments (`…/import-from-url/async` +
  // `importFromUrl` would otherwise yield `…_import_from_url_async_import_from_url`).
  const words = [...slugTokens, ...staticSegments, verb].flatMap((t) => snakeCase(t).split("_")).filter(Boolean);
  const seenWords = new Set<string>();
  const deduped: string[] = [];
  for (const w of words) {
    if (seenWords.has(w)) continue;
    seenWords.add(w);
    deduped.push(w);
  }
  // Truncate on a word boundary when the joined name exceeds the MCP cap.
  let name = "";
  for (const w of deduped) {
    const next = name ? `${name}_${w}` : w;
    if (next.length > MCP_TOOL_NAME_MAX) break;
    name = next;
  }
  return name || deduped[0].slice(0, MCP_TOOL_NAME_MAX);
}

/* ────────────────────── schema & description ────────────────────── */

function paramToSchema(p: ParameterSpec): JsonSchema {
  const base: Record<string, unknown> = { ...(p.schema ?? { type: "string" }) };
  if (p.description && !base.description) base.description = p.description;
  return base;
}

function bodyDescription(op: Operation): string {
  const ct = op.requestBodyContentType ?? "application/json";
  if (ct === "multipart/form-data") {
    return (
      "Request body (multipart/form-data). Pass each form field as a property. " +
      'For binary file fields pass an object: {"fileName": "name.ext", "contentBase64": "…"} ' +
      'or {"fileName": "name.ext", "content": "plain text"}. Object-valued fields are sent as JSON strings.'
    );
  }
  if (ct === "application/x-www-form-urlencoded") {
    return "Request body (application/x-www-form-urlencoded). Pass each form field as a property.";
  }
  return `Request body (${ct}).`;
}

function buildInputSchema(op: Operation): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const p of op.parameters) {
    properties[p.name] = paramToSchema(p);
    if (p.required) required.push(p.name);
  }

  if (op.requestBodySchema) {
    properties.body = { description: bodyDescription(op), ...op.requestBodySchema };
    if (op.requestBodyRequired) required.push("body");
  }

  const schema: Record<string, unknown> = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** Prettify a group key into a human title, e.g. `marketing-emails` → `Marketing Emails`. */
export function prettyGroup(group: string): string {
  return group
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function scopesLine(op: Operation): string | undefined {
  const [first, ...rest] = op.scopeAlternatives;
  if (!first || first.length === 0) return undefined;
  const shown = first.slice(0, 3).join(", ") + (first.length > 3 ? ", …" : "");
  return rest.length > 0 ? `Scopes: ${shown} (or ${rest.length} alternative scope set${rest.length > 1 ? "s" : ""})` : `Scopes: ${shown}`;
}

function buildDescription(op: Operation): string {
  const meta = categoryForOperation(op.method, op.path);
  const lines: string[] = [];
  lines.push(`${meta.banner} · ${op.entry.name} (${op.entry.area}) · ${op.method.toUpperCase()} ${op.path}`);
  if (op.summary) lines.push(op.summary.trim());
  lines.push(meta.blurb);

  const facts: string[] = [];
  const plan = formatRequirements(op.entry.requirements);
  if (plan) facts.push(`Plan: ${plan}.`);
  const scopes = scopesLine(op);
  if (scopes) facts.push(`${scopes}.`);
  if (op.entry.beta) facts.push("⚠️ Beta/preview API — may change without notice.");
  if (facts.length > 0) lines.push(facts.join(" "));

  if (op.description) {
    const desc = op.description.trim();
    if (desc && desc !== op.summary) lines.push(desc.length > 400 ? desc.slice(0, 400) + "…" : desc);
  }
  return lines.join("\n\n");
}

/* ─────────────────────────── filtering ─────────────────────────── */

const areaKey = (area: string) => area.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** True when a group filter token matches this operation: either its group
 * key (`contacts`) or an area wildcard (`crm:*`, `cms:*`). */
function filterMatches(tokens: Set<string>, op: Operation): boolean {
  if (tokens.has(op.group.toLowerCase())) return true;
  return tokens.has(`${areaKey(op.entry.area)}:*`);
}

function filterOperations(operations: Operation[], opts: ToolFilterOptions): Operation[] {
  return operations.filter((op) => {
    if (opts.includeBeta === false && op.entry.beta) return false;
    if (opts.includeGroups && !filterMatches(opts.includeGroups, op)) return false;
    if (opts.excludeGroups && filterMatches(opts.excludeGroups, op)) return false;
    if (opts.readOnly) {
      const bucket = safetyBucket(categoryForOperation(op.method, op.path).id);
      if (bucket !== "read") return false;
    }
    return true;
  });
}

export function operationsToTools(
  operations: Operation[],
  opts: ToolFilterOptions = {},
): ToolDefinition[] {
  const used = new Set<string>();
  const tools: ToolDefinition[] = [];

  // Append a suffix while keeping the name legal: trim the BASE, never the
  // suffix — slicing the whole string would drop the suffix at the 64-char cap
  // and the collision could never resolve.
  const withSuffix = (base: string, suffix: string) =>
    `${base.slice(0, Math.max(1, MCP_TOOL_NAME_MAX - suffix.length - 1)).replace(/_+$/, "")}_${suffix}`;

  for (const op of filterOperations(operations, opts)) {
    const baseName = toolNameForOperation(op) || "tool";

    // Resolve the (rare) collision: try the HTTP method, then a numeric suffix.
    let name = baseName;
    if (used.has(name)) {
      const withMethod = withSuffix(baseName, op.method);
      if (!used.has(withMethod)) name = withMethod;
    }
    if (used.has(name)) {
      let i = 2;
      while (used.has(withSuffix(baseName, String(i)))) i++;
      name = withSuffix(baseName, String(i));
    }
    used.add(name);

    const meta = categoryForOperation(op.method, op.path);
    const title = op.summary?.trim() || `${op.entry.name}: ${op.method.toUpperCase()} ${op.path}`;

    tools.push({
      name,
      description: buildDescription(op),
      inputSchema: buildInputSchema(op),
      annotations: { title, ...meta.annotations },
      operation: op,
      group: op.group,
      category: meta.id,
    });
  }

  return tools;
}
