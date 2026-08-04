import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_ANALYST_TASKS, COUNCIL_MODES, DEBATE_ROLES, DEFAULT_TASKS, LIMITS, OUTPUT_MODES, QUICK_TASKS, councilPaceProfile } from "./constants.mjs";
import { invalidParams } from "./errors.mjs";
import { readJson, readJsonl, writeJson } from "./fsutil.mjs";
import { registry } from "./personas/registry.mjs";
import { assertReaderLanguage, isChineseLanguage, localized, resolveLanguage } from "./lang.mjs";
import { cleanLog } from "./text.mjs";
import { authoredReportSectionGaps, completenessStatus, masterSeatIncomplete, requiredReportSectionAliases, sourceManifest, verificationStatus } from "./gates.mjs";
import { agentState, appendEvent, artifactPaths, existingDebate, runPath, runId, safeSymbol, saveRun, taskState, today, updateAgent, updateTask, writeSourceManifest, writeStatus } from "./run-store.mjs";
import { publishFinalArtifacts, writeAllAgentsMarkdown, writeAnalystMarkdownFiles, writeArtifactIndex, writeFinalArtifacts } from "./markdown.mjs";
import { applyGroundedRegulatorCoverage, assertOfficialSourceCoverage, assertPriceLevelContinuity, assertSourceIdsResolve, debateFailurePacket, debateFromCodex, debateQnaGate, dryDebate, dryPacket, extractJson, extractRepairedWorkerJson, extractWorkerJson, firstFailedDebateResult, managerFallback, mergeDebateRounds, normalizeDebate, normalizeMasterOpinion, normalizeMasterVoice, normalizePacket, rawRecordText } from "./packets.mjs";
import { assertRuntimeClientPayload } from "./runtime-validation.mjs";
import { mapLimit, runCodex } from "./codex.mjs";
import { debatePrompt, masterPrompt, masterVoicePrompt, methodVoiceOutputContract, selectedMasters, taskPrompt } from "./prompts.mjs";
import { resolveSeatWeights } from "./weights.mjs";
import { completedMasterOpinion, declinedMasterOpinion, ensureV3FactPack, needsMethodVoiceWorker, planMasterSeats, reconcileMasterOpinion } from "./personas/engine.mjs";
import { gatherGrounding } from "./grounding.mjs";
import { councilOptions } from "./council-options.mjs";
import { sha256 } from "./personas-v3/canonical.mjs";
import { managerDecisionNestedSourceIds, renderStructuredManagerReport } from "./manager-report.mjs";
import {
  assertCompanyCoveragePacket,
  assertCompanyDossierAck,
  buildCompanyDossier,
  companyEvidencePacketHash,
  companyCoverageInstruction,
  companyDossierCoverageStatus,
  companyDossierPromptBlock,
  requiresOperatingCompanyDossier,
} from "./company-dossier.mjs";
import { assertCompanySourceAcquisition, buildCompanySourceAcquisitionPlan, sourceAcquisitionPromptBlock } from "./company-source-acquisition.mjs";
import { recordCompanyAcquisitionObservations } from "./company-observations.mjs";
import {
  REQUIRED_VERIFIER_IDS,
  buildVerifierBatchInput,
  buildVerifierHeadlessOutputSchema,
  initializeVerificationPolicy,
  normalizeVerifierBatch,
  normalizeVerifierHeadlessTransport,
  tripleVerificationRequired,
  verificationAuditStatus,
  verifierBatchPrompt,
} from "./verification.mjs";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;

/** A council cannot certify an information set whose cutoff has not happened yet. */
export function councilAsOf(value, { now = new Date() } = {}) {
  const asOfDate = value || (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  const parsed = ISO_DAY.test(String(asOfDate)) ? Date.parse(`${asOfDate}T00:00:00.000Z`) : NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== asOfDate) {
    throw invalidParams(`as_of must be a valid YYYY-MM-DD date, got ${JSON.stringify(value)}`);
  }
  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowTime)) throw new Error("council now must be a valid timestamp");
  const currentDay = new Date(nowTime).toISOString().slice(0, 10);
  if (asOfDate > currentDay) {
    throw invalidParams(`as_of ${asOfDate} is in the future; the latest certifiable cutoff is ${currentDay}`, {
      reason: "FUTURE_AS_OF",
      as_of: asOfDate,
      latest_certifiable_cutoff: currentDay,
    });
  }
  return asOfDate;
}

function commitFinalArtifacts(run, debate = {}) {
  const prepared = writeFinalArtifacts(run, debate);
  if (!prepared.publication_manifest && run.status === "complete") {
    const events = readJsonl(artifactPaths(run).events_jsonl).entries;
    if (!events.some((event) => event.type === "run_complete")) {
      appendEvent(run, "run_complete", {
        decision: debate.manager?.rating ?? null,
        winner: debate.manager?.winner ?? null,
      });
    }
  }
  if (!prepared.publication_manifest) {
    // report_quality is assigned while rendering; save the complete terminal state only
    // after that gate, then render the trace once more from the exact persisted timestamp.
    saveRun(run);
    writeAllAgentsMarkdown(run, debate);
  }
  const publication_manifest = publishFinalArtifacts(run, debate);
  return { ...prepared, publication_manifest };
}

function materializeCompanyDossier(run) {
  const coverage = companyDossierCoverageStatus(run);
  if (!coverage.required) {
    delete run.company_dossier;
    return null;
  }
  // Freeze every deterministic derivative before hashing the dossier. Otherwise the first
  // method plan would add typed_fact_pack to grounding after the evidence snapshot was signed.
  ensureV3FactPack(run);
  const dir = runPath(run.run_id);
  const path = join(dir, "company_dossier.json");
  const dossier = buildCompanyDossier(run, sourceManifest(run));
  writeJson(path, dossier, { mode: 0o600 });
  run.company_dossier = {
    contract_id: dossier.contract_id,
    required: coverage.required,
    status: coverage.status,
    retrieval_status: coverage.retrieval_status,
    sufficiency: coverage.sufficiency,
    decision_barrier_ready: coverage.decision_barrier_ready,
    expected_count: coverage.expected_count,
    covered_count: coverage.covered_count,
    unavailable_count: coverage.unavailable_count,
    not_applicable_count: coverage.not_applicable_count,
    missing_count: coverage.missing.length,
    invalid_count: coverage.invalid.length,
    content_hash: dossier.content_hash,
    path,
    bytes: readFileSync(path).byteLength,
  };
  return run.company_dossier;
}

/**
 * Visible plans are created before the evidence barrier, so their provisional deterministic
 * snapshots cannot yet contain the dossier hash. Re-freeze those same typed-fact decisions
 * after the immutable dossier exists and require a dedicated voice worker for every v3 seat,
 * including out-of-scope abstentions.
 */
function bindVisibleMastersToCompanyDossier(run) {
  const selected = selectedMasters(run);
  const plan = planMasterSeats(run, selected);
  run.master_decisions = plan.decisions;
  run.fact_pack_hash = plan.shared_fact_pack_hash;
  run.master_runtime_provenance = masterRuntimeProvenance(run, plan);
  const byId = new Map((run.master_opinions || []).map((opinion) => [opinion.master, opinion]));
  for (const item of plan.declined) {
    byId.set(item.id, attachMasterRuntimeProvenance(
      run,
      item.id,
      declinedMasterOpinion(run, item),
      item.engine,
    ));
    run.master_status[item.id] = {
      ...(run.master_status?.[item.id] || {}),
      master: item.id,
      status: "waiting",
      engine: item.engine,
      deterministic_decline: true,
      voice_required: true,
      company_dossier_hash: run.company_dossier.content_hash,
      completed_at: null,
    };
  }
  for (const item of plan.completed) {
    byId.set(item.id, attachMasterRuntimeProvenance(
      run,
      item.id,
      completedMasterOpinion(run, item),
      item.engine,
    ));
    run.master_status[item.id] = {
      ...(run.master_status?.[item.id] || {}),
      master: item.id,
      status: "waiting",
      engine: item.engine,
      deterministic_execution: true,
      voice_required: true,
      company_dossier_hash: run.company_dossier.content_hash,
      completed_at: null,
    };
  }
  for (const item of plan.blocked) {
    run.master_status[item.id] = {
      ...(run.master_status?.[item.id] || {}),
      master: item.id,
      status: "failed",
      engine: item.engine,
      error: item.reason,
      error_code: item.error_code || "V3_POLICY_EXECUTION_FAILED",
      company_dossier_hash: run.company_dossier.content_hash,
      completed_at: new Date().toISOString(),
    };
  }
  run.master_opinions = selected.map((id) => byId.get(id)).filter(Boolean);
  return plan;
}

function refreshVisibleDownstreamPromptFiles(run) {
  const dir = join(runPath(run.run_id), "prompts");
  if (!existsSync(dir)) return [];
  const refreshed = [];
  if (tripleVerificationRequired(run)) {
    for (const verifier of REQUIRED_VERIFIER_IDS) {
      const input = join(runPath(run.run_id), `verification.${verifier}.input.json`);
      writeJson(input, buildVerifierBatchInput(run, verifier), { mode: 0o600 });
      const file = join(dir, `verifier.${verifier}.prompt.md`);
      writeFileSync(file, `${verifierBatchPrompt(run, verifier, input).trimEnd()}\n`, { encoding: "utf8", mode: 0o600 });
      refreshed.push(file);
    }
  }
  if (!requiresOperatingCompanyDossier(run) || !run?.company_dossier?.content_hash) return refreshed;
  const frozenById = new Map((run.master_opinions || []).map((opinion) => [opinion.master, opinion]));
  for (const id of selectedMasters(run)) {
    const file = join(dir, `master.${id}.prompt.md`);
    if (!existsSync(file)) continue;
    const frozen = frozenById.get(id);
    if (!frozen) continue;
    const prompt = masterVoicePrompt(id, run, frozen);
    writeFileSync(file, `${prompt.trimEnd()}\n`, { encoding: "utf8", mode: 0o600 });
    refreshed.push(file);
  }
  for (const role of DEBATE_ROLES) {
    const file = join(dir, `debate.${role}.prompt.md`);
    if (!existsSync(file)) continue;
    const prompt = debatePrompt(role, run);
    writeFileSync(file, `${prompt.trimEnd()}\n`, { encoding: "utf8", mode: 0o600 });
    refreshed.push(file);
  }
  return refreshed;
}

function councilMode(args = {}) {
  return COUNCIL_MODES.includes(args.council_mode) ? args.council_mode : "full";
}

function plannedTasks(args = {}) {
  if (councilMode(args) === "quick") return QUICK_TASKS;
  // Selection-gated public runs take analyst breadth only from the one-use receipt. A caller-
  // supplied tasks array cannot turn an approved 11-seat run back into eight (or vice versa).
  const receiptTasks = args.master_selection?.selected_analyst_ids || args.selected_analyst_ids;
  if (Array.isArray(receiptTasks) && receiptTasks.length) return [...receiptTasks];
  // Public full-council entry tools may add optional breadth, never subtract one of the eight
  // mandatory evidence roles. Direct library callers retain a narrow-task seam for isolated
  // tests and data-only development helpers; every selected MCP run carries entry_tool.
  if (Array.isArray(args.tasks) && args.tasks.length) {
    if (args.entry_tool === "collect_evidence" || !args.entry_tool) return args.tasks;
    return [...new Set([...DEFAULT_TASKS, ...args.tasks])];
  }
  return DEFAULT_TASKS;
}

/**
 * The pace a run executes at, and the per-stage caps that come with it.
 *
 * Quick has one fixed shape and does not take a pace: it is a smaller contract, not a slower
 * one. Full carries the pace on the run so every stage reads the same profile and `status.json`
 * records which one was used.
 */
export function runPace(run) {
  if (run?.council_mode === "quick") return null;
  return councilPaceProfile(run?.council_pace);
}

/**
 * Resolve optional legacy worker caps without letting an MCP schema default silently shorten
 * a confirmed pace. A caller may explicitly lower a stage, but omitting the legacy field means
 * "use the pace profile" -- especially slow evidence at twelve minutes.
 */
export function evidenceStageTimeout(args = {}, timing = {}) {
  const cap = timing.council_mode === "quick"
    ? LIMITS.QUICK_EVIDENCE_MS
    : councilPaceProfile(timing.council_pace).evidence_ms;
  const requested = Number.isFinite(args.timeout_ms) ? Number(args.timeout_ms) : cap;
  return Math.min(requested, cap);
}

export function masterStageTimeout(args = {}, run = {}) {
  const cap = run.council_mode === "quick"
    ? LIMITS.QUICK_MASTER_MS
    : runPace(run).master_ms;
  const requested = Number.isFinite(args.timeout_ms) ? Number(args.timeout_ms) : cap;
  return Math.min(requested, cap);
}

export function verifierStageTimeout(run = {}) {
  if (!tripleVerificationRequired(run)) return 0;
  return councilPaceProfile(run.council_pace).verifier_ms || LIMITS.FULL_VERIFIER_MS;
}

function explicitSynthesisCeiling(args = {}) {
  if (Number.isFinite(args.synthesis_timeout_ms)) return Number(args.synthesis_timeout_ms);
  if (Number.isFinite(args.timeout_ms)) return Number(args.timeout_ms);
  return null;
}

export function debateStageTimeout(args = {}, run = {}) {
  const cap = run.council_mode === "quick" ? LIMITS.QUICK_SYNTHESIS_MS : runPace(run).debate_ms;
  const requested = explicitSynthesisCeiling(args);
  return Math.min(requested ?? cap, cap);
}

export function portfolioManagerStageTimeout(args = {}, run = {}) {
  const cap = run.council_mode === "quick" ? LIMITS.QUICK_SYNTHESIS_MS : runPace(run).pm_ms;
  const requested = explicitSynthesisCeiling(args);
  return Math.min(requested ?? cap, cap);
}

function councilTiming(args, startedAt) {
  const mode = councilMode(args);
  const requested = Number(args.total_timeout_ms);
  const profile = mode === "quick" ? null : councilPaceProfile(args.council_pace);
  // The ceiling a call is held to is its own pace's total, not the outer bound of the schema.
  // A caller may still lower it; `LIMITS.FULL_TOTAL_MS` keeps the operator env override.
  const hardMaximum = mode === "quick" ? LIMITS.QUICK_HARD_MAX_MS : profile.total_ms;
  const defaultBudget = mode === "quick"
    ? LIMITS.QUICK_TOTAL_MS
    : Math.min(profile.total_ms, LIMITS.FULL_TOTAL_OVERRIDE_MS ?? profile.total_ms);
  const timeBudgetMs = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, hardMaximum)
    : defaultBudget;
  const deadlineAt = args.queued_run?.deadline_at
    || new Date(Date.parse(startedAt) + timeBudgetMs).toISOString();
  return {
    council_mode: mode,
    council_pace: profile?.pace || null,
    debate_format: mode === "quick" ? "single_round_parallel" : "three_round_cross_exam_parallel_per_round",
    time_budget_ms: timeBudgetMs,
    deadline_at: deadlineAt,
    deadline_enforced: true,
  };
}

function visibleCouncilTiming(args) {
  const mode = councilMode(args);
  const profile = mode === "quick" ? null : councilPaceProfile(args.council_pace);
  return {
    council_mode: mode,
    council_pace: profile?.pace || null,
    debate_format: mode === "quick" ? "single_round_parallel" : "host_managed_visible_debate",
    time_budget_ms: null,
    deadline_at: null,
    deadline_enforced: false,
  };
}

function remainingCouncilBudget(run, capMs, nowMs = Date.now()) {
  if (!run.deadline_at) return capMs;
  const configuredReserve = run.council_mode === "quick"
    ? LIMITS.QUICK_FINALIZE_RESERVE_MS
    : runPace(run).finalize_reserve_ms;
  const reserve = Math.min(
    configuredReserve,
    Math.max(100, Math.floor(Number(run.time_budget_ms || LIMITS.FULL_TOTAL_MS) * 0.1)),
  );
  const killGrace = councilKillGrace(run);
  // runCodex may need one SIGKILL grace after its timeout. Budget that grace before
  // launching a child so the queue-to-persistence deadline remains the outer boundary.
  const usable = Date.parse(run.deadline_at) - nowMs - reserve - killGrace;
  return Math.max(0, Math.min(capMs, usable));
}

function councilKillGrace(run) {
  const total = Math.max(1_000, Number(run?.time_budget_ms || LIMITS.FULL_TOTAL_MS));
  // A fixed five-second grace would consume tiny operator-supplied budgets before the
  // first worker. Production budgets retain the full grace; small budgets scale it down.
  // The exact same value is passed to runCodex, so forced settlement remains inside the
  // queue-to-persistence deadline rather than becoming an unaccounted overrun.
  return Math.min(LIMITS.SIGKILL_GRACE_MS, Math.max(50, Math.floor(total * 0.02)));
}

/**
 * Budget the one allowed no-search repair inside both the pace-specific stage and the outer run.
 * A deeper pace buys a proportionally larger repair window, but never more than the absolute
 * repair ceiling and never by borrowing the finalize/SIGKILL reserve from the global deadline.
 */
export function parseRepairBudget(run, {
  stageBudgetMs,
  stageStartedAtMs,
  nowMs = Date.now(),
} = {}) {
  const stageBudget = Math.max(0, Math.floor(Number(stageBudgetMs) || 0));
  const stageStarted = Number.isFinite(Number(stageStartedAtMs)) ? Number(stageStartedAtMs) : nowMs;
  const stageElapsed = Math.max(0, nowMs - stageStarted);
  const stageRemaining = Math.max(0, stageBudget - stageElapsed);
  const paceAwareCap = Math.floor(stageBudget * LIMITS.PARSE_REPAIR_STAGE_FRACTION);
  const boundedCap = Math.max(0, Math.min(LIMITS.PARSE_REPAIR_MS, paceAwareCap, stageRemaining));
  return Math.floor(remainingCouncilBudget(run, boundedCap, nowMs));
}

function deadlineResult(run) {
  return {
    ok: false,
    code: null,
    text: "",
    stderr: `${run?.council_mode || "council"} global deadline exhausted`,
    stdout: "",
    timedOut: true,
    deadline_exhausted: true,
  };
}

function masterRuntimeProvenance(run, plan) {
  const decisions = new Map((plan.decisions || []).map((decision) => [decision.persona_id, decision]));
  const planned = new Map(
    [...(plan.to_run || []), ...(plan.declined || []), ...(plan.completed || []), ...(plan.blocked || [])]
      .map((item) => [item.id, item]),
  );
  return Object.fromEntries(selectedMasters(run).map((id) => {
    const decision = decisions.get(id) || {};
    const item = planned.get(id) || {};
    const methodSources = (item.pack?.components?.sources || []).map((source) => ({
      ...source,
      method_id: id,
    }));
    return [id, {
      engine: decision.engine || item.engine || "unknown",
      pack_hash: decision.pack_hash || run.master_selection?.selected_master_pack_hashes?.[id] || null,
      corpus_hash: decision.corpus_hash || null,
      policy_hash: decision.policy_hash || null,
      tool_graph_hash: decision.tool_graph_hash || null,
      fact_pack_hash: decision.fact_pack_hash || item.preDecision?.fact_pack?.fact_pack_hash || null,
      evidence_snapshot_hash: decision.evidence_snapshot_hash || item.preDecision?.evidence_snapshot_hash || null,
      company_dossier_hash: run.company_dossier?.content_hash || null,
      method_source_ids: methodSources.map((source) => source.id || source.source_id).filter(Boolean),
      method_sources: methodSources,
    }];
  }));
}

function attachMasterRuntimeProvenance(run, masterId, opinion, engine = null) {
  const provenance = run.master_runtime_provenance?.[masterId] || {};
  return {
    ...opinion,
    engine: opinion.engine || engine || provenance.engine || "unknown",
    pack_hash: opinion.pack_hash || provenance.pack_hash
      || run.master_selection?.selected_master_pack_hashes?.[masterId] || null,
    corpus_hash: opinion.corpus_hash || provenance.corpus_hash || null,
    policy_hash: opinion.policy_hash || provenance.policy_hash || null,
    tool_graph_hash: opinion.tool_graph_hash || provenance.tool_graph_hash || null,
    fact_pack_hash: opinion.fact_pack_hash || provenance.fact_pack_hash || null,
    evidence_snapshot_hash: opinion.evidence_snapshot_hash || provenance.evidence_snapshot_hash || null,
    company_dossier_hash: opinion.company_dossier_hash || provenance.company_dossier_hash
      || run.company_dossier?.content_hash || null,
  };
}

function frozenMasterSelection(args = {}) {
  const selection = args.master_selection;
  if (!selection || selection.status !== "consumed") {
    throw invalidParams("A consumed master selection receipt is required before creating a council run.", {
      reason: "MASTER_SELECTION_REQUIRED",
    });
  }
  if (!Array.isArray(args.masters) || args.masters.length === 0) {
    throw invalidParams("A confirmed council run must contain at least one selected master.", {
      reason: "EMPTY_MASTER_SELECTION",
    });
  }
  if (new Set(args.masters).size !== args.masters.length) {
    throw invalidParams("Selected masters must be unique.", { reason: "DUPLICATE_MASTER_SELECTION" });
  }
  if (!Array.isArray(selection.selected_master_ids)
    || JSON.stringify(selection.selected_master_ids) !== JSON.stringify(args.masters)) {
    throw invalidParams("Selected masters do not match the consumed receipt.", {
      reason: "MASTER_SELECTION_RECEIPT_MISMATCH",
    });
  }
  if (!Array.isArray(selection.selected_analyst_ids) || selection.selected_analyst_ids.length === 0) {
    throw invalidParams("The consumed selection receipt has no analyst-seat selection.", {
      reason: "ANALYST_SELECTION_REQUIRED",
    });
  }
  const validAnalysts = selection.analyst_scope === "all" ? ALL_ANALYST_TASKS
    : selection.analyst_scope === "quick" ? QUICK_TASKS : DEFAULT_TASKS;
  if (JSON.stringify(selection.selected_analyst_ids) !== JSON.stringify(validAnalysts)) {
    throw invalidParams("Selected analysts do not match the consumed receipt's analyst scope.", {
      reason: "ANALYST_SELECTION_RECEIPT_MISMATCH",
      analyst_scope: selection.analyst_scope,
      selected_analyst_ids: selection.selected_analyst_ids,
      expected_analyst_ids: validAnalysts,
    });
  }
  const reg = registry();
  const unknown = args.masters.filter((id) => reg.get(id)?.kind !== "master" || reg.get(id)?.enabled === false);
  if (unknown.length) {
    throw invalidParams(`Unknown or disabled selected master(s): ${unknown.join(", ")}`, {
      reason: "UNKNOWN_MASTER_SELECTION",
      unknown,
    });
  }
  const currentPackHashes = Object.fromEntries(
    councilOptions({ language: args.language }).masters.map((master) => [master.id, master.pack_hash]),
  );
  const receiptPackHashes = selection.selected_master_pack_hashes;
  const mismatchedPackHashes = args.masters.filter((id) => (
    typeof receiptPackHashes?.[id] !== "string"
      || receiptPackHashes[id] !== currentPackHashes[id]
  ));
  if (mismatchedPackHashes.length) {
    throw invalidParams("The selected persona pack changed after confirmation. Start a new selection.", {
      reason: "MASTER_SELECTION_PACK_HASH_MISMATCH",
      mismatched_master_ids: mismatchedPackHashes,
    });
  }
  return {
    masters: [...args.masters],
    analysts: [...selection.selected_analyst_ids],
    selection: {
      ...selection,
      selected_master_ids: [...args.masters],
      selected_master_pack_hashes: Object.fromEntries(
        args.masters.map((id) => [id, receiptPackHashes[id]]),
      ),
    },
  };
}

export function visibleRun(args) {
  const symbol = safeSymbol(args.symbol);
  const asOfDate = councilAsOf(args.as_of);
  const id = args.run_id || runId(symbol);
  const tasks = plannedTasks(args);
  const language = resolveLanguage(args);
  const frozen = frozenMasterSelection(args);
  const dir = runPath(id);
  mkdirSync(dir, { recursive: true });
  const startedAt = new Date().toISOString();
  // External host threads are outside this MCP process, so the plugin cannot stop them or
  // make a truthful queue-to-persistence SLA claim. Only analyze_symbol gets the enforced
  // thirty-minute full-council deadline.
  const timing = visibleCouncilTiming(args);
  const run = {
    run_id: id,
    symbol,
    as_of: asOfDate,
    language,
    dry_run: false,
    execution_mode: "visible_host_threads",
    entry_tool: args.entry_tool || "plan_visible_run",
    decision_requested: true,
    visibility_required: true,
    ...timing,
    started_at: startedAt,
    updated_at: startedAt,
    completed_at: null,
    status: "planned",
    phase: "visible_planned",
    tasks,
    analyst_scope: frozen.selection.analyst_scope,
    task_status: Object.fromEntries(tasks.map((task) => [task, { task, status: "pending" }])),
    agent_status: Object.fromEntries(DEBATE_ROLES.map((role) => [role, { role, status: "pending" }])),
    // Visible hosts call record_visible_decision once per role and round. Keep those
    // packets separate: overwriting bull_researcher.json three times destroys the audit
    // chain and makes a one-round shortcut indistinguishable from a full cross-exam.
    visible_debate: {
      contract: "role_round_audit_v1",
      rounds_expected: councilMode(args) === "quick" ? 1 : 3,
      rounds: { bull_researcher: {}, bear_researcher: {} },
      qna_gate: {
        status: councilMode(args) === "quick" ? "not_run" : "pending",
        errors: [],
      },
    },
    packets: [],
    // The receipt resolves the user's exact choice once. This frozen list, not a dynamic
    // roster lookup, is the run truth and every seat is part of the completeness gate.
    masters: frozen.masters,
    master_selection: frozen.selection,
    master_opinions: [],
    master_status: Object.fromEntries(frozen.masters.map((master) => [master, { master, status: "pending" }])),
    // Verifier outcomes, keyed to the seat that cited the claim. These drive the
    // down-weighting in weights.mjs.
    verifier_verdicts: [],
    // Deterministic facts injected into every analyst prompt, so search explains and
    // challenges established numbers rather than re-deriving them from nothing.
    grounding: args.grounding && typeof args.grounding === "object" ? args.grounding : null,
    seat_weight_overrides: (args.seat_weights && typeof args.seat_weights === "object") ? args.seat_weights : {},
  };
  writeStatus(run);
  appendEvent(run, "master_selection_consumed", {
    selection_id: frozen.selection.selection_id,
    catalog_hash: frozen.selection.catalog_hash,
    selection_hash: frozen.selection.selection_hash,
    selected_masters: frozen.masters,
  });
  appendEvent(run, "visible_run_planned", { tasks, masters: frozen.masters });
  writeJson(join(dir, "evidence.json"), run);
  writeSourceManifest(run);
  writeAllAgentsMarkdown(run);
  return run;
}

export function visibleAgentSpecs(run, userPrompt = "") {
  const evidence_agents = run.tasks.map((task) => ({
    role: task,
    title: localized(run.language, {
      en: `AlphaCouncil Agent ${run.symbol} ${task} evidence subagent`,
      zh: `AlphaCouncil Agent ${run.symbol} ${task} 证据子代理`,
      ja: `AlphaCouncil Agent ${run.symbol} ${task} 証拠サブエージェント`,
      ko: `AlphaCouncil Agent ${run.symbol} ${task} 증거 하위 에이전트`,
    }),
    prompt: [
      taskPrompt(task, run.symbol, run.as_of, userPrompt, run.language, run.grounding, run.council_pace),
      companyCoverageInstruction(task, run),
    ].filter(Boolean).join("\n\n"),
    output_contract: localized(run.language, {
      en: `Return one JSON evidence packet with reader-facing fields in ${run.language}.`,
      zh: "只返回一个 JSON evidence packet。",
      ja: "読者向けフィールドを日本語にした JSON evidence packet を1つだけ返してください。",
      ko: "독자용 필드를 한국어로 작성한 JSON evidence packet 하나만 반환하십시오.",
    }),
  }));
  const debate_agents = DEBATE_ROLES.map((role) => ({
    role,
    title: `AlphaCouncil Agent ${run.symbol} ${role}`,
    prompt_template: [
      debatePrompt(role, run),
      "",
      localized(run.language, {
        en: "The main thread must paste the completed Evidence JSON before running this visible agent.", zh: "主线程必须先粘贴已完成的 Evidence JSON，再运行这个可见代理。", ja: "メインスレッドは、この可視エージェントを実行する前に完成済みの Evidence JSON を貼り付ける必要があります。", ko: "메인 스레드는 이 표시형 에이전트를 실행하기 전에 완료된 Evidence JSON을 붙여 넣어야 합니다.",
      }),
      role === "bear_researcher" ? localized(run.language, { en: "The main thread must also paste Bull argument JSON.", zh: "主线程还必须粘贴 Bull argument JSON。", ja: "メインスレッドは Bull argument JSON も貼り付ける必要があります。", ko: "메인 스레드는 Bull argument JSON도 붙여 넣어야 합니다." }) : "",
      role === "portfolio_manager" ? localized(run.language, { en: "The main thread must also paste Bull and Bear argument JSON.", zh: "主线程还必须粘贴 Bull 和 Bear argument JSON。", ja: "メインスレッドは Bull と Bear の argument JSON も貼り付ける必要があります。", ko: "메인 스레드는 Bull 및 Bear argument JSON도 붙여 넣어야 합니다." }) : "",
    ].filter(Boolean).join("\n"),
    output_contract: localized(run.language, { en: `Return one JSON debate packet with reader-facing fields in ${run.language}.`, zh: "只返回一个 JSON debate packet。", ja: "読者向けフィールドを日本語にした JSON debate packet を1つだけ返してください。", ko: "독자용 필드를 한국어로 작성한 JSON debate packet 하나만 반환하십시오." }),
  }));
  const verifier_agents = tripleVerificationRequired(run)
    ? REQUIRED_VERIFIER_IDS.map((verifier) => {
      const input = join(runPath(run.run_id), `verification.${verifier}.input.json`);
      return {
        role: verifier,
        title: `AlphaCouncil Agent ${run.symbol} ${verifier}`,
        prompt_template: verifierBatchPrompt(run, verifier, input),
        output_contract: localized(run.language, {
          en: "Return one verifier-batch JSON with exactly one result for every frozen material claim. Record it with record_verifier_batch before any method seat runs.",
          zh: "只返回一个 verifier-batch JSON，必须逐条覆盖全部冻结的重大论断；任何方法席运行前先用 record_verifier_batch 记录。",
          ja: "凍結された全重要主張を1件ずつ網羅する verifier-batch JSON を1つ返し、メソッド席より先に record_verifier_batch で記録してください。",
          ko: "동결된 모든 중요 주장에 정확히 하나씩 결과를 내는 verifier-batch JSON 하나를 반환하고 방법론 좌석 전에 record_verifier_batch로 기록하십시오.",
        }),
      };
    })
    : [];
  // The deterministic pass freezes every physical v3 stance before language generation.
  // Visible v3 workers below may explain that frozen result after evidence completes, but
  // cannot turn an out_of_scope method into a directional vote.
  const plan = planMasterSeats(run, selectedMasters(run));
  run.master_decisions = plan.decisions;
  run.fact_pack_hash = plan.shared_fact_pack_hash;
  run.master_runtime_provenance = masterRuntimeProvenance(run, plan);
  const zh = isChineseLanguage(run.language);
  const master_agents = plan.to_run.map(({ id, decision, engine }) => ({
    role: id,
    engine: engine || (decision ? "v2_method_model" : "v1_prompt"),
    title: `AlphaCouncil Agent ${run.symbol} ${id}`,
    prompt_template: [
      masterPrompt(id, run),
      "",
      decision ? deterministicVerdictBlock(decision, zh) : "",
      "",
      localized(run.language, {
        en: "The main thread must paste the completed Evidence JSON first. Masters run after the evidence stage and before the debate.",
        zh: "主线程必须先粘贴已完成的 Evidence JSON，再运行这个大师议席；大师在证据之后、辩论之前运行。",
        ja: "メインスレッドは先に完成済みの Evidence JSON を貼り付ける必要があります。メソッド席は証拠段階の後、討論の前に実行します。",
        ko: "메인 스레드는 먼저 완료된 Evidence JSON을 붙여 넣어야 합니다. 방법론 좌석은 증거 단계 이후, 토론 이전에 실행합니다.",
      }),
    ].filter(Boolean).join("\n"),
    output_contract: localized(run.language, {
      en: `Return one JSON master opinion with reader-facing fields in ${run.language}.`,
      zh: "只返回一个 JSON master opinion。",
      ja: "読者向けフィールドを日本語にした JSON master opinion を1つだけ返してください。",
      ko: "독자용 필드를 한국어로 작성한 JSON master opinion 하나만 반환하십시오.",
    }),
  }));
  // Persist the deterministic fallback before the visible worker runs. It remains auditable
  // if the host fails, but a full visible PM now waits for the returned explanation worker.
  if (plan.declined.length) {
    const byId = new Map((run.master_opinions || []).map((o) => [o.master, o]));
    for (const item of plan.declined) {
      if (!byId.has(item.id)) {
        const fallback = declinedMasterOpinion(run, item);
        byId.set(item.id, attachMasterRuntimeProvenance(
          run,
          item.id,
          {
            ...fallback,
            voice_statement: fallback.voice_statement || fallback.summary || fallback.verdict,
            voice_status: fallback.voice_status || "deterministic_fallback",
            statement_origin: fallback.statement_origin || "deterministic_scope_fallback",
          },
          item.engine,
        ));
      }
      // An abstention is still a method result. It must read the shared dossier and explain in
      // that method's own first-person reasoning why the available facts do not open its gate.
      const requiresVisibleVoice = needsMethodVoiceWorker(byId.get(item.id), { run });
      const alreadyVoiced = run.master_status?.[item.id]?.status === "completed"
        && byId.get(item.id)?.voice_status === "completed";
      const completed = alreadyVoiced || !requiresVisibleVoice;
      run.master_status[item.id] = {
        ...(run.master_status[item.id] || {}),
        master: item.id,
        status: completed ? "completed" : "waiting",
        engine: item.engine || "v2_method_model",
        deterministic_decline: true,
        voice_required: requiresVisibleVoice,
        completed_at: completed
          ? (run.master_status[item.id]?.completed_at || new Date().toISOString())
          : null,
      };
    }
    run.master_opinions = selectedMasters(run).map((id) => byId.get(id)).filter(Boolean);
  }
  if (plan.completed.length) {
    const byId = new Map((run.master_opinions || []).map((opinion) => [opinion.master, opinion]));
    for (const item of plan.completed) {
      if (!byId.has(item.id)) {
        byId.set(item.id, attachMasterRuntimeProvenance(
          run,
          item.id,
          completedMasterOpinion(run, item),
          item.engine,
        ));
      }
      // A seat that executed its policy and still abstained is in the same position as a
      // declined seat: the frozen stance is out_of_scope, no worker may change it, and the
      // deterministic statement already names the gate that closed and says an abstention is
      // not a bearish vote. Only seats that reached a stance have a reading to explain.
      const requiresVisibleVoice = needsMethodVoiceWorker(byId.get(item.id), { run });
      const alreadyVoiced = run.master_status?.[item.id]?.status === "completed"
        && byId.get(item.id)?.voice_status === "completed";
      run.master_status[item.id] = {
        ...(run.master_status[item.id] || {}),
        master: item.id,
        status: alreadyVoiced || !requiresVisibleVoice ? "completed" : "waiting",
        engine: item.engine,
        deterministic_execution: true,
        voice_required: requiresVisibleVoice,
        completed_at: alreadyVoiced || !requiresVisibleVoice
          ? (run.master_status[item.id]?.completed_at || new Date().toISOString())
          : null,
      };
    }
    run.master_opinions = selectedMasters(run).map((id) => byId.get(id)).filter(Boolean);
  }
  for (const item of plan.blocked) {
    run.master_status[item.id] = {
      ...(run.master_status[item.id] || {}),
      master: item.id,
      status: "failed",
      engine: item.engine,
      error: item.reason,
      error_code: item.error_code || "V3_POLICY_EXECUTION_FAILED",
      diagnostic: item.error || undefined,
      updated_at: new Date().toISOString(),
    };
  }
  const frozenById = new Map((run.master_opinions || []).map((opinion) => [opinion.master, opinion]));
  const v3VoiceAgents = [...plan.declined, ...plan.completed]
    .filter((item) => item.engine === "v3_method_runtime")
    .filter((item) => run.master_status?.[item.id]?.status !== "completed")
    .filter((item) => needsMethodVoiceWorker(frozenById.get(item.id), { run }))
    .map((item) => {
      const frozenOpinion = frozenById.get(item.id);
      return {
        role: item.id,
        engine: "v3_method_runtime",
        worker_kind: "visible_method_voice",
        frozen_stance: frozenOpinion?.stance || "out_of_scope",
        title: `AlphaCouncil Agent ${run.symbol} ${item.id} method-seat explanation`,
        prompt_template: [
          masterVoicePrompt(item.id, run, frozenOpinion),
          localized(run.language, {
            en: "The main thread MUST append the completed Evidence JSON before launching this visible worker. Use it only to explain or challenge analyst interpretation; never change the frozen stance or add a fact.",
            zh: "主线程必须在启动这个可见方法席前附上已完成的 Evidence JSON。它只能用于解释或质疑分析师解读；不得改变冻结立场，也不得新增事实。",
            ja: "メインスレッドは、この可視メソッド席を起動する前に完成済み Evidence JSON を追加してください。分析担当の解釈を説明・検討する目的だけに使い、凍結済みスタンスの変更や事実追加は禁止です。",
            ko: "메인 스레드는 이 표시형 방법론 좌석을 시작하기 전에 완료된 Evidence JSON을 추가해야 합니다. 분석가 해석을 설명·검토하는 데만 사용하고 동결된 입장을 바꾸거나 사실을 추가하지 마십시오.",
          }),
        ].join("\n\n"),
        output_contract: localized(run.language, {
          en: "Return one JSON method voice with the exact voice_mode and disclosure_ack from the prompt, position_intent, all five first-person voice fields, key_findings, disagreements, what_would_change_my_mind, source_ids and confidence. master and acknowledged_stance must equal the frozen record.",
          zh: "只返回一个 JSON 方法席陈词：使用提示中的精确 voice_mode 与 disclosure_ack，并包含 position_intent、全部五个强第一人称 voice 字段、key_findings、disagreements、what_would_change_my_mind、source_ids、confidence；master 与 acknowledged_stance 必须等于冻结记录。",
          ja: "プロンプト指定の voice_mode と disclosure_ack、position_intent、5つすべての一人称 voice フィールド、key_findings、disagreements、what_would_change_my_mind、source_ids、confidence を持つ JSON を1つだけ返してください。master と acknowledged_stance は凍結済み記録と一致させます。",
          ko: "프롬프트의 정확한 voice_mode와 disclosure_ack, position_intent, 5개 모두의 1인칭 voice 필드, key_findings, disagreements, what_would_change_my_mind, source_ids, confidence를 가진 JSON 하나만 반환하십시오. master와 acknowledged_stance는 동결 기록과 같아야 합니다.",
        }),
      };
    });
  master_agents.push(...v3VoiceAgents);
  const orderedMasterAgents = selectedMasters(run)
    .map((id) => master_agents.find((agent) => agent.role === id))
    .filter(Boolean);
  saveRun(run);
  const prompts = externalizeVisiblePrompts(run, [
    { kind: "evidence", agents: evidence_agents },
    { kind: "verifier", agents: verifier_agents },
    { kind: "master", agents: orderedMasterAgents },
    { kind: "debate", agents: debate_agents },
  ]);
  return {
    // Every planned prompt is on disk either way. `prompts_inline` says whether this result
    // also carries them, so a host never has to guess whether `prompt_template` is missing
    // because the plan failed or because it was too large to return.
    prompts_inline: prompts.inline,
    prompt_dir: prompts.prompt_dir,
    prompt_chars_total: prompts.prompt_chars_total,
    evidence_agents: prompts.byKind.get("evidence"),
    verifier_agents: prompts.byKind.get("verifier"),
    master_agents: prompts.byKind.get("master"),
    debate_agents: prompts.byKind.get("debate"),
    // Recorded, not hidden: a reader must be able to tell a method that judged from a method
    // that could not look, and neither from a seat that was never offered.
    master_decisions: plan.decisions,
    masters_declined: plan.declined.map((item) => {
      const opinion = declinedMasterOpinion(run, item);
      return {
        master: item.id,
        engine: item.engine || opinion.engine,
        stance: opinion.stance,
        reason: opinion.decision_reason,
        unmet: item.preDecision?.eligibility?.missing_required_fact_types
          || item.decision?.eligibility?.unmet
          || [],
      };
    }),
    masters_completed: plan.completed.map((item) => ({
      master: item.id,
      engine: item.engine,
      stance: item.decision.stance,
      reason: item.decision.reason,
      policy_execution_hash: item.decision.policy_execution_hash,
      frozen_decision_hash: item.frozenDecision.frozen_decision_hash,
    })),
    masters_blocked: plan.blocked.map((item) => ({
      master: item.id,
      engine: item.engine,
      reason: item.reason,
      error: item.error || null,
    })),
  };
}

/**
 * Total prompt characters a visible plan may return inline.
 *
 * The plan carries one full prompt per agent, and every prompt embeds the grounding and
 * evidence JSON. A real eight-seat run returned 311,007 characters in a single tool result and
 * the host rejected the whole thing for exceeding its result ceiling -- the plan was produced
 * correctly and then thrown away. Below this budget nothing changes for an existing host;
 * above it the prompts move to disk and each agent carries the path instead.
 */
const VISIBLE_PLAN_INLINE_PROMPT_CHARS = 120000;

/**
 * The size that decides this is the grounding each prompt embeds, not the number of seats: a
 * bench-wide plan with no grounding is well inside the budget, while eight seats against a
 * full macro series is what produced the 311k result. Operators may lower the budget for a
 * host with a tighter ceiling; they may not raise it past what that host would reject anyway.
 */
function inlinePromptBudget(env = process.env) {
  const requested = Number(env?.ALPHACOUNCIL_VISIBLE_INLINE_PROMPT_CHARS);
  if (!Number.isFinite(requested) || requested < 0) return VISIBLE_PLAN_INLINE_PROMPT_CHARS;
  return Math.min(requested, VISIBLE_PLAN_INLINE_PROMPT_CHARS);
}

/**
 * Write every planned prompt to the run directory, and drop the inline copies when returning
 * them all at once would exceed what a host will accept.
 */
function externalizeVisiblePrompts(run, groups) {
  const dir = join(runPath(run.run_id), "prompts");
  mkdirSync(dir, { recursive: true });
  // Roles are generated ids, but a filename is still a filename: keep it to one path segment.
  const fileSafe = (role) => String(role || "agent").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "agent";
  // Evidence agents carry `prompt`; master and debate agents carry `prompt_template`. Reading
  // only one of them wrote empty files for the other group.
  const promptKey = (agent) => (typeof agent.prompt_template === "string" ? "prompt_template" : "prompt");
  const total = groups.reduce((sum, { agents }) => sum + agents
    .reduce((inner, agent) => inner + String(agent[promptKey(agent)] || "").length, 0), 0);
  // An operating-company full run cannot return downstream inline prompts before the dossier
  // exists: those strings would remain stale after the evidence barrier. Force prompt-file
  // delivery so the host reads the refreshed, hash-bound version only after evidence completes.
  const inline = total <= inlinePromptBudget() && !requiresOperatingCompanyDossier(run);
  const externalized = groups.map(({ kind, agents }) => ({
    kind,
    agents: agents.map((agent) => {
      const key = promptKey(agent);
      const file = join(dir, `${kind}.${fileSafe(agent.role)}.prompt.md`);
      const prompt = String(agent[key] || "");
      writeFileSync(file, prompt.endsWith("\n") ? prompt : `${prompt}\n`, { encoding: "utf8", mode: 0o600 });
      return {
        ...agent,
        prompt_file: file,
        prompt_chars: prompt.length,
        ...(inline ? {} : { [key]: null }),
      };
    }),
  }));
  return {
    inline,
    prompt_dir: dir,
    prompt_chars_total: total,
    byKind: new Map(externalized.map(({ kind, agents }) => [kind, agents])),
  };
}

/**
 * The stance is already decided. The prompt says so, in the run's language, so the model
 * writes an explanation rather than a verdict.
 */
function deterministicVerdictBlock(decision, zh) {
  const hits = (decision.score?.hits || []).map((h) => `${h.id}=${h.actual} (>=${h.threshold}, +${h.points})`).join("; ") || "none";
  const misses = (decision.score?.misses || []).map((m) => `${m.id}=${m.actual}`).join("; ") || "none";
  const uncomputable = (decision.score?.uncomputable || []).map((u) => u.id).join("; ") || "none";
  return zh
    ? [
      "## 已确定的判决（由确定性政策产生，你不能推翻）",
      `- 立场：${decision.stance}（依据：${decision.reason}）`,
      `- 得分：${decision.score?.score ?? "—"}/${decision.score?.max_possible ?? "—"}，覆盖率 ${Math.round((decision.score?.coverage || 0) * 100)}%`,
      `- 命中：${hits}`,
      `- 未命中：${misses}`,
      `- 无法计算（既不算命中也不算未命中）：${uncomputable}`,
      "",
      "你的任务是解释这个判决为什么成立、它最可能错在哪里、以及什么证据会推翻它。**不要给出与上面不同的 stance**；如果你认为它错了，把理由写进 disagreements。",
    ].join("\n")
    : [
      "## Settled verdict (produced by the deterministic policy; you cannot overturn it)",
      `- Stance: ${decision.stance} (basis: ${decision.reason})`,
      `- Score: ${decision.score?.score ?? "—"}/${decision.score?.max_possible ?? "—"}, coverage ${Math.round((decision.score?.coverage || 0) * 100)}%`,
      `- Hits: ${hits}`,
      `- Misses: ${misses}`,
      `- Uncomputable (neither a hit nor a miss): ${uncomputable}`,
      "",
      "Explain why this verdict holds, where it is most likely wrong, and what evidence would overturn it. **Do not return a different stance**; if you think it is wrong, put the reason in disagreements.",
    ].join("\n");
}

export function recordMasterOpinion(args) {
  const run = readJson(join(runPath(args.run_id), "evidence.json"));
  if (run.execution_mode !== "visible_host_threads") {
    throw invalidParams("record_master_opinion requires a run created by plan_visible_run.");
  }
  assertVisibleRunOpen(run, "record a master opinion");
  const allowed = selectedMasters(run);
  if (!allowed.includes(args.master)) {
    throw invalidParams(`master ${args.master} was not selected for this run. Selected: ${allowed.join(", ") || "none"}`);
  }
  const missingEvidence = (run.tasks || []).filter((task) => taskState(run, task).status !== "completed");
  if (missingEvidence.length) {
    throw invalidParams("record_master_opinion rejected: every planned evidence packet must complete first.", {
      reason: "VISIBLE_MASTER_EVIDENCE_INCOMPLETE",
      run_id: run.run_id,
      missing_evidence: missingEvidence,
    });
  }
  const dossierCoverage = companyDossierCoverageStatus(run);
  if (dossierCoverage.required && !dossierCoverage.decision_barrier_ready) {
    throw invalidParams("record_master_opinion rejected: shared company dossier is incomplete or insufficient for a decision.", {
      reason: "VISIBLE_MASTER_DOSSIER_NOT_DECISION_READY",
      run_id: run.run_id,
      coverage: dossierCoverage,
    });
  }
  const verifierGate = verificationStatus(run);
  if (verifierGate.verification === "needs_verification") {
    throw invalidParams("record_master_opinion rejected: the required source/triple-verification gate has not passed.", {
      reason: "VISIBLE_MASTER_VERIFICATION_INCOMPLETE",
      run_id: run.run_id,
      verification: verifierGate,
    });
  }
  const dir = runPath(run.run_id);
  const frozenOpinion = (run.master_opinions || []).find((item) => item.master === args.master);
  const v3Voice = frozenOpinion?.engine === "v3_method_runtime"
    || run.master_runtime_provenance?.[args.master]?.engine === "v3_method_runtime";
  let opinion;
  let overridden = false;
  if (v3Voice) {
    if (!frozenOpinion) throw invalidParams(`v3 master ${args.master} has no frozen deterministic opinion.`);
    if (args.packet?.master !== args.master || args.packet?.acknowledged_stance !== frozenOpinion.stance) {
      throw invalidParams("visible v3 method voice must acknowledge the exact frozen master and stance.", {
        reason: "VISIBLE_MASTER_FROZEN_STANCE_MISMATCH",
        run_id: run.run_id,
        master: args.master,
        expected_stance: frozenOpinion.stance,
        supplied_master: args.packet?.master || null,
        supplied_stance: args.packet?.acknowledged_stance || null,
      });
    }
    const validatedVoice = assertRuntimeClientPayload("method_voice", args.packet, {
      run_id: run.run_id,
      master: args.master,
    });
    assertCompanyDossierAck(validatedVoice, run, `visible master voice ${args.master}`, { client: true });
    const voice = normalizeMasterVoice(
      validatedVoice,
      args.master,
      run,
      frozenOpinion,
      rawRecordText(args.packet),
    );
    assertVisibleReaderLanguage([
      voice.statement,
      ...(voice.key_findings || []),
      ...(voice.disagreements || []),
      ...(voice.what_would_change_my_mind || []),
    ].filter(Boolean).join("\n"), run, `visible master voice ${args.master}`);
    opinion = attachMasterRuntimeProvenance(run, args.master, {
      ...frozenOpinion,
      deterministic_summary: frozenOpinion.deterministic_summary || frozenOpinion.summary,
      summary: voice.statement,
      voice_statement: voice.statement,
      voice: voice.voice,
      position_intent: voice.position_intent,
      voice_mode: voice.voice_mode,
      disclosure_ack: voice.disclosure_ack,
      disclosure: voice.disclosure,
      voice_status: "completed",
      voice_language: run.language,
      statement_origin: "visible_method_voice_worker",
      key_findings: voice.key_findings.length ? voice.key_findings : frozenOpinion.key_findings,
      disagreements: voice.disagreements,
      what_would_change_my_mind: voice.what_would_change_my_mind.length
        ? voice.what_would_change_my_mind
        : frozenOpinion.what_would_change_my_mind,
      source_ids: [...new Set([...(frozenOpinion.source_ids || []), ...voice.source_ids])],
      evidence_source_ids: [...new Set([...(frozenOpinion.source_ids || []), ...voice.source_ids])],
      confidence: voice.confidence,
      company_dossier_hash_ack: voice.company_dossier_hash_ack,
      evidence_packet_acks: voice.evidence_packet_acks,
      thread_id: args.thread_id,
      dedicated_worker: {
        status: "completed",
        language: run.language,
        execution_mode: "visible_host_thread",
        thread_id: args.thread_id,
      },
    }, "v3_method_runtime");
  } else {
    const normalized = normalizeMasterOpinion(
      { ...(args.packet || {}), thread_id: args.thread_id },
      args.master,
      run,
      rawRecordText(args.packet),
    );
    assertVisibleReaderLanguage(masterReaderText(normalized), run, `visible master ${args.master}`);
    // A narrated stance that disagrees with the arithmetic does not get to win quietly. The
    // deterministic verdict stands and the disagreement is preserved on the record.
    const reconciled = reconcileMasterOpinion(run, args.master, normalized);
    opinion = attachMasterRuntimeProvenance(run, args.master, {
      ...reconciled.opinion,
      voice_statement: reconciled.opinion.voice_statement
        || reconciled.opinion.summary
        || reconciled.opinion.verdict,
      voice_status: "completed",
      voice_language: run.language,
      statement_origin: "visible_legacy_method_worker",
    }, reconciled.engine);
    overridden = reconciled.overridden;
  }
  const byId = new Map((run.master_opinions || []).map((item) => [item.master, item]));
  byId.set(args.master, opinion);
  run.master_opinions = allowed.map((id) => byId.get(id)).filter(Boolean);
  run.master_status = run.master_status || {};
  run.master_status[args.master] = {
    ...(run.master_status[args.master] || {}),
    master: args.master,
    status: "completed",
    company_dossier_hash_ack: opinion.company_dossier_hash_ack || null,
    evidence_packet_ack_count: Array.isArray(opinion.evidence_packet_acks)
      ? opinion.evidence_packet_acks.length
      : 0,
    evidence_packet_ack_statuses: Array.isArray(opinion.evidence_packet_acks)
      ? Object.fromEntries(opinion.evidence_packet_acks.map((ack) => [ack.task, ack.status]))
      : {},
    completed_at: new Date().toISOString(),
  };
  writeJson(join(dir, `${args.master}.json`), opinion);
  saveRun(run);
  writeJson(join(dir, "evidence.json"), run);
  appendEvent(run, "master_opinion_recorded", { master: args.master, stance: opinion.stance, overridden });
  return { run, opinion, overridden, recorded: run.master_opinions.length, expected: allowed.length };
}

export function visibleStatusAfterPacket(run) {
  if (agentState(run, "portfolio_manager").status === "completed") {
    let finished;
    if (completenessStatus(run).completeness === "incomplete") finished = "incomplete";
    else if (verificationStatus(run).verification === "needs_verification") finished = "needs_verification";
    else if (run.report_quality?.status === "needs_revision") finished = "needs_revision";
    else finished = "complete";
    return { status: finished, phase: finished, completed_at: run.completed_at || new Date().toISOString() };
  }
  if (DEBATE_ROLES.some((role) => agentState(run, role).status === "completed")) {
    return { status: "running", phase: "visible_debate", completed_at: null };
  }
  return { status: "running", phase: "visible_evidence", completed_at: null };
}

export function recordVisiblePacket(args) {
  const run = readJson(join(runPath(args.run_id), "evidence.json"));
  if (run.execution_mode !== "visible_host_threads") {
    throw invalidParams("record_visible_packet requires a run created by plan_visible_run.");
  }
  assertVisibleRunOpen(run, "record a visible evidence packet");
  const task = args.task;
  if (!run.tasks.includes(task)) throw invalidParams(`Unknown task for this run: ${task}`);
  const dir = runPath(run.run_id);
  const evidenceKind = task === "news_industry_management" ? "news_evidence" : "evidence";
  const validated = assertRuntimeClientPayload(evidenceKind, args.packet, {
    run_id: run.run_id,
    task,
  });
  const packet = normalizePacket({
    ...validated,
    thread_id: args.thread_id,
    thread_title: args.thread_title,
    execution_mode: "visible_host_threads",
  }, task, run.symbol, run.as_of, rawRecordText(args.packet));
  applyGroundedRegulatorCoverage(packet, { task, asOfDate: run.as_of, grounding: run.grounding });
  assertOfficialSourceCoverage(packet, { task, asOfDate: run.as_of, grounding: run.grounding });
  assertCompanyCoveragePacket(packet, run, { client: true });
  assertCompanySourceAcquisition(packet, run, { client: true });
  assertVisibleReaderLanguage(visibleEvidenceReaderText(packet), run, `visible evidence ${task}`);
  const existingPacket = (run.packets || []).find((item) => item.task === task);
  if (taskState(run, task).status === "completed" && existingPacket) {
    const existingHash = companyEvidencePacketHash(existingPacket);
    const suppliedHash = companyEvidencePacketHash(packet);
    if (existingHash === suppliedHash) {
      appendEvent(run, "visible_evidence_replay_ignored", { task, packet_hash: existingHash });
      return run;
    }
    throw invalidParams(`visible evidence ${task} is already frozen; conflicting content requires a new run.`, {
      reason: "VISIBLE_EVIDENCE_PACKET_CONFLICT",
      run_id: run.run_id,
      task,
      frozen_packet_hash: existingHash,
      supplied_packet_hash: suppliedHash,
      company_dossier_hash: run.company_dossier?.content_hash || null,
    });
  }
  const byTask = new Map(run.packets.map((item) => [item.task, item]));
  byTask.set(task, packet);
  run.packets = run.tasks.map((item) => byTask.get(item)).filter(Boolean);
  const observationResult = recordCompanyAcquisitionObservations({
    symbol: run.symbol,
    task,
    ledger: packet.acquisition_ledger,
  });
  Object.assign(run, visibleStatusAfterPacket(run));
  writeJson(join(dir, `${task}.json`), packet);
  saveRun(run);
  updateTask(run, task, "completed", {
    completed_at: new Date().toISOString(),
    thread_id: args.thread_id,
    thread_title: args.thread_title,
    output: join(dir, `${task}.json`),
    acquisition_observations_recorded: observationResult.recorded || 0,
  });
  const allEvidenceRecorded = (run.tasks || []).every((item) => taskState(run, item).status === "completed");
  if (allEvidenceRecorded) {
    const dossierRef = materializeCompanyDossier(run);
    if (dossierRef) {
      bindVisibleMastersToCompanyDossier(run);
      initializeVerificationPolicy(run);
      const refreshed = refreshVisibleDownstreamPromptFiles(run);
      appendEvent(run, "company_dossier_ready", {
        contract_id: dossierRef.contract_id,
        content_hash: dossierRef.content_hash,
        retrieval_status: dossierRef.retrieval_status,
        sufficiency: dossierRef.sufficiency,
        decision_barrier_ready: dossierRef.decision_barrier_ready,
        unavailable_count: dossierRef.unavailable_count,
        refreshed_prompt_count: refreshed.length,
      });
    } else {
      initializeVerificationPolicy(run);
      refreshVisibleDownstreamPromptFiles(run);
    }
    run.status = "running";
    run.phase = tripleVerificationRequired(run) ? "visible_verification" : "visible_methods";
    saveRun(run);
  }
  writeJson(join(dir, "evidence.json"), run);
  writeAnalystMarkdownFiles(run, existingDebate(dir));
  writeArtifactIndex(run, existingDebate(dir));
  writeAllAgentsMarkdown(run, existingDebate(dir));
  return run;
}

function visibleDebateState(run) {
  const expected = run.council_mode === "quick" ? 1 : 3;
  run.visible_debate = run.visible_debate && typeof run.visible_debate === "object"
    ? run.visible_debate
    : {};
  run.visible_debate.contract = "role_round_audit_v1";
  run.visible_debate.rounds_expected = expected;
  run.visible_debate.rounds = run.visible_debate.rounds && typeof run.visible_debate.rounds === "object"
    ? run.visible_debate.rounds
    : {};
  for (const role of ["bull_researcher", "bear_researcher"]) {
    run.visible_debate.rounds[role] = run.visible_debate.rounds[role]
      && typeof run.visible_debate.rounds[role] === "object"
      ? run.visible_debate.rounds[role]
      : {};
  }
  run.visible_debate.qna_gate = run.visible_debate.qna_gate && typeof run.visible_debate.qna_gate === "object"
    ? run.visible_debate.qna_gate
    : { status: expected === 1 ? "not_run" : "pending", errors: [] };
  return run.visible_debate;
}

function visibleRoundEntry(state, role, round) {
  return state?.rounds?.[role]?.[String(round)] || null;
}

function visibleRoundPacket(state, role, round) {
  return visibleRoundEntry(state, role, round)?.packet || null;
}

function visibleRoundNumbers(state, role) {
  return Object.keys(state?.rounds?.[role] || {})
    .map(Number)
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
}

function visibleDecisionContentHash(packet) {
  const content = JSON.parse(JSON.stringify(packet || {}));
  delete content.raw_text;
  delete content.thread_id;
  delete content.thread_title;
  delete content.execution_mode;
  return sha256(content);
}

function roundGateArgs(state, role, round, candidate) {
  const get = (candidateRole, candidateRound) => (
    candidateRole === role && candidateRound === round
      ? candidate
      : visibleRoundPacket(state, candidateRole, candidateRound)
  );
  return {
    bullR2: get("bull_researcher", 2),
    bearR2: get("bear_researcher", 2),
    bullR3: get("bull_researcher", 3),
    bearR3: get("bear_researcher", 3),
  };
}

function rejectVisibleDecision(run, reason, message, data = {}) {
  throw invalidParams(message, { reason, run_id: run.run_id, ...data });
}

function assertVisibleRoundOrder(run, state, role, round) {
  if (round === 1) return;
  const previous = round - 1;
  const missing = ["bull_researcher", "bear_researcher"]
    .filter((side) => !visibleRoundEntry(state, side, previous))
    .map((side) => `${side}:${previous}`);
  if (missing.length) {
    rejectVisibleDecision(
      run,
      "VISIBLE_DEBATE_ROUND_OUT_OF_ORDER",
      `Cannot record ${role} round ${round} before both round ${previous} packets are recorded.`,
      { role, round, missing_prerequisite_rounds: missing },
    );
  }
}

function assertVisibleRoundQna(run, state, role, round, packet) {
  if (run.council_mode === "quick" || round === 1) return;
  const gate = debateQnaGate(roundGateArgs(state, role, round, packet));
  const ownErrors = gate.errors.filter((error) => error.startsWith(`${role} round ${round}`));
  if (ownErrors.length) {
    rejectVisibleDecision(
      run,
      "VISIBLE_DEBATE_QNA_INVALID",
      `Rejected ${role} round ${round}: ${ownErrors.join("; ")}`,
      { role, round, qna_gate: { status: "failed", errors: ownErrors } },
    );
  }
  const other = role === "bull_researcher" ? "bear_researcher" : "bull_researcher";
  if (round === 3 && visibleRoundEntry(state, other, 3) && gate.status !== "passed") {
    rejectVisibleDecision(
      run,
      "VISIBLE_DEBATE_QNA_INVALID",
      `Rejected ${role} round 3 because the completed cross-exam failed the exact Q&A gate.`,
      { role, round, qna_gate: gate },
    );
  }
}

function visibleRoundAgentPatch(run, state, role) {
  const dir = runPath(run.run_id);
  const rounds = visibleRoundNumbers(state, role);
  const latest = rounds.length ? visibleRoundEntry(state, role, rounds.at(-1)) : null;
  return {
    rounds_completed: rounds,
    last_completed_round: rounds.at(-1) || null,
    round_status: rounds.length ? "completed" : "pending",
    qna_gate: state.qna_gate.status,
    thread_id: latest?.thread_id,
    thread_title: latest?.thread_title,
    output: join(dir, `${role}.json`),
  };
}

function recordVisibleDebateRound(run, args) {
  const role = args.role;
  const missingEvidence = (run.tasks || []).filter((task) => taskState(run, task).status !== "completed");
  const missingMasters = selectedMasters(run).filter((master) => masterSeatIncomplete(run, master));
  const dossierCoverage = companyDossierCoverageStatus(run);
  const dossierReady = !dossierCoverage.required || dossierCoverage.decision_barrier_ready;
  const verifierGate = verificationStatus(run);
  if (missingEvidence.length || missingMasters.length || !dossierReady
    || verifierGate.verification === "needs_verification") {
    rejectVisibleDecision(
      run,
      "VISIBLE_DEBATE_PREREQUISITES_INCOMPLETE",
      "Bull/Bear debate rejected: complete every evidence packet and returned method-seat worker first.",
      {
        missing_evidence: missingEvidence,
        missing_masters: missingMasters,
        company_dossier: dossierCoverage,
        verification: verifierGate,
      },
    );
  }
  const expected = run.council_mode === "quick" ? [1] : [1, 2, 3];
  if (!Number.isInteger(args.round) || !expected.includes(args.round)) {
    rejectVisibleDecision(
      run,
      "VISIBLE_DEBATE_ROUND_REQUIRED",
      `${role} requires an explicit round=${expected.join("|")}.`,
      { role, supplied_round: args.round ?? null, allowed_rounds: expected },
    );
  }
  const round = args.round;
  const dir = runPath(run.run_id);
  const state = visibleDebateState(run);
  const validated = assertRuntimeClientPayload("debate", args.packet, {
    run_id: run.run_id,
    role,
    round,
  });
  assertCompanyDossierAck(validated, run, `visible ${role} round ${round}`, { client: true });
  const source_ids = assertSourceIdsResolve(run, validated.source_ids, `${role} round ${round}`);
  const packet = {
    ...normalizeDebate({
      ...validated,
      source_ids,
      thread_id: args.thread_id,
      thread_title: args.thread_title,
      execution_mode: "visible_host_threads",
    }, role, run, rawRecordText(args.packet)),
    round,
    // A caller records exactly one round. Nested supplied rounds would create a second,
    // unaudited history inside the packet and are therefore discarded.
    debate_rounds: [],
  };
  assertVisibleReaderLanguage(debateReaderText(packet), run, `visible debate ${role} round ${round}`);
  const contentHash = visibleDecisionContentHash(packet);
  const existing = visibleRoundEntry(state, role, round);
  if (existing) {
    if (existing.content_hash !== contentHash) {
      rejectVisibleDecision(
        run,
        "VISIBLE_DEBATE_ROUND_CONFLICT",
        `Conflicting replay for ${role} round ${round}.`,
        { role, round, existing_content_hash: existing.content_hash, submitted_content_hash: contentHash },
      );
    }
    return { run, decision: existing.packet, idempotent_replay: true };
  }

  assertVisibleRoundOrder(run, state, role, round);
  assertVisibleRoundQna(run, state, role, round, packet);

  const completedAt = new Date().toISOString();
  const roundFile = join(dir, `${role}.round-${round}.json`);
  state.rounds[role][String(round)] = {
    round,
    role,
    content_hash: contentHash,
    packet,
    thread_id: args.thread_id,
    thread_title: args.thread_title,
    output: roundFile,
    completed_at: completedAt,
  };
  writeJson(roundFile, packet);
  const merged = mergeDebateRounds(visibleRoundNumbers(state, role)
    .map((item) => visibleRoundPacket(state, role, item)));
  writeJson(join(dir, `${role}.json`), merged);

  const quick = run.council_mode === "quick";
  const hasBothFinalRounds = ["bull_researcher", "bear_researcher"]
    .every((side) => visibleRoundEntry(state, side, quick ? 1 : 3));
  if (quick) {
    state.qna_gate = { status: "not_run", errors: [], checked_at: completedAt };
    updateAgent(run, role, "completed", {
      ...visibleRoundAgentPatch(run, state, role),
      completed_at: completedAt,
    });
  } else if (hasBothFinalRounds) {
    const qnaGate = debateQnaGate(roundGateArgs(state, role, round, packet));
    // The candidate was validated before persistence. This guard protects future state
    // migrations or a manually corrupted run file from manufacturing a passed audit.
    if (qnaGate.status !== "passed") {
      delete state.rounds[role][String(round)];
      rejectVisibleDecision(
        run,
        "VISIBLE_DEBATE_QNA_INVALID",
        "The completed visible cross-exam failed the exact Q&A gate.",
        { role, round, qna_gate: qnaGate },
      );
    }
    state.qna_gate = { ...qnaGate, checked_at: completedAt };
    for (const side of ["bull_researcher", "bear_researcher"]) {
      updateAgent(run, side, "completed", {
        ...visibleRoundAgentPatch(run, state, side),
        completed_at: completedAt,
      });
    }
    appendEvent(run, "debate_qna_gate", state.qna_gate);
  } else {
    updateAgent(run, role, "waiting", visibleRoundAgentPatch(run, state, role));
  }

  run.status = "running";
  run.phase = "visible_debate";
  run.completed_at = null;
  saveRun(run);
  appendEvent(run, "visible_debate_round_recorded", {
    role,
    round,
    content_hash: contentHash,
    output: roundFile,
    qna_gate: state.qna_gate.status,
  });
  writeAnalystMarkdownFiles(run, existingDebate(dir));
  writeArtifactIndex(run, existingDebate(dir));
  writeAllAgentsMarkdown(run, existingDebate(dir));
  return { run, decision: packet, idempotent_replay: false };
}

function visiblePmPrerequisites(run, state) {
  const missingEvidence = (run.tasks || [])
    .filter((task) => taskState(run, task).status !== "completed");
  const missingMasters = selectedMasters(run).filter((master) => masterSeatIncomplete(run, master));
  const expected = run.council_mode === "quick" ? [1] : [1, 2, 3];
  const missingRounds = ["bull_researcher", "bear_researcher"].flatMap((role) => (
    expected.filter((round) => !visibleRoundEntry(state, role, round)).map((round) => `${role}:${round}`)
  ));
  const missingSides = ["bull_researcher", "bear_researcher"]
    .filter((role) => agentState(run, role).status !== "completed");
  const qnaRequired = run.council_mode !== "quick";
  const dossier = companyDossierCoverageStatus(run);
  const dossierReady = !dossier.required || dossier.decision_barrier_ready;
  const verification = verificationStatus(run);
  return {
    missing_evidence: missingEvidence,
    missing_masters: missingMasters,
    missing_debate_rounds: missingRounds,
    missing_debate_sides: missingSides,
    qna_gate: state.qna_gate,
    company_dossier: dossier,
    verification,
    passed: missingEvidence.length === 0
      && missingMasters.length === 0
      && missingRounds.length === 0
      && missingSides.length === 0
      && dossierReady
      && verification.verification === "passed"
      && (!qnaRequired || state.qna_gate.status === "passed"),
  };
}

function recordVisiblePortfolioManager(run, args) {
  if (args.round !== undefined && args.round !== null) {
    rejectVisibleDecision(
      run,
      "VISIBLE_PM_ROUND_FORBIDDEN",
      "portfolio_manager is the final decision and does not accept a debate round.",
      { supplied_round: args.round },
    );
  }
  const dir = runPath(run.run_id);
  const state = visibleDebateState(run);
  // Validate the shared debate contract first so a missing/invalid rating can never be
  // normalized into Hold. report_markdown remains a role-specific gate immediately below.
  const validated = assertRuntimeClientPayload("debate", args.packet, {
    run_id: run.run_id,
    role: "portfolio_manager",
  });
  assertPriceLevelContinuity(validated.price_levels, { required: run.council_mode === "full" });
  assertCompanyDossierAck(validated, run, "visible portfolio_manager", { client: true });
  const source_ids = assertSourceIdsResolve(run, validated.source_ids, "portfolio_manager");
  const packet = normalizeDebate({
    ...validated,
    source_ids,
    thread_id: args.thread_id,
    thread_title: args.thread_title,
    execution_mode: "visible_host_threads",
  }, "portfolio_manager", run, rawRecordText(args.packet));
  assertVisibleReaderLanguage(debateReaderText(packet), run, "visible portfolio_manager decision");
  // Reject a report body that cannot pass the report gate before the packet takes the
  // idempotency lock, and say which headings are owed. Previously the gate ran only after the
  // report was assembled, so a submission with no `report_markdown` at all was accepted, the
  // report was built from the summary fallback, and the author learned about 21 missing
  // sections only after the entire PM turn had been spent.
  const authoredGaps = authoredReportSectionGaps(packet.report_markdown, run);
  if (authoredGaps.length) {
    rejectVisibleDecision(
      run,
      "VISIBLE_PM_REPORT_SECTIONS_MISSING",
      packet.report_markdown
        ? "portfolio_manager rejected: report_markdown does not carry every required report-contract section."
        : "portfolio_manager rejected: packet.report_markdown is required and must be the complete report body, not an execution note.",
      {
        report_contract: run.council_mode === "quick" ? "quick_v1" : "full_v2",
        report_markdown_characters: String(packet.report_markdown || "").length,
        gaps: authoredGaps,
        required_sections: requiredReportSectionAliases(run),
      },
    );
  }
  const contentHash = visibleDecisionContentHash(packet);
  if (state.portfolio_manager) {
    // A report that failed the structure gate must stay revisable. The first submission takes
    // the idempotency lock before the gate runs, so a PM whose report_markdown was thin left the
    // run stuck at needs_revision forever: the fix was rejected as a conflicting replay and there
    // was no other way in. A passed report is still frozen -- revision is for repairing a
    // rejected report, not for changing a verdict that already stands.
    const priorQualityPath = join(dir, "report_quality.json");
    const priorQuality = existsSync(priorQualityPath) ? readJson(priorQualityPath) : null;
    const revisable = priorQuality && priorQuality.status !== "passed";
    if (state.portfolio_manager.content_hash !== contentHash && !revisable) {
      rejectVisibleDecision(run, "VISIBLE_PM_CONFLICT", "Conflicting portfolio_manager replay.", {
        existing_content_hash: state.portfolio_manager.content_hash,
        submitted_content_hash: contentHash,
        report_quality: priorQuality?.status || null,
      });
    }
    // Revision accepted: drop the lock so the normal record path below runs again.
    if (state.portfolio_manager.content_hash !== contentHash) state.portfolio_manager = null;
  }
  if (state.portfolio_manager) {
    const debate = existingDebate(dir);
    const artifacts = commitFinalArtifacts(run, debate);
    return {
      run,
      decision: state.portfolio_manager.packet,
      idempotent_replay: true,
      ...artifacts,
    };
  }

  const prerequisites = visiblePmPrerequisites(run, state);
  if (!prerequisites.passed) {
    rejectVisibleDecision(
      run,
      "VISIBLE_PM_PREREQUISITES_INCOMPLETE",
      "portfolio_manager rejected: complete evidence, every selected master, all required bull/bear rounds, and the exact Q&A gate are mandatory first.",
      prerequisites,
    );
  }

  const completedAt = new Date().toISOString();
  const file = join(dir, "manager_synthesis.json");
  state.portfolio_manager = {
    content_hash: contentHash,
    packet,
    thread_id: args.thread_id,
    thread_title: args.thread_title,
    output: file,
    completed_at: completedAt,
  };
  writeJson(file, packet);
  writeJson(join(dir, "decision.json"), packet);
  updateAgent(run, "portfolio_manager", "completed", {
    completed_at: completedAt,
    thread_id: args.thread_id,
    thread_title: args.thread_title,
    output: file,
    debate_qna_gate: state.qna_gate.status,
  });

  const gate = verificationStatus(run);
  const completeness = completenessStatus(run);
  if (completeness.completeness === "incomplete") {
    // Defensive only: visiblePmPrerequisites rejects all known incomplete states before
    // this point. Never create a final report if a future completeness field disagrees.
    rejectVisibleDecision(run, "VISIBLE_PM_PREREQUISITES_INCOMPLETE", "portfolio_manager completeness gate failed.", {
      missing_evidence: completeness.missing_evidence,
      missing_debate: completeness.missing_debate,
      missing_masters: completeness.missing_masters,
    });
  }
  if (gate.verification === "needs_verification") {
    run.status = "needs_verification";
    run.phase = "needs_verification";
    appendEvent(run, "needs_verification", { missing: gate.missing_claim_source_ids.length });
  } else {
    run.status = "complete";
    run.phase = "complete";
  }
  run.completed_at = completedAt;
  saveRun(run);
  const finalArtifacts = commitFinalArtifacts(run, existingDebate(dir));
  return { run, decision: packet, idempotent_replay: false, ...finalArtifacts };
}

export function recordVisibleDecision(args) {
  const run = readJson(join(runPath(args.run_id), "evidence.json"));
  if (run.execution_mode !== "visible_host_threads") {
    throw invalidParams("record_visible_decision requires a run created by plan_visible_run.");
  }
  assertVisibleRunOpen(run, "record a visible decision");
  const role = args.role;
  if (!DEBATE_ROLES.includes(role)) throw invalidParams(`Unknown decision role: ${role}`);
  return role === "portfolio_manager"
    ? recordVisiblePortfolioManager(run, args)
    : recordVisibleDebateRound(run, args);
}

const VISIBLE_FINALIZE_REASONS = new Set([
  "host_cancelled",
  "host_timeout",
  "evidence_worker_failed",
  "verifier_worker_failed",
  "method_worker_failed",
  "debate_worker_failed",
  "host_unavailable",
]);

function finalizedVisibleReplay(run, idempotentReplay = true) {
  const dir = runPath(run.run_id);
  const managerPath = join(dir, "manager_synthesis.json");
  const manager = existsSync(managerPath) ? readJson(managerPath) : null;
  const artifacts = manager
    ? commitFinalArtifacts(run, { ...existingDebate(dir), manager })
    : { artifacts: artifactPaths(run) };
  return {
    run,
    decision: manager,
    idempotent_replay: idempotentReplay,
    ...artifacts,
  };
}

/**
 * Close a visible-host run that cannot cross its next hard gate.
 *
 * External threads cannot report transport failure through the normal record calls, and PM
 * correctly refuses to run while a selected seat is missing. Without this terminal path the
 * run stays `running` forever and no user_response.md exists, inviting the host to improvise a
 * shorter recap. Finalization preserves every completed record, marks only open work terminal,
 * creates a no-rating manager fallback, and returns the standard system-owned handoff. It never
 * creates a master opinion or directional stance for a failed seat.
 */
export function finalizeVisibleRun(args) {
  const run = readJson(join(runPath(args.run_id), "evidence.json"));
  if (run.execution_mode !== "visible_host_threads") {
    throw invalidParams("finalize_visible_run requires a run created by plan_visible_run.", {
      reason: "VISIBLE_FINALIZE_WRONG_EXECUTION_MODE",
      run_id: run.run_id,
    });
  }
  if (!VISIBLE_FINALIZE_REASONS.has(args.reason)) {
    throw invalidParams(`reason must be one of ${[...VISIBLE_FINALIZE_REASONS].join(", ")}.`, {
      reason: "VISIBLE_FINALIZE_REASON_INVALID",
      run_id: run.run_id,
    });
  }
  // Failure targets are sets, not ordered execution plans. Canonicalize them before hashing
  // so a host can replay the same finalization with a different array order.
  const unique = (values) => [...new Set(Array.isArray(values) ? values : [])].sort();
  const targets = {
    tasks: unique(args.failed_tasks),
    masters: unique(args.failed_masters),
    roles: unique(args.failed_roles),
  };
  const unknown = {
    tasks: targets.tasks.filter((id) => !(run.tasks || []).includes(id)),
    masters: targets.masters.filter((id) => !(run.masters || []).includes(id)),
    roles: targets.roles.filter((id) => !DEBATE_ROLES.includes(id)),
  };
  if (Object.values(unknown).some((ids) => ids.length)) {
    throw invalidParams("finalize_visible_run named a seat that is not part of this run.", {
      reason: "VISIBLE_FINALIZE_TARGET_INVALID",
      run_id: run.run_id,
      unknown,
    });
  }
  const canonicalRequest = { reason: args.reason, failed: targets };
  const requestHash = sha256(canonicalRequest);
  if (run.visible_finalization) {
    if (run.visible_finalization.request_hash !== requestHash) {
      throw invalidParams("Conflicting finalize_visible_run replay.", {
        reason: "VISIBLE_FINALIZE_CONFLICT",
        run_id: run.run_id,
        existing_request_hash: run.visible_finalization.request_hash,
        submitted_request_hash: requestHash,
      });
    }
    return finalizedVisibleReplay(run, true);
  }
  if (!["planned", "running"].includes(run.status)) {
    throw invalidParams(`Visible run ${run.run_id} is already terminal (${run.status}).`, {
      reason: "VISIBLE_FINALIZE_ALREADY_TERMINAL",
      run_id: run.run_id,
      status: run.status,
    });
  }

  const completedAt = new Date().toISOString();
  const terminal = new Set(["completed", "degraded", "failed", "timed_out", "skipped"]);
  const failureTerminal = new Set(["failed", "timed_out"]);
  const targetState = {
    tasks: (id) => run.task_status?.[id] || { task: id, status: "pending" },
    masters: (id) => run.master_status?.[id] || { master: id, status: "pending" },
    roles: (id) => run.agent_status?.[id] || { role: id, status: "pending" },
  };
  const notOpen = Object.fromEntries(Object.entries(targets).map(([kind, ids]) => [
    kind,
    ids.map((id) => ({ id, status: targetState[kind](id).status }))
      .filter(({ status }) => terminal.has(status) && !failureTerminal.has(status)),
  ]));
  if (Object.values(notOpen).some((items) => items.length)) {
    throw invalidParams("finalize_visible_run cannot relabel a completed, degraded, or skipped seat as failed.", {
      reason: "VISIBLE_FINALIZE_TARGET_NOT_OPEN",
      run_id: run.run_id,
      targets: notOpen,
    });
  }
  const closeStates = (states, ids, failed, identity) => Object.fromEntries(ids.map((id) => {
    const state = states?.[id] || { [identity]: id, status: "pending" };
    if (terminal.has(state.status)) return [id, state];
    const explicitlyFailed = failed.includes(id);
    return [id, {
      ...state,
      [identity]: id,
      status: explicitlyFailed ? "failed" : "skipped",
      error: `${explicitlyFailed ? "visible_finalize" : "visible_finalize_upstream"}:${args.reason}`,
      completed_at: completedAt,
      updated_at: completedAt,
    }];
  }));
  run.task_status = closeStates(run.task_status, run.tasks || [], targets.tasks, "task");
  run.master_status = closeStates(run.master_status, run.masters || [], targets.masters, "master");
  run.agent_status = closeStates(run.agent_status, DEBATE_ROLES, targets.roles, "role");
  run.status = "incomplete";
  run.phase = "incomplete";
  run.completed_at = completedAt;
  run.visible_finalization = {
    contract: "visible_finalize_v1",
    request_hash: requestHash,
    reason: args.reason,
    failed: targets,
    finalized_at: completedAt,
  };

  const dir = runPath(run.run_id);
  const manager = managerFallback(run, "");
  manager.failure_reason = `visible_host_${args.reason}`;
  manager.visible_finalization = run.visible_finalization;
  writeJson(join(dir, "manager_synthesis.json"), manager);
  writeJson(join(dir, "decision.json"), manager);
  const completeness = completenessStatus(run);
  appendEvent(run, "visible_run_finalized", {
    reason: args.reason,
    failed: targets,
    missing_evidence: completeness.missing_evidence,
    missing_masters: completeness.missing_masters,
    missing_debate: completeness.missing_debate,
  });
  saveRun(run);
  const debate = { ...existingDebate(dir), manager };
  const artifacts = commitFinalArtifacts(run, debate);
  return { run, decision: manager, idempotent_replay: false, ...artifacts };
}

export function isDryRun(args = {}) {
  return args.dry_run === true;
}

function boundedSchemaRepairIssues(errorOrIssues) {
  let source = Array.isArray(errorOrIssues)
    ? errorOrIssues
    : Array.isArray(errorOrIssues?.data?.errors) ? errorOrIssues.data.errors : [];
  if (!source.length && errorOrIssues?.data?.coverage) {
    const coverage = errorOrIssues.data.coverage;
    const seenCoverageInvalid = new Set();
    const uniqueCoverageInvalid = [];
    for (const issue of coverage.invalid || []) {
      const sourceIdentity = issue?.source_id
        || (Array.isArray(issue?.source_ids) ? issue.source_ids.join(",") : "")
        || issue?.id
        || "unknown";
      const key = `${issue?.reason || "coverage"}|${sourceIdentity}`;
      if (seenCoverageInvalid.has(key)) continue;
      seenCoverageInvalid.add(key);
      uniqueCoverageInvalid.push(issue);
    }
    source = [
      ...(coverage.missing || []).map((id) => ({
        path: `/coverage_items/${id}`,
        keyword: "required",
        message: "required coverage id is missing",
      })),
      ...(coverage.duplicates || []).map((id) => ({
        path: `/coverage_items/${id}`,
        keyword: "unique",
        message: "coverage id appears more than once",
      })),
      ...(coverage.unexpected || []).map((id) => ({
        path: `/coverage_items/${id}`,
        keyword: "unexpected",
        message: "coverage id is not owned by this task",
      })),
      ...uniqueCoverageInvalid.map((issue) => ({
        path: `/coverage_items/${issue?.id || "unknown"}`,
        keyword: issue?.reason || "coverage",
        message: [
          issue?.reason || "coverage validation failed",
          issue?.source_id ? `source_id=${issue.source_id}` : "",
          Array.isArray(issue?.source_ids) ? `source_ids=${issue.source_ids.join(",")}` : "",
        ].filter(Boolean).join("; "),
      })),
    ];
  }
  return source.slice(0, 8).map((issue) => ({
    path: cleanLog(String(issue?.path || "/"), 240),
    keyword: cleanLog(String(issue?.keyword || "schema"), 80),
    message: cleanLog(String(issue?.message || "validation failed"), 240),
    ...(typeof issue?.missing_property === "string"
      ? { missing_property: cleanLog(issue.missing_property, 120) }
      : {}),
  }));
}

function boundedVerifierCoverageProblems(error, limit = 80) {
  const problems = Array.isArray(error?.data?.problems) ? error.data.problems : [];
  return problems.slice(0, limit).map((problem) => ({
    ...(problem?.claim_id ? { claim_id: cleanLog(String(problem.claim_id), 120) } : {}),
    reason: cleanLog(String(problem?.reason || "verification_problem"), 160),
    ...(problem?.verdict ? { verdict: cleanLog(String(problem.verdict), 80) } : {}),
    ...(Array.isArray(problem?.missing_urls)
      ? { missing_urls: problem.missing_urls.slice(0, 12).map((url) => cleanLog(String(url), 500)) }
      : {}),
    ...(Array.isArray(problem?.urls)
      ? { urls: problem.urls.slice(0, 12).map((url) => cleanLog(String(url), 500)) }
      : {}),
    ...(Number.isSafeInteger(problem?.expected) ? { expected: problem.expected } : {}),
    ...(Number.isSafeInteger(problem?.supplied) ? { supplied: problem.supplied } : {}),
  }));
}

function schemaRepairIssueCount(errorOrIssues) {
  if (Array.isArray(errorOrIssues)) return errorOrIssues.length;
  if (Array.isArray(errorOrIssues?.data?.errors)) return errorOrIssues.data.errors.length;
  const coverage = errorOrIssues?.data?.coverage;
  if (!coverage) return 0;
  return (coverage.missing || []).length
    + (coverage.duplicates || []).length
    + (coverage.unexpected || []).length
    + (coverage.invalid || []).length;
}

function schemaRepairIssuePrompt(errorOrIssues) {
  const issues = boundedSchemaRepairIssues(errorOrIssues);
  if (!issues.length) return "Validator error paths were unavailable; preserve the supplied content and satisfy the stated schema contract exactly.";
  return [
    "Bounded validator errors to fix exactly:",
    ...issues.map((issue) => `- ${issue.path} [${issue.keyword}]: ${issue.message}${issue.missing_property ? `; missing_property=${issue.missing_property}` : ""}`),
  ].join("\n");
}

const EVIDENCE_REPAIR_SCHEMA_CONTRACT = [
  "Evidence schema contract: required top-level fields are summary (non-empty string), claims (array), metrics (object), sources (array), open_questions (array), and confidence (high|medium|low).",
  "Every claim requires non-empty claim and evidence strings, confidence (high|medium|low), and source_ids containing at least one non-empty source id.",
  "Every source requires non-empty id, title, url, published_at, and retrieved_at. At least one of claims or open_questions must be non-empty.",
  "Every coverage_items row uses strings for note, attempted and gap (empty string when unused), and arrays for source_ids and attempted_urls (empty array when unused). For a directly observed dynamic quote/table/index with no publication date, preserve published_at as unknown and add source_kind=dynamic_snapshot plus observed_at from the actual retrieval observation. Never apply this label to an ordinary undated article; news and event claims still need dated evidence.",
  "When the prompt carries company_source_acquisition_v1, preserve top-level acquisition_ledger with exactly one item per owned coverage id. Do not delete acquisition attempts, formulas, inputs, assumptions, or actual/proxy/model labels during transport repair.",
  "Use only source ids already present in the supplied sources array. Never invent a source id or fact; remove an unsupported claim and record the lost point in open_questions instead of returning empty source_ids.",
].join(" ");

const NEWS_OFFICIAL_SOURCE_REPAIR_CONTRACT = [
  "For news_industry_management, also preserve a top-level official_source_coverage object with status and regulator/issuer surfaces.",
  "Every claim must carry claim_type exactly equal to event_or_observation or absence_no_event; never omit or infer it. Use absence_no_event for every claim that concludes no news, filing, announcement, event or management/executive change was found.",
  "Each surface requires status (complete|incomplete), entry_url, checked_through, latest_dated_item, dated_items_checked, and gap.",
  "Each dated official item must resolve to the same packet source id, direct item URL and published_at. Do not reuse an undated landing-page source id for a dated article; add or retain the dated article as its own source.",
  "A complete surface must be checked_through as_of and source-link every dated item; an incomplete surface must carry a non-empty gap also present in open_questions.",
].join(" ");

function evidenceRepairSchemaContract(task) {
  return task === "news_industry_management"
    ? `${EVIDENCE_REPAIR_SCHEMA_CONTRACT} ${NEWS_OFFICIAL_SOURCE_REPAIR_CONTRACT}`
    : EVIDENCE_REPAIR_SCHEMA_CONTRACT;
}

/**
 * Keep execution diagnostics separate from investment evidence.
 *
 * A timed-out Codex worker can leave a long partial transcript containing tool chatter,
 * internal instructions and half-finished searches. That material is useful to an operator
 * but is not a sourced claim and must never enter evidence.json or downstream debate.
 */
export function workerFailureArtifacts({ task, symbol, asOfDate, language, timeoutMs, result, failureKind, parseError }) {
  const copy = localized(language, {
    en: {
      parse: `Evidence worker ${task} returned output that violated the JSON contract; it produced no evidence usable for an investment decision.`,
      language: `Evidence worker ${task} returned reader-facing content in the wrong language; it produced no evidence usable for an investment decision.`,
      failed: `Evidence worker ${task} timed out or failed; it produced no evidence usable for an investment decision.`,
      inspect: `Inspect the separate ${task} failure diagnostic and retry; do not use its partial transcript as evidence.`,
    },
    zh: {
      parse: `证据席位 ${task} 的输出不符合 JSON 契约；未生成可用于投资判断的证据。`,
      language: `证据席位 ${task} 返回了错误语言的读者内容；未生成可用于投资判断的证据。`,
      failed: `证据席位 ${task} 执行超时或失败；未生成可用于投资判断的证据。`,
      inspect: `检查 ${task} 的独立失败诊断并重试；不得用该席位的部分对话补齐证据。`,
    },
    ja: {
      parse: `証拠席 ${task} の出力は JSON 契約に違反しており、投資判断に使用できる証拠は生成されませんでした。`,
      language: `証拠席 ${task} は指定と異なる言語の読者向け内容を返したため、投資判断に使用できる証拠は生成されませんでした。`,
      failed: `証拠席 ${task} はタイムアウトまたは失敗し、投資判断に使用できる証拠は生成されませんでした。`,
      inspect: `${task} の分離された失敗診断を確認して再実行してください。部分的な対話を証拠として使用してはいけません。`,
    },
    ko: {
      parse: `증거 좌석 ${task}의 출력이 JSON 계약을 위반해 투자 판단에 사용할 수 있는 증거를 생성하지 못했습니다.`,
      language: `증거 좌석 ${task}가 지정과 다른 언어의 독자용 내용을 반환해 투자 판단에 사용할 수 있는 증거를 생성하지 못했습니다.`,
      failed: `증거 좌석 ${task}가 시간 초과 또는 실패로 투자 판단에 사용할 수 있는 증거를 생성하지 못했습니다.`,
      inspect: `${task}의 분리된 실패 진단을 확인한 뒤 다시 실행하십시오. 부분 대화를 증거로 사용해서는 안 됩니다.`,
    },
  });
  const timedOut = result?.timedOut === true;
  const parseFailed = failureKind === "parse_failed";
  const languageMismatch = failureKind === "reader_language_mismatch";
  const outputContractFailed = parseFailed || languageMismatch;
  const status = outputContractFailed ? failureKind : (timedOut ? "timed_out" : "failed");
  const exitLabel = Number.isInteger(result?.code) ? `exit code ${result.code}` : "worker error";
  const parseMessage = cleanLog(parseError?.message || parseError || "subagent did not return valid JSON", 1_000);
  const schemaErrors = boundedSchemaRepairIssues(parseError);
  const reason = outputContractFailed ? parseMessage : (timedOut ? `timeout after ${timeoutMs}ms` : exitLabel);
  const rawOutput = String(result?.text || "");
  const positionMatch = outputContractFailed ? /\bposition\s+(\d+)\b/i.exec(parseMessage) : null;
  const parsePosition = positionMatch ? Number(positionMatch[1]) : null;
  const contextStart = Number.isInteger(parsePosition) ? Math.max(0, parsePosition - 500) : 0;
  const contextEnd = Number.isInteger(parsePosition) ? Math.min(rawOutput.length, parsePosition + 500) : 0;
  const packet = normalizePacket({
    summary: parseFailed
      ? copy.parse
      : languageMismatch ? copy.language : copy.failed,
    claims: [],
    open_questions: [copy.inspect],
    confidence: "low",
  }, task, symbol, asOfDate, "");
  const diagnostic = {
    schema_version: 1,
    task,
    symbol,
    as_of: asOfDate,
    status,
    timed_out: timedOut,
    timeout_ms: timeoutMs,
    exit_code: Number.isInteger(result?.code) ? result.code : null,
    reason,
    diagnostic_excerpt: cleanLog(outputContractFailed
      ? (rawOutput || result?.stderr || result?.stdout || reason)
      : (result?.stderr || result?.stdout || rawOutput || reason)),
    ...(result?.output_too_large === true ? {
      output_too_large: true,
      output_bytes: Number.isSafeInteger(result.output_bytes) ? result.output_bytes : null,
      max_output_bytes: Number.isSafeInteger(result.max_output_bytes) ? result.max_output_bytes : null,
      output_fingerprint_sha256: typeof result.output_fingerprint_sha256 === "string"
        ? result.output_fingerprint_sha256
        : null,
      output_hash_scope: typeof result.output_hash_scope === "string" ? result.output_hash_scope : null,
      output_prefix: String(result.output_prefix || "").slice(0, 4 * 1024),
      output_tail: String(result.output_tail || "").slice(-4 * 1024),
    } : {}),
    ...(outputContractFailed ? {
      ...(parseFailed ? { parse_error: parseMessage } : { reader_language_error: parseMessage }),
      ...(schemaErrors.length ? {
        schema_id: cleanLog(String(parseError?.data?.schema_id || "unknown"), 160),
        schema_kind: cleanLog(String(parseError?.data?.kind || "unknown"), 80),
        schema_error_count: schemaRepairIssueCount(parseError) || schemaErrors.length,
        schema_errors: schemaErrors,
      } : {}),
      parse_position: Number.isInteger(parsePosition) ? parsePosition : null,
      parse_context: Number.isInteger(parsePosition)
        ? cleanLog(rawOutput.slice(contextStart, contextEnd), 1_000)
        : cleanLog(rawOutput, 1_000),
      output_chars: rawOutput.length,
      output_sha256: sha256(rawOutput),
    } : {}),
    recorded_at: new Date().toISOString(),
  };
  return { packet, diagnostic };
}

function evidenceReaderText(packet) {
  const acquisitionMachine = new Set([
    "policy_id", "task", "coverage_id", "outcome", "source_ids", "stage", "locator_type",
    "locator", "result", "unit", "period", "value",
  ]);
  return [
    packet?.summary,
    ...(packet?.claims || []).flatMap((claim) => [claim?.claim, claim?.evidence]),
    ...(packet?.open_questions || []),
    ...readerStrings(packet?.acquisition_ledger, acquisitionMachine),
  ].filter(Boolean).join("\n");
}

function readerStrings(value, skipKeys = new Set()) {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => readerStrings(item, skipKeys));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => (
    skipKeys.has(key) ? [] : readerStrings(item, skipKeys)
  ));
}

function visibleEvidenceReaderText(packet) {
  // `title` joins the machine set for the same reason `url` is already there: a source title is
  // the publisher's own words. Counting English headlines against a Chinese run's language ratio
  // rejected packets whose every authored sentence was Chinese, and the only way to pass was to
  // translate the citation -- which is falsifying the source, not localising the report.
  const machine = new Set([
    "task", "symbol", "as_of", "source_ids", "id", "url", "title", "published_at", "retrieved_at",
    "source_id", "entry_url", "checked_through", "record_id", "status",
    "confidence", "information_richness", "thread_id", "execution_mode", "raw_text",
    "policy_id", "coverage_id", "outcome", "stage", "locator_type", "locator", "result",
    "unit", "period", "value",
  ]);
  return [
    ...readerStrings(packet, machine),
  ].filter(Boolean).join("\n");
}

function masterReaderText(opinion) {
  const machine = new Set([
    "master", "symbol", "as_of", "stance", "source_ids", "confidence", "thread_id", "raw_text",
    "engine", "voice_status", "voice_language", "dedicated_worker", "runtime_provenance",
  ]);
  return readerStrings(opinion, machine).join("\n");
}

function debateReaderText(packet) {
  const machine = new Set([
    "role", "symbol", "as_of", "decision_available", "rating", "winner", "source_ids", "confidence",
    "thread_id", "execution_mode", "raw_text", "round", "debate_rounds",
  ]);
  return readerStrings(packet, machine).join("\n");
}

function assertVisibleReaderLanguage(text, run, label) {
  try {
    return assertReaderLanguage(text, run.language, label);
  } catch (error) {
    if (error?.code !== "READER_LANGUAGE_MISMATCH") throw error;
    throw invalidParams(error.message, {
      reason: "READER_LANGUAGE_MISMATCH",
      label,
      ...error.data,
    });
  }
}

function assertVisibleRunOpen(run, operation) {
  if (!run?.visible_finalization) return;
  throw invalidParams(`Cannot ${operation}: visible run ${run.run_id} was already finalized.`, {
    reason: "VISIBLE_RUN_FINALIZED",
    run_id: run.run_id,
    finalization_reason: run.visible_finalization.reason,
    finalized_at: run.visible_finalization.finalized_at,
    remedy: "Read and deliver the persisted user_response_markdown; start a new selected run to continue research.",
  });
}

export function outputFailureKind(error) {
  const reason = error?.data?.reason;
  if (error?.code === "READER_LANGUAGE_MISMATCH" || reason === "READER_LANGUAGE_MISMATCH") {
    return "reader_language_mismatch";
  }
  if (reason === "SOURCE_PROVENANCE_MISMATCH") return "source_provenance_mismatch";
  if (reason === "SOURCE_PROVENANCE_REQUIRED") return "source_provenance_required";
  return "parse_failed";
}

function repairableOutputFailure(failureKind) {
  return ["parse_failed", "reader_language_mismatch"].includes(failureKind);
}

/**
 * Persist enough about a rejected method-worker output to debug the contract without
 * copying the worker transcript into a durable run artifact. Schema paths and provenance
 * IDs are bounded and hashed; the output body is represented only by its length and digest.
 */
const MASTER_DIAGNOSTIC_SOURCE_ID_LIMIT = 8;
const MASTER_DIAGNOSTIC_SOURCE_ID_CHARS = 512;
const MASTER_DIAGNOSTIC_SOURCE_ID_COUNT_MAX = 1_000_000;

function boundedDiagnosticCode(value, fallback, maxLength = 96) {
  const candidate = String(value || "").trim();
  if (!candidate || !/^[a-z0-9_.:-]+$/iu.test(candidate)) return fallback;
  return candidate.slice(0, maxLength);
}

function boundedDiagnosticMaster(master) {
  const candidate = String(master || "").trim();
  return /^master_[a-z0-9_]{1,80}$/u.test(candidate) ? candidate : "master_unknown";
}

function sourceIdDiagnosticHash(value) {
  const sourceId = String(value || "");
  const boundedPrefix = sourceId.slice(0, MASTER_DIAGNOSTIC_SOURCE_ID_CHARS);
  return sha256(`${Buffer.byteLength(sourceId, "utf8")}:${boundedPrefix}`);
}

export function masterAttemptFailureDiagnostic({
  master,
  attempt,
  failureKind,
  error,
  result,
  stage = "worker_output",
}) {
  const schemaErrors = boundedSchemaRepairIssues(error);
  const provenanceReason = ["SOURCE_PROVENANCE_MISMATCH", "SOURCE_PROVENANCE_REQUIRED"]
    .includes(error?.data?.reason)
    ? error.data.reason
    : null;
  const unknownSourceIds = Array.isArray(error?.data?.unknown_source_ids)
    ? error.data.unknown_source_ids
      .filter((id) => typeof id === "string" && id)
      .slice(0, MASTER_DIAGNOSTIC_SOURCE_ID_LIMIT)
    : [];
  const unknownSourceIdCount = Array.isArray(error?.data?.unknown_source_ids)
    ? error.data.unknown_source_ids.length
    : 0;
  const rawOutput = typeof result?.text === "string" ? result.text : null;
  const safeMaster = boundedDiagnosticMaster(master);
  const safeFailureKind = boundedDiagnosticCode(failureKind, "unexpected_error");
  const safeStage = boundedDiagnosticCode(stage, "worker_output");
  const readerLanguage = safeFailureKind === "reader_language_mismatch" && error?.data
    ? {
      requested_locale: boundedDiagnosticCode(error.data.requested_locale, "unknown", 16),
      observed_locale: boundedDiagnosticCode(error.data.observed_locale, "unknown", 16),
      target_characters: Number.isSafeInteger(error.data.target_characters) ? error.data.target_characters : null,
      reader_characters: Number.isSafeInteger(error.data.reader_characters) ? error.data.reader_characters : null,
      ratio: Number.isFinite(error.data.ratio) ? error.data.ratio : null,
    }
    : null;
  return {
    schema_version: 1,
    master: safeMaster,
    attempt: Number.isInteger(attempt) ? Math.max(0, Math.min(attempt, 100)) : 0,
    stage: safeStage,
    failure_kind: safeFailureKind,
    // Error messages may contain the forged ID or rejected worker body. Persist only codes
    // produced by this process; the raw worker output is represented by the digest below.
    diagnostic: `${safeFailureKind} during ${safeStage}`,
    ...(readerLanguage ? { reader_language: readerLanguage } : {}),
    ...(schemaErrors.length ? {
      schema_id: boundedDiagnosticCode(error?.data?.schema_id, "unknown", 160),
      schema_kind: boundedDiagnosticCode(error?.data?.kind, "unknown", 80),
      schema_error_count: Array.isArray(error?.data?.errors) ? error.data.errors.length : schemaErrors.length,
      schema_errors: schemaErrors,
    } : {}),
    ...(provenanceReason ? {
      provenance: {
        reason: provenanceReason,
        // The diagnostic owner is the selected seat, never a model-controlled error field.
        owner: safeMaster,
        unknown_source_id_count: Math.min(unknownSourceIdCount, MASTER_DIAGNOSTIC_SOURCE_ID_COUNT_MAX),
        unknown_source_id_count_truncated: unknownSourceIdCount > MASTER_DIAGNOSTIC_SOURCE_ID_COUNT_MAX,
        unknown_source_ids: unknownSourceIds.map(sourceIdDiagnosticHash),
        unknown_source_ids_hashed: true,
        unknown_source_id_hash_scope: "utf8_length_plus_first_512_chars",
      },
    } : {}),
    ...(rawOutput !== null ? {
      output_chars: rawOutput.length,
      output_bytes: Buffer.byteLength(rawOutput, "utf8"),
      output_sha256: sha256(rawOutput),
    } : {}),
    recorded_at: new Date().toISOString(),
  };
}

/**
 * A rejected PM response must remain diagnosable after runCodex removes its temporary output.
 * Persist only bounded process-owned codes plus size/digest metadata; never retain the report,
 * prompt, model prose, output prefix/tail, or parser context in the run directory.
 */
export function portfolioManagerAttemptDiagnostic({ attempt, failureKind, packet, result }) {
  const rawOutput = typeof result?.text === "string" ? result.text : null;
  const contract = packet?.output_contract_diagnostic && typeof packet.output_contract_diagnostic === "object"
    ? packet.output_contract_diagnostic
    : {};
  const schemaErrors = boundedSchemaRepairIssues(contract.schema_errors || packet?.schema_errors);
  const safeFailureKind = boundedDiagnosticCode(failureKind, "unexpected_error");
  const safeReason = boundedDiagnosticCode(contract.reason, "WORKER_OUTPUT_REJECTED");
  const outputBytes = Number.isSafeInteger(result?.output_bytes)
    ? result.output_bytes
    : rawOutput === null ? null : Buffer.byteLength(rawOutput, "utf8");
  const fingerprint = typeof result?.output_fingerprint_sha256 === "string"
    && /^[0-9a-f]{64}$/u.test(result.output_fingerprint_sha256)
    ? result.output_fingerprint_sha256
    : null;
  return {
    schema_version: 1,
    role: "portfolio_manager",
    attempt: Number.isInteger(attempt) ? Math.max(1, Math.min(attempt, 2)) : 1,
    stage: "structured_decision",
    failure_kind: safeFailureKind,
    reason: safeReason,
    transport_ok: result?.ok === true,
    timed_out: result?.timedOut === true,
    exit_code: Number.isInteger(result?.code) ? result.code : null,
    output_too_large: result?.output_too_large === true,
    output_chars: rawOutput === null ? null : rawOutput.length,
    output_bytes: outputBytes,
    ...(rawOutput !== null ? { output_sha256: sha256(rawOutput) } : {}),
    ...(fingerprint ? {
      output_fingerprint_sha256: fingerprint,
      output_hash_scope: "byte_count_plus_prefix_tail",
    } : {}),
    ...(typeof contract.schema_id === "string" ? {
      schema_id: cleanLog(contract.schema_id, 160),
    } : {}),
    ...(typeof contract.schema_kind === "string" ? {
      schema_kind: boundedDiagnosticCode(contract.schema_kind, "unknown", 80),
    } : {}),
    ...(schemaErrors.length ? {
      schema_error_count: Number.isSafeInteger(contract.schema_error_count)
        ? Math.min(contract.schema_error_count, 1_000_000)
        : schemaErrors.length,
      schema_errors: schemaErrors,
    } : {}),
    contract_error_count: Array.isArray(packet?.contract_errors)
      ? Math.min(packet.contract_errors.length, 1_000_000)
      : 0,
    recorded_at: new Date().toISOString(),
  };
}

/**
 * A production headless run must not silently become a prompt-only council because its
 * caller omitted `grounding`. Visible runs already collect it in rpc.mjs; this gives the
 * headless path the same fact boundary. Dry runs remain network-free by design.
 */
export async function groundingForHeadlessRun({ symbol, asOf, grounding, dryRun, timeoutMs }, gather = gatherGrounding) {
  if (grounding && typeof grounding === "object") return grounding;
  if (dryRun) return null;
  if (Number.isFinite(timeoutMs) && timeoutMs <= 0) {
    return {
      as_of: asOf,
      facts_unavailable: true,
      unavailable: ["quick grounding skipped: global time budget was already exhausted"],
    };
  }
  let timer;
  const controller = Number.isFinite(timeoutMs) ? new AbortController() : null;
  try {
    // The budget is handed DOWN so grounding can settle and return what it has. Racing it from
    // out here discarded a completed quote and a completed screen whenever one feed was slow,
    // and the analysts then reported a missing ticker for a symbol that had been supplied.
    // The outer race stays as a backstop, with headroom, for a call that hangs entirely.
    const work = gather({
      symbol, asOf,
      ...(Number.isFinite(timeoutMs) ? { budgetMs: timeoutMs } : {}),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!Number.isFinite(timeoutMs)) return await work;
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`quick grounding timed out after ${Math.round(timeoutMs)}ms`);
          reject(error);
          controller?.abort(error);
        }, timeoutMs + LIMITS.GROUNDING_SETTLE_HEADROOM_MS);
      }),
    ]);
  } catch (error) {
    // A failed fact fetch is still an explicit grounding result. Keeping an object here
    // makes deterministic methods decline on missing inputs instead of taking the v1 prompt
    // fallback and filling the gap from model memory.
    return {
      as_of: asOf,
      facts_unavailable: true,
      unavailable: [`grounding failed: ${cleanLog(error?.message || error)}`],
      source_acquisition_plan: buildCompanySourceAcquisitionPlan({ symbol, asOf, profile: {} }),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Persist a minimal receipt-bound lifecycle before a background MCP call is accepted.
 *
 * Grounding can perform several network requests. Without this envelope, `analyze_symbol`
 * returned a run_id first and `read_run` failed with ENOENT until those requests finished.
 * Keeping the queued snapshot deliberately free of inferred facts also means a crash in the
 * initialization window remains inspectable without pretending that evidence was collected.
 */
export function queueHeadlessRun(args) {
  if (args.visibility_required) {
    throw invalidParams("visibility_required=true cannot be satisfied by headless MCP. Use host-level multi_agent or codex_app threads first, then record_visible_packet/record_visible_decision.");
  }
  const symbol = safeSymbol(args.symbol);
  const asOfDate = councilAsOf(args.as_of);
  const id = args.run_id || runId(symbol);
  const tasks = plannedTasks(args);
  const dryRun = isDryRun(args);
  const language = resolveLanguage(args);
  const frozen = frozenMasterSelection(args);
  const dir = runPath(id);
  mkdirSync(dir, { recursive: true });
  const startedAt = new Date().toISOString();
  const timing = councilTiming(args, startedAt);
  const run = {
    run_id: id,
    symbol,
    as_of: asOfDate,
    language,
    dry_run: dryRun,
    execution_mode: dryRun ? "dry_run" : "background_codex_exec",
    entry_tool: args.entry_tool || "analyze_symbol",
    decision_requested: args.synthesis !== false,
    visibility_required: false,
    ...timing,
    started_at: startedAt,
    updated_at: startedAt,
    completed_at: null,
    status: "queued",
    phase: "queued",
    tasks,
    analyst_scope: frozen.selection.analyst_scope,
    task_status: Object.fromEntries(tasks.map((task) => [task, { task, status: "pending" }])),
    agent_status: Object.fromEntries(DEBATE_ROLES.map((role) => [role, { role, status: "pending" }])),
    packets: [],
    masters: frozen.masters,
    master_selection: frozen.selection,
    master_opinions: [],
    master_status: Object.fromEntries(frozen.masters.map((master) => [master, { master, status: "pending" }])),
    verifier_verdicts: [],
    grounding: args.grounding && typeof args.grounding === "object" ? args.grounding : null,
    seat_weight_overrides: (args.seat_weights && typeof args.seat_weights === "object") ? args.seat_weights : {},
  };
  saveRun(run);
  appendEvent(run, "background_run_queued", {
    selection_id: frozen.selection.selection_id,
    catalog_hash: frozen.selection.catalog_hash,
    selection_hash: frozen.selection.selection_hash,
    tasks,
    masters: frozen.masters,
    council_mode: run.council_mode,
    deadline_at: run.deadline_at,
  });
  writeAllAgentsMarkdown(run);
  return run;
}

export async function collectEvidence(args) {
  if (args.visibility_required) {
    throw invalidParams("visibility_required=true cannot be satisfied by headless MCP. Use host-level multi_agent or codex_app threads first, then record_visible_packet/record_visible_decision.");
  }
  const symbol = safeSymbol(args.symbol);
  const asOfDate = councilAsOf(args.as_of);
  const id = args.run_id || runId(symbol);
  const tasks = plannedTasks(args);
  const dryRun = isDryRun(args);
  const language = resolveLanguage(args);
  const frozen = frozenMasterSelection(args);
  const startedAt = args.queued_run?.started_at || new Date().toISOString();
  const timing = councilTiming(args, startedAt);
  const timeoutMs = evidenceStageTimeout(args, timing);
  const defaultConcurrency = timing.council_mode === "quick"
    ? QUICK_TASKS.length
    : Math.min(tasks.length, LIMITS.FULL_EVIDENCE_CONCURRENCY);
  // The evidence topology is contractual: every planned evidence seat starts in the same
  // wave. A legacy low max_concurrency override may not silently turn the full fan-out back
  // into the old three-wave, ~30-minute evidence stage. Higher values have no effect once
  // every task can launch.
  const requestedConcurrency = Number(args.max_concurrency || defaultConcurrency);
  const maxConcurrency = Math.max(
    defaultConcurrency,
    Math.min(LIMITS.CONCURRENCY_MAX, Number.isFinite(requestedConcurrency) ? requestedConcurrency : defaultConcurrency),
  );
  const grounding = await groundingForHeadlessRun({
    symbol,
    asOf: asOfDate,
    grounding: args.grounding,
    dryRun,
    timeoutMs: remainingCouncilBudget(
      timing,
      timing.council_mode === "quick" ? LIMITS.QUICK_GROUNDING_MS : councilPaceProfile(timing.council_pace).grounding_ms,
    ),
  });
  const dir = runPath(id);
  mkdirSync(dir, { recursive: true });

  const run = {
    run_id: id,
    symbol,
    as_of: asOfDate,
    language,
    dry_run: dryRun,
    execution_mode: dryRun ? "dry_run" : "background_codex_exec",
    entry_tool: args.entry_tool || "collect_evidence",
    decision_requested: (args.entry_tool || "collect_evidence") !== "collect_evidence"
      && args.synthesis !== false,
    visibility_required: false,
    ...timing,
    started_at: startedAt,
    updated_at: startedAt,
    completed_at: null,
    status: "running",
    phase: "evidence",
    tasks,
    analyst_scope: frozen.selection.analyst_scope,
    task_status: Object.fromEntries(tasks.map((task) => [task, { task, status: "pending" }])),
    agent_status: Object.fromEntries(DEBATE_ROLES.map((role) => [role, { role, status: "pending" }])),
    packets: [],
    masters: frozen.masters,
    master_selection: frozen.selection,
    master_opinions: [],
    master_status: Object.fromEntries(frozen.masters.map((master) => [master, { master, status: "pending" }])),
    verifier_verdicts: [],
    grounding,
    seat_weight_overrides: (args.seat_weights && typeof args.seat_weights === "object") ? args.seat_weights : {},
  };
  const packetsByTask = new Map();
  writeStatus(run);
  appendEvent(run, "master_selection_consumed", {
    selection_id: frozen.selection.selection_id,
    catalog_hash: frozen.selection.catalog_hash,
    selection_hash: frozen.selection.selection_hash,
    selected_masters: frozen.masters,
  });
  appendEvent(run, "run_started", {
    tasks,
    masters: frozen.masters,
    council_mode: run.council_mode,
    deadline_at: run.deadline_at,
    grounding: grounding ? (grounding.facts_unavailable ? "unavailable" : "attached") : "dry_run_skipped",
  });
  writeJson(join(dir, "evidence.json"), run);
  writeSourceManifest(run);
  writeAllAgentsMarkdown(run);

  const commitPacket = (packet) => {
    packetsByTask.set(packet.task, packet);
    run.packets = tasks.map((task) => packetsByTask.get(task)).filter(Boolean);
    if (packet.acquisition_ledger) {
      try {
        const observation = recordCompanyAcquisitionObservations({
          symbol: run.symbol,
          task: packet.task,
          ledger: packet.acquisition_ledger,
        });
        appendEvent(run, "company_observations_recorded", {
          task: packet.task,
          recorded: observation.recorded || 0,
          observation_count: observation.observation_count || 0,
        });
      } catch (error) {
        appendEvent(run, "company_observation_record_failed", {
          task: packet.task,
          reason: cleanLog(String(error?.message || error), 500),
        });
      }
    }
    writeJson(join(dir, `${packet.task}.json`), packet);
    writeJson(join(dir, "evidence.json"), run);
    writeSourceManifest(run);
    writeAnalystMarkdownFiles(run, existingDebate(dir));
    writeArtifactIndex(run, existingDebate(dir));
    writeAllAgentsMarkdown(run);
  };

  const persistTerminalTask = (task, status, patch = {}) => {
    updateTask(run, task, status, patch);
    // `status.json` is intentionally lightweight and receives running heartbeats, while the
    // multi-megabyte evidence snapshot should not be rewritten for every heartbeat. Terminal
    // state is different: persist it immediately after the packet so an unexpected later-stage
    // failure cannot reload an older `running` state and overwrite a completed worker.
    writeJson(join(dir, "evidence.json"), run);
  };

  const commitUnexpectedEvidenceFailure = (error, task) => {
    const failedResult = {
      ok: false,
      code: null,
      text: "",
      stderr: cleanLog(error?.message || error),
      stdout: "",
      timedOut: false,
      unexpected_error: true,
    };
    const failure = workerFailureArtifacts({
      task,
      symbol,
      asOfDate,
      language,
      timeoutMs,
      result: failedResult,
      failureKind: "unexpected_error",
    });
    const diagnosticPath = join(dir, `${task}.failure.json`);
    writeJson(diagnosticPath, failure.diagnostic, { mode: 0o600 });
    commitPacket(failure.packet);
    persistTerminalTask(task, run.council_mode === "quick" ? "degraded" : "failed", {
      completed_at: new Date().toISOString(),
      output: join(dir, `${task}.json`),
      diagnostic: diagnosticPath,
      attempts: taskState(run, task).attempts || 0,
      error: "unexpected_error",
    });
    return failure.packet;
  };

  await mapLimit(tasks, maxConcurrency, async (task) => {
    const quickPriority = run.council_mode === "quick"
      ? task === "news_industry_management"
        ? "QUICK COUNCIL PRIORITY: return only the highest-impact company and industry developments from the 120 days up to as_of. Every news source must have a publication date and URL; exclude future, undated and stale items. Keep the packet concise."
        : "QUICK COUNCIL PRIORITY: return only the 4-6 highest-information claims needed for a directional read. Keep the packet concise, source every claim, and make unknowns explicit."
      : "";
    const workerObjective = [args.prompt || "", quickPriority].filter(Boolean).join("\n\n");
    const prompt = [
      taskPrompt(task, symbol, asOfDate, workerObjective, language, run.grounding, run.council_pace),
      companyCoverageInstruction(task, run),
    ].filter(Boolean).join("\n\n");
    updateTask(run, task, "running", { started_at: new Date().toISOString() });
    if (dryRun) {
      const packet = dryPacket(task, symbol, asOfDate, prompt, language);
      commitPacket(packet);
      persistTerminalTask(task, "completed", { completed_at: new Date().toISOString(), output: join(dir, `${task}.json`) });
      return packet;
    }
    const workerStartedAt = Date.now();
    const runAttempt = async (workerPrompt, budgetMs, attempt, { search = true } = {}) => {
      const allowedMs = remainingCouncilBudget(run, budgetMs);
      if (allowedMs <= 0) return { ...deadlineResult(run), budget_ms: 0 };
      const result = await runCodex(workerPrompt, allowedMs, ({ pid, output }) => {
        updateTask(run, task, "running", { pid, output, attempts: attempt });
      }, ({ pid, output, elapsed_ms }) => {
        updateTask(run, task, "running", { pid, output, attempts: attempt });
        appendEvent(run, "task_heartbeat", { task, pid, output, elapsed_ms, attempt });
      }, { search, sigkillGraceMs: councilKillGrace(run) });
      return { ...result, budget_ms: allowedMs };
    };
    const commitFailure = ({ failedResult, budgetMs, attempts, failureKind, parseError, retryDiagnostic }) => {
      const failure = workerFailureArtifacts({
        task,
        symbol,
        asOfDate,
        language,
        timeoutMs: budgetMs,
        result: failedResult,
        failureKind,
        parseError,
      });
      const diagnosticPath = join(dir, `${task}.failure.json`);
      writeJson(diagnosticPath, failure.diagnostic, { mode: 0o600 });
      commitPacket(failure.packet);
      const terminalStatus = run.council_mode === "quick"
        ? "degraded"
        : failedResult.timedOut ? "timed_out" : "failed";
      persistTerminalTask(task, terminalStatus, {
        completed_at: new Date().toISOString(),
        output: join(dir, `${task}.json`),
        diagnostic: diagnosticPath,
        ...(retryDiagnostic ? { retry_diagnostic: retryDiagnostic } : {}),
        attempts,
        deadline_exhausted: failedResult.deadline_exhausted === true,
        error: ["parse_failed", "reader_language_mismatch"].includes(failureKind)
          ? failureKind
          : (failedResult.deadline_exhausted ? "global_deadline" : failedResult.timedOut ? "timeout" : `exit code ${failedResult.code}`),
      });
      return failure.packet;
    };

    let result = await runAttempt(prompt, timeoutMs, 1);
    if (!result.ok) {
      return commitFailure({ failedResult: result, budgetMs: result.budget_ms ?? timeoutMs, attempts: 1 });
    }
    let packet;
    try {
      packet = normalizePacket(extractWorkerJson(result.text, task === "news_industry_management" ? "news_evidence" : "evidence"), task, symbol, asOfDate, result.text);
      applyGroundedRegulatorCoverage(packet, { task, asOfDate, grounding: run.grounding });
      assertOfficialSourceCoverage(packet, { task, asOfDate, grounding: run.grounding });
      assertCompanyCoveragePacket(packet, run);
      assertCompanySourceAcquisition(packet, run);
      assertReaderLanguage(evidenceReaderText(packet), language, `evidence worker ${task}`);
      commitPacket(packet);
      persistTerminalTask(task, "completed", { completed_at: new Date().toISOString(), output: join(dir, `${task}.json`), attempts: 1 });
      return packet;
    } catch (firstParseError) {
      const firstFailureKind = outputFailureKind(firstParseError);
      const firstFailure = workerFailureArtifacts({
        task,
        symbol,
        asOfDate,
        language,
        timeoutMs,
        result,
        failureKind: firstFailureKind,
        parseError: firstParseError,
      });
      const retryDiagnostic = join(dir, `${task}.attempt-1.failure.json`);
      writeJson(retryDiagnostic, firstFailure.diagnostic, { mode: 0o600 });
      const retryTimeoutMs = parseRepairBudget(run, {
        stageBudgetMs: timeoutMs,
        stageStartedAtMs: workerStartedAt,
      });
      if (retryTimeoutMs <= 0) {
        return commitFailure({
          failedResult: result,
          budgetMs: result.budget_ms ?? timeoutMs,
          attempts: 1,
          failureKind: firstFailureKind,
          parseError: firstParseError,
          retryDiagnostic,
        });
      }

      appendEvent(run, "task_retry", {
        task,
        attempt: 2,
        max_attempts: 2,
        reason: firstFailureKind,
        retry_diagnostic: retryDiagnostic,
        remaining_ms: retryTimeoutMs,
      });
      updateTask(run, task, "running", { attempts: 2, retry_diagnostic: retryDiagnostic });
      const malformed = String(result.text || "").slice(0, LIMITS.PARSE_REPAIR_INPUT_CHARS);
      const retryPrompt = [
        "PARSE-ONLY TRANSPORT REPAIR. Do not search, browse, fetch, add facts, or redo the research.",
        `Target task: ${task}; symbol: ${symbol}; as_of: ${asOfDate}; reader language: ${language}.`,
        firstFailureKind === "reader_language_mismatch"
          ? "Translate only the reader-facing strings in the supplied valid JSON into the requested language. Preserve the evidence packet schema, claims, numbers, source IDs, URLs, dates, explicit gaps and uncertainty. Return exactly one JSON object and nothing else."
          : "Convert only the supplied malformed worker output into exactly one valid JSON object matching the evidence packet schema. Preserve claims, numbers, source IDs, URLs, dates, explicit gaps and uncertainty. If a field cannot be recovered, use an empty value and record the loss in open_questions. Return JSON only.",
        evidenceRepairSchemaContract(task),
        companyCoverageInstruction(task, run),
        sourceAcquisitionPromptBlock(run.grounding?.source_acquisition_plan, task, language),
        schemaRepairIssuePrompt(firstParseError),
        `Write every reader-facing value in ${language}. Translation is permitted only to repair the language mismatch; do not alter facts, numbers, dates, source IDs or uncertainty.`,
        `Malformed worker output:\n${malformed}`,
      ].join("\n\n");
      result = await runAttempt(retryPrompt, retryTimeoutMs, 2, { search: false });
      if (!result.ok) {
        return commitFailure({
          failedResult: result,
          budgetMs: result.budget_ms ?? retryTimeoutMs,
          attempts: 2,
          retryDiagnostic,
        });
      }
      try {
        packet = normalizePacket(extractRepairedWorkerJson(result.text, task === "news_industry_management" ? "news_evidence" : "evidence"), task, symbol, asOfDate, result.text);
        applyGroundedRegulatorCoverage(packet, { task, asOfDate, grounding: run.grounding });
        assertOfficialSourceCoverage(packet, { task, asOfDate, grounding: run.grounding });
        assertCompanyCoveragePacket(packet, run);
        assertCompanySourceAcquisition(packet, run);
        assertReaderLanguage(evidenceReaderText(packet), language, `evidence worker ${task} repair`);
        commitPacket(packet);
        appendEvent(run, "task_repair_succeeded", {
          task,
          original_failure_kind: firstFailureKind,
          original_output_sha256: firstFailure.diagnostic.output_sha256 || null,
          repaired_packet_hash: companyEvidencePacketHash(packet),
          retry_diagnostic: retryDiagnostic,
        });
        persistTerminalTask(task, "completed", {
          completed_at: new Date().toISOString(),
          output: join(dir, `${task}.json`),
          attempts: 2,
          retry_diagnostic: retryDiagnostic,
        });
        return packet;
      } catch (secondParseError) {
        const secondFailureKind = outputFailureKind(secondParseError);
        return commitFailure({
          failedResult: result,
          budgetMs: result.budget_ms ?? retryTimeoutMs,
          attempts: 2,
          failureKind: secondFailureKind,
          parseError: secondParseError,
          retryDiagnostic,
        });
      }
    }
  }, commitUnexpectedEvidenceFailure);

  const dossierRef = materializeCompanyDossier(run);
  const dossierCoverage = companyDossierCoverageStatus(run);
  if (dossierRef) {
    appendEvent(run, "company_dossier_ready", {
      contract_id: dossierRef.contract_id,
      content_hash: dossierRef.content_hash,
      retrieval_status: dossierRef.retrieval_status,
      sufficiency: dossierRef.sufficiency,
      decision_barrier_ready: dossierRef.decision_barrier_ready,
      unavailable_count: dossierRef.unavailable_count,
    });
  }
  if (dossierCoverage.required && !dossierCoverage.decision_barrier_ready) {
    const affected = [...new Set([
      ...dossierCoverage.missing.map((item) => item.task),
      ...dossierCoverage.invalid.map((item) => item.task),
      ...dossierCoverage.critical_gaps.map((item) => item.task),
    ])].filter((task) => tasks.includes(task));
    for (const task of affected) {
      if (taskState(run, task).status !== "completed") continue;
      updateTask(run, task, "failed", {
        completed_at: new Date().toISOString(),
        output: join(dir, `${task}.json`),
        error: "company_dossier_coverage_incomplete",
      });
    }
  }
  const successfulTasks = tasks.filter((task) => taskState(run, task).status === "completed");
  const degradedTasks = tasks.filter((task) => taskState(run, task).status === "degraded");
  const failedTasks = tasks.filter((task) => !["completed", "degraded"].includes(taskState(run, task).status));
  const quickMinimumMet = run.council_mode === "quick"
    && successfulTasks.length >= LIMITS.QUICK_MIN_SUCCESSFUL_TASKS;
  const allEvidenceSucceeded = failedTasks.length === 0
    && (degradedTasks.length === 0 || quickMinimumMet);
  const evidenceDegraded = allEvidenceSucceeded && degradedTasks.length > 0;
  const evidenceEvent = evidenceDegraded
    ? "evidence_degraded"
    : allEvidenceSucceeded ? "evidence_complete" : "evidence_partial";
  run.completed_at = new Date().toISOString();
  run.phase = evidenceDegraded
    ? "evidence_degraded"
    : allEvidenceSucceeded ? "evidence_complete" : "evidence_partial";
  run.status = evidenceDegraded
    ? "evidence_degraded"
    : allEvidenceSucceeded ? "evidence_complete" : "partial";
  writeJson(join(dir, "evidence.json"), run);
  writeSourceManifest(run);
  writeStatus(run);
  appendEvent(run, evidenceEvent, {
    barrier_satisfied: allEvidenceSucceeded,
    successful: successfulTasks.length,
    degraded: degradedTasks.length,
    failed: failedTasks.length,
    total: tasks.length,
    packet_count: run.packets.length,
    failed_tasks: failedTasks,
    degraded_tasks: degradedTasks,
  });
  writeAllAgentsMarkdown(run);
  return run;
}

function updateVerifierStatus(run, verifier, status, patch = {}) {
  run.verifier_status = run.verifier_status || {};
  run.verifier_status[verifier] = {
    ...(run.verifier_status[verifier] || {}),
    ...patch,
    verifier,
    status,
    updated_at: new Date().toISOString(),
  };
  if (["completed", "failed", "skipped"].includes(status)) saveRun(run);
  else writeStatus(run);
  appendEvent(run, `verifier_${status}`, { verifier, ...patch });
}

/**
 * The slow/full/all path runs three independent batch workers over the exact same frozen
 * material-claim set. Each worker must account for every claim; partial batches never satisfy
 * the gate, and zero verdicts are explicitly terminal needs_verification rather than complete.
 */
export async function runHeadlessVerification(run, args = {}) {
  const dir = runPath(run.run_id);
  const policy = initializeVerificationPolicy(run);
  saveRun(run);
  if (!policy.required) return run;

  run.phase = "verification";
  run.status = "running";
  run.completed_at = null;
  appendEvent(run, "verification_started", {
    policy_id: policy.policy_id,
    verifier_ids: policy.verifier_ids,
    material_claim_count: policy.material_claim_count,
    expected_verdict_count: policy.expected_verdict_count,
  });
  if (policy.material_claim_count === 0 || run.dry_run) {
    for (const verifier of REQUIRED_VERIFIER_IDS) {
      updateVerifierStatus(run, verifier, run.dry_run ? "skipped" : "failed", {
        error: run.dry_run ? "dry_run_not_executed" : "no_material_claims",
        completed_at: new Date().toISOString(),
      });
    }
    run.verification_policy.status = "needs_verification";
    saveRun(run);
    return run;
  }

  const timeoutMs = verifierStageTimeout(run);
  const fullInputPaths = Object.fromEntries(REQUIRED_VERIFIER_IDS.map((verifier) => {
    const path = join(dir, `verification.${verifier}.input.json`);
    writeJson(path, buildVerifierBatchInput(run, verifier), { mode: 0o600 });
    return [verifier, path];
  }));
  await mapLimit(REQUIRED_VERIFIER_IDS, LIMITS.FULL_VERIFIER_CONCURRENCY, async (verifier) => {
    const claimsPerBatch = verifier === "source_fidelity"
      ? LIMITS.FULL_SOURCE_FIDELITY_CLAIMS_PER_BATCH
      : LIMITS.FULL_VERIFIER_CLAIMS_PER_BATCH;
    const claimChunks = [];
    for (let offset = 0; offset < policy.material_claim_ids.length; offset += claimsPerBatch) {
      claimChunks.push(policy.material_claim_ids.slice(offset, offset + claimsPerBatch));
    }
    const chunkConcurrency = verifier === "source_fidelity"
      ? LIMITS.FULL_SOURCE_FIDELITY_CHUNK_CONCURRENCY
      : LIMITS.FULL_VERIFIER_CHUNK_CONCURRENCY;
    const startedAtMs = Date.now();
    updateVerifierStatus(run, verifier, "running", {
      started_at: new Date().toISOString(),
      input: fullInputPaths[verifier],
      attempts: 1,
      chunks_total: claimChunks.length,
      chunks_completed: 0,
    });
    let pid = null;
    const remainingVerifierBudget = () => Math.max(0, timeoutMs - (Date.now() - startedAtMs));
    const execute = async (workerPrompt, budgetMs, attempt, search, outputSchema = null) => {
      const allowedMs = remainingCouncilBudget(run, Math.min(budgetMs, remainingVerifierBudget()));
      if (allowedMs <= 0) return { ...deadlineResult(run), budget_ms: 0 };
      const result = await runCodex(workerPrompt, allowedMs, ({ pid: workerPid, output }) => {
        pid = workerPid;
        updateVerifierStatus(run, verifier, "running", { pid: workerPid, output, attempts: attempt });
      }, ({ pid: workerPid, output, elapsed_ms }) => {
        updateVerifierStatus(run, verifier, "running", { pid: workerPid, output, elapsed_ms, attempts: attempt });
      }, { search, outputSchema, sigkillGraceMs: councilKillGrace(run) });
      return { ...result, budget_ms: allowedMs };
    };
    const chunkResults = new Array(claimChunks.length);
    let chunksCompleted = 0;
    let verifierFailed = false;
    await mapLimit(claimChunks, chunkConcurrency, async (expectedClaimIds, index) => {
      if (verifierFailed) return;
      const chunkNumber = String(index + 1).padStart(2, "0");
      const inputPath = join(dir, `verification.${verifier}.chunk-${chunkNumber}.input.json`);
      writeJson(inputPath, buildVerifierBatchInput(run, verifier, { expectedClaimIds }), { mode: 0o600 });
      const outputSchemaPath = join(dir, `verification.${verifier}.chunk-${chunkNumber}.output.schema.json`);
      writeJson(
        outputSchemaPath,
        buildVerifierHeadlessOutputSchema(run, verifier, expectedClaimIds),
        { mode: 0o600 },
      );
      const prompt = verifierBatchPrompt(run, verifier, inputPath, { keyedResults: true });
      const chunkStartedAtMs = Date.now();
      updateVerifierStatus(run, verifier, "running", {
        input: fullInputPaths[verifier],
        active_chunk: index + 1,
        active_chunk_claim_count: expectedClaimIds.length,
        chunks_total: claimChunks.length,
        chunks_completed: chunksCompleted,
        attempts: 1,
      });
      // The headless transport is intentionally keyed so Codex Structured Outputs can make
      // omission and duplication impossible. Parse the bounded JSON value first, convert it
      // to the public row contract, and only then invoke the runtime verifier-batch schema.
      // Running the public schema before conversion would reject the correct keyed object.
      const parse = (result) => normalizeVerifierBatch(
        normalizeVerifierHeadlessTransport(extractJson(result.text), run, verifier, expectedClaimIds),
        run,
        verifier,
        { expectedClaimIds },
      );

      let result = await execute(prompt, remainingVerifierBudget(), 1, true, outputSchemaPath);
      let normalizedChunk = null;
      let diagnostic = null;
      if (result.ok) {
        try {
          normalizedChunk = parse(result);
        } catch (error) {
          diagnostic = error;
        }
      }
      if (!normalizedChunk && result.ok && diagnostic) {
        const retryBudget = parseRepairBudget(run, {
          stageBudgetMs: Math.min(result.budget_ms || 0, remainingVerifierBudget()),
          stageStartedAtMs: chunkStartedAtMs,
        });
        const diagnosticPath = join(dir, `verification.${verifier}.chunk-${chunkNumber}.attempt-1.failure.json`);
        const coverageProblems = boundedVerifierCoverageProblems(diagnostic);
        const semanticRetry = diagnostic?.data?.reason === "VERIFIER_BATCH_COVERAGE_MISMATCH";
        writeJson(diagnosticPath, {
          verifier,
          chunk: index + 1,
          claim_ids: expectedClaimIds,
          failure_kind: outputFailureKind(diagnostic),
          diagnostic: cleanLog(diagnostic?.message || diagnostic, 2_000),
          schema_errors: boundedSchemaRepairIssues(diagnostic),
          ...(coverageProblems.length ? { coverage_problems: coverageProblems } : {}),
          retry_kind: semanticRetry ? "verification_research_retry" : "parse_only_transport_repair",
          output_sha256: sha256(String(result.text || "")),
          recorded_at: new Date().toISOString(),
        }, { mode: 0o600 });
        if (retryBudget > 0) {
          updateVerifierStatus(run, verifier, "running", {
            attempts: 2,
            active_chunk: index + 1,
            retry_diagnostic: diagnosticPath,
            retry_kind: semanticRetry ? "verification_research_retry" : "parse_only_transport_repair",
          });
          const repairPrompt = semanticRetry ? [
            "VERIFIER COVERAGE RETRY. This is the only research retry for one frozen claim chunk. Use native web search and actual page checks; do not alter the frozen analyst input.",
            `Verifier: ${verifier}; run_id: ${run.run_id}; chunk: ${index + 1}/${claimChunks.length}.`,
            `Read the same frozen input again at ${inputPath}. Return every exact claim ID as one key in results: ${JSON.stringify(expectedClaimIds)}.`,
            `The first audit failed these exact checks: ${JSON.stringify(coverageProblems)}`,
            "Correct those checks with real retrieval/search. You may change a verifier verdict only when the renewed check justifies it. Never claim a URL was checked unless you actually attempted it.",
            `Allowed verdicts: ${registry().get(verifier).verdict_values.join(" | ")}. Return only the schema-bound JSON object.`,
          ].join("\n\n") : [
            "PARSE-ONLY VERIFIER TRANSPORT REPAIR. Do not search, browse, fetch, change a verdict, add a claim, or drop a claim.",
            `Verifier: ${verifier}; run_id: ${run.run_id}; chunk: ${index + 1}/${claimChunks.length}.`,
            `Return exactly one valid verifier-batch JSON object whose results object has every exact claim ID as a key: ${JSON.stringify(expectedClaimIds)}. Do not repeat claim_id inside a result value.`,
            `Allowed verdicts: ${registry().get(verifier).verdict_values.join(" | ")}. Preserve note, checked_urls, queries, excerpt and rederivation from the supplied output.`,
            `Malformed output:\n${String(result.text || "").slice(0, LIMITS.PARSE_REPAIR_INPUT_CHARS)}`,
          ].join("\n\n");
          result = await execute(repairPrompt, retryBudget, 2, semanticRetry, outputSchemaPath);
          if (result.ok) {
            try {
              normalizedChunk = parse(result);
              diagnostic = null;
            } catch (error) {
              diagnostic = error;
            }
          }
        }
      }

      if (!result.ok || !normalizedChunk) {
        const error = result.deadline_exhausted ? "global_deadline"
          : result.timedOut ? "timeout"
            : diagnostic ? outputFailureKind(diagnostic)
              : `exit code ${result.code}`;
        if (verifierFailed) return;
        verifierFailed = true;
        const failurePath = join(dir, `verification.${verifier}.failure.json`);
        writeJson(failurePath, {
          verifier,
          chunk: index + 1,
          chunks_total: claimChunks.length,
          claim_ids: expectedClaimIds,
          error,
          diagnostic: diagnostic ? cleanLog(diagnostic.message || diagnostic, 2_000) : null,
          ...(diagnostic && boundedVerifierCoverageProblems(diagnostic).length
            ? { coverage_problems: boundedVerifierCoverageProblems(diagnostic) }
            : {}),
          stderr: cleanLog(result.stderr || "", 2_000),
          recorded_at: new Date().toISOString(),
        }, { mode: 0o600 });
        updateVerifierStatus(run, verifier, "failed", {
          pid,
          error,
          failed_chunk: index + 1,
          chunks_total: claimChunks.length,
          chunks_completed: chunksCompleted,
          diagnostic: failurePath,
          completed_at: new Date().toISOString(),
        });
        return;
      }

      // Another in-flight chunk may have failed while this worker was finishing. The verifier
      // remains failed and no partial union is promoted.
      if (verifierFailed) return;

      const chunkOutputPath = join(dir, `verification.${verifier}.chunk-${chunkNumber}.json`);
      writeJson(chunkOutputPath, normalizedChunk, { mode: 0o600 });
      chunkResults[index] = normalizedChunk.results;
      chunksCompleted += 1;
      updateVerifierStatus(run, verifier, "running", {
        chunks_total: claimChunks.length,
        chunks_completed: chunksCompleted,
        active_chunk: null,
        result_count: chunkResults.filter(Boolean).reduce((sum, rows) => sum + rows.length, 0),
      });
    });
    if (verifierFailed) return;
    const flattenedChunkResults = chunkResults.flat();

    const normalized = normalizeVerifierBatch({
      verifier,
      run_id: run.run_id,
      results: flattenedChunkResults,
    }, run, verifier);
    const outputPath = join(dir, `verification.${verifier}.json`);
    writeJson(outputPath, normalized, { mode: 0o600 });
    run.verifier_verdicts = [
      ...(run.verifier_verdicts || []).filter((row) => row.verifier !== verifier),
      ...normalized.results,
    ];
    updateVerifierStatus(run, verifier, "completed", {
      pid,
      result_count: normalized.results.length,
      chunks_total: claimChunks.length,
      chunks_completed: claimChunks.length,
      output: outputPath,
      completed_at: new Date().toISOString(),
    });
  });

  const audit = verificationAuditStatus(run);
  run.verification_policy.status = audit.status;
  run.verification_policy.completed_at = new Date().toISOString();
  const auditComplete = audit.status !== "needs_verification";
  run.phase = auditComplete ? "verification_complete" : "needs_verification";
  run.status = auditComplete ? "running" : "needs_verification";
  saveRun(run);
  writeSourceManifest(run);
  writeStatus(run);
  appendEvent(run, auditComplete ? "verification_complete" : "needs_verification", {
    policy_id: audit.policy_id,
    recorded_verdict_count: audit.recorded_verdict_count,
    expected_verdict_count: audit.expected_verdict_count,
    missing_count: audit.missing.length,
    non_clean_count: audit.non_clean.length,
    verifier_zero: audit.verifier_zero,
  });
  writeAllAgentsMarkdown(run);
  return run;
}

function updateMasterStatus(run, master, status, patch = {}) {
  run.master_status = run.master_status || {};
  run.master_status[master] = {
    ...(run.master_status[master] || {}),
    ...patch,
    master,
    status,
    updated_at: new Date().toISOString(),
  };
  // A terminal status is not observable until the same state is durable in the canonical
  // evidence record. Recovery reads evidence.json, so status-only settlement would lose a
  // completed opinion (or resurrect a failed seat) when the process dies at the barrier.
  if (["completed", "failed"].includes(status)) saveRun(run);
  else writeStatus(run);
  appendEvent(run, `master_${status}`, { master, ...patch });
}

function commitHeadlessMasterOutcome(run, outcome, { dir, byId, selected }) {
  const completedAt = new Date().toISOString();
  if (!outcome.opinion) {
    const diagnosticPath = join(dir, `${outcome.id}.failure.json`);
    const provenanceFailure = ["source_provenance_mismatch", "source_provenance_required"]
      .includes(outcome.error);
    const publicSummary = outcome.error === "reader_language_mismatch"
      ? localized(run.language, {
        en: "The dedicated method worker returned reader-facing content in the wrong language; no method-seat statement is available.",
        zh: "专属方法席 worker 返回了错误语言的读者内容；没有可用的方法席发言。",
        ja: "専用メソッド席ワーカーは指定と異なる言語の読者向け内容を返したため、利用可能なメソッド席の発言はありません。",
        ko: "전용 방법론 좌석 워커가 지정과 다른 언어의 독자용 내용을 반환해 사용할 수 있는 방법론 좌석 발언이 없습니다.",
      })
      : provenanceFailure
        ? localized(run.language, {
          en: "The method seat failed the frozen source-provenance gate; no worker repair or method-seat statement is available.",
          zh: "该方法席未通过冻结来源追溯闸门；系统未执行 worker repair，也没有可用的方法席发言。",
          ja: "このメソッド席は凍結済み出典来歴ゲートを通過できず、ワーカー修復も利用可能な発言もありません。",
          ko: "이 방법론 좌석은 동결된 출처 추적 게이트를 통과하지 못해 워커 복구나 사용할 수 있는 발언이 없습니다.",
        })
        : localized(run.language, {
          en: "The dedicated method worker did not complete; no method-seat statement is available.",
          zh: "专属方法席 worker 未完成；没有可用的方法席发言。",
          ja: "専用メソッド席ワーカーが完了せず、利用可能なメソッド席の発言はありません。",
          ko: "전용 방법론 좌석 워커가 완료되지 않아 사용할 수 있는 방법론 좌석 발언이 없습니다.",
        });
    const diagnostic = outcome.diagnostic || masterAttemptFailureDiagnostic({
      master: outcome.id,
      attempt: outcome.attempts ?? 0,
      failureKind: outcome.error || "unexpected_error",
      error: new Error(cleanLog(outcome.raw || outcome.error || "method worker failed", 1_000)),
      stage: outcome.failure_stage || "worker_execution",
    });
    writeJson(diagnosticPath, { ...diagnostic, public_summary: publicSummary }, { mode: 0o600 });
    updateMasterStatus(run, outcome.id, "failed", {
      ...(outcome.engine ? { engine: outcome.engine } : {}),
      error: outcome.error || "unexpected_error",
      ...(outcome.error_code ? { error_code: outcome.error_code } : {}),
      diagnostic: diagnosticPath,
      completed_at: completedAt,
      ...(Number.isInteger(outcome.attempts) ? { attempts: outcome.attempts } : {}),
      ...(outcome.retry_diagnostic ? { retry_diagnostic: outcome.retry_diagnostic } : {}),
      ...(outcome.failure_stage ? { failure_stage: outcome.failure_stage } : {}),
    });
    return outcome;
  }

  byId.set(outcome.id, outcome.opinion);
  run.master_opinions = selected.map((id) => byId.get(id)).filter(Boolean);
  const outputPath = join(dir, `${outcome.id}.json`);
  writeJson(outputPath, outcome.opinion);
  updateMasterStatus(run, outcome.id, "completed", {
    engine: outcome.opinion.engine || outcome.engine,
    worker_kind: outcome.opinion.dedicated_worker?.execution_mode === "dry_run"
      ? "dedicated_method_voice_dry_run"
      : "dedicated_method_worker",
    worker_pid: outcome.opinion.dedicated_worker?.pid || null,
    voice_status: outcome.opinion.voice_status || "completed",
    ...(outcome.opinion.company_dossier_hash_ack
      ? { company_dossier_hash_ack: outcome.opinion.company_dossier_hash_ack }
      : {}),
    ...(Array.isArray(outcome.opinion.evidence_packet_acks)
      ? {
        evidence_packet_ack_count: outcome.opinion.evidence_packet_acks.length,
        evidence_packet_ack_statuses: Object.fromEntries(outcome.opinion.evidence_packet_acks
          .map((ack) => [ack.task, ack.status])),
      }
      : {}),
    completed_at: completedAt,
    output: outputPath,
    ...(Number.isInteger(outcome.attempts) ? { attempts: outcome.attempts } : {}),
    ...(outcome.retry_diagnostic ? { retry_diagnostic: outcome.retry_diagnostic } : {}),
  });
  return outcome;
}

/** Execute every selected master between evidence collection and the bull/bear debate. */
export async function runHeadlessMasters(run, args = {}) {
  const selected = selectedMasters(run);
  const dir = runPath(run.run_id);
  const timeoutMs = masterStageTimeout(args, run);
  const defaultConcurrency = run.council_mode === "quick"
    ? 4
    : Math.min(selected.length, LIMITS.FULL_MASTER_CONCURRENCY);
  const requestedConcurrency = Number(args.max_concurrency || defaultConcurrency);
  const maxConcurrency = Math.max(
    defaultConcurrency,
    Math.min(LIMITS.CONCURRENCY_MAX, Number.isFinite(requestedConcurrency) ? requestedConcurrency : defaultConcurrency),
  );
  const plan = planMasterSeats(run, selected);
  const byId = new Map((run.master_opinions || []).map((opinion) => [opinion.master, opinion]));

  run.phase = "masters";
  run.status = "running";
  run.completed_at = null;
  run.master_decisions = plan.decisions;
  run.fact_pack_hash = plan.shared_fact_pack_hash;
  run.master_runtime_provenance = masterRuntimeProvenance(run, plan);
  appendEvent(run, "masters_started", {
    selected: selected.length,
    to_run: plan.to_run.length,
    declined: plan.declined.length,
    completed: plan.completed.length,
    blocked: plan.blocked.length,
  });

  for (const item of plan.blocked) {
    updateMasterStatus(run, item.id, "failed", {
      engine: item.engine,
      error: item.reason,
      error_code: item.error_code || "V3_POLICY_EXECUTION_FAILED",
      diagnostic: item.error || undefined,
    });
  }

  const workerItems = [
    ...plan.declined.map((item) => ({
      ...item,
      frozenOpinion: attachMasterRuntimeProvenance(run, item.id, declinedMasterOpinion(run, item), item.engine),
      deterministic_decline: true,
    })),
    ...plan.completed.map((item) => ({
      ...item,
      frozenOpinion: attachMasterRuntimeProvenance(run, item.id, completedMasterOpinion(run, item), item.engine),
      deterministic_execution: true,
    })),
    ...plan.to_run,
  ];
  // A frozen abstention has no reading for a worker to explain, and its deterministic statement
  // already carries what the contract asks of an out_of_scope seat. Publish it directly instead
  // of spending one model turn per seat to restate it.
  const abstainedWithoutWorker = [];
  const votingWorkerItems = workerItems.filter((item) => {
    if (!item.frozenOpinion || needsMethodVoiceWorker(item.frozenOpinion, { run })) return true;
    abstainedWithoutWorker.push(item);
    return false;
  });
  for (const item of workerItems) {
    if (!item.frozenOpinion) continue;
    writeJson(join(dir, `${item.id}.deterministic.json`), item.frozenOpinion);
  }

  const abstainedOutcomes = abstainedWithoutWorker.map(({ id, engine, frozenOpinion }) => ({
    id,
    engine,
    opinion: {
      ...frozenOpinion,
      deterministic_summary: frozenOpinion.summary,
      voice_statement: frozenOpinion.voice_statement || frozenOpinion.summary,
      voice_status: "deterministic_scope",
      voice_language: run.language,
      statement_origin: "deterministic_scope_fallback",
      dedicated_worker: {
        status: "not_required_frozen_abstention",
        language: run.language,
        execution_mode: "deterministic_only",
      },
    },
  }));

  for (const outcome of abstainedOutcomes) {
    commitHeadlessMasterOutcome(run, outcome, { dir, byId, selected });
  }

  const runnableVotingItems = [];
  for (const item of votingWorkerItems) {
    if (!item.frozenOpinion) {
      runnableVotingItems.push(item);
      continue;
    }
    try {
      assertSourceIdsResolve(run, item.frozenOpinion.source_ids, item.id, {
        allowEmpty: item.frozenOpinion.stance === "out_of_scope",
      });
      runnableVotingItems.push(item);
    } catch (error) {
      const failureKind = outputFailureKind(error);
      commitHeadlessMasterOutcome(run, {
        id: item.id,
        engine: item.engine,
        error: failureKind,
        attempts: 0,
        failure_stage: "frozen_source_preflight",
        diagnostic: masterAttemptFailureDiagnostic({
          master: item.id,
          attempt: 0,
          failureKind,
          error,
          stage: "frozen_source_preflight",
        }),
      }, { dir, byId, selected });
    }
  }

  await mapLimit(runnableVotingItems, maxConcurrency, async ({ id, decision, engine, frozenOpinion, deterministic_decline, deterministic_execution }) => {
    const outcome = await (async () => {
    const prompt = frozenOpinion
      ? masterVoicePrompt(id, run, frozenOpinion)
      : [
        masterPrompt(id, run),
        decision ? deterministicVerdictBlock(decision, isChineseLanguage(run.language)) : "",
      ].filter(Boolean).join("\n\n");
    updateMasterStatus(run, id, "running", {
      started_at: new Date().toISOString(),
      worker_kind: frozenOpinion ? "dedicated_method_voice" : "dedicated_method_judgment",
      deterministic_decline: deterministic_decline || undefined,
      deterministic_execution: deterministic_execution || undefined,
    });

    if (run.dry_run) {
      if (frozenOpinion) {
        return {
          id,
          engine,
          opinion: {
            ...frozenOpinion,
            deterministic_summary: frozenOpinion.summary,
            voice_statement: frozenOpinion.summary,
            voice_status: "dry_run",
            dedicated_worker: { status: "dry_run", language: run.language, execution_mode: "dry_run" },
          },
        };
      }
      const normalized = normalizeMasterOpinion({
        verdict: "DRY_RUN",
        stance: "out_of_scope",
        summary: "Dry run: the dedicated method worker was planned but no model judgment was executed.",
        what_would_change_my_mind: ["Run without dry_run to obtain a method judgment."],
        confidence: "low",
      }, id, run, prompt);
      const reconciled = reconcileMasterOpinion(run, id, normalized);
      const resolvedEngine = engine || reconciled.engine || (decision ? "v2_method_model" : "v1_prompt");
      return {
        id,
        opinion: attachMasterRuntimeProvenance(run, id, {
          ...reconciled.opinion,
          voice_status: "dry_run",
          dedicated_worker: { status: "dry_run", language: run.language, execution_mode: "dry_run" },
        }, resolvedEngine),
        engine: resolvedEngine,
      };
    }

    let pid = null;
    const execute = async (workerPrompt, budgetMs, attempt) => {
      const allowedMs = remainingCouncilBudget(run, budgetMs);
      if (allowedMs <= 0) return { ...deadlineResult(run), budget_ms: 0 };
      const result = await runCodex(workerPrompt, allowedMs, ({ pid: workerPid, output }) => {
        pid = workerPid;
        updateMasterStatus(run, id, "running", { pid: workerPid, output, attempts: attempt });
      }, ({ pid: workerPid, output, elapsed_ms }) => {
        updateMasterStatus(run, id, "running", { pid: workerPid, output, elapsed_ms, attempts: attempt });
      }, { search: false, sigkillGraceMs: councilKillGrace(run) });
      return { ...result, budget_ms: allowedMs };
    };
    const parse = (result, { repairedTransport = false } = {}) => {
      if (frozenOpinion) {
        const voicePacket = repairedTransport
          ? extractRepairedWorkerJson(result.text, "method_voice")
          : extractWorkerJson(result.text, "method_voice");
        assertCompanyDossierAck(voicePacket, run, `master voice ${id}`);
        const voice = normalizeMasterVoice(voicePacket, id, run, frozenOpinion, result.text);
        assertReaderLanguage([
          voice.statement,
          ...(voice.key_findings || []),
          ...(voice.disagreements || []),
          ...(voice.what_would_change_my_mind || []),
        ].filter(Boolean).join("\n"), run.language, `master voice ${id}`);
        return attachMasterRuntimeProvenance(run, id, {
          ...frozenOpinion,
          deterministic_summary: frozenOpinion.summary,
          summary: voice.statement,
          voice_statement: voice.statement,
          voice: voice.voice,
          position_intent: voice.position_intent,
          voice_mode: voice.voice_mode,
          disclosure_ack: voice.disclosure_ack,
          disclosure: voice.disclosure,
          voice_status: "completed",
          voice_language: run.language,
          statement_origin: "dedicated_method_voice_worker",
          key_findings: voice.key_findings.length ? voice.key_findings : frozenOpinion.key_findings,
          disagreements: voice.disagreements,
          what_would_change_my_mind: voice.what_would_change_my_mind.length
            ? voice.what_would_change_my_mind
            : frozenOpinion.what_would_change_my_mind,
          source_ids: [...new Set([...(frozenOpinion.source_ids || []), ...voice.source_ids])],
          evidence_source_ids: [...new Set([...(frozenOpinion.source_ids || []), ...voice.source_ids])],
          confidence: voice.confidence,
          company_dossier_hash_ack: voice.company_dossier_hash_ack,
          evidence_packet_acks: voice.evidence_packet_acks,
          dedicated_worker: { status: "completed", pid, language: run.language, execution_mode: "codex_exec" },
        }, engine);
      }
      const normalized = normalizeMasterOpinion(extractJson(result.text), id, run, result.text);
      assertReaderLanguage([
        normalized.summary,
        normalized.verdict,
        ...(normalized.key_findings || []),
        ...(normalized.disagreements || []),
        ...(normalized.what_would_change_my_mind || []),
      ].filter(Boolean).join("\n"), run.language, `legacy master voice ${id}`);
      const reconciled = reconcileMasterOpinion(run, id, normalized);
      const resolvedEngine = engine || reconciled.engine || (decision ? "v2_method_model" : "v1_prompt");
      return attachMasterRuntimeProvenance(run, id, {
        ...reconciled.opinion,
        voice_statement: reconciled.opinion.summary || reconciled.opinion.verdict,
        voice_status: "completed",
        voice_language: run.language,
        dedicated_worker: { status: "completed", pid, language: run.language, execution_mode: "codex_exec" },
      }, resolvedEngine);
    };

    const workerStartedAt = Date.now();
    let result = await execute(prompt, timeoutMs, 1);
    if (!result.ok) {
      return { id, error: result.deadline_exhausted ? "global_deadline" : result.timedOut ? "timeout" : `exit code ${result.code}`, raw: cleanLog(result.stderr || result.stdout || "method worker failed") };
    }
    try {
      return { id, opinion: parse(result), engine };
    } catch (firstParseError) {
      const firstFailureKind = outputFailureKind(firstParseError);
      const firstSchemaErrors = boundedSchemaRepairIssues(firstParseError);
      const retryDiagnostic = join(dir, `${id}.attempt-1.failure.json`);
      const firstDiagnostic = masterAttemptFailureDiagnostic({
        master: id,
        attempt: 1,
        failureKind: firstFailureKind,
        error: firstParseError,
        result,
      });
      writeJson(retryDiagnostic, firstDiagnostic, { mode: 0o600 });
      if (!repairableOutputFailure(firstFailureKind)) {
        return {
          id,
          engine,
          error: firstFailureKind,
          attempts: 1,
          retry_diagnostic: retryDiagnostic,
          failure_stage: "worker_output_provenance",
          diagnostic: firstDiagnostic,
        };
      }
      const repairBudget = parseRepairBudget(run, {
        stageBudgetMs: timeoutMs,
        stageStartedAtMs: workerStartedAt,
      });
      if (repairBudget <= 0) {
        return {
          id,
          engine,
          error: firstFailureKind,
          attempts: 1,
          retry_diagnostic: retryDiagnostic,
          schema_errors: firstSchemaErrors,
          diagnostic: firstDiagnostic,
        };
      }
      appendEvent(run, "master_parse_repair", {
        master: id,
        budget_ms: repairBudget,
        reason: firstFailureKind,
        retry_diagnostic: retryDiagnostic,
      });
      updateMasterStatus(run, id, "running", { attempts: 2, retry_diagnostic: retryDiagnostic });
      const repairPrompt = [
        "PARSE-ONLY TRANSPORT REPAIR. Do not browse, search, add facts or change the frozen method stance.",
        `Master ID: ${id}; required acknowledged stance: ${frozenOpinion?.stance || "use the original stance"}; output language: ${run.language}.`,
        frozenOpinion
          ? methodVoiceOutputContract(id, run, frozenOpinion)
          : "Return one JSON object matching the master_opinion schema from the original prompt.",
        schemaRepairIssuePrompt(firstParseError),
        `Write every reader-facing value in ${run.language}. Translation is allowed only to repair language; preserve the frozen stance, facts, numbers and source IDs.`,
        `Malformed output:\n${String(result.text || "").slice(0, LIMITS.PARSE_REPAIR_INPUT_CHARS)}`,
      ].join("\n\n");
      result = await execute(repairPrompt, repairBudget, 2);
      if (!result.ok) {
        return {
          id,
          error: result.deadline_exhausted ? "global_deadline" : result.timedOut ? "timeout" : `exit code ${result.code}`,
          raw: cleanLog(result.stderr || "method repair failed"),
          schema_errors: firstSchemaErrors,
        };
      }
      try {
        return { id, opinion: parse(result, { repairedTransport: true }), engine };
      } catch (secondParseError) {
        const secondFailureKind = outputFailureKind(secondParseError);
        if (secondFailureKind === "reader_language_mismatch") {
          const secondDiagnosticPath = join(dir, `${id}.attempt-2.failure.json`);
          const secondDiagnostic = masterAttemptFailureDiagnostic({
            master: id,
            attempt: 2,
            failureKind: secondFailureKind,
            error: secondParseError,
            result,
            stage: "language_repair_output",
          });
          writeJson(secondDiagnosticPath, secondDiagnostic, { mode: 0o600 });
          const languageBudget = parseRepairBudget(run, {
            stageBudgetMs: timeoutMs,
            stageStartedAtMs: workerStartedAt,
          });
          if (languageBudget > 0) {
            appendEvent(run, "master_language_repair", {
              master: id,
              budget_ms: languageBudget,
              reason: secondFailureKind,
              retry_diagnostic: secondDiagnosticPath,
            });
            updateMasterStatus(run, id, "running", {
              attempts: 3,
              retry_diagnostic: secondDiagnosticPath,
              retry_kind: "language_only_translation_repair",
            });
            const languagePrompt = [
              "FINAL LANGUAGE-ONLY TRANSPORT REPAIR. Do not browse, search, add facts, remove facts, change numbers, change source IDs, change packet acknowledgements, or change the frozen stance.",
              `Master ID: ${id}; required acknowledged stance: ${frozenOpinion?.stance || "preserve input"}; output language: ${run.language}.`,
              `Translate EVERY reader-facing prose string into ${run.language}: all five voice fields, key_findings, disagreements, what_would_change_my_mind, and every evidence_packet_acks.note. Keep the method in first person.`,
              "Do not translate JSON keys or contract values: master, acknowledged_stance, voice_mode, disclosure_ack, position_intent, confidence, task, packet_hash, status, source_ids, URLs, tickers, formulas, and numbers. Return exactly one JSON object and no commentary.",
              `Valid but wrong-language input JSON:\n${String(result.text || "").slice(0, LIMITS.PARSE_REPAIR_INPUT_CHARS)}`,
            ].join("\n\n");
            result = await execute(languagePrompt, languageBudget, 3);
            if (result.ok) {
              try {
                return { id, opinion: parse(result, { repairedTransport: true }), engine };
              } catch (thirdParseError) {
                return {
                  id,
                  error: outputFailureKind(thirdParseError),
                  raw: cleanLog(thirdParseError?.message || result.text),
                  schema_errors: boundedSchemaRepairIssues(thirdParseError),
                };
              }
            }
            return {
              id,
              error: result.deadline_exhausted ? "global_deadline" : result.timedOut ? "timeout" : `exit code ${result.code}`,
              raw: cleanLog(result.stderr || "method language repair failed"),
            };
          }
        }
        return {
          id,
          error: secondFailureKind,
          raw: cleanLog(secondParseError?.message || result.text),
          schema_errors: boundedSchemaRepairIssues(secondParseError),
        };
      }
    }
    })();
    return commitHeadlessMasterOutcome(run, outcome, { dir, byId, selected });
  }, (error, { id, engine }) => commitHeadlessMasterOutcome(run, {
    id,
    engine,
    error: "unexpected_error",
    raw: cleanLog(error?.message || error),
    failure_stage: "worker_execution",
  }, { dir, byId, selected }));

  run.master_opinions = selected.map((id) => byId.get(id)).filter(Boolean);
  const missing = selected.filter((id) => !byId.has(id));
  run.phase = missing.length ? "masters_partial" : "masters_complete";
  run.status = missing.length ? "partial" : "masters_complete";
  saveRun(run);
  appendEvent(run, "masters_complete", { completed: run.master_opinions.length, total: selected.length, missing });
  return run;
}

export async function runDebateRole(run, role, context, timeoutMs) {
  const structuredManagerDecision = role === "portfolio_manager" && context.structuredDecisionOnly === true;
  const prompt = debatePrompt(role, run, {
    ...context,
    ...(structuredManagerDecision ? { structuredDecisionOnly: true } : {}),
  });
  updateAgent(run, role, "running", { started_at: new Date().toISOString(), round: context.round, attempts: 1 });
  const workerStartedAt = Date.now();
  let attemptCount = 1;
  const attemptDiagnostics = [];
  let result = timeoutMs <= 0
    ? deadlineResult(run)
    : await runCodex(prompt, timeoutMs, ({ pid, output }) => {
      updateAgent(run, role, "running", { pid, output, round: context.round });
    }, ({ pid, output, elapsed_ms }) => {
      updateAgent(run, role, "running", { pid, output, round: context.round });
      appendEvent(run, "agent_heartbeat", { role, round: context.round, pid, output, elapsed_ms });
    }, { search: false, sigkillGraceMs: councilKillGrace(run) });
  const parseWorkerPacket = (workerResult, workerPrompt, { repairedTransport = false } = {}) => {
    const candidate = debateFromCodex(workerResult, role, run, workerPrompt, {
      managerDecisionOnly: structuredManagerDecision,
      repairedTransport,
    });
    if (!structuredManagerDecision || candidate?.failure_kind) return candidate;
    try {
      // The base decision source_ids already passed assertSourceIdsResolve in debateFromCodex.
      // Validate optional per-price-band IDs too before any model prose reaches the report.
      assertSourceIdsResolve(run, managerDecisionNestedSourceIds(candidate), `${role} structured decision`);
      return normalizeDebate({
        ...candidate,
        report_markdown: renderStructuredManagerReport(run, candidate, {
          bull: context.bull,
          bear: context.bear,
        }),
      }, role, run, candidate.raw_text || "");
    } catch (error) {
      const reason = String(error?.data?.reason || "WORKER_OUTPUT_REJECTED");
      return {
        ...debateFailurePacket(role, run, "parse_failed"),
        output_contract_diagnostic: {
          reason: /^[A-Z0-9_]{1,96}$/u.test(reason) ? reason : "WORKER_OUTPUT_REJECTED",
        },
      };
    }
  };
  const enforceLanguage = (candidate) => {
    if (candidate?.failure_kind) return candidate;
    try {
      assertReaderLanguage([
        candidate?.summary,
        ...(candidate?.long_thesis || []),
        ...(candidate?.short_thesis || []),
        ...(candidate?.catalysts || []),
        ...(candidate?.risks || []),
        candidate?.position,
        ...(candidate?.invalidation || []),
        ...(candidate?.questions || []),
        ...(candidate?.questions_answered || []).flatMap((item) => [item?.question, item?.answer]),
        candidate?.report_markdown,
      ].filter(Boolean).join("\n"), run.language, `${role} debate output`);
      if (role === "portfolio_manager") {
        const gaps = authoredReportSectionGaps(candidate?.report_markdown, run);
        if (gaps.length) {
          return {
            ...debateFailurePacket(role, run, "parse_failed"),
            contract_errors: gaps,
          };
        }
      }
      return candidate;
    } catch (error) {
      return debateFailurePacket(role, run, "reader_language_mismatch");
    }
  };
  const persistManagerAttemptDiagnostic = (attempt, candidate, workerResult) => {
    if (!structuredManagerDecision || !candidate?.failure_kind) return null;
    const path = join(runPath(run.run_id), `portfolio_manager.attempt-${attempt}.failure.json`);
    const diagnostic = portfolioManagerAttemptDiagnostic({
      attempt,
      failureKind: candidate.failure_kind,
      packet: candidate,
      result: workerResult,
    });
    writeJson(path, diagnostic, { mode: 0o600 });
    attemptDiagnostics.push(path);
    appendEvent(run, "agent_attempt_diagnostic", {
      role,
      attempt,
      failure_kind: diagnostic.failure_kind,
      reason: diagnostic.reason,
      diagnostic: path,
    });
    updateAgent(run, role, "running", {
      attempts: attempt,
      attempt_diagnostics: [...attemptDiagnostics],
    });
    return path;
  };

  let packet = enforceLanguage(parseWorkerPacket(result, prompt));
  if (result.ok && ["parse_failed", "reader_language_mismatch"].includes(packet.failure_kind)) {
    persistManagerAttemptDiagnostic(1, packet, result);
    const repairBudget = parseRepairBudget(run, {
      stageBudgetMs: timeoutMs,
      stageStartedAtMs: workerStartedAt,
    });
    if (repairBudget > 0) {
      const repairReason = packet.failure_kind;
      appendEvent(run, "agent_parse_repair", { role, round: context.round, budget_ms: repairBudget, reason: repairReason });
      const repairPrompt = [
        "PARSE-ONLY TRANSPORT REPAIR. Do not search, browse, add facts or redo the analysis.",
        `Role: ${role}; symbol: ${run.symbol}; as_of: ${run.as_of}; reader language: ${run.language}; round: ${context.round || "final"}.`,
        repairReason === "reader_language_mismatch"
          ? "Translate only the reader-facing strings in the supplied valid debate-packet JSON. Preserve exact round-2 questions, exact round-3 question bindings, facts, numbers, source IDs and uncertainty. Return one JSON object only."
          : "Convert only the supplied malformed output into one valid debate-packet JSON object. Preserve exact round-2 questions and exact round-3 question bindings when present. Return JSON only.",
        structuredManagerDecision
          ? "Return only HEADLESS_STRUCTURED_PM_DECISION_V1: the compact required debate fields plus price_levels, horizon_views and data_gaps. Omit report_markdown completely; the server renders it deterministically."
          : role === "portfolio_manager"
            ? `portfolio_manager.report_markdown is mandatory and must contain every authored report section. Required headings: ${requiredReportSectionAliases(run).map((section) => section.suggested_heading).join("; ")}.`
          : "",
        companyDossierPromptBlock(run),
        schemaRepairIssuePrompt(packet.schema_errors),
        `Write every reader-facing value in ${run.language}. Translation is allowed only to repair language; preserve facts, numbers, source IDs and exact Q&A bindings.`,
        `Malformed output:\n${String(result.text || "").slice(0, structuredManagerDecision
          ? Math.min(LIMITS.PARSE_REPAIR_INPUT_CHARS, 32_000)
          : LIMITS.PARSE_REPAIR_INPUT_CHARS)}`,
      ].join("\n\n");
      attemptCount = 2;
      result = await runCodex(repairPrompt, repairBudget, ({ pid, output }) => {
        updateAgent(run, role, "running", { pid, output, round: context.round, attempts: 2 });
      }, () => {}, { search: false, sigkillGraceMs: councilKillGrace(run) });
      packet = enforceLanguage(parseWorkerPacket(result, repairPrompt, { repairedTransport: true }));
      if (packet?.failure_kind) persistManagerAttemptDiagnostic(2, packet, result);
    }
  }
  const roundCompletedAt = new Date().toISOString();
  if (Number.isInteger(context.round)) {
    // A role can run three times. Leaving it marked `running` after one awaited invocation
    // returned made sequential rounds look concurrent in status.json. Record the dependency
    // boundary explicitly while reserving `completed` for the merged three-round artifact.
    updateAgent(run, role, "waiting", {
      round: context.round,
      round_status: "completed",
      last_completed_round: context.round,
      round_completed_at: roundCompletedAt,
      pid: null,
      output: null,
      attempts: attemptCount,
      ...(attemptDiagnostics.length ? { attempt_diagnostics: [...attemptDiagnostics] } : {}),
    });
    appendEvent(run, "agent_round_completed", {
      role,
      round: context.round,
      ok: result.ok,
      timed_out: result.timedOut === true,
      verdict: packet.verdict,
      failure_kind: packet.failure_kind,
      question_count: packet.questions.length,
      answered_count: packet.questions_answered.length,
    });
  } else {
    updateAgent(run, role, "waiting", {
      synthesis_status: "completed",
      synthesis_completed_at: roundCompletedAt,
      pid: null,
      output: null,
      attempts: attemptCount,
      ...(attemptDiagnostics.length ? { attempt_diagnostics: [...attemptDiagnostics] } : {}),
    });
    appendEvent(run, "agent_role_completed", {
      role,
      ok: result.ok,
      timed_out: result.timedOut === true,
      verdict: packet.verdict,
      failure_kind: packet.failure_kind,
    });
  }
  return { packet, result, attempts: attemptCount, attempt_diagnostics: attemptDiagnostics };
}

function debateFailure(step) {
  if (!step.result.ok) {
    if (step.result.deadline_exhausted) return "global_deadline";
    if (step.result.timedOut) return "timeout";
    if (Number.isInteger(step.result.code)) return `exit code ${step.result.code}`;
    return "unexpected_error";
  }
  if (step.packet.failure_kind) return step.packet.failure_kind;
  if (step.packet.verdict === "PARSE_FAILED") return "parse_failed";
  return undefined;
}

async function synthesizeQuickDecision(run, args, timeoutMs, outputMode) {
  const dir = runPath(run.run_id);
  appendEvent(run, "debate_round", { round: 1, format: "single_round_parallel" });
  const sideBudget = remainingCouncilBudget(run, timeoutMs);
  const [bullOutcome, bearOutcome] = await Promise.allSettled([
    runDebateRole(run, "bull_researcher", { round: 1, brief: "quick long case" }, sideBudget),
    runDebateRole(run, "bear_researcher", { round: 1, brief: "quick short case" }, sideBudget),
  ]);
  const settledStep = (outcome, role) => {
    if (outcome.status === "fulfilled") return outcome.value;
    const result = {
      ok: false,
      code: null,
      text: "",
      stderr: cleanLog(outcome.reason?.message || outcome.reason),
      stdout: "",
      timedOut: false,
      unexpected_error: true,
    };
    return { result, packet: debateFromCodex(result, role, run, "unexpected quick debate failure") };
  };
  const bullStep = settledStep(bullOutcome, "bull_researcher");
  const bearStep = settledStep(bearOutcome, "bear_researcher");
  const bull = mergeDebateRounds([bullStep.packet]);
  const bear = mergeDebateRounds([bearStep.packet]);
  const bullError = debateFailure(bullStep);
  const bearError = debateFailure(bearStep);

  writeJson(join(dir, "bull_researcher.json"), bull);
  updateAgent(run, "bull_researcher", bullError ? "degraded" : "completed", {
    completed_at: new Date().toISOString(),
    output: join(dir, "bull_researcher.json"),
    error: bullError,
  });
  writeJson(join(dir, "bear_researcher.json"), bear);
  updateAgent(run, "bear_researcher", bearError ? "degraded" : "completed", {
    completed_at: new Date().toISOString(),
    output: join(dir, "bear_researcher.json"),
    error: bearError,
  });
  appendEvent(run, "debate_qna_gate", {
    status: "not_run",
    reason: "quick_single_round",
    full_council_equivalent: false,
  });
  writeAllAgentsMarkdown(run, { bull, bear });

  const managerBudget = remainingCouncilBudget(run, timeoutMs);
  const managerStep = await runDebateRole(run, "portfolio_manager", { bull, bear, outputMode }, managerBudget);
  const managerError = debateFailure(managerStep);
  const managerOk = !managerError;
  const manager = managerOk ? managerStep.packet : managerFallback(run, args.prompt || "", managerStep.packet);
  writeJson(join(dir, "manager_synthesis.json"), manager);
  writeJson(join(dir, "decision.json"), manager);
  updateAgent(run, "portfolio_manager", managerOk ? "completed" : "failed", {
    completed_at: new Date().toISOString(),
    output: join(dir, "manager_synthesis.json"),
    error: managerOk
      ? undefined
      : managerError,
  });

  const gate = verificationStatus(run);
  const completeness = completenessStatus(run);
  run.completed_at = new Date().toISOString();
  if (completeness.completeness === "incomplete") {
    run.phase = "incomplete";
    run.status = "incomplete";
    appendEvent(run, "incomplete", {
      missing_evidence: completeness.missing_evidence,
      missing_debate: completeness.missing_debate,
      missing_masters: completeness.missing_masters,
      degraded_evidence: completeness.degraded_evidence,
      degraded_debate: completeness.degraded_debate,
    });
  } else if (gate.verification === "needs_verification") {
    run.phase = "needs_verification";
    run.status = "needs_verification";
    appendEvent(run, "needs_verification", { missing: gate.missing_claim_source_ids.length });
  } else if (completeness.degraded_evidence.length || completeness.degraded_debate.length) {
    run.phase = "degraded";
    run.status = "degraded";
    appendEvent(run, "run_degraded", {
      degraded_evidence: completeness.degraded_evidence,
      degraded_debate: completeness.degraded_debate,
    });
  } else {
    run.phase = "complete";
    run.status = "complete";
  }
  const finalArtifacts = commitFinalArtifacts(run, { bull, bear, manager });
  return { bull, bear, manager, ...finalArtifacts };
}

function finalizeBeforeDebate(run, args, reason) {
  const dir = runPath(run.run_id);
  for (const role of DEBATE_ROLES) {
    if (["pending", "waiting", "running"].includes(agentState(run, role).status)) {
      updateAgent(run, role, "skipped", { error: reason, completed_at: new Date().toISOString() });
    }
  }
  const manager = managerFallback(run, args.prompt || "");
  writeJson(join(dir, "manager_synthesis.json"), manager);
  writeJson(join(dir, "decision.json"), manager);
  run.phase = "incomplete";
  run.status = "incomplete";
  run.completed_at = new Date().toISOString();
  const completeness = completenessStatus(run);
  appendEvent(run, "incomplete", {
    reason,
    downstream_model_calls_skipped: true,
    missing_evidence: completeness.missing_evidence,
    missing_debate: completeness.missing_debate,
    missing_masters: completeness.missing_masters,
  });
  const finalArtifacts = commitFinalArtifacts(run, { manager });
  return { bull: null, bear: null, manager, ...finalArtifacts };
}

function finalizeNeedsVerification(run, args, reason = "verification_gate_failed") {
  const dir = runPath(run.run_id);
  for (const master of selectedMasters(run)) {
    if (["pending", "waiting", "running"].includes(run.master_status?.[master]?.status || "pending")) {
      updateMasterStatus(run, master, "failed", {
        error: reason,
        error_code: "TRIPLE_VERIFICATION_REQUIRED",
        completed_at: new Date().toISOString(),
      });
    }
  }
  for (const role of DEBATE_ROLES) {
    if (["pending", "waiting", "running"].includes(agentState(run, role).status)) {
      updateAgent(run, role, "skipped", { error: reason, completed_at: new Date().toISOString() });
    }
  }
  const manager = managerFallback(run, args.prompt || "");
  writeJson(join(dir, "manager_synthesis.json"), manager);
  writeJson(join(dir, "decision.json"), manager);
  run.phase = "needs_verification";
  run.status = "needs_verification";
  run.completed_at = new Date().toISOString();
  const gate = verificationStatus(run);
  appendEvent(run, "needs_verification", {
    reason,
    downstream_model_calls_skipped: true,
    verifier_zero: gate.verifier_audit.verifier_zero,
    verifier_recorded: gate.verifier_audit.recorded_verdict_count,
    verifier_expected: gate.verifier_audit.expected_verdict_count,
    verifier_missing: gate.verifier_audit.missing.length,
    verifier_non_clean: gate.verifier_audit.non_clean.length,
    missing_source_ids: gate.missing_claim_source_ids.length,
  });
  const finalArtifacts = commitFinalArtifacts(run, { manager });
  return { bull: null, bear: null, manager, ...finalArtifacts };
}

function finalizeAfterDebateFailure(run, args, reason, bullRounds = [], bearRounds = []) {
  const dir = runPath(run.run_id);
  const bull = mergeDebateRounds(bullRounds.map((step) => step?.packet).filter(Boolean));
  const bear = mergeDebateRounds(bearRounds.map((step) => step?.packet).filter(Boolean));
  if (bull) writeJson(join(dir, "bull_researcher.json"), bull);
  if (bear) writeJson(join(dir, "bear_researcher.json"), bear);
  updateAgent(run, "bull_researcher", "failed", {
    error: reason,
    completed_at: new Date().toISOString(),
    output: bull ? join(dir, "bull_researcher.json") : undefined,
  });
  updateAgent(run, "bear_researcher", "failed", {
    error: reason,
    completed_at: new Date().toISOString(),
    output: bear ? join(dir, "bear_researcher.json") : undefined,
  });
  updateAgent(run, "portfolio_manager", "skipped", {
    error: reason,
    completed_at: new Date().toISOString(),
  });
  const manager = managerFallback(run, args.prompt || "");
  writeJson(join(dir, "manager_synthesis.json"), manager);
  writeJson(join(dir, "decision.json"), manager);
  run.phase = "incomplete";
  run.status = "incomplete";
  run.completed_at = new Date().toISOString();
  const completeness = completenessStatus(run);
  appendEvent(run, "incomplete", {
    reason,
    downstream_model_calls_skipped: true,
    missing_evidence: completeness.missing_evidence,
    missing_debate: completeness.missing_debate,
    missing_masters: completeness.missing_masters,
  });
  const finalArtifacts = commitFinalArtifacts(run, { bull, bear, manager });
  return { bull, bear, manager, ...finalArtifacts };
}

export async function synthesizeDecision(run, args) {
  const dir = runPath(run.run_id);
  const timeoutMs = debateStageTimeout(args, run);
  const outputMode = OUTPUT_MODES.includes(args.output_mode) ? args.output_mode : "public_equity";
  run.phase = "debate";
  run.status = "running";
  run.completed_at = null;
  writeStatus(run);
  appendEvent(run, "debate_started", {
    output_mode: outputMode,
    council_mode: run.council_mode,
    debate_format: run.debate_format,
  });
  if (run.dry_run || args.synthesis === false) {
    updateAgent(run, "bull_researcher", "running", { started_at: new Date().toISOString() });
    const bull = dryDebate("bull_researcher", run, debatePrompt("bull_researcher", run));
    updateAgent(run, "bull_researcher", "completed", { completed_at: new Date().toISOString(), output: join(dir, "bull_researcher.json") });
    updateAgent(run, "bear_researcher", "running", { started_at: new Date().toISOString() });
    const bear = dryDebate("bear_researcher", run, debatePrompt("bear_researcher", run, { bull }));
    updateAgent(run, "bear_researcher", "completed", { completed_at: new Date().toISOString(), output: join(dir, "bear_researcher.json") });
    updateAgent(run, "portfolio_manager", "running", { started_at: new Date().toISOString() });
    const fallback = managerFallback(run, args.prompt || "");
    updateAgent(run, "portfolio_manager", "completed", { completed_at: new Date().toISOString(), output: join(dir, "manager_synthesis.json") });
    writeJson(join(dir, "bull_researcher.json"), bull);
    writeJson(join(dir, "bear_researcher.json"), bear);
    writeJson(join(dir, "manager_synthesis.json"), fallback);
    writeJson(join(dir, "decision.json"), fallback);
    const dryGate = verificationStatus(run);
    const dryCompleteness = completenessStatus(run);
    run.completed_at = new Date().toISOString();
    if (dryCompleteness.completeness === "incomplete") {
      run.phase = "incomplete";
      run.status = "incomplete";
      appendEvent(run, "incomplete", {
        missing_evidence: dryCompleteness.missing_evidence,
        missing_debate: dryCompleteness.missing_debate,
        missing_masters: dryCompleteness.missing_masters,
      });
    } else if (dryGate.verification === "needs_verification") {
      run.phase = "needs_verification";
      run.status = "needs_verification";
      appendEvent(run, "needs_verification", { missing: dryGate.missing_claim_source_ids.length });
    } else {
      run.phase = "complete";
      run.status = "complete";
    }
    const finalArtifacts = commitFinalArtifacts(run, { bull, bear, manager: fallback });
    return { bull, bear, manager: fallback, ...finalArtifacts };
  }

  if (run.council_mode === "quick") {
    return synthesizeQuickDecision(run, args, timeoutMs, outputMode);
  }

  const rejectedStep = (reason, role) => {
    const result = {
      ok: false, code: null, text: "", stderr: cleanLog(reason?.message || reason), stdout: "",
      timedOut: false, unexpected_error: true,
    };
    return { result, packet: debateFromCodex(result, role, run, "unexpected debate failure") };
  };
  const parallelRound = async (round, bullContext, bearContext) => {
    const budget = remainingCouncilBudget(run, timeoutMs);
    appendEvent(run, "debate_round", { round, format: "parallel_per_round", budget_ms: budget });
    const [bullOutcome, bearOutcome] = await Promise.allSettled([
      runDebateRole(run, "bull_researcher", { round, ...bullContext }, budget),
      runDebateRole(run, "bear_researcher", { round, ...bearContext }, budget),
    ]);
    return {
      bull: bullOutcome.status === "fulfilled" ? bullOutcome.value : rejectedStep(bullOutcome.reason, "bull_researcher"),
      bear: bearOutcome.status === "fulfilled" ? bearOutcome.value : rejectedStep(bearOutcome.reason, "bear_researcher"),
    };
  };
  const failedRound = (round) => [debateFailure(round.bull), debateFailure(round.bear)].filter(Boolean);

  // Three-round debate with a strict inter-round barrier and parallel sides per round.
  const r1 = await parallelRound(1, { brief: "long" }, { brief: "short" });
  if (failedRound(r1).length) {
    return finalizeAfterDebateFailure(run, args, `debate_round_1_failed:${failedRound(r1).join(",")}`, [r1.bull], [r1.bear]);
  }

  const r2 = await parallelRound(2,
    { otherCaseR1: r1.bear.packet },
    { otherCaseR1: r1.bull.packet });
  if (failedRound(r2).length) {
    return finalizeAfterDebateFailure(run, args, `debate_round_2_failed:${failedRound(r2).join(",")}`, [r1.bull, r2.bull], [r1.bear, r2.bear]);
  }
  const exactlyThreeQuestions = (packet) => Array.isArray(packet?.questions)
    && packet.questions.length === 3
    && packet.questions.every((question) => typeof question === "string" && question.trim());
  if (!exactlyThreeQuestions(r2.bull.packet) || !exactlyThreeQuestions(r2.bear.packet)) {
    appendEvent(run, "debate_qna_gate", { status: "failed", errors: ["round 2 did not produce exactly three questions per side"] });
    return finalizeAfterDebateFailure(run, args, "debate_round_2_questions_incomplete", [r1.bull, r2.bull], [r1.bear, r2.bear]);
  }

  const r3 = await parallelRound(3, {
    otherCaseR1: r2.bear.packet,
    questionsYouAsked: r2.bull.packet.questions,
    questionsForYou: r2.bear.packet.questions,
  }, {
    otherCaseR1: r2.bull.packet,
    questionsYouAsked: r2.bear.packet.questions,
    questionsForYou: r2.bull.packet.questions,
  });
  if (failedRound(r3).length) {
    return finalizeAfterDebateFailure(run, args, `debate_round_3_failed:${failedRound(r3).join(",")}`, [r1.bull, r2.bull, r3.bull], [r1.bear, r2.bear, r3.bear]);
  }

  const bullR1 = r1.bull;
  const bearR1 = r1.bear;
  const bullR2 = r2.bull;
  const bearR2 = r2.bear;
  const bullR3 = r3.bull;
  const bearR3 = r3.bear;

  const bull = mergeDebateRounds([bullR1.packet, bullR2.packet, bullR3.packet]);
  const bear = mergeDebateRounds([bearR1.packet, bearR2.packet, bearR3.packet]);
  const qnaGate = debateQnaGate({
    bullR2: bullR2.packet,
    bearR2: bearR2.packet,
    bullR3: bullR3.packet,
    bearR3: bearR3.packet,
  });
  appendEvent(run, "debate_qna_gate", qnaGate);
  if (qnaGate.status !== "passed") {
    return finalizeAfterDebateFailure(run, args, "debate_round_3_qna_incomplete", [bullR1, bullR2, bullR3], [bearR1, bearR2, bearR3]);
  }
  const bullQnaErrors = qnaGate.errors.filter((error) => error.startsWith("bull_researcher"));
  const bearQnaErrors = qnaGate.errors.filter((error) => error.startsWith("bear_researcher"));
  const bullTransportOk = [bullR1, bullR2, bullR3].every((step) => step.result.ok);
  const bearTransportOk = [bearR1, bearR2, bearR3].every((step) => step.result.ok);
  const bullOk = bullTransportOk && bull.verdict !== "PARSE_FAILED" && bullQnaErrors.length === 0;
  const bearOk = bearTransportOk && bear.verdict !== "PARSE_FAILED" && bearQnaErrors.length === 0;
  const bullTransportFailure = firstFailedDebateResult([bullR1, bullR2, bullR3]);
  const bearTransportFailure = firstFailedDebateResult([bearR1, bearR2, bearR3]);

  writeJson(join(dir, "bull_researcher.json"), bull);
  updateAgent(run, "bull_researcher", bullOk ? "completed" : "failed", {
    completed_at: new Date().toISOString(),
    output: join(dir, "bull_researcher.json"),
    error: bullOk
      ? undefined
      : !bullTransportOk
        ? (bullTransportFailure?.timedOut ? "timeout" : `exit code ${bullTransportFailure?.code ?? "unknown"}`)
        : bull.verdict === "PARSE_FAILED"
          ? "parse_failed"
          : "qna_incomplete",
    qna_errors: bullQnaErrors,
  });
  writeJson(join(dir, "bear_researcher.json"), bear);
  updateAgent(run, "bear_researcher", bearOk ? "completed" : "failed", {
    completed_at: new Date().toISOString(),
    output: join(dir, "bear_researcher.json"),
    error: bearOk
      ? undefined
      : !bearTransportOk
        ? (bearTransportFailure?.timedOut ? "timeout" : `exit code ${bearTransportFailure?.code ?? "unknown"}`)
        : bear.verdict === "PARSE_FAILED"
          ? "parse_failed"
          : "qna_incomplete",
    qna_errors: bearQnaErrors,
  });
  writeAllAgentsMarkdown(run, { bull, bear });

  const pmBudget = remainingCouncilBudget(run, portfolioManagerStageTimeout(args, run));
  const managerStep = await runDebateRole(run, "portfolio_manager", {
    bull,
    bear,
    outputMode,
    structuredDecisionOnly: true,
  }, pmBudget);
  const managerOk = !debateFailure(managerStep);
  const manager = managerOk ? managerStep.packet : managerFallback(run, args.prompt || "", managerStep.packet);
  const gate = verificationStatus(run);
  writeJson(join(dir, "manager_synthesis.json"), manager);
  writeJson(join(dir, "decision.json"), manager);
  updateAgent(run, "portfolio_manager", managerOk ? "completed" : "failed", {
    completed_at: new Date().toISOString(),
    output: join(dir, "manager_synthesis.json"),
    error: managerOk ? undefined : debateFailure(managerStep),
    attempts: managerStep.attempts,
    ...(managerStep.attempt_diagnostics?.length
      ? { attempt_diagnostics: managerStep.attempt_diagnostics }
      : {}),
  });
  const completeness = completenessStatus(run);
  run.completed_at = new Date().toISOString();
  if (completeness.completeness === "incomplete") {
    run.phase = "incomplete";
    run.status = "incomplete";
    appendEvent(run, "incomplete", {
      missing_evidence: completeness.missing_evidence,
      missing_debate: completeness.missing_debate,
      missing_masters: completeness.missing_masters,
    });
  } else if (gate.verification === "needs_verification") {
    run.phase = "needs_verification";
    run.status = "needs_verification";
    appendEvent(run, "needs_verification", { missing: gate.missing_claim_source_ids.length });
  } else {
    run.phase = "complete";
    run.status = "complete";
  }
  const finalArtifacts = commitFinalArtifacts(run, { bull, bear, manager });
  return { bull, bear, manager, ...finalArtifacts };
}

export async function analyzeSymbol(args) {
  const run = await collectEvidence(args);
  let gate = completenessStatus(run);
  if (gate.missing_evidence.length > 0) {
    const debate = finalizeBeforeDebate(run, args, "evidence_gate_failed");
    return {
      run,
      debate,
      decision: debate.manager,
      final_report_markdown: debate.final_report_markdown,
      user_response_markdown: debate.user_response_markdown,
      report_quality: debate.report_quality,
      artifacts: debate.artifacts || artifactPaths(run),
    };
  }
  await runHeadlessVerification(run, args);
  const verificationGate = verificationStatus(run);
  if (verificationGate.verification === "needs_verification") {
    const debate = finalizeNeedsVerification(run, args, "verification_gate_failed_before_methods");
    return {
      run,
      debate,
      decision: debate.manager,
      final_report_markdown: debate.final_report_markdown,
      user_response_markdown: debate.user_response_markdown,
      report_quality: debate.report_quality,
      artifacts: debate.artifacts || artifactPaths(run),
    };
  }
  if (remainingCouncilBudget(run, 1) <= 0) {
    const debate = finalizeBeforeDebate(run, args, "global_deadline_before_masters");
    return {
      run,
      debate,
      decision: debate.manager,
      final_report_markdown: debate.final_report_markdown,
      user_response_markdown: debate.user_response_markdown,
      report_quality: debate.report_quality,
      artifacts: debate.artifacts || artifactPaths(run),
    };
  }
  await runHeadlessMasters(run, args);
  gate = completenessStatus(run);
  if (gate.missing_masters.length > 0 || remainingCouncilBudget(run, 1) <= 0) {
    const debate = finalizeBeforeDebate(run, args,
      gate.missing_masters.length ? "master_gate_failed" : "global_deadline_before_debate");
    return {
      run,
      debate,
      decision: debate.manager,
      final_report_markdown: debate.final_report_markdown,
      user_response_markdown: debate.user_response_markdown,
      report_quality: debate.report_quality,
      artifacts: debate.artifacts || artifactPaths(run),
    };
  }
  const debate = await synthesizeDecision(run, args);
  return {
    run,
    debate,
    decision: debate.manager,
    final_report_markdown: debate.final_report_markdown,
    user_response_markdown: debate.user_response_markdown,
    report_quality: debate.report_quality,
    artifacts: debate.artifacts || artifactPaths(run),
  };
}

/** Best-effort standard artifact package for an unexpected background orchestration error. */
export function finalizeUnhandledBackgroundFailure(runIdValue, prompt, error) {
  const dir = runPath(runIdValue);
  const run = readJson(join(dir, "evidence.json"));
  const statusPath = join(dir, "status.json");
  if (existsSync(statusPath)) {
    const latest = readJson(statusPath);
    const overlay = (current = {}, rows = [], idField) => {
      const merged = { ...current };
      for (const row of rows || []) {
        const id = row?.[idField];
        if (typeof id !== "string" || !id) continue;
        merged[id] = { ...(merged[id] || {}), ...row };
      }
      return merged;
    };
    // status.json is written after every state transition. If a later artifact write throws,
    // it may be newer than evidence.json; preserve those terminal transitions before closing
    // only the genuinely open work as unexpected failures.
    run.task_status = overlay(run.task_status, latest.tasks, "task");
    run.agent_status = overlay(run.agent_status, latest.agents, "role");
    run.master_status = overlay(run.master_status, latest.masters, "master");
  }
  const completedAt = new Date().toISOString();
  const terminal = new Set(["completed", "degraded", "failed", "timed_out", "skipped"]);
  const failOpenStates = (states = {}, openStatus = "failed", openError = "unexpected_orchestrator_error") => Object.fromEntries(Object.entries(states).map(([id, state]) => [id,
    terminal.has(state?.status) ? state : {
      ...state,
      status: openStatus,
      error: openError,
      completed_at: completedAt,
      updated_at: completedAt,
      pid: null,
    },
  ]));
  const evidencePhase = ["queued", "evidence", "evidence_partial", "evidence_complete", "evidence_degraded"]
    .includes(run.phase);
  run.task_status = failOpenStates(run.task_status);
  run.agent_status = failOpenStates(
    run.agent_status,
    evidencePhase ? "skipped" : "failed",
    evidencePhase ? "not_run_upstream_evidence_failure" : "unexpected_orchestrator_error",
  );
  run.master_status = failOpenStates(
    run.master_status,
    evidencePhase ? "skipped" : "failed",
    evidencePhase ? "not_run_upstream_evidence_failure" : "unexpected_orchestrator_error",
  );
  run.status = "failed";
  run.phase = "failed";
  run.completed_at = completedAt;
  run.background_error = cleanLog(error?.message || error, 1_000) || "unexpected orchestration error";
  const manager = managerFallback(run, prompt || "");
  manager.failure_reason = "unexpected_orchestrator_error";
  writeJson(join(dir, "manager_synthesis.json"), manager);
  writeJson(join(dir, "decision.json"), manager);
  appendEvent(run, "background_run_failed", {
    error: "unexpected_orchestrator_error",
    diagnostic: run.background_error,
    standard_artifacts_written: true,
  });
  const artifacts = commitFinalArtifacts(run, { manager });
  return { run, manager, ...artifacts };
}

export function recordVerifierVerdict(args) {
  const run = readJson(join(runPath(args.run_id), "evidence.json"));
  if (run.execution_mode !== "visible_host_threads") {
    throw invalidParams("record_verifier_verdict requires a run created by plan_visible_run.");
  }
  assertVisibleRunOpen(run, "record a verifier verdict");
  if (tripleVerificationRequired(run)) {
    throw invalidParams("This slow + all run requires one complete batch from each verifier; single manual verdicts cannot satisfy it.", {
      reason: "VERIFIER_BATCH_REQUIRED",
      required_verifiers: REQUIRED_VERIFIER_IDS,
      alternative_tool: "record_verifier_batch",
    });
  }
  const verifier = registry().get(args.verifier);
  if (!verifier || verifier.kind !== "verifier") {
    throw invalidParams(`unknown verifier: ${args.verifier}`);
  }
  if (!verifier.verdict_values.includes(args.verdict)) {
    throw invalidParams(`verdict must be one of ${verifier.verdict_values.join(", ")} for ${args.verifier}, got ${JSON.stringify(args.verdict)}`);
  }
  run.verifier_verdicts = [
    ...(run.verifier_verdicts || []),
    {
      verifier: args.verifier,
      seat: args.seat,
      verdict: args.verdict,
      claim: typeof args.claim === "string" ? args.claim : "",
      note: typeof args.note === "string" ? args.note : "",
      at: new Date().toISOString(),
    },
  ];
  saveRun(run);
  writeJson(join(runPath(run.run_id), "evidence.json"), run);
  appendEvent(run, "verifier_verdict", { verifier: args.verifier, seat: args.seat, verdict: args.verdict });
  return { run_id: run.run_id, recorded: run.verifier_verdicts.length, weights: resolveSeatWeights(run, run.seat_weight_overrides) };
}

export function recordVerifierBatch(args) {
  const dir = runPath(args.run_id);
  const run = readJson(join(dir, "evidence.json"));
  if (run.execution_mode !== "visible_host_threads") {
    throw invalidParams("record_verifier_batch requires a run created by plan_visible_run.");
  }
  assertVisibleRunOpen(run, "record a verifier batch");
  const missingEvidence = (run.tasks || []).filter((task) => taskState(run, task).status !== "completed");
  if (missingEvidence.length) {
    throw invalidParams("record_verifier_batch rejected: every selected analyst packet must complete first.", {
      reason: "VISIBLE_VERIFIER_EVIDENCE_INCOMPLETE",
      missing_evidence: missingEvidence,
    });
  }
  if (!run.verification_policy) initializeVerificationPolicy(run);
  if (!tripleVerificationRequired(run)) {
    throw invalidParams("This run does not require the triple verifier batch stage.", {
      reason: "VERIFIER_BATCH_NOT_REQUIRED",
    });
  }
  if (!REQUIRED_VERIFIER_IDS.includes(args.verifier)) {
    throw invalidParams(`unknown required verifier: ${args.verifier}`);
  }
  const normalized = normalizeVerifierBatch(args.packet, run, args.verifier, { client: true });
  const outputPath = join(dir, `verification.${args.verifier}.json`);
  if (existsSync(outputPath)) {
    const existing = readJson(outputPath);
    if (sha256(existing) !== sha256(normalized)) {
      throw invalidParams(`Verifier batch ${args.verifier} is already frozen; conflicting content requires a new run.`, {
        reason: "VISIBLE_VERIFIER_BATCH_CONFLICT",
        verifier: args.verifier,
        existing_hash: sha256(existing),
        submitted_hash: sha256(normalized),
      });
    }
    return {
      run,
      verifier: args.verifier,
      recorded: normalized.results.length,
      expected: run.verification_policy.material_claim_count,
      idempotent_replay: true,
      audit: verificationAuditStatus(run),
    };
  }
  writeJson(outputPath, normalized, { mode: 0o600 });
  run.verifier_verdicts = [
    ...(run.verifier_verdicts || []).filter((row) => row.verifier !== args.verifier),
    ...normalized.results,
  ];
  updateVerifierStatus(run, args.verifier, "completed", {
    output: outputPath,
    result_count: normalized.results.length,
    thread_id: args.thread_id,
    thread_title: args.thread_title,
    completed_at: new Date().toISOString(),
  });
  const audit = verificationAuditStatus(run);
  run.verification_policy.status = audit.status;
  run.phase = audit.status !== "needs_verification" ? "visible_methods" : "visible_verification";
  run.status = "running";
  saveRun(run);
  writeStatus(run);
  appendEvent(run, "verifier_batch_recorded", {
    verifier: args.verifier,
    result_count: normalized.results.length,
    recorded_verdict_count: audit.recorded_verdict_count,
    expected_verdict_count: audit.expected_verdict_count,
    audit_status: audit.status,
  });
  writeAllAgentsMarkdown(run, existingDebate(dir));
  return {
    run,
    verifier: args.verifier,
    recorded: normalized.results.length,
    expected: run.verification_policy.material_claim_count,
    idempotent_replay: false,
    audit,
  };
}

/** Current weighting for a run, for the PM prompt and for the report. */
export function seatWeights(run) {
  return resolveSeatWeights(run, run.seat_weight_overrides || {});
}
