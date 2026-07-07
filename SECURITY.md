# Security Policy

## Supported Versions

This project tracks the latest commit on the `main` branch. Security fixes land
there — please make sure you are running the most recent version before
reporting an issue.

| Version | Supported |
| ------- | :-------: |
| `main` (latest) | ✅ |
| older commits   | ❌ |

## Reporting a Vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately through GitHub:

1. Open this repository's [**Security** tab](../../security).
2. Click [**Report a vulnerability**](../../security/advisories/new) to start a
   private security advisory.

> If the "Report a vulnerability" button isn't visible, a maintainer needs to
> enable **Private vulnerability reporting** under **Settings → Security**.

Please include:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if possible), and
- the affected version/commit and your environment.

You'll get an initial response on a best-effort basis. Once a fix is ready it is
released on `main` and the advisory is published.

## Deployment & Hardening Notes

This server bridges an MCP client to the **HubSpot API**. It can read and write
real business data — contacts, companies, deals, tickets, CMS content, files,
commerce records — and can **send real email** (marketing single-send,
transactional email, sequence enrollments), **merge records irreversibly** and
**permanently purge data for GDPR**, so treat it accordingly:

- **Your access token is a secret.** `HUBSPOT_ACCESS_TOKEN` lives in `.env`,
  which is git-ignored — never commit or share it. If it leaks, rotate it in
  **HubSpot → Settings → Integrations → Private Apps**. The token grants
  whatever its scopes allow.
- **Scope the token at the source.** A private app only receives the scopes you
  tick — grant read scopes for reporting deployments and add write scopes
  deliberately. The `hubspot_get_capabilities` tool shows exactly which tool
  groups the current scopes unlock.
- **Credentials never reach the model.** The server injects the
  `Authorization: Bearer` header on every outgoing request; the MCP client (and
  the LLM behind it) only ever sees tool inputs and API responses, never your
  token.
- **The HTTP endpoint is unauthenticated by default**, which is fine for
  localhost-only use (the bundled `docker-compose.yml` binds to `127.0.0.1`). If
  you expose it beyond your machine, set `MCP_SHARED_TOKEN` and require it via an
  `Authorization: Bearer <token>` header. Prefer running it behind TLS (a reverse
  proxy) rather than exposing the raw port.
- **Mind the destructive and outbound tools.** Deletes, batch archives, record
  **merges** (cannot be undone), **GDPR purges** (skip the recycle bin) and the
  email **send** tools carry `destructiveHint` / non-`readOnlyHint` annotations
  and 🔴 / 🟡 banners so a well-behaved host can prompt for confirmation — keep
  that confirmation on. For read-heavy or reporting use cases, run with
  `HUBSPOT_READ_ONLY=true` to expose only 🟢 read-only tools (the raw-request
  escape hatch is hidden automatically in that mode).
- **Scope the surface if you can.** Use `HUBSPOT_INCLUDE_GROUPS` /
  `HUBSPOT_EXCLUDE_GROUPS` (group keys or `area:*` wildcards) to expose only the
  resource groups a given deployment needs.
- **Keep the container on a trusted network** and **keep dependencies current**
  (see Dependabot, if enabled).

Thank you for helping keep this project and its users safe.
