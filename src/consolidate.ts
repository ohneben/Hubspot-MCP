import { isDeepStrictEqual } from "node:util";
import { categoryForOperation } from "./categories.js";
import { asSentence, cleanText, clip, purposeFor } from "./describe.js";
import type { Operation } from "./openapi.js";
import { formatRequirements } from "./specs.js";

/**
 * Tool consolidation.
 *
 * HubSpot publishes one API per CRM object type, and each repeats the same
 * eleven endpoints: `/crm/v3/objects/contacts/search`,
 * `/crm/v3/objects/deals/search`, and so on for 32 types. Landing pages and
 * site pages, and blog posts, authors and tags, repeat each other the same way.
 * One tool per endpoint turned that into hundreds of near-identical tools a
 * model has to tell apart.
 *
 * A consolidated tool covers one such endpoint family and takes an extra
 * argument (`objectType`, `pageType`, `blogResource`) that picks the variant.
 * Nothing is lost: every variant still calls exactly the endpoint it called
 * before, with its own scopes, plan requirement and error hints. Endpoints are
 * only merged when every variant accepts exactly the same query parameters and
 * request body; anything that differs stays its own tool.
 */

export interface Variant {
  /** Canonical value of the dispatch argument; "*" for the wildcard variant. */
  value: string;
  /** Lower-case values that select this variant. */
  aliases: string[];
  /** The generic endpoint that accepts any value (CRM custom objects). */
  wildcard: boolean;
  operation: Operation;
  /** This variant's own argument keys for the generic path arguments, in path order. */
  pathArgKeys: string[];
  /** Wildcard only: the argument key that receives the dispatch value. */
  dispatchArgKey?: string;
}

export interface Family {
  prefix: string;
  /** Group key the consolidated tools report. */
  group: string;
  /** API label shown on the endpoint line. */
  label: string;
  /** Argument that selects the variant. */
  param: string;
  /** Plural noun used in usage guidance. */
  noun: string;
  /** Captures the variant segment; the full match is the family's base path. */
  match: RegExp;
  genericBase: string;
  /** The path segment the wildcard variant uses in place of a literal value. */
  wildcardSegment?: string;
  /** Preferred variant for schema and wording. */
  primary: string;
  /** Argument name for the record ID when variants name it differently. */
  idArg: string;
  /** Hand-written purpose lines keyed by name suffix, where spec wording would name one variant. */
  purposes?: Record<string, string>;
  scopeHint?: string;
  values(segment: string, op: Operation): { value: string; aliases: string[] };
  /** Rewrite the primary variant's wording so it applies to every variant. */
  neutralize(text: string, primary: Variant): string;
  intro(variants: Variant[]): string;
}

export interface ConsolidatedEndpoint {
  family: Family;
  name: string;
  /** Name without the family prefix, e.g. `batch_read`. */
  suffix: string;
  method: string;
  /** Generic path template, e.g. `/crm/v3/objects/{objectType}/search`. */
  path: string;
  /** Argument keys of the path parameters after the variant segment. */
  pathArgs: string[];
  variants: Variant[];
}

const lowerUnique = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()))];

const orList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);

function replaceWords(text: string, from: string, to: string): string {
  const pattern = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
  return text.replace(pattern, (hit) => (hit[0] === hit[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to));
}

const CRM_PURPOSES: Record<string, string> = {
  list: "List records of one CRM object type (contacts, companies, deals, tickets, custom objects and more), one page at a time.",
  get: "Get one CRM record by its ID, with the properties and associations you ask for.",
  create: "Create one CRM record of the given object type.",
  update: "Update the properties of one CRM record by its ID.",
  archive: "Archive one CRM record by its ID.",
  search: "Search CRM records of one object type by property filters, a free-text query and sort order.",
  batch_read: "Read many CRM records of one object type by ID, or by a unique property, in one call.",
  batch_create: "Create many CRM records of one object type in one call.",
  batch_update: "Update many CRM records of one object type by ID in one call.",
  batch_upsert: "Create or update many CRM records of one object type, matched by a unique property, in one call.",
  batch_archive: "Archive many CRM records of one object type by ID in one call.",
  merge: "Merge two CRM records of the same object type into one.",
  associations_list: "List the records associated with a partner client or partner service.",
  associations_create: "Associate a partner client or partner service with another record.",
  associations_delete: "Remove an association between a partner client or partner service and another record.",
};

export const FAMILIES: Family[] = [
  {
    prefix: "crm_objects",
    group: "crm-objects",
    label: "CRM objects API",
    param: "objectType",
    noun: "records",
    match: /^\/crm\/v3\/objects\/([a-z0-9_-]+|\{objectType\})(?=\/|$)/,
    genericBase: "/crm/v3/objects/{objectType}",
    wildcardSegment: "{objectType}",
    primary: "contacts",
    idArg: "objectId",
    purposes: CRM_PURPOSES,
    scopeHint: "usually crm.objects.<type>.read for reads and crm.objects.<type>.write for changes",
    values(segment, op) {
      // Some types are addressed by objectTypeId (deals are 0-3); name them by their API.
      const value = /^\d+-\d+$/.test(segment) ? op.group.replace(/-/g, "_") : segment;
      return { value, aliases: lowerUnique([value, segment, op.group, op.group.replace(/-/g, "_"), value.replace(/_/g, "-")]) };
    },
    neutralize(text, primary) {
      const plural = primary.value.replace(/_/g, " ");
      const singular = plural.replace(/s$/, "");
      return replaceWords(replaceWords(text, plural, "records"), singular, "record");
    },
    intro(variants) {
      const named = variants.filter((v) => !v.wildcard).map((v) => v.value);
      const wildcard = variants.some((v) => v.wildcard);
      if (named.length === 0) return "CRM object type, e.g. contacts, deals, or a custom object's objectTypeId such as 2-12345.";
      return (
        `CRM object type. Supported: ${named.join(", ")}.` +
        (wildcard
          ? " Any other value, such as a custom object's objectTypeId (e.g. 2-12345) or fullyQualifiedName, goes to HubSpot's generic objects endpoint."
          : "")
      );
    },
  },
  {
    prefix: "cms_pages",
    group: "pages",
    label: "CMS Pages API",
    param: "pageType",
    noun: "pages",
    match: /^\/cms\/v3\/pages\/(landing-pages|site-pages)(?=\/|$)/,
    genericBase: "/cms/v3/pages/{pageType}",
    primary: "landing",
    idArg: "objectId",
    values(segment) {
      const value = segment === "landing-pages" ? "landing" : "site";
      return { value, aliases: lowerUnique([value, segment, segment.replace(/-/g, "_")]) };
    },
    neutralize: (text) => replaceWords(replaceWords(text, "landing pages", "pages"), "landing page", "page"),
    intro: (variants) => `Which pages: ${orList(variants.map((v) => v.value))} (landing = landing pages, site = website pages).`,
  },
  {
    prefix: "cms_blog",
    group: "blogs",
    label: "CMS Blogs API",
    param: "blogResource",
    noun: "blog items",
    match: /^\/cms\/v3\/blogs\/(authors|posts|tags)(?=\/|$)/,
    genericBase: "/cms/v3/blogs/{blogResource}",
    primary: "posts",
    idArg: "objectId",
    values: (segment) => ({ value: segment, aliases: lowerUnique([segment, segment.replace(/s$/, "")]) }),
    // The primary variant is posts; case-sensitive so an HTTP "POST" is left alone.
    neutralize: (text) =>
      text
        .replace(/\b[Bb]log [Pp]osts\b/g, "blog items")
        .replace(/\b[Bb]log [Pp]ost\b/g, "blog item")
        .replace(/\b[Pp]osts\b/g, "blog items")
        .replace(/\b[Pp]ost\b/g, "blog item"),
    intro: (variants) => `Which blog resource: ${orList(variants.map((v) => v.value))}.`,
  },
];

/* ─────────────────────────── planning ─────────────────────────── */

const SHAPE_IGNORED = new Set(["description", "title", "example", "examples"]);

/** Drop prose so only the accepted structure is compared. Keys of a
 * `properties` map are field names, so a body field called `description` stays. */
function stripProse(value: unknown, isPropertyMap = false): unknown {
  if (Array.isArray(value)) return value.map((v) => stripProse(v));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => isPropertyMap || !SHAPE_IGNORED.has(k))
      .map(([k, v]) => [k, stripProse(v, !isPropertyMap && k === "properties")]),
  );
}

/** Everything a caller can send besides the path: query/header params and the body. */
function shapeOf(op: Operation): unknown {
  return stripProse({
    params: op.parameters
      .filter((p) => p.in !== "path")
      .map((p) => [p.argName ?? p.name, p.name, p.in, p.required, p.explode ?? null, p.dynamicPrefix ?? null, p.schema ?? null]),
    body: op.requestBodySchema ?? null,
    contentType: op.requestBodyContentType ?? null,
    bodyRequired: op.requestBodyRequired,
    serverPath: op.serverPath,
    category: categoryForOperation(op.method, op.path).id,
  });
}

/** Name suffix for a generic sub-path, e.g. `/{objectId}/revisions/{revisionId}` + GET → `revisions_get`. */
export function actionSuffix(method: string, rest: string): string {
  const m = method.toLowerCase();
  const segments = rest.split("/").filter(Boolean);
  const statics = segments.filter((s) => !s.startsWith("{")).map((s) => s.replace(/-/g, "_"));
  const joined = statics.join("_");
  const withJoined = (verb: string) => (joined ? `${joined}_${verb}` : verb);
  const last = segments[segments.length - 1];

  if (!last) return m === "get" ? "list" : m === "post" ? "create" : m;
  if (last.startsWith("{")) {
    const param = last.slice(1, -1);
    if (m === "get") return withJoined(/(id|ids|key|name)$/i.test(param) ? "get" : "list");
    if (statics.includes("associations")) return withJoined(m === "delete" ? "delete" : "create");
    return withJoined(m === "delete" ? "archive" : "update");
  }
  if (m === "get") return withJoined(last.endsWith("s") ? "list" : "get");
  if (m === "patch") return withJoined("update");
  return joined;
}

function buildEndpoint(
  family: Family,
  method: string,
  members: Array<{ op: Operation; segment: string; rest: string }>,
): ConsolidatedEndpoint | undefined {
  if (members.length < 2) return undefined;

  const variants: Variant[] = members.map(({ op, segment, rest }) => {
    const keyOf = (name: string) => op.parameters.find((p) => p.in === "path" && p.name === name)?.argName ?? name;
    const names = [...rest.matchAll(/\{([^}]+)\}/g)].map((hit) => hit[1]);
    const wildcard = segment === family.wildcardSegment;
    const { value, aliases } = wildcard ? { value: "*", aliases: [] } : family.values(segment, op);
    return {
      value,
      aliases,
      wildcard,
      operation: op,
      pathArgKeys: names.map(keyOf),
      ...(wildcard ? { dispatchArgKey: keyOf(segment.slice(1, -1)) } : {}),
    };
  });

  if (variants.filter((v) => v.wildcard).length > 1) return undefined;
  const shape = shapeOf(variants[0].operation);
  if (!variants.every((v) => isDeepStrictEqual(shapeOf(v.operation), shape))) return undefined;
  const aliases = variants.flatMap((v) => v.aliases);
  if (new Set(aliases).size !== aliases.length) return undefined;

  const named = variants.find((v) => !v.wildcard) ?? variants[0];
  const pathArgs = named.pathArgKeys.map((key, i) =>
    new Set(variants.map((v) => v.pathArgKeys[i])).size === 1 ? key : i === 0 ? family.idArg : key,
  );
  if (new Set(pathArgs).size !== pathArgs.length) return undefined;

  let i = 0;
  const genericRest = members[0].rest.replace(/\{[^}]+\}/g, () => `{${pathArgs[i++]}}`);
  const suffix = actionSuffix(method, genericRest);
  return {
    family,
    name: `${family.prefix}_${suffix}`,
    suffix,
    method,
    path: family.genericBase + genericRest,
    pathArgs,
    variants,
  };
}

/** Find every endpoint family worth one tool, over the full, unfiltered spec set. */
export function planConsolidation(operations: Operation[]): ConsolidatedEndpoint[] {
  const clusters = new Map<string, { family: Family; method: string; members: Array<{ op: Operation; segment: string; rest: string }> }>();
  for (const op of operations) {
    for (const family of FAMILIES) {
      const hit = op.path.match(family.match);
      if (!hit) continue;
      const rest = op.path.slice(hit[0].length);
      const key = `${family.prefix} ${op.method} ${rest.replace(/\{[^}]+\}/g, "{}")}`;
      const cluster = clusters.get(key) ?? { family, method: op.method, members: [] };
      cluster.members.push({ op, segment: hit[1], rest });
      clusters.set(key, cluster);
      break;
    }
  }
  return [...clusters.values()]
    .map((c) => buildEndpoint(c.family, c.method, c.members))
    .filter((ep): ep is ConsolidatedEndpoint => ep !== undefined);
}

/* ─────────────────────────── calling ─────────────────────────── */

const valuesText = (ep: ConsolidatedEndpoint) => {
  const named = ep.variants.filter((v) => !v.wildcard).map((v) => v.value);
  return ep.variants.some((v) => v.wildcard) ? `${named.join(", ")}, or a custom object type ID` : named.join(", ");
};

/**
 * Pick the endpoint for the dispatch argument and translate the generic
 * arguments into that endpoint's own names, so the request is exactly what
 * the per-endpoint tool used to send.
 */
export function resolveVariant(
  ep: ConsolidatedEndpoint,
  rawArgs: Record<string, unknown>,
): { operation: Operation; args: Record<string, unknown> } {
  const param = ep.family.param;
  const raw = rawArgs[param];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`Missing required argument "${param}". Use one of: ${valuesText(ep)}.`);
  }
  const wanted = raw.trim();
  const target =
    ep.variants.find((v) => !v.wildcard && v.aliases.includes(wanted.toLowerCase())) ?? ep.variants.find((v) => v.wildcard);
  if (!target) {
    throw new Error(`Unsupported ${param} "${wanted}" for ${ep.name}. Use one of: ${valuesText(ep)}.`);
  }

  const args: Record<string, unknown> = { ...rawArgs };
  delete args[param];
  const renamed: Record<string, unknown> = {};
  ep.pathArgs.forEach((generic, i) => {
    if (!(generic in rawArgs)) return;
    delete args[generic];
    renamed[target.pathArgKeys[i]] = rawArgs[generic];
  });
  Object.assign(args, renamed);
  if (target.wildcard && target.dispatchArgKey) args[target.dispatchArgKey] = wanted;
  return { operation: target.operation, args };
}

/* ─────────────────────────── describing ─────────────────────────── */

export function primaryVariant(ep: ConsolidatedEndpoint): Variant {
  return ep.variants.find((v) => v.value === ep.family.primary) ?? ep.variants.find((v) => !v.wildcard) ?? ep.variants[0];
}

export function consolidatedPurpose(ep: ConsolidatedEndpoint): string {
  const written = ep.family.purposes?.[ep.suffix];
  if (written) return written;
  const primary = primaryVariant(ep);
  const summary = cleanText(primary.operation.summary);
  return summary ? asSentence(ep.family.neutralize(summary, primary)) : purposeFor(undefined, ep.method, ep.path);
}

export function consolidatedDetail(ep: ConsolidatedEndpoint): string | undefined {
  if (ep.family.purposes) return undefined;
  const primary = primaryVariant(ep);
  const detail = cleanText(primary.operation.description);
  if (!detail || detail === cleanText(primary.operation.summary)) return undefined;
  return clip(ep.family.neutralize(detail, primary), 400);
}

/** The dispatch argument's description: allowed values, and plan or beta differences between them. */
export function dispatchDescription(ep: ConsolidatedEndpoint): string {
  const parts = [ep.family.intro(ep.variants)];
  const named = ep.variants.filter((v) => !v.wildcard);

  const byPlan = new Map<string, string[]>();
  for (const v of named) {
    const plan = formatRequirements(v.operation.entry.requirements) ?? "no published plan";
    byPlan.set(plan, [...(byPlan.get(plan) ?? []), v.value]);
  }
  if (byPlan.size > 1) {
    const [common, ...others] = [...byPlan].sort((a, b) => b[1].length - a[1].length);
    parts.push(`Plan: ${common[0]}. Different for ${others.map(([plan, values]) => `${values.join(", ")}: ${plan}`).join("; ")}.`);
  }

  const beta = named.filter((v) => v.operation.entry.beta).map((v) => v.value);
  if (beta.length > 0 && beta.length < named.length) parts.push(`Beta APIs, may change: ${beta.join(", ")}.`);
  return parts.join(" ");
}
