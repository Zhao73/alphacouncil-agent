import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COUNCIL_MODES, DEBATE_ROLES, DEFAULT_TASKS, LIMITS, OUTPUT_MODES, QUICK_TASKS, councilPaceProfile } from "./constants.mjs";
import { invalidParams } from "./errors.mjs";
import { readJson, readJsonl, writeJson } from "./fsutil.mjs";
import { registry } from "./personas/registry.mjs";
import { assertReaderLanguage, isChineseLanguage, localized, resolveLanguage } from "./lang.mjs";
import { cleanLog } from "./text.mjs";
import { authoredReportSectionGaps, completenessStatus, masterSeatIncomplete, requiredReportSectionAliases, verificationStatus } from "./gates.mjs";
import { agentState, appendEvent, artifactPaths, existingDebate, runPath, runId, safeSymbol, saveRun, taskState, today, updateAgent, updateTask, writeSourceManifest, writeStatus } from "./run-store.mjs";
import { publishFinalArtifacts, writeAllAgentsMarkdown, writeAnalystMarkdownFiles, writeArtifactIndex, writeFinalArtifacts } from "./markdown.mjs";
import { assertSourceIdsResolve, debateFailurePacket, debateFromCodex, debateQnaGate, dryDebate, dryPacket, extractJson, extractWorkerJson, firstFailedDebateResult, managerFallback, mergeDebateRounds, normalizeDebate, normalizeMasterOpinion, normalizeMasterVoice, normalizePacket, rawRecordText } from "./packets.mjs";
import { assertRuntimeClientPayload } from "./runtime-validation.mjs";
import { mapLimit, runCodex } from "./codex.mjs";
import { debatePrompt, masterPrompt, masterVoicePrompt, selectedMasters, taskPrompt } from "./prompts.mjs";
import { resolveSeatWeights } from "./weights.mjs";
import { completedMasterOpinion, declinedMasterOpinion, needsMethodVoiceWorker, planMasterSeats, reconcileMasterOpinion } from "./personas/engine.mjs";
import { gatherGrounding } from "./grounding.mjs";
import { councilOptions } from "./council-options.mjs";
import { sha256 } from "./personas-v3/canonical.mjs";

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

function councilMode(args = {}) {
  return COUNCIL_MODES.includes(args.council_mode) ? args.council_mode : "full";
}

function plannedTasks(args = {}) {
  if (councilMode(args) === "quick") return QUICK_TASKS;
  if (Array.isArray(args.tasks) && args.tasks.length) return args.tasks;
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
  return {
    council_mode: mode,
    debate_format: mode === "quick" ? "single_round_parallel" : "host_managed_visible_debate",
    time_budget_ms: null,
    deadline_at: null,
    deadline_enforced: false,
  };
}

function remainingCouncilBudget(run, capMs) {
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
  const usable = Date.parse(run.deadline_at) - Date.now() - reserve - killGrace;
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
    visibility_required: true,
    ...timing,
    started_at: startedAt,
    updated_at: startedAt,
    completed_at: null,
    status: "planned",
    phase: "visible_planned",
    tasks,
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
    prompt: taskPrompt(task, run.symbol, run.as_of, userPrompt, run.language, run.grounding, run.council_pace),
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
      // A declined seat already carries a readable deterministic scope statement and a frozen
      // out_of_scope stance no worker may change, so the explanation worker could not alter
      // the record -- it only cost one sequential model turn per seat on a host with no
      // fan-out. On a full bench that was 26 extra turns, which roughly doubled visible
      // wall-clock. Seats that actually reached a decision still get their worker below.
      const requiresVisibleVoice = false;
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
  const v3VoiceAgents = plan.completed
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
  const inline = total <= inlinePromptBudget();
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
      confidence: voice.confidence,
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
  const validated = assertRuntimeClientPayload("evidence", args.packet, {
    run_id: run.run_id,
    task,
  });
  const packet = normalizePacket({
    ...validated,
    thread_id: args.thread_id,
    thread_title: args.thread_title,
    execution_mode: "visible_host_threads",
  }, task, run.symbol, run.as_of, rawRecordText(args.packet));
  assertVisibleReaderLanguage(visibleEvidenceReaderText(packet), run, `visible evidence ${task}`);
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
  if (missingEvidence.length || missingMasters.length) {
    rejectVisibleDecision(
      run,
      "VISIBLE_DEBATE_PREREQUISITES_INCOMPLETE",
      "Bull/Bear debate rejected: complete every evidence packet and returned method-seat worker first.",
      { missing_evidence: missingEvidence, missing_masters: missingMasters },
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
  return {
    missing_evidence: missingEvidence,
    missing_masters: missingMasters,
    missing_debate_rounds: missingRounds,
    missing_debate_sides: missingSides,
    qna_gate: state.qna_gate,
    passed: missingEvidence.length === 0
      && missingMasters.length === 0
      && missingRounds.length === 0
      && missingSides.length === 0
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
  return [
    packet?.summary,
    ...(packet?.claims || []).flatMap((claim) => [claim?.claim, claim?.evidence]),
    ...(packet?.open_questions || []),
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
    "confidence", "information_richness", "thread_id", "execution_mode", "raw_text",
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

function outputFailureKind(error) {
  return error?.code === "READER_LANGUAGE_MISMATCH"
    ? "reader_language_mismatch"
    : "parse_failed";
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
  const asOfDate = args.as_of || today();
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
    visibility_required: false,
    ...timing,
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
  const asOfDate = args.as_of || today();
  const id = args.run_id || runId(symbol);
  const tasks = plannedTasks(args);
  const dryRun = isDryRun(args);
  const language = resolveLanguage(args);
  const frozen = frozenMasterSelection(args);
  const startedAt = args.queued_run?.started_at || new Date().toISOString();
  const timing = councilTiming(args, startedAt);
  const requestedTimeoutMs = Number.isFinite(args.timeout_ms) ? args.timeout_ms : LIMITS.CODEX_TIMEOUT_MS;
  const timeoutMs = timing.council_mode === "quick"
    ? Math.min(requestedTimeoutMs, LIMITS.QUICK_EVIDENCE_MS)
    : Math.min(requestedTimeoutMs, councilPaceProfile(timing.council_pace).evidence_ms);
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
    visibility_required: false,
    ...timing,
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
    writeJson(join(dir, `${packet.task}.json`), packet);
    writeJson(join(dir, "evidence.json"), run);
    writeSourceManifest(run);
    writeAnalystMarkdownFiles(run, existingDebate(dir));
    writeArtifactIndex(run, existingDebate(dir));
    writeAllAgentsMarkdown(run);
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
    updateTask(run, task, run.council_mode === "quick" ? "degraded" : "failed", {
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
    const prompt = taskPrompt(task, symbol, asOfDate, workerObjective, language, run.grounding, run.council_pace);
    updateTask(run, task, "running", { started_at: new Date().toISOString() });
    if (dryRun) {
      const packet = dryPacket(task, symbol, asOfDate, prompt, language);
      commitPacket(packet);
      updateTask(run, task, "completed", { completed_at: new Date().toISOString(), output: join(dir, `${task}.json`) });
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
      updateTask(run, task, terminalStatus, {
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
      packet = normalizePacket(extractWorkerJson(result.text, "evidence"), task, symbol, asOfDate, result.text);
      assertReaderLanguage(evidenceReaderText(packet), language, `evidence worker ${task}`);
      commitPacket(packet);
      updateTask(run, task, "completed", { completed_at: new Date().toISOString(), output: join(dir, `${task}.json`), attempts: 1 });
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
      const elapsedMs = Date.now() - workerStartedAt;
      const retryTimeoutMs = Math.min(
        LIMITS.PARSE_REPAIR_MS,
        timeoutMs - elapsedMs,
        remainingCouncilBudget(run, LIMITS.PARSE_REPAIR_MS),
      );
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
        packet = normalizePacket(extractWorkerJson(result.text, "evidence"), task, symbol, asOfDate, result.text);
        assertReaderLanguage(evidenceReaderText(packet), language, `evidence worker ${task} repair`);
        commitPacket(packet);
        updateTask(run, task, "completed", {
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
  const requestedTimeoutMs = Number.isFinite(args.timeout_ms) ? args.timeout_ms : LIMITS.CODEX_TIMEOUT_MS;
  const timeoutMs = run.council_mode === "quick"
    ? Math.min(requestedTimeoutMs, LIMITS.QUICK_MASTER_MS)
    : Math.min(requestedTimeoutMs, runPace(run).master_ms);
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

  const outcomes = await mapLimit(votingWorkerItems, maxConcurrency, async ({ id, decision, engine, frozenOpinion, deterministic_decline, deterministic_execution }) => {
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
    const parse = (result) => {
      if (frozenOpinion) {
        const voice = normalizeMasterVoice(extractWorkerJson(result.text, "method_voice"), id, run, frozenOpinion, result.text);
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
          confidence: voice.confidence,
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

    let result = await execute(prompt, timeoutMs, 1);
    if (!result.ok) {
      return { id, error: result.deadline_exhausted ? "global_deadline" : result.timedOut ? "timeout" : `exit code ${result.code}`, raw: cleanLog(result.stderr || result.stdout || "method worker failed") };
    }
    try {
      return { id, opinion: parse(result), engine };
    } catch (firstParseError) {
      const firstFailureKind = outputFailureKind(firstParseError);
      const repairBudget = Math.min(LIMITS.PARSE_REPAIR_MS, remainingCouncilBudget(run, LIMITS.PARSE_REPAIR_MS));
      if (repairBudget <= 0) return { id, error: firstFailureKind, raw: cleanLog(firstParseError?.message || result.text) };
      const repairPrompt = [
        "PARSE-ONLY TRANSPORT REPAIR. Do not browse, search, add facts or change the frozen method stance.",
        `Master ID: ${id}; required acknowledged stance: ${frozenOpinion?.stance || "use the original stance"}; output language: ${run.language}.`,
        frozenOpinion
          ? "Return one JSON object with master, acknowledged_stance, voice_mode=first_person_public_method_simulation_v1, disclosure_ack=alphacouncil.first_person_public_method_simulation.v1, position_intent, every required first-person voice field, key_findings, disagreements, what_would_change_my_mind, source_ids and confidence. Do not return a flat statement."
          : "Return one JSON object matching the master_opinion schema from the original prompt.",
        `Write every reader-facing value in ${run.language}. Translation is allowed only to repair language; preserve the frozen stance, facts, numbers and source IDs.`,
        `Malformed output:\n${String(result.text || "").slice(0, LIMITS.PARSE_REPAIR_INPUT_CHARS)}`,
      ].join("\n\n");
      result = await execute(repairPrompt, repairBudget, 2);
      if (!result.ok) return { id, error: result.deadline_exhausted ? "global_deadline" : result.timedOut ? "timeout" : `exit code ${result.code}`, raw: cleanLog(result.stderr || "method repair failed") };
      try {
        return { id, opinion: parse(result), engine };
      } catch (secondParseError) {
        return { id, error: outputFailureKind(secondParseError), raw: cleanLog(secondParseError?.message || result.text) };
      }
    }
  }, (error, { id }) => ({
    id,
    error: "unexpected_error",
    raw: cleanLog(error?.message || error),
  }));

  for (const outcome of [...abstainedOutcomes, ...outcomes]) {
    if (!outcome.opinion) {
      const diagnosticPath = join(dir, `${outcome.id}.failure.json`);
      writeJson(diagnosticPath, {
        master: outcome.id,
        failure_kind: outcome.error,
        diagnostic: outcome.raw,
        public_summary: outcome.error === "reader_language_mismatch"
          ? localized(run.language, {
            en: "The dedicated method worker returned reader-facing content in the wrong language; no method-seat statement is available.",
            zh: "专属方法席 worker 返回了错误语言的读者内容；没有可用的方法席发言。",
            ja: "専用メソッド席ワーカーは指定と異なる言語の読者向け内容を返したため、利用可能なメソッド席の発言はありません。",
            ko: "전용 방법론 좌석 워커가 지정과 다른 언어의 독자용 내용을 반환해 사용할 수 있는 방법론 좌석 발언이 없습니다.",
          })
          : localized(run.language, {
            en: "The dedicated method worker did not complete; no method-seat statement is available.",
            zh: "专属方法席 worker 未完成；没有可用的方法席发言。",
            ja: "専用メソッド席ワーカーが完了せず、利用可能なメソッド席の発言はありません。",
            ko: "전용 방법론 좌석 워커가 완료되지 않아 사용할 수 있는 방법론 좌석 발언이 없습니다.",
          }),
      }, { mode: 0o600 });
      updateMasterStatus(run, outcome.id, "failed", { error: outcome.error, diagnostic: diagnosticPath });
      continue;
    }
    byId.set(outcome.id, outcome.opinion);
    writeJson(join(dir, `${outcome.id}.json`), outcome.opinion);
    updateMasterStatus(run, outcome.id, "completed", {
      engine: outcome.opinion.engine || outcome.engine,
      worker_kind: outcome.opinion.dedicated_worker?.execution_mode === "dry_run"
        ? "dedicated_method_voice_dry_run"
        : "dedicated_method_worker",
      worker_pid: outcome.opinion.dedicated_worker?.pid || null,
      voice_status: outcome.opinion.voice_status || "completed",
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
  let result = timeoutMs <= 0
    ? deadlineResult(run)
    : await runCodex(prompt, timeoutMs, ({ pid, output }) => {
      updateAgent(run, role, "running", { pid, output, round: context.round });
    }, ({ pid, output, elapsed_ms }) => {
      updateAgent(run, role, "running", { pid, output, round: context.round });
      appendEvent(run, "agent_heartbeat", { role, round: context.round, pid, output, elapsed_ms });
    }, { search: false, sigkillGraceMs: councilKillGrace(run) });
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
  let packet = enforceLanguage(debateFromCodex(result, role, run, prompt));
  if (result.ok && ["parse_failed", "reader_language_mismatch"].includes(packet.failure_kind)) {
    const repairBudget = Math.min(LIMITS.PARSE_REPAIR_MS, remainingCouncilBudget(run, LIMITS.PARSE_REPAIR_MS));
    if (repairBudget > 0) {
      const repairReason = packet.failure_kind;
      appendEvent(run, "agent_parse_repair", { role, round: context.round, budget_ms: repairBudget, reason: repairReason });
      const repairPrompt = [
        "PARSE-ONLY TRANSPORT REPAIR. Do not search, browse, add facts or redo the analysis.",
        `Role: ${role}; symbol: ${run.symbol}; as_of: ${run.as_of}; reader language: ${run.language}; round: ${context.round || "final"}.`,
        repairReason === "reader_language_mismatch"
          ? "Translate only the reader-facing strings in the supplied valid debate-packet JSON. Preserve exact round-2 questions, exact round-3 question bindings, facts, numbers, source IDs and uncertainty. Return one JSON object only."
          : "Convert only the supplied malformed output into one valid debate-packet JSON object. Preserve exact round-2 questions and exact round-3 question bindings when present. Return JSON only.",
        role === "portfolio_manager"
          ? `portfolio_manager.report_markdown is mandatory and must contain every authored report section. Required headings: ${requiredReportSectionAliases(run).map((section) => section.suggested_heading).join("; ")}.`
          : "",
        `Write every reader-facing value in ${run.language}. Translation is allowed only to repair language; preserve facts, numbers, source IDs and exact Q&A bindings.`,
        `Malformed output:\n${String(result.text || "").slice(0, LIMITS.PARSE_REPAIR_INPUT_CHARS)}`,
      ].join("\n\n");
      result = await runCodex(repairPrompt, repairBudget, ({ pid, output }) => {
        updateAgent(run, role, "running", { pid, output, round: context.round, attempts: 2 });
      }, () => {}, { search: false, sigkillGraceMs: councilKillGrace(run) });
      packet = enforceLanguage(debateFromCodex(result, role, run, repairPrompt));
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
    });
    appendEvent(run, "agent_role_completed", {
      role,
      ok: result.ok,
      timed_out: result.timedOut === true,
      verdict: packet.verdict,
      failure_kind: packet.failure_kind,
    });
  }
  return { packet, result };
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
  const manager = managerOk ? managerStep.packet : managerFallback(run, args.prompt || "");
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
  const requestedSynthesisMs = Number.isFinite(args.synthesis_timeout_ms)
    ? args.synthesis_timeout_ms
    : Number(args.timeout_ms || LIMITS.CODEX_TIMEOUT_MS);
  const timeoutMs = run.council_mode === "quick"
    ? Math.min(requestedSynthesisMs, LIMITS.QUICK_SYNTHESIS_MS)
    : Math.min(requestedSynthesisMs, runPace(run).debate_ms);
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

  const pmBudget = remainingCouncilBudget(run, Math.min(requestedSynthesisMs, runPace(run).pm_ms));
  const managerStep = await runDebateRole(run, "portfolio_manager", { bull, bear, outputMode }, pmBudget);
  const managerOk = !debateFailure(managerStep);
  const manager = managerOk ? managerStep.packet : managerFallback(run, args.prompt || "");
  const gate = verificationStatus(run);
  writeJson(join(dir, "manager_synthesis.json"), manager);
  writeJson(join(dir, "decision.json"), manager);
  updateAgent(run, "portfolio_manager", managerOk ? "completed" : "failed", {
    completed_at: new Date().toISOString(),
    output: join(dir, "manager_synthesis.json"),
    error: managerOk ? undefined : debateFailure(managerStep),
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
  const completedAt = new Date().toISOString();
  const terminal = new Set(["completed", "degraded", "failed", "timed_out", "skipped"]);
  const failOpenStates = (states = {}) => Object.fromEntries(Object.entries(states).map(([id, state]) => [id,
    terminal.has(state?.status) ? state : {
      ...state,
      status: "failed",
      error: "unexpected_orchestrator_error",
      completed_at: completedAt,
      updated_at: completedAt,
      pid: null,
    },
  ]));
  run.task_status = failOpenStates(run.task_status);
  run.agent_status = failOpenStates(run.agent_status);
  run.master_status = failOpenStates(run.master_status);
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
