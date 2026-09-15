# ohneben's HubSpot MCP

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-ohneben-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/ohneben)

---

#### License & checks

[![CI](https://github.com/ohneben/Hubspot-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/ohneben/Hubspot-MCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE.md)

#### MCP registries

[![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0.1%2Fservers%2Fio.github.ohneben%252Fhubspot-mcp%2Fversions%2Flatest&query=%24.server.version&prefix=v&label=MCP%20Registry&color=blue&logo=modelcontextprotocol&logoColor=white)](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.ohneben%2Fhubspot-mcp/versions/latest)
[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/ohneben/hubspot-mcp)
[![Hubspot-MCP MCP server](https://glama.ai/mcp/servers/ohneben/Hubspot-MCP/badges/score.svg)](https://glama.ai/mcp/servers/ohneben/Hubspot-MCP)

**The most complete HubSpot MCP server there is.** Run your entire
[HubSpot](https://www.hubspot.com/) account in plain language from **Claude**,
**Cursor**, or any other [MCP](https://modelcontextprotocol.io) client.

This [Model Context Protocol](https://modelcontextprotocol.io) server exposes the
**whole public HubSpot API — all 1,076 endpoints across 102 APIs, in 687
tools** — CRM, CMS, Marketing, Automation, Conversations, Commerce, Files,
Settings, Webhooks and more, generated straight from HubSpot's own OpenAPI
definitions. Endpoints HubSpot repeats per object type are one tool each
(`crm_objects_search` with `objectType: "deals"` instead of 32 separate search
tools), and every tool description says when to use it. Every tool is
**safety-categorized** (🟢 read-only / 🟡 write / 🔴 destructive) and — unique to
this server — **hub & plan aware**: HubSpot publishes which hub and tier every
API needs (Free / Starter / Professional / Enterprise), and this server carries
that straight into each tool plus a live **capability report** for *your*
portal. It runs over **stdio** (Claude Desktop and other local launchers) or
**Streamable HTTP** (hosted in Docker), and ships with retries, client-side rate
limiting tuned to HubSpot's burst caps, and request timeouts so it holds up
against a live account.

## Why you'll want this

Some MCP servers just forward a slice of the API. This one is built to be **safe
to hand to an LLM**, **complete**, and **easy to run for real**:

| What you get | Why it matters |
| --- | --- |
| **All 1,076 endpoints — the whole public API** | Contacts, companies, deals, tickets, every engagement type, associations v4, properties, pipelines, lists, imports/exports, marketing emails & events, campaigns, forms, transactional email, sequences, workflows/actions, conversations & custom channels, CMS pages/posts/HubDB/source code, files, commerce (invoices, orders, carts, payments, subscriptions), settings, webhooks — nothing hand-picked or left behind. Most servers stop at ~30 CRM tools. |
| **687 tools, not 1,076 look-alikes** | HubSpot repeats the same endpoints for 32 CRM object types, for landing and site pages, and for blog posts, authors and tags. Those are one tool each with a selector argument (`objectType`, `pageType`, `blogResource`), so `crm_objects_search` covers contacts, deals, tickets and custom objects. Every call still goes to exactly the endpoint it went to before, with that endpoint's scopes and plan hints. |
| **Descriptions that say when to use a tool** | Each description opens with what the tool does, then when to prefer a sibling (`crm_objects_list` points to `crm_objects_search` for filtering and `crm_objects_batch_read` for known IDs), what it changes, plan and scopes, and the endpoint it calls. Undocumented HubSpot parameters get a description. |
| **Hub & plan awareness** *(nobody else has this)* | HubSpot gates APIs by hub and tier — HubDB needs Content/Marketing Hub **Professional**, custom-object schemas need **Enterprise**, sequences need Sales/Service **Professional**. Every tool states its requirement, straight from HubSpot's own API index. |
| **Access check at startup** | When the server starts it reads the token's scopes and probes every paid-tier or beta API group with one cheap read. The model gets the result in the server instructions, search results say per tool whether this token can use it, and `hubspot_get_capabilities` explains each status with the scopes to add. No more walls of mystery 403s. |
| **Curated safety categories** 🟢 / 🟡 / 🔴 | Not naive "GET = safe": a `POST …/search` is a **read-only query**, `merge` is flagged **irreversible**, `gdpr-delete` is a **permanent purge** (vs. archive → recycle bin), list-membership calls are reversible **links**, `POST /crm/v3/imports` is a **bulk import**, and transactional email is **sends messages**. |
| **Machine-readable MCP annotations** (`readOnlyHint`, `destructiveHint`) | Hosts that honor annotations (Claude included) can auto-trust reads and demand confirmation before anything destructive. |
| **Actionable error hints** | 403 with `MISSING_SCOPES` → the exact scopes to add and where; plain 403 on a gated API → the plan tier it needs; 401 → token type & expiry guidance; 429 → your limits. The model gets *how to fix it*, not just *what broke*. |
| **Read-only mode & group filtering** | Expose only the 302 🟢 read-only tools (`HUBSPOT_READ_ONLY=true`), or narrow to the groups you use (`HUBSPOT_INCLUDE_GROUPS=contacts,deals,cms:*`). Area wildcards included. |
| **Discovery mode by default** | Out of the box the model sees 6 tools (~2k tokens): search, inspect and invoke over all 687 endpoint tools, plus the capability, GraphQL and raw-request tools. `HUBSPOT_TOOL_MODE=all` exposes every endpoint tool directly. Read-only mode applies either way. |
| **Real file uploads** | The multipart endpoints (Files, CRM imports, HubDB import, CMS source code) actually work — pass file content inline or as base64. Most generated servers can't do multipart at all. |
| **Automatic retries with backoff** | Transient `429` / `5xx` responses are retried with jittered exponential backoff, honoring HubSpot's `Retry-After` header. |
| **Built-in rate limiting** | Self-throttles under HubSpot's burst caps (default 100 req / 10 s) with a **separate limiter for the `/search` endpoints** (~5 req/s cap). A burst of tool calls won't trip a `429`. |
| **Response-size guard** | Optionally cap huge list responses (`HUBSPOT_MAX_RESPONSE_CHARS`) so one call can't blow the model's context window. |
| **CRM GraphQL passthrough** | HubSpot's GraphQL endpoint is query-only, so it's a 🟢 tool here — fetch a contact, its company and that company's deals in one round-trip. |
| **Raw-request escape hatch** | `hubspot_api_request` reaches brand-new or beta endpoints the moment HubSpot ships them — auth, throttling and retries still handled server-side. |
| **Two transports: stdio *and* Streamable HTTP** | Use it locally in Claude Desktop, or run one always-on server that any number of MCP clients reach over HTTP. |
| **Docker + docker-compose, health check, auto-restart** | Production-style deployment out of the box: `docker compose up` and it stays up. |
| **Optional bearer-token auth** on the HTTP endpoint | Put the server behind a shared secret the moment it's reachable beyond localhost. |
| **Your token never reaches the model** | The access token lives in the server's environment and is injected on every request — the assistant only ever sees tool inputs and API responses. |
| **Drop-in spec updates** | `npm run fetch-specs` pulls HubSpot's latest OpenAPI definitions (and their hub/tier metadata) from HubSpot's public index — new endpoints become new tools on rebuild, no code changes. |

## How it compares

There are a few ways to reach HubSpot from an AI assistant today. Here's how this
server stacks up against the alternatives:

| | **This server** | Official HubSpot MCP | shinzo-labs `hubspot-mcp` | `mcp-hubspot` (buryhuang) | CData MCP |
|---|:---:|:---:|:---:|:---:|:---:|
| Approx. tools | **~690 (all 1,076 endpoints)** | ~7 curated (remote) | 100+ | ~7 | 3 (generic SQL) |
| Whole public API (CRM **and** CMS · Marketing · Automation · Commerce · Files · Settings · Webhooks) | ✅ | ➖ CRM + some content reads | ➖ CRM-centric | ❌ | ❌ |
| Hub & plan-tier awareness per tool | ✅ | ❌ | ❌ | ❌ | ❌ |
| Account capability report (scopes · usage · unlocks) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Reads **and** writes | ✅ | ✅ | ✅ | ➖ partial | ❌ read-only |
| Curated 🟢 / 🟡 / 🔴 safety categories | ✅ | ➖ | ➖ | ➖ | n/a |
| `readOnlyHint` / `destructiveHint` annotations | ✅ | ➖ | ➖ | ➖ | ➖ |
| Read-only mode + group filtering | ✅ | ❌ | ❌ | ❌ | always read-only |
| File uploads (multipart) | ✅ | ❌ | ❌ | ❌ | ❌ |
| GraphQL passthrough | ✅ | ❌ | ❌ | ❌ | ❌ |
| Rate limiting + auto-retry (`429`/`5xx`) | ✅ | ➖ | ➖ | ❌ | ❌ |
| `stdio` transport | ✅ | ✅ local package | ✅ | ✅ | ✅ |
| Streamable-HTTP transport | ✅ | ✅ hosted remote | ✅ | ❌ | ❌ |
| Docker + compose + health check | ✅ | ❌ | ➖ Dockerfile | ➖ image only | ❌ |
| Self-hosted on your own infra | ✅ | ➖ vendor cloud | ✅ | ✅ | ✅ |
| Language | TypeScript | TypeScript | TypeScript | Python | Java |
| License | MIT | — | MIT | MIT | MIT |

<sub>✅ = yes · ➖ = partial / not documented · ❌ = no. Compiled from each
project's public documentation; this is an unofficial project, not affiliated
with HubSpot or the projects listed. Tool counts are approximate and move as
APIs evolve.</sub>

**The short version:** the official remote server is a great managed on-ramp
but covers a handful of curated tools. The community servers are solid but
CRM-centric, without plan awareness or safety guardrails. This one gives you
**the entire public API**, **hub/plan awareness no one else has**, **both
transports**, a **production Docker deployment**, and **curated safety
categories** — self-hosted, on your token, MIT.

## What you can do

Once it's connected, ask your assistant things like:

- "Find jane@example.com, show her company, open deals and the last emails we exchanged."
- "Create a $12,000 deal 'Acme expansion' in the Sales pipeline, stage Qualified, associated with Acme Corp."
- "Search contacts created this month with lifecycle stage MQL and add them to the 'Q3 nurture' list."
- "Which HubDB tables exist? Add a row to 'pricing' and publish the table."
- "Clone last month's newsletter as a draft — don't publish."
- "Upload this CSV and start a contact import mapped to email + first name."
- "What can my token do? Check my API usage and which scopes are missing for HubDB." *(→ `hubspot_get_capabilities`)*
- "Merge these two duplicate contacts — after showing me both records first."

Tools are generated automatically from HubSpot's specs and grouped into
🟢 read-only, 🟡 write and 🔴 destructive — so a well-behaved host can treat each
group differently.

## How it works

```
Claude / Cursor / any MCP client  ──MCP──►  this server  ──HTTPS──►  api.hubapi.com (your portal)
```

The server parses 104 bundled OpenAPI definitions (fetched from HubSpot's public
API index, which also publishes per-API **hub/tier requirements**) into MCP
tools — resolving `$ref`s, guarding against recursive schemas, merging
endpoints that only differ by object type into one tool, deriving clean names
like `crm_objects_search` and `hubdb_tables_create_table`, and tagging each
tool with a curated safety category, its plan requirement and its OAuth scopes.
Your access token is injected server-side on every request; the model never
sees or handles it.

## Hub & plan awareness

HubSpot isn't one API — what you can call depends on **which hubs** (Marketing,
Sales, Service, Content, Commerce, Operations) and **which tier** (Free,
Starter, Professional, Enterprise) the portal has, plus the **scopes** granted
to your token. This server is built around that reality:

1. **Every tool description carries the requirement**, from HubSpot's own index:

   ```
   🟢 READ-ONLY · Get all published tables.
   Use to page through tables: pass limit, then the after cursor from paging.next.after for the next page.
   …
   Plan: Professional tier of Marketing Hub / Content Hub. Scopes: hubdb.
   Endpoint: GET /cms/v3/hubdb/tables (Hubdb API, CMS)
   ```

   Consolidated tools state it per value: `crm_objects_list` lists which
   object types need a paid tier in its `objectType` parameter.

2. **An access check runs when the server starts.** HubSpot has no API that
   returns a portal's subscription, so the server combines what it can
   observe: the token's granted scopes, and one cheap read per paid-tier or
   beta group (up to about 30 API calls; plan gates only surface as 403s).
   Every group gets a status: `available`, `missing_scopes`, `blocked` (plan
   tier, user permission, or a 401 from an API that does not accept this kind
   of token) or `unverified`. HubSpot's error details count: a 403 that names
   scopes the token lacks is a missing scope, while `MISSING_SCOPES` for an
   object whose scopes the token already holds is how HubSpot answers a plan
   gate, so that is reported as blocked. A read
   that succeeds proves read access only; a paid-tier API can still refuse
   writes, and the report says so. The model receives a summary in
   the server instructions, `hubspot_search_endpoints` marks each result (and
   takes `usable_only: true`), and `hubspot_get_capabilities` returns the full
   report with reasons, `"unlockedByScopes": "13/16"` counts and the scopes to
   add; `refresh: true` runs it again. Turn it off with
   `HUBSPOT_CAPABILITY_CHECK=false`.

3. **403s come back with the fix**: missing scope → the exact scope name and
   where to grant it; plan-gated API → the tier HubSpot requires.

## Requirements

- A **HubSpot account** and a **service key** (or an existing legacy private
  app token); see [Get your API credentials](#get-your-api-credentials).
- **Docker** (Docker Desktop on macOS/Windows) for the quick start below — or
  **Node.js ≥ 18** to [run from source](#run-from-source-stdio-no-docker).

## Quick start (Docker)

**1. Add your credentials.** Copy the example config and fill it in:

```bash
cp .env.example .env
# edit .env → set HUBSPOT_ACCESS_TOKEN
#           → set MCP_AUTH_TOKEN. REQUIRED unless HOST is a loopback address,
#             otherwise the server refuses to start: MCP_AUTH_TOKEN=$(openssl rand -hex 32)
```

**2. Start the server:**

```bash
docker compose up -d --build
```

The bundled `docker-compose.yml` binds to `127.0.0.1:8765` only, so the server is
reachable from your machine but not the network.

**3. Confirm it's running:**

```bash
curl -s http://localhost:8765/health
# → {"status":"ok","server":"hubspot-mcp"}
```

**4. Connect your MCP client.** The MCP endpoint is `http://localhost:8765/mcp`.

- **Claude Desktop** — add a **custom connector** (Settings → Connectors) pointing
  at the URL, or bridge it locally with
  [`mcp-remote`](https://www.npmjs.com/package/mcp-remote). Add this under
  `mcpServers` in your config, then fully quit and reopen the app:

  ```json
  {
    "mcpServers": {
      "hubspot": {
        "command": "npx",
        "args": [
          "mcp-remote",
          "http://localhost:8765/mcp",
          "--header", "Authorization: Bearer YOUR_MCP_AUTH_TOKEN"
        ]
      }
    }
  }
  ```

  (Drop the `--header` line only if the server runs without a token, which it
  allows on a loopback bind alone.)

- **Claude Code** — one command:

  ```bash
  claude mcp add --transport http hubspot http://localhost:8765/mcp
  ```

- **Claude Cowork** — shares Claude Code's MCP config, so the command above makes
  the tools available there too.

> **Tip:** by default the model sees 6 tools and reaches every endpoint through
> search → inspect → invoke. For one tool per endpoint set
> `HUBSPOT_TOOL_MODE=all` (690 tools) and trim it with `HUBSPOT_INCLUDE_GROUPS`
> (e.g. `contacts,companies,deals,tickets,lists`) — see
> [Context footprint](#context-footprint) for measured numbers per
> configuration.

### Prefer a prebuilt image?

Every push to `main` publishes a ready-to-run image to the GitHub Container
Registry, so you can skip the local build entirely:

```bash
docker run -d --name hubspot-mcp -p 127.0.0.1:8765:8765 --env-file .env \
  ghcr.io/ohneben/hubspot-mcp:latest
```

## Get your API credentials

The recommended way is a **service key**, HubSpot's replacement for legacy
private apps:

1. In HubSpot, open **Settings → Integrations → Service Keys** (or
   **Development → Keys → Service Keys**) and create a key. You need super
   admin rights or the *Developer tools access* permission.
2. Select the scopes you want the assistant to reach. Scopes map 1:1 to tool
   groups: grant read scopes (`crm.objects.contacts.read`, …) for a reporting
   setup, and add write scopes only where you want changes.
3. Copy the key (`pat-…`) → `HUBSPOT_ACCESS_TOKEN` in `.env`. It is sent as a
   bearer token exactly like a private app token, so nothing else changes.

Notes:

- **Service keys are in public beta** and differ from private apps in three
  ways that matter here: they do **not** support GraphQL (set
  `HUBSPOT_ENABLE_GRAPHQL=false`), rotation keeps the old key valid for a
  7-day grace period, and the scope and usage figures in the capability report
  may be incomplete for them.
- **Existing private app tokens keep working.** HubSpot stops the creation of
  new legacy private apps (existing portals from 26 October 2026, new portals
  from 28 September 2026); apps already created are not affected. A private
  app is still the only option here if you rely on the GraphQL tool.

- **OAuth access tokens work too** (for apps you've built) — but they expire
  after ~30 minutes and this server does not refresh them; a service key or
  private app token is the right fit for a long-running server.
- The token determines the portal — no portal ID needed.
- **EU data residency**: if your portal lives in HubSpot's EU data center, set
  `HUBSPOT_BASE_URL=https://api-eu1.hubapi.com`.

## Configuration

Everything is set in `.env` (copied from `.env.example`):

| Variable | Required | Default | Description |
|---|---|---|---|
| `HUBSPOT_ACCESS_TOKEN` | ✅ | — | Service key or legacy private app token (both `pat-…`), or an OAuth access token. Without it the server still starts and lists its tools (for registries and inspectors), but every call returns setup instructions |
| `HUBSPOT_BASE_URL` | — | `https://api.hubapi.com` | Use `https://api-eu1.hubapi.com` for EU data residency |
| `MCP_TRANSPORT` | — | `stdio` | `stdio` or `http` (the Docker image defaults to `http`) |
| `PORT` | — | `8765` | HTTP listen port |
| `HOST` | — | `0.0.0.0` | HTTP bind address |
| `MCP_HTTP_PATH` | — | `/mcp` | HTTP MCP route |
| `MCP_AUTH_TOKEN` | ⚠️ | _(off)_ | Require `Authorization: Bearer <token>` on `/mcp`. **Required** when `HOST` is not a loopback address, otherwise the server refuses to start. Renamed from `MCP_SHARED_TOKEN` in 1.1.0 |
| `MCP_ALLOWED_HOSTS` | — | _(derived)_ | Comma-separated hostnames the `Host` header may carry. Defaults to the loopback names on a loopback bind, and to no check behind a reverse proxy |
| `MCP_ALLOW_INSECURE` | — | `0` | Start without a token on a non-loopback bind. Only for a port that genuinely is not reachable by anyone else |
| `MCP_BODY_LIMIT` | — | `25mb` | Largest accepted request body |
| `MCP_SESSION_TTL` | — | `1800` | Seconds an idle session is kept before it is swept |
| `MCP_MAX_SESSIONS` | — | `256` | Concurrent sessions before the least recently used one is evicted |
| `HUBSPOT_MAX_REQUESTS` | — | `100` | Client-side requests per window (`0` disables throttling) |
| `HUBSPOT_RATE_WINDOW_MS` | — | `10000` | Rate-limit window in ms (default: 100 req / 10 s) |
| `HUBSPOT_SEARCH_MAX_REQUESTS` | — | `4` | Extra throttle for `/search` endpoints (`0` disables) |
| `HUBSPOT_SEARCH_RATE_WINDOW_MS` | — | `1000` | Search throttle window (default: 4 req / 1 s) |
| `HUBSPOT_MAX_RETRIES` | — | `3` | Retries on `429` / `5xx` / network errors |
| `HUBSPOT_TIMEOUT_MS` | — | `30000` | Per-attempt request timeout |
| `HUBSPOT_READ_ONLY` | — | `false` | Expose only 🟢 read-only tools |
| `HUBSPOT_INCLUDE_GROUPS` | — | _(all)_ | Only expose these groups — keys like `contacts,deals` and area wildcards like `cms:*` |
| `HUBSPOT_EXCLUDE_GROUPS` | — | _(none)_ | Hide these groups (same syntax) |
| `HUBSPOT_INCLUDE_BETA` | — | `true` | Include beta / developer-preview APIs |
| `HUBSPOT_TOOL_MODE` | — | `discovery` | `discovery` (3 meta-tools over the whole catalog) or `all` (one tool per endpoint or endpoint family) |
| `HUBSPOT_CAPABILITY_CHECK` | — | `true` | Read the token's scopes and probe paid-tier or beta groups at startup (up to about 30 API calls) |
| `HUBSPOT_ENABLE_GRAPHQL` | — | `true` | Expose the CRM GraphQL query tool |
| `HUBSPOT_GRAPHQL_URL` | — | _(derived)_ | Override the GraphQL endpoint |
| `HUBSPOT_ENABLE_RAW_REQUEST` | — | `true` | Expose the raw-request escape hatch (auto-hidden in read-only mode) |
| `HUBSPOT_MAX_RESPONSE_CHARS` | — | `0` | Truncate responses longer than N chars (`0` = never) |
| `HUBSPOT_SPEC_DIR` | — | _(bundled)_ | Load OpenAPI files + catalog.json from a different directory |

After changing `.env`, reload with `docker compose up -d --force-recreate`.

Run `npm run list-tools` (no credentials needed) to print the full catalog, the
per-category counts, and every group key you can filter on — add `--names` to
list all 687 tool names with the endpoint each one calls.

## Tool safety categories

Each tool's description starts with one of these banners and carries the matching
[MCP annotations](https://modelcontextprotocol.io/docs/concepts/tools#tool-annotations):

| Banner | Tools | Endpoints | `readOnlyHint` | `destructiveHint` | Meaning |
|---|:---:|:---:|:---:|:---:|---|
| 🟢 **READ-ONLY** | 274 | 348 | `true` | `false` | `GET` — fetches data only. Safe. |
| 🟢 **READ-ONLY · query** | 28 | 95 | `true` | `false` | A `POST` that *searches/reads* (object search, batch read, export start, token introspection) — changes no records. |
| 🟡 **WRITE · creates data** | 133 | 198 | `false` | `false` | Creates records (not idempotent; may duplicate). |
| 🟡 **WRITE · creates or updates** | 7 | 36 | `false` | `false` | Idempotent upserts (batch upsert, marketing-event upsert). |
| 🟡 **WRITE · updates data** | 131 | 215 | `false` | `false` | Modifies records/settings in place, including publishing, scheduling and restoring existing content. |
| 🟡 **WRITE · links records** | 18 | 19 | `false` | `false` | Associates records (list memberships, v4 associations). Reversible. |
| 🟡 **WRITE · unlinks records** | 11 | 12 | `false` | `false` | Removes associations. Reversible — records survive. |
| 🟡 **WRITE · sends messages** | 4 | 4 | `false` | `false` | Marketing/transactional email, sequence enrollment, conversation replies. |
| 🟡 **WRITE · bulk import** | 1 | 1 | `false` | `false` | `POST /crm/v3/imports` — can create/update thousands of records. |
| 🔴 **DESTRUCTIVE · deletes data** | 64 | 96 | `false` | `true` | Deletes/archives a record (CRM archives are restorable ~90 days). |
| 🔴 **DESTRUCTIVE · bulk delete** | 10 | 42 | `false` | `true` | Batch archive — many records in one call. |
| 🔴 **DESTRUCTIVE · merges records** | 3 | 7 | `false` | `true` | HubSpot **cannot un-merge**. Confirm both IDs first. |
| 🔴 **DESTRUCTIVE · permanent GDPR purge** | 3 | 3 | `false` | `true` | Skips the recycle bin; gone forever. |

That's **302 read-only · 305 write · 80 destructive = 687 endpoint tools**
(443 · 485 · 148 = 1,076 endpoints), plus the three power tools below. Hosts
that respect annotations (Claude included) can require confirmation for
`destructiveHint` tools and trust `readOnlyHint` tools automatically. Prefer to
lock it down further? Set `HUBSPOT_READ_ONLY=true` to expose *only* the 302
read-only tools (plus the 🟢 capability and GraphQL tools).

<details>
<summary><strong>Coverage by area (APIs / endpoints by 🟢 read / 🟡 write / 🔴 destructive / tools)</strong></summary>

| Area | APIs | 🟢 Read | 🟡 Write | 🔴 Delete | Endpoints | Tools |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| CRM | 58 | 216 | 245 | 92 | 553 | **211** |
| CMS | 13 | 74 | 123 | 22 | 219 | **172** |
| Marketing | 7 | 42 | 46 | 11 | 99 | **99** |
| Conversations | 3 | 18 | 11 | 3 | 32 | **32** |
| Automation | 3 | 17 | 10 | 4 | 31 | **31** |
| Webhooks Journal | 1 | 20 | 3 | 3 | 26 | **26** |
| Settings | 3 | 14 | 9 | 1 | 24 | **24** |
| Files | 1 | 10 | 7 | 4 | 21 | **21** |
| Communication Preferences | 1 | 6 | 8 | 0 | 14 | **14** |
| Events | 3 | 4 | 7 | 2 | 13 | **13** |
| Webhooks | 1 | 3 | 4 | 2 | 9 | **9** |
| Data Studio | 1 | 1 | 6 | 1 | 8 | **8** |
| Auth (OAuth) | 1 | 3 | 2 | 2 | 7 | **7** |
| Account | 2 | 5 | 0 | 0 | 5 | **5** |
| Commerce | 1 | 2 | 2 | 1 | 5 | **5** |
| Scheduler | 1 | 3 | 2 | 0 | 5 | **5** |
| Meta | 1 | 4 | 0 | 0 | 4 | **4** |
| Business Units | 1 | 1 | 0 | 0 | 1 | **1** |
| **Total** | **102** | **443** | **485** | **148** | **1,076** | **687** |

</details>

## Context footprint

What does the tool list cost in model context? Measured on the bundled specs
(`tools/list` JSON payload; tokens ≈ chars ÷ 3.6):

| Configuration | Tools | Payload | ≈ Tokens |
|---|---:|---:|---:|
| **Discovery mode (default)** | **6** | **0.01 MB** | **~2k** |
| `HUBSPOT_TOOL_MODE=all` | 690 | 1.33 MB | ~370k |
| `all` + read-only | 304 | 0.38 MB | ~104k |
| `all` + CRM core preset¹ | 85 | 0.13 MB | ~36k |
| `all` + CRM core preset¹ + read-only | 33 | 0.04 MB | ~12k |

In discovery mode each `hubspot_get_endpoint` lookup adds only the schema the
model asked for: about 350 tokens for a typical endpoint, up to ~12k for the
largest CMS page bodies.

<sub>¹ `HUBSPOT_INCLUDE_GROUPS=contacts,companies,deals,tickets,lists,properties,associations,pipelines,crm-owners,notes,tasks,calls,emails,meetings`</sub>

How to read that:

- **Discovery mode loses no coverage**: all 1,076 endpoints stay callable
  through search → inspect → invoke, at the cost of one or two extra calls the
  first time the model uses an endpoint.
- **Clients with tool search / deferred loading** (Claude Code, claude.ai
  connectors) load tool definitions on demand, so `HUBSPOT_TOOL_MODE=all` works
  well there; narrow it with a `HUBSPOT_INCLUDE_GROUPS` preset and/or
  `HUBSPOT_READ_ONLY=true`.
- **Responses consume context too.** Cap outliers with
  `HUBSPOT_MAX_RESPONSE_CHARS` (e.g. `40000`) and request only the
  `properties` you need on CRM reads.
- Oversized inline schemas are already handled: the four pathological
  recursive schemas (list filters, workflow definitions — ~1.7 MB *each*
  fully inlined) are budget-pruned to ≤24 KB with their top levels intact.
  Input schemas also drop examples and any prose below the body's own fields;
  every field, type, enum and required list stays.

## The power tools

Besides the generated endpoint tools, the server ships four hand-built ones:

- **`hubspot_get_capabilities`** 🟢 — the access report described
  [above](#hub--plan-awareness). Returns the startup check without new API
  calls; `refresh: true` runs it again.
- **`hubspot_graphql_query`** 🟢 — HubSpot's CRM GraphQL API
  (`POST /collector/graphql`). Query-only by design (HubSpot exposes no
  mutations), so it stays available even in read-only mode. Requires the
  `collector.graphql_query.execute` scope and Marketing/Content Hub Pro+.
- **`hubspot_api_request`** 🔴 — raw escape hatch for any path on the HubSpot
  host (new betas, undocumented corners). Same auth injection, throttling and
  retries. Hidden in read-only mode.
- **Discovery mode** (the default) — replaces the 687
  endpoint tools with `hubspot_search_endpoints` →
  `hubspot_get_endpoint` → `hubspot_invoke_endpoint` over the same registry.
  All filters (groups, beta, read-only) still apply; in read-only mode the
  invoke tool physically cannot reach a write because writes aren't in the
  registry.

## Upgrading from 1.x

2.0 merges endpoints that HubSpot repeats per object type into one tool with a
selector argument. Every endpoint is still reachable and sends the same
request; only tool names and a few argument names change. Update saved
prompts, client allowlists and permission rules that name tools. Group keys
for `HUBSPOT_INCLUDE_GROUPS` / `HUBSPOT_EXCLUDE_GROUPS` (`contacts`, `deals`,
`pages`, …) are unchanged.

| 1.x tools | 2.0 tool | Arguments |
|---|---|---|
| `contacts_list`, `deals_list`, `tickets_list`, … `custom_objects_list` | `crm_objects_list` | `objectType: "contacts"` (or `"deals"`, `"0-3"`, a custom `"2-12345"`, …) |
| `<type>_get`, `<type>_update`, `<type>_archive` (some were `<type>_delete`) | `crm_objects_get`, `crm_objects_update`, `crm_objects_archive` | `objectType`; the record ID is `objectId` instead of `contactId`, `dealId`, … |
| `<type>_create`, `<type>_search`, `<type>_merge`, `<type>_batch_read` / `_create` / `_update` / `_upsert` / `_archive` | `crm_objects_create`, `crm_objects_search`, `crm_objects_merge`, `crm_objects_batch_*` | `objectType` |
| `partner_clients_associations_*`, `partner_services_associations_*` | `crm_objects_associations_list` / `_create` / `_delete` | `objectType: "partner_clients"` or `"partner_services"`, `objectId` |
| `pages_landing_*`, `pages_site_*` | `cms_pages_*`, e.g. `cms_pages_draft_push_live` | `pageType: "landing"` or `"site"` |
| `posts_blogs_*`, `authors_blogs_*`, `tags_blogs_*` for list, get, archive, batch read/update/archive and multi-language | `cms_blog_*`, e.g. `cms_blog_list` | `blogResource: "posts"`, `"authors"` or `"tags"` |

Unchanged: endpoints only one type has (`contacts_gdpr_delete`, landing page
folders, blog post drafts and revisions, blog create/update, whose bodies differ
per resource). `npm run list-tools -- --names` prints every tool with the endpoint
it calls. POST endpoints that publish, schedule or restore existing content are
now labelled 🟡 *updates data* instead of *creates data*.

Two defaults change as well: `HUBSPOT_TOOL_MODE` is now `discovery` (set it to
`all` to expose the endpoint tools themselves), and the server runs the access
check at startup, which costs up to about 30 API calls per start
(`HUBSPOT_CAPABILITY_CHECK=false` turns it off).

## Run from source (stdio, no Docker)

Prefer the classic stdio mode for Claude Desktop? Build it locally:

```bash
npm install
npm run build
```

Then point Claude Desktop at the compiled entrypoint in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hubspot": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/Hubspot-MCP/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "HUBSPOT_ACCESS_TOKEN": "pat-na1-…"
      }
    }
  }
}
```

## Keeping the specs current

The bundled files under `spec/` are the source of truth for the tools. They are
fetched from **HubSpot's own public API index**
(`https://api.hubspot.com/public/api/spec/v1/specs`), which lists every public
API with per-version OpenAPI documents **and the hub/tier requirements** this
server bakes into tool descriptions. `spec/catalog.json` records what was
fetched (API, version, stage, beta flag, requirements, docs links).

To refresh against HubSpot's latest:

```bash
npm run fetch-specs   # rewrites spec/*.json + spec/catalog.json
npm run build && npm run list-tools
```

New endpoints become new tools automatically — no code changes. The fetch
script prefers each API's **stable classic version** (v1/v3/v4) and falls back
to dated or beta versions when that's all HubSpot offers; a couple of APIs are
pinned to bundle multiple genuinely-different versions (OAuth v1 + v3,
Communication Preferences v3 + v4).

## Development

```bash
npm install
npm run build       # compile TypeScript → dist/
npm test            # run the Vitest suite (160 tests)
npm run list-tools  # print the categorized tool catalog (no credentials needed)
npm run fetch-specs # refresh spec/ from HubSpot's public API index
```

CI builds and tests every push across Node 20 and 22; pushes to `main` also
publish a Docker image to the GitHub Container Registry.

## Notes & conventions

- **Transports**: `MCP_TRANSPORT=stdio` (default) for local launchers;
  `MCP_TRANSPORT=http` for the always-on Streamable-HTTP server the Docker image
  runs.
- **Paging**: CRM list tools use cursor paging — pass `limit` and the `after`
  cursor from `paging.next.after`. Ask for the properties you need via the
  `properties` parameter (arrays become repeated query params).
- **Selectors**: consolidated tools take `objectType` (`crm_objects_*`),
  `pageType` (`cms_pages_*`) or `blogResource` (`cms_blog_*`). `objectType`
  accepts names (`contacts`, `line_items`), objectTypeIds (`0-3`) and custom
  object types (`2-12345`).
- **Search**: `crm_objects_search` and the other `*_search` tools take a JSON
  `body` with `filterGroups`, `sorts`, `query`, `properties`, `limit` and
  `after`. HubSpot caps search at ~5 req/s per token — the built-in search
  throttle keeps you under it.
- **Batch tools** (`crm_objects_batch_read`, `crm_objects_batch_create`, …) are
  the efficient way to touch many records — prefer them over loops of single
  calls.
- **Associations**: use the v4 association tools (`associations_*`) to link
  records, with optional labels via the association-schema tools.
- **File uploads**: multipart tools accept file fields as
  `{"fileName": "report.pdf", "contentBase64": "…"}` (or `content` for plain
  text); other fields are sent as regular form fields, objects as JSON strings.
- **Deletes are archives** for CRM objects (recycle bin, ~90 days) — the truly
  permanent ones are the 🔴 `gdpr_delete` purge tools and record merges.
- **Rate limits**: HubSpot enforces burst caps per 10 s (private apps:
  100–200/10 s depending on plan; OAuth apps ~110/10 s) plus daily caps. The
  server self-throttles at `HUBSPOT_MAX_REQUESTS` per window and retries any
  `429` it still receives, honoring `Retry-After`. Check real usage anytime via
  `hubspot_get_capabilities`.
- **Request bodies**: write tools take a `body` argument; its schema is resolved
  from the spec and shown to the model (e.g. `crm_objects_create` expects
  `{"properties": {…}}`).
- **Beta APIs** (developer preview / public beta) are included by default and
  labelled ⚠️ in descriptions; hide them with `HUBSPOT_INCLUDE_BETA=false`.

## Security

- Your access token lives only in `.env`, which is git-ignored. **Never commit
  real secrets.** The token grants whatever its scopes allow — if it leaks,
  expire it in **Settings → Integrations → Service Keys** (or **Private Apps**
  for a legacy token).
- The HTTP endpoint refuses to start unauthenticated once it is bound beyond
  this machine. Set `MCP_AUTH_TOKEN` (`openssl rand -hex 32`) and send it as an
  `Authorization: Bearer <token>` header, ideally behind TLS. A loopback bind
  still needs no token, and is additionally protected against DNS rebinding by
  a `Host` header check.
- Destructive tools (delete / **merge** / **GDPR purge**) and **send** tools
  (marketing & transactional email, sequences) carry the right annotations so a
  well-behaved host prompts before acting — keep that confirmation on, or run
  with `HUBSPOT_READ_ONLY=true`.
- Scope the blast radius at the source: grant the service key only the scopes
  you actually need — the startup access check and `hubspot_get_capabilities`
  tell you what's missing when you want more. The check itself only reads.

See [SECURITY.md](./SECURITY.md) for the full policy and how to report a
vulnerability.

## Credits & license

An unofficial community integration for [HubSpot](https://www.hubspot.com/);
not affiliated with or endorsed by HubSpot. Built on the
[Model Context Protocol](https://modelcontextprotocol.io). Tools are generated
from HubSpot's public OpenAPI definitions. Licensed under the
[MIT License](./LICENSE.md).
