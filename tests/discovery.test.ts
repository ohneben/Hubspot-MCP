import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllSpecs } from "../src/openapi.js";
import { loadCatalog } from "../src/specs.js";
import { operationsToTools } from "../src/tools.js";
import { discoveryTools, handleGetEndpoint, handleSearchEndpoints } from "../src/discovery.js";
import type { ServerConfig } from "../src/config.js";

const specDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "spec");
const catalog = loadCatalog(specDir);
const operations = loadAllSpecs(specDir, catalog.apis, resolve);
const registry = operationsToTools(operations);
const registryMap = new Map(registry.map((t) => [t.name, t]));

const cfgLike = (readOnly: boolean) => ({ readOnly }) as ServerConfig;

describe("discoveryTools", () => {
  it("exposes exactly three meta-tools", () => {
    const tools = discoveryTools(cfgLike(false), registry.length);
    expect(tools.map((t) => t.name)).toEqual([
      "hubspot_search_endpoints",
      "hubspot_get_endpoint",
      "hubspot_invoke_endpoint",
    ]);
  });

  it("marks invoke as read-only when the server is read-only", () => {
    const rw = discoveryTools(cfgLike(false), 10).find((t) => t.name === "hubspot_invoke_endpoint")!;
    expect(rw.annotations.destructiveHint).toBe(true);
    const ro = discoveryTools(cfgLike(true), 10).find((t) => t.name === "hubspot_invoke_endpoint")!;
    expect(ro.annotations.readOnlyHint).toBe(true);
    expect(ro.annotations.destructiveHint).toBe(false);
  });
});

describe("handleSearchEndpoints", () => {
  it("finds endpoints by keywords", () => {
    const out = handleSearchEndpoints(registry, { query: "contacts search" });
    expect(out).toContain("contacts_search");
    expect(out).toContain("POST /crm/v3/objects/contacts/search");
  });

  it("filters by group and category", () => {
    const out = handleSearchEndpoints(registry, { group: "contacts", category: "purge" });
    expect(out).toContain("contacts_gdpr_delete");
    expect(out).not.toContain("contacts_list —");
  });

  it("paginates and reports totals", () => {
    const page1 = handleSearchEndpoints(registry, { limit: 5, offset: 0 });
    expect(page1).toMatch(/^\d+ endpoint\(s\) matched; showing 1–5\./);
    expect(page1).toContain("offset=5");
  });
});

describe("handleGetEndpoint", () => {
  it("returns the full description and schema", () => {
    const out = handleGetEndpoint(registryMap, { name: "contacts_search" });
    expect(out).toContain("# contacts_search");
    expect(out).toContain("🟢 READ-ONLY · query");
    expect(out).toContain('"type": "object"');
  });

  it("throws a helpful error for unknown names", () => {
    expect(() => handleGetEndpoint(registryMap, { name: "nope_nope" })).toThrow(/hubspot_search_endpoints/);
  });
});
