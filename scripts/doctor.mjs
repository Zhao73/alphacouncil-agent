#!/usr/bin/env node
/**
 * Report which copy of this plugin is actually running, and warn about the failure mode
 * that motivated it: a second, non-git install sitting on disk at an older version. Two
 * copies drifted by a whole minor release, and editing the wrong one silently loses work.
 *
 *   node scripts/doctor.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import os from "node:os";
import { DATA_DIR, VERSION } from "../mcp/lib/constants.mjs";
import { loadPersonas, defaultPersonaDir } from "../mcp/lib/personas/registry.mjs";
import {
  loadCompiledPersonaPacks,
  resolveRuntimePersonaBuildProfile,
} from "../mcp/lib/personas-v3/registry.mjs";
import { scanPersonaCorpusGaps } from "./report-persona-corpus-gaps.mjs";
import { auditHostAdapterFreshness, validateHostCapabilities } from "./lib/host-capabilities.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const problems = [];
const notes = [];

const ok = (label, detail) => console.log(`  ok    ${label}${detail ? `  ${detail}` : ""}`);
const warn = (label, detail) => { problems.push(`${label}: ${detail}`); console.log(`  WARN  ${label}  ${detail}`); };

console.log("alphacouncil-agent doctor\n");
console.log(`running from: ${ROOT}`);
console.log(`node:        ${process.version}`);
console.log(`version:     ${VERSION}`);
console.log(`data dir:    ${DATA_DIR}\n`);

// 1. Is the running copy under version control?
console.log("install");
if (existsSync(join(ROOT, ".git"))) ok("this copy is a git checkout");
else warn("this copy is NOT a git checkout", "edits here are not tracked and will be lost on reinstall");

// 2. Are there other copies on disk, and are they older?
const searchRoots = [
  join(os.homedir(), "plugins"),
  join(os.homedir(), ".claude", "plugins"),
  join(os.homedir(), ".agents", "plugins"),
  join(os.homedir(), ".codex", "plugins"),
];
const others = [];
for (const root of searchRoots) {
  if (!existsSync(root)) continue;
  let entries;
  try { entries = readdirSync(root); } catch { continue; }
  for (const entry of entries) {
    const candidate = join(root, entry);
    const pkg = join(candidate, "package.json");
    if (candidate === ROOT || !existsSync(pkg)) continue;
    try {
      const meta = JSON.parse(readFileSync(pkg, "utf8"));
      if (meta.name !== "alphacouncil-agent") continue;
      others.push({ path: candidate, version: meta.version, git: existsSync(join(candidate, ".git")) });
    } catch { /* not ours, or unreadable */ }
  }
}
if (others.length === 0) ok("no other copy of this plugin found on disk");
for (const other of others) {
  const detail = `version ${other.version}${other.git ? "" : ", no .git"}`;
  if (other.version !== VERSION || !other.git) {
    warn(`second copy at ${other.path}`, `${detail} -- edits made there are invisible here`);
  } else {
    notes.push(`another checkout at ${other.path} (${detail})`);
  }
}

// 3. Personas: the load-bearing data the server refuses to start without.
console.log("\npersonas");
const personaDir = defaultPersonaDir();
try {
  const reg = loadPersonas();
  ok(`${reg.all().length} personas load`, `${reg.ids("analyst").length} analysts, ${reg.ids("debate").length} debate, ${reg.ids("master").length} masters`);
  ok("persona dir", personaDir);
} catch (error) {
  warn("persona set fails to load", error.message.split("\n")[0]);
  console.log(`        the server will refuse every request until this is fixed`);
}

// 3b. Always report the formal corpus inventory. A solo-test build is allowed to ship
// provisional physical packs, but must never be mistaken for formal production admission.
console.log("\npersona v3");
try {
  const report = scanPersonaCorpusGaps();
  const levels = Object.entries(report.summary.levels).map(([level, count]) => `${level}=${count}`).join(", ");
  ok("corpus inventory", `${report.canonical_master_count} seats; ${levels}`);
  const buildProfile = resolveRuntimePersonaBuildProfile();
  ok("runtime build profile", buildProfile);
  if (buildProfile === "solo_test") {
    const registry = loadCompiledPersonaPacks({ buildProfile });
    const operatorCount = registry.packs.filter((pack) => pack.admission.level === "operator_lens").length;
    const toolCount = registry.packs.reduce((sum, pack) => sum + pack.components.tools.length, 0);
    const validSoloCut = registry.packs.length === 26
      && operatorCount === 26
      && toolCount === 52
      && registry.packs.every((pack) => pack.build_profile === "solo_test");
    if (validSoloCut) {
      ok("solo-test runtime", "26 physical provisional operator_lens; 52 derived-proxy tools; 0 method_model");
      notes.push("Formal PersonaPack v3 production GA is not passed; human source/formula review, signed experiments, and live four-host E2E remain absent");
    } else {
      warn("solo-test runtime incomplete", `${registry.packs.length}/26 packs, ${operatorCount}/26 operator_lens, ${toolCount}/52 tools`);
    }
  } else if (/^0\.9\./.test(VERSION) && report.summary.operational_or_higher !== 26) {
    warn("0.9 v3 cutover incomplete", `${report.summary.operational_or_higher}/26 seats operational or higher`);
  } else if (report.summary.operational_or_higher !== 26) {
    notes.push(`PersonaPack v3 migration remains in development: ${report.summary.operational_or_higher}/26 operational or higher`);
  }
} catch (error) {
  warn("PersonaPack v3 corpus inventory failed", error.message.split("\n")[0]);
}

// 4. Manifest paths that hosts resolve.
console.log("\nmanifests");
for (const [file, key] of [[".claude-plugin/plugin.json", "mcpServers"], [".codex-plugin/plugin.json", "mcpServers"], ["codex.mcp.json", null]]) {
  const path = join(ROOT, file);
  if (!existsSync(path)) { warn(`${file} missing`, "hosts will not find the server"); continue; }
  try {
    JSON.parse(readFileSync(path, "utf8"));
    ok(file);
  } catch (error) {
    warn(`${file} is not valid JSON`, error.message);
  }
}
const entry = join(ROOT, "mcp", "server.mjs");
if (existsSync(entry)) ok("mcp/server.mjs present", "manifests hardcode this path");
else warn("mcp/server.mjs missing", "every manifest points here");

// 5. Static host capability and command freshness. This proves shipped files agree; it does
// not claim that any external host executable was launched.
console.log("\nhost parity");
try {
  const capability = validateHostCapabilities();
  if (capability.valid) ok("static four-host contract", `${capability.selector_ids.length} canonical selector IDs; live E2E not run`);
  else warn("static four-host contract invalid", capability.errors[0]);

  const freshness = auditHostAdapterFreshness();
  for (const adapter of freshness.adapters) {
    if (adapter.status === "current") ok(`${adapter.host_id} /alpha adapter`, adapter.path);
    else warn(`${adapter.host_id} /alpha adapter ${adapter.status}`, `${adapter.path} differs from commands/alpha.md; run node scripts/sync-personas.mjs`);
  }
  if (freshness.codex_user_prompt.status === "current") {
    ok("Codex user /alpha prompt", freshness.codex_user_prompt.path);
  } else if (freshness.codex_user_prompt.status === "stale") {
    warn("Codex user /alpha prompt is stale", `replace ${freshness.codex_user_prompt.path} with commands/alpha.md`);
  } else {
    notes.push(`Codex user /alpha prompt not installed at ${freshness.codex_user_prompt.path}; copy commands/alpha.md there when using the Codex prompt surface`);
  }
  notes.push("Claude Code, Codex, OpenCode and Grok live host E2E status: not_run (static repository contract only)");
} catch (error) {
  warn("host parity audit failed", error.message.split("\n")[0]);
}

// 6. Leftover Codex output files, which older versions leaked one per analyst per run.
console.log("\ndata dir");
if (!existsSync(DATA_DIR)) {
  ok("data dir does not exist yet", "it is created on the first run");
} else {
  let leaked = 0;
  let bytes = 0;
  for (const name of readdirSync(DATA_DIR)) {
    if (!/^codex-\d+-[0-9a-f]+\.txt$/.test(name)) continue;
    leaked += 1;
    try { bytes += statSync(join(DATA_DIR, name)).size; } catch { /* raced */ }
  }
  if (leaked === 0) ok("no leaked codex output files");
  else warn(`${leaked} leaked codex output files`, `${(bytes / 1024).toFixed(0)} KB; the server sweeps files older than 24h at startup`);

  const runsDir = join(DATA_DIR, "runs");
  if (existsSync(runsDir)) ok(`${readdirSync(runsDir).length} saved runs`, runsDir);
}

console.log("");
for (const note of notes) console.log(`note: ${note}`);
if (problems.length === 0) {
  console.log("no problems found");
  process.exit(0);
}
console.log(`${problems.length} problem(s) found`);
process.exit(1);
