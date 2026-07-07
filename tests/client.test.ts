import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllSpecs, type Operation } from "../src/openapi.js";
import { loadCatalog } from "../src/specs.js";
import { callOperation, buildUrl, buildHint, encodeBody, __test } from "../src/client.js";
import type { ServerConfig } from "../src/config.js";

const specDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "spec");
const catalog = loadCatalog(specDir);
const operations = loadAllSpecs(specDir, catalog.apis, resolve);

const find = (method: string, path: string): Operation => {
  const op = operations.find((o) => o.method === method && o.path === path);
  if (!op) throw new Error(`missing op ${method} ${path}`);
  return op;
};

function cfg(fetchImpl?: typeof fetch): ServerConfig {
  return {
    baseUrl: "https://api.hubapi.com",
    accessToken: "pat-na1-test-token",
    specDir,
    maxRetries: 2,
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

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("buildUrl", () => {
  it("joins the base URL and path", () => {
    const op = find("get", "/crm/v3/objects/contacts");
    expect(buildUrl(cfg(), op, "/crm/v3/objects/contacts", "?limit=5")).toBe(
      "https://api.hubapi.com/crm/v3/objects/contacts?limit=5",
    );
  });
});

describe("query building", () => {
  it("repeats array params (HubSpot style: properties=a&properties=b)", () => {
    const op = find("get", "/crm/v3/objects/contacts");
    const q = __test.buildQueryString(op, { properties: ["email", "firstname"], limit: 10 }, new Set());
    expect(q).toContain("properties=email");
    expect(q).toContain("properties=firstname");
    expect(q).toContain("limit=10");
  });
});

describe("path expansion", () => {
  it("URL-encodes path parameters", () => {
    const consumed = new Set<string>();
    const out = __test.expandPath("/crm/v3/objects/contacts/{contactId}", { contactId: "a/b" }, consumed);
    expect(out).toBe("/crm/v3/objects/contacts/a%2Fb");
    expect(consumed.has("contactId")).toBe(true);
  });

  it("throws a clear error when a required path parameter is missing", async () => {
    const fetchImpl = (async () => jsonResponse(200, {})) as unknown as typeof fetch;
    const op = find("get", "/crm/v3/objects/contacts/{contactId}");
    await expect(callOperation(cfg(fetchImpl), op, {})).rejects.toThrow(/path parameter/i);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(__test.parseRetryAfter("2")).toBe(2000);
  });
  it("returns undefined for a missing header", () => {
    expect(__test.parseRetryAfter(null)).toBeUndefined();
  });
});

describe("isSearchPath", () => {
  it("detects CRM search endpoints for the extra limiter", () => {
    expect(__test.isSearchPath("/crm/v3/objects/contacts/search")).toBe(true);
    expect(__test.isSearchPath("/crm/v3/objects/contacts")).toBe(false);
  });
});

describe("encodeBody", () => {
  it("encodes multipart bodies with file parts from base64", async () => {
    const { payload, contentTypeHeader } = encodeBody("multipart/form-data", {
      file: { fileName: "note.txt", contentBase64: Buffer.from("hello").toString("base64") },
      options: { access: "PRIVATE" },
      folderPath: "/docs",
    });
    expect(contentTypeHeader).toBeUndefined(); // FormData sets its own boundary
    const form = payload as FormData;
    expect(form.get("folderPath")).toBe("/docs");
    expect(form.get("options")).toBe('{"access":"PRIVATE"}');
    const file = form.get("file") as File;
    expect(await file.text()).toBe("hello");
    expect(file.name).toBe("note.txt");
  });

  it("encodes form-urlencoded bodies", () => {
    const { payload, contentTypeHeader } = encodeBody("application/x-www-form-urlencoded", {
      grant_type: "refresh_token",
      refresh_token: "abc",
    });
    expect(contentTypeHeader).toBe("application/x-www-form-urlencoded");
    expect(String(payload)).toBe("grant_type=refresh_token&refresh_token=abc");
  });

  it("encodes JSON bodies", () => {
    const { payload, contentTypeHeader } = encodeBody("application/json", { properties: { email: "a@b.c" } });
    expect(contentTypeHeader).toBe("application/json");
    expect(String(payload)).toBe('{"properties":{"email":"a@b.c"}}');
  });
});

describe("callOperation", () => {
  it("injects the Bearer token, builds the URL, and parses JSON", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenHeaders = init.headers as Record<string, string>;
      return jsonResponse(200, { results: [] });
    }) as unknown as typeof fetch;

    const res = await callOperation(cfg(fetchImpl), find("get", "/crm/v3/objects/contacts"), { limit: 5 });
    expect(seenUrl).toBe("https://api.hubapi.com/crm/v3/objects/contacts?limit=5");
    expect(seenHeaders["Authorization"]).toBe("Bearer pat-na1-test-token");
    expect(res.ok).toBe(true);
    expect(res.body).toEqual({ results: [] });
  });

  it("retries on 429 (honoring Retry-After) then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return jsonResponse(429, { message: "rate" }, { "retry-after": "0" });
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;

    const res = await callOperation(cfg(fetchImpl), find("get", "/crm/v3/objects/contacts"), {});
    expect(calls).toBe(2);
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(1);
  });

  it("attaches a scope hint on 403 MISSING_SCOPES", async () => {
    const fetchImpl = (async () =>
      jsonResponse(403, { status: "error", category: "MISSING_SCOPES", message: "nope" })) as unknown as typeof fetch;
    const res = await callOperation(cfg(fetchImpl), find("get", "/crm/v3/objects/contacts"), {});
    expect(res.ok).toBe(false);
    expect(res.hint).toContain("crm.objects.contacts.read");
    expect(res.hint).toContain("Private Apps");
  });

  it("attaches a token hint on 401", async () => {
    const fetchImpl = (async () => jsonResponse(401, { message: "expired" })) as unknown as typeof fetch;
    const res = await callOperation(cfg(fetchImpl), find("get", "/crm/v3/objects/contacts"), {});
    expect(res.hint).toContain("HUBSPOT_ACCESS_TOKEN");
  });
});

describe("buildHint", () => {
  it("mentions the plan tier on plain 403s for gated APIs", () => {
    const hubdb = find("get", "/cms/v3/hubdb/tables");
    const hint = buildHint(hubdb, 403, { category: "FORBIDDEN" });
    expect(hint).toContain("Professional");
  });

  it("suggests capability check on 429", () => {
    const hint = buildHint(null, 429, {});
    expect(hint).toContain("hubspot_get_capabilities");
  });
});
