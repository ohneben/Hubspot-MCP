import type { ServerConfig } from "./config.js";
import type { Operation } from "./openapi.js";
import { formatRequirements, HUB_NAMES, type HubKey } from "./specs.js";
import { categoryForOperation, safetyBucket } from "./categories.js";
import type { ToolDefinition } from "./tools.js";

/**
 * `hubspot_get_capabilities` — the "what can THIS portal actually do?" tool.
 *
 * HubSpot's API surface depends on which hubs and plan tiers an account has
 * (HubDB needs Content/Marketing Hub Professional, custom-object schemas need
 * Enterprise, …) and on which scopes the token was granted. Instead of letting
 * the model discover that through a wall of 403s, this tool reports it up
 * front:
 *
 *   - account details (portal ID, type, currency, time zone, data hosting),
 *   - the token's granted scopes (private-app tokens and OAuth tokens),
 *   - today's API usage against the daily limit (private apps),
 *   - per resource group: how many of its endpoints the current token's
 *     scopes unlock, the plan tier HubSpot lists for it, and beta status,
 *   - optionally, live probes: one cheap read per requested group to verify
 *     end-to-end access empirically (some tier gates only show up as 403s).
 */
export const CAPABILITIES_TOOL_NAME = "hubspot_get_capabilities";

export function capabilitiesTool(): ToolDefinition {
  const description = [
    "🟢 READ-ONLY · HubSpot account capability report",
    "Reports what THIS HubSpot account + token can do: portal details, granted scopes, daily API usage, and — for every tool group — whether the current scopes unlock it, which plan tier HubSpot requires, and whether it is beta.",
    "Call this first in a session (or when you hit a 403) to know which tools will work instead of finding out by trial and error. " +
      'Optional "probe_groups" performs one cheap live read per named group to verify access end-to-end (plan gates often only surface as 403s).',
  ].join("\n\n");

  return {
    name: CAPABILITIES_TOOL_NAME,
    description,
    inputSchema: {
      type: "object",
      properties: {
        probe_groups: {
          type: "array",
          items: { type: "string" },
          description:
            'Group keys to live-probe with one parameter-free read each (e.g. ["contacts","hubdb"]). Costs one API call per group.',
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

interface GroupReport {
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
  probe?: { status: number; ok: boolean; endpoint: string } | { skipped: string };
}

/** Pick a cheap, parameter-free GET to probe a group with. */
export function pickProbeOperation(ops: Operation[]): Operation | undefined {
  const candidates = ops
    .filter((op) => op.method === "get" && !op.path.includes("{"))
    .filter((op) => op.parameters.every((p) => !p.required || p.in !== "path"))
    .filter((op) => op.parameters.filter((p) => p.required).length === 0);
  // Shortest path ≈ the collection root — the cheapest representative read.
  return candidates.sort((a, b) => a.path.length - b.path.length)[0];
}

export async function runCapabilities(
  cfg: ServerConfig,
  operations: Operation[],
  rawArgs: unknown,
  callProbe: (cfg: ServerConfig, op: Operation, args: unknown) => Promise<{ status: number; ok: boolean }>,
): Promise<string> {
  const args = asRecord(rawArgs);
  const includeUsage = args.include_api_usage !== false;
  const probeGroups = new Set(
    Array.isArray(args.probe_groups) ? (args.probe_groups as unknown[]).map((g) => String(g).toLowerCase()) : [],
  );

  const [account, tokenInfo] = await Promise.all([
    simpleFetch(cfg, "GET", `${cfg.baseUrl}/account-info/v3/details`),
    fetchTokenInfo(cfg),
  ]);

  const granted = new Set((tokenInfo.scopes as string[]) ?? []);

  let usage: unknown;
  if (includeUsage && cfg.accessToken.startsWith("pat-")) {
    const res = await simpleFetch(cfg, "GET", `${cfg.baseUrl}/account-info/v3/api-usage/daily/private-apps`);
    usage = res.ok ? res.body : { note: `API usage unavailable (HTTP ${res.status}).` };
  }

  // ── Per-group report ────────────────────────────────────────────────────
  const byGroup = new Map<string, Operation[]>();
  for (const op of operations) {
    const list = byGroup.get(op.group) ?? [];
    list.push(op);
    byGroup.set(op.group, list);
  }

  const groups: GroupReport[] = [];
  for (const [group, ops] of [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = ops[0].entry;
    const counts = { read: 0, write: 0, destructive: 0 };
    let unlocked = 0;
    for (const op of ops) {
      counts[safetyBucket(categoryForOperation(op.method, op.path).id)]++;
      if (granted.size > 0 && scopesSatisfy(op.scopeAlternatives, granted)) unlocked++;
    }

    const report: GroupReport = {
      group,
      api: entry.name,
      area: entry.area,
      plan: formatRequirements(entry.requirements),
      ...(entry.beta ? { beta: true as const } : {}),
      tools: counts,
    };
    if (granted.size > 0) {
      report.unlockedByScopes = `${unlocked}/${ops.length}`;
      if (unlocked === 0) {
        const sample = ops[0].scopeAlternatives[0];
        if (sample && sample.length > 0) report.scopesNeeded = sample;
      }
    }

    if (probeGroups.has(group.toLowerCase())) {
      const probeOp = pickProbeOperation(ops);
      if (!probeOp) {
        report.probe = { skipped: "no parameter-free read endpoint in this group" };
      } else {
        const probeArgs = probeOp.parameters.some((p) => p.in === "query" && p.name === "limit") ? { limit: 1 } : {};
        try {
          const res = await callProbe(cfg, probeOp, probeArgs);
          report.probe = { status: res.status, ok: res.ok, endpoint: `GET ${probeOp.path}` };
        } catch (err) {
          report.probe = { skipped: `probe failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
    }

    groups.push(report);
  }

  const hubRequirementKeys = Object.keys(HUB_NAMES) as HubKey[];
  const result = {
    account: account.ok
      ? account.body
      : { note: `Account details unavailable (HTTP ${account.status}). The token may lack the account-info scopes.` },
    token: tokenInfo,
    ...(usage !== undefined ? { dailyApiUsage: usage } : {}),
    toolGroups: groups,
    notes: [
      "unlockedByScopes counts endpoints whose required scopes this token holds — it does not check plan tier.",
      "plan is HubSpot's published minimum tier per hub for the API; probes verify real access (403 usually = missing scope or plan).",
      `Hub keys: ${hubRequirementKeys.map((k) => `${k}=${HUB_NAMES[k]}`).join(", ")}.`,
    ],
  };

  return JSON.stringify(result, null, 2);
}
