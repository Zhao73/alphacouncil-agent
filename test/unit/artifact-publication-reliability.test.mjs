import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { makeDataDir, removeDataDir } from "../helpers/env.mjs";

const dataDir = makeDataDir();
process.env.ALPHACOUNCIL_AGENT_DATA_DIR = dataDir;

const { QUICK_TASKS } = await import("../../mcp/lib/constants.mjs");
const { readJson, readJsonl, writeJson } = await import("../../mcp/lib/fsutil.mjs");
const {
  appendEvent,
  artifactPaths,
  runPath,
  saveRun,
} = await import("../../mcp/lib/run-store.mjs");
const {
  publishFinalArtifacts,
  writeAllAgentsMarkdown,
  writeFinalArtifacts,
} = await import("../../mcp/lib/markdown.mjs");
const { recoverInterruptedBackgroundRuns } = await import("../../mcp/lib/background-recovery.mjs");

after(() => removeDataDir(dataDir));

function quickReport() {
  const analystRows = QUICK_TASKS.map(
    (task) => `- ${task}: recorded facts, confidence and data gaps for the quick read.`,
  ).join("\n");
  return `# RKLB Quick Council

## Conclusion
The quick council reached a conditional Hold conclusion; this is not equivalent to a full council decision.

## Analyst Work Log
${analystRows}

## Bull/Bear Debate Record
One parallel bull/bear statement was completed. The bull emphasized execution while the bear emphasized valuation risk.

## Earnings Call Management Signals
The earnings analyst separated filed figures from interpretation and recorded the remaining management questions.

## Recent Company and Industry News
The news analyst recorded dated items and excluded stale or undated items from the recent-news list.

## Valuation Range
The valuation remains conditional on revenue growth, margins and dilution; no unsupported point target is asserted.

## Price Levels
Above the evidence-supported range do not chase; inside the range wait; below it reassess only if the thesis remains intact.

## Major Risks
Execution delays, financing needs, dilution and evidence gaps can invalidate the directional read.

## Position Recommendation
Keep sizing small until the missing facts and the next primary filing are available.

## Data Gaps / Unavailable Data
The quick path did not run adversarial verifiers or a three-round cross-examination, and those limits remain visible.

## Confidence
medium, conditional on the cited quick evidence.

## Source Table
- market_data:S1 — quote source — 2026-08-02 — https://example.com
`;
}

function fixtureRun(runId, packetPatch = {}) {
  const packets = QUICK_TASKS.map((task) => ({
    task,
    symbol: "RKLB",
    as_of: "2026-08-03",
    language: "English",
    summary: `${task} produced a bounded analyst view with facts and explicit limits.`,
    claims: [{ claim: `${task} claim`, evidence: "bounded evidence", confidence: "medium", source_ids: [`${task}:S1`] }],
    metrics: {},
    sources: [{ id: `${task}:S1`, title: `${task} source`, url: "https://example.com", published_at: "2026-08-02" }],
    open_questions: [],
    confidence: "medium",
    information_richness: "B",
    raw_text: "fixture raw text",
  }));
  Object.assign(packets[0], packetPatch);
  return {
    run_id: runId,
    symbol: "RKLB",
    as_of: "2026-08-03",
    language: "English",
    council_mode: "quick",
    execution_mode: "background_codex_exec",
    dry_run: false,
    status: "complete",
    phase: "complete",
    started_at: "2026-08-03T00:00:00.000Z",
    completed_at: "2026-08-03T00:05:00.000Z",
    updated_at: "2026-08-03T00:05:00.000Z",
    tasks: [...QUICK_TASKS],
    task_status: Object.fromEntries(QUICK_TASKS.map((task) => [task, { task, status: "completed" }])),
    agent_status: {
      bull_researcher: { role: "bull_researcher", status: "completed" },
      bear_researcher: { role: "bear_researcher", status: "completed" },
      portfolio_manager: { role: "portfolio_manager", status: "completed" },
    },
    packets,
    masters: [],
    master_status: {},
    master_opinions: [],
    verifier_verdicts: [],
    grounding: {
      instrument: {
        asset_type: "company",
        research_model: "company_fundamentals",
        classification_source: "fixture",
      },
    },
    seat_weight_overrides: {},
  };
}

function manager() {
  return {
    role: "portfolio_manager",
    rating: "Hold",
    winner: "balanced",
    confidence: "medium",
    verdict: "Conditional hold while the next primary filing resolves the identified gaps.",
    summary: "A bounded quick-council decision.",
    long_thesis: ["Execution can improve."],
    short_thesis: ["Valuation and financing remain risks."],
    valuation_range: "Conditional range only; no point target.",
    catalysts: ["Next filing"],
    risks: ["Execution", "Dilution"],
    position: "Small watch position only.",
    invalidation: ["Primary filing contradicts the thesis."],
    source_ids: ["market_data:S1"],
    questions: [],
    questions_answered: [],
    report_markdown: quickReport(),
    raw_text: "fixture manager raw text",
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("appendEvent upgrades legacy logs and repairs only a trailing half-line", () => {
  const run = fixtureRun("EVENT-CHAIN");
  const dir = runPath(run.run_id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "events.jsonl");
  writeFileSync(path, `${JSON.stringify({ at: "legacy", type: "legacy_event" })}\n`);
  const first = appendEvent(run, "first_hashed");
  writeFileSync(path, `${readFileSync(path, "utf8")}{"type":"half`);
  const second = appendEvent(run, "after_repair");
  const log = readJsonl(path);
  assert.deepEqual(log.entries.map((event) => event.seq), [undefined, 2, 3]);
  assert.equal(first.prev_hash, null);
  assert.equal(second.prev_hash, first.event_hash);
  assert.equal(log.parse_errors, 0);
});

test("publication marker commits last, covers the delivery set, and terminal replay is immutable", () => {
  const run = fixtureRun("PUBLICATION-OK");
  const debate = { manager: manager() };
  const dir = runPath(run.run_id);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "decision.json"), debate.manager);
  appendEvent(run, "run_started");

  const result = writeFinalArtifacts(run, debate);
  assert.equal(result.report_quality.status, "passed", result.report_quality.missing.join("; "));
  const markerPath = result.artifacts.publication_manifest_json;
  assert.equal(existsSync(markerPath), false, "rendering alone must not publish before terminal state is saved");
  appendEvent(run, "run_complete", { decision: debate.manager.rating, winner: debate.manager.winner });
  saveRun(run);
  writeAllAgentsMarkdown(run, debate);
  result.publication_manifest = publishFinalArtifacts(run, debate);
  assert.ok(existsSync(markerPath));
  const markerBytes = readFileSync(markerPath);
  const manifest = JSON.parse(markerBytes);
  assert.equal(manifest.schema, "alphacouncil_publication_manifest_v1");
  assert.equal(manifest.run_id, run.run_id);
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.quality, "passed");
  assert.ok(!Object.values(manifest.artifacts).some((record) => record.path === markerPath), "marker must not hash itself");
  assert.ok(Object.hasOwn(manifest.artifacts, "evidence_json"));
  assert.ok(Object.hasOwn(manifest.artifacts, "status_json"));
  assert.ok(Object.hasOwn(manifest.artifacts, "source_manifest_json"));
  assert.equal(Object.hasOwn(manifest.artifacts, "events_jsonl"), false, "the audit log remains append-only after publication");
  assert.equal(readJson(result.artifacts.evidence_json).status, manifest.status);
  assert.equal(readJson(result.artifacts.status_json).status, manifest.status);

  const markerMtime = statSync(markerPath, { bigint: true }).mtimeNs;
  for (const [key, record] of Object.entries(manifest.artifacts)) {
    const bytes = readFileSync(record.path);
    assert.equal(bytes.length, record.byte_length, `${key} byte length`);
    assert.equal(sha256(bytes), record.sha256, `${key} sha256`);
    assert.ok(statSync(record.path, { bigint: true }).mtimeNs <= markerMtime, `${key} must precede the marker`);
  }
  assert.ok(Object.hasOwn(manifest.artifacts, "decision_json"));
  assert.ok(Object.hasOwn(manifest.artifacts, "all_agents_md"));
  assert.ok(Object.keys(manifest.artifacts).filter((key) => key.startsWith("seat_")).length >= QUICK_TASKS.length + 1);
  assert.equal(readdirSync(dir).some((name) => name.endsWith(".tmp")), false, "all atomic Markdown temps must be gone");

  const eventsBeforeReplay = readJsonl(join(dir, "events.jsonl")).entries;
  assert.equal(eventsBeforeReplay.at(-1).type, "artifacts_published");
  assert.equal(eventsBeforeReplay.filter((event) => event.type === "artifacts_published").length, 1);

  run.updated_at = "2099-01-01T00:00:00.000Z";
  writeFinalArtifacts(run, debate);
  writeAllAgentsMarkdown(run, debate);
  publishFinalArtifacts(run, debate);
  assert.deepEqual(readFileSync(markerPath), markerBytes, "replay must preserve published_at and marker bytes");
  assert.equal(readJsonl(join(dir, "events.jsonl")).entries.filter((event) => event.type === "artifacts_published").length, 1);

  const decision = readJson(join(dir, "decision.json"));
  writeJson(join(dir, "decision.json"), decision);
  assert.throws(
    () => writeJson(join(dir, "decision.json"), { ...decision, rating: "Buy" }),
    /refusing to modify immutable published artifact/u,
  );
  assert.throws(
    () => writeJson(result.artifacts.evidence_json, { ...readJson(result.artifacts.evidence_json), status: "failed" }),
    /refusing to modify immutable published artifact/u,
  );
});

test("a crash after terminal save but before marker is not rewritten as failed by startup recovery", () => {
  const run = fixtureRun("TERMINAL-SAVED-NOT-PUBLISHED");
  run.entry_tool = "analyze_symbol";
  const debate = { manager: manager() };
  const dir = runPath(run.run_id);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "decision.json"), debate.manager);
  writeFinalArtifacts(run, debate);
  appendEvent(run, "run_complete", { decision: debate.manager.rating, winner: debate.manager.winner });
  saveRun(run);
  writeAllAgentsMarkdown(run, debate);

  assert.equal(existsSync(artifactPaths(run).publication_manifest_json), false, "fault is injected before commit marker");
  recoverInterruptedBackgroundRuns();
  assert.equal(readJson(artifactPaths(run).evidence_json).status, "complete");
  assert.equal(readJson(artifactPaths(run).status_json).status, "complete");
  assert.equal(existsSync(artifactPaths(run).publication_manifest_json), false);
  assert.equal(readJsonl(artifactPaths(run).events_jsonl).entries.some((event) => event.type === "background_run_interrupted"), false);
});

test("a failure before the commit point cannot leave a publication marker", () => {
  const run = fixtureRun("PUBLICATION-INJECTED-FAILURE", { claims: undefined });
  const debate = { manager: manager() };
  const dir = runPath(run.run_id);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "decision.json"), debate.manager);
  assert.throws(() => writeFinalArtifacts(run, debate));
  assert.equal(existsSync(artifactPaths(run).publication_manifest_json), false);
});
