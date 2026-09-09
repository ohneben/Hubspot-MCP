/**
 * HTTP-level integration tests: these start the real compiled server as a child
 * process and talk to it over a socket.
 *
 * Every unit test in this repo exercises a pure function. That is why an
 * independent review found a pre-auth memory exhaustion, an escape hatch that
 * disabled two layers at once, and a bind failure reported as a successful
 * start - none of which a pure function can show. The cases below are the
 * regression guard for exactly those.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Each case spawns a real server process; one of them parses a large OpenAPI
// spec at boot. vitest's 5 s default is not enough for that.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "dist", "index.js");
/** Matches the ready line however it is worded. */
const READY = /ready on http/;

const CREDS = {
  // Deliberately not shaped like a real pat-... token: secret scanning treats
  // that shape as a leak even when the value is obviously a placeholder.
  HUBSPOT_ACCESS_TOKEN: "test-token-no-network-calls-are-made",
  HUBSPOT_BASE_URL: "https://example.test",
};
const TOKEN = "s3cret-token-long-enough";

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
});

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}


/**
 * fetch() refuses to set a Host header (it is forbidden in undici), so every
 * Host-validation case has to go through node:http.
 */
function rawRequest(
  port: number,
  path: string,
  opts: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: opts.method ?? "GET",
        headers: { ...(opts.host ? { Host: opts.host } : {}), ...(opts.headers ?? {}) },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += String(c)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}


/**
 * This server streams its replies as SSE rather than answering with plain
 * JSON. Both are valid Streamable HTTP, so the helper accepts either rather
 * than pinning the wire format of a running deployment.
 */
async function readRpc(res: Response): Promise<any> {
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(line ? line.slice(5).trim() : text);
}

interface Started {
  port: number;
  stderr: string;
  proc: ChildProcess;
}

/** Starts the server and resolves once it is listening, or rejects on exit. */
async function start(env: Record<string, string>): Promise<Started> {
  const port = env.PORT ? Number(env.PORT) : await freePort();
  const proc = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, MCP_TRANSPORT: "http", ...CREDS, ...env, PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  proc.stderr!.on("data", (c) => (stderr += String(c)));

  const ready = new Promise<void>((resolve, reject) => {
    proc.stderr!.on("data", () => {
      if (READY.test(stderr)) resolve();
    });
    proc.once("exit", (code) =>
      reject(new Error(`exited early, code ${code}\n${stderr}`))
    );
    setTimeout(() => reject(new Error(`timeout\n${stderr}`)), 15_000);
  });
  await ready;
  return { port, get stderr() { return stderr; }, proc } as Started;
}

/** Runs the server to completion and reports how it ended. */
async function run(
  env: Record<string, string>
): Promise<{ code: number | null; stderr: string }> {
  const proc = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, MCP_TRANSPORT: "http", ...CREDS, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  proc.stderr!.on("data", (c) => (stderr += String(c)));
  const [code] = (await once(proc, "exit")) as [number | null];
  return { code, stderr };
}

function stop(s: Started | undefined): void {
  if (s && !s.proc.killed) s.proc.kill("SIGKILL");
}

describe("startup", () => {
  it("refuses a non-loopback bind without a token, with exit code 1", async () => {
    const r = await run({ HOST: "0.0.0.0", PORT: String(await freePort()) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Refusing to start");
    expect(r.stderr).toContain("MCP_AUTH_TOKEN");
  });

  it("reports a bind failure as a failure instead of printing ready", async () => {
    // A failed bind used to be silent: nothing listened, nothing was logged,
    // and the process stayed up as if it had started. A platform that reads
    // exit codes then treats a dead deploy as a running one.
    const r = await run({
      HOST: "bogus.invalid",
      PORT: String(await freePort()),
      MCP_AUTH_TOKEN: TOKEN,
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("could not listen");
    expect(READY.test(r.stderr)).toBe(false);
  });

  it("binds the bracketed IPv6 loopback spelling used in the docs", async () => {
    // HOST=[::1] counted as loopback (waiving the token) but node cannot bind
    // it, which produced the silent exit above.
    let s: Started | undefined;
    try {
      s = await start({ HOST: "[::1]" });
      expect(READY.test(s.stderr)).toBe(true);
    } finally {
      stop(s);
    }
  });

  it("warns instead of silently falling back on an unusable PORT", async () => {
    const proc = spawn(process.execPath, [ENTRY], {
      env: { ...process.env, MCP_TRANSPORT: "http", ...CREDS, HOST: "127.0.0.1", PORT: "abc" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr!.on("data", (c) => (stderr += String(c)));
    await new Promise((r) => setTimeout(r, 3000));
    proc.kill("SIGKILL");
    expect(stderr).toContain("not a usable port number");
  });
});

describe("unauthenticated requests never reach a body parser", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start({ HOST: "127.0.0.1", MCP_AUTH_TOKEN: TOKEN });
  });
  afterAll(() => stop(s));

  it("answers an oversized body on an unknown path with 404 JSON, unread", async () => {
    // Regression: the body was read with no size limit at all, so a single
    // large request was buffered into memory in full before anything else
    // happened.
    const big = JSON.stringify({ a: "A".repeat(8_000_000) });
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${s.port}/notmcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: big,
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toMatchObject({ jsonrpc: "2.0" });
    // The body is refused, not buffered: this must not take parsing time.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("answers an oversized body on the MCP path with 401, not 413", async () => {
    const big = JSON.stringify({ a: "A".repeat(8_000_000) });
    const res = await fetch(`http://127.0.0.1:${s.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: big,
    });
    expect(res.status).toBe(401);
  });

  it("never answers with HTML", async () => {
    for (const path of ["/notmcp", "/", "/mcp"]) {
      const res = await fetch(`http://127.0.0.1:${s.port}${path}`, { method: "PUT" });
      expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
    }
  });
});

describe("Host validation", () => {
  it("still applies when MCP_ALLOW_INSECURE waives the token", async () => {
    // Regression: the escape hatch dropped the token requirement, and
    // hostAllowlist() returned undefined for a non-loopback bind, so both
    // layers went at once and any web page could drive the destructive tools.
    let s: Started | undefined;
    try {
      s = await start({ HOST: "0.0.0.0", MCP_ALLOW_INSECURE: "1" });
      const hdrs = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      const evil = await rawRequest(s.port, "/mcp", {
        method: "POST",
        host: "evil.attacker.example",
        headers: hdrs,
        body: INITIALIZE,
      });
      expect(evil.status).toBe(403);

      const ok = await rawRequest(s.port, "/mcp", {
        method: "POST",
        headers: hdrs,
        body: INITIALIZE,
      });
      expect(ok.status).toBe(200);
    } finally {
      stop(s);
    }
  });

  it("matches an allowlist entry written with capitals or a port", async () => {
    // Regression: entries were compared verbatim against a lowercased,
    // portless hostname, so such an entry could never match while the startup
    // banner reported it as configured.
    let s: Started | undefined;
    try {
      s = await start({
        HOST: "127.0.0.1",
        MCP_AUTH_TOKEN: TOKEN,
        MCP_ALLOWED_HOSTS: "MCP.Example.COM, other.internal:8080",
      });
      for (const host of ["mcp.example.com", "MCP.Example.COM", "other.internal:8080"]) {
        const res = await rawRequest(s.port, "/health", { host });
        expect(res.status, `Host: ${host}`).toBe(200);
      }
      const evil = await rawRequest(s.port, "/health", { host: "evil.attacker.example" });
      expect(evil.status).toBe(403);
    } finally {
      stop(s);
    }
  });

  it("keeps /health reachable on loopback when an allowlist is pinned", async () => {
    // The Dockerfile HEALTHCHECK probes 127.0.0.1, so pinning the allowlist to
    // a public hostname used to make the container mark itself unhealthy.
    let s: Started | undefined;
    try {
      s = await start({
        HOST: "127.0.0.1",
        MCP_AUTH_TOKEN: TOKEN,
        MCP_ALLOWED_HOSTS: "mcp.example.com",
      });
      const health = await fetch(`http://127.0.0.1:${s.port}/health`);
      expect(health.status).toBe(200);

      const mcp = await fetch(`http://127.0.0.1:${s.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: INITIALIZE,
      });
      // /mcp stays strict: loopback is not on the configured allowlist.
      expect(mcp.status).toBe(403);
    } finally {
      stop(s);
    }
  });
});

describe("sessions", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start({
      HOST: "127.0.0.1",
      MCP_AUTH_TOKEN: TOKEN,
      MCP_MAX_SESSIONS: "5",
    });
  });
  afterAll(() => stop(s));

  const auth = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${TOKEN}`,
  };

  it("answers an unknown session id with 404 so clients re-initialize", async () => {
    const res = await fetch(`http://127.0.0.1:${s.port}/mcp`, {
      method: "POST",
      headers: { ...auth, "mcp-session-id": "00000000-0000-0000-0000-000000000000" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(404);
  });

  it("serves a full initialize, tools/list and delete cycle", async () => {
    const init = await fetch(`http://127.0.0.1:${s.port}/mcp`, {
      method: "POST",
      headers: auth,
      body: INITIALIZE,
    });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id");
    expect(sid).toBeTruthy();

    const list = await fetch(`http://127.0.0.1:${s.port}/mcp`, {
      method: "POST",
      headers: { ...auth, "mcp-session-id": sid! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(list.status).toBe(200);
    const body = await readRpc(list);
    expect(body.result.tools.length).toBeGreaterThan(100);
    const del = await fetch(`http://127.0.0.1:${s.port}/mcp`, {
      method: "DELETE",
      headers: { ...auth, "mcp-session-id": sid! },
    });
    expect(del.status).toBe(200);

    const after = await fetch(`http://127.0.0.1:${s.port}/mcp`, {
      method: "POST",
      headers: { ...auth, "mcp-session-id": sid! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    expect(after.status).toBe(404);
  });

  it("holds the session cap under a flood of initialize calls", async () => {
    await Promise.all(
      Array.from({ length: 40 }, () =>
        fetch(`http://127.0.0.1:${s.port}/mcp`, {
          method: "POST",
          headers: auth,
          body: INITIALIZE,
        }).then((r) => r.text())
      )
    );
    // Nothing to assert directly from outside beyond the server staying up and
    // answering; the cap itself is covered by the unit tests.
    const health = await fetch(`http://127.0.0.1:${s.port}/health`);
    expect(health.status).toBe(200);
  });
});

describe("path matching", () => {
  let s: Started;
  beforeAll(async () => {
    s = await start({ HOST: "127.0.0.1", MCP_AUTH_TOKEN: TOKEN });
  });
  afterAll(() => stop(s));

  it("does not serve MCP on a path that merely starts with the MCP path", async () => {
    // Regression: req.url.startsWith(cfg.path) made /mcpXYZ and /mcp-evil
    // fully working MCP endpoints, which defeats any WAF rule, proxy route or
    // rate limit scoped to exactly /mcp.
    for (const path of ["/mcpXYZ", "/mcp-evil", "/mcpevil"]) {
      const res = await rawRequest(s.port, path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: INITIALIZE,
      });
      expect(res.status, path).toBe(404);
    }
  });

  it("keeps /health reachable with a query string", async () => {
    // Regression: an exact `req.url === "/health"` comparison 404s any probe
    // that appends a cache-buster.
    for (const path of ["/health", "/health?x=1"]) {
      const res = await rawRequest(s.port, path);
      expect(res.status, path).toBe(200);
    }
  });

  it("does not disclose the tool count on /health", async () => {
    const res = await rawRequest(s.port, "/health");
    expect(res.body).not.toContain("tools");
  });
});
