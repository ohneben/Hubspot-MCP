import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RateLimiter } from "./rateLimiter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// HubSpot's tightest burst limit is 100 requests / 10 s (private apps on
// Free/Starter). We default exactly at that window and let retries cover the
// rest; raise it if your plan/app allows more.
const DEFAULT_MAX_REQUESTS = 100;
const DEFAULT_RATE_WINDOW_MS = 10_000;
// The CRM search endpoints have their own cap (~5 req/s per token) — throttle
// a touch under it.
const DEFAULT_SEARCH_MAX_REQUESTS = 4;
const DEFAULT_SEARCH_RATE_WINDOW_MS = 1_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
// 0 disables the response-size guard.
const DEFAULT_MAX_RESPONSE_CHARS = 0;

export type ToolMode = "all" | "discovery";

export interface ServerConfig {
  /** Scheme + host of the HubSpot API (default https://api.hubapi.com). */
  baseUrl: string;
  /** Service key / private-app token (`pat-…`) or OAuth access token; "" when unset. */
  accessToken: string;
  specDir: string;

  maxRetries: number;
  timeoutMs: number;
  rateLimiter?: RateLimiter;
  /** Extra limiter applied to CRM `/search` calls on top of the global one. */
  searchRateLimiter?: RateLimiter;

  // ── Tool-surface controls ───────────────────────────────────────────────
  /** If set, only these groups (or `area:*` wildcards) are exposed. */
  includeGroups?: Set<string>;
  /** These groups (or `area:*` wildcards) are hidden. */
  excludeGroups?: Set<string>;
  /** Hide every write/destructive tool — expose read-only tools only. */
  readOnly: boolean;
  /** Include beta / developer-preview APIs (default true — full coverage). */
  includeBeta: boolean;
  /** `discovery` (default) = 3 meta-tools that search, inspect and invoke the
   * registry; `all` = one tool per endpoint or endpoint family. */
  toolMode: ToolMode;
  /** Check scopes and probe paid-tier or beta groups when the server starts. */
  capabilityCheck: boolean;
  /** Expose the CRM GraphQL query tool. */
  enableGraphql: boolean;
  /** GraphQL endpoint (CRM GraphQL API). */
  graphqlUrl: string;
  /** Expose the raw `hubspot_api_request` escape hatch. */
  enableRawRequest: boolean;

  /** Truncate tool responses longer than this many characters (0 = never). */
  maxResponseChars: number;

  fetchImpl?: typeof fetch;
}

/** The token is not needed to start: tools/list works without it, and tool
 * calls report the missing token instead. Empty string when unset. */
function tokenEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** Read a non-negative integer env var, falling back when unset/invalid. */
function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/** Parse a comma/space-separated group list into a lowercased Set (or undefined). */
function groupSetEnv(name: string): Set<string> | undefined {
  const v = process.env[name];
  if (!v || v.trim().length === 0) return undefined;
  const items = v
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return items.length > 0 ? new Set(items) : undefined;
}

function baseUrlEnv(): string {
  const raw = process.env.HUBSPOT_BASE_URL?.trim() || "https://api.hubapi.com";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    throw new Error(
      `HUBSPOT_BASE_URL is not a valid URL: "${raw}". ` +
        `Expected https://api.hubapi.com (default) or https://api-eu1.hubapi.com for EU data residency.`,
    );
  }
}

function toolModeEnv(): ToolMode {
  const v = (process.env.HUBSPOT_TOOL_MODE?.trim() || "discovery").toLowerCase();
  if (v === "all" || v === "discovery") return v;
  throw new Error(`Unknown HUBSPOT_TOOL_MODE: "${v}". Use "all" or "discovery".`);
}

function resolveSpecDir(): string {
  const explicit = process.env.HUBSPOT_SPEC_DIR;
  if (explicit) {
    const abs = resolve(explicit);
    if (!existsSync(abs)) throw new Error(`HUBSPOT_SPEC_DIR not found: ${abs}`);
    return abs;
  }
  // Bundled specs: dist/ is a sibling of spec/ at the package root.
  const bundled = resolve(__dirname, "..", "spec");
  if (existsSync(bundled)) return bundled;
  throw new Error(`Could not locate the bundled spec/ directory. Set HUBSPOT_SPEC_DIR to point at it.`);
}

export function loadConfig(): ServerConfig {
  const baseUrl = baseUrlEnv();
  const maxRequests = intEnv("HUBSPOT_MAX_REQUESTS", DEFAULT_MAX_REQUESTS);
  const windowMs = intEnv("HUBSPOT_RATE_WINDOW_MS", DEFAULT_RATE_WINDOW_MS);
  const searchMax = intEnv("HUBSPOT_SEARCH_MAX_REQUESTS", DEFAULT_SEARCH_MAX_REQUESTS);
  const searchWindowMs = intEnv("HUBSPOT_SEARCH_RATE_WINDOW_MS", DEFAULT_SEARCH_RATE_WINDOW_MS);

  return {
    baseUrl,
    accessToken: tokenEnv("HUBSPOT_ACCESS_TOKEN"),
    specDir: resolveSpecDir(),
    maxRetries: intEnv("HUBSPOT_MAX_RETRIES", DEFAULT_MAX_RETRIES),
    timeoutMs: intEnv("HUBSPOT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    rateLimiter: maxRequests > 0 ? new RateLimiter(maxRequests, windowMs) : undefined,
    searchRateLimiter: searchMax > 0 ? new RateLimiter(searchMax, searchWindowMs) : undefined,

    includeGroups: groupSetEnv("HUBSPOT_INCLUDE_GROUPS"),
    excludeGroups: groupSetEnv("HUBSPOT_EXCLUDE_GROUPS"),
    readOnly: boolEnv("HUBSPOT_READ_ONLY", false),
    includeBeta: boolEnv("HUBSPOT_INCLUDE_BETA", true),
    toolMode: toolModeEnv(),
    capabilityCheck: boolEnv("HUBSPOT_CAPABILITY_CHECK", true),
    enableGraphql: boolEnv("HUBSPOT_ENABLE_GRAPHQL", true),
    graphqlUrl: process.env.HUBSPOT_GRAPHQL_URL?.trim() || `${baseUrl}/collector/graphql`,
    enableRawRequest: boolEnv("HUBSPOT_ENABLE_RAW_REQUEST", true),

    maxResponseChars: intEnv("HUBSPOT_MAX_RESPONSE_CHARS", DEFAULT_MAX_RESPONSE_CHARS),
  };
}
