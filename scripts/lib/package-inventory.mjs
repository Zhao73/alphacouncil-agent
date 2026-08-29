/** Evidence-first npm package inventory and runtime import-closure classification. */

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const PACKAGE_INVENTORY_CATEGORIES = Object.freeze([
  "runtime-required",
  "audit-surface-required",
  "build-only",
  "unknown",
]);

export const WP2_FORBIDDEN_PACKAGE_PATHS = Object.freeze([
  "mcp/lib/personas-v2/ablation.mjs",
  "mcp/lib/personas-v2/memory.mjs",
  "test/helpers/persona-v2-ablation.mjs",
  "test/helpers/persona-v2-memory.mjs",
]);

export const WP2_REQUIRED_PACKAGE_TREES = Object.freeze([
  Object.freeze({
    prefix: "knowledge/solo-test/masters/",
    reason: "default installed runtime selects the complete 26-seat solo-test pack root",
  }),
  Object.freeze({
    prefix: "knowledge/masters/",
    reason: "production PersonaPack root remains a runtime release surface",
  }),
  Object.freeze({
    prefix: "knowledge/ai-assisted-solo/reviews/",
    reason: "shipped method-lens skill and package parity promise the complete review capsule",
  }),
  Object.freeze({
    prefix: "knowledge/solo-test/persona-v3-solo-test-formulas/",
    reason: "installed portable selfcheck verifies the solo-test formula build inputs",
  }),
  Object.freeze({
    prefix: "knowledge/ai-assisted-solo/experiments/",
    reason: "installed portable selfcheck verifies the AI simulation evidence",
  }),
]);

const RUNTIME_DATA_FILES = new Set([
  "package.json",
  "data/build-profile.v1.json",
  "data/method-panel-calibration.v2.json",
  "data/industry-map.json",
  "data/social-handles.json",
  "schemas/headless-evidence-envelope-v1.schema.json",
  "schemas/timing-ledger-v1.schema.json",
  "schemas/runtime-evidence-packet-v1.schema.json",
  "schemas/runtime-headless-portfolio-manager-decision-v1.schema.json",
  "schemas/runtime-method-voice-v1.schema.json",
]);

const BUILD_ONLY_PERSONA_V3_MODULES = new Set([
  "mcp/lib/personas-v3/ai-source-pre-review.mjs",
  "mcp/lib/personas-v3/experiment-adjudication.mjs",
  "mcp/lib/personas-v3/ga-external-evidence.mjs",
  "mcp/lib/personas-v3/ga-gate.mjs",
  "mcp/lib/personas-v3/ga-package-evidence.mjs",
  "mcp/lib/personas-v3/n-eff.mjs",
  "mcp/lib/personas-v3/platform-durability.mjs",
  "mcp/lib/personas-v3/release-evidence.mjs",
  "mcp/lib/personas-v3/release-source-evidence.mjs",
  "mcp/lib/personas-v3/releases.mjs",
  "mcp/lib/personas-v3/semantic-source-adjudication.mjs",
  "mcp/lib/personas-v3/semantic-source-extraction.mjs",
  "mcp/lib/personas-v3/semantic-source-skeptic-review.mjs",
  "mcp/lib/personas-v3/source-acquisition.mjs",
  "mcp/lib/personas-v3/source-adjudication.mjs",
  "mcp/lib/personas-v3/source-review-operations.mjs",
  "mcp/lib/personas-v3/source-review-signing.mjs",
]);

const SOURCE_SCAN_ROOTS = Object.freeze(["mcp", "scripts", "test", "data"]);
const STATIC_IMPORT = /^\s*import\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']\s*;?/gmu;
const STATIC_EXPORT = /^\s*export\s+(?:\*|\{[^;]*\})\s+from\s+["']([^"']+)["']\s*;?/gmu;
const LITERAL_DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
const ANY_DYNAMIC_IMPORT = /\bimport\s*\(([^)]*)\)/gu;
const REQUIRE_CALL = /\b(?:createRequire|require)\s*\(([^)]*)\)/gu;

function normalizedPath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^package\//u, "").replace(/^\.\//u, "");
}

function inside(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function maskComments(source) {
  let out = "";
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "line") {
      if (char === "\n") { state = "code"; out += "\n"; } else out += " ";
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") { state = "code"; out += "  "; index += 1; }
      else out += char === "\n" ? "\n" : " ";
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      out += char;
      if (char === "\\" && next !== undefined) { out += next; index += 1; continue; }
      if ((state === "single" && char === "'")
        || (state === "double" && char === '"')
        || (state === "template" && char === "`")) state = "code";
      continue;
    }
    if (char === "/" && next === "/") { state = "line"; out += "  "; index += 1; continue; }
    if (char === "/" && next === "*") { state = "block"; out += "  "; index += 1; continue; }
    if (char === "'") state = "single";
    else if (char === '"') state = "double";
    else if (char === "`") state = "template";
    out += char;
  }
  return out;
}

function literalModuleSpecifiers(source) {
  const code = maskComments(source);
  return [...code.matchAll(STATIC_IMPORT), ...code.matchAll(STATIC_EXPORT), ...code.matchAll(LITERAL_DYNAMIC_IMPORT)]
    .map((match) => match[1]);
}

function dynamicEdges(source, from) {
  const code = maskComments(source);
  const literal = new Set([...code.matchAll(LITERAL_DYNAMIC_IMPORT)].map((match) => match[0]));
  const found = [];
  for (const match of code.matchAll(ANY_DYNAMIC_IMPORT)) {
    if (!literal.has(match[0])) found.push({ from, expression: match[1].trim(), kind: "dynamic-import" });
  }
  for (const match of code.matchAll(REQUIRE_CALL)) {
    found.push({ from, expression: match[1].trim(), kind: "require" });
  }
  return found;
}

function resolveLocalModule(repoRoot, from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.mjs`, `${base}.js`, join(base, "index.mjs")]) {
    if (!inside(repoRoot, candidate)) return null;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export function deriveStaticImportClosure(repoRoot, entry = "mcp/server.mjs") {
  const root = realpathSync(resolve(repoRoot));
  const entryFile = resolve(root, entry);
  if (!inside(root, entryFile) || !existsSync(entryFile) || !statSync(entryFile).isFile()) {
    throw new Error(`runtime entry is missing or unsafe: ${entry}`);
  }
  const seen = new Set();
  const unresolved = [];
  const dynamic = [];
  const external = new Set();
  const edges = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const from = normalizedPath(relative(root, file));
    const source = readFileSync(file, "utf8");
    dynamic.push(...dynamicEdges(source, from));
    for (const specifier of literalModuleSpecifiers(source)) {
      if (!specifier.startsWith(".")) { external.add(specifier); continue; }
      const target = resolveLocalModule(root, file, specifier);
      if (!target) { unresolved.push({ from, specifier }); continue; }
      const to = normalizedPath(relative(root, target));
      edges.push({ from, to, specifier });
      visit(target);
    }
  };
  visit(entryFile);
  return Object.freeze({
    entry: normalizedPath(relative(root, entryFile)),
    files: Object.freeze([...seen].map((file) => normalizedPath(relative(root, file))).sort()),
    edges: Object.freeze(edges.sort((left, right) => `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`))),
    external: Object.freeze([...external].sort()),
    unresolved: Object.freeze(unresolved),
    dynamic: Object.freeze(dynamic),
  });
}

function walkSourceFiles(root, directory, out = []) {
  if (!existsSync(directory)) return out;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkSourceFiles(root, file, out);
    else if (entry.isFile() && /\.(?:mjs|js)$/u.test(entry.name)) out.push(file);
  }
  return out;
}

function directImporters(repoRoot) {
  const root = realpathSync(resolve(repoRoot));
  const reverse = new Map();
  const sources = SOURCE_SCAN_ROOTS.flatMap((directory) => walkSourceFiles(root, join(root, directory)));
  for (const file of sources) {
    const from = normalizedPath(relative(root, file));
    for (const specifier of literalModuleSpecifiers(readFileSync(file, "utf8"))) {
      const target = resolveLocalModule(root, file, specifier);
      if (!target) continue;
      const to = normalizedPath(relative(root, target));
      if (!reverse.has(to)) reverse.set(to, new Set());
      reverse.get(to).add(from);
    }
  }
  return new Map([...reverse].map(([path, callers]) => [path, [...callers].sort()]));
}

function startsWithAny(path, prefixes) {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

function callerEvidence(path, importers) {
  const callers = importers.get(path) || [];
  return callers.length
    ? `direct static JS callers: ${callers.join(", ")}`
    : "zero static JS importers in mcp/scripts/test/data";
}

function classification(path, runtimeFiles, importers) {
  if (runtimeFiles.has(path)) {
    return { category: "runtime-required", evidence: "static import closure of mcp/server.mjs" };
  }
  if (RUNTIME_DATA_FILES.has(path)) {
    return { category: "runtime-required", evidence: "explicit filesystem read from the runtime closure" };
  }
  if (startsWithAny(path, ["personas/", "knowledge/solo-test/masters/", "knowledge/masters/", "knowledge/persona-releases/", "gui/", "tui/"])) {
    return { category: "runtime-required", evidence: "installed runtime data or package.json runtime entry surface" };
  }
  if (startsWithAny(path, [
    "knowledge/ai-assisted-solo/reviews/",
    "skills/",
    "commands/",
    ".claude/",
    ".claude-plugin/",
    ".codex-plugin/",
    ".grok/",
    ".opencode/",
    "docs/",
    "assets/",
    "test/fixtures/",
  ]) || [
    "AGENTS.md", "CLAUDE.md", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE",
    "PRODUCT.md", "README.md", "README.ja.md", "README.zh-CN.md", "SECURITY.md",
    "codex.mcp.json", "opencode.json", "server.json",
  ].includes(path) || path === "data/host-capabilities.v1.json") {
    return { category: "audit-surface-required", evidence: "shipped host, skill, documentation, fixture, or review contract" };
  }
  if (path.startsWith("scripts/")) {
    return {
      category: "build-only",
      evidence: `outside runtime closure; ${callerEvidence(path, importers)}; retained as a directly invocable shipped development/check surface`,
    };
  }
  if (path.startsWith("knowledge/solo-test/persona-v3-solo-test-formulas/")) {
    return {
      category: "build-only",
      evidence: `outside runtime closure; ${callerEvidence(path, importers)}; input to scripts/build-persona-v3-solo-test-packs.mjs and retained for installed selfcheck`,
    };
  }
  if (path.startsWith("knowledge/ai-assisted-solo/experiments/")) {
    return {
      category: "build-only",
      evidence: `outside runtime closure; ${callerEvidence(path, importers)}; input to scripts/run-persona-v3-ai-machine-simulations.mjs and retained for installed selfcheck`,
    };
  }
  if (path.startsWith("schemas/")) {
    return {
      category: "build-only",
      evidence: `outside runtime closure; ${callerEvidence(path, importers)}; schema-generation/check input outside the runtime-read schema set and retained for shipped checks`,
    };
  }
  if (BUILD_ONLY_PERSONA_V3_MODULES.has(path)) {
    return {
      category: "build-only",
      evidence: `outside runtime closure; ${callerEvidence(path, importers)}; retained for shipped build/check entry points`,
    };
  }
  return {
    category: "unknown",
    evidence: `outside the proven runtime/audit/build rules; ${callerEvidence(path, importers)}; non-JS consumers not disproven, so retained fail-closed`,
  };
}

function sourceTreeFiles(repoRoot, prefix) {
  const root = resolve(repoRoot, prefix);
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) out.push(normalizedPath(relative(repoRoot, file)));
    }
  };
  walk(root);
  return out.sort();
}

export function buildPackageInventoryReport(repoRoot, packMetadata) {
  const root = realpathSync(resolve(repoRoot));
  const files = Array.isArray(packMetadata?.files) ? packMetadata.files : [];
  if (!files.length) throw new Error("npm pack metadata contains no files");
  const paths = new Set(files.map((entry) => normalizedPath(entry.path)));
  if (paths.size !== files.length) throw new Error("npm pack metadata contains duplicate paths");
  const closure = deriveStaticImportClosure(root);
  const runtimeFiles = new Set(closure.files);
  const importers = directImporters(root);
  const entries = files.map((entry) => {
    const path = normalizedPath(entry.path);
    return Object.freeze({
      path,
      bytes: Number(entry.size || 0),
      ...classification(path, runtimeFiles, importers),
    });
  }).sort((left, right) => left.path.localeCompare(right.path));
  const issues = [];
  if (closure.unresolved.length) issues.push(`runtime closure has ${closure.unresolved.length} unresolved local imports`);
  if (closure.dynamic.length) issues.push(`runtime closure has ${closure.dynamic.length} non-literal dynamic/require edges`);
  for (const path of closure.files) if (!paths.has(path)) issues.push(`runtime closure file is absent from tarball: ${path}`);
  for (const path of WP2_FORBIDDEN_PACKAGE_PATHS) if (paths.has(path)) issues.push(`forbidden test-only path shipped: ${path}`);
  for (const tree of WP2_REQUIRED_PACKAGE_TREES) {
    const sourceFiles = sourceTreeFiles(root, tree.prefix);
    if (!sourceFiles.length) issues.push(`required source tree is empty: ${tree.prefix}`);
    for (const path of sourceFiles) if (!paths.has(path)) issues.push(`required package tree is incomplete: ${path}`);
  }
  const soloManifests = entries.filter((entry) => /^knowledge\/solo-test\/masters\/[^/]+\/manifest\.json$/u.test(entry.path));
  if (soloManifests.length !== 26) issues.push(`default solo-test runtime must contain 26 manifests; found ${soloManifests.length}`);
  const summary = Object.fromEntries(PACKAGE_INVENTORY_CATEGORIES.map((category) => {
    const selected = entries.filter((entry) => entry.category === category);
    return [category, Object.freeze({ files: selected.length, bytes: selected.reduce((sum, entry) => sum + entry.bytes, 0) })];
  }));
  return Object.freeze({
    schema_version: 1,
    artifact_kind: "alphacouncil_npm_package_inventory",
    evidence_scope: "source_static_closure_plus_npm_pack_inventory",
    package: Object.freeze({
      name: packMetadata.name || null,
      version: packMetadata.version || null,
      compressed_bytes: Number(packMetadata.size || 0),
      unpacked_bytes: Number(packMetadata.unpackedSize || 0),
      file_count: entries.length,
    }),
    runtime_closure: Object.freeze({
      entry: closure.entry,
      file_count: closure.files.length,
      files: closure.files,
      external_modules: closure.external,
      unresolved: closure.unresolved,
      non_literal_dynamic_or_require: closure.dynamic,
    }),
    required_trees: WP2_REQUIRED_PACKAGE_TREES,
    forbidden_paths: WP2_FORBIDDEN_PACKAGE_PATHS,
    classification_summary: Object.freeze(summary),
    issues: Object.freeze(issues),
    entries: Object.freeze(entries),
  });
}

export function assertPackageInventory(report) {
  if (!report || report.artifact_kind !== "alphacouncil_npm_package_inventory") {
    throw new Error("invalid package inventory report");
  }
  if (report.issues.length) throw new Error(`package inventory failed:\n- ${report.issues.join("\n- ")}`);
  return report;
}
