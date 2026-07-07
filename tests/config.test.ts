import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const ENV_KEYS = [
  "HUBSPOT_ACCESS_TOKEN",
  "HUBSPOT_BASE_URL",
  "HUBSPOT_MAX_REQUESTS",
  "HUBSPOT_RATE_WINDOW_MS",
  "HUBSPOT_SEARCH_MAX_REQUESTS",
  "HUBSPOT_MAX_RETRIES",
  "HUBSPOT_TIMEOUT_MS",
  "HUBSPOT_READ_ONLY",
  "HUBSPOT_INCLUDE_BETA",
  "HUBSPOT_TOOL_MODE",
  "HUBSPOT_INCLUDE_GROUPS",
  "HUBSPOT_EXCLUDE_GROUPS",
  "HUBSPOT_ENABLE_GRAPHQL",
  "HUBSPOT_GRAPHQL_URL",
  "HUBSPOT_ENABLE_RAW_REQUEST",
  "HUBSPOT_MAX_RESPONSE_CHARS",
  "HUBSPOT_SPEC_DIR",
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HUBSPOT_ACCESS_TOKEN = "pat-na1-test";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadConfig", () => {
  it("fails fast without an access token", () => {
    delete process.env.HUBSPOT_ACCESS_TOKEN;
    expect(() => loadConfig()).toThrow(/HUBSPOT_ACCESS_TOKEN/);
  });

  it("applies HubSpot-tuned defaults", () => {
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe("https://api.hubapi.com");
    expect(cfg.maxRetries).toBe(3);
    expect(cfg.timeoutMs).toBe(30000);
    expect(cfg.rateLimiter).toBeDefined();
    expect(cfg.searchRateLimiter).toBeDefined();
    expect(cfg.readOnly).toBe(false);
    expect(cfg.includeBeta).toBe(true);
    expect(cfg.toolMode).toBe("all");
    expect(cfg.enableGraphql).toBe(true);
    expect(cfg.enableRawRequest).toBe(true);
    expect(cfg.graphqlUrl).toBe("https://api.hubapi.com/collector/graphql");
  });

  it("supports the EU base URL", () => {
    process.env.HUBSPOT_BASE_URL = "api-eu1.hubapi.com";
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe("https://api-eu1.hubapi.com");
    expect(cfg.graphqlUrl).toBe("https://api-eu1.hubapi.com/collector/graphql");
  });

  it("parses group filters into lowercase sets", () => {
    process.env.HUBSPOT_INCLUDE_GROUPS = "Contacts, deals CRM:*";
    const cfg = loadConfig();
    expect(cfg.includeGroups).toEqual(new Set(["contacts", "deals", "crm:*"]));
  });

  it("rejects an unknown tool mode", () => {
    process.env.HUBSPOT_TOOL_MODE = "banana";
    expect(() => loadConfig()).toThrow(/HUBSPOT_TOOL_MODE/);
  });

  it("disables limiters when set to 0", () => {
    process.env.HUBSPOT_MAX_REQUESTS = "0";
    process.env.HUBSPOT_SEARCH_MAX_REQUESTS = "0";
    const cfg = loadConfig();
    expect(cfg.rateLimiter).toBeUndefined();
    expect(cfg.searchRateLimiter).toBeUndefined();
  });
});
