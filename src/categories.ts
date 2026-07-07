/**
 * Safety categorisation for every HubSpot operation.
 *
 * Each tool carries two, complementary signals:
 *   1. machine-readable MCP annotations (`readOnlyHint`, `destructiveHint`, …)
 *      so a well-behaved host (Claude included) can auto-trust reads and demand
 *      confirmation before destructive actions, and
 *   2. a human-readable 🟢 / 🟡 / 🔴 banner prepended to the description so the
 *      model sees the category even if it ignores annotations.
 *
 * A naive "GET = safe, everything-else = write, DELETE = destructive" mapping
 * mislabels a lot of HubSpot's surface:
 *   - `POST …/search` and `POST …/batch/read` *fetch* data — they change nothing;
 *   - `POST /crm/v3/objects/contacts/merge` is **irreversible** — HubSpot cannot
 *     un-merge records;
 *   - `POST …/gdpr-delete` **permanently purges** a contact for GDPR compliance —
 *     unlike a normal archive it never lands in the recycle bin;
 *   - a plain `DELETE /crm/v3/objects/contacts/{id}` only *archives* — the record
 *     is restorable from the recycle bin for 90 days;
 *   - `PUT /crm/v3/lists/{listId}/memberships/add` merely *links* records
 *     (reversible), and the v4 association endpoints do the same;
 *   - `POST /marketing/v3/transactional/single-email/send` emails a real person —
 *     arguably the most consequential call in the whole API;
 *   - `POST /crm/v3/imports` can create/update thousands of records in one call.
 *
 * HubSpot's ~1,000 operations follow strong path conventions, so instead of a
 * hand-written map per operation we apply ordered PATTERN RULES (first match
 * wins) with a small override map for stragglers. A wrong or missing rule falls
 * back to the method-based default, which is always at least as cautious.
 */

export type CategoryId =
  | "read"
  | "query"
  | "create"
  | "upsert"
  | "update"
  | "link"
  | "unlink"
  | "send"
  | "import"
  | "delete"
  | "bulk_delete"
  | "merge"
  | "purge";

export interface CategoryMeta {
  id: CategoryId;
  /** Banner prefixed to the tool description. */
  banner: string;
  /** One-line explanation of what this class of action does. */
  blurb: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

export const CATEGORIES: Record<CategoryId, CategoryMeta> = {
  read: {
    id: "read",
    banner: "🟢 READ-ONLY",
    blurb: "Fetches data. Makes no changes to your HubSpot account.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  query: {
    id: "query",
    banner: "🟢 READ-ONLY · query",
    blurb:
      "Runs a search / batch-read / report (a POST that returns data). Changes no account records; may start a short-lived export or result set.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  create: {
    id: "create",
    banner: "🟡 WRITE · creates data",
    blurb: "Creates one or more records. Not idempotent — calling twice may create duplicates.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  upsert: {
    id: "upsert",
    banner: "🟡 WRITE · creates or updates",
    blurb: "Creates the record if it is new, otherwise updates the existing one (an upsert). Idempotent.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  update: {
    id: "update",
    banner: "🟡 WRITE · updates data",
    blurb: "Modifies an existing record or setting in place. Idempotent.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  link: {
    id: "link",
    banner: "🟡 WRITE · links records",
    blurb:
      "Creates an association between existing records (e.g. adds a record to a list, associates a contact with a company). Reversible.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  unlink: {
    id: "unlink",
    banner: "🟡 WRITE · unlinks records",
    blurb:
      "Removes an association between records (e.g. removes list members, deletes an association label). Reversible — it does not delete the underlying records.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  send: {
    id: "send",
    banner: "🟡 WRITE · sends messages",
    blurb:
      "Sends an outbound message (marketing / transactional email, sequence enrollment, conversation reply) to real recipients. Not reversible once delivered — confirm the audience first.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  import: {
    id: "import",
    banner: "🟡 WRITE · bulk import",
    blurb:
      "Starts an import that can create or update MANY records in one call. High blast radius — double-check the mapping and data before calling.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  delete: {
    id: "delete",
    banner: "🔴 DESTRUCTIVE · deletes data",
    blurb:
      "Deletes/archives a record. CRM object deletes go to the recycle bin (restorable ~90 days); most other deletes are final. Confirm with the user before calling.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  bulk_delete: {
    id: "bulk_delete",
    banner: "🔴 DESTRUCTIVE · bulk delete",
    blurb: "Deletes/archives many records in a single call. High blast radius — always confirm before calling.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  merge: {
    id: "merge",
    banner: "🔴 DESTRUCTIVE · merges records",
    blurb:
      "Merges two records into one. HubSpot CANNOT un-merge — the losing record is gone for good. Always confirm both record IDs with the user first.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  purge: {
    id: "purge",
    banner: "🔴 DESTRUCTIVE · permanent GDPR purge",
    blurb:
      "PERMANENTLY erases data for GDPR compliance — it skips the recycle bin and cannot be undone or restored. Always confirm with the user first.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
};

type Method = string;

interface Rule {
  /** Human note (kept for maintainability; not shown to models). */
  why: string;
  match: (method: Method, path: string) => boolean;
  category: CategoryId;
}

const ends = (path: string, suffix: string) => path.toLowerCase().endsWith(suffix);
const has = (path: string, part: string) => path.toLowerCase().includes(part);

/**
 * Ordered rules — the FIRST match wins, so the sharp exceptions sit on top.
 * Everything here is derived from HubSpot's strong path conventions and was
 * checked against the bundled specs (see tests/categories.test.ts).
 */
export const RULES: Rule[] = [
  {
    why: "GDPR purges are permanent (contacts gdpr-delete, …)",
    match: (_m, p) => has(p, "gdpr"),
    category: "purge",
  },
  {
    why: "Record merges cannot be undone",
    match: (m, p) => m === "post" && ends(p, "/merge"),
    category: "merge",
  },
  {
    why: "POST search endpoints only fetch data (CRM object search, lists search, …)",
    match: (m, p) => m === "post" && ends(p, "/search"),
    category: "query",
  },
  {
    why: "POST batch/read endpoints fetch records by ID",
    match: (m, p) => m === "post" && has(p, "/batch/read"),
    category: "query",
  },
  {
    why: "OAuth token introspection returns token metadata",
    match: (m, p) => m === "post" && ends(p, "/introspect"),
    category: "query",
  },
  {
    why: "Starting a CRM export produces a file; it changes no CRM records",
    match: (m, p) => m === "post" && has(p, "/exports/export"),
    category: "query",
  },
  {
    why: "List membership adds link existing records to a list",
    match: (m, p) => (m === "put" || m === "post") && has(p, "/memberships") && (ends(p, "/add") || has(p, "/add-from/") || ends(p, "/add-and-remove")),
    category: "link",
  },
  {
    why: "List membership removals unlink records (records themselves survive)",
    match: (m, p) =>
      has(p, "/memberships") && (ends(p, "/remove") || m === "delete"),
    category: "unlink",
  },
  {
    why: "v3/v4 association creates link two existing records",
    match: (m, p) => (m === "put" || m === "post") && has(p, "/associations") && !has(p, "/associations/definitions") && !has(p, "/batch/archive") && !ends(p, "/labels"),
    category: "link",
  },
  {
    why: "Association removals unlink records without deleting them",
    match: (m, p) => has(p, "/associations") && !has(p, "/associations/definitions") && (m === "delete" || has(p, "/batch/archive") || has(p, "/archive")),
    category: "unlink",
  },
  {
    why: "Batch archives delete many records at once",
    match: (m, p) => m === "post" && has(p, "/batch/archive"),
    category: "bulk_delete",
  },
  {
    why: "Batch upserts are idempotent create-or-update",
    match: (m, p) => m === "post" && has(p, "/batch/upsert"),
    category: "upsert",
  },
  {
    why: "Batch updates modify existing records",
    match: (m, p) => m === "post" && has(p, "/batch/update"),
    category: "update",
  },
  {
    why: "Marketing single-send + transactional email send real email",
    match: (m, p) => m === "post" && (has(p, "/single-send") || has(p, "/single-email/send")),
    category: "send",
  },
  {
    why: "Enrolling a contact in a sequence starts sending them emails",
    match: (m, p) => m === "post" && has(p, "/sequences") && has(p, "/enrollments"),
    category: "send",
  },
  {
    why: "Posting a message to a conversation thread messages a real person",
    match: (m, p) => m === "post" && has(p, "/conversations/threads/") && ends(p, "/messages"),
    category: "send",
  },
  {
    why: "Starting a CRM import mass-creates/updates records from a file",
    match: (m, p) => m === "post" && ends(p, "/imports"),
    category: "import",
  },
  {
    why: "Cancelling a job/import/event is a reversible state change",
    match: (m, p) => m === "post" && ends(p, "/cancel"),
    category: "update",
  },
  {
    why: "Revoking a token permanently invalidates it",
    match: (m, p) => m === "post" && ends(p, "/revoke"),
    category: "delete",
  },
  {
    why: "Marketing-event upserts are documented as create-or-update",
    match: (m, p) => (m === "put" || m === "post") && ends(p, "/upsert"),
    category: "upsert",
  },
];

/**
 * Manual overrides keyed by `<method> <path>` (lower-case method) for the few
 * operations the rules cannot express. Checked before the rules.
 */
export const CATEGORY_OVERRIDES: Record<string, CategoryId> = {
  // The marketing-events upsert lives at the collection path with PUT.
  "put /marketing/v3/marketing-events/events/{externalEventId}": "upsert",
  // Deleting a refresh token revokes the grant — destructive for the integration.
  "delete /oauth/v1/refresh-tokens/{token}": "delete",
};

function defaultCategory(method: Method): CategoryId {
  switch (method.toLowerCase()) {
    case "get":
      return "read";
    case "delete":
      return "delete";
    case "put":
    case "patch":
      return "update";
    default:
      return "create"; // post
  }
}

export function categoryForOperation(method: Method, path: string): CategoryMeta {
  const m = method.toLowerCase();
  const override = CATEGORY_OVERRIDES[`${m} ${path.toLowerCase()}`];
  if (override) return CATEGORIES[override];
  for (const rule of RULES) {
    if (rule.match(m, path)) return CATEGORIES[rule.category];
  }
  return CATEGORIES[defaultCategory(m)];
}

/** Coarse bucket used for the read-only filter and headline counts. */
export function safetyBucket(id: CategoryId): "read" | "write" | "destructive" {
  if (id === "read" || id === "query") return "read";
  if (id === "delete" || id === "bulk_delete" || id === "merge" || id === "purge") return "destructive";
  return "write";
}
