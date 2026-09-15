import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllSpecs } from "../src/openapi.js";
import { loadCatalog } from "../src/specs.js";
import {
  pickProbeOperation,
  runCapabilities,
  scopesSatisfy,
  summarizeProfile,
  type CapabilityProfile,
} from "../src/capabilities.js";
import type { ServerConfig } from "../src/config.js";

const specDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "spec");
const catalog = loadCatalog(specDir);
const operations = loadAllSpecs(specDir, catalog.apis, resolve);

function cfg(fetchImpl: typeof fetch): ServerConfig {
  return {
    baseUrl: "https://api.hubapi.com",
    accessToken: "pat-na1-test-token",
    specDir,
    maxRetries: 0,
    timeoutMs: 5000,
    readOnly: false,
    includeBeta: true,
    toolMode: "all",
    enableGraphql: true,
    graphqlUrl: "https://api.hubapi.com/collector/graphql",
    enableRawRequest: true,
    maxResponseChars: 0,
    fetchImpl,
  } as ServerConfig;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("scopesSatisfy", () => {
  it("passes when any alternative is fully granted", () => {
    const granted = new Set(["crm.objects.contacts.read", "oauth"]);
    expect(scopesSatisfy([["crm.objects.contacts.read"]], granted)).toBe(true);
    expect(scopesSatisfy([["crm.objects.deals.read"], ["oauth"]], granted)).toBe(true);
    expect(scopesSatisfy([["crm.objects.deals.read", "oauth"]], granted)).toBe(false);
    expect(scopesSatisfy([], granted)).toBe(true); // endpoint lists no scopes
  });
});

describe("pickProbeOperation", () => {
  it("picks a parameter-free GET (the collection root)", () => {
    const contactsOps = operations.filter((o) => o.group === "contacts");
    const probe = pickProbeOperation(contactsOps);
    expect(probe).toBeDefined();
    expect(probe!.method).toBe("get");
    expect(probe!.path).toBe("/crm/v3/objects/contacts");
  });

  it("returns undefined when every op needs parameters", () => {
    const opsNeedingParams = operations.filter((o) => o.path.includes("{"));
    expect(pickProbeOperation(opsNeedingParams.slice(0, 5))).toBeUndefined();
  });
});

describe("runCapabilities", () => {
  it("aggregates account, token scopes, usage and per-group unlock state", async () => {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/account-info/v3/details")) {
        return json(200, { portalId: 12345, accountType: "STANDARD", timeZone: "US/Eastern", dataHostingLocation: "na1" });
      }
      if (u.endsWith("/oauth/v2/private-apps/get/access-token-info")) {
        expect(init?.method).toBe("POST");
        return json(200, { hubId: 12345, appId: 99, userId: 7, scopes: ["crm.objects.contacts.read", "oauth"] });
      }
      if (u.endsWith("/account-info/v3/api-usage/daily/private-apps")) {
        return json(200, [{ name: "api-calls-daily", usageLimit: 250000, currentUsage: 42 }]);
      }
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;

    const report = JSON.parse(
      await runCapabilities(cfg(fetchImpl), operations, {}, async () => ({ status: 200, ok: true })),
    );

    expect(report.account.portalId).toBe(12345);
    expect(report.token.scopes).toContain("crm.objects.contacts.read");
    expect(report.dailyApiUsage[0].usageLimit).toBe(250000);

    const contacts = report.toolGroups.find((g: { group: string }) => g.group === "contacts");
    expect(contacts).toBeDefined();
    expect(contacts.plan).toBe("any HubSpot plan (Free and up)");
    // read scope only → the read endpoints unlock, the writes don't.
    const [unlocked, total] = contacts.unlockedByScopes.split("/").map(Number);
    expect(total).toBeGreaterThan(0);
    expect(unlocked).toBeGreaterThan(0);
    expect(unlocked).toBeLessThan(total);

    const hubdb = report.toolGroups.find((g: { group: string }) => g.group === "hubdb");
    expect(hubdb.plan).toContain("Professional");
    expect(hubdb.unlockedByScopes).toBe(`0/${hubdb.tools.read + hubdb.tools.write + hubdb.tools.destructive}`);
    expect(Array.isArray(hubdb.scopesNeeded)).toBe(true);
  });

  it("live-probes requested groups via the provided callback", async () => {
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.endsWith("/account-info/v3/details")) return json(200, { portalId: 1 });
      if (u.endsWith("/oauth/v2/private-apps/get/access-token-info")) return json(200, { scopes: [] });
      if (u.endsWith("/account-info/v3/api-usage/daily/private-apps")) return json(200, []);
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;

    const probed: string[] = [];
    const report = JSON.parse(
      await runCapabilities(cfg(fetchImpl), operations, { probe_groups: ["contacts"] }, async (_c, op) => {
        probed.push(op.path);
        return { status: 200, ok: true };
      }),
    );

    expect(probed).toContain("/crm/v3/objects/contacts");
    const contacts = report.toolGroups.find((g: { group: string }) => g.group === "contacts");
    expect(contacts.probe.ok).toBe(true);
    expect(contacts.probe.endpoint).toBe("GET /crm/v3/objects/contacts");
  });

  it("classifies access per group and probes paid-tier groups on its own", async () => {
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.endsWith("/account-info/v3/details")) return json(200, { portalId: 77 });
      if (u.endsWith("/oauth/v2/private-apps/get/access-token-info")) {
        return json(200, { scopes: ["crm.objects.contacts.read", "hubdb"] });
      }
      if (u.endsWith("/account-info/v3/api-usage/daily/private-apps")) return json(200, []);
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;

    const probed: string[] = [];
    const report = JSON.parse(
      await runCapabilities(cfg(fetchImpl), operations, {}, async (_c, op) => {
        probed.push(op.path);
        return op.path.startsWith("/cms/v3/hubdb") ? { status: 403, ok: false } : { status: 200, ok: true };
      }),
    );
    const group = (key: string) => report.toolGroups.find((g: { group: string }) => g.group === key);

    // Free tier with its scope granted: usable without spending a probe.
    expect(group("contacts").access).toBe("available");
    expect(probed).not.toContain("/crm/v3/objects/contacts");
    // Paid tier with its scope granted: probed, and the 403 means the plan or permission blocks it.
    expect(probed.some((p) => p.startsWith("/cms/v3/hubdb"))).toBe(true);
    expect(group("hubdb").access).toBe("blocked");
    expect(group("deals").access).toBe("missing_scopes");
  });

  it("returns the startup result without calling HubSpot again", async () => {
    const fetchImpl = (async () => {
      throw new Error("no network call expected");
    }) as unknown as typeof fetch;
    const cache = {
      profile: { checkedAt: "startup", account: {}, token: {}, toolGroups: [], notes: [] } as CapabilityProfile,
    };
    const report = JSON.parse(
      await runCapabilities(cfg(fetchImpl), operations, {}, async () => {
        throw new Error("no probe expected");
      }, cache),
    );
    expect(report.checkedAt).toBe("startup");
  });
});

describe("summarizeProfile", () => {
  it("condenses the check for the server instructions", () => {
    const text = summarizeProfile({
      checkedAt: "2026-09-15T00:00:00.000Z",
      account: { portalId: 77 },
      token: {},
      notes: [],
      toolGroups: [
        { group: "contacts", access: "available" },
        { group: "deals", access: "missing_scopes" },
        { group: "hubdb", access: "blocked" },
      ],
    } as unknown as CapabilityProfile);
    expect(text).toContain("portal 77");
    expect(text).toContain("1 of 3 API groups are usable");
    expect(text).toContain("Missing scopes: deals.");
    expect(text).toContain("Blocked by plan tier or permissions: hubdb.");
  });

  it("says so plainly when HubSpot could not be reached", () => {
    const text = summarizeProfile({
      checkedAt: "2026-09-15T00:00:00.000Z",
      account: {},
      token: { error: "Could not introspect token (HTTP 0)." },
      notes: [],
      toolGroups: [{ group: "contacts", access: "unverified" }],
    } as unknown as CapabilityProfile);
    expect(text).toContain("could not read the token's scopes");
    expect(text).not.toContain("Not verified:");
  });
});
