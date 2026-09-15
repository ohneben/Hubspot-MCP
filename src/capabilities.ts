import type { ServerConfig } from "./config.js";
import type { Operation } from "./openapi.js";
import { formatRequirements, HUB_NAMES, type CatalogEntry, type HubKey } from "./specs.js";
import { categoryForOperation, safetyBucket } from "./categories.js";
import type { ToolDefinition } from "./tools.js";

/**
 * The access check behind `hubspot_get_capabilities`: "what can THIS portal
 * and token actually use?"
 *
 * HubSpot's API surface depends on which hubs and plan tiers an account has
 * (HubDB needs Content/Marketing Hub Professional, custom-object schemas need
 * Enterprise, …) and on which scopes the token was granted. HubSpot has no API
 * that returns the subscription, so the check combines what can be observed:
 *
 *   - account details (portal ID, type, currency, time zone, data hosting),
 *   - the token's granted scopes (private-app tokens and OAuth tokens),
 *   - today's API usage against the daily limit (private apps),
 *   - per API group: how many endpoints the scopes unlock, the plan tier
 *     HubSpot publishes for it, and beta status,
 *   - one cheap live read per paid-tier or beta group, because plan gates only
 *     show up as a 403.
 *
 * The server runs it once at startup and keeps the result, so the model starts
 * with an access status for every group instead of finding out through 403s.
 */
export const CAPABILITIES_TOOL_NAME = "hubspot_get_capabilities";

export function capabilitiesTool(): ToolDefinition {
  const description = [
    "🟢 READ-ONLY · HubSpot account access report",
    "Reports what THIS HubSpot account and token can use: portal details, granted scopes, daily API usage, and for every API group an access status (available, missing_scopes, blocked, unverified) with the reason, the plan tier HubSpot requires and the scopes that would unlock it.",
    "The server already ran this check at startup, probing each paid-tier or beta group with one cheap read, so a plain call returns that result without new API calls. " +
      "Pass refresh=true after the token's scopes or the portal's subscription changed. probe_groups live-probes further groups, one API call each.",
  ].join("\n\n");

  return {
    name: CAPABILITIES_TOOL_NAME,
    description,
    inputSchema: {
      type: "object",
      properties: {
        refresh: {
          type: "boolean",
          description: "Run the check again instead of returning the startup result. Costs one API call per probed group. Default false.",
        },
        probe_groups: {
          type: "array",
          items: { type: "string" },
          description:
            'Extra group keys to live-probe with one parameter-free read each (e.g. ["contacts"]). Implies a fresh check. Costs one API call per group.',
        },
        include_api_usage: {
          type: "boolean",
          description: "Include today's API usage vs. the daily limit (private-app tokens only). Default true.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "What can this HubSpot account + token do?",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    operation: null,
  };
}

interface SimpleResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

async function simpleFetch(
  cfg: ServerConfig,
  method: "GET" | "POST",
  url: string,
  jsonBody?: unknown,
): Promise<SimpleResponse> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  if (cfg.rateLimiter) await cfg.rateLimiter.acquire();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${cfg.accessToken}`,
        ...(jsonBody !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
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
  } catch (err) {
    return { status: 0, ok: false, body: { error: err instanceof Error ? err.message : String(err) } };
  } finally {
    clearTimeout(timer);
  }
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Fetch the token's granted scopes + identity, handling both token kinds. */
async function fetchTokenInfo(cfg: ServerConfig): Promise<Record<string, unknown>> {
  const isPrivateApp = cfg.accessToken.startsWith("pat-");
  if (isPrivateApp) {
    const res = await simpleFetch(cfg, "POST", `${cfg.baseUrl}/oauth/v2/private-apps/get/access-token-info`, {
      tokenKey: cfg.accessToken,
    });
    if (res.ok) {
      const b = asRecord(res.body);
      return {
        tokenType: "private-app",
        hubId: b.hubId,
        appId: b.appId,
        userId: b.userId,
        scopes: Array.isArray(b.scopes) ? b.scopes : [],
      };
    }
    return { tokenType: "private-app", error: `Could not introspect token (HTTP ${res.status}).`, scopes: [] };
  }

  const res = await simpleFetch(cfg, "GET", `${cfg.baseUrl}/oauth/v1/access-tokens/${encodeURIComponent(cfg.accessToken)}`);
  if (res.ok) {
    const b = asRecord(res.body);
    return {
      tokenType: "oauth",
      hubId: b.hub_id,
      appId: b.app_id,
      user: b.user,
      expiresIn: b.expires_in,
      scopes: Array.isArray(b.scopes) ? b.scopes : [],
    };
  }
  return { tokenType: "oauth (unverified)", error: `Could not introspect token (HTTP ${res.status}).`, scopes: [] };
}

/** True when the token's scopes satisfy at least one scope alternative. */
export function scopesSatisfy(scopeAlternatives: string[][], granted: Set<string>): boolean {
  if (scopeAlternatives.length === 0) return true; // endpoint lists no scopes
  return scopeAlternatives.some((alt) => alt.every((s) => granted.has(s)));
}

export type GroupAccess = "available" | "missing_scopes" | "blocked" | "unverified";

export interface GroupReport {
  group: string;
  api: string;
  area: string;
  plan?: string;
  beta?: true;
  tools: { read: number; write: number; destructive: number };
  /** endpoints usable with the token's current scopes, e.g. "13/16". */
  unlockedByScopes?: string;
  /** A sample scope set that would unlock the group when nothing is unlocked. */
  scopesNeeded?: string[];
  access: GroupAccess;
  accessReason: string;
  probe?: { status: number; ok: boolean; endpoint: string; category?: string; message?: string } | { skipped: string };
}

export interface CapabilityProfile {
  checkedAt: string;
  account: unknown;
  token: Record<string, unknown>;
  dailyApiUsage?: unknown;
  toolGroups: GroupReport[];
  notes: string[];
}

export type ProbeFn = (
  cfg: ServerConfig,
  op: Operation,
  args: unknown,
) => Promise<{ status: number; ok: boolean; body?: unknown }>;

/**
 * Fixed path values for groups whose only collection read needs one. The
 * appointments API is served per object type (checked against a live portal);
 * HubSpot's forecasts spec names `forecast` as the object.
 */
const PROBE_PATH_VALUES: Record<string, Record<string, string>> = {
  appointments: { objectType: "appointments" },
  forecasts: { objectType: "forecast" },
};

/** Pick a cheap GET to probe a group with: no required parameters beyond the known path values. */
export function pickProbeOperation(ops: Operation[], pathValues: Record<string, string> = {}): Operation | undefined {
  const candidates = ops
    .filter((op) => op.method === "get")
    .filter((op) => [...op.path.matchAll(/\{([^}]+)\}/g)].every((hit) => hit[1] in pathValues))
    .filter((op) => op.parameters.filter((p) => p.required).every((p) => p.in === "path" && p.name in pathValues));
  // Shortest path ≈ the collection root — the cheapest representative read.
  return candidates.sort((a, b) => a.path.length - b.path.length)[0];
}

const clipMessage = (message: string, max = 160) => (message.length > max ? `${message.slice(0, max)}…` : message);

/** Paid plan tiers, as opposed to hub availability on the free tier. */
const PAID_TIER = /Starter|Professional|Enterprise/;

/** A group whose published plan tier or beta status can block a token that has the scopes. */
function isGated(entry: CatalogEntry): boolean {
  const plan = formatRequirements(entry.requirements);
  return Boolean(plan && !plan.startsWith("any")) || entry.beta;
}

interface AccessContext {
  gated: boolean;
  scopesKnown: boolean;
  granted: Set<string>;
  /** The token could be introspected, so a 401 on one API is about that API. */
  tokenUsable: boolean;
  /** Whether the token holds the scopes the probed endpoint lists (undefined when unknown). */
  probeScopesHeld?: boolean;
  unlocked: number;
  total: number;
}

function decideAccess(report: GroupReport, ctx: AccessContext): Pick<GroupReport, "access" | "accessReason"> {
  const { gated, scopesKnown, granted, tokenUsable, probeScopesHeld, unlocked, total } = ctx;
  if (scopesKnown && unlocked === 0) {
    const needed = report.scopesNeeded ? ` (for example ${report.scopesNeeded.join(", ")})` : "";
    return { access: "missing_scopes", accessReason: `The token has none of the scopes this group needs${needed}.` };
  }
  const partial = scopesKnown && unlocked < total ? ` Its scopes cover ${unlocked} of ${total} endpoints.` : "";
  const probe = report.probe;
  if (probe && "status" in probe) {
    const said = probe.message ? ` HubSpot says: "${clipMessage(probe.message)}"` : "";
    if (probe.ok) {
      // A read can succeed on a plan that still refuses writes (schemas list works below Enterprise).
      const writes =
        report.plan && PAID_TIER.test(report.plan)
          ? ` That proves read access only; writes can still be refused without ${report.plan}.`
          : "";
      return { access: "available", accessReason: `Verified: ${probe.endpoint} returned ${probe.status}.${writes}${partial}` };
    }
    if (probe.status === 403) {
      const message = probe.message ?? "";
      if (/available for public use/i.test(message)) {
        return {
          access: "blocked",
          accessReason: `${probe.endpoint} returned 403: HubSpot does not offer this API's scope to service keys or private apps.${said}`,
        };
      }
      // e.g. "Insufficient scopes, requires one of: [event-detail-read,web-analytics-api-access]"
      const named = (message.match(/requires one of:\s*\[([^\]]*)\]/i)?.[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (named.length > 0 && !named.some((s) => granted.has(s))) {
        return {
          access: "missing_scopes",
          accessReason: `${probe.endpoint} needs one of ${named.join(", ")}, which the token does not have.`,
        };
      }
      if (probe.category === "MISSING_SCOPES" && probeScopesHeld === false) {
        return {
          access: "missing_scopes",
          accessReason: `${probe.endpoint} returned 403 MISSING_SCOPES and the token lacks the scopes this endpoint lists.${said}`,
        };
      }
      if (probe.category === "MISSING_SCOPES") {
        // Seen live for leads, goals and feedback submissions: the token held the
        // object's read scope and HubSpot still answered MISSING_SCOPES.
        return {
          access: "blocked",
          accessReason: `${probe.endpoint} returned 403 MISSING_SCOPES although the token holds the scopes this endpoint lists, which usually means the portal's plan does not include it${report.plan ? ` (needs ${report.plan})` : ""}.${said}`,
        };
      }
    }
    if (probe.status === 403) {
      return {
        access: "blocked",
        accessReason: `${probe.endpoint} returned 403: the portal's plan${report.plan ? ` (needs ${report.plan})` : ""} or the token user's permissions do not allow it.${said}`,
      };
    }
    if (probe.status === 401 && tokenUsable) {
      return {
        access: "blocked",
        accessReason: `${probe.endpoint} returned 401 although the token works for other APIs, so this API does not accept this kind of token (it may need an OAuth app token).${said}`,
      };
    }
    if (probe.status === 404 && report.beta) {
      return { access: "blocked", accessReason: `${probe.endpoint} returned 404: this beta API is probably not enabled for the portal.${said}` };
    }
    return {
      access: "unverified",
      accessReason: `${probe.endpoint} returned ${probe.status ? `HTTP ${probe.status}` : "no response"}.${said}${partial}`,
    };
  }
  if (gated) {
    const skipped = probe && "skipped" in probe ? ` (${probe.skipped})` : "";
    return { access: "unverified", accessReason: `Needs ${report.plan ?? "beta access"}; not verified${skipped}.${partial}` };
  }
  if (scopesKnown) return { access: "available", accessReason: `Scopes granted and no paid tier required.${partial}` };
  return { access: "unverified", accessReason: "The token's scopes could not be read." };
}

export interface CheckOptions {
  /** Probe every paid-tier or beta group the scopes do not already rule out. Default true. */
  probeGated?: boolean;
  /** Additional group keys to probe. */
  probeGroups?: Set<string>;
  includeUsage?: boolean;
}

export async function checkCapabilities(
  cfg: ServerConfig,
  operations: Operation[],
  callProbe: ProbeFn,
  options: CheckOptions = {},
): Promise<CapabilityProfile> {
  const [account, tokenInfo] = await Promise.all([
    simpleFetch(cfg, "GET", `${cfg.baseUrl}/account-info/v3/details`),
    fetchTokenInfo(cfg),
  ]);

  const granted = new Set((tokenInfo.scopes as string[]) ?? []);
  const scopesKnown = granted.size > 0;

  let usage: unknown;
  if (options.includeUsage !== false && cfg.accessToken.startsWith("pat-")) {
    const res = await simpleFetch(cfg, "GET", `${cfg.baseUrl}/account-info/v3/api-usage/daily/private-apps`);
    usage = res.ok ? res.body : { note: `API usage unavailable (HTTP ${res.status}).` };
  }

  const byGroup = new Map<string, Operation[]>();
  for (const op of operations) {
    const list = byGroup.get(op.group) ?? [];
    list.push(op);
    byGroup.set(op.group, list);
  }

  const groups = await Promise.all(
    [...byGroup.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([group, ops]): Promise<GroupReport> => {
        const entry = ops[0].entry;
        const counts = { read: 0, write: 0, destructive: 0 };
        let unlocked = 0;
        for (const op of ops) {
          counts[safetyBucket(categoryForOperation(op.method, op.path).id)]++;
          if (scopesKnown && scopesSatisfy(op.scopeAlternatives, granted)) unlocked++;
        }

        const report: GroupReport = {
          group,
          api: entry.name,
          area: entry.area,
          plan: formatRequirements(entry.requirements),
          ...(entry.beta ? { beta: true as const } : {}),
          tools: counts,
          access: "unverified",
          accessReason: "",
        };
        if (scopesKnown) {
          report.unlockedByScopes = `${unlocked}/${ops.length}`;
          if (unlocked === 0) {
            const sample = ops[0].scopeAlternatives[0];
            if (sample && sample.length > 0) report.scopesNeeded = sample;
          }
        }

        const ruledOutByScopes = scopesKnown && unlocked === 0;
        const wantProbe =
          !ruledOutByScopes &&
          ((options.probeGated !== false && isGated(entry)) || Boolean(options.probeGroups?.has(group.toLowerCase())));
        let probeScopesHeld: boolean | undefined;
        if (wantProbe) {
          const pathValues = PROBE_PATH_VALUES[group] ?? {};
          const probeOp = pickProbeOperation(ops, pathValues);
          if (probeOp && scopesKnown) probeScopesHeld = scopesSatisfy(probeOp.scopeAlternatives, granted);
          if (!probeOp) {
            report.probe = {
              skipped: ops.some((op) => op.method === "get")
                ? "every read endpoint needs an ID or object type this check does not know"
                : "the group has no read endpoint, and writes are never used for testing",
            };
          } else {
            const probeArgs: Record<string, unknown> = {};
            for (const p of probeOp.parameters) {
              if (p.in === "path" && p.name in pathValues) probeArgs[p.argName ?? p.name] = pathValues[p.name];
              if (p.in === "query" && p.name === "limit") probeArgs[p.argName ?? p.name] = 1;
            }
            const endpoint = `GET ${probeOp.path.replace(/\{([^}]+)\}/g, (hit, name: string) => pathValues[name] ?? hit)}`;
            try {
              const res = await callProbe(cfg, probeOp, probeArgs);
              const body = asRecord(res.body);
              report.probe = {
                status: res.status,
                ok: res.ok,
                endpoint,
                ...(!res.ok && typeof body.category === "string" ? { category: body.category } : {}),
                ...(!res.ok && typeof body.message === "string" ? { message: body.message } : {}),
              };
            } catch (err) {
              report.probe = { skipped: `probe failed: ${err instanceof Error ? err.message : String(err)}` };
            }
          }
        }

        Object.assign(
          report,
          decideAccess(report, {
            gated: isGated(entry),
            scopesKnown,
            granted,
            tokenUsable: !tokenInfo.error,
            probeScopesHeld,
            unlocked,
            total: ops.length,
          }),
        );
        return report;
      }),
  );

  const hubRequirementKeys = Object.keys(HUB_NAMES) as HubKey[];
  return {
    checkedAt: new Date().toISOString(),
    account: account.ok
      ? account.body
      : { note: `Account details unavailable (HTTP ${account.status}). The token may lack the account-info scopes.` },
    token: tokenInfo,
    ...(usage !== undefined ? { dailyApiUsage: usage } : {}),
    toolGroups: groups,
    notes: [
      "access: available = scopes granted and, for paid-tier or beta groups, a live read succeeded (a read does not prove writes are allowed); missing_scopes = the token lacks every scope the group needs, or a live read named scopes the token lacks; blocked = a live read returned 403 (plan tier or user permission, including MISSING_SCOPES although the token holds the listed scopes), 401 (the API does not accept this kind of token) or 404 for a beta; unverified = could not be confirmed.",
      "unlockedByScopes counts endpoints whose required scopes this token holds; it does not check plan tier.",
      "plan is HubSpot's published minimum tier per hub for the API. HubSpot has no API that returns the portal's subscription, so tiers are verified by probing.",
      `Hub keys: ${hubRequirementKeys.map((k) => `${k}=${HUB_NAMES[k]}`).join(", ")}.`,
    ],
  };
}

/** Access status per group key. */
export function accessByGroup(profile: CapabilityProfile | undefined): Map<string, GroupReport> {
  return new Map((profile?.toolGroups ?? []).map((g) => [g.group, g]));
}

const listUpTo = (items: string[], max: number) =>
  items.length > max ? `${items.slice(0, max).join(", ")} and ${items.length - max} more` : items.join(", ");

/** A few sentences for the server instructions, so the model starts with the result. */
export function summarizeProfile(profile: CapabilityProfile): string {
  const groupsWith = (access: GroupAccess) => profile.toolGroups.filter((g) => g.access === access).map((g) => g.group);
  const tokenError = typeof profile.token.error === "string" ? profile.token.error : undefined;
  if (tokenError && groupsWith("available").length === 0) {
    return `The access check at ${profile.checkedAt} could not read the token's scopes (${tokenError}), so no API group is confirmed. Call ${CAPABILITIES_TOOL_NAME} with refresh=true once HubSpot is reachable.`;
  }
  const portal = asRecord(profile.account).portalId;
  const parts = [
    `Access check at ${profile.checkedAt}${portal ? ` for portal ${portal}` : ""}: ${groupsWith("available").length} of ${profile.toolGroups.length} API groups are usable with this token.`,
  ];
  const missing = groupsWith("missing_scopes");
  if (missing.length > 0) parts.push(`Missing scopes: ${listUpTo(missing, 25)}.`);
  const blocked = groupsWith("blocked");
  if (blocked.length > 0) parts.push(`Blocked by plan tier, permissions or token type: ${listUpTo(blocked, 25)}.`);
  const unverified = groupsWith("unverified");
  if (unverified.length > 0) parts.push(`Not verified: ${listUpTo(unverified, 25)}.`);
  const readOnlyProof = profile.toolGroups
    .filter((g) => g.access === "available" && g.probe && "ok" in g.probe && g.probe.ok && g.plan && PAID_TIER.test(g.plan))
    .map((g) => g.group);
  if (readOnlyProof.length > 0) {
    parts.push(`Paid-tier groups confirmed only by a read can still refuse writes: ${listUpTo(readOnlyProof, 10)}.`);
  }
  parts.push(`Prefer tools in usable groups; ${CAPABILITIES_TOOL_NAME} gives the reason and the scopes to add for each group.`);
  return parts.join(" ");
}

export async function runCapabilities(
  cfg: ServerConfig,
  operations: Operation[],
  rawArgs: unknown,
  callProbe: ProbeFn,
  cache?: { profile?: CapabilityProfile },
): Promise<string> {
  const args = asRecord(rawArgs);
  const probeGroups = new Set(
    Array.isArray(args.probe_groups) ? (args.probe_groups as unknown[]).map((g) => String(g).toLowerCase()) : [],
  );

  if (cache?.profile && args.refresh !== true && probeGroups.size === 0) {
    return JSON.stringify(cache.profile, null, 2);
  }

  const profile = await checkCapabilities(cfg, operations, callProbe, {
    probeGroups,
    includeUsage: args.include_api_usage !== false,
  });
  if (cache) cache.profile = profile;
  return JSON.stringify(profile, null, 2);
}
