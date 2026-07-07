import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CatalogEntry } from "./specs.js";

const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "head", "options"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ParameterSpec {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
  schema?: JsonSchema;
  explode?: boolean;
  /**
   * The key this parameter is exposed under in the tool's input schema.
   * Anthropic's API only accepts property keys matching
   * `^[a-zA-Z0-9_.-]{1,64}$`, but a few HubSpot specs declare template
   * parameters like `objectProperty.{propname}` — one such key would make an
   * MCP client reject the ENTIRE tool list. Always set on loaded operations;
   * equals `name` whenever the raw name is already legal.
   */
  argName?: string;
  /**
   * For dynamic template parameters (`objectProperty.{propname}`): the literal
   * query-key prefix. The tool argument takes an object and the client sends
   * one `<prefix><key>=<value>` pair per entry.
   */
  dynamicPrefix?: string;
}

export interface Operation {
  operationId: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  /** Resource-group key (the catalog entry's group, e.g. `contacts`, `hubdb`). */
  group: string;
  parameters: ParameterSpec[];
  requestBodySchema?: JsonSchema;
  requestBodyRequired: boolean;
  requestBodyContentType?: string;
  /** The catalog entry this operation came from (name, area, plan tier, beta). */
  entry: CatalogEntry;
  /**
   * OAuth scope alternatives from the spec's `security` — the call succeeds if
   * the token holds every scope of ANY one alternative. Empty = no auth listed.
   */
  scopeAlternatives: string[][];
  /** Path prefix from the definition's `servers[].url` (usually empty — all
   * HubSpot APIs are mounted at the `https://api.hubapi.com` root). */
  serverPath: string;
}

export type JsonSchema = Record<string, unknown> | null | undefined;

interface OpenApiDoc {
  servers?: Array<{ url?: string }>;
  paths?: Record<string, PathItem>;
  security?: SecurityRequirement[];
  components?: {
    parameters?: Record<string, ParameterSpec>;
    schemas?: Record<string, JsonSchema>;
    requestBodies?: Record<string, RequestBodyObject>;
    responses?: Record<string, unknown>;
  };
}

type SecurityRequirement = Record<string, string[]>;

interface PathItem {
  parameters?: Array<ParameterSpec | RefObject>;
  [method: string]: unknown;
}

interface RefObject {
  $ref: string;
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<ParameterSpec | RefObject>;
  requestBody?: RequestBodyObject | RefObject;
  security?: SecurityRequirement[];
}

interface RequestBodyObject {
  required?: boolean;
  description?: string;
  content?: Record<string, { schema?: JsonSchema }>;
}

function isRef(value: unknown): value is RefObject {
  return (
    typeof value === "object" &&
    value !== null &&
    "$ref" in value &&
    typeof (value as RefObject).$ref === "string"
  );
}

function resolveRef<T>(doc: OpenApiDoc, ref: string): T | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const segments = ref.slice(2).split("/");
  let cursor: unknown = doc;
  for (const seg of segments) {
    // JSON Pointer escaping: ~1 => "/", ~0 => "~"
    const key = seg.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cursor && typeof cursor === "object" && key in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cursor as T;
}

/** How deep schemas are inlined before we cut them off. A handful of CMS
 * schemas nest 30+ levels of theme/layout metadata that would balloon every
 * tool listing; past this depth a short note replaces the subtree. */
const MAX_SCHEMA_DEPTH = 16;

/**
 * Inline every `$ref` in a schema, guarding against infinite recursion (a
 * self-referential schema resolves to a short note instead of blowing the
 * stack) and against pathologically deep nesting.
 */
function dereferenceSchema(
  doc: OpenApiDoc,
  schema: JsonSchema,
  seen: Set<string> = new Set(),
  depth = 0,
): JsonSchema {
  if (!schema || typeof schema !== "object") return schema;
  if (depth > MAX_SCHEMA_DEPTH) return { description: "Nested schema truncated (too deep to inline)." };
  if (isRef(schema)) {
    const ref = (schema as unknown as RefObject).$ref;
    if (seen.has(ref)) return { description: `Recursive reference to ${ref}` };
    const resolved = resolveRef<JsonSchema>(doc, ref);
    if (!resolved) return { description: `Unresolved $ref: ${ref}` };
    return dereferenceSchema(doc, resolved, new Set([...seen, ref]), depth + 1);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        item && typeof item === "object" ? dereferenceSchema(doc, item as JsonSchema, seen, depth + 1) : item,
      );
    } else if (v && typeof v === "object") {
      out[k] = dereferenceSchema(doc, v as JsonSchema, seen, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * A few HubSpot schemas explode when inlined — the list-filter and workflow
 * definitions are recursive unions that dereference to ~1.7 MB EACH. A tool
 * schema that large would swamp every client's context for near-zero value,
 * so oversized body schemas are re-truncated at decreasing depths until they
 * fit this budget. Everything above the cut keeps full fidelity; the cut
 * points say what was elided. (Median body schema is <1 KB — this touches
 * only the outliers.)
 */
const MAX_BODY_SCHEMA_CHARS = 24_000;

function truncateSchemaAtDepth(node: unknown, depth: number): unknown {
  if (!node || typeof node !== "object") return node;
  if (depth <= 0) {
    const n = node as Record<string, unknown>;
    const summary: Record<string, unknown> = {};
    if (typeof n.type === "string") summary.type = n.type;
    summary.description =
      typeof n.description === "string" && n.description.length > 0
        ? `${String(n.description).slice(0, 200)} (nested schema abridged — see HubSpot docs)`
        : "Nested schema abridged — pass a valid object per HubSpot's docs for this endpoint.";
    return summary;
  }
  if (Array.isArray(node)) return node.map((item) => truncateSchemaAtDepth(item, depth - 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    out[k] = truncateSchemaAtDepth(v, depth - 1);
  }
  return out;
}

export function fitSchemaToBudget(schema: JsonSchema, budget = MAX_BODY_SCHEMA_CHARS): JsonSchema {
  if (!schema) return schema;
  const full = JSON.stringify(schema);
  if (!full || full.length <= budget) return schema;
  for (const depth of [14, 12, 10, 8, 6, 5, 4, 3]) {
    const truncated = truncateSchemaAtDepth(schema, depth) as JsonSchema;
    const size = JSON.stringify(truncated)?.length ?? 0;
    if (size <= budget) return truncated;
  }
  return truncateSchemaAtDepth(schema, 2) as JsonSchema;
}

function resolveParameter(doc: OpenApiDoc, p: ParameterSpec | RefObject): ParameterSpec | undefined {
  if (isRef(p)) {
    const resolved = resolveRef<ParameterSpec>(doc, p.$ref);
    return resolved ? { ...resolved, required: resolved.required ?? resolved.in === "path" } : undefined;
  }
  return { ...p, required: p.required ?? p.in === "path" };
}

function resolveRequestBody(
  doc: OpenApiDoc,
  body: RequestBodyObject | RefObject,
): RequestBodyObject | undefined {
  if (isRef(body)) return resolveRef<RequestBodyObject>(doc, body.$ref);
  return body;
}

/** Auth/content headers we inject ourselves — never expose them as tool inputs. */
const HEADERS_TO_SKIP = new Set(["authorization", "content-type", "accept"]);

/** Anthropic's constraint on tool input-schema property keys. */
export const TOOL_ARG_KEY = /^[a-zA-Z0-9_.-]{1,64}$/;

const sanitizeArgKey = (name: string): string =>
  name.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^[_.]+|[_.]+$/g, "").slice(0, 64) || "param";

/**
 * Give every parameter a schema-legal `argName` (unique per operation) and
 * turn template parameters like `objectProperty.{propname}` into object-valued
 * inputs the client expands back into `objectProperty.<name>=<value>` pairs.
 */
function assignArgNames(params: ParameterSpec[]): ParameterSpec[] {
  const used = new Set<string>();
  return params.map((p) => {
    const out: ParameterSpec = { ...p };
    const template = /^([^{}]*)\{[^{}]+\}$/.exec(p.name);
    let base: string;
    if (template) {
      out.dynamicPrefix = template[1];
      base = sanitizeArgKey(template[1].replace(/[._-]+$/, "") || "params");
      out.schema = {
        type: "object",
        additionalProperties: true,
        description:
          (p.description ? `${p.description} ` : "") +
          `Dynamic query parameters: each entry is sent as ${out.dynamicPrefix}<key>=<value> ` +
          `(e.g. {"lifecyclestage": "lead"} → ${out.dynamicPrefix}lifecyclestage=lead).`,
      };
    } else {
      base = TOOL_ARG_KEY.test(p.name) ? p.name : sanitizeArgKey(p.name);
    }
    let argName = base;
    let i = 2;
    while (used.has(argName)) argName = `${base.slice(0, 60)}_${i++}`;
    used.add(argName);
    out.argName = argName;
    return out;
  });
}

/** Extract the path portion of the first server URL (usually ``). */
function serverPathFromDoc(doc: OpenApiDoc): string {
  const url = doc.servers?.[0]?.url ?? "";
  const noScheme = url.replace(/^https?:\/\//i, "");
  const slash = noScheme.indexOf("/");
  if (slash === -1) return "";
  return noScheme.slice(slash).replace(/\/+$/, "");
}

/** Preferred request content type: JSON first, then whatever the spec offers. */
function pickContentType(content: Record<string, { schema?: JsonSchema }>): string | undefined {
  if ("application/json" in content) return "application/json";
  return Object.keys(content)[0];
}

/** Normalise a security list into deduped scope alternatives. */
function scopeAlternativesFrom(security: SecurityRequirement[] | undefined): string[][] {
  if (!security) return [];
  const seen = new Set<string>();
  const alternatives: string[][] = [];
  for (const requirement of security) {
    const scopes = [...new Set(Object.values(requirement).flat())].sort();
    const key = scopes.join(" ");
    if (scopes.length === 0 || seen.has(key)) continue;
    seen.add(key);
    alternatives.push(scopes);
  }
  return alternatives;
}

/** Parse a spec file (JSON or YAML) into a document object. */
function parseSpecFile(specPath: string): OpenApiDoc {
  const raw = readFileSync(specPath, "utf8");
  if (extname(specPath).toLowerCase() === ".json") {
    return JSON.parse(raw) as OpenApiDoc;
  }
  return parseYaml(raw) as OpenApiDoc;
}

/** Load a single OpenAPI definition into a flat list of operations. */
export function loadSpec(specPath: string, entry: CatalogEntry): Operation[] {
  const doc = parseSpecFile(specPath);
  const operations: Operation[] = [];
  if (!doc.paths) return operations;

  const serverPath = serverPathFromDoc(doc);

  for (const [path, pathItem] of Object.entries(doc.paths)) {
    if (!pathItem) continue;
    const pathLevelParams: ParameterSpec[] = (pathItem.parameters ?? [])
      .map((p) => resolveParameter(doc, p))
      .filter((p): p is ParameterSpec => Boolean(p));

    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method] as OperationObject | undefined;
      if (!op || typeof op !== "object") continue;

      const opParams: ParameterSpec[] = (op.parameters ?? [])
        .map((p) => resolveParameter(doc, p))
        .filter((p): p is ParameterSpec => Boolean(p));

      // Operation-level params override path-level ones by (name + in).
      const merged = new Map<string, ParameterSpec>();
      for (const p of pathLevelParams) merged.set(`${p.in}:${p.name}`, p);
      for (const p of opParams) merged.set(`${p.in}:${p.name}`, p);

      const allParams = [...merged.values()].filter(
        (p) => !(p.in === "header" && HEADERS_TO_SKIP.has(p.name.toLowerCase())),
      );

      let requestBodySchema: JsonSchema | undefined;
      let requestBodyRequired = false;
      let requestBodyContentType: string | undefined;
      if (op.requestBody) {
        const rb = resolveRequestBody(doc, op.requestBody);
        if (rb?.content) {
          const contentType = pickContentType(rb.content);
          const entryContent = contentType ? rb.content[contentType] : undefined;
          if (contentType && entryContent?.schema) {
            requestBodySchema = fitSchemaToBudget(dereferenceSchema(doc, entryContent.schema));
            requestBodyContentType = contentType;
            requestBodyRequired = rb.required ?? false;
          }
        }
      }

      const operationId =
        op.operationId?.trim() ||
        `${method}-${path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

      operations.push({
        operationId,
        method,
        path,
        summary: op.summary,
        description: op.description,
        group: entry.group,
        parameters: assignArgNames(
          allParams.map((p) => ({
            ...p,
            schema: p.schema ? dereferenceSchema(doc, p.schema) : undefined,
          })),
        ),
        requestBodySchema,
        requestBodyRequired,
        requestBodyContentType,
        entry,
        scopeAlternatives: scopeAlternativesFrom(op.security ?? doc.security),
        serverPath,
      });
    }
  }

  return operations;
}

/** Load and merge every bundled definition listed in the catalog. */
export function loadAllSpecs(
  specDir: string,
  entries: CatalogEntry[],
  resolvePath: (dir: string, file: string) => string,
): Operation[] {
  const all: Operation[] = [];
  for (const entry of entries) {
    all.push(...loadSpec(resolvePath(specDir, entry.file), entry));
  }
  return all;
}
