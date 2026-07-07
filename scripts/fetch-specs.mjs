#!/usr/bin/env node
/**
 * Refresh the bundled HubSpot OpenAPI specs from HubSpot's own public catalog.
 *
 * HubSpot publishes an index of every public API — including, per version, the
 * hub/tier requirements (e.g. "HubDB needs Marketing Hub Professional or
 * Content Hub Professional") — at:
 *
 *   https://api.hubspot.com/public/api/spec/v1/specs
 *
 * This script downloads that index, picks ONE version per API (see policy
 * below), fetches each OpenAPI document into `spec/`, and writes
 * `spec/catalog.json`: the manifest the server loads at startup, carrying the
 * hub/tier requirements and beta flags for every bundled file.
 *
 * Run it any time HubSpot ships new endpoints:
 *
 *   npm run fetch-specs
 *
 * New paths become new MCP tools on the next build — no code changes.
 *
 * Version policy (per API), most preferred first:
 *   1. classic numeric version (v1/v3/v4…) marked STABLE — highest number wins
 *   2. classic numeric version in any non-preview stage
 *   3. dated version (2026-03…) marked STABLE — newest date wins
 *   4. dated version in any non-preview stage — newest date wins
 *   5. developer-preview versions (classic first, then newest dated)
 *
 * Classic numeric versions are preferred because their URLs (`/crm/v3/…`) are
 * what HubSpot's docs, SDKs and the wider ecosystem reference; dated versions
 * (`/crm/objects/2026-03/…`) are still young and churn with each release.
 * APIs that only exist as dated or beta versions are bundled anyway — the
 * catalog marks them `beta: true` so the server can label (or exclude) them.
 *
 * PINS below force extra versions for APIs where several versions expose
 * genuinely different endpoints (OAuth v1 token introspection vs v3
 * token/revoke, Communication-Preference v3 subscribe/unsubscribe vs v4
 * statuses).
 */

import { mkdir, writeFile, readdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INDEX_URL = process.env.HUBSPOT_SPEC_INDEX_URL ?? "https://api.hubspot.com/public/api/spec/v1/specs";
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "spec");
const CONCURRENCY = 8;
const MAX_ATTEMPTS = 4;

/** Extra versions to bundle besides the policy pick, keyed by API name. */
const PINS = {
  Oauth: ["1", "3"],
  Subscriptions: ["3", "4"],
};

const kebab = (s) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const isClassic = (v) => /^\d+$/.test(v.version);
const isPreview = (v) => v.stage === "DEVELOPER_PREVIEW";

/** Pick the bundled version(s) for one API according to the policy + pins. */
function pickVersions(api) {
  const pinned = PINS[api.name];
  if (pinned) {
    const found = api.versions.filter((v) => pinned.includes(v.version));
    if (found.length === pinned.length) return found;
    console.warn(`⚠️  Pin for "${api.name}" (${pinned.join(", ")}) not fully present — falling back to policy.`);
  }

  const classicStable = api.versions.filter((v) => isClassic(v) && v.stage === "STABLE");
  const classicOther = api.versions.filter((v) => isClassic(v) && !isPreview(v));
  const datedStable = api.versions.filter((v) => !isClassic(v) && v.stage === "STABLE");
  const datedOther = api.versions.filter((v) => !isClassic(v) && !isPreview(v));
  const classicPreview = api.versions.filter((v) => isClassic(v) && isPreview(v));
  const datedPreview = api.versions.filter((v) => !isClassic(v) && isPreview(v));

  const byNumberDesc = (a, b) => Number(b.version) - Number(a.version);
  const byDateDesc = (a, b) => b.version.localeCompare(a.version);

  for (const [pool, sort] of [
    [classicStable, byNumberDesc],
    [classicOther, byNumberDesc],
    [datedStable, byDateDesc],
    [datedOther, byDateDesc],
    [classicPreview, byNumberDesc],
    [datedPreview, byDateDesc],
  ]) {
    if (pool.length > 0) return [pool.sort(sort)[0]];
  }
  return [];
}

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}

function countOperations(doc) {
  let n = 0;
  for (const item of Object.values(doc.paths ?? {})) {
    for (const m of ["get", "post", "put", "delete", "patch", "head", "options"]) {
      if (item && typeof item === "object" && item[m]) n++;
    }
  }
  return n;
}

async function main() {
  console.log(`Fetching HubSpot API index: ${INDEX_URL}`);
  const index = await fetchJson(INDEX_URL);
  const apis = index.results ?? [];
  console.log(`Index lists ${apis.length} public APIs.`);

  // Deterministic ordering so slug collisions resolve the same way every run.
  apis.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));

  // Assign slugs: API name, then group-prefixed on collision (e.g. the CRM
  // "Meetings" engagement API keeps `meetings`; the Scheduler one becomes
  // `scheduler-meetings`).
  const slugFor = new Map();
  const taken = new Set();
  for (const api of apis) {
    let slug = kebab(api.name);
    if (taken.has(slug)) slug = `${kebab(api.group)}-${slug}`;
    let i = 2;
    while (taken.has(slug)) slug = `${kebab(api.group)}-${kebab(api.name)}-${i++}`;
    taken.add(slug);
    slugFor.set(api, slug);
  }

  const jobs = [];
  for (const api of apis) {
    const picks = pickVersions(api);
    if (picks.length === 0) {
      console.warn(`⚠️  No usable version for "${api.name}" — skipped.`);
      continue;
    }
    for (const v of picks) {
      const baseSlug = slugFor.get(api);
      const slug = picks.length > 1 ? `${baseSlug}-v${kebab(v.version)}` : baseSlug;
      jobs.push({ api, version: v, slug, group: baseSlug });
    }
  }

  await mkdir(OUT_DIR, { recursive: true });

  const entries = [];
  let cursor = 0;
  async function worker() {
    for (;;) {
      const job = jobs[cursor++];
      if (!job) return;
      const { api, version, slug, group } = job;
      const doc = await fetchJson(version.openApi);
      const file = `${slug}.json`;
      await writeFile(resolve(OUT_DIR, file), JSON.stringify(doc), "utf8");
      const beta =
        version.stage === "DEVELOPER_PREVIEW" ||
        version.documentationBanner === "PUBLIC_BETA" ||
        /beta/i.test(version.version);
      entries.push({
        slug,
        group,
        file,
        name: api.name,
        area: api.group,
        version: version.version,
        stage: version.stage,
        beta,
        requirements: version.requirements ?? {},
        documentation: (version.relatedDocumentation ?? []).map((d) => d.url),
        operations: countOperations(doc),
        source: version.openApi,
      });
      console.log(
        `  ✓ ${api.group.padEnd(26)} ${api.name.padEnd(32)} v${version.version.padEnd(12)} → spec/${file} (${countOperations(doc)} ops${beta ? ", beta" : ""})`,
      );
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  entries.sort((a, b) => a.slug.localeCompare(b.slug));
  const catalog = {
    fetchedAt: new Date().toISOString(),
    indexUrl: INDEX_URL,
    apis: entries,
  };
  await writeFile(resolve(OUT_DIR, "catalog.json"), JSON.stringify(catalog, null, 2), "utf8");

  // Remove stale spec files from previous runs (renamed/vanished APIs).
  const keep = new Set([...entries.map((e) => e.file), "catalog.json"]);
  for (const existing of await readdir(OUT_DIR)) {
    if (existing.endsWith(".json") && !keep.has(existing)) {
      await unlink(resolve(OUT_DIR, existing));
      console.log(`  ✂ removed stale spec/${existing}`);
    }
  }

  const totalOps = entries.reduce((n, e) => n + e.operations, 0);
  console.log(`\nWrote ${entries.length} specs + catalog.json → ${OUT_DIR}`);
  console.log(`Total operations across all specs: ${totalOps}`);
}

main().catch((err) => {
  console.error("fetch-specs failed:", err);
  process.exit(1);
});
