import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DEBATE_ROLES, RUNS_DIR } from "./constants.mjs";
import { internalError, invalidParams } from "./errors.mjs";
import { jsonlEntryHash, readJson, readJsonl, writeJson } from "./fsutil.mjs";
import { agentState, completenessStatus, masterSeatIncomplete, sourceManifest, taskState, verificationStatus } from "./gates.mjs";

export { agentState, taskState };

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function runId(symbol) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  return `${symbol.toUpperCase()}-${stamp}`;
}

export function safeSymbol(symbol) {
  if (typeof symbol !== "string" || !/^[A-Za-z0-9.^=+\-]{1,32}$/.test(symbol)) {
    throw invalidParams("symbol must be 1-32 chars and contain only ticker-safe characters.");
  }
  if (/^\.+$/.test(symbol)) throw invalidParams("symbol cannot be only dots.");
  return symbol.toUpperCase();
}

export function runPath(id) {
  if (typeof id !== "string" || !/^[A-Z0-9.^=+\-_]{1,80}$/.test(id)) {
    throw invalidParams("run_id is invalid.");
  }
  return join(RUNS_DIR, id);
}

/**
 * How much material the evidence agents actually found, counted by grade.
 * A run that is mostly C is not necessarily wrong, but it is a different kind of report
 * and the reader should be told before the conclusion, not after.
 */
export function richnessSummary(run) {
  const counts = { A: 0, B: 0, C: 0, unrated: 0 };
  for (const packet of run.packets || []) {
    const grade = ["A", "B", "C"].includes(packet.information_richness) ? packet.information_richness : "unrated";
    counts[grade] += 1;
  }
  return counts;
}

export function statusSnapshot(run) {
  const gate = verificationStatus(run);
  const completeness = completenessStatus(run);
  const verifierVerdicts = Array.isArray(run.verifier_verdicts) ? run.verifier_verdicts : [];
  const selectedMasters = Array.isArray(run.masters) ? run.masters : [];
  const recordedMasters = (run.master_opinions || []).map((opinion) => opinion.master);
  const pendingMasters = selectedMasters.filter((master) => masterSeatIncomplete(run, master));
  const visibleDebate = run.execution_mode === "visible_host_threads" ? run.visible_debate : null;
  const visibleDebateRounds = visibleDebate
    ? Object.fromEntries(["bull_researcher", "bear_researcher"].map((role) => [
        role,
        Object.keys(visibleDebate.rounds?.[role] || {}).map(Number).filter(Number.isInteger).sort((a, b) => a - b),
      ]))
    : null;
  return {
    run_id: run.run_id,
    symbol: run.symbol,
    asset_type: run.grounding?.instrument?.asset_type || "unknown",
    research_model: run.grounding?.instrument?.research_model || "unknown",
    instrument_classification_source: run.grounding?.instrument?.classification_source || "unknown",
    as_of: run.as_of,
    language: run.language,
    execution_mode: run.execution_mode,
    council_mode: run.council_mode || "full",
    // Which depth/time tier produced this run. Two runs of the same symbol at different paces
    // are not the same analysis, so the pace belongs in the audit record beside the budget.
    council_pace: run.council_pace || null,
    debate_format: run.debate_format || "three_round_cross_exam",
    visible_debate_contract: visibleDebate?.contract || null,
    visible_debate_rounds_expected: visibleDebate?.rounds_expected || null,
    visible_debate_rounds_recorded: visibleDebateRounds,
    visible_debate_qna_gate: visibleDebate?.qna_gate?.status || null,
    report_contract: run.council_mode === "quick" ? "quick_v1" : "full_v2",
    full_council_equivalent: run.council_mode !== "quick",
    master_worker_contract: run.execution_mode === "background_codex_exec"
      ? "one_isolated_worker_per_selected_method_v1"
      : run.execution_mode === "dry_run"
        ? "planned_not_executed"
        : "host_managed_not_plugin_enforced",
    deadline_enforced: run.deadline_enforced === true,
    time_budget_ms: run.time_budget_ms || null,
    deadline_at: run.deadline_at || null,
    remaining_budget_ms: run.deadline_at
      ? Math.max(0, Date.parse(run.deadline_at) - Date.now())
      : null,
    elapsed_ms: run.started_at
      ? Math.max(0, Date.parse(run.completed_at || new Date().toISOString()) - Date.parse(run.started_at))
      : null,
    deadline_met: run.deadline_at && run.completed_at
      ? Date.parse(run.completed_at) <= Date.parse(run.deadline_at)
      : null,
    visibility_required: run.visibility_required,
    dry_run: run.dry_run,
    status: run.status,
    phase: run.phase,
    verification: gate.verification,
    verification_scope: "source_id_presence_only",
    adversarial_verification: verifierVerdicts.length ? "recorded_not_exhaustive" : "not_run",
    verifier_verdict_count: verifierVerdicts.length,
    missing_source_count: gate.missing_claim_source_ids.length,
    completeness: completeness.completeness,
    evidence_coverage: completeness.evidence_coverage,
    degraded_evidence_count: completeness.degraded_evidence.length,
    degraded_evidence: completeness.degraded_evidence,
    degraded_debate_count: completeness.degraded_debate.length,
    degraded_debate: completeness.degraded_debate,
    missing_evidence_count: completeness.missing_evidence_count,
    missing_debate_count: completeness.missing_debate_count,
    missing_master_count: pendingMasters.length,
    selected_master_count: selectedMasters.length,
    recorded_master_count: recordedMasters.length,
    selected_masters: selectedMasters,
    recorded_masters: recordedMasters,
    pending_masters: pendingMasters,
    master_selection_status: run.master_selection?.status || "missing",
    selection_id: run.master_selection?.selection_id || null,
    catalog_hash: run.master_selection?.catalog_hash || null,
    selection_hash: run.master_selection?.selection_hash || null,
    fact_pack_hash: run.fact_pack_hash || run.grounding?.typed_fact_pack?.fact_pack_hash || null,
    typed_fact_count: run.grounding?.typed_fact_pack?.facts?.length || 0,
    information_richness: richnessSummary(run),
    report_quality: run.report_quality?.status || "not_checked",
    missing_report_items_count: run.report_quality?.missing?.length || 0,
    started_at: run.started_at,
    updated_at: run.updated_at,
    completed_at: run.completed_at,
    tasks: run.tasks.map((task) => taskState(run, task)),
    agents: DEBATE_ROLES.map((role) => agentState(run, role)),
    masters: selectedMasters.map((master) => run.master_status?.[master] || { master, status: "pending" }),
  };
}

export function writeStatus(run, patch = {}) {
  Object.assign(run, patch, { updated_at: new Date().toISOString() });
  writeJson(join(runPath(run.run_id), "status.json"), statusSnapshot(run));
}

export function appendEvent(run, type, data = {}) {
  const path = join(runPath(run.run_id), "events.jsonl");
  const log = readJsonl(path);
  if (log.trailing_partial) truncateSync(path, log.valid_bytes);
  const previous = log.entries.at(-1);
  const reserved = new Set(["schema_version", "seq", "prev_hash", "event_hash", "at", "type"]);
  const eventData = Object.fromEntries(
    Object.entries(data || {}).filter(([key]) => !reserved.has(key)),
  );
  const event = {
    schema_version: 1,
    seq: previous?.event_hash ? previous.seq + 1 : log.entries.length + 1,
    prev_hash: previous?.event_hash || null,
    at: new Date().toISOString(),
    type,
    ...eventData,
  };
  event.event_hash = jsonlEntryHash(event);
  const needsSeparator = log.valid_bytes > 0 && !log.ends_with_newline;
  let fd;
  try {
    fd = openSync(path, "a");
    writeFileSync(fd, `${needsSeparator ? "\n" : ""}${JSON.stringify(event)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the append failure.
      }
    }
    throw internalError(`failed to append event log ${path}: ${error.message}`);
  }
  return event;
}

export function writeSourceManifest(run) {
  writeJson(join(runPath(run.run_id), "source_manifest.json"), sourceManifest(run));
}

export function updateTask(run, task, status, patch = {}) {
  run.task_status[task] = { ...taskState(run, task), ...patch, task, status, updated_at: new Date().toISOString() };
  writeStatus(run);
  appendEvent(run, `task_${status}`, { task, ...patch });
}

export function updateAgent(run, role, status, patch = {}) {
  run.agent_status[role] = { ...agentState(run, role), ...patch, role, status, updated_at: new Date().toISOString() };
  writeStatus(run);
  appendEvent(run, `agent_${status}`, { role, ...patch });
}

export function artifactPaths(run) {
  const dir = runPath(run.run_id);
  const analyst_markdown = Object.fromEntries(
    [...(run.tasks || []), ...DEBATE_ROLES].map((role) => [role, join(dir, `${role}.md`)])
  );
  return {
    run_dir: dir,
    final_report_md: join(dir, "final_report.md"),
    user_response_md: join(dir, "user_response.md"),
    artifact_index_md: join(dir, "artifact_index.md"),
    all_agents_md: join(dir, "all_agents.md"),
    evidence_json: join(dir, "evidence.json"),
    source_manifest_json: join(dir, "source_manifest.json"),
    status_json: join(dir, "status.json"),
    events_jsonl: join(dir, "events.jsonl"),
    report_quality_json: join(dir, "report_quality.json"),
    decision_json: join(dir, "decision.json"),
    publication_manifest_json: join(dir, "publication_manifest.json"),
    analyst_markdown,
  };
}

function artifactDigest(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw internalError(`publication artifact is unavailable at ${path}: ${error.message}`);
  }
  return {
    path,
    byte_length: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function publicationArtifactPaths(run, debate = {}) {
  const artifacts = artifactPaths(run);
  const files = {
    evidence_json: artifacts.evidence_json,
    source_manifest_json: artifacts.source_manifest_json,
    status_json: artifacts.status_json,
    final_report_md: artifacts.final_report_md,
    user_response_md: artifacts.user_response_md,
    artifact_index_md: artifacts.artifact_index_md,
    all_agents_md: artifacts.all_agents_md,
    report_quality_json: artifacts.report_quality_json,
    decision_json: artifacts.decision_json,
  };
  for (const packet of run.packets || []) files[`seat_${packet.task}_md`] = join(artifacts.run_dir, `${packet.task}.md`);
  if (debate.bull) files.seat_bull_researcher_md = artifacts.analyst_markdown.bull_researcher;
  if (debate.bear) files.seat_bear_researcher_md = artifacts.analyst_markdown.bear_researcher;
  if (debate.manager) files.seat_portfolio_manager_md = artifacts.analyst_markdown.portfolio_manager;
  for (const opinion of run.master_opinions || []) {
    files[`seat_${opinion.master}_md`] = join(artifacts.run_dir, `${opinion.master}.md`);
  }
  return files;
}

/**
 * Commit the quality-gated terminal run and reader delivery set. This file is written last.
 *
 * events remains append-only so the post-commit artifacts_published event is intentionally
 * not hashed. Every terminal state file and delivered artifact is immutable once listed.
 */
export function writePublicationManifest(run, debate = {}) {
  if (run.report_quality?.status !== "passed") {
    throw internalError("publication manifest requires a passed report quality gate");
  }
  if (!["complete", "degraded", "incomplete", "needs_verification", "needs_revision", "failed"].includes(run.status)) {
    throw internalError(`publication manifest requires a terminal run status, got ${String(run.status)}`);
  }
  const paths = artifactPaths(run);
  const persistedEvidence = readJson(paths.evidence_json);
  const persistedStatus = readJson(paths.status_json);
  if (persistedEvidence.status !== run.status || persistedStatus.status !== run.status) {
    throw internalError(
      `publication status mismatch: memory=${String(run.status)}, evidence=${String(persistedEvidence.status)}, status=${String(persistedStatus.status)}`,
    );
  }
  if (persistedEvidence.report_quality?.status !== run.report_quality.status
    || persistedStatus.report_quality !== run.report_quality.status) {
    throw internalError("publication quality mismatch across evidence, status and report quality");
  }
  const artifacts = Object.fromEntries(
    Object.entries(publicationArtifactPaths(run, debate)).map(([key, path]) => [key, artifactDigest(path)]),
  );
  const manifest = {
    schema: "alphacouncil_publication_manifest_v1",
    schema_version: 1,
    run_id: run.run_id,
    status: run.status,
    quality: run.report_quality.status,
    artifacts,
    published_at: new Date().toISOString(),
  };
  writeJson(artifactPaths(run).publication_manifest_json, manifest);
  return manifest;
}

/** Read and fully verify an existing publication marker without modifying its timestamp. */
export function readPublicationManifest(run) {
  const markerPath = artifactPaths(run).publication_manifest_json;
  if (!existsSync(markerPath)) return null;
  const manifest = readJson(markerPath);
  if (manifest.schema !== "alphacouncil_publication_manifest_v1"
    || manifest.schema_version !== 1
    || manifest.run_id !== run.run_id) {
    throw internalError(`invalid publication manifest at ${markerPath}`);
  }
  for (const [key, expected] of Object.entries(manifest.artifacts || {})) {
    const actual = artifactDigest(expected.path);
    if (actual.byte_length !== expected.byte_length || actual.sha256 !== expected.sha256) {
      throw internalError(`published artifact no longer matches commit marker: ${key}`);
    }
  }
  const paths = artifactPaths(run);
  const persistedEvidence = readJson(paths.evidence_json);
  const persistedStatus = readJson(paths.status_json);
  if (persistedEvidence.status !== manifest.status || persistedStatus.status !== manifest.status) {
    throw internalError(`publication manifest status disagrees with persisted terminal state at ${markerPath}`);
  }
  if (run.status !== undefined && run.status !== manifest.status) {
    throw internalError(`publication manifest status disagrees with in-memory run at ${markerPath}`);
  }
  return manifest;
}

/** Return true only when an already-published artifact still matches its commit marker. */
export function verifyPublishedArtifact(run, key) {
  const manifest = readPublicationManifest(run);
  if (!manifest) return false;
  const expected = manifest.artifacts?.[key];
  if (!expected) throw internalError(`publication manifest is missing artifact ${key}`);
  return true;
}

export function existingDebate(dir) {
  return {
    bull: existsSync(join(dir, "bull_researcher.json")) ? readJson(join(dir, "bull_researcher.json")) : null,
    bear: existsSync(join(dir, "bear_researcher.json")) ? readJson(join(dir, "bear_researcher.json")) : null,
    manager: existsSync(join(dir, "manager_synthesis.json")) ? readJson(join(dir, "manager_synthesis.json")) : null,
  };
}

export function saveRun(run) {
  run.updated_at = new Date().toISOString();
  writeJson(join(runPath(run.run_id), "evidence.json"), run);
  writeSourceManifest(run);
  writeJson(join(runPath(run.run_id), "status.json"), statusSnapshot(run));
}
