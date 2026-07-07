import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The bundled spec set is described by `spec/catalog.json`, which is generated
 * by `scripts/fetch-specs.mjs` from HubSpot's own public API index
 * (https://api.hubspot.com/public/api/spec/v1/specs).
 *
 * Unlike most vendors, HubSpot publishes — per API and version — which hub and
 * plan tier an account needs (e.g. HubDB requires Marketing Hub Professional
 * or Content Hub Professional). The fetch script preserves that in each
 * catalog entry's `requirements`, and the server carries it through to tool
 * descriptions and the `hubspot_get_capabilities` tool.
 */

export type HubKey =
  | "marketing"
  | "sales"
  | "service"
  | "cms"
  | "commerce"
  | "crmHub"
  | "dataHub";

export type Tier = "FREE" | "STARTER" | "PROFESSIONAL" | "ENTERPRISE";

export interface CatalogEntry {
  /** Stable key for this spec file (also the default resource-group key). */
  slug: string;
  /** Resource-group key used for include/exclude filtering. Usually == slug;
   * pinned multi-version APIs share one group (oauth-v1 + oauth-v3 → oauth). */
  group: string;
  /** Filename under spec/. */
  file: string;
  /** Human API name from HubSpot's index (e.g. "Contacts"). */
  name: string;
  /** HubSpot's top-level grouping (e.g. "CRM", "CMS", "Marketing"). */
  area: string;
  /** The bundled version (e.g. "3", "4", "2026-03"). */
  version: string;
  /** HubSpot's stage for that version (STABLE / LATEST / DEVELOPER_PREVIEW). */
  stage: string;
  /** True for developer-preview or public-beta versions. */
  beta: boolean;
  /** Minimum plan tier per hub (null/absent = not available via that hub). */
  requirements: Partial<Record<HubKey, Tier | null>>;
  /** Related HubSpot docs pages. */
  documentation: string[];
  /** Operation count at fetch time (informational). */
  operations: number;
  /** Where the spec was downloaded from. */
  source: string;
}

export interface Catalog {
  fetchedAt: string;
  indexUrl: string;
  apis: CatalogEntry[];
}

/** Human display names for HubSpot's hub keys. */
export const HUB_NAMES: Record<HubKey, string> = {
  marketing: "Marketing Hub",
  sales: "Sales Hub",
  service: "Service Hub",
  cms: "Content Hub",
  commerce: "Commerce Hub",
  crmHub: "Smart CRM",
  dataHub: "Operations Hub",
};

const TIER_LABELS: Record<Tier, string> = {
  FREE: "Free",
  STARTER: "Starter",
  PROFESSIONAL: "Professional",
  ENTERPRISE: "Enterprise",
};

export function loadCatalog(specDir: string): Catalog {
  const raw = readFileSync(resolve(specDir, "catalog.json"), "utf8");
  const catalog = JSON.parse(raw) as Catalog;
  if (!Array.isArray(catalog.apis)) {
    throw new Error(`spec/catalog.json is malformed — run \`npm run fetch-specs\` to regenerate it.`);
  }
  return catalog;
}

/**
 * Render an entry's hub/tier requirements as one short human line, e.g.
 *   "any HubSpot plan (Free and up)"
 *   "Professional tier (Marketing Hub, Sales Hub, …)"
 *   "Marketing Hub Professional, or Content Hub Starter"
 * Returns undefined when HubSpot lists no requirements for the API.
 */
export function formatRequirements(requirements: CatalogEntry["requirements"]): string | undefined {
  const entries = (Object.entries(requirements ?? {}) as Array<[HubKey, Tier | null]>).filter(
    (e): e is [HubKey, Tier] => e[1] != null,
  );
  if (entries.length === 0) return undefined;

  const tiers = new Set(entries.map(([, t]) => t));
  if (tiers.size === 1) {
    const tier = entries[0][1];
    if (tier === "FREE" && entries.length >= 6) return "any HubSpot plan (Free and up)";
    const hubs = entries.map(([h]) => HUB_NAMES[h]);
    if (entries.length >= 6) return `${TIER_LABELS[tier]} tier of any hub`;
    if (hubs.length === 1) return `${hubs[0]} ${TIER_LABELS[tier]}`;
    return `${TIER_LABELS[tier]} tier of ${hubs.join(" / ")}`;
  }
  return entries.map(([h, t]) => `${HUB_NAMES[h]} ${TIER_LABELS[t]}`).join(", or ");
}
