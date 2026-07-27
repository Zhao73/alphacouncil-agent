import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEBATE_ROLES, DEFAULT_TASKS, LIMITS, OUTPUT_MODES } from "./constants.mjs";
import { invalidParams } from "./errors.mjs";
import { readJson, writeJson } from "./fsutil.mjs";
import { registry } from "./personas/registry.mjs";
import { isChineseLanguage, resolveLanguage } from "./lang.mjs";
import { cleanLog } from "./text.mjs";
import { completenessStatus, verificationStatus } from "./gates.mjs";
import { agentState, appendEvent, artifactPaths, existingDebate, runPath, runId, safeSymbol, saveRun, taskState, today, updateAgent, updateTask, writeSourceManifest, writeStatus } from "./run-store.mjs";
import { writeAllAgentsMarkdown, writeAnalystMarkdownFiles, writeArtifactIndex, writeFinalArtifacts } from "./markdown.mjs";
import { debateFromCodex, debateQnaGate, dryDebate, dryPacket, extractJson, firstFailedDebateResult, managerFallback, mergeDebateRounds, normalizeDebate, normalizeMasterOpinion, normalizePacket, rawRecordText } from "./packets.mjs";
import { mapLimit, runCodex } from "./codex.mjs";
import { debatePrompt, masterPrompt, selectedMasters, taskPrompt } from "./prompts.mjs";
import { resolveSeatWeights } from "./weights.mjs";
import { completedMasterOpinion, declinedMasterOpinion, planMasterSeats, reconcileMasterOpinion } from "./personas/engine.mjs";
import { gatherGrounding } from "./grounding.mjs";
import { councilOptions } from "./council-options.mjs";
import { sha256 } from "./personas-v3/canonical.mjs";

function masterRuntimeProvenance(run, plan) {
  const decisions = new Map((plan.decisions || []).map((decision) => [decision.persona_id, decision]));
  const planned = new Map(
    [...(plan.to_run || []), ...(plan.declined || []), ...(plan.completed || []), ...(plan.blocked || [])]
      .map((item) => [item.id, item]),
  );
  return Object.fromEntries(selectedMasters(run).map((id) => {
    const decision = decisions.get(id) || {};
    const item = planned.get(id) || {};
    return [id, {
      engine: decision.engine || item.engine || "unknown",
      pack_hash: decision.pack_hash || run.master_selection?.selected_master_pack_hashes?.[id] || null,
      corpus_hash: decision.corpus_hash || null,
      policy_hash: decision.policy_hash || null,
      tool_graph_hash: decision.tool_graph_hash || null,
      fact_pack_hash: decision.fact_pack_hash || item.preDecision?.fact_pack?.fact_pack_hash || null,
      evidence_snapshot_hash: decision.evidence_snapshot_hash || item.preDecision?.evidence_snapshot_hash || null,
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
  const asOfDate = args.as_of || today();
  const id = args.run_id || runId(symbol);
  const tasks = Array.isArray(args.tasks) && args.tasks.length ? args.tasks : DEFAULT_TASKS;
  const language = resolveLanguage(args);
  const frozen = frozenMasterSelection(args);
  const dir = runPath(id);
  mkdirSync(dir, { recursive: true });
  const startedAt = new Date().toISOString();
  const run = {
    run_id: id,
    symbol,
    as_of: asOfDate,
    language,
    dry_run: false,
    execution_mode: "visible_host_threads",
    entry_tool: args.entry_tool || "plan_visible_run",
    visibility_required: true,
    started_at: startedAt,
    updated_at: startedAt,
    completed_at: null,
    status: "planned",
    phase: "visible_planned",
    tasks,
    task_status: Object.fromEntries(tasks.map((task) => [task, { task, status: "pending" }])),
    agent_status: Object.fromEntries(DEBATE_ROLES.map((role) => [role, { role, status: "pending" }])),
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
    title: isChineseLanguage(run.language) ? `AlphaCouncil Agent ${run.symbol} ${task} 证据子代理` : `AlphaCouncil Agent ${run.symbol} ${task} evidence subagent`,
    prompt: taskPrompt(task, run.symbol, run.as_of, userPrompt, run.language, run.grounding),
    output_contract: isChineseLanguage(run.language) ? "只返回一个 JSON evidence packet。" : `Return one JSON evidence packet with reader-facing fields in ${run.language}.`,
  }));
  const debate_agents = DEBATE_ROLES.map((role) => ({
    role,
    title: `AlphaCouncil Agent ${run.symbol} ${role}`,
    prompt_template: [
      debatePrompt(role, run),
      "",
      isChineseLanguage(run.language) ? "主线程必须先粘贴已完成的 Evidence JSON，再运行这个可见代理。" : "The main thread must paste the completed Evidence JSON before running this visible agent.",
      role === "bear_researcher" ? (isChineseLanguage(run.language) ? "主线程还必须粘贴 Bull argument JSON。" : "The main thread must also paste Bull argument JSON.") : "",
      role === "portfolio_manager" ? (isChineseLanguage(run.language) ? "主线程还必须粘贴 Bull 和 Bear argument JSON。" : "The main thread must also paste Bull and Bear argument JSON.") : "",
    ].filter(Boolean).join("\n"),
    output_contract: isChineseLanguage(run.language) ? "只返回一个 JSON debate packet。" : `Return one JSON debate packet with reader-facing fields in ${run.language}.`,
  }));
  // The deterministic pass runs first and settles, for free, every seat whose method cannot
  // reach this security. Spawning an agent for a lens that has already declined is how the
  // previous design produced ten confident essays over a screen that computed nothing.
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
      zh
        ? "主线程必须先粘贴已完成的 Evidence JSON，再运行这个大师议席；大师在证据之后、辩论之前运行。"
        : "The main thread must paste the completed Evidence JSON first. Masters run after the evidence stage and before the debate.",
    ].filter(Boolean).join("\n"),
    output_contract: zh
      ? "只返回一个 JSON master opinion。"
      : `Return one JSON master opinion with reader-facing fields in ${run.language}.`,
  }));
  // A declined seat is settled here rather than skipped: it is written straight into the
  // run as an out_of_scope opinion, so the completeness gate is satisfied and no agent is
  // ever spawned for a method that cannot look.
  if (plan.declined.length) {
    const byId = new Map((run.master_opinions || []).map((o) => [o.master, o]));
    for (const item of plan.declined) {
      if (!byId.has(item.id)) {
        byId.set(item.id, attachMasterRuntimeProvenance(
          run,
          item.id,
          declinedMasterOpinion(run, item),
          item.engine,
        ));
      }
      run.master_status[item.id] = {
        ...(run.master_status[item.id] || {}),
        master: item.id,
        status: "completed",
        engine: item.engine || "v2_method_model",
        deterministic_decline: true,
        completed_at: new Date().toISOString(),
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
      run.master_status[item.id] = {
        ...(run.master_status[item.id] || {}),
        master: item.id,
        status: "completed",
        engine: item.engine,
        deterministic_execution: true,
        completed_at: new Date().toISOString(),
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
      updated_at: new Date().toISOString(),
    };
  }
  saveRun(run);
  return {
    evidence_agents,
    master_agents,
    debate_agents,
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
  const allowed = selectedMasters(run);
  if (!allowed.includes(args.master)) {
    throw invalidParams(`master ${args.master} was not selected for this run. Selected: ${allowed.join(", ") || "none"}`);
  }
  const dir = runPath(run.run_id);
  const normalized = normalizeMasterOpinion(
    { ...(args.packet || {}), thread_id: args.thread_id },
    args.master,
    run,
    rawRecordText(args.packet),
  );
  // A narrated stance that disagrees with the arithmetic does not get to win quietly. The
  // deterministic verdict stands and the disagreement is preserved on the record.
  const reconciled = reconcileMasterOpinion(run, args.master, normalized);
  const opinion = attachMasterRuntimeProvenance(run, args.master, reconciled.opinion, reconciled.engine);
  const { overridden } = reconciled;
  const byId = new Map((run.master_opinions || []).map((item) => [item.master, item]));
  byId.set(args.master, opinion);
  run.master_opinions = allowed.map((id) => byId.get(id)).filter(Boolean);
  run.master_status = run.master_status || {};
  run.master_status[args.master] = {
    ...(run.master_status[args.master] || {}),
    master: args.master,
    status: "completed",
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
  const task = args.task;
  if (!run.tasks.includes(task)) throw invalidParams(`Unknown task for this run: ${task}`);
  const dir = runPath(run.run_id);
  const packet = normalizePacket({
    ...(args.packet || {}),
    thread_id: args.thread_id,
    thread_title: args.thread_title,
    execution_mode: "visible_host_threads",
  }, task, run.symbol, run.as_of, rawRecordText(args.packet));
  const byTask = new Map(run.packets.map((item) => [item.task, item]));
  byTask.set(task, packet);
  run.packets = run.tasks.map((item) => byTask.get(item)).filter(Boolean);
  Object.assign(run, visibleStatusAfterPacket(run));
  writeJson(join(dir, `${task}.json`), packet);
  saveRun(run);
  updateTask(run, task, "completed", {
    completed_at: new Date().toISOString(),
    thread_id: args.thread_id,
    thread_title: args.thread_title,
    output: join(dir, `${task}.json`),
  });
  writeJson(join(dir, "evidence.json"), run);
  writeAnalystMarkdownFiles(run, existingDebate(dir));
  writeArtifactIndex(run, existingDebate(dir));
  writeAllAgentsMarkdown(run, existingDebate(dir));
  return run;
}

export function recordVisibleDecision(args) {
  const run = readJson(join(runPath(args.run_id), "evidence.json"));
  if (run.execution_mode !== "visible_host_threads") {
    throw invalidParams("record_visible_decision requires a run created by plan_visible_run.");
  }
  const role = args.role;
  if (!DEBATE_ROLES.includes(role)) throw invalidParams(`Unknown decision role: ${role}`);
  const dir = runPath(run.run_id);
  const packet = normalizeDebate({
    ...(args.packet || {}),
    thread_id: args.thread_id,
    thread_title: args.thread_title,
    execution_mode: "visible_host_threads",
  }, role, run, rawRecordText(args.packet));
  const file = role === "portfolio_manager" ? "manager_synthesis.json" : `${role}.json`;
  writeJson(join(dir, file), packet);
  // Mark the agent completed BEFORE evaluating the gates. The completeness gate now
  // counts portfolio_manager, so reading it first would report every finished run as
  // incomplete -- the PM would never be recorded by the time it was checked.
  updateAgent(run, role, "completed", {
    completed_at: new Date().toISOString(),
    thread_id: args.thread_id,
    thread_title: args.thread_title,
    output: join(dir, file),
  });
  let finalArtifacts = {};
  if (role === "portfolio_manager") {
    const gate = verificationStatus(run);
    const completeness = completenessStatus(run);
    writeJson(join(dir, "decision.json"), packet);
    if (completeness.completeness === "incomplete") {
      run.status = "incomplete";
      run.phase = "incomplete";
      appendEvent(run, "incomplete", {
        missing_evidence: completeness.missing_evidence,
        missing_debate: completeness.missing_debate,
        missing_masters: completeness.missing_masters,
      });
    } else if (gate.verification === "needs_verification") {
      run.status = "needs_verification";
      run.phase = "needs_verification";
      appendEvent(run, "needs_verification", { missing: gate.missing_claim_source_ids.length });
    } else {
      run.status = "complete";
      run.phase = "complete";
    }
    run.completed_at = new Date().toISOString();
  } else {
    run.status = "running";
    run.phase = "visible_debate";
  }
  saveRun(run);
  writeJson(join(dir, "evidence.json"), run);
  if (role === "portfolio_manager") {
    finalArtifacts = writeFinalArtifacts(run, existingDebate(dir));
    writeJson(join(dir, "evidence.json"), run);
    if (run.status === "complete") appendEvent(run, "run_complete", { decision: packet.rating, winner: packet.winner });
  } else {
    writeAnalystMarkdownFiles(run, existingDebate(dir));
    writeArtifactIndex(run, existingDebate(dir));
  }
  writeStatus(run);
  writeAllAgentsMarkdown(run, existingDebate(dir));
  return { run, decision: packet, ...finalArtifacts };
}

export function isDryRun(args = {}) {
  return args.dry_run === true;
}

/**
 * Keep execution diagnostics separate from investment evidence.
 *
 * A timed-out Codex worker can leave a long partial transcript containing tool chatter,
 * internal instructions and half-finished searches. That material is useful to an operator
 * but is not a sourced claim and must never enter evidence.json or downstream debate.
 */
export function workerFailureArtifacts({ task, symbol, asOfDate, language, timeoutMs, result, failureKind, parseError }) {
  const chinese = isChineseLanguage(language);
  const timedOut = result?.timedOut === true;
  const parseFailed = failureKind === "parse_failed";
  const status = parseFailed ? "parse_failed" : (timedOut ? "timed_out" : "failed");
  const exitLabel = Number.isInteger(result?.code) ? `exit code ${result.code}` : "worker error";
  const parseMessage = cleanLog(parseError?.message || parseError || "subagent did not return valid JSON", 1_000);
  const reason = parseFailed ? parseMessage : (timedOut ? `timeout after ${timeoutMs}ms` : exitLabel);
  const rawOutput = String(result?.text || "");
  const positionMatch = parseFailed ? /\bposition\s+(\d+)\b/i.exec(parseMessage) : null;
  const parsePosition = positionMatch ? Number(positionMatch[1]) : null;
  const contextStart = Number.isInteger(parsePosition) ? Math.max(0, parsePosition - 500) : 0;
  const contextEnd = Number.isInteger(parsePosition) ? Math.min(rawOutput.length, parsePosition + 500) : 0;
  const packet = normalizePacket({
    summary: parseFailed
      ? (chinese
        ? `证据席位 ${task} 的输出不符合 JSON 契约；未生成可用于投资判断的证据。`
        : `Evidence worker ${task} returned output that violated the JSON contract; it produced no evidence usable for an investment decision.`)
      : (chinese
        ? `证据席位 ${task} 执行超时或失败；未生成可用于投资判断的证据。`
        : `Evidence worker ${task} timed out or failed; it produced no evidence usable for an investment decision.`),
    claims: [],
    open_questions: [chinese
      ? `检查 ${task} 的独立失败诊断并重试；不得用该席位的部分对话补齐证据。`
      : `Inspect the separate ${task} failure diagnostic and retry; do not use its partial transcript as evidence.`],
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
    diagnostic_excerpt: cleanLog(parseFailed
      ? (rawOutput || result?.stderr || result?.stdout || reason)
      : (result?.stderr || result?.stdout || rawOutput || reason)),
    ...(parseFailed ? {
      parse_error: parseMessage,
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

/**
 * A production headless run must not silently become a prompt-only council because its
 * caller omitted `grounding`. Visible runs already collect it in rpc.mjs; this gives the
 * headless path the same fact boundary. Dry runs remain network-free by design.
 */
export async function groundingForHeadlessRun({ symbol, asOf, grounding, dryRun }, gather = gatherGrounding) {
  if (grounding && typeof grounding === "object") return grounding;
  if (dryRun) return null;
  try {
    return await gather({ symbol, asOf });
  } catch (error) {
    // A failed fact fetch is still an explicit grounding result. Keeping an object here
    // makes deterministic methods decline on missing inputs instead of taking the v1 prompt
    // fallback and filling the gap from model memory.
    return {
      as_of: asOf,
      facts_unavailable: true,
      unavailable: [`grounding failed: ${cleanLog(error?.message || error)}`],
    };
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
  const asOfDate = args.as_of || today();
  const id = args.run_id || runId(symbol);
  const tasks = Array.isArray(args.tasks) && args.tasks.length ? args.tasks : DEFAULT_TASKS;
  const dryRun = isDryRun(args);
  const language = resolveLanguage(args);
  const frozen = frozenMasterSelection(args);
  const dir = runPath(id);
  mkdirSync(dir, { recursive: true });
  const startedAt = new Date().toISOString();
  const run = {
    run_id: id,
    symbol,
    as_of: asOfDate,
    language,
    dry_run: dryRun,
    execution_mode: dryRun ? "dry_run" : "background_codex_exec",
    entry_tool: args.entry_tool || "analyze_symbol",
    visibility_required: false,
    started_at: startedAt,
    updated_at: startedAt,
    completed_at: null,
    status: "queued",
    phase: "queued",
    tasks,
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
  });
  writeAllAgentsMarkdown(run);
  return run;
}

export async function collectEvidence(args) {
  if (args.visibility_required) {
    throw invalidParams("visibility_required=true cannot be satisfied by headless MCP. Use host-level multi_agent or codex_app threads first, then record_visible_packet/record_visible_decision.");
  }
  const symbol = safeSymbol(args.symbol);
  const asOfDate = args.as_of || today();
  const id = args.run_id || runId(symbol);
  const tasks = Array.isArray(args.tasks) && args.tasks.length ? args.tasks : DEFAULT_TASKS;
  const dryRun = isDryRun(args);
  const language = resolveLanguage(args);
  const frozen = frozenMasterSelection(args);
  const timeoutMs = Number.isFinite(args.timeout_ms) ? args.timeout_ms : LIMITS.CODEX_TIMEOUT_MS;
  const maxConcurrency = Math.max(LIMITS.CONCURRENCY_MIN, Math.min(LIMITS.CONCURRENCY_MAX, Number(args.max_concurrency || LIMITS.CONCURRENCY_DEFAULT)));
  const grounding = await groundingForHeadlessRun({
    symbol,
    asOf: asOfDate,
    grounding: args.grounding,
    dryRun,
  });
  const dir = runPath(id);
  mkdirSync(dir, { recursive: true });

  const startedAt = args.queued_run?.started_at || new Date().toISOString();
  const run = {
    run_id: id,
    symbol,
    as_of: asOfDate,
    language,
    dry_run: dryRun,
    execution_mode: dryRun ? "dry_run" : "background_codex_exec",
    entry_tool: args.entry_tool || "collect_evidence",
    visibility_required: false,
    started_at: startedAt,
    updated_at: startedAt,
    completed_at: null,
    status: "running",
    phase: "evidence",
    tasks,
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
    grounding: grounding ? (grounding.facts_unavailable ? "unavailable" : "attached") : "dry_run_skipped",
  });
  writeJson(join(dir, "evidence.json"), run);
  writeSourceManifest(run);
  writeAllAgentsMarkdown(run);

  const commitPacket = (packet) => {
    packetsByTask.set(packet.task, packet);
    run.packets = tasks.map((task) => packetsByTask.get(task)).filter(Boolean);
    writeJson(join(dir, `${packet.task}.json`), packet);
    writeJson(join(dir, "evidence.json"), run);
    writeSourceManifest(run);
    writeAnalystMarkdownFiles(run, existingDebate(dir));
    writeArtifactIndex(run, existingDebate(dir));
    writeAllAgentsMarkdown(run);
  };

  await mapLimit(tasks, maxConcurrency, async (task) => {
    const prompt = taskPrompt(task, symbol, asOfDate, args.prompt || "", language, run.grounding);
    updateTask(run, task, "running", { started_at: new Date().toISOString() });
    if (dryRun) {
      const packet = dryPacket(task, symbol, asOfDate, prompt, language);
      commitPacket(packet);
      updateTask(run, task, "completed", { completed_at: new Date().toISOString(), output: join(dir, `${task}.json`) });
      return packet;
    }
    const workerStartedAt = Date.now();
    const runAttempt = (workerPrompt, budgetMs, attempt) => runCodex(workerPrompt, budgetMs, ({ pid, output }) => {
      updateTask(run, task, "running", { pid, output, attempts: attempt });
    }, ({ pid, output, elapsed_ms }) => {
      updateTask(run, task, "running", { pid, output, attempts: attempt });
      appendEvent(run, "task_heartbeat", { task, pid, output, elapsed_ms, attempt });
    });
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
      updateTask(run, task, failedResult.timedOut ? "timed_out" : "failed", {
        completed_at: new Date().toISOString(),
        output: join(dir, `${task}.json`),
        diagnostic: diagnosticPath,
        ...(retryDiagnostic ? { retry_diagnostic: retryDiagnostic } : {}),
        attempts,
        error: failureKind === "parse_failed"
          ? "parse_failed"
          : (failedResult.timedOut ? "timeout" : `exit code ${failedResult.code}`),
      });
      return failure.packet;
    };

    let result = await runAttempt(prompt, timeoutMs, 1);
    if (!result.ok) {
      return commitFailure({ failedResult: result, budgetMs: timeoutMs, attempts: 1 });
    }
    let packet;
    try {
      packet = normalizePacket(extractJson(result.text), task, symbol, asOfDate, result.text);
      commitPacket(packet);
      updateTask(run, task, "completed", { completed_at: new Date().toISOString(), output: join(dir, `${task}.json`), attempts: 1 });
      return packet;
    } catch (firstParseError) {
      const firstFailure = workerFailureArtifacts({
        task,
        symbol,
        asOfDate,
        language,
        timeoutMs,
        result,
        failureKind: "parse_failed",
        parseError: firstParseError,
      });
      const retryDiagnostic = join(dir, `${task}.attempt-1.failure.json`);
      writeJson(retryDiagnostic, firstFailure.diagnostic, { mode: 0o600 });
      const elapsedMs = Date.now() - workerStartedAt;
      const retryTimeoutMs = timeoutMs - elapsedMs;
      if (retryTimeoutMs <= 0) {
        return commitFailure({
          failedResult: result,
          budgetMs: timeoutMs,
          attempts: 1,
          failureKind: "parse_failed",
          parseError: firstParseError,
          retryDiagnostic,
        });
      }

      appendEvent(run, "task_retry", {
        task,
        attempt: 2,
        max_attempts: 2,
        reason: "parse_failed",
        retry_diagnostic: retryDiagnostic,
        remaining_ms: retryTimeoutMs,
      });
      updateTask(run, task, "running", { attempts: 2, retry_diagnostic: retryDiagnostic });
      const retryPrompt = `${prompt}\n\nTRANSPORT RETRY ONLY: Your previous final response violated the required JSON transport contract. Return exactly one JSON object matching the schema above, with no prose, Markdown fence, second object, or trailing text. Do not infer or repair facts from the prior malformed response; perform the same source-bounded task again.`;
      result = await runAttempt(retryPrompt, retryTimeoutMs, 2);
      if (!result.ok) {
        return commitFailure({
          failedResult: result,
          budgetMs: retryTimeoutMs,
          attempts: 2,
          retryDiagnostic,
        });
      }
      try {
        packet = normalizePacket(extractJson(result.text), task, symbol, asOfDate, result.text);
        commitPacket(packet);
        updateTask(run, task, "completed", {
          completed_at: new Date().toISOString(),
          output: join(dir, `${task}.json`),
          attempts: 2,
          retry_diagnostic: retryDiagnostic,
        });
        return packet;
      } catch (secondParseError) {
        return commitFailure({
          failedResult: result,
          budgetMs: retryTimeoutMs,
          attempts: 2,
          failureKind: "parse_failed",
          parseError: secondParseError,
          retryDiagnostic,
        });
      }
    }
  });

  const successfulTasks = tasks.filter((task) => taskState(run, task).status === "completed");
  const failedTasks = tasks.filter((task) => taskState(run, task).status !== "completed");
  const allEvidenceSucceeded = failedTasks.length === 0;
  run.completed_at = new Date().toISOString();
  run.phase = allEvidenceSucceeded ? "evidence_complete" : "evidence_partial";
  run.status = allEvidenceSucceeded ? "evidence_complete" : "partial";
  writeJson(join(dir, "evidence.json"), run);
  writeSourceManifest(run);
  writeStatus(run);
  appendEvent(run, allEvidenceSucceeded ? "evidence_complete" : "evidence_partial", {
    successful: successfulTasks.length,
    failed: failedTasks.length,
    total: tasks.length,
    packet_count: run.packets.length,
    failed_tasks: failedTasks,
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
  writeStatus(run);
  appendEvent(run, `master_${status}`, { master, ...patch });
}

/** Execute every selected master between evidence collection and the bull/bear debate. */
export async function runHeadlessMasters(run, args = {}) {
  const selected = selectedMasters(run);
  const dir = runPath(run.run_id);
  const timeoutMs = Number.isFinite(args.timeout_ms) ? args.timeout_ms : LIMITS.CODEX_TIMEOUT_MS;
  const maxConcurrency = Math.max(
    LIMITS.CONCURRENCY_MIN,
    Math.min(LIMITS.CONCURRENCY_MAX, Number(args.max_concurrency || LIMITS.CONCURRENCY_DEFAULT)),
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

  for (const item of plan.declined) {
    const opinion = attachMasterRuntimeProvenance(
      run,
      item.id,
      declinedMasterOpinion(run, item),
      item.engine,
    );
    byId.set(item.id, opinion);
    writeJson(join(dir, `${item.id}.json`), opinion);
    updateMasterStatus(run, item.id, "completed", {
      engine: item.engine || opinion.engine,
      deterministic_decline: true,
      completed_at: new Date().toISOString(),
    });
  }

  for (const item of plan.completed) {
    const opinion = attachMasterRuntimeProvenance(
      run,
      item.id,
      completedMasterOpinion(run, item),
      item.engine,
    );
    byId.set(item.id, opinion);
    writeJson(join(dir, `${item.id}.json`), opinion);
    updateMasterStatus(run, item.id, "completed", {
      engine: item.engine,
      deterministic_execution: true,
      policy_execution_hash: opinion.policy_execution_hash,
      frozen_decision_hash: opinion.frozen_decision_hash,
      completed_at: new Date().toISOString(),
    });
  }

  for (const item of plan.blocked) {
    updateMasterStatus(run, item.id, "failed", {
      engine: item.engine,
      error: item.reason,
      output: item.error || undefined,
    });
  }

  const outcomes = await mapLimit(plan.to_run, maxConcurrency, async ({ id, decision, engine }) => {
    const prompt = [
      masterPrompt(id, run),
      decision ? deterministicVerdictBlock(decision, isChineseLanguage(run.language)) : "",
    ].filter(Boolean).join("\n\n");
    updateMasterStatus(run, id, "running", { started_at: new Date().toISOString() });

    if (run.dry_run) {
      const normalized = normalizeMasterOpinion({
        verdict: "DRY_RUN",
        stance: "out_of_scope",
        summary: "Dry run: the master prompt was planned but no model judgment was executed.",
        what_would_change_my_mind: ["Run without dry_run to obtain a method judgment."],
        confidence: "low",
      }, id, run, prompt);
      const reconciled = reconcileMasterOpinion(run, id, normalized);
      const resolvedEngine = engine || reconciled.engine || (decision ? "v2_method_model" : "v1_prompt");
      return { id, opinion: attachMasterRuntimeProvenance(run, id, reconciled.opinion, resolvedEngine), engine: resolvedEngine };
    }

    const result = await runCodex(prompt, timeoutMs, ({ pid, output }) => {
      updateMasterStatus(run, id, "running", { pid, output });
    }, ({ pid, output, elapsed_ms }) => {
      updateMasterStatus(run, id, "running", { pid, output, elapsed_ms });
    });
    if (!result.ok) {
      return {
        id,
        error: result.timedOut ? "timeout" : `exit code ${result.code}`,
        raw: cleanLog(result.stderr || result.stdout || result.text || "master execution failed"),
      };
    }
    try {
      const normalized = normalizeMasterOpinion(extractJson(result.text), id, run, result.text);
      const reconciled = reconcileMasterOpinion(run, id, normalized);
      const resolvedEngine = engine || reconciled.engine || (decision ? "v2_method_model" : "v1_prompt");
      return { id, opinion: attachMasterRuntimeProvenance(run, id, reconciled.opinion, resolvedEngine), engine: resolvedEngine };
    } catch (error) {
      return { id, error: "parse_failed", raw: cleanLog(result.text || String(error?.message || error)) };
    }
  });

  for (const outcome of outcomes) {
    if (!outcome.opinion) {
      updateMasterStatus(run, outcome.id, "failed", { error: outcome.error, output: outcome.raw });
      continue;
    }
    byId.set(outcome.id, outcome.opinion);
    writeJson(join(dir, `${outcome.id}.json`), outcome.opinion);
    updateMasterStatus(run, outcome.id, "completed", {
      engine: outcome.opinion.engine || outcome.engine,
      completed_at: new Date().toISOString(),
      output: join(dir, `${outcome.id}.json`),
    });
  }

  run.master_opinions = selected.map((id) => byId.get(id)).filter(Boolean);
  const missing = selected.filter((id) => !byId.has(id));
  run.phase = missing.length ? "masters_partial" : "masters_complete";
  run.status = missing.length ? "partial" : "masters_complete";
  saveRun(run);
  appendEvent(run, "masters_complete", { completed: run.master_opinions.length, total: selected.length, missing });
  return run;
}

export async function runDebateRole(run, role, context, timeoutMs) {
  const prompt = debatePrompt(role, run, context);
  updateAgent(run, role, "running", { started_at: new Date().toISOString(), round: context.round });
  const result = await runCodex(prompt, timeoutMs, ({ pid, output }) => {
    updateAgent(run, role, "running", { pid, output, round: context.round });
  }, ({ pid, output, elapsed_ms }) => {
    updateAgent(run, role, "running", { pid, output, round: context.round });
    appendEvent(run, "agent_heartbeat", { role, round: context.round, pid, output, elapsed_ms });
  });
  const packet = debateFromCodex(result, role, run, prompt);
  const roundCompletedAt = new Date().toISOString();
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
  });
  appendEvent(run, "agent_round_completed", {
    role,
    round: context.round,
    ok: result.ok,
    timed_out: result.timedOut === true,
    verdict: packet.verdict,
    question_count: packet.questions.length,
    answered_count: packet.questions_answered.length,
  });
  return { packet, result };
}

export async function synthesizeDecision(run, args) {
  const dir = runPath(run.run_id);
  const timeoutMs = Number.isFinite(args.synthesis_timeout_ms) ? args.synthesis_timeout_ms : Number(args.timeout_ms || LIMITS.CODEX_TIMEOUT_MS);
  const outputMode = OUTPUT_MODES.includes(args.output_mode) ? args.output_mode : "public_equity";
  run.phase = "debate";
  run.status = "running";
  run.completed_at = null;
  writeStatus(run);
  appendEvent(run, "debate_started", { output_mode: outputMode });
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
    const finalArtifacts = writeFinalArtifacts(run, { bull, bear, manager: fallback });
    writeJson(join(dir, "evidence.json"), run);
    writeStatus(run);
    if (run.status === "complete") appendEvent(run, "run_complete", { decision: fallback.rating, winner: fallback.winner });
    writeAllAgentsMarkdown(run, { bull, bear, manager: fallback });
    return { bull, bear, manager: fallback, ...finalArtifacts };
  }

  // Three-round debate: R1 cases, R2 cross-rebuttal, R3 Q&A.
  appendEvent(run, "debate_round", { round: 1 });
  const bullR1 = await runDebateRole(run, "bull_researcher", { round: 1, brief: "long" }, timeoutMs);
  const bearR1 = await runDebateRole(run, "bear_researcher", { round: 1, brief: "short", bull: bullR1.packet }, timeoutMs);

  appendEvent(run, "debate_round", { round: 2 });
  const bullR2 = await runDebateRole(run, "bull_researcher", { round: 2, otherCaseR1: bearR1.packet }, timeoutMs);
  const bearR2 = await runDebateRole(run, "bear_researcher", { round: 2, otherCaseR1: bullR1.packet }, timeoutMs);

  appendEvent(run, "debate_round", { round: 3 });
  const bullR3 = await runDebateRole(run, "bull_researcher", {
    round: 3,
    otherCaseR1: bearR2.packet,
    questionsYouAsked: bullR2.packet.questions,
    questionsForYou: bearR2.packet.questions,
  }, timeoutMs);
  const bearR3 = await runDebateRole(run, "bear_researcher", {
    round: 3,
    otherCaseR1: bullR2.packet,
    questionsYouAsked: bearR2.packet.questions,
    questionsForYou: bullR2.packet.questions,
  }, timeoutMs);

  const bull = mergeDebateRounds([bullR1.packet, bullR2.packet, bullR3.packet]);
  const bear = mergeDebateRounds([bearR1.packet, bearR2.packet, bearR3.packet]);
  const qnaGate = debateQnaGate({
    bullR2: bullR2.packet,
    bearR2: bearR2.packet,
    bullR3: bullR3.packet,
    bearR3: bearR3.packet,
  });
  appendEvent(run, "debate_qna_gate", qnaGate);
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

  const managerPrompt = debatePrompt("portfolio_manager", run, { bull, bear, outputMode });
  updateAgent(run, "portfolio_manager", "running", { started_at: new Date().toISOString() });
  const managerResult = await runCodex(managerPrompt, timeoutMs, ({ pid, output }) => {
    updateAgent(run, "portfolio_manager", "running", { pid, output });
  }, ({ pid, output, elapsed_ms }) => {
    updateAgent(run, "portfolio_manager", "running", { pid, output });
    appendEvent(run, "agent_heartbeat", { role: "portfolio_manager", pid, output, elapsed_ms });
  });
  const manager = managerResult.ok
    ? debateFromCodex(managerResult, "portfolio_manager", run, managerPrompt)
    : managerFallback(run, args.prompt || "");
  const gate = verificationStatus(run);
  writeJson(join(dir, "manager_synthesis.json"), manager);
  writeJson(join(dir, "decision.json"), manager);
  updateAgent(run, "portfolio_manager", managerResult.ok && manager.verdict !== "PARSE_FAILED" ? "completed" : "failed", {
    completed_at: new Date().toISOString(),
    output: join(dir, "manager_synthesis.json"),
    error: managerResult.ok ? undefined : (managerResult.timedOut ? "timeout" : `exit code ${managerResult.code}`),
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
  const finalArtifacts = writeFinalArtifacts(run, { bull, bear, manager });
  writeJson(join(dir, "evidence.json"), run);
  writeStatus(run);
  if (run.status === "complete") appendEvent(run, "run_complete", { decision: manager.rating, winner: manager.winner });
  writeAllAgentsMarkdown(run, { bull, bear, manager });
  return { bull, bear, manager, ...finalArtifacts };
}

export async function analyzeSymbol(args) {
  const run = await collectEvidence(args);
  await runHeadlessMasters(run, args);
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

export function recordVerifierVerdict(args) {
  const run = readJson(join(runPath(args.run_id), "evidence.json"));
  if (run.execution_mode !== "visible_host_threads") {
    throw invalidParams("record_verifier_verdict requires a run created by plan_visible_run.");
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

/** Current weighting for a run, for the PM prompt and for the report. */
export function seatWeights(run) {
  return resolveSeatWeights(run, run.seat_weight_overrides || {});
}
