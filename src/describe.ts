/**
 * Building blocks for tool descriptions.
 *
 * HubSpot's specs say what an endpoint is ("Retrieve contacts") but rarely when
 * to pick it over a sibling, and roughly 40% of their parameters ship without a
 * description. These helpers add that context without inventing API behaviour:
 * usage guidance only names tools that exist next to the endpoint, and limits
 * are only stated where HubSpot documents them.
 */

export type ActionKey =
  | "list"
  | "get"
  | "create"
  | "update"
  | "archive"
  | "search"
  | "batch_read"
  | "batch_create"
  | "batch_update"
  | "batch_upsert"
  | "batch_archive"
  | "merge"
  | "other";

/** Param names that read as record identifiers. */
const ID_LIKE = /(id|ids|token|key|name|slug|path|date|guid|url)s?$/i;

/** Non-GET trailing segments that are actions rather than collections. */
const ACTION_WORDS = /^(cancel|revoke|introspect|add|remove|add-and-remove|upsert|archive|read|update|clone|publish|unpublish|push-live|reset|restore|restore-to-draft|send|single-send|validate|subscribe|unsubscribe|import|purge|schedule|end|rerun|attach-to-lang-group|detach-from-lang-group|create-language-variation|update-languages|set-new-lang-primary|gdpr-delete)$/;

/**
 * Classify an endpoint by what it does to its resource, and return the
 * resource's base path so siblings (list / get / search / batch …) of the same
 * resource can find each other.
 */
export function actionOf(method: string, path: string): { action: ActionKey; base: string } {
  const m = method.toLowerCase();
  const batch = path.match(/^(.*)\/batch\/(read|create|update|upsert|archive)$/);
  if (m === "post" && batch) return { action: `batch_${batch[2]}` as ActionKey, base: batch[1] };
  if (m === "post" && path.endsWith("/search")) return { action: "search", base: path.slice(0, -"/search".length) };
  if (m === "post" && path.endsWith("/merge")) return { action: "merge", base: path.slice(0, -"/merge".length) };

  const segments = path.split("/");
  const last = segments[segments.length - 1] ?? "";
  if (last.startsWith("{")) {
    const base = segments.slice(0, -1).join("/");
    if (m === "get") return { action: ID_LIKE.test(last.slice(1, -1)) ? "get" : "other", base };
    if (m === "patch" || m === "put") return { action: "update", base };
    if (m === "delete") return { action: "archive", base };
    return { action: "other", base };
  }
  const parent = segments[segments.length - 2] ?? "";
  if (m === "get") {
    // `/{id}/draft` is one sub-resource, `/{id}/revisions` a collection.
    if (parent.startsWith("{") && !last.endsWith("s")) return { action: "other", base: path };
    return { action: "list", base: path };
  }
  if (m === "post" && !ACTION_WORDS.test(last)) return { action: "create", base: path };
  return { action: "other", base: path };
}

/** `eventTemplate` → `event template`, `line-items` → `line items`. */
export function humanize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
}

/** A readable noun for the resource at `base`, e.g. `/cms/v3/hubdb/tables` → `tables`. */
export function nounFor(base: string): string {
  const statics = base.split("/").filter((s) => s && !s.startsWith("{") && !/^v\d+$/.test(s) && !/^\d{4}-\d{2}/.test(s));
  const last = statics[statics.length - 1];
  if (!last || last === "objects") return "records";
  return humanize(last);
}

const singular = (noun: string) => (/[^s]s$/.test(noun) ? noun.slice(0, -1) : noun);

const PARAM_HINTS: Record<string, string> = {
  after: "Paging cursor. Pass paging.next.after from the previous response to get the next page; omit it for the first page.",
  before: "Paging cursor for the previous page.",
  limit: "Maximum number of results per page.",
  offset: "Number of results to skip, for paging.",
  archived: "true returns only archived items; false (the default) returns active ones.",
  properties: "Property names to include in the response.",
  propertiesWithHistory: "Property names to return together with their history of previous values.",
  associations: "Object types whose associated record IDs should be included in the response.",
  idProperty: "Name of a unique-value property that identifies the records, used instead of the record ID.",
  objectType: "CRM object type: a name such as contacts, companies, deals or tickets, or an objectTypeId such as 0-1, or 2-12345 for a custom object.",
  fromObjectType: "Object type of the source records, e.g. contacts or 0-1.",
  toObjectType: "Object type of the records on the other side of the association, e.g. companies or 0-2.",
  objectId: "ID of the CRM record.",
  fromObjectId: "ID of the source record.",
  toObjectId: "ID of the record on the other side of the association.",
  associationType: "Association type ID that describes how the two records relate.",
  appId: "ID of the HubSpot developer app that owns this resource.",
  portalId: "HubSpot account (portal) ID.",
  tableIdOrName: "HubDB table ID or table name.",
  sort: "Field to sort the results by.",
  property: "Property name.",
  propertyName: "Internal property name (not its label).",
  userId: "HubSpot user ID.",
  ownerId: "HubSpot owner ID.",
  channelId: "Conversations channel ID.",
  threadId: "Conversations thread ID.",
  pipelineId: "Pipeline ID.",
  stageId: "Pipeline stage ID.",
  createdAfter: "Only include items created after this date-time.",
  createdBefore: "Only include items created before this date-time.",
  updatedAfter: "Only include items updated after this date-time.",
  updatedBefore: "Only include items updated before this date-time.",
  createdAt: "Only include items created at exactly this date-time.",
  updatedAt: "Only include items updated at exactly this date-time.",
  flagName: "Name of the feature flag.",
  eventTemplateId: "ID of the timeline event template.",
  occurredAfter: "Only include events that occurred after this date-time.",
  occurredBefore: "Only include events that occurred before this date-time.",
  path: "Path of the file or folder, e.g. my-theme/templates/home.html.",
  environment: "Source code environment: draft or published.",
  eventName: "Internal name of the custom event definition.",
  groupName: "Internal name of the property group.",
  token: "The OAuth token (access or refresh token, depending on the endpoint).",
  ruleType: "Type of the property validation rule.",
  slug: "Meeting link slug: the last part of the booking page URL.",
  tokenName: "Name of the event template token.",
  id: "ID of the resource.",
  accountToken: "Staging token of the channel account.",
  mediaType: "Media type of the object definition, e.g. VIDEO.",
  emailAddress: "Email address of the contact.",
  q: "Free-text search query.",
  query: "Free-text search query.",
  email: "Email address.",
};

/** A description for a parameter the spec left undocumented, when its name is unambiguous. */
export function fallbackParamDescription(name: string): string | undefined {
  if (PARAM_HINTS[name]) return PARAM_HINTS[name];
  const id = name.match(/^([a-zA-Z]+?)(Id|Ids|IdOrName)$/);
  if (id) {
    const subject = humanize(id[1]);
    if (id[2] === "Ids") return `IDs of the ${subject} items.`;
    if (id[2] === "IdOrName") return `ID or name of the ${subject}.`;
    return `ID of the ${subject}.`;
  }
  return undefined;
}

/** Strip markdown links and HTML from spec prose and collapse whitespace. */
export function cleanText(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut `text` to at most `max` characters, preferring a sentence boundary. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const stop = head.lastIndexOf(". ");
  if (stop > max * 0.5) return head.slice(0, stop + 1);
  const space = head.lastIndexOf(" ");
  return `${head.slice(0, space > 0 ? space : max)}…`;
}

export const asSentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

const VERB: Partial<Record<ActionKey, [string, "one" | "many"]>> = {
  list: ["List", "many"],
  get: ["Get one", "one"],
  create: ["Create a", "one"],
  update: ["Update a", "one"],
  archive: ["Delete a", "one"],
  search: ["Search", "many"],
  batch_read: ["Read a batch of", "many"],
  batch_create: ["Create a batch of", "many"],
  batch_update: ["Update a batch of", "many"],
  batch_upsert: ["Create or update a batch of", "many"],
  batch_archive: ["Delete a batch of", "many"],
  merge: ["Merge two", "many"],
};

/** What the tool does, from the spec summary or, when HubSpot gave none, from its shape. */
export function purposeFor(summary: string | undefined, method: string, path: string): string {
  const cleaned = cleanText(summary);
  if (cleaned) return asSentence(cleaned);
  const { action, base } = actionOf(method, path);
  const verb = VERB[action];
  const noun = nounFor(base);
  if (!verb) return `Call ${method.toUpperCase()} ${path}.`;
  return `${verb[0]} ${verb[1] === "one" ? singular(noun) : noun}.`;
}

export interface GuidanceContext {
  /** Name of a sibling tool on the same resource, if one exists. */
  sibling: (action: ActionKey) => string | undefined;
  /** Plural noun for the resource, e.g. "records", "tables". */
  noun: string;
  /** True for the CRM objects API, whose batch and search limits are documented. */
  crmObjects: boolean;
  /** The tool takes an `after` paging cursor. */
  cursor: boolean;
}

/** When to use this tool and which sibling to prefer instead. Undefined when nothing useful applies. */
export function usageGuidance(action: ActionKey, ctx: GuidanceContext): string | undefined {
  const { sibling: s, noun } = ctx;
  const one = singular(noun);
  const parts: string[] = [];
  const batchLimit = ctx.crmObjects ? " Up to 100 inputs per request." : "";
  switch (action) {
    case "list":
      parts.push(
        ctx.cursor
          ? `Use to page through ${noun}: pass limit, then the after cursor from paging.next.after for the next page.`
          : `Use to list ${noun}.`,
      );
      if (s("search")) parts.push(`To filter by property values, use ${s("search")} instead.`);
      if (s("batch_read")) parts.push(`To fetch specific IDs, use ${s("batch_read")}.`);
      break;
    case "get":
      parts.push(`Use when you already know the ${one}'s ID.`);
      if (s("batch_read")) parts.push(`For several IDs at once, use ${s("batch_read")}.`);
      if (s("search") ?? s("list")) parts.push(`To find an ID, use ${s("search") ?? s("list")}.`);
      break;
    case "search":
      parts.push(
        ctx.crmObjects
          ? "Filters inside one filterGroup must all match; separate filterGroups are alternatives. Returns at most 200 results per page and 10,000 in total; page with after."
          : `Use to find ${noun} that match filters.`,
      );
      if (s("get")) parts.push(`To load one record whose ID you know, use ${s("get")}.`);
      break;
    case "create":
      parts.push(`Use to add one new ${one}.`);
      if (s("search")) parts.push(`Check with ${s("search")} first to avoid duplicates.`);
      if (s("batch_create")) parts.push(`For many at once, use ${s("batch_create")}.`);
      if (s("batch_upsert")) parts.push(`To create or update by a unique property, use ${s("batch_upsert")}.`);
      break;
    case "update":
      parts.push(`Use to change one existing ${one} by ID; send only the fields that change.`);
      if (s("batch_update")) parts.push(`For many at once, use ${s("batch_update")}.`);
      break;
    case "archive":
      if (s("get")) parts.push(`Confirm it is the right ${one} with ${s("get")} first.`);
      if (s("batch_archive")) parts.push(`To delete many at once, use ${s("batch_archive")}.`);
      break;
    case "batch_read":
      parts.push(`Use to read many ${noun} by ID in one request${s("get") ? ` instead of repeated ${s("get")} calls` : ""}.${batchLimit}`);
      break;
    case "batch_create":
    case "batch_update":
    case "batch_upsert":
    case "batch_archive":
      parts.push(`Use to change many ${noun} in one request.${batchLimit}`);
      break;
    case "merge":
      parts.push(`Use only after the user has confirmed both records${s("get") ? ` (load them with ${s("get")})` : ""}.`);
      break;
    default:
      break;
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export interface DescriptionParts {
  banner: string;
  purpose: string;
  guidance?: string;
  blurb: string;
  facts: string[];
  detail?: string;
  endpoint: string;
}

/**
 * Purpose first (so a truncated list still reads well), then when to use it,
 * what it changes, plan and scope requirements, HubSpot's own notes, and the
 * raw endpoint last for reference.
 */
export function assembleDescription(p: DescriptionParts): string {
  return [
    `${p.banner} · ${p.purpose}`,
    p.guidance,
    p.blurb,
    p.facts.length > 0 ? p.facts.join(" ") : undefined,
    p.detail,
    `Endpoint: ${p.endpoint}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");
}
