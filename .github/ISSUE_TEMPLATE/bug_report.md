---
name: Bug report
about: Something isn't working as expected
title: "[Bug] "
labels: bug
---

**Describe the bug**
A clear description of what went wrong.

**To reproduce**
Steps to reproduce the behavior:
1. …
2. …

Include the tool name and (redacted) arguments if a specific tool call failed.

**Expected behavior**
What you expected to happen.

**Logs**
Relevant output from `docker compose logs -f` or your MCP client.
⚠️ **Redact your `HUBSPOT_ACCESS_TOKEN` and any other secrets before pasting.**

**Environment**
- OS:
- Docker version (`docker --version`):
- How you run it: Docker / stdio from source
- Node version (if from source):
- MCP client (Claude Desktop, Claude Code, Cursor, …):
- HubSpot region base URL (`api.hubapi.com` or `api-eu1.hubapi.com`), if relevant:
- Hub plan(s) (e.g. Marketing Hub Pro), if the issue is a 403/plan gate:

**Additional context**
Anything else that helps — the output of `hubspot_get_capabilities` (redacted)
is often useful for access issues.
