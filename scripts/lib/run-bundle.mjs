import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { diagnoseCouncilRuns } from "../../mcp/lib/council-diagnostics.mjs";
import { RUNTIME_BUILD_IDENTITY } from "../../mcp/lib/constants.mjs";
import { jsonlEntryHash } from "../../mcp/lib/fsutil.mjs";
import { canonicalJson } from "../../mcp/lib/personas-v3/canonical.mjs";
import { CANONICAL_MASTER_IDS } from "../../mcp/lib/personas-v3/staging.mjs";

export const EVIDENCE_STANDARD_ID = "alphacouncil_evidence_standard_v1";
export const EVIDENCE_STANDARD_VERSION = 1;
export const RUN_BUNDLE_SCHEMA = "alphacouncil_run_bundle_v1";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
const MAX_BUNDLE_ENTRIES = 4_096;
const SIMILARITY_THRESHOLD = 0.5;
const WINDOWS_RENAME_DELAYS_MS = Object.freeze([1, 2, 4, 8, 16, 32, 64, 128]);
const WINDOWS_RENAME_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);
const renameSignal = new Int32Array(new SharedArrayBuffer(4));
const REQUIRED_VOICE_FIELDS = Object.freeze([
  "what_i_see",
  "how_my_method_reads_it",
  "would_i_act",
  "what_changes_my_mind",
  "where_i_disagree",
]);
const ALLOWED_STANCES = new Set(["constructive", "cautious", "opposed", "out_of_scope"]);
const ALLOWED_POSITION_INTENTS = new Set([
  "would_buy",
  "would_add",
  "would_hold",
  "would_watch",
  "would_pass",
  "would_avoid",
  "not_in_my_circle",
  "inputs_unavailable",
]);
const CORE_PAYLOAD_FILES = Object.freeze([
  "status.json",
  "evidence.json",
  "events.jsonl",
  "source_manifest.json",
  "company_dossier.json",
  "publication_manifest.json",
]);
const OPTIONAL_CORE_FILES = Object.freeze([
  "performance.json",
  "report_quality.json",
  "decision.json",
  "manager_synthesis.json",
  "final_report.md",
  "user_response.md",
  "artifact_index.md",
  "all_agents.md",
  "bull_researcher.json",
  "bull_researcher.md",
  "bear_researcher.json",
  "bear_researcher.md",
  "portfolio_manager.json",
  "portfolio_manager.md",
]);
const STOPWORDS = new Set([
  "and", "are", "but", "can", "company", "could", "does", "for", "from", "has", "have",
  "into", "its", "market", "method", "must", "not", "price", "return", "risk", "sell", "should",
  "stock", "that", "the", "their", "this", "through", "value", "with", "would", "buy",
]);

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readJson(path, label = path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function readJsonl(path, label = path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${label}:${index + 1} is not valid JSON: ${error.message}`);
      }
    });
}

function normalizeRelativePath(path) {
  if (typeof path !== "string" || !path.length || path.includes("\\") || path.includes("\0")) {
    throw new Error(`unsafe bundle path: ${String(path)}`);
  }
  if (path.startsWith("/") || /^[A-Za-z]:/u.test(path)) throw new Error(`absolute bundle path is forbidden: ${path}`);
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`traversal bundle path is forbidden: ${path}`);
  return parts.join("/");
}

function within(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

function bundlePath(root, relativePath) {
  const safe = normalizeRelativePath(relativePath);
  const path = resolve(root, ...safe.split("/"));
  if (!within(root, path)) throw new Error(`bundle path escapes root: ${relativePath}`);
  return path;
}

function assertPlainFile(root, relativePath) {
  const safe = normalizeRelativePath(relativePath);
  let current = resolve(root);
  for (const part of safe.split("/")) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`refusing symlinked run artifact: ${relativePath}`);
  }
  const stat = lstatSync(current);
  if (!stat.isFile()) throw new Error(`run artifact is not a regular file: ${relativePath}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`run artifact exceeds ${MAX_FILE_BYTES} bytes: ${relativePath}`);
  const realRoot = realpathSync(root);
  if (!within(realRoot, realpathSync(current))) throw new Error(`run artifact resolves outside run directory: ${relativePath}`);
  return stat;
}

function safeSourceRelative(runDir, sourcePath) {
  const absolute = isAbsolute(sourcePath) ? resolve(sourcePath) : resolve(runDir, sourcePath);
  if (!within(runDir, absolute)) throw new Error(`publication artifact is outside run directory: ${sourcePath}`);
  return normalizeRelativePath(relative(resolve(runDir), absolute).split(sep).join("/"));
}

function fileDigest(path) {
  const bytes = readFileSync(path);
  return { byte_length: bytes.length, sha256: sha256Bytes(bytes) };
}

function selectedMasters(status, evidence) {
  const values = status?.selected_masters || evidence?.masters || [];
  return [...new Set(Array.isArray(values) ? values.filter((item) => /^master_[a-z0-9_]+$/u.test(item)) : [])];
}

function selectedTasks(status, evidence) {
  const values = status?.selected_analysts || evidence?.tasks || [];
  return [...new Set(Array.isArray(values) ? values
    .map((item) => typeof item === "string" ? item : item?.task)
    .filter((item) => /^[a-z][a-z0-9_]*$/u.test(item)) : [])];
}

function normalizeSeatText(opinion) {
  const text = [
    opinion?.voice_statement,
    opinion?.summary,
    opinion?.position_intent,
    ...REQUIRED_VOICE_FIELDS.map((field) => opinion?.voice?.[field]),
    ...(Array.isArray(opinion?.key_findings) ? opinion.key_findings : []),
    ...(Array.isArray(opinion?.disagreements) ? opinion.disagreements : []),
    ...(Array.isArray(opinion?.what_would_change_my_mind) ? opinion.what_would_change_my_mind : []),
  ].filter(Boolean).join(" ");
  return text.normalize("NFKC")
    .toLowerCase()
    .replace(/master_[a-z0-9_]+/gu, " ")
    .replace(/sha256:[a-f0-9]{64}|\b[a-f0-9]{32,64}\b/gu, " ")
    .replace(/\b(?:src|source)[-_ ]?\d+\b/gu, " ")
    .replace(/\d+(?:\.\d+)?/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function trigrams(text) {
  const compact = text.replace(/\s+/gu, "");
  const result = new Set();
  for (let index = 0; index + 2 < compact.length; index += 1) result.add(compact.slice(index, index + 3));
  return result;
}

function jaccard(left, right) {
  if (!left.size && !right.size) return 1;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function outOfScopeReason(opinion) {
  return [
    opinion?.decision_reason,
    ...(Array.isArray(opinion?.disqualifiers_triggered) ? opinion.disqualifiers_triggered : []),
    ...(Array.isArray(opinion?.what_would_change_my_mind) ? opinion.what_would_change_my_mind : []),
    opinion?.voice?.how_my_method_reads_it,
    opinion?.voice?.what_changes_my_mind,
  ].filter(Boolean).join(" ").trim();
}

export function analyzeSeatContent(opinions, { similarityThreshold = SIMILARITY_THRESHOLD } = {}) {
  const seats = (Array.isArray(opinions) ? opinions : [])
    .filter((opinion) => typeof opinion?.master === "string")
    .map((opinion) => ({ opinion, master: opinion.master, text: normalizeSeatText(opinion) }))
    .sort((left, right) => compareText(left.master, right.master));
  const pairs = [];
  for (let left = 0; left < seats.length; left += 1) {
    const leftSet = trigrams(seats[left].text);
    for (let right = left + 1; right < seats.length; right += 1) {
      pairs.push({
        left: seats[left].master,
        right: seats[right].master,
        score: Number(jaccard(leftSet, trigrams(seats[right].text)).toFixed(6)),
      });
    }
  }
  pairs.sort((left, right) => right.score - left.score || compareText(left.left, right.left) || compareText(left.right, right.right));
  const duplicatePairs = pairs.filter((pair) => pair.score >= similarityThreshold);
  const lengths = seats.map((seat) => seat.text.replace(/\s+/gu, "").length);
  const lengthRange = lengths.length ? Math.max(...lengths) - Math.min(...lengths) : 0;
  const meanLength = lengths.length ? lengths.reduce((sum, value) => sum + value, 0) / lengths.length : 0;
  const distinctLengths = new Set(lengths).size;
  const lengthPassed = seats.length < 2
    ? false
    : distinctLengths >= 2 && lengthRange >= Math.max(12, Math.floor(meanLength * 0.05));
  const stances = Object.fromEntries([...ALLOWED_STANCES].map((stance) => [
    stance,
    seats.filter((seat) => seat.opinion.stance === stance).length,
  ]));
  const usedStances = Object.values(stances).filter((count) => count > 0).length;
  const outOfScopeFailures = seats
    .filter((seat) => seat.opinion.stance === "out_of_scope" && outOfScopeReason(seat.opinion).length < 24)
    .map((seat) => seat.master);
  return {
    contract_id: "alphacouncil_seat_content_diagnostics_v1",
    seat_count: seats.length,
    similarity: {
      status: seats.length >= 2 && duplicatePairs.length === 0 ? "passed" : "failed",
      threshold: similarityThreshold,
      pair_count: pairs.length,
      pairs_at_or_above_threshold: duplicatePairs.length,
      max_score: pairs[0]?.score ?? null,
      duplicate_pairs: duplicatePairs.slice(0, 100),
    },
    length_variance: {
      status: lengthPassed ? "passed" : "failed",
      required_range: Math.max(12, Math.floor(meanLength * 0.05)),
      distinct_length_count: distinctLengths,
      min_length: lengths.length ? Math.min(...lengths) : null,
      max_length: lengths.length ? Math.max(...lengths) : null,
      range: lengthRange,
    },
    stance_distribution: {
      status: seats.length >= 2 && usedStances >= 2 ? "passed" : "failed",
      counts: stances,
      note: usedStances < 2 ? "all recorded seats share one stance; repeated-case evidence is required to justify this" : null,
    },
    out_of_scope_reasons: {
      status: outOfScopeFailures.length ? "failed" : "passed",
      minimum_dense_reason_length: 24,
      missing_method_reason: outOfScopeFailures,
    },
  };
}

function packCorpus(manifest, packDir) {
  const values = [];
  const add = (value) => {
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === "object") Object.values(value).forEach(add);
  };
  add(manifest?.selection?.method);
  add(manifest?.selection?.best_for);
  add(manifest?.capability?.domains);
  add(manifest?.research?.mandatory_disconfirming_queries);
  for (const field of ["en", "zh"]) {
    const relativePath = manifest?.voice?.[field];
    if (typeof relativePath !== "string" || relativePath.includes("..") || relativePath.includes("/")) continue;
    const voicePath = join(packDir, relativePath);
    if (existsSync(voicePath) && lstatSync(voicePath).isFile()) values.push(readFileSync(voicePath, "utf8"));
  }
  return values.join(" ");
}

function markerTokens(text) {
  const tokens = String(text).normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/u)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
  return [...tokens, ...tokens.slice(0, -1).map((token, index) => `${token} ${tokens[index + 1]}`)];
}

export function derivedMarkerAdvisory(opinions, { packageRoot = PACKAGE_ROOT } = {}) {
  const root = join(packageRoot, "knowledge", "solo-test", "masters");
  const packs = [];
  for (const master of CANONICAL_MASTER_IDS) {
    const packDir = join(root, master);
    const manifestPath = join(packDir, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const tokens = markerTokens(packCorpus(readJson(manifestPath), packDir));
    packs.push({ master, tokens });
  }
  if (packs.length !== CANONICAL_MASTER_IDS.length) {
    return {
      status: "unavailable",
      note: "advisory; derived pack text is incomplete; not a reviewed vocabulary and not a gate",
      pack_count: packs.length,
      seats: [],
    };
  }
  const documentFrequency = new Map();
  for (const pack of packs) {
    for (const token of new Set(pack.tokens)) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
  }
  const markers = new Map();
  for (const pack of packs) {
    const tf = new Map();
    for (const token of pack.tokens) tf.set(token, (tf.get(token) || 0) + 1);
    const ranked = [...tf.entries()]
      .filter(([token]) => (documentFrequency.get(token) || 0) < 7)
      .map(([token, count]) => ({ token, score: count * Math.log(26 / documentFrequency.get(token)) }))
      .sort((left, right) => right.score - left.score || compareText(left.token, right.token))
      .slice(0, 12)
      .map((item) => item.token);
    markers.set(pack.master, ranked);
  }
  const byMaster = new Map((Array.isArray(opinions) ? opinions : []).map((opinion) => [opinion.master, opinion]));
  return {
    status: "advisory",
    note: "advisory; derived from pack-declared text, not a reviewed vocabulary; not a gate",
    rule: "NFKC lowercase 1/2-grams; <3 chars, fixed stoplist and terms in >=7/26 packs removed; tf*log(26/df), top 12",
    pack_count: packs.length,
    seats: CANONICAL_MASTER_IDS.filter((master) => byMaster.has(master)).map((master) => {
      const voiceTokens = new Set(markerTokens(normalizeSeatText(byMaster.get(master))));
      const seatMarkers = markers.get(master) || [];
      const hits = seatMarkers.filter((marker) => voiceTokens.has(marker));
      return { master, marker_count: seatMarkers.length, hit_count: hits.length, hits, markers: seatMarkers };
    }),
  };
}

function diagnosticsFor(evidence, opinions, missingMasters, missingTasks, options = {}) {
  return {
    schema: "alphacouncil_run_bundle_diagnostics_v1",
    schema_version: 1,
    standard_id: EVIDENCE_STANDARD_ID,
    run_id: evidence.run_id,
    generated_at: options.generatedAt || new Date().toISOString(),
    council_diagnostics: diagnoseCouncilRuns([evidence]),
    seat_content: analyzeSeatContent(opinions),
    derived_marker_hits: derivedMarkerAdvisory(opinions, options),
    failures: [
      ...missingMasters.map((master) => ({ seat_type: "method", master, status: "not_produced" })),
      ...missingTasks.map((task) => ({ seat_type: "analyst", task, status: "not_produced" })),
    ],
  };
}

function sourceFileSet(runDir, status, evidence, publication) {
  const files = new Set();
  for (const name of CORE_PAYLOAD_FILES) {
    if (!existsSync(join(runDir, name))) throw new Error(`required run artifact is missing: ${name}`);
    files.add(name);
  }
  for (const name of OPTIONAL_CORE_FILES) if (existsSync(join(runDir, name))) files.add(name);

  for (const [key, record] of Object.entries(publication?.artifacts || {})) {
    if (!record || typeof record.path !== "string") throw new Error(`publication artifact ${key} has no path`);
    const sourceRelative = safeSourceRelative(runDir, record.path);
    const sourcePath = join(runDir, ...sourceRelative.split("/"));
    assertPlainFile(runDir, sourceRelative);
    const actual = fileDigest(sourcePath);
    if (actual.byte_length !== record.byte_length || actual.sha256 !== record.sha256) {
      throw new Error(`publication artifact digest mismatch: ${key}`);
    }
    files.add(sourceRelative);
  }

  for (const task of selectedTasks(status, evidence)) {
    for (const suffix of [".json", ".md", ".failure.json"]) {
      const name = `${task}${suffix}`;
      if (existsSync(join(runDir, name))) files.add(name);
    }
  }
  for (const master of selectedMasters(status, evidence)) {
    for (const suffix of [".json", ".md", ".deterministic.json", ".output-schema.json", ".failure.json"]) {
      const name = `${master}${suffix}`;
      if (existsSync(join(runDir, name))) files.add(name);
    }
  }
  for (const name of files) normalizeRelativePath(name);
  return [...files].sort();
}

function portablePublicationManifest(publication, runDir) {
  return {
    schema: "alphacouncil_publication_manifest_portable_v1",
    schema_version: 1,
    source_schema: publication.schema,
    source_schema_version: publication.schema_version,
    source_manifest_sha256: sha256Bytes(readFileSync(join(runDir, "publication_manifest.json"))),
    run_id: publication.run_id,
    runtime_provenance: publication.runtime_provenance || null,
    status: publication.status,
    quality: publication.quality,
    published_at: publication.published_at,
    artifacts: Object.fromEntries(Object.entries(publication.artifacts || {}).map(([key, record]) => {
      const sourceRelative = safeSourceRelative(runDir, record.path);
      return [key, {
        path: `payload/${sourceRelative}`,
        byte_length: record.byte_length,
        sha256: record.sha256,
      }];
    })),
    note: "Portable projection: absolute source-machine paths were replaced by bundle-relative paths; source manifest bytes remain separately hash-bound.",
  };
}

function copyPayloadFile(runDir, relativePath, tempDir) {
  const stat = assertPlainFile(runDir, relativePath);
  const destination = bundlePath(tempDir, `payload/${relativePath}`);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(join(runDir, ...relativePath.split("/")), destination);
  chmodSync(destination, 0o600);
  return stat.size;
}

function cleanupTemp(tempDir, parent, prefix) {
  if (dirname(tempDir) !== parent || !tempDir.startsWith(join(parent, prefix))) return;
  rmSync(tempDir, { recursive: true, force: true });
}

function listBundleFiles(root) {
  const collected = [];
  const pending = [root];
  let entryCount = 0;
  while (pending.length) {
    const current = pending.pop();
    for (const name of readdirSync(current).sort().reverse()) {
      entryCount += 1;
      if (entryCount > MAX_BUNDLE_ENTRIES) throw new Error(`bundle exceeds ${MAX_BUNDLE_ENTRIES} filesystem entries`);
      const path = join(current, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`bundle contains a symlink: ${relative(root, path)}`);
      if (stat.isDirectory()) pending.push(path);
      else if (stat.isFile()) collected.push(relative(root, path).split(sep).join("/"));
      else throw new Error(`bundle contains a non-regular entry: ${relative(root, path)}`);
    }
  }
  return collected.sort();
}

function renameBundleDirectory(source, destination) {
  let attempt = 0;
  while (true) {
    if (existsSync(destination)) throw new Error(`output target already exists: ${destination}`);
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const delay = WINDOWS_RENAME_DELAYS_MS[attempt];
      if (process.platform !== "win32" || delay === undefined || !WINDOWS_RENAME_ERRORS.has(error.code)) throw error;
      attempt += 1;
      Atomics.wait(renameSignal, 0, 0, delay);
    }
  }
}

export function exportRunBundle({
  runDir,
  outputDir,
  packageRoot = PACKAGE_ROOT,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (typeof runDir !== "string" || typeof outputDir !== "string") {
    throw new Error("runDir and outputDir are required");
  }
  const sourceRoot = resolve(runDir);
  const destination = resolve(outputDir);
  if (!existsSync(sourceRoot)) throw new Error(`run directory does not exist: ${sourceRoot}`);
  const sourceStat = lstatSync(sourceRoot);
  if (sourceStat.isSymbolicLink()) throw new Error(`refusing symlinked run directory: ${sourceRoot}`);
  if (!sourceStat.isDirectory()) throw new Error(`runDir is not a directory: ${sourceRoot}`);
  if (existsSync(destination)) throw new Error(`output target already exists: ${destination}`);
  if (within(sourceRoot, destination)) throw new Error("output target cannot be inside the source run directory");

  for (const name of ["status.json", "evidence.json", "publication_manifest.json"]) assertPlainFile(sourceRoot, name);
  const status = readJson(join(sourceRoot, "status.json"), "status.json");
  const evidence = readJson(join(sourceRoot, "evidence.json"), "evidence.json");
  const publication = readJson(join(sourceRoot, "publication_manifest.json"), "publication_manifest.json");
  if (!status.run_id || status.run_id !== evidence.run_id || status.run_id !== publication.run_id) {
    throw new Error("run_id mismatch across status, evidence and publication manifest");
  }
  const files = sourceFileSet(sourceRoot, status, evidence, publication);
  const masters = selectedMasters(status, evidence);
  const opinions = masters
    .filter((master) => existsSync(join(sourceRoot, `${master}.json`)))
    .map((master) => readJson(join(sourceRoot, `${master}.json`), `${master}.json`));
  const presentMasters = new Set(opinions.map((opinion) => opinion.master));
  const missingMasters = masters.filter((master) => !presentMasters.has(master));
  const tasks = selectedTasks(status, evidence);
  const missingTasks = tasks.filter((task) => !existsSync(join(sourceRoot, `${task}.json`)));
  const diagnostics = diagnosticsFor(evidence, opinions, missingMasters, missingTasks, { packageRoot, generatedAt });
  const portablePublication = portablePublicationManifest(publication, sourceRoot);

  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const prefix = `.${destination.split(sep).at(-1)}.run-bundle.`;
  const tempDir = join(parent, `${prefix}${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  mkdirSync(tempDir, { mode: 0o700 });
  let renamed = false;
  try {
    let totalBytes = 0;
    for (const relativePath of files) {
      totalBytes += copyPayloadFile(sourceRoot, relativePath, tempDir);
      if (totalBytes > MAX_BUNDLE_BYTES) throw new Error(`run bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
    }
    const generated = [
      ["payload/council_diagnostics.json", diagnostics],
      ["payload/publication_manifest.portable.json", portablePublication],
    ];
    for (const [relativePath, value] of generated) {
      const path = bundlePath(tempDir, relativePath);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, stableJson(value), { mode: 0o600, flag: "wx" });
      totalBytes += statSync(path).size;
    }
    if (totalBytes > MAX_BUNDLE_BYTES) throw new Error(`run bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);

    const payloadFiles = [...files.map((name) => `payload/${name}`), ...generated.map(([name]) => name)]
      .sort()
      .map((relativePath) => ({ path: relativePath, ...fileDigest(bundlePath(tempDir, relativePath)) }));
    const toolIdentity = { ...RUNTIME_BUILD_IDENTITY };
    const manifest = {
      schema: RUN_BUNDLE_SCHEMA,
      schema_version: 1,
      created_at: generatedAt,
      verification_contract: {
        standard_id: EVIDENCE_STANDARD_ID,
        standard_version: EVIDENCE_STANDARD_VERSION,
        exporter: { name: "export-run-bundle", runtime_build_identity: toolIdentity },
        verifier: { name: "verify-run-bundle", runtime_build_identity: toolIdentity },
      },
      source_run: {
        run_id: evidence.run_id,
        symbol: evidence.symbol || status.symbol || null,
        status: evidence.status || status.status || null,
        started_at: evidence.started_at || status.started_at || null,
        completed_at: evidence.completed_at || status.completed_at || null,
        runtime_provenance: evidence.runtime_provenance || status.runtime_provenance || null,
        publication_manifest_sha256: portablePublication.source_manifest_sha256,
      },
      integrity_notice: "Payload hashes detect bundle modification; this bundle is not signed and does not prove author identity or source authenticity.",
      files: payloadFiles,
      total_payload_bytes: payloadFiles.reduce((sum, item) => sum + item.byte_length, 0),
    };
    writeFileSync(join(tempDir, "bundle-manifest.json"), stableJson(manifest), { mode: 0o600, flag: "wx" });
    renameBundleDirectory(tempDir, destination);
    renamed = true;
    return { bundle_dir: destination, manifest };
  } finally {
    if (!renamed) cleanupTemp(tempDir, parent, prefix);
  }
}

function issue(code, message, details) {
  return { code, message, ...(details === undefined ? {} : { details }) };
}

function pushUnique(list, value) {
  if (!list.some((item) => item.code === value.code && item.message === value.message)) list.push(value);
}

function safeJsonFromBundle(bundleDir, relativePath, errors) {
  try {
    const path = bundlePath(bundleDir, relativePath);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("symlink is forbidden");
    if (!stat.isFile()) throw new Error("not a regular file");
    return readJson(path, relativePath);
  } catch (error) {
    pushUnique(errors, issue("payload_json_invalid", `${relativePath}: ${error.message}`));
    return null;
  }
}

function verifyEventChain(events, errors) {
  let previousHash = null;
  let previousTime = -Infinity;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.seq !== index + 1) pushUnique(errors, issue("event_sequence_invalid", `events.jsonl line ${index + 1} has seq ${String(event.seq)}`));
    if (event.prev_hash !== previousHash) pushUnique(errors, issue("event_previous_hash_invalid", `events.jsonl line ${index + 1} has an invalid prev_hash`));
    const expectedHash = jsonlEntryHash(event);
    if (event.event_hash !== expectedHash) pushUnique(errors, issue("event_hash_invalid", `events.jsonl line ${index + 1} hash mismatch`));
    const timestamp = Date.parse(event.at);
    if (!Number.isFinite(timestamp)) pushUnique(errors, issue("event_timestamp_invalid", `events.jsonl line ${index + 1} has an invalid timestamp`));
    else if (timestamp < previousTime) pushUnique(errors, issue("event_timestamp_not_monotonic", `events.jsonl line ${index + 1} moves backwards in time`));
    else previousTime = timestamp;
    previousHash = event.event_hash;
  }
}

function lifecycleBlockers(events, masters) {
  const blockers = [];
  const intervals = new Map();
  for (const master of masters) {
    const started = events.find((event) => event.type === "master_running" && event.master === master && event.started_at);
    const completed = events.find((event) => event.type === "master_completed" && event.master === master && event.completed_at);
    if (!started || !completed) {
      blockers.push(issue("seat_event_interval_missing", `${master} has no independent running/completed event interval`));
      continue;
    }
    const start = Date.parse(started.started_at);
    const finish = Date.parse(completed.completed_at);
    if (!Number.isFinite(start) || !Number.isFinite(finish) || finish <= start) {
      blockers.push(issue("seat_event_interval_not_discrete", `${master} has a non-positive or invalid wall-clock interval`));
      continue;
    }
    const signature = `${started.started_at}\0${completed.completed_at}`;
    const previousMaster = intervals.get(signature);
    if (previousMaster) blockers.push(issue(
      "seat_event_intervals_not_independent",
      `${master} and ${previousMaster} share the exact same start/finish interval`,
    ));
    else intervals.set(signature, master);
  }
  return blockers;
}

function sourceIdsFromManifest(sourceManifest) {
  const ids = new Set();
  for (const source of Array.isArray(sourceManifest?.sources) ? sourceManifest.sources : []) {
    if (typeof source?.id === "string") ids.add(source.id);
    if (typeof source?.source_id === "string") ids.add(source.source_id);
  }
  return ids;
}

function dossierPacketHash(packet) {
  const normalized = JSON.parse(JSON.stringify(packet || {}));
  delete normalized.raw_text;
  return `sha256:${sha256Bytes(Buffer.from(canonicalJson(normalized), "utf8"))}`;
}

function dossierContentHash(dossier) {
  const content = JSON.parse(JSON.stringify(dossier || {}));
  delete content.content_hash;
  return `sha256:${sha256Bytes(Buffer.from(canonicalJson(content), "utf8"))}`;
}

function seatContractProblems(opinion, master, tasks, dossier, sourceIds) {
  const problems = [];
  const requireValue = (condition, message) => { if (!condition) problems.push(message); };
  requireValue(opinion?.master === master, "master identity mismatch");
  requireValue(ALLOWED_STANCES.has(opinion?.stance), "invalid frozen stance");
  requireValue(opinion?.acknowledged_stance !== undefined, "acknowledged_stance missing from persisted artifact");
  requireValue(opinion?.acknowledged_stance === opinion?.stance, "acknowledged_stance does not equal stance");
  if (typeof opinion?.deterministic_stance === "string") {
    requireValue(opinion.acknowledged_stance === opinion.deterministic_stance, "acknowledged_stance does not equal deterministic_stance");
  }
  requireValue(opinion?.voice_status === "completed", "voice_status is not completed");
  requireValue(["dedicated_method_voice_worker", "visible_method_voice_worker"].includes(opinion?.statement_origin), "statement_origin is not a dedicated method voice worker");
  requireValue(opinion?.dedicated_worker?.status === "completed", "dedicated worker is not completed");
  requireValue(!["dry_run", "fallback"].includes(opinion?.dedicated_worker?.execution_mode), "dedicated worker used a dry or fallback transport");
  requireValue(opinion?.voice_mode === "first_person_public_method_simulation_v1", "voice_mode contract mismatch");
  requireValue(opinion?.disclosure_ack === "alphacouncil.first_person_public_method_simulation.v1", "disclosure contract mismatch");
  requireValue(ALLOWED_POSITION_INTENTS.has(opinion?.position_intent), "position_intent contract mismatch");
  requireValue(opinion?.voice && typeof opinion.voice === "object", "voice object missing");
  for (const field of REQUIRED_VOICE_FIELDS) requireValue(typeof opinion?.voice?.[field] === "string" && /\S/u.test(opinion.voice[field]), `voice.${field} missing`);
  for (const field of ["key_findings", "disagreements", "what_would_change_my_mind", "source_ids"]) {
    requireValue(Array.isArray(opinion?.[field]), `${field} must be an array`);
  }
  requireValue(["high", "medium", "low"].includes(opinion?.confidence), "confidence contract mismatch");
  if (opinion?.stance !== "out_of_scope") requireValue((opinion?.source_ids || []).length > 0, "directional stance has no source_ids");
  for (const sourceId of opinion?.source_ids || []) requireValue(sourceIds.has(sourceId), `source_id is absent from source_manifest: ${sourceId}`);
  requireValue(opinion?.company_dossier_hash_ack === dossier?.content_hash, "company dossier hash ack mismatch");
  const packetManifest = new Map((Array.isArray(dossier?.packet_manifest) ? dossier.packet_manifest : []).map((item) => [item.task, item.packet_hash]));
  const acknowledgements = new Map((Array.isArray(opinion?.evidence_packet_acks) ? opinion.evidence_packet_acks : []).map((item) => [item.task, item]));
  requireValue(acknowledgements.size === tasks.length, "evidence packet acknowledgement count mismatch");
  for (const task of tasks) {
    const acknowledgement = acknowledgements.get(task);
    requireValue(Boolean(acknowledgement), `evidence packet acknowledgement missing: ${task}`);
    if (acknowledgement) requireValue(acknowledgement.packet_hash === packetManifest.get(task), `evidence packet hash mismatch: ${task}`);
  }
  return problems;
}

function contentBlockers(content) {
  const blockers = [];
  if (content?.similarity?.status !== "passed") blockers.push(issue(
    "anti_template_similarity_failed",
    `${content?.similarity?.pairs_at_or_above_threshold ?? "unknown"} seat pair(s) meet or exceed the ${SIMILARITY_THRESHOLD} trigram Jaccard limit`,
  ));
  if (content?.length_variance?.status !== "passed") blockers.push(issue("anti_template_length_variance_failed", "seat text lengths are degenerate"));
  if (content?.stance_distribution?.status !== "passed") blockers.push(issue("stance_distribution_unsubstantiated", "all seats share one stance without repeated-case support"));
  if (content?.out_of_scope_reasons?.status !== "passed") blockers.push(issue(
    "out_of_scope_reason_missing",
    "one or more out-of-scope seats lack a method-specific reason",
    content?.out_of_scope_reasons?.missing_method_reason,
  ));
  return blockers;
}

function gitOutput(args, packageRoot) {
  return execFileSync("git", args, {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function taggedCriticalSourceHash(tag, files, packageRoot) {
  const hash = createHash("sha256");
  for (const path of files) {
    const bytes = execFileSync("git", ["show", `${tag}:${path}`], {
      cwd: packageRoot,
      encoding: null,
      stdio: ["ignore", "pipe", "ignore"],
    });
    hash.update(path);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function releaseBlockers(runtime, startedAt, packageRoot) {
  const blockers = [];
  if (!runtime || typeof runtime !== "object") return [issue("runtime_provenance_missing", "run has no runtime build identity")];
  if (runtime.contract_id !== "alphacouncil_runtime_build_v1") blockers.push(issue("runtime_provenance_contract_invalid", "runtime provenance contract is not alphacouncil_runtime_build_v1"));
  if (runtime.package_version !== "1.5.0") blockers.push(issue("release_version_not_v1_5_0", `run package version is ${String(runtime.package_version)}, not 1.5.0`));
  if (runtime.git_tracked_tree_dirty !== false) blockers.push(issue("runtime_tree_not_clean", "run was not produced from a recorded clean tracked tree"));
  if (!/^[a-f0-9]{40}$/u.test(runtime.git_commit || "")) blockers.push(issue("runtime_commit_missing", "run has no exact 40-character git commit"));
  if (!/^[a-f0-9]{64}$/u.test(runtime.critical_source_sha256 || "")) blockers.push(issue("runtime_source_hash_missing", "run has no critical source hash"));
  const criticalFiles = Array.isArray(runtime.critical_source_files)
    ? runtime.critical_source_files.filter((path) => {
      try {
        normalizeRelativePath(path);
        return true;
      } catch {
        return false;
      }
    })
    : [];
  if (!criticalFiles.length || criticalFiles.length !== runtime.critical_source_files?.length || criticalFiles.length > 128) {
    blockers.push(issue("runtime_source_file_inventory_invalid", "runtime critical source file inventory is missing or unsafe"));
  }

  const tag = `v${runtime.package_version || "1.5.0"}`;
  try {
    const tagCommit = gitOutput(["rev-parse", `${tag}^{commit}`], packageRoot);
    if (runtime.git_commit !== tagCommit) blockers.push(issue("runtime_commit_not_release_tag", `runtime commit does not equal ${tag}`));
    const taggedHash = taggedCriticalSourceHash(tag, criticalFiles, packageRoot);
    if (runtime.critical_source_sha256 !== taggedHash) blockers.push(issue("runtime_source_hash_not_release_tag", `runtime critical source hash does not equal ${tag} tree`));
    const commitTime = Date.parse(gitOutput(["show", "-s", "--format=%cI", tagCommit], packageRoot));
    const runTime = Date.parse(startedAt);
    if (!Number.isFinite(runTime) || !Number.isFinite(commitTime) || runTime < commitTime) {
      blockers.push(issue("run_predates_release_commit", `run start time is not on or after ${tag} commit time`));
    }
  } catch {
    blockers.push(issue("release_tag_missing", `${tag} cannot be verified in the local repository`));
  }
  return blockers;
}

function verifyPortablePublication(bundleDir, portable, errors) {
  if (portable?.schema !== "alphacouncil_publication_manifest_portable_v1") {
    pushUnique(errors, issue("portable_publication_manifest_invalid", "portable publication manifest schema mismatch"));
    return;
  }
  for (const [key, record] of Object.entries(portable.artifacts || {})) {
    try {
      const path = bundlePath(bundleDir, record.path);
      const actual = fileDigest(path);
      if (actual.byte_length !== record.byte_length || actual.sha256 !== record.sha256) {
        pushUnique(errors, issue("published_artifact_digest_mismatch", `published artifact ${key} does not match its source commit marker`));
      }
    } catch (error) {
      pushUnique(errors, issue("published_artifact_missing", `${key}: ${error.message}`));
    }
  }
}

export function verifyRunBundle({ bundleDir, packageRoot = PACKAGE_ROOT } = {}) {
  const root = resolve(bundleDir || "");
  const errors = [];
  const blockers = [];
  const notEvaluable = [];
  let manifest = null;
  if (!bundleDir || !existsSync(root)) {
    pushUnique(errors, issue("bundle_missing", `bundle directory does not exist: ${root}`));
  } else {
    try {
      const rootStat = lstatSync(root);
      if (rootStat.isSymbolicLink()) throw new Error("bundle root is a symlink");
      if (!rootStat.isDirectory()) throw new Error("bundle root is not a directory");
      const manifestPath = join(root, "bundle-manifest.json");
      const manifestStat = lstatSync(manifestPath);
      if (manifestStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.size > MAX_FILE_BYTES) throw new Error("bundle manifest is not a bounded regular file");
      manifest = readJson(manifestPath, "bundle-manifest.json");
    } catch (error) {
      pushUnique(errors, issue("bundle_manifest_invalid", error.message));
    }
  }

  if (manifest) {
    if (manifest.schema !== RUN_BUNDLE_SCHEMA || manifest.schema_version !== 1) {
      pushUnique(errors, issue("bundle_schema_invalid", "bundle manifest schema/version mismatch"));
    }
    if (manifest.verification_contract?.standard_id !== EVIDENCE_STANDARD_ID
      || manifest.verification_contract?.standard_version !== EVIDENCE_STANDARD_VERSION) {
      pushUnique(errors, issue("evidence_standard_anchor_invalid", "bundle does not identify the required five-item evidence standard"));
    }
    for (const tool of ["exporter", "verifier"]) {
      const anchor = manifest.verification_contract?.[tool]?.runtime_build_identity;
      if (!anchor || typeof anchor.package_version !== "string" || !/^[a-f0-9]{64}$/u.test(anchor.critical_source_sha256 || "")) {
        pushUnique(errors, issue("tool_build_anchor_invalid", `${tool} runtime build identity is missing or invalid`));
      }
    }
    const seen = new Set();
    let total = 0;
    const inventory = Array.isArray(manifest.files) ? manifest.files : [];
    if (inventory.length > MAX_BUNDLE_ENTRIES) pushUnique(errors, issue("payload_inventory_too_large", `bundle manifest exceeds ${MAX_BUNDLE_ENTRIES} entries`));
    for (const record of inventory.slice(0, MAX_BUNDLE_ENTRIES)) {
      try {
        const safe = normalizeRelativePath(record.path);
        if (seen.has(safe)) throw new Error("duplicate manifest path");
        seen.add(safe);
        const path = bundlePath(root, safe);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error("symlink is forbidden");
        if (!stat.isFile()) throw new Error("not a regular file");
        if (stat.size > MAX_FILE_BYTES) throw new Error("file exceeds size limit");
        const actual = fileDigest(path);
        total += actual.byte_length;
        if (actual.byte_length !== record.byte_length || actual.sha256 !== record.sha256) {
          pushUnique(errors, issue("payload_digest_mismatch", `${safe} does not match bundle-manifest.json`));
        }
        if (safe.endsWith(".json")) readJson(path, safe);
        else if (safe.endsWith(".jsonl")) readJsonl(path, safe);
      } catch (error) {
        pushUnique(errors, issue("payload_path_invalid", `${String(record?.path)}: ${error.message}`));
      }
    }
    if (!inventory.length) pushUnique(errors, issue("payload_inventory_missing", "bundle manifest has no payload inventory"));
    if (total > MAX_BUNDLE_BYTES || total !== manifest.total_payload_bytes) pushUnique(errors, issue("payload_size_invalid", "payload byte total is invalid"));
    for (const relativePath of CORE_PAYLOAD_FILES.map((name) => `payload/${name}`)) {
      if (!seen.has(relativePath)) pushUnique(errors, issue("required_payload_missing", `${relativePath} is absent from the payload inventory`));
    }
    for (const relativePath of ["payload/council_diagnostics.json", "payload/publication_manifest.portable.json"]) {
      if (!seen.has(relativePath)) pushUnique(errors, issue("required_payload_missing", `${relativePath} is absent from the payload inventory`));
    }
    try {
      const actualFiles = listBundleFiles(root).filter((path) => path !== "bundle-manifest.json");
      const extras = actualFiles.filter((path) => !seen.has(path));
      const missing = [...seen].filter((path) => !actualFiles.includes(path));
      if (extras.length || missing.length) pushUnique(errors, issue(
        "payload_inventory_mismatch",
        "filesystem payload does not exactly match the manifest inventory",
        { extras, missing },
      ));
    } catch (error) {
      pushUnique(errors, issue("payload_inventory_invalid", error.message));
    }
  }

  const status = errors.length ? null : safeJsonFromBundle(root, "payload/status.json", errors);
  const evidence = errors.length ? null : safeJsonFromBundle(root, "payload/evidence.json", errors);
  const sourceManifest = errors.length ? null : safeJsonFromBundle(root, "payload/source_manifest.json", errors);
  const dossier = errors.length ? null : safeJsonFromBundle(root, "payload/company_dossier.json", errors);
  const publication = errors.length ? null : safeJsonFromBundle(root, "payload/publication_manifest.json", errors);
  const portable = errors.length ? null : safeJsonFromBundle(root, "payload/publication_manifest.portable.json", errors);
  const diagnostics = errors.length ? null : safeJsonFromBundle(root, "payload/council_diagnostics.json", errors);
  let events = [];
  if (!errors.length) {
    try {
      events = readJsonl(bundlePath(root, "payload/events.jsonl"), "payload/events.jsonl");
      verifyEventChain(events, errors);
    } catch (error) {
      pushUnique(errors, issue("events_jsonl_invalid", error.message));
    }
  }

  if (!errors.length) {
    const runId = manifest.source_run?.run_id;
    for (const [label, value] of [["status", status], ["evidence", evidence], ["source_manifest", sourceManifest], ["company_dossier", dossier], ["publication_manifest", publication], ["council_diagnostics", diagnostics]]) {
      if (value?.run_id !== runId) pushUnique(errors, issue("run_identity_mismatch", `${label}.run_id does not equal bundle source_run.run_id`));
    }
    if (status.status !== evidence.status || publication.status !== evidence.status) pushUnique(errors, issue("run_status_mismatch", "terminal status differs across persisted artifacts"));
    const statusMasters = status.selected_masters;
    const evidenceMasters = evidence.masters;
    if (!Array.isArray(statusMasters) || !Array.isArray(evidenceMasters)
      || statusMasters.some((id) => !/^master_[a-z0-9_]+$/u.test(id))
      || new Set(statusMasters).size !== statusMasters.length
      || JSON.stringify(statusMasters) !== JSON.stringify(evidenceMasters)) {
      pushUnique(errors, issue("selected_master_inventory_mismatch", "status and evidence do not carry the same valid ordered method-seat inventory"));
    }
    const statusTasks = (Array.isArray(status.selected_analysts) ? status.selected_analysts : []).map((item) => typeof item === "string" ? item : item?.task);
    const evidenceTasks = Array.isArray(evidence.tasks) ? evidence.tasks : [];
    if (!statusTasks.length || statusTasks.some((id) => !/^[a-z][a-z0-9_]*$/u.test(id))
      || new Set(statusTasks).size !== statusTasks.length
      || JSON.stringify(statusTasks) !== JSON.stringify(evidenceTasks)) {
      pushUnique(errors, issue("selected_analyst_inventory_mismatch", "status and evidence do not carry the same valid ordered analyst inventory"));
    }
    if (canonicalJson(publication.runtime_provenance || null) !== canonicalJson(evidence.runtime_provenance || null)
      || canonicalJson(manifest.source_run?.runtime_provenance || null) !== canonicalJson(evidence.runtime_provenance || null)) {
      pushUnique(errors, issue("runtime_provenance_mismatch", "runtime provenance differs across bundle, evidence and publication manifest"));
    }
    if (sourceManifest.source_count !== sourceManifest.sources?.length) pushUnique(errors, issue("source_manifest_count_mismatch", "source_manifest.source_count does not equal its source inventory"));
    const externalSourceIds = sourceIdsFromManifest(sourceManifest);
    for (const sourceId of sourceIdsFromManifest(dossier.source_manifest)) {
      if (!externalSourceIds.has(sourceId)) pushUnique(errors, issue("dossier_source_manifest_mismatch", `company dossier source ${sourceId} is absent from source_manifest.json`));
    }
    if (sha256Bytes(readFileSync(bundlePath(root, "payload/publication_manifest.json"))) !== manifest.source_run?.publication_manifest_sha256) {
      pushUnique(errors, issue("publication_manifest_source_hash_mismatch", "source publication manifest hash does not match bundle anchor"));
    }
    verifyPortablePublication(root, portable, errors);
    try {
      const recomputed = diagnoseCouncilRuns([evidence]);
      if (diagnostics?.council_diagnostics?.diagnostics_hash !== recomputed.diagnostics_hash) {
        pushUnique(errors, issue("council_diagnostics_mismatch", "attached council diagnostics do not match evidence.json"));
      }
    } catch (error) {
      pushUnique(errors, issue("council_diagnostics_invalid", error.message));
    }
  }

  if (errors.length) {
    blockers.push(issue("structure_failed", "claim readiness cannot be evaluated because structure failed"));
  } else {
    const masters = selectedMasters(status, evidence);
    const tasks = selectedTasks(status, evidence);
    const sourceIds = sourceIdsFromManifest(sourceManifest);
    if (Array.isArray(sourceManifest.missing_claim_source_ids) && sourceManifest.missing_claim_source_ids.length) {
      blockers.push(issue("claim_source_ids_unresolved", "source_manifest records unresolved claim source IDs", sourceManifest.missing_claim_source_ids));
    }
    const taskStates = new Map((Array.isArray(status.tasks) ? status.tasks : []).map((item) => [item.task, item]));
    for (const task of tasks) {
      if (taskStates.size && taskStates.get(task)?.status !== "completed") blockers.push(issue("analyst_status_not_completed", `${task} status is not completed`));
    }
    const masterStates = new Map((Array.isArray(status.masters) ? status.masters : []).map((item) => [item.master, item]));
    for (const master of masters) {
      if (masterStates.size && (masterStates.get(master)?.status !== "completed" || masterStates.get(master)?.voice_status !== "completed")) {
        blockers.push(issue("method_status_not_completed", `${master} status/voice_status is not completed`));
      }
    }
    if (dossier?.content_hash !== dossierContentHash(dossier)) {
      pushUnique(errors, issue("company_dossier_hash_mismatch", "company_dossier.json content_hash cannot be reproduced"));
    }
    const dossierPackets = new Map((Array.isArray(dossier?.packet_manifest) ? dossier.packet_manifest : []).map((item) => [item.task, item.packet_hash]));
    for (const task of tasks) {
      const path = `payload/${task}.json`;
      if (!existsSync(bundlePath(root, path))) {
        blockers.push(issue("analyst_not_produced", `${task} has no persisted analyst packet`));
        continue;
      }
      const packet = safeJsonFromBundle(root, path, errors);
      if (!packet) continue;
      if (packet.task !== task) pushUnique(errors, issue("analyst_packet_identity_mismatch", `${task}.json records task ${String(packet.task)}`));
      if (dossierPackets.get(task) !== dossierPacketHash(packet)) {
        pushUnique(errors, issue("analyst_packet_hash_mismatch", `${task}.json does not match company_dossier.packet_manifest`));
      }
      for (const source of Array.isArray(packet.sources) ? packet.sources : []) {
        const scoped = typeof source?.id === "string" && source.id.includes(":") ? source.id : `${task}:${String(source?.id || "")}`;
        if (!sourceIds.has(scoped)) pushUnique(errors, issue("analyst_source_manifest_mismatch", `${task}.json source ${scoped} is absent from source_manifest.json`));
      }
    }
    const opinions = [];
    for (const master of masters) {
      const path = `payload/${master}.json`;
      if (!existsSync(bundlePath(root, path))) {
        blockers.push(issue("seat_not_produced", `${master} has no persisted method-seat artifact`));
        continue;
      }
      const opinion = safeJsonFromBundle(root, path, errors);
      if (!opinion) continue;
      opinions.push(opinion);
      const evidenceOpinion = (Array.isArray(evidence.master_opinions) ? evidence.master_opinions : []).find((item) => item?.master === master);
      if (canonicalJson(evidenceOpinion || null) !== canonicalJson(opinion)) {
        pushUnique(errors, issue("method_artifact_evidence_mismatch", `${master}.json does not equal the evidence.json method record`));
      }
      const problems = seatContractProblems(opinion, master, tasks, dossier, sourceIds);
      if (problems.length) blockers.push(issue("seat_contract_invalid", `${master} failed the persisted method-seat contract`, problems));
    }
    if (!errors.length) {
      const content = analyzeSeatContent(opinions);
      blockers.push(...contentBlockers(content));
      blockers.push(...lifecycleBlockers(events, masters));
      if (diagnostics?.schema !== "alphacouncil_run_bundle_diagnostics_v1"
        || diagnostics?.schema_version !== 1
        || diagnostics?.standard_id !== EVIDENCE_STANDARD_ID) {
        pushUnique(errors, issue("run_bundle_diagnostics_schema_invalid", "attached run-bundle diagnostics schema/standard mismatch"));
      }
      if (JSON.stringify(diagnostics?.seat_content) !== JSON.stringify(content)) {
        pushUnique(errors, issue("seat_content_diagnostics_mismatch", "attached seat content diagnostics do not match persisted seat artifacts"));
      }
      const markerAdvisory = derivedMarkerAdvisory(opinions, { packageRoot });
      if (JSON.stringify(diagnostics?.derived_marker_hits) !== JSON.stringify(markerAdvisory)) {
        pushUnique(errors, issue("derived_marker_advisory_mismatch", "attached advisory marker hits do not match the fixed derivation rule"));
      }
      const failures = (diagnostics?.failures || []).filter((item) => item?.status === "not_produced");
      if (failures.length !== (diagnostics?.failures || []).length) {
        pushUnique(errors, issue("seat_failure_diagnostic_invalid", "failure diagnostics may contain only not_produced entries"));
      }
      const failureMasters = new Set(failures.map((item) => item.master).filter(Boolean));
      const failureTasks = new Set(failures.map((item) => item.task).filter(Boolean));
      for (const master of masters.filter((id) => !opinions.some((opinion) => opinion.master === id))) {
        if (!failureMasters.has(master)) pushUnique(errors, issue("seat_failure_diagnostic_missing", `${master} is missing without a not_produced diagnostic`));
      }
      for (const task of tasks.filter((id) => !existsSync(bundlePath(root, `payload/${id}.json`)))) {
        if (!failureTasks.has(task)) pushUnique(errors, issue("seat_failure_diagnostic_missing", `${task} is missing without a not_produced diagnostic`));
      }
    }
    blockers.push(...releaseBlockers(evidence.runtime_provenance || status.runtime_provenance, evidence.started_at || status.started_at, packageRoot));
    if (status.status !== "complete" || evidence.status !== "complete") blockers.push(issue("run_not_complete", `run terminal status is ${String(evidence.status || status.status)}`));
    if (status.recorded_masters && status.recorded_masters.length !== masters.length) blockers.push(issue("selected_seat_coverage_incomplete", "recorded master count does not equal selected master count"));
    const vocabulary = issue(
      "reviewed_vocabulary_contract_pending",
      "method vocabulary gate is not evaluable until P1c preregisters reviewed markers and per-seat N",
    );
    notEvaluable.push(vocabulary);
    blockers.push(vocabulary);
  }

  const structure = { status: errors.length ? "FAIL" : "PASS", errors };
  const claimReadiness = {
    status: errors.length || blockers.length ? "BLOCKED" : "READY",
    blockers,
    not_evaluable: notEvaluable,
  };
  return {
    schema: "alphacouncil_run_bundle_verification_v1",
    verified_at: new Date().toISOString(),
    bundle_dir: root,
    structure,
    claim_readiness: claimReadiness,
  };
}

export function formatVerificationSummary(result) {
  const lines = [`structure: ${result.structure.status}`];
  if (result.structure.errors.length) {
    for (const error of result.structure.errors) lines.push(`  - ${error.code}: ${error.message}`);
  }
  const blockers = result.claim_readiness.blockers.length;
  const notEvaluable = result.claim_readiness.not_evaluable.length;
  lines.push(`claim_readiness: ${result.claim_readiness.status}${blockers ? ` (${blockers} blocker(s); ${notEvaluable} not_evaluable)` : ""}`);
  for (const blocker of result.claim_readiness.blockers) lines.push(`  - ${blocker.code}: ${blocker.message}`);
  return lines.join("\n");
}
