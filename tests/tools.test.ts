import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllSpecs } from "../src/openapi.js";
import { loadCatalog } from "../src/specs.js";
import { operationsToTools } from "../src/tools.js";

const specDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "spec");
const catalog = loadCatalog(specDir);
const operations = loadAllSpecs(specDir, catalog.apis, resolve);
const tools = operationsToTools(operations);
const byName = new Map(tools.map((t) => [t.name, t]));

describe("operationsToTools", () => {
  it("produces exactly one tool per operation (no filter)", () => {
    expect(tools.length).toBe(operations.length);
  });

  it("gives every tool a unique, MCP-legal name", () => {
    const names = new Set<string>();
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z0-9_]+$/);
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
    }
  });

  it("derives friendly, predictable names for the flagship endpoints", () => {
    for (const expected of [
      "contacts_list",
      "contacts_get",
      "contacts_create",
      "contacts_update",
      "contacts_archive",
      "contacts_search",
      "contacts_merge",
      "contacts_gdpr_delete",
      "contacts_batch_upsert",
      "deals_list",
      "deals_search",
      "companies_create",
      "tickets_search",
      "files_upload",
      "hubdb_tables_get_all",
      "lists_memberships_add",
      "marketing_emails_publish",
      "oauth_v1_access_tokens_get",
      "pipelines_list",
      "properties_create",
    ]) {
      expect(byName.has(expected), `expected tool ${expected}`).toBe(true);
    }
  });

  it("prefixes every description with a 🟢 / 🟡 / 🔴 banner", () => {
    for (const t of tools) {
      expect(t.description).toMatch(/^(🟢|🟡|🔴)/);
    }
  });

  it("includes the hub/plan line when HubSpot lists a paid tier", () => {
    const hubdb = byName.get("hubdb_tables_get_all")!;
    expect(hubdb.description).toContain("Plan: Professional tier of Marketing Hub / Content Hub");
    const schemas = byName.get("schemas_list")!;
    expect(schemas.description).toContain("Enterprise");
  });

  it("includes required scopes in descriptions", () => {
    const t = byName.get("contacts_list")!;
    expect(t.description).toMatch(/Scopes: .*crm\.objects\.contacts\.read/);
  });

  it("marks beta APIs in the description", () => {
    const beta = tools.find((t) => t.operation?.entry.beta);
    expect(beta).toBeDefined();
    expect(beta!.description).toContain("Beta/preview API");
  });

  it("builds a closed object input schema for every tool", () => {
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("explains the file-part convention on multipart tools", () => {
    const upload = byName.get("files_upload")!;
    const body = (upload.inputSchema.properties as Record<string, { description?: string }>).body;
    expect(body.description).toContain("contentBase64");
  });

  it("sets readOnlyHint on GETs and destructiveHint on true deletes", () => {
    for (const t of tools) {
      if (!t.operation) continue;
      if (t.operation.method === "get") {
        expect(t.annotations.readOnlyHint).toBe(true);
        expect(t.annotations.destructiveHint).toBe(false);
      }
      if (t.operation.method === "delete" && t.category === "delete") {
        expect(t.annotations.destructiveHint).toBe(true);
      }
    }
  });

  describe("read-only filter", () => {
    const readTools = operationsToTools(operations, { readOnly: true });
    it("keeps only read-only tools", () => {
      expect(readTools.length).toBeGreaterThan(0);
      expect(readTools.length).toBeLessThan(tools.length);
      for (const t of readTools) {
        expect(t.annotations.readOnlyHint).toBe(true);
        expect(t.annotations.destructiveHint).toBe(false);
      }
    });

    it("keeps POST searches available in read-only mode", () => {
      expect(readTools.some((t) => t.name === "contacts_search")).toBe(true);
    });
  });

  describe("group filters", () => {
    it("include-list keeps only the named groups", () => {
      const only = operationsToTools(operations, { includeGroups: new Set(["contacts", "deals"]) });
      expect(only.length).toBeGreaterThan(0);
      for (const t of only) expect(["contacts", "deals"]).toContain(t.group);
    });

    it("supports area wildcards like cms:*", () => {
      const cmsOnly = operationsToTools(operations, { includeGroups: new Set(["cms:*"]) });
      expect(cmsOnly.length).toBeGreaterThan(0);
      for (const t of cmsOnly) expect(t.operation!.entry.area).toBe("CMS");
    });

    it("exclude-list drops the named groups", () => {
      const without = operationsToTools(operations, { excludeGroups: new Set(["hubdb"]) });
      expect(without.some((t) => t.group === "hubdb")).toBe(false);
      expect(without.length).toBeLessThan(tools.length);
    });

    it("pinned multi-version specs share one group key", () => {
      const oauthOnly = operationsToTools(operations, { includeGroups: new Set(["oauth"]) });
      const paths = oauthOnly.map((t) => t.operation!.path);
      expect(paths.some((p) => p.startsWith("/oauth/v1/"))).toBe(true);
      expect(paths.some((p) => p.startsWith("/oauth/v3/"))).toBe(true);
    });
  });

  describe("beta filter", () => {
    it("drops developer-preview APIs when includeBeta is false", () => {
      const stable = operationsToTools(operations, { includeBeta: false });
      expect(stable.length).toBeLessThan(tools.length);
      expect(stable.every((t) => !t.operation!.entry.beta)).toBe(true);
      // Forms is beta-only in HubSpot's index but must exist by default.
      expect(tools.some((t) => t.group === "forms")).toBe(true);
      expect(stable.some((t) => t.group === "forms")).toBe(false);
    });
  });
});
