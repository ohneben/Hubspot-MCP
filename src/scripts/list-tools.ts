import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllSpecs } from "../openapi.js";
import { loadCatalog, formatRequirements } from "../specs.js";
import { operationsToTools, prettyGroup } from "../tools.js";
import { CATEGORIES, safetyBucket, type CategoryId } from "../categories.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findSpecDir(): string {
  if (process.env.HUBSPOT_SPEC_DIR) return resolve(process.env.HUBSPOT_SPEC_DIR);
  const bundled = resolve(__dirname, "..", "..", "spec");
  if (!existsSync(bundled)) throw new Error(`Spec directory not found at ${bundled}`);
  return bundled;
}

const specDir = findSpecDir();
const catalog = loadCatalog(specDir);
const operations = loadAllSpecs(specDir, catalog.apis, resolve);
const tools = operationsToTools(operations);

// The running server also exposes hubspot_get_capabilities, hubspot_graphql_query
// and hubspot_api_request; they are meta-tools, not spec endpoints, so the
// numbers here are the endpoint catalog.

const bucketCounts = { read: 0, write: 0, destructive: 0 };
const catCounts = new Map<CategoryId, number>();
const byGroup = new Map<string, { area: string; api: string; plan?: string; beta: boolean; read: number; write: number; destructive: number }>();

for (const t of tools) {
  const cat = (t.category ?? "create") as CategoryId;
  const bucket = safetyBucket(cat);
  bucketCounts[bucket]++;
  catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
  const op = t.operation!;
  const row =
    byGroup.get(op.group) ??
    {
      area: op.entry.area,
      api: op.entry.name,
      plan: formatRequirements(op.entry.requirements),
      beta: op.entry.beta,
      read: 0,
      write: 0,
      destructive: 0,
    };
  row[bucket]++;
  byGroup.set(op.group, row);
}

console.log(
  `HubSpot MCP — ${operations.length} operations across ${catalog.apis.length} bundled specs → ${tools.length} endpoint tools (specs fetched ${catalog.fetchedAt.slice(0, 10)}).\n`,
);
console.log(`🟢 Read-only:    ${bucketCounts.read}`);
console.log(`🟡 Write:        ${bucketCounts.write}`);
console.log(`🔴 Destructive:  ${bucketCounts.destructive}`);

console.log("\nBy category:");
for (const [id, meta] of Object.entries(CATEGORIES)) {
  const c = catCounts.get(id as CategoryId) ?? 0;
  if (c > 0) console.log(`  ${meta.banner.padEnd(40)} ${String(c).padStart(4)}`);
}

console.log("\nBy resource group (🟢 read / 🟡 write / 🔴 destructive) — group key in (parens):");
for (const [group, row] of [...byGroup.entries()].sort((a, b) => a[1].area.localeCompare(b[1].area) || a[0].localeCompare(b[0]))) {
  const flags = [row.beta ? "beta" : "", row.plan && !row.plan.startsWith("any") ? row.plan : ""].filter(Boolean).join(" · ");
  console.log(
    `  ${row.area.padEnd(14)} ${prettyGroup(group).padEnd(34)} ${String(row.read).padStart(3)}  ${String(row.write).padStart(3)}  ${String(row.destructive).padStart(3)}   (${group})${flags ? "  [" + flags + "]" : ""}`,
  );
}

if (process.argv.includes("--names")) {
  console.log("\nAll tool names:");
  for (const t of tools) {
    console.log(`  ${t.name.padEnd(64)} ${t.operation!.method.toUpperCase().padEnd(6)} ${t.operation!.path}`);
  }
}

// Sanity: names must be unique and MCP-legal.
const seen = new Set<string>();
const dups: string[] = [];
for (const t of tools) {
  if (!/^[a-z0-9_]+$/.test(t.name) || t.name.length > 64) console.warn(`⚠️  Illegal tool name: ${t.name}`);
  if (seen.has(t.name)) dups.push(t.name);
  seen.add(t.name);
}
console.log(dups.length ? `\n⚠️  Duplicate names: ${dups.join(", ")}` : "\nAll tool names unique ✓");
