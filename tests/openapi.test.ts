import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllSpecs, type Operation } from "../src/openapi.js";
import { loadCatalog } from "../src/specs.js";

const specDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "spec");
const catalog = loadCatalog(specDir);
const operations = loadAllSpecs(specDir, catalog.apis, resolve);

const find = (method: string, path: string): Operation | undefined =>
  operations.find((o) => o.method === method && o.path === path);

describe("catalog", () => {
  it("bundles the whole public API surface (100+ specs, 1000+ operations)", () => {
    expect(catalog.apis.length).toBeGreaterThanOrEqual(100);
    expect(operations.length).toBeGreaterThanOrEqual(1000);
  });

  it("carries hub/tier requirements from HubSpot's index", () => {
    const hubdb = catalog.apis.find((a) => a.slug === "hubdb");
    expect(hubdb).toBeDefined();
    expect(hubdb!.requirements.cms).toBe("PROFESSIONAL");
    const contacts = catalog.apis.find((a) => a.slug === "contacts");
    expect(contacts!.requirements.marketing).toBe("FREE");
  });

  it("marks developer-preview APIs as beta", () => {
    const forms = catalog.apis.find((a) => a.slug === "forms");
    expect(forms?.beta).toBe(true);
  });

  it("keeps pinned multi-version APIs under one group key", () => {
    const oauthEntries = catalog.apis.filter((a) => a.group === "oauth");
    expect(oauthEntries.map((a) => a.slug).sort()).toEqual(["oauth-v1", "oauth-v3"]);
  });
});

describe("loadAllSpecs", () => {
  it("gives every operation an operationId, method and path", () => {
    for (const op of operations) {
      expect(op.operationId.length).toBeGreaterThan(0);
      expect(op.method).toMatch(/^(get|post|put|delete|patch)$/);
      expect(op.path.startsWith("/")).toBe(true);
    }
  });

  it("extracts OAuth scope alternatives from the spec security", () => {
    const listContacts = find("get", "/crm/v3/objects/contacts");
    expect(listContacts).toBeDefined();
    const flat = listContacts!.scopeAlternatives.flat();
    expect(flat).toContain("crm.objects.contacts.read");
  });

  it("mounts every HubSpot API at the host root (empty serverPath)", () => {
    for (const op of operations) expect(op.serverPath).toBe("");
  });

  it("dereferences $ref-based request bodies", () => {
    const create = find("post", "/crm/v3/objects/contacts");
    expect(create?.requestBodySchema).toBeDefined();
    expect(JSON.stringify(create?.requestBodySchema)).not.toContain('"$ref"');
  });

  it("keeps multipart and form-urlencoded content types", () => {
    expect(find("post", "/files/v3/files")?.requestBodyContentType).toBe("multipart/form-data");
    expect(find("post", "/oauth/v1/token")?.requestBodyContentType).toBe("application/x-www-form-urlencoded");
    expect(find("post", "/crm/v3/objects/contacts")?.requestBodyContentType).toBe("application/json");
  });

  it("never leaks auth/content headers as tool parameters", () => {
    for (const op of operations) {
      for (const p of op.parameters) {
        if (p.in === "header") {
          expect(["authorization", "content-type", "accept"]).not.toContain(p.name.toLowerCase());
        }
      }
    }
  });

  it("attaches the catalog entry (group, area, beta) to each operation", () => {
    const op = find("get", "/cms/v3/hubdb/tables");
    expect(op?.group).toBe("hubdb");
    expect(op?.entry.area).toBe("CMS");
  });

  it("keeps every body schema within the context budget", () => {
    for (const op of operations) {
      if (!op.requestBodySchema) continue;
      const size = JSON.stringify(op.requestBodySchema).length;
      expect(size, `${op.method} ${op.path} body schema too large (${size})`).toBeLessThanOrEqual(25_000);
    }
  });

  it("prunes the giant recursive schemas while keeping their top level intact", () => {
    const createList = find("post", "/crm/v3/lists");
    expect(createList?.requestBodySchema).toBeDefined();
    const props = (createList!.requestBodySchema as { properties?: Record<string, unknown> }).properties;
    expect(props).toBeDefined();
    expect(Object.keys(props!)).toEqual(expect.arrayContaining(["name", "objectTypeId", "processingType"]));
  });
});
