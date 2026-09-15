#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { callOperation } from "./client.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { loadAllSpecs, type Operation } from "./openapi.js";
import { loadCatalog } from "./specs.js";
import { operationsToTools, resolveCall, toolOperations, type ToolDefinition } from "./tools.js";
import { GRAPHQL_TOOL_NAME, callGraphql, graphqlTool } from "./graphql.js";
import { RAW_REQUEST_TOOL_NAME, callRawRequest, rawRequestTool } from "./rawRequest.js";
import {
  CAPABILITIES_TOOL_NAME,
  capabilitiesTool,
  checkCapabilities,
  runCapabilities,
  summarizeProfile,
  type CapabilityProfile,
  type ProbeFn,
} from "./capabilities.js";
import {
  GET_ENDPOINT_TOOL,
  INVOKE_ENDPOINT_TOOL,
  SEARCH_ENDPOINTS_TOOL,
  discoveryTools,
  handleGetEndpoint,
  handleSearchEndpoints,
} from "./discovery.js";
import {
  bearerFrom,
  healthHostAllowlist,
  hostAllowed,
  hostAllowlist,
  loadHttpConfig,
  startupRefusal,
  tokenMatches,
  weakTokenWarning,
} from "./http.js";

const SERVER_NAME = "hubspot-mcp";

const FALLBACK_VERSION = "unknown";

/**
 * The version reported over MCP. It comes from package.json, which CI stamps
 * from the release tag and writes back to main, so the number is never
 * maintained by hand and never drifts from what was actually published. It
 * used to be a second literal in this file, which is why it still said 1.0.1
 * after the repository had moved on.
 */
function readPackageVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as {
      version?: string;
    };
    return pkg.version ?? FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

const SERVER_VERSION = readPackageVersion();

/** How long stdio startup waits for the access check before serving without it. */
const ACCESS_CHECK_WAIT_MS = 10_000;

/** The startup access check's result, shared by every session once it lands. */
interface AccessState {
  profile?: CapabilityProfile;
}

/** Probes fail fast: a slow or failing probe only means "unverified". */
const probeOperation: ProbeFn = (cfg, op, args) =>
  callOperation({ ...cfg, maxRetries: 0, timeoutMs: Math.min(cfg.timeoutMs, 10_000) }, op, args);

interface Registry {
  /** Endpoint tools generated from the specs (post-filtering). */
  endpointTools: ToolDefinition[];
  /** The tools actually advertised to the client (depends on tool mode). */
  exposedTools: ToolDefinition[];
  /** All spec operations that survived filtering (for capabilities). */
  operations: Operation[];
}

/** Build the full, filtered tool surface for the configured mode. */
function buildRegistry(config: ServerConfig): Registry {
  const catalog = loadCatalog(config.specDir);
  const allOperations = loadAllSpecs(config.specDir, catalog.apis, resolve);
  const endpointTools = operationsToTools(allOperations, {
    includeGroups: config.includeGroups,
    excludeGroups: config.excludeGroups,
    readOnly: config.readOnly,
    includeBeta: config.includeBeta,
  });
  const operations = endpointTools.flatMap(toolOperations);

  const special: ToolDefinition[] = [capabilitiesTool()];
  // HubSpot's GraphQL endpoint is query-only, so it stays in read-only mode.
  if (config.enableGraphql) special.push(graphqlTool(config));
  // The raw escape hatch can write/delete — hidden in read-only mode.
  if (config.enableRawRequest && !config.readOnly) special.push(rawRequestTool(config));

  const exposedTools =
    config.toolMode === "discovery"
      ? [...discoveryTools(config, endpointTools.length), ...special]
      : [...endpointTools, ...special];

  return { endpointTools, exposedTools, operations };
}

const MISSING_TOKEN_MESSAGE =
  "HUBSPOT_ACCESS_TOKEN is not set, so this server cannot call HubSpot. Create a service key (or legacy private app token) " +
  "in HubSpot under Settings -> Integrations, set it as HUBSPOT_ACCESS_TOKEN in the server environment, and restart the server.";

/**
 * Guidance the client places ahead of the tool catalog. It covers what no
 * single tool description can: where to start, how the safety banners map to
 * confirmation, and how plan/scope gating shows up.
 */
function serverInstructions(config: ServerConfig, access: AccessState): string {
  const lines = [
    "HubSpot API server: tools map 1:1 to HubSpot's public REST endpoints (CRM, CMS, Marketing, Automation, Commerce, Files, Settings, Webhooks).",
    "Every tool description starts with a safety banner that matches its annotations: 🟢 READ-ONLY (no changes), 🟡 WRITE (creates, updates, links or sends), 🔴 DESTRUCTIVE (deletes, merges, purges). Confirm 🔴 tools and 'sends messages' tools with the user before calling them.",
    access.profile
      ? `The server checked this token's access when it started. ${summarizeProfile(access.profile)}`
      : `Call ${CAPABILITIES_TOOL_NAME} first: it reports the portal, the token's granted scopes, daily API usage, and an access status for every API group. Access depends on the portal's hubs and plan tier and on the token's scopes; a 403 names the missing scope or the required tier.`,
    "Prefer *_search and *_batch_* tools over loops of single calls. CRM list tools page with limit plus the after cursor; request only the properties you need.",
    "CRM deletes archive records to the recycle bin for about 90 days. Merges and gdpr_delete purges are permanent.",
  ];
  if (config.toolMode === "discovery") {
    lines.push(
      `Discovery mode: find an endpoint with ${SEARCH_ENDPOINTS_TOOL}, read its input schema with ${GET_ENDPOINT_TOOL}, then call it with ${INVOKE_ENDPOINT_TOOL}.`,
    );
  }
  if (config.readOnly) lines.push("Read-only mode: only 🟢 tools are exposed; no call can change the account.");
  return lines.join("\n\n");
}

/** Stringify a response body and, if configured, truncate very large payloads. */
function formatBody(config: ServerConfig, summary: string, body: unknown, rawBody?: string, hint?: string): string {
  let formatted = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  if (formatted === undefined) formatted = rawBody ?? "";
  const max = config.maxResponseChars;
  if (max > 0 && formatted.length > max) {
    const shown = formatted.slice(0, max);
    formatted =
      `${shown}\n\n…[truncated ${formatted.length - max} of ${formatted.length} characters. ` +
      `Narrow the result with limit/after/properties, or raise HUBSPOT_MAX_RESPONSE_CHARS.]`;
  }
  const hintBlock = hint ? `\n\n💡 ${hint}` : "";
  return `${summary}\n${formatted}${hintBlock}`;
}

function buildServer(registry: Registry, config: ServerConfig, access: AccessState): Server {
  const exposedMap = new Map(registry.exposedTools.map((t) => [t.name, t]));
  const endpointMap = new Map(registry.endpointTools.map((t) => [t.name, t]));
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: serverInstructions(config, access) },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.exposedTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
  }));

  const runEndpointTool = async (tool: ToolDefinition, args: unknown) => {
    const call = resolveCall(tool, args ?? {});
    const result = await callOperation(config, call.operation, call.args);
    const summary = `HTTP ${result.status} ${result.ok ? "OK" : "ERROR"}`;
    return {
      isError: !result.ok,
      content: [{ type: "text" as const, text: formatBody(config, summary, result.body, result.rawBody, result.hint) }],
    };
  };

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      // Catalog lookups work offline; everything else calls HubSpot.
      const offline = config.toolMode === "discovery" && (name === SEARCH_ENDPOINTS_TOOL || name === GET_ENDPOINT_TOOL);
      if (!config.accessToken && !offline) {
        return { isError: true, content: [{ type: "text", text: MISSING_TOKEN_MESSAGE }] };
      }

      if (name === CAPABILITIES_TOOL_NAME && exposedMap.has(name)) {
        const text = await runCapabilities(config, registry.operations, args ?? {}, probeOperation, access);
        return { content: [{ type: "text", text }] };
      }

      if (name === GRAPHQL_TOOL_NAME && exposedMap.has(name)) {
        const result = await callGraphql(config, args ?? {});
        const summary = `HTTP ${result.status} ${result.ok ? "OK" : "ERROR"}`;
        return { isError: !result.ok, content: [{ type: "text", text: formatBody(config, summary, result.body) }] };
      }

      if (name === RAW_REQUEST_TOOL_NAME && exposedMap.has(name)) {
        const result = await callRawRequest(config, args ?? {});
        const summary = `HTTP ${result.status} ${result.ok ? "OK" : "ERROR"}`;
        return { isError: !result.ok, content: [{ type: "text", text: formatBody(config, summary, result.body) }] };
      }

      if (config.toolMode === "discovery") {
        if (name === SEARCH_ENDPOINTS_TOOL) {
          return { content: [{ type: "text", text: handleSearchEndpoints(registry.endpointTools, args ?? {}, access.profile) }] };
        }
        if (name === GET_ENDPOINT_TOOL) {
          return { content: [{ type: "text", text: handleGetEndpoint(endpointMap, args ?? {}, access.profile) }] };
        }
        if (name === INVOKE_ENDPOINT_TOOL) {
          const a = (args ?? {}) as Record<string, unknown>;
          const target = endpointMap.get(String(a.name ?? ""));
          if (!target || !target.operation) {
            return {
              isError: true,
              content: [{ type: "text", text: `Unknown endpoint "${a.name}". Find valid names with ${SEARCH_ENDPOINTS_TOOL}.` }],
            };
          }
          return await runEndpointTool(target, a.arguments ?? {});
        }
      }

      const tool = exposedMap.get(name);
      if (!tool || !tool.operation) {
        return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
      }
      return await runEndpointTool(tool, args ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Tool execution failed: ${message}` }] };
    }
  });

  return server;
}

class BodyTooLarge extends Error {}

/**
 * Reads the request body, refusing anything over `limitBytes`. Without the
 * limit the whole request is buffered in memory, and with no token set anyone
 * who could reach the port could send a body of any size.
 */
async function readBody(
  req: IncomingMessage,
  limitBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) {
      // Throwing out of `for await` already destroys the request and nulls its
      // socket, so neither req.pause() nor a later req.destroy() does anything.
      // The response socket is still alive, which is all the caller needs to
      // write the 413.
      throw new BodyTooLarge(`Request body exceeds ${limitBytes} bytes`);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function runStdio(registry: Registry, config: ServerConfig, access: AccessState) {
  const server = buildServer(registry, config, access);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} (stdio) ready: ${registry.exposedTools.length} tools registered.`);
}

async function runHttp(registry: Registry, config: ServerConfig, access: AccessState) {
  const cfg = loadHttpConfig();

  // A server reachable beyond this machine must require a token. This endpoint
  // can read, write and delete across the whole HubSpot account, so starting it
  // wide open is refused rather than warned about.
  const refusal = startupRefusal(cfg);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
  if (cfg.portFellBack) {
    console.error(
      `${SERVER_NAME}: WARNING - PORT=${process.env.PORT} is not a usable ` +
        `port number, falling back to ${cfg.port}. A platform that injects ` +
        `PORT will probe the value it injected, not this one.`,
    );
  }
  const weak = weakTokenWarning(cfg);
  if (weak) console.error(`${SERVER_NAME}: ${weak}`);
  if (!cfg.authToken && cfg.allowInsecure) {
    console.error(
      `${SERVER_NAME}: WARNING - MCP_ALLOW_INSECURE is set and no ` +
        "MCP_AUTH_TOKEN is configured. Anyone who can reach this port has " +
        "full access to the HubSpot account data.",
    );
  }

  const allowlist = hostAllowlist(cfg);
  const healthAllowlist = healthHostAllowlist(cfg);

  type Session = {
    server: Server;
    transport: StreamableHTTPServerTransport;
    lastSeen: number;
    /** Open SSE streams; a session serving one is in use, however quiet. */
    streams: number;
  };
  const sessions = new Map<string, Session>();

  const drop = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    void Promise.resolve(s.transport.close()).catch(() => {});
  };

  // Sessions were previously only removed when the transport closed, and each
  // one holds a full Server built over the whole endpoint catalog. A client that
  // reconnects instead of closing grew the map until the process died.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - cfg.sessionTtlMs;
    for (const [id, s] of sessions) {
      if (s.streams === 0 && s.lastSeen < cutoff) drop(id);
    }
  }, 60_000);
  sweep.unref();

  const evictOldest = () => {
    let victim: string | undefined;
    let oldest = Infinity;
    let victimStreaming = true;
    for (const [id, s] of sessions) {
      const streaming = s.streams > 0;
      // A non-streaming candidate always beats a streaming one.
      if (victimStreaming && !streaming) {
        victim = id;
        oldest = s.lastSeen;
        victimStreaming = false;
        continue;
      }
      if (streaming === victimStreaming && s.lastSeen < oldest) {
        victim = id;
        oldest = s.lastSeen;
      }
    }
    if (victim) drop(victim);
  };

  const send = (res: ServerResponse, status: number, payload: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const rpcError = (code: number, message: string) => ({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.writeHead(400).end();
      return;
    }

    // 1. DNS-rebinding protection, on every route: /health used to answer with
    //    any Host header and hand out the server name, tool count and mode.
    const listForRequest =
      req.method === "GET" && (req.url === "/health" || req.url.startsWith("/health?"))
        ? healthAllowlist
        : allowlist;
    if (listForRequest && !hostAllowed(req.headers.host, listForRequest)) {
      send(res, 403, rpcError(-32000, `Invalid Host: ${req.headers.host ?? "(missing)"}`));
      return;
    }

    // Parse once: req.url carries the query string, and startsWith() turned
    // /mcpXYZ and /mcp-evil into fully working MCP endpoints, which silently
    // defeats any WAF rule, proxy route or rate limit scoped to exactly /mcp.
    const pathname = (() => {
      try {
        return new URL(req.url!, "http://localhost").pathname;
      } catch {
        return req.url!;
      }
    })();
    const isMcpPath = pathname === cfg.path || pathname.startsWith(cfg.path + "/");

    // Liveness only. Behind the Host check, in front of the auth gate so a
    // platform health check needs no token. The tool count and mode it used to
    // report told an unauthenticated caller how the server was configured.
    if (req.method === "GET" && pathname === "/health") {
      send(res, 200, { status: "ok", server: SERVER_NAME });
      return;
    }

    if (!isMcpPath) {
      send(res, 404, rpcError(-32601, `Not found. MCP endpoint is ${cfg.path}`));
      return;
    }

    // 2. Shared secret, still before the body is read. The comparison is
    //    constant-time; `!==` on the raw strings leaked the token prefix.
    if (cfg.authToken && !tokenMatches(bearerFrom(req.headers.authorization), cfg.authToken)) {
      send(res, 401, rpcError(-32001, "Unauthorized"));
      return;
    }

    try {
      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

      // 3. Body first, so an initialize can be recognised without allocating.
      let body: unknown;
      if (req.method === "POST") {
        try {
          body = await readBody(req, cfg.bodyLimitBytes);
        } catch (err) {
          if (err instanceof BodyTooLarge) {
            send(res, 413, rpcError(-32600, `Request body exceeds the configured limit of ${cfg.bodyLimitBytes} bytes`));
            return;
          }
          throw err;
        }
      }

      let session: Session | undefined;

      if (sessionId) {
        session = sessions.get(sessionId);
        if (!session) {
          // 404, not a silent new session: this used to build a fresh Server
          // for any session id it did not recognise, so a client that sent a
          // stale id got a working but empty session instead of being told to
          // re-initialize, and nothing capped how many were created.
          send(res, 404, rpcError(-32001, "Session not found"));
          return;
        }
        session.lastSeen = Date.now();
      } else if (req.method === "POST" && isInitializeRequest(body)) {
        if (sessions.size >= cfg.maxSessions) evictOldest();
        const server = buildServer(registry, config, access);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newId) => {
            sessions.set(newId, { server, transport, lastSeen: Date.now(), streams: 0 });
          },
        });
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) sessions.delete(id);
        };
        await server.connect(transport);
        session = { server, transport, lastSeen: Date.now(), streams: 0 };
      } else {
        send(res, req.method === "POST" ? 400 : 404, rpcError(-32000, "Bad Request: no valid session ID provided."));
        return;
      }

      // A GET is the SSE stream and stays open; count it so the idle sweep
      // leaves the session alone while it is genuinely in use.
      if (req.method === "GET" && sessionId) {
        const held = session;
        held.streams += 1;
        res.on("close", () => {
          held.streams = Math.max(0, held.streams - 1);
          held.lastSeen = Date.now();
        });
      }

      await session.transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("Request handling error:", err);
      if (!res.headersSent) {
        send(res, 500, rpcError(-32603, "Internal server error"));
      } else {
        res.end();
      }
    }
  });

  // Without this a failed bind was silent: nothing listened, nothing was
  // logged, and the process stayed up as if it had started.
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    const hint =
      err.code === "EADDRINUSE"
        ? ` Port ${cfg.port} is already in use.`
        : err.code === "EACCES"
          ? ` No permission to bind port ${cfg.port}.`
          : err.code === "ENOTFOUND" || err.code === "EADDRNOTAVAIL"
            ? ` HOST=${cfg.host} is not an address this machine can bind.`
            : "";
    console.error(
      `Fatal: could not listen on ${cfg.host}:${cfg.port}.${hint} (${err.code ?? err.message})`,
    );
    process.exit(1);
  });

  httpServer.listen(cfg.port, cfg.host, () => {
    console.error(
      `${SERVER_NAME} (http) ready on http://${cfg.host}:${cfg.port}${cfg.path}  -  ${registry.exposedTools.length} tools registered (${registry.endpointTools.length} endpoints, mode: ${config.toolMode}).`,
    );
    if (allowlist) {
      console.error(`${SERVER_NAME}: Host header restricted to ${allowlist.join(", ")}`);
    }
    if (cfg.authToken) console.error("Bearer auth: required (MCP_AUTH_TOKEN set).");
    else console.error("Bearer auth: DISABLED (MCP_AUTH_TOKEN not set).");
  });

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down…`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/**
 * Check scopes and probe paid-tier or beta groups once, in the background.
 * Skipped without a token or with HUBSPOT_CAPABILITY_CHECK=false.
 */
function startAccessCheck(config: ServerConfig, registry: Registry, access: AccessState): Promise<void> | undefined {
  if (!config.accessToken || !config.capabilityCheck) return undefined;
  const started = Date.now();
  return checkCapabilities(config, registry.operations, probeOperation)
    .then((profile) => {
      access.profile = profile;
      const usable = profile.toolGroups.filter((g) => g.access === "available").length;
      console.error(
        `${SERVER_NAME}: access check done in ${Date.now() - started} ms: ${usable} of ${profile.toolGroups.length} API groups usable.`,
      );
    })
    .catch((err) => {
      console.error(`${SERVER_NAME}: access check failed: ${err instanceof Error ? err.message : String(err)}`);
    });
}

async function main() {
  const config = loadConfig();
  const registry = buildRegistry(config);
  // Start anyway: tools/list needs no credentials, so registries and inspectors
  // can enumerate the catalog. Tool calls return MISSING_TOKEN_MESSAGE instead.
  if (!config.accessToken) {
    console.error(`${SERVER_NAME}: WARNING - HUBSPOT_ACCESS_TOKEN is not set. Tools are listed, but every HubSpot call will fail until it is.`);
  }

  const access: AccessState = {};
  const check = startAccessCheck(config, registry, access);

  const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (transport === "http" || transport === "streamable-http") {
    // Listen right away so health checks pass; sessions opened after the check get its result.
    await runHttp(registry, config, access);
  } else if (transport === "stdio") {
    // The initialize reply carries the instructions, so give the check a moment to land first.
    if (check) await Promise.race([check, new Promise((done) => setTimeout(done, ACCESS_CHECK_WAIT_MS).unref())]);
    await runStdio(registry, config, access);
  } else {
    throw new Error(`Unknown MCP_TRANSPORT: ${transport}. Use "stdio" or "http".`);
  }
}

main().catch((err) => {
  console.error(`Fatal error starting ${SERVER_NAME}:`, err);
  process.exit(1);
});
