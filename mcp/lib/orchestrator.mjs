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
import { debateFromCodex, dryDebate, dryPacket, extractJson, managerFallback, mergeDebateRounds, normalizeDebate, normalizeMasterOpinion, normalizePacket, rawRecordText } from "./packets.mjs";
import { mapLimit, runCodex } from "./codex.mjs";
import { debatePrompt, masterPrompt, selectedMasters, taskPrompt } from "./prompts.mjs";
import { resolveSeatWeights } from "./weights.mjs";

export function visibleRun(args) {
  const symbol = safeSymbol(args.symbol);
  const asOfDate = args.as_of || today();
  const id = args.run_id || runId(symbol);
  const tasks = Array.isArray(args.tasks) && args.tasks.length ? args.tasks : DEFAULT_TASKS;
  const language = resolveLanguage(args);
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
    // Masters are an optional judgment layer. They are deliberately NOT part of the
    // completeness gate: turning the bench on must not be able to mark a run incomplete.
    masters_roster: typeof args.masters_roster === "string" ? args.masters_roster : undefined,
    masters: Array.isArray(args.masters) ? args.masters : undefined,
    master_opinions: [],
    // Verifier outcomes, keyed to the seat that cited the claim. These drive the
    // down-weighting in weights.mjs.
    verifier_verdicts: [],
    seat_weight_overrides: (args.seat_weights && typeof args.seat_weights === "object") ? args.seat_weights : {},
  };
  writeStatus(run);
  appendEvent(run, "visible_run_planned", { tasks, masters: selectedMasters(run) });
  writeJson(join(dir, "evidence.json"), run);
  writeSourceManifest(run);
  writeAllAgentsMarkdown(run);
  return run;
}

export function visibleAgentSpecs(run, userPrompt = "") {
  const evidence_agents = run.tasks.map((task) => ({
    role: task,
    title: isChineseLanguage(run.language) ? `AlphaCouncil Agent ${run.symbol} ${task} 证据子代理` : `AlphaCouncil Agent ${run.symbol} ${task} evidence subagent`,
    prompt: taskPrompt(task, run.symbol, run.as_of, userPrompt, run.language),
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
  const master_agents = selectedMasters(run).map((id) => ({
    role: id,
    title: `AlphaCouncil Agent ${run.symbol} ${id}`,
    prompt_template: [
      masterPrompt(id, run),
      "",
      isChineseLanguage(run.language)
        ? "主线程必须先粘贴已完成的 Evidence JSON，再运行这个大师议席；大师在证据之后、辩论之前运行。"
        : "The main thread must paste the completed Evidence JSON first. Masters run after the evidence stage and before the debate.",
    ].filter(Boolean).join("\n"),
    output_contract: isChineseLanguage(run.language)
      ? "只返回一个 JSON master opinion。"
      : `Return one JSON master opinion with reader-facing fields in ${run.language}.`,
  }));
  return { evidence_agents, master_agents, debate_agents };
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
  const opinion = normalizeMasterOpinion(
    { ...(args.packet || {}), thread_id: args.thread_id },
    args.master,
    run,
    rawRecordText(args.packet),
  );
  const byId = new Map((run.master_opinions || []).map((item) => [item.master, item]));
  byId.set(args.master, opinion);
  run.master_opinions = allowed.map((id) => byId.get(id)).filter(Boolean);
  writeJson(join(dir, `${args.master}.json`), opinion);
  saveRun(run);
  writeJson(join(dir, "evidence.json"), run);
  appendEvent(run, "master_opinion_recorded", { master: args.master, stance: opinion.stance });
  return { run, opinion, recorded: run.master_opinions.length, expected: allowed.length };
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
  const timeoutMs = Number.isFinite(args.timeout_ms) ? args.timeout_ms : LIMITS.CODEX_TIMEOUT_MS;
  const maxConcurrency = Math.max(LIMITS.CONCURRENCY_MIN, Math.min(LIMITS.CONCURRENCY_MAX, Number(args.max_concurrency || LIMITS.CONCURRENCY_DEFAULT)));
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
    visibility_required: false,
    started_at: startedAt,
    updated_at: startedAt,
    completed_at: null,
    status: "running",
    phase: "evidence",
    tasks,
    task_status: Object.fromEntries(tasks.map((task) => [task, { task, status: "pending" }])),
    agent_status: {},
    packets: [],
  };
  const packetsByTask = new Map();
  writeStatus(run);
  appendEvent(run, "run_started", { tasks });
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
    const prompt = taskPrompt(task, symbol, asOfDate, args.prompt || "", language);
    updateTask(run, task, "running", { started_at: new Date().toISOString() });
    if (dryRun) {
      const packet = dryPacket(task, symbol, asOfDate, prompt, language);
      commitPacket(packet);
      updateTask(run, task, "completed", { completed_at: new Date().toISOString(), output: join(dir, `${task}.json`) });
      return packet;
    }
    const result = await runCodex(prompt, timeoutMs, ({ pid, output }) => {
      updateTask(run, task, "running", { pid, output });
    }, ({ pid, output, elapsed_ms }) => {
      updateTask(run, task, "running", { pid, output });
      appendEvent(run, "task_heartbeat", { task, pid, output, elapsed_ms });
    });
    let packet;
    if (!result.ok) {
      const failure = cleanLog(result.stderr || result.stdout || `exit code ${result.code}`);
      packet = normalizePacket({
        summary: `Subagent ${task} failed or timed out.`,
        claims: [{ claim: "Subagent failure", evidence: failure, confidence: "low", source_ids: [] }],
        open_questions: ["Retry this packet or lower concurrency."],
        confidence: "low",
      }, task, symbol, asOfDate, cleanLog(result.text || result.stderr || result.stdout));
      commitPacket(packet);
      updateTask(run, task, result.timedOut ? "timed_out" : "failed", {
        completed_at: new Date().toISOString(),
        output: join(dir, `${task}.json`),
        error: result.timedOut ? "timeout" : `exit code ${result.code}`,
      });
      return packet;
    }
    try {
      packet = normalizePacket(extractJson(result.text), task, symbol, asOfDate, result.text);
      commitPacket(packet);
      updateTask(run, task, "completed", { completed_at: new Date().toISOString(), output: join(dir, `${task}.json`) });
      return packet;
    } catch (error) {
      const raw = cleanLog(result.text);
      packet = normalizePacket({
        summary: `Subagent ${task} returned non-JSON output.`,
        claims: [{ claim: "Output was not parseable JSON", evidence: String(error.message || error), confidence: "low", source_ids: [] }],
        open_questions: ["Inspect raw_text and rerun with a stricter prompt."],
        confidence: "low",
      }, task, symbol, asOfDate, raw);
      commitPacket(packet);
      updateTask(run, task, "failed", {
        completed_at: new Date().toISOString(),
        output: join(dir, `${task}.json`),
        error: "parse_failed",
      });
      return packet;
    }
  });

  run.completed_at = new Date().toISOString();
  run.phase = "evidence_complete";
  run.status = tasks.every((task) => taskState(run, task).status === "completed") ? "evidence_complete" : "partial";
  writeJson(join(dir, "evidence.json"), run);
  writeSourceManifest(run);
  writeStatus(run);
  appendEvent(run, "evidence_complete", { completed: run.packets.length, total: tasks.length });
  writeAllAgentsMarkdown(run);
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
      appendEvent(run, "incomplete", { missing_evidence: dryCompleteness.missing_evidence, missing_debate: dryCompleteness.missing_debate });
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
  const bullR3 = await runDebateRole(run, "bull_researcher", { round: 3, otherCaseR1: bearR2.packet, questionsForYou: bearR2.packet.questions }, timeoutMs);
  const bearR3 = await runDebateRole(run, "bear_researcher", { round: 3, otherCaseR1: bullR2.packet, questionsForYou: bullR2.packet.questions }, timeoutMs);

  const bull = mergeDebateRounds([bullR1.packet, bullR2.packet, bullR3.packet]);
  const bear = mergeDebateRounds([bearR1.packet, bearR2.packet, bearR3.packet]);
  const bullOk = [bullR1, bullR2, bullR3].every((step) => step.result.ok) && bull.verdict !== "PARSE_FAILED";
  const bearOk = [bearR1, bearR2, bearR3].every((step) => step.result.ok) && bear.verdict !== "PARSE_FAILED";
  const lastBull = bullR3.result;
  const lastBear = bearR3.result;

  writeJson(join(dir, "bull_researcher.json"), bull);
  updateAgent(run, "bull_researcher", bullOk ? "completed" : "failed", {
    completed_at: new Date().toISOString(),
    output: join(dir, "bull_researcher.json"),
    error: bullOk ? undefined : (lastBull.timedOut ? "timeout" : `exit code ${lastBull.code}`),
  });
  writeJson(join(dir, "bear_researcher.json"), bear);
  updateAgent(run, "bear_researcher", bearOk ? "completed" : "failed", {
    completed_at: new Date().toISOString(),
    output: join(dir, "bear_researcher.json"),
    error: bearOk ? undefined : (lastBear.timedOut ? "timeout" : `exit code ${lastBear.code}`),
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
    appendEvent(run, "incomplete", { missing_evidence: completeness.missing_evidence, missing_debate: completeness.missing_debate });
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
