import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllSpecs, type Operation } from "../src/openapi.js";
import { loadCatalog } from "../src/specs.js";
import { operationsToTools, resolveCall, toolOperations } from "../src/tools.js";
import { actionSuffix } from "../src/consolidate.js";
import { callOperation } from "../src/client.js";
import type { ServerConfig } from "../src/config.js";

const specDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "spec");
const catalog = loadCatalog(specDir);
const operations = loadAllSpecs(specDir, catalog.apis, resolve);
const tools = operationsToTools(operations);
const byName = new Map(tools.map((t) => [t.name, t]));

type Props = Record<string, { description?: string; enum?: string[] }>;
const propsOf = (name: string) => byName.get(name)!.inputSchema.properties as Props;

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

/** The method, URL and body callOperation sends for these arguments. */
async function requestFor(op: Operation, args: Record<string, unknown>): Promise<string> {
  let sent = "";
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    sent = `${init?.method} ${String(url)} ${typeof init?.body === "string" ? init.body : ""}`;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  await callOperation(cfg(fetchImpl), op, args);
  return sent;
}

describe("tool consolidation", () => {
  it("keeps every operation reachable through exactly one tool", () => {
    const reached = tools.flatMap(toolOperations);
    expect(reached.length).toBe(operations.length);
    expect(new Set(reached).size).toBe(operations.length);
  });

  it("cuts the tool list well below one tool per endpoint", () => {
    expect(tools.length).toBeLessThan(750);
  });

  it("replaces the per-object CRM tools with crm_objects_* tools", () => {
    for (const name of [
      "crm_objects_list",
      "crm_objects_get",
      "crm_objects_create",
      "crm_objects_update",
      "crm_objects_archive",
      "crm_objects_search",
      "crm_objects_batch_read",
      "crm_objects_batch_create",
      "crm_objects_batch_update",
      "crm_objects_batch_upsert",
      "crm_objects_batch_archive",
      "crm_objects_merge",
    ]) {
      expect(byName.has(name), name).toBe(true);
    }
    expect(byName.has("contacts_list")).toBe(false);
    expect(byName.has("deals_search")).toBe(false);
    expect(byName.has("custom_objects_list")).toBe(false);
    // An endpoint only one object type has stays its own tool.
    expect(byName.has("contacts_gdpr_delete")).toBe(true);
  });

  it("sends exactly the request the per-endpoint tool sent, for every variant", async () => {
    let checked = 0;
    for (const tool of tools.filter((t) => t.consolidated)) {
      const ep = tool.consolidated!;
      for (const v of ep.variants) {
        const value = v.wildcard ? "2-12345" : v.value;
        const nativeArgs: Record<string, unknown> = { limit: 5, body: { inputs: [{ id: "1" }] } };
        const genericArgs: Record<string, unknown> = { [ep.family.param]: value, limit: 5, body: { inputs: [{ id: "1" }] } };
        v.pathArgKeys.forEach((key, i) => {
          nativeArgs[key] = `p${i}`;
          genericArgs[ep.pathArgs[i]] = `p${i}`;
        });
        if (v.wildcard) nativeArgs[v.dispatchArgKey!] = value;

        const call = resolveCall(tool, genericArgs);
        expect(call.operation, `${tool.name} ${value}`).toBe(v.operation);
        expect(await requestFor(call.operation, call.args), `${tool.name} ${value}`).toBe(await requestFor(v.operation, nativeArgs));
        checked++;
      }
    }
    expect(checked).toBe(operations.length - tools.filter((t) => !t.consolidated).length);
  });

  it("accepts objectTypeIds and API group names as aliases", () => {
    const get = byName.get("crm_objects_get")!;
    expect(resolveCall(get, { objectType: "deals", objectId: "1" }).operation.path).toBe("/crm/v3/objects/0-3/{dealId}");
    expect(resolveCall(get, { objectType: "0-3", objectId: "1" }).args).toEqual({ dealId: "1" });
    expect(resolveCall(get, { objectType: "line-items", objectId: "1" }).operation.group).toBe("line-items");

    const custom = resolveCall(get, { objectType: "2-999", objectId: "7" });
    expect(custom.operation.path).toBe("/crm/v3/objects/{objectType}/{objectId}");
    expect(custom.args).toEqual({ objectType: "2-999", objectId: "7" });
  });

  it("rejects values outside the filtered scope when no generic endpoint is left", () => {
    const narrow = operationsToTools(operations, { includeGroups: new Set(["contacts", "deals"]) });
    const list = narrow.find((t) => t.name === "crm_objects_list")!;
    const selector = (list.inputSchema.properties as Props).objectType;
    expect([...selector.enum!].sort()).toEqual(["contacts", "deals"]);
    expect(() => resolveCall(list, { objectType: "tickets" })).toThrow(/contacts, deals|deals, contacts/);
    expect(() => resolveCall(list, {})).toThrow(/objectType/);
  });

  it("keeps tool names stable under filters", () => {
    const readOnly = operationsToTools(operations, { readOnly: true });
    expect(readOnly.some((t) => t.name === "crm_objects_search")).toBe(true);
    expect(readOnly.some((t) => t.name === "crm_objects_create")).toBe(false);
  });

  it("states per-type plan requirements on the selector", () => {
    expect(propsOf("crm_objects_list").objectType.description).toContain("leads");
    expect(byName.get("crm_objects_list")!.description).toContain("Plan: depends on objectType");
  });

  it("uses closed selectors for pages and blogs", () => {
    expect(propsOf("cms_pages_list").pageType.enum).toEqual(["landing", "site"]);
    expect([...propsOf("cms_blog_get").blogResource.enum!].sort()).toEqual(["authors", "posts", "tags"]);
    // Blog create bodies differ per resource, so those stay separate tools.
    expect(byName.has("cms_blog_create")).toBe(false);
  });

  it("derives name suffixes from the generic sub-path", () => {
    expect(actionSuffix("get", "")).toBe("list");
    expect(actionSuffix("post", "")).toBe("create");
    expect(actionSuffix("get", "/{objectId}")).toBe("get");
    expect(actionSuffix("get", "/{objectId}/revisions")).toBe("revisions_list");
    expect(actionSuffix("get", "/{objectId}/revisions/{revisionId}")).toBe("revisions_get");
    expect(actionSuffix("patch", "/{objectId}/draft")).toBe("draft_update");
    expect(actionSuffix("put", "/{objectId}/associations/{toObjectType}/{toObjectId}/{associationType}")).toBe("associations_create");
    expect(actionSuffix("post", "/batch/read")).toBe("batch_read");
  });
});

describe("tool descriptions", () => {
  it("point to the better-fitting sibling tool", () => {
    expect(byName.get("crm_objects_list")!.description).toContain("crm_objects_search");
    expect(byName.get("crm_objects_get")!.description).toContain("crm_objects_batch_read");
    expect(byName.get("crm_objects_create")!.description).toContain("crm_objects_batch_create");
  });

  it("end with the endpoint they call", () => {
    for (const t of tools) expect(t.description, t.name).toMatch(/\n\nEndpoint: (GET|POST|PUT|PATCH|DELETE) \//);
  });

  it("document every path parameter and selector", () => {
    for (const t of tools) {
      const props = t.inputSchema.properties as Props;
      const keys = t.consolidated
        ? [t.consolidated.family.param, ...t.consolidated.pathArgs]
        : t.operation!.parameters.filter((p) => p.in === "path").map((p) => p.argName ?? p.name);
      for (const key of keys) expect(props[key]?.description, `${t.name}.${key}`).toBeTruthy();
    }
  });

  it("drop markdown link syntax from HubSpot's prose", () => {
    for (const t of tools) expect(t.description, t.name).not.toMatch(/\]\(https?:/);
  });
});
