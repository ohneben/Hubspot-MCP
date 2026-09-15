import { isDeepStrictEqual } from "node:util";
import { categoryForOperation, safetyBucket, type CategoryId } from "./categories.js";
import {
  consolidatedDetail,
  consolidatedPurpose,
  dispatchDescription,
  planConsolidation,
  primaryVariant,
  resolveVariant,
  type ConsolidatedEndpoint,
  type Variant,
} from "./consolidate.js";
import {
  actionOf,
  assembleDescription,
  cleanText,
  clip,
  fallbackParamDescription,
  nounFor,
  purposeFor,
  usageGuidance,
  type ActionKey,
} from "./describe.js";
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
  /** The REST operation this tool proxies (the primary variant for a
   * consolidated tool), or `null` for special tools. */
  operation: Operation | null;
  /** Consolidated tools only: every endpoint the tool reaches, picked by one argument. */
  consolidated?: ConsolidatedEndpoint;
  /** Method and path shown to the model; a generic template for consolidated tools. */
  endpoint?: { method: string; path: string; api: string; area: string };
  group?: string;
  category?: CategoryId;
}

/** Every operation a tool can call. */
export function toolOperations(tool: ToolDefinition): Operation[] {
  if (tool.consolidated) return tool.consolidated.variants.map((v) => v.operation);
  return tool.operation ? [tool.operation] : [];
}

/** The operation a call runs, with arguments in that operation's own names. */
export function resolveCall(tool: ToolDefinition, rawArgs: unknown): { operation: Operation; args: Record<string, unknown> } {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  if (tool.consolidated) return resolveVariant(tool.consolidated, args);
  if (!tool.operation) throw new Error(`${tool.name} does not call a HubSpot endpoint.`);
  return { operation: tool.operation, args };
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
  if (!base.description) {
    const hint = fallbackParamDescription(p.name);
    if (hint) base.description = hint;
  }
  // A renamed (sanitized) parameter still reaches HubSpot under its raw name.
  if (p.argName && p.argName !== p.name && !p.dynamicPrefix) {
    base.description = [base.description, `Sent to HubSpot as "${p.name}".`].filter(Boolean).join(" ");
  }
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
    const key = p.argName ?? p.name;
    properties[key] = paramToSchema(p);
    if (p.required) required.push(key);
  }

  if (op.requestBodySchema) {
    properties.body = { description: bodyDescription(op), ...op.requestBodySchema };
    if (op.requestBodyRequired) required.push("body");
  }

  const schema: Record<string, unknown> = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return compactSchema(schema) as Record<string, unknown>;
}

const EXAMPLE_KEYS = new Set(["example", "examples"]);

/**
 * Keep what a model needs to fill arguments in: every field, type, enum and
 * required list, plus the descriptions of the top-level arguments and of the
 * body's own fields. Examples and prose nested deeper are dropped; they were a
 * large share of the tool list and rarely change what the model sends. Keys of
 * a `properties` map are field names and always stay.
 */
function compactSchema(schema: unknown, depth = 0, isPropertyMap = false): unknown {
  if (Array.isArray(schema)) return schema.map((s) => compactSchema(s, depth + 1));
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!isPropertyMap && EXAMPLE_KEYS.has(k)) continue;
    if (!isPropertyMap && (k === "description" || k === "title") && depth > 2) continue;
    out[k] = compactSchema(v, isPropertyMap ? depth : depth + 1, !isPropertyMap && k === "properties");
  }
  return out;
}

/** Prettify a group key into a human title, e.g. `marketing-emails` → `Marketing Emails`. */
export function prettyGroup(group: string): string {
  return group
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function scopesLine(scopeAlternatives: string[][]): string | undefined {
  const [first, ...rest] = scopeAlternatives;
  if (!first || first.length === 0) return undefined;
  const shown = first.slice(0, 3).join(", ") + (first.length > 3 ? ", …" : "");
  return rest.length > 0 ? `Scopes: ${shown} (or ${rest.length} alternative scope set${rest.length > 1 ? "s" : ""})` : `Scopes: ${shown}`;
}

const BETA_NOTE = "⚠️ Beta/preview API — may change without notice.";

function endpointFacts(op: Operation): string[] {
  const facts: string[] = [];
  const plan = formatRequirements(op.entry.requirements);
  if (plan) facts.push(`Plan: ${plan}.`);
  const scopes = scopesLine(op.scopeAlternatives);
  if (scopes) facts.push(`${scopes}.`);
  if (op.entry.beta) facts.push(BETA_NOTE);
  return facts;
}

function endpointDetail(op: Operation): string | undefined {
  const detail = cleanText(op.description);
  if (!detail || detail === cleanText(op.summary)) return undefined;
  return clip(detail, 400);
}

function consolidatedFacts(ep: ConsolidatedEndpoint): string[] {
  const named = ep.variants.filter((v) => !v.wildcard);
  const reference = named.length > 0 ? named : ep.variants;
  const param = ep.family.param;
  const facts: string[] = [];

  const plans = new Set(reference.map((v) => formatRequirements(v.operation.entry.requirements) ?? ""));
  if (plans.size > 1) {
    facts.push(`Plan: depends on ${param}; see that parameter.`);
  } else {
    const [plan] = plans;
    if (plan) facts.push(`Plan: ${plan}.`);
  }

  const alternatives = reference.map((v) => v.operation.scopeAlternatives);
  if (alternatives.every((a) => isDeepStrictEqual(a, alternatives[0]))) {
    const scopes = scopesLine(alternatives[0]);
    if (scopes) facts.push(`${scopes}.`);
  } else {
    const hint = ep.family.scopeHint ? `, ${ep.family.scopeHint}` : "";
    facts.push(`Scopes: depend on ${param}${hint}. A 403 response names the missing scope.`);
  }

  if (reference.every((v) => v.operation.entry.beta)) facts.push(BETA_NOTE);
  return facts;
}

type SiblingIndex = Map<string, Map<ActionKey, string>>;

function siblingSlot(tool: ToolDefinition): { key: string; action: ActionKey } {
  // A consolidated path ends in its selector placeholder (`…/objects/{objectType}`),
  // which is a collection, not a record ID, so classify it as a fixed segment.
  const selector = tool.consolidated ? `{${tool.consolidated.family.param}}` : undefined;
  const path = selector ? tool.endpoint!.path.replace(selector, "variant") : tool.endpoint!.path;
  const { action, base } = actionOf(tool.endpoint!.method, path);
  return { key: `${tool.group}|${base}`, action };
}

/** Tools on the same resource, by what they do, so descriptions can point to the better fit. */
function buildSiblingIndex(tools: ToolDefinition[]): SiblingIndex {
  const index: SiblingIndex = new Map();
  for (const tool of tools) {
    const { key, action } = siblingSlot(tool);
    if (action === "other") continue;
    const slots = index.get(key) ?? new Map<ActionKey, string>();
    if (!slots.has(action)) slots.set(action, tool.name);
    index.set(key, slots);
  }
  return index;
}

function describeTool(tool: ToolDefinition, index: SiblingIndex): string {
  const op = tool.operation!;
  const endpoint = tool.endpoint!;
  const ep = tool.consolidated;
  const meta = categoryForOperation(op.method, op.path);
  const { key, action } = siblingSlot(tool);
  const slots = index.get(key);

  const guidance = usageGuidance(action, {
    sibling: (a) => {
      const name = slots?.get(a);
      return name && name !== tool.name ? name : undefined;
    },
    noun: ep ? ep.family.noun : nounFor(actionOf(endpoint.method, endpoint.path).base),
    crmObjects: endpoint.path.startsWith("/crm/v3/objects/"),
    cursor: "after" in ((tool.inputSchema.properties as Record<string, unknown>) ?? {}),
  });

  return assembleDescription({
    banner: meta.banner,
    purpose: ep ? consolidatedPurpose(ep) : purposeFor(op.summary, op.method, op.path),
    guidance,
    blurb: meta.blurb,
    facts: ep ? consolidatedFacts(ep) : endpointFacts(op),
    detail: ep ? consolidatedDetail(ep) : endpointDetail(op),
    endpoint: `${endpoint.method.toUpperCase()} ${endpoint.path} (${endpoint.api}, ${endpoint.area})`,
  });
}

/** Apply `fn` to every prose `description` in a schema, leaving body fields named "description" alone. */
function mapDescriptions(schema: unknown, fn: (text: string) => string, isPropertyMap = false): unknown {
  if (Array.isArray(schema)) return schema.map((s) => mapDescriptions(s, fn));
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([k, v]) => [
      k,
      !isPropertyMap && k === "description" && typeof v === "string"
        ? fn(v)
        : mapDescriptions(v, fn, !isPropertyMap && k === "properties"),
    ]),
  );
}

/** The primary variant's schema, with the dispatch argument first and path arguments under their generic names. */
function consolidatedInputSchema(ep: ConsolidatedEndpoint, primary: Variant): Record<string, unknown> {
  const base = buildInputSchema(primary.operation);
  const baseRequired = new Set((base.required as string[] | undefined) ?? []);
  const values = ep.variants.filter((v) => !v.wildcard).map((v) => v.value);
  const dispatch: Record<string, unknown> = { type: "string", description: dispatchDescription(ep) };
  if (!ep.variants.some((v) => v.wildcard)) dispatch.enum = values;

  const properties: Record<string, unknown> = { [ep.family.param]: dispatch };
  const required = [ep.family.param];
  const neutral = (text: string) => ep.family.neutralize(text, primary);
  for (const [key, schema] of Object.entries(base.properties as Record<string, Record<string, unknown>>)) {
    if (primary.wildcard && key === primary.dispatchArgKey) continue;
    const position = primary.pathArgKeys.indexOf(key);
    const outKey = position >= 0 ? ep.pathArgs[position] : key;
    if (outKey in properties) throw new Error(`${ep.name}: argument "${outKey}" is defined twice.`);
    let out = mapDescriptions(schema, neutral) as Record<string, unknown>;
    if (outKey !== key) out = { ...out, description: fallbackParamDescription(outKey) ?? out.description };
    properties[outKey] = out;
    if (baseRequired.has(key)) required.push(outKey);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function consolidatedTool(ep: ConsolidatedEndpoint): ToolDefinition {
  const primary = primaryVariant(ep);
  const op = primary.operation;
  const meta = categoryForOperation(op.method, op.path);
  return {
    name: ep.name,
    description: "",
    inputSchema: consolidatedInputSchema(ep, primary),
    annotations: { title: consolidatedPurpose(ep).replace(/\.$/, ""), ...meta.annotations },
    operation: op,
    consolidated: ep,
    endpoint: { method: ep.method, path: ep.path, api: ep.family.label, area: op.entry.area },
    group: ep.family.group,
    category: meta.id,
  };
}

function endpointTool(op: Operation, name: string): ToolDefinition {
  const meta = categoryForOperation(op.method, op.path);
  return {
    name,
    description: "",
    inputSchema: buildInputSchema(op),
    annotations: { title: purposeFor(op.summary, op.method, op.path).replace(/\.$/, ""), ...meta.annotations },
    operation: op,
    endpoint: { method: op.method, path: op.path, api: `${op.entry.name} API`, area: op.entry.area },
    group: op.group,
    category: meta.id,
  };
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
  // Consolidation is planned over the full spec set so tool names never change
  // with the include/exclude/read-only filters; the filters only narrow which
  // variants a consolidated tool can reach.
  const planOf = new Map<Operation, ConsolidatedEndpoint>();
  for (const ep of planConsolidation(operations)) {
    for (const v of ep.variants) planOf.set(v.operation, ep);
  }

  const kept = new Set(filterOperations(operations, opts));
  const drafts: Array<{ op: Operation; ep?: ConsolidatedEndpoint }> = [];
  const planned = new Set<ConsolidatedEndpoint>();
  for (const op of operations) {
    if (!kept.has(op)) continue;
    const ep = planOf.get(op);
    if (!ep) {
      drafts.push({ op });
    } else if (!planned.has(ep)) {
      planned.add(ep);
      drafts.push({ op, ep: { ...ep, variants: ep.variants.filter((v) => kept.has(v.operation)) } });
    }
  }

  // Consolidated names are fixed, so they are claimed before any derived name.
  const used = new Set<string>();
  for (const { ep } of drafts) {
    if (!ep) continue;
    if (used.has(ep.name)) throw new Error(`Two consolidated tools would both be named ${ep.name}.`);
    used.add(ep.name);
  }
  const tools: ToolDefinition[] = [];

  // Append a suffix while keeping the name legal: trim the BASE, never the
  // suffix — slicing the whole string would drop the suffix at the 64-char cap
  // and the collision could never resolve.
  const withSuffix = (base: string, suffix: string) =>
    `${base.slice(0, Math.max(1, MCP_TOOL_NAME_MAX - suffix.length - 1)).replace(/_+$/, "")}_${suffix}`;

  for (const { op, ep } of drafts) {
    if (ep) {
      tools.push(consolidatedTool(ep));
      continue;
    }
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
    tools.push(endpointTool(op, name));
  }

  // Descriptions last: they name sibling tools, so every name must be final.
  const index = buildSiblingIndex(tools);
  for (const tool of tools) tool.description = describeTool(tool, index);
  return tools;
}
