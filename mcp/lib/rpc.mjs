import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";
import { ANALYST_SCOPES, COUNCIL_MODES, COUNCIL_PACE_NAMES, DEFAULT_COUNCIL_PACE, LIMITS, MASTER_STANCES, OUTPUT_MODES, QUICK_TASKS, SERVER_NAME, VERSION } from "./constants.mjs";
import { RpcCode, methodNotFound, invalidParams, toRpcError } from "./errors.mjs";
import { readJson, readJsonl, writeJson } from "./fsutil.mjs";
import { localized, resolveLanguage } from "./lang.mjs";
import { sweepStaleOutputs } from "./codex.mjs";
import { completenessStatus, sourceManifest } from "./gates.mjs";
import { artifactPaths, existingDebate, runId, runPath, safeSymbol, saveRun } from "./run-store.mjs";
import { summaryModes } from "./output-modes.mjs";
import { registry } from "./personas/registry.mjs";
import { preflightNetworkPermissions } from "./preflight.mjs";
import { getQuotes } from "./quotes.mjs";
import { MACRO_BLOCKS, getMacroSnapshot } from "./macro.mjs";
import { fetchOptionsChain } from "./options.mjs";
import { getMarketNarrative } from "./narrative.mjs";
import { getSocialPulse, verifyXPost } from "./social.mjs";
import { councilOptions } from "./council-options.mjs";
import { beginCouncilSelection, confirmCouncilSelection, consumeCouncilSelection, selectionRequiredError } from "./council-selection.mjs";
import { cleanupSelectionStore } from "./selection-cleanup.mjs";
import { fetchFeeds, tickerNewsFeed, queryNewsFeed, filingsFeed } from "./feeds.mjs";
import { screenTicker, explainResult, screenBatch } from "./screen.mjs";
import { gatherGrounding, groundingBlock } from "./grounding.mjs";
import { fetchMarketFinancials, coverageFor, MARKETS } from "./markets.mjs";
import { table, mark, metricValue, groundingDashboard, label, threshold, skippedMark } from "./tables.mjs";
import { fetchUniverse } from "./sec.mjs";
import { industryBrief, listIndustries, industryCoverage, peersBySic, SIC_GROUPS } from "./industry.mjs";
import { analyzeSymbol, collectEvidence, finalizeUnhandledBackgroundFailure, finalizeVisibleRun, queueHeadlessRun, recordMasterOpinion, recordVerifierBatch, recordVerifierVerdict, recordVisibleDecision, recordVisiblePacket, visibleAgentSpecs, visibleRun } from "./orchestrator.mjs";
import { acquireRunLock } from "./run-locks.mjs";
import { diagnoseCouncilRuns } from "./council-diagnostics.mjs";
import { recoverInterruptedBackgroundRuns } from "./background-recovery.mjs";
import { buildCompanySourceAcquisitionPlan, getCompanySourceMap } from "./company-source-acquisition.mjs";

export function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

export function sendError(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

/**
 * What a `record_*` call returns: progress, not the whole run.
 *
 * These handlers used to echo the entire run object -- every packet, every master opinion,
 * the full grounding block -- on every call. The payload therefore grew with each recording,
 * and late in a twenty-one-seat run a single response passed 240k characters. On any host
 * that keeps tool results in the transcript that is a context-exhaustion bug, and it gets
 * worse exactly when the run is most nearly finished.
 *
 * The caller needs to know what landed and what is still outstanding. The full state is on
 * disk in status.json and is one read away for anyone who wants it.
 */
export function recordAck(run, extra = {}) {
  const gate = completenessStatus(run);
  const pendingMasters = gate.missing_masters;
  return {
    run_id: run.run_id,
    symbol: run.symbol,
    status: run.status,
    phase: run.phase,
    recorded_tasks: (run.packets || []).map((p) => p.task),
    pending_tasks: (run.tasks || []).filter((t) => !(run.packets || []).some((p) => p.task === t)),
    recorded_masters: (run.master_opinions || []).map((o) => o.master),
    pending_masters: pendingMasters,
    missing_master_count: pendingMasters.length,
    completeness: gate.completeness,
    missing_evidence_count: gate.missing_evidence_count,
    missing_debate_count: gate.missing_debate_count,
    status_json: join(runPath(run.run_id), "status.json"),
    ...extra,
  };
}

function renderSelectionCatalog(data) {
  const copy = (messages) => localized(data.language, messages);
  const labels = copy({
    en: { identity: "Identity", method: "Method", bestFor: "Best for", maturity: "Maturity", pack: "Pack format", preselected: "preselected", recommended: "advisory method match" },
    zh: { identity: "身份", method: "方法", bestFor: "适合", maturity: "成熟度", pack: "物理格式", preselected: "已预选", recommended: "方法模拟建议" },
    ja: { identity: "人物像", method: "手法", bestFor: "適した対象", maturity: "成熟度", pack: "パック形式", preselected: "事前選択済み", recommended: "参考メソッド候補" },
    ko: { identity: "정체성", method: "방법", bestFor: "적합 대상", maturity: "성숙도", pack: "팩 형식", preselected: "사전 선택", recommended: "참고 방법 후보" },
  });
  const preselected = new Set(data.preselected_master_ids || []);
  const recommended = new Set(data.method_panel_recommendation?.included_master_ids || []);
  // Some MCP hosts expose only text content even when the server also returns
  // structuredContent. Keep the selection handshake usable on those hosts by
  // mirroring the exact, non-secret session identifiers in a stable text block.
  // This does not confirm or consume the selection; display_ack and the one-use
  // receipt are still enforced by confirmCouncilSelection/consumeCouncilSelection.
  const fallbackContext = `ALPHACOUNCIL_SELECTION_CONTEXT ${JSON.stringify({
    selection_id: data.selection_id,
    catalog_hash: data.catalog_hash,
    intent_hash: data.intent_hash,
    expires_at: data.expires_at,
    council_mode: data.council_mode,
    analyst_options: data.analyst_options?.map((option) => ({ scope: option.scope, count: option.count })),
    ...(data.recommendation_hash ? { recommendation_hash: data.recommendation_hash } : {}),
  })}`;
  const cards = data.masters.map((master) => [
    `${master.index}. ${master.title} [${master.id}]${preselected.has(master.id) ? ` [${labels.preselected}]` : ""}${recommended.has(master.id) ? ` [${labels.recommended}]` : ""}`,
    `${labels.identity}: ${master.identity}`,
    `${labels.method}: ${master.method}`,
    `${labels.bestFor}: ${master.best_for}`,
    `${labels.maturity}: ${master.maturity_label} (${master.maturity})`,
    `${labels.pack}: ${master.pack_format} (${master.admission_level})`,
  ].join("\n   ")).join("\n\n");
  const recommendedIds = data.method_panel_recommendation?.included_master_ids || [];
  const unfilledFamilies = data.method_panel_recommendation?.unfilled_families || [];
  const recommendationNotice = data.method_panel_recommendation?.status === "recommended"
    ? recommendedIds.length
      ? copy({
        en: `Advisory method-simulation panel: ${recommendedIds.join(", ")}. Unfilled method families: ${unfilledFamilies.join(", ") || "none"}. This is selection help only: the full catalog remains available, it does not represent human experts, and no research starts without your explicit submission. Return recommendation_hash with confirmation.`,
        zh: `方法模拟建议面板：${recommendedIds.join("、")}。未填充方法族：${unfilledFamilies.join("、") || "无"}。这只帮助选择：完整目录仍可选，不代表真人专家；未经你明确提交不会开始研究。确认时请原样回传 recommendation_hash。`,
        ja: `参考メソッド候補：${recommendedIds.join(", ")}。未充足のメソッド群：${unfilledFamilies.join(", ") || "なし"}。選択補助に限られ、全カタログは引き続き選択可能です。実在の専門家を表すものではなく、明示的な送信なしに調査は開始しません。確認時に recommendation_hash をそのまま返してください。`,
        ko: `참고 방법 후보: ${recommendedIds.join(", ")}. 채워지지 않은 방법론 계열: ${unfilledFamilies.join(", ") || "없음"}. 선택 보조일 뿐이며 전체 카탈로그는 계속 선택할 수 있습니다. 실제 전문가를 뜻하지 않고 명시적으로 제출하기 전에는 조사가 시작되지 않습니다. 확인 시 recommendation_hash를 그대로 보내십시오.`,
      })
      : copy({
        en: `No method passed the advisory coverage gate. Unfilled method families: ${unfilledFamilies.join(", ") || "none"}. The full catalog remains selectable; confirm an explicit choice with recommendation_hash.`,
        zh: `没有方法通过本次建议覆盖闸门。未填充方法族：${unfilledFamilies.join("、") || "无"}。完整目录仍可选择；请带 recommendation_hash 明确确认你的选择。`,
        ja: `参考カバレッジゲートを通過したメソッドはありません。未充足のメソッド群：${unfilledFamilies.join(", ") || "なし"}。全カタログは選択可能です。recommendation_hash を添えて明示的に確認してください。`,
        ko: `권고 커버리지 게이트를 통과한 방법론이 없습니다. 채워지지 않은 방법론 계열: ${unfilledFamilies.join(", ") || "없음"}. 전체 카탈로그는 선택할 수 있으며 recommendation_hash와 함께 명시적으로 확인해야 합니다.`,
      })
    : copy({
      en: "No advisory panel was generated because the instrument classification is missing. Choose explicitly from the full catalog; no default eight was guessed.",
      zh: "由于缺少资产分类，本次未生成方法建议面板。请从完整目录明确选择；系统没有猜测默认 8 席。",
      ja: "銘柄分類がないため参考パネルは生成されませんでした。全カタログから明示的に選択してください。既定の8席は推測していません。",
      ko: "종목 분류가 없어 참고 패널을 만들지 않았습니다. 전체 카탈로그에서 명시적으로 선택하십시오. 기본 8개 좌석을 추측하지 않았습니다.",
    });
  const quick = data.council_mode === "quick";
  const analystChoice = quick
    ? copy({
      en: `Analyst selection: quick is fixed at ${data.analyst_options[0].count} seats (${data.analyst_options[0].analyst_ids.join(", ")}).`,
      zh: `分析席选择：quick 固定运行 ${data.analyst_options[0].count} 席（${data.analyst_options[0].analyst_ids.join("、")}）。`,
      ja: `分析席選択：quick は ${data.analyst_options[0].count} 席固定です（${data.analyst_options[0].analyst_ids.join(", ")}）。`,
      ko: `분석가 선택: quick은 ${data.analyst_options[0].count}개 좌석으로 고정됩니다(${data.analyst_options[0].analyst_ids.join(", ")}).`,
    })
    : copy({
      en: `Analyst selection is separate from method selection: choose core (${data.analyst_options.find((option) => option.scope === "core")?.count}) or all (${data.analyst_options.find((option) => option.scope === "all")?.count}). "All methods" does not imply "all analysts" and vice versa.`,
      zh: `分析席与方法席必须分开选择：core（${data.analyst_options.find((option) => option.scope === "core")?.count} 席）或 all（${data.analyst_options.find((option) => option.scope === "all")?.count} 席）。“全部方法席”不再等于“全部分析席”，反之亦然。`,
      ja: `分析席とメソッド席は別々に選択します：core（${data.analyst_options.find((option) => option.scope === "core")?.count}席）または all（${data.analyst_options.find((option) => option.scope === "all")?.count}席）。`,
      ko: `분석가 좌석과 방법론 좌석은 별도로 선택합니다: core(${data.analyst_options.find((option) => option.scope === "core")?.count}개) 또는 all(${data.analyst_options.find((option) => option.scope === "all")?.count}개).`,
    });
  const instructions = quick
    ? copy({
      en: `Quick mode: choose 1 to ${data.maximum} masters. Submit numbers, ranges, or stable IDs, for example: 1 / 1,3,8 / 1-4 / master_buffett. Selecting all is not supported.`,
      zh: `Quick 模式请选择 1 至 ${data.maximum} 位大师。回复编号、范围或稳定 ID，例如：1 / 1,3,8 / 1-4 / master_buffett；不支持 all 全选。`,
      ja: `Quick モードでは1席から${data.maximum}席を選んでください。番号、範囲、stable ID（例：1 / 1,3,8 / 1-4 / master_buffett）を送信してください。all は使用できません。`,
      ko: `Quick 모드에서는 1개에서 ${data.maximum}개 마스터 좌석을 선택하십시오. 번호, 범위 또는 stable ID(예: 1 / 1,3,8 / 1-4 / master_buffett)를 제출하십시오. all은 지원하지 않습니다.`,
    })
    : copy({
      en: `Choose 1 to ${data.maximum} masters. Submit numbers, ranges, stable IDs, or all, for example: 1 / 1,3,8 / 1-5 / master_buffett / all.`,
      zh: `请选择 1 至 ${data.maximum} 位大师。回复编号、范围、稳定 ID，或 all 全选，例如：1 / 1,3,8 / 1-5 / master_buffett / all。`,
      ja: `1席から${data.maximum}席のマスターを選んでください。番号、範囲、stable ID、または all（例：1 / 1,3,8 / 1-5 / master_buffett / all）を送信してください。`,
      ko: `1개에서 ${data.maximum}개 마스터 좌석을 선택하십시오. 번호, 범위, stable ID 또는 all(예: 1 / 1,3,8 / 1-5 / master_buffett / all)을 제출하십시오.`,
    });
  return [
    copy({
      en: `Master selection (${data.masters.length} in catalog; choose up to ${data.maximum})`,
      zh: `大师选择（目录共 ${data.masters.length} 席；最多选择 ${data.maximum} 席）`,
      ja: `マスター選択（全${data.masters.length}席、最大${data.maximum}席まで）`,
      ko: `마스터 선택(전체 ${data.masters.length}개 좌석, 최대 ${data.maximum}개 선택)`,
    }),
    fallbackContext,
    "",
    recommendationNotice,
    "",
    cards,
    "",
    analystChoice,
    "",
    instructions,
    copy({
      en: "Research starts only after this selection is submitted.",
      zh: "提交选择后才会开始研究。",
      ja: "選択を送信するまで調査は開始されません。",
      ko: "선택을 제출하기 전에는 조사를 시작하지 않습니다.",
    }),
  ].join("\n");
}

export function jsonContent(text, structuredContent = {}) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

const TERMINAL_ANALYSIS_STATUSES = new Set([
  "complete",
  "degraded",
  "incomplete",
  "needs_verification",
  "needs_revision",
  "failed",
]);
const READ_RUN_DETAILS = new Set(["compact", "full"]);
const COMPACT_DECISION_SCALARS = [
  "run_id", "role", "symbol", "as_of", "decision_available", "verdict", "rating",
  "winner", "summary", "valuation_range", "position", "confidence", "failure_kind",
];
const COMPACT_DECISION_LISTS = ["catalysts", "risks", "invalidation", "source_ids"];

function isTerminalAnalysis(value) {
  const status = typeof value === "string" ? value : value?.status;
  return TERMINAL_ANALYSIS_STATUSES.has(status);
}

function persistedUserResponse(runId) {
  const path = join(runPath(runId), "user_response.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function terminalHandoffText(run, fallback) {
  if (!isTerminalAnalysis(run) || !run?.run_id) return fallback;
  return persistedUserResponse(run.run_id) || fallback;
}

function boundedCompactText(value, limit = 2_000) {
  if (typeof value !== "string") return value;
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** Keep the decision useful for polling without returning its report/raw transcript bodies. */
export function compactDecision(decision) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return decision ?? null;
  const compact = {};
  for (const field of COMPACT_DECISION_SCALARS) {
    if (decision[field] !== undefined) compact[field] = boundedCompactText(decision[field]);
  }
  for (const field of COMPACT_DECISION_LISTS) {
    if (!Array.isArray(decision[field])) continue;
    compact[field] = decision[field].slice(0, 12).map((item) => boundedCompactText(item, 800));
  }
  return compact;
}

/** Summarize an append-only event log without echoing every event payload into the host. */
export function compactEventSummary(eventLog) {
  const entries = Array.isArray(eventLog?.entries) ? eventLog.entries : [];
  const typeCounts = new Map();
  for (const event of entries) {
    const type = typeof event?.type === "string" ? event.type : "unknown";
    typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
  }
  const first = entries[0] || null;
  const last = entries[entries.length - 1] || null;
  return {
    count: entries.length,
    parse_error_count: Number(eventLog?.parse_errors || 0),
    first_at: first?.at || null,
    last_at: last?.at || null,
    last_type: last?.type || null,
    type_counts: Object.fromEntries([...typeCounts.entries()].slice(0, 64)),
  };
}

function readRunDetail(value) {
  const detail = value === undefined ? "compact" : String(value);
  if (!READ_RUN_DETAILS.has(detail)) {
    throw invalidParams("read_run detail must be compact or full.", {
      reason: "INVALID_READ_RUN_DETAIL",
      allowed: [...READ_RUN_DETAILS],
    });
  }
  return detail;
}

// Series history and per-fact lineage are the two unbounded parts of a grounding object: on one
// real run they were 2.33 MB of a 2.54 MB plan payload, which exceeded the host's tool-result
// limit and pushed the entire plan to a scratch file. They are already saved in evidence.json and
// baked into every seat prompt, so the plan response replaces them with a pointer and a count.
const BULK_GROUNDING_FIELDS = ["macro_series", "typed_fact_sources"];

/**
 * The grounding a plan response carries: the same object minus its two unbounded fields.
 * Shape, flags and gap lists are preserved so a host can still read what was established.
 */
export function compactGrounding(run) {
  const g = run?.grounding;
  if (!g || typeof g !== "object") return g;
  const compact = { ...g };
  const omitted = [];
  for (const field of BULK_GROUNDING_FIELDS) {
    if (compact[field] === undefined) continue;
    const count = Array.isArray(compact[field]) ? compact[field].length : Object.keys(compact[field] || {}).length;
    omitted.push(`${field} (${count} entries)`);
    delete compact[field];
  }
  if (!omitted.length) return compact;
  compact.omitted_from_this_response = {
    fields: omitted,
    reason: "kept out of the plan payload for size; every seat prompt already carries them",
    saved_to: join(runPath(run.run_id), "evidence.json"),
  };
  return compact;
}

export function tool(name, description, inputSchema, annotations = {}) {
  return { name, description, inputSchema, annotations };
}

/**
 * Validate and consume the one-run master selection before any run directory, network
 * request or worker exists. A caller-provided masters list cannot override the receipt.
 */
function startValidation(args, entryTool) {
  if ((entryTool === "collect_evidence" || entryTool === "analyze_symbol") && args.visibility_required === true) {
    throw invalidParams("visibility_required=true cannot be satisfied by headless MCP. Use host-visible agents or threads and plan_visible_run.", {
      reason: "VISIBLE_EXECUTION_REQUIRED",
    });
  }
  if (args.tasks !== undefined) {
    if (!Array.isArray(args.tasks)) throw invalidParams("tasks must be an array of analyst IDs.");
    const analysts = new Set(registry().ids("analyst"));
    const unknown = args.tasks.filter((task) => typeof task !== "string" || !analysts.has(task));
    if (unknown.length) {
      throw invalidParams(`Unknown analyst task(s): ${unknown.join(", ")}`, {
        reason: "UNKNOWN_ANALYST_TASK",
        unknown,
      });
    }
  }
  const mode = args.council_mode === undefined ? "full" : args.council_mode;
  if (!COUNCIL_MODES.includes(mode)) {
    throw invalidParams(`council_mode must be one of ${COUNCIL_MODES.join(", ")}.`, {
      reason: "INVALID_COUNCIL_MODE",
    });
  }
  if (mode === "quick" && args.tasks !== undefined
    && JSON.stringify(args.tasks) !== JSON.stringify(QUICK_TASKS)) {
    throw invalidParams("Quick council uses its fixed four-role evidence contract; tasks cannot override it.", {
      reason: "QUICK_TASK_OVERRIDE_FORBIDDEN",
      required_tasks: QUICK_TASKS,
    });
  }
  if (args.total_timeout_ms !== undefined
    && (!Number.isFinite(args.total_timeout_ms) || args.total_timeout_ms <= 0)) {
    throw invalidParams("total_timeout_ms must be a positive number.", {
      reason: "INVALID_TOTAL_TIMEOUT",
    });
  }
  if (args.council_pace !== undefined && !COUNCIL_PACE_NAMES.includes(String(args.council_pace))) {
    throw invalidParams(`council_pace must be one of ${COUNCIL_PACE_NAMES.join(", ")}.`, {
      reason: "INVALID_COUNCIL_PACE",
      allowed: COUNCIL_PACE_NAMES,
    });
  }
  if (mode === "quick" && args.council_pace !== undefined) {
    throw invalidParams("council_pace applies to the full council only. Quick is a smaller contract, not a slower one.", {
      reason: "QUICK_PACE_FORBIDDEN",
    });
  }
  // The upper bound cannot be checked here: when execution omits council_pace, the confirmed
  // receipt still owns it. consumeCouncilSelection validates the requested timeout against that
  // bound pace while both the run lock and receipt lock are held, before writing consumed state.
  if (mode === "quick" && args.synthesis === false) {
    throw invalidParams("Quick council requires its one-round bull/bear and portfolio-manager synthesis.", {
      reason: "QUICK_SYNTHESIS_REQUIRED",
    });
  }
  if (entryTool === "analyze_symbol" && mode === "full" && args.synthesis === false) {
    throw invalidParams("analyze_symbol is a decision-producing council and requires Bull/Bear plus portfolio-manager synthesis. Use collect_evidence for a task-selective evidence run.", {
      reason: "FULL_SYNTHESIS_REQUIRED",
      alternative_tool: "collect_evidence",
    });
  }
  if (entryTool === "plan_visible_run" && args.synthesis !== undefined) {
    throw invalidParams("plan_visible_run always plans the complete visible full council; synthesis cannot be disabled or overridden.", {
      reason: "VISIBLE_SYNTHESIS_OVERRIDE_FORBIDDEN",
    });
  }
  if (entryTool === "plan_visible_run" && mode === "quick") {
    throw invalidParams("Quick council requires plugin-managed analyze_symbol so its global deadline can be enforced.", {
      reason: "QUICK_REQUIRES_HEADLESS_ORCHESTRATOR",
    });
  }
}

function assertExistingRunMatches(existing, args, entryTool, id) {
  if (existing.master_selection?.selection_receipt !== args.selection_receipt) {
    throw invalidParams(`run_id already exists and belongs to another selection: ${id}`, {
      reason: "RUN_ID_ALREADY_EXISTS",
      run_id: id,
    });
  }
  if (existing.entry_tool && existing.entry_tool !== entryTool) {
    throw invalidParams(`Run ${id} was started by ${existing.entry_tool}, not ${entryTool}.`, {
      reason: "RUN_ENTRY_TOOL_MISMATCH",
      run_id: id,
      entry_tool: existing.entry_tool,
    });
  }
}

function selectedRunArgs(args = {}, entryTool) {
  if (!args.selection_receipt) throw selectionRequiredError();
  if (args.masters !== undefined || args.masters_roster !== undefined) {
    throw invalidParams("masters and masters_roster cannot override a confirmed selection receipt.", {
      reason: "MASTER_SELECTION_OVERRIDE_FORBIDDEN",
    });
  }
  startValidation(args, entryTool);
  const symbol = safeSymbol(args.symbol);
  const id = args.run_id || runId(symbol);
  const dir = runPath(id); // validates the id without creating anything
  const existingEvidence = join(dir, "evidence.json");

  // Serialize both first-start and idempotent replay. The metadata lease recovers a
  // same-host dead owner under the bounded run-lock policy; an active owner is never
  // pre-empted merely because its advertised lease elapsed.
  const runLock = acquireRunLock(id);
  const releaseRunLock = () => runLock.release();
  try {
    let existing = existsSync(existingEvidence) ? readJson(existingEvidence) : null;
    if (existing) assertExistingRunMatches(existing, args, entryTool, id);

    const selection = consumeCouncilSelection({
      selection_receipt: args.selection_receipt,
      symbol,
      run_id: id,
      // Preserve omission so consumeCouncilSelection can infer the same locale
      // from the prompt that begin_council_selection bound into the receipt.
      language: args.language,
      prompt: typeof args.prompt === "string" ? args.prompt : "",
      council_mode: args.council_mode || "full",
      council_pace: args.council_pace,
      analyst_scope: args.analyst_scope,
      total_timeout_ms: args.total_timeout_ms,
    });
    const outsideFrozenAnalystScope = Array.isArray(args.tasks)
      ? args.tasks.filter((task) => !selection.selected_analyst_ids.includes(task))
      : [];
    if (outsideFrozenAnalystScope.length) {
      throw invalidParams("tasks cannot add analysts outside the scope frozen in the selection receipt.", {
        reason: "ANALYST_SELECTION_OVERRIDE_FORBIDDEN",
        confirmed_analyst_scope: selection.analyst_scope,
        confirmed_analyst_ids: selection.selected_analyst_ids,
        submitted_tasks: args.tasks,
        outside_frozen_scope: outsideFrozenAnalystScope,
      });
    }
    return {
      ...args,
      run_id: id,
      entry_tool: entryTool,
      masters: selection.selected_master_ids,
      master_selection: selection,
      analyst_scope: selection.analyst_scope,
      selected_analyst_ids: [...selection.selected_analyst_ids],
      tasks: [...selection.selected_analyst_ids],
      // The gate's decision wins when the caller omitted it.
      council_pace: args.council_pace ?? selection.council_pace ?? undefined,
      existing_run: existing,
      release_run_lock: releaseRunLock,
    };
  } catch (error) {
    releaseRunLock();
    throw error;
  }
}

function attachRunContext(error, runArgs) {
  if (error && typeof error === "object") {
    error.data = { ...(error.data || {}), run_id: runArgs.run_id };
  }
  return error;
}

async function withSelectedRun(args, entryTool, operation) {
  const runArgs = selectedRunArgs(args, entryTool);
  try {
    return await operation(runArgs);
  } catch (error) {
    throw attachRunContext(error, runArgs);
  } finally {
    runArgs.release_run_lock();
  }
}

const backgroundRuns = new Map();

function backgroundAnalysisAccepted(runArgs) {
  const dir = runPath(runArgs.run_id);
  const queued = runArgs.queued_run;
  const mode = queued?.council_mode || runArgs.council_mode || "full";
  return {
    accepted: true,
    run_id: runArgs.run_id,
    symbol: safeSymbol(runArgs.symbol),
    status: "accepted",
    phase: "queued",
    execution_mode: "background_codex_exec",
    council_mode: mode,
    report_contract: mode === "quick" ? "quick_v1" : "full_v2",
    full_council_equivalent: mode !== "quick",
    deadline_at: queued?.deadline_at || null,
    time_budget_ms: queued?.time_budget_ms || null,
    poll_tool: "read_run",
    status_json: join(dir, "status.json"),
    events_jsonl: join(dir, "events.jsonl"),
  };
}

function persistBackgroundFailure(runArgs, error) {
  const evidencePath = join(runPath(runArgs.run_id), "evidence.json");
  if (!existsSync(evidencePath)) return;
  try {
    finalizeUnhandledBackgroundFailure(runArgs.run_id, runArgs.prompt || "", error);
  } catch {
    // A concurrent read can still use the last atomic status/evidence snapshot. Never let
    // failure-reporting itself become an unhandled rejection that kills the MCP process.
  }
}

function startBackgroundSelectedRun(args, entryTool, operation) {
  const runArgs = selectedRunArgs(args, entryTool);
  // A replay of an already terminal run is not new background work. Return its persisted
  // result synchronously so text-only hosts receive the final handoff instead of another
  // misleading "accepted; keep polling" acknowledgement.
  if (runArgs.existing_run && isTerminalAnalysis(runArgs.existing_run)) {
    try {
      return { terminal_result: loadExistingAnalysis(runArgs.existing_run) };
    } catch (error) {
      throw attachRunContext(error, runArgs);
    } finally {
      runArgs.release_run_lock();
    }
  }
  try {
    if (!runArgs.existing_run) runArgs.queued_run = queueHeadlessRun(runArgs);
  } catch (error) {
    runArgs.release_run_lock();
    throw attachRunContext(error, runArgs);
  }
  const pending = Promise.resolve()
    .then(() => operation(runArgs))
    .catch((error) => persistBackgroundFailure(runArgs, attachRunContext(error, runArgs)))
    .finally(() => {
      backgroundRuns.delete(runArgs.run_id);
      runArgs.release_run_lock();
    });
  backgroundRuns.set(runArgs.run_id, pending);
  return backgroundAnalysisAccepted(runArgs);
}

function loadExistingAnalysis(run) {
  const dir = runPath(run.run_id);
  const decisionPath = join(dir, "decision.json");
  if (!existsSync(decisionPath)) {
    throw invalidParams(`Run ${run.run_id} already started but has no completed decision to replay.`, {
      reason: "RUN_ALREADY_STARTED",
      run_id: run.run_id,
      status: run.status,
      phase: run.phase,
    });
  }
  const decision = readJson(decisionPath);
  const finalReportPath = join(dir, "final_report.md");
  const userResponsePath = join(dir, "user_response.md");
  const qualityPath = join(dir, "report_quality.json");
  return {
    run,
    debate: existingDebate(dir),
    decision,
    final_report_markdown: existsSync(finalReportPath) ? readFileSync(finalReportPath, "utf8") : "",
    user_response_markdown: existsSync(userResponsePath) ? readFileSync(userResponsePath, "utf8") : "",
    report_quality: existsSync(qualityPath) ? readJson(qualityPath) : null,
    artifacts: artifactPaths(run),
    idempotent_replay: true,
  };
}

export function tools() {
  // Derived from personas/, not from a frozen list: adding a persona file makes the role
  // selectable through the tool schema with no code change.
  const analystIds = registry().ids("analyst");
  const debateIds = registry().ids("debate");
  const masterIds = registry().ids("master");
  const common = {
    symbol: { type: "string", description: "Exchange ticker. US, HK, JP, KR, CN and TW symbols all work, e.g. AAPL, 0700.HK, 7203.T, 005930.KS, 600519.SS." },
    as_of: { type: "string", description: "Analysis date YYYY-MM-DD. Defaults to today." },
    prompt: { type: "string", description: "User objective or extra instructions." },
    language: { type: "string", default: "auto", description: "Reader-facing language for subagents and final report, e.g. auto, zh-CN, en-US, ja-JP. Auto infers from prompt." },
    council_mode: {
      type: "string",
      enum: COUNCIL_MODES,
      default: "full",
      description: "full runs the analyst scope frozen in the receipt (core=8, all=11) and a three-round cross-exam. quick runs the fixed news-inclusive four-role preset, up to four methods, one parallel bull/bear round, a short PM, and a hard global budget.",
    },
    tasks: { type: "array", items: { type: "string", enum: analystIds } },
    dry_run: { type: "boolean", default: false, description: "Default false. Set true only for planning/self-tests without launching Codex subagents." },
    max_concurrency: { type: "number", default: LIMITS.CONCURRENCY_DEFAULT },
    timeout_ms: { type: "number", description: "Optional legacy per-worker ceiling. Omit it to use the selected council pace's stage caps; callers may only use it to lower those caps." },
    synthesis: { type: "boolean", default: true, description: "Run bull, bear, and portfolio-manager synthesis after evidence collection." },
    synthesis_timeout_ms: { type: "number", description: "Optional legacy synthesis ceiling. Omit it to use the selected council pace's debate and portfolio-manager caps." },
    council_pace: {
      type: "string",
      enum: COUNCIL_PACE_NAMES,
      description: "Full-council depth/time tier. fast = 15 minutes, normal = 30, slow = 60. The tier sets the total budget AND every per-stage cap together: fast gives each evidence seat 4.7 minutes and each debate side 45 seconds; normal gives 6 and 3 minutes; slow gives 12 and 6 minutes. These are configured ceilings, not measured completion times. Raising total_timeout_ms alone buys idle time, not depth. Quick rejects this field.",
    },
    total_timeout_ms: {
      type: "number",
      maximum: LIMITS.FULL_HARD_MAX_MS,
      description: "Hard queue-to-persistence wall-clock budget. Cannot exceed the selected council_pace's total (fast 900000, normal 1800000, slow 3600000) or ten minutes for quick. Callers may lower the applicable ceiling, never raise it.",
    },
    output_mode: { type: "string", enum: OUTPUT_MODES, default: "public_equity", description: "Final synthesis target shape." },
    selection_receipt: { type: "string", description: "One-run receipt returned by confirm_master_selection. Required for every council run and consumed exactly once." },
    seat_weights: { type: "object", description: "Override the declared weight of any seat, e.g. {\"master_buffett\": 2, \"master_soros\": 0}. Weights are an editable prior, not an optimum: a return backtest of LLM judgment would be invalidated by look-ahead bias." },
    visibility_required: { type: "boolean", default: false, description: "When true, headless MCP execution is rejected; use host-visible agents/threads and record their outputs." },
  };
  return [
    tool("begin_council_selection", "MANDATORY first step for every council run. Creates a short-lived selection session and returns two separate choices: method seats and analyst breadth (core=8 or all=11). It does not create a research run, fetch data or launch workers. Show both choices even when the request already names one of them.", {
      type: "object",
      properties: {
        symbol: common.symbol,
        prompt: common.prompt,
        language: common.language,
        council_mode: common.council_mode,
        host: { type: "string", description: "Calling host, e.g. codex, claude-code, opencode or grok-build." },
        preselected_master_ids: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", enum: masterIds },
          description: "Optional stable IDs inferred from masters explicitly named in the request. They are highlighted only; the user must still submit this run's selection.",
        },
        council_pace: {
          type: "string",
          enum: COUNCIL_PACE_NAMES,
          description: "Prefill only, when the request already named a speed such as fast or slow. It highlights that tier in the returned pace_options and never confirms one. Full only.",
        },
        analyst_scope: {
          type: "string",
          enum: ANALYST_SCOPES,
          description: "Prefill only. core means the eight mandatory evidence seats; all means all eleven analyst seats. The user still submits the scope at confirmation.",
        },
        instrument_classification: {
          type: "object",
          properties: {
            asset_type: { type: "string", minLength: 1 },
            research_model: { type: "string", minLength: 1 },
            classification_source: { type: "string" },
          },
          required: ["asset_type", "research_model"],
          description: "Optional already-known classification used only for a deterministic advisory method panel. Missing classification fails closed and never guesses a default eight.",
        },
        typed_fact_coverage: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
          description: "Optional stable typed-fact IDs already known to be available. Used only with instrument_classification to rank manifest-declared capabilities.",
        },
      },
      required: ["symbol"],
    }, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }),
    tool("confirm_master_selection", "Confirm both independent one-run choices after the catalog was displayed: (1) method seats via IDs/select_all/text and (2) analyst_scope=core|all. Full runs reject an omitted analyst scope. Returns a one-time receipt binding both choices and the pace.", {
      type: "object",
      properties: {
        selection_id: { type: "string" },
        catalog_hash: { type: "string", description: "The catalog_hash returned by begin_council_selection." },
        display_ack: { type: "boolean", description: "Must be true after the host displayed the catalog to the user." },
        recommendation_hash: {
          type: "string",
          pattern: "^sha256:[a-f0-9]{64}$",
          description: "Required only when begin_council_selection returned a non-null advisory recommendation_hash. It acknowledges the exact 26-decision recommendation displayed; it does not select seats.",
        },
        selected_master_ids: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: masterIds } },
        select_all: { type: "boolean", const: true },
        selection: { type: "string", minLength: 1, description: "Text fallback: stable numbers/ranges/IDs, or all." },
        council_pace: {
          type: "string",
          enum: COUNCIL_PACE_NAMES,
          description: "The depth tier the user picked from the pace_options this selection returned. Full only; omit to accept the default (normal, 30-minute persistence ceiling; observed completion remains unvalidated until live evidence exists). Binds into the receipt, so an execution call may repeat it but never change it.",
        },
        analyst_scope: {
          type: "string",
          enum: ANALYST_SCOPES,
          description: "Required for full: core runs 8 analyst seats; all runs all 11. Separate from select_all, which selects method seats only. Omit for quick.",
        },
      },
      required: ["selection_id", "catalog_hash", "display_ack"],
      oneOf: [
        { required: ["selected_master_ids"], not: { anyOf: [{ required: ["select_all"] }, { required: ["selection"] }] } },
        { required: ["select_all"], not: { anyOf: [{ required: ["selected_master_ids"] }, { required: ["selection"] }] } },
        { required: ["selection"], not: { anyOf: [{ required: ["selected_master_ids"] }, { required: ["select_all"] }] } },
      ],
    }, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }),
    tool("plan_visible_run", "Create the visible-host-thread AlphaCouncil run after a confirmed master selection. Requires a one-time selection_receipt. Does NOT execute. Run every returned evidence_agent, then every returned master_agent. Physical v3 master agents explain a frozen deterministic stance and may not change it. Record all required bull/bear rounds before the portfolio_manager decision; PM rejects any returned master_agent that was not recorded.", {
      type: "object",
      properties: {
        symbol: common.symbol,
        as_of: common.as_of,
        prompt: common.prompt,
        language: common.language,
        council_mode: common.council_mode,
        tasks: common.tasks,
        total_timeout_ms: common.total_timeout_ms,
        selection_receipt: common.selection_receipt,
        seat_weights: common.seat_weights,
        grounding: { type: "object", description: "The `grounding` object from compose_research_brief. Injected into every analyst prompt." },
        run_id: { type: "string" },
      },
      required: ["symbol", "selection_receipt"],
    }),
    tool("record_visible_packet", "MANDATORY sequential step (not optional): record one completed visible evidence agent packet into a planned visible run. Every reader-facing field must use the run language or the packet is rejected without changing run state. Every planned evidence task MUST be recorded before debate completion and portfolio_manager.", {
      type: "object",
      properties: {
        run_id: { type: "string" },
        task: { type: "string", enum: analystIds },
        packet: { type: "object" },
        thread_id: { type: "string" },
        thread_title: { type: "string" },
      },
      required: ["run_id", "task", "packet"],
    }),
    tool("finalize_visible_run", "MANDATORY terminal fallback when a visible-host run cannot cross its next hard gate. It irreversibly closes the run as incomplete, preserves completed records, writes the standard no-rating report and handoff, and returns user_response_markdown whose final section accounts for every selected method seat. Never use it to turn a failed seat into an opinion.", {
      type: "object",
      properties: {
        run_id: { type: "string" },
        reason: {
          type: "string",
          enum: ["host_cancelled", "host_timeout", "evidence_worker_failed", "verifier_worker_failed", "method_worker_failed", "debate_worker_failed", "host_unavailable"],
        },
        failed_tasks: { type: "array", items: { type: "string", enum: analystIds }, uniqueItems: true },
        failed_masters: { type: "array", items: { type: "string", enum: masterIds }, uniqueItems: true },
        failed_roles: { type: "array", items: { type: "string", enum: debateIds }, uniqueItems: true },
      },
      required: ["run_id", "reason"],
    }, { readOnlyHint: false, destructiveHint: true, openWorldHint: false }),
    tool("record_visible_decision", "Record exactly one visible decision step. Full visible bull_researcher and bear_researcher calls MUST supply round=1, then round=2, then round=3; both sides of the prior round are required before advancing. Round 2 asks exactly three questions; Round 3 preserves its own questions and answers the opponent's questions with exact bindings. Packets are persisted by role+round: an identical replay is idempotent and conflicting content is rejected. portfolio_manager accepts no round and is rejected until all evidence, selected masters, both three-round sides, and the exact Q&A gate are complete. Every reader-facing field must use the run language.", {
      type: "object",
      properties: {
        run_id: { type: "string" },
        role: { type: "string", enum: debateIds },
        round: { type: "integer", minimum: 1, maximum: 3, description: "Required for bull_researcher and bear_researcher. Full visible runs require 1, 2, and 3 in order. Omit for portfolio_manager." },
        packet: { type: "object" },
        thread_id: { type: "string" },
        thread_title: { type: "string" },
      },
      required: ["run_id", "role", "packet"],
      allOf: [
        {
          if: { properties: { role: { enum: ["bull_researcher", "bear_researcher"] } }, required: ["role"] },
          then: { required: ["round"] },
        },
        {
          if: { properties: { role: { const: "portfolio_manager" } }, required: ["role"] },
          then: { not: { required: ["round"] } },
        },
      ],
    }),
    tool("collect_evidence", "Launch Codex subagents and save shared JSON evidence packets. Use dry_run=true only for planning/self-tests.", {
      type: "object",
      properties: common,
      required: ["symbol", "selection_receipt"],
    }),
    tool("analyze_symbol", "Research an operating company, ETF, mutual fund or market index and write a manager-style decision summary. The instrument is classified before evidence routing: funds use holdings look-through, indices use aggregate methodology, and Company Facts screens apply only to operating companies. Set council_mode=quick for the bounded news-inclusive quick_v1 path; the default remains the full council.", {
      type: "object",
      properties: {
        ...common,
        wait_for_completion: {
          type: "boolean",
          default: false,
          description: "Default false for real runs: return a run_id immediately and poll read_run. Set true only when the MCP client can remain connected for the entire council. Dry runs remain synchronous when this field is omitted.",
        },
      },
      required: ["symbol", "selection_receipt"],
    }),
    tool("read_run", "Read a saved AlphaCouncil Agent run. Terminal text is the persisted user handoff. detail=compact (default) returns bounded polling state and artifact paths; detail=full returns the legacy complete evidence/report payload.", {
      type: "object",
      properties: {
        run_id: { type: "string" },
        detail: {
          type: "string",
          enum: ["compact", "full"],
          default: "compact",
          description: "compact returns status, a bounded decision, report quality, artifact paths, an event summary and user_response only. full preserves the legacy evidence/events/report bodies.",
        },
      },
      required: ["run_id"],
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    tool("council_diagnostics", "Measure descriptive seat agreement, unique cited-source contribution and repeated-input behavioural differentiation across saved runs. This tool never treats seat count or agreement as independent evidence: error N_eff remains null unless the separate preregistered signed resolved-outcome protocol is satisfied.", {
      type: "object",
      properties: {
        run_ids: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: { type: "string" },
          description: "Saved run IDs. Repeated-input claims require hash-identical facts, selection and pack policies.",
        },
        minimum_cases: {
          type: "integer",
          minimum: 3,
          maximum: 100,
          default: 3,
          description: "Minimum distinct hash-identical cases, each with at least two repetitions, before a behavioural-differentiation verdict is emitted.",
        },
      },
      required: ["run_ids"],
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    tool("compare_summary_modes", "Compare chat, PDF, presentation, document, and specialist plugin modes for final AlphaCouncil Agent synthesis.", {
      type: "object",
      properties: { language: common.language },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    tool("record_master_opinion", "Record one returned visible method-seat worker after evidence and before debate. For physical v3 seats, submit the first-person public-method simulation schema from plan_visible_run: exact voice_mode and disclosure_ack, master, acknowledged_stance, position_intent, all five voice fields, key_findings, disagreements, what_would_change_my_mind, source_ids and confidence. acknowledged_stance must equal the frozen stance; the worker cannot vote again. Legacy packets may use stance/verdict/summary. Reader-facing fields in the wrong run language are rejected without changing state. Every returned selected seat must be recorded before PM.", {
      type: "object",
      properties: {
        run_id: { type: "string" },
        master: { type: "string", enum: masterIds },
        packet: {
          type: "object",
          description: `Current physical v3 seats require the five-field first-person public-method voice contract; acknowledged_stance MUST be one of ${MASTER_STANCES.join(" | ")} and match the frozen stance returned by plan_visible_run. The legacy stance/verdict/summary shape remains accepted only for a legacy seat.`,
          properties: {
            master: { type: "string", enum: masterIds },
            acknowledged_stance: { type: "string", enum: MASTER_STANCES },
            voice_mode: { type: "string", const: "first_person_public_method_simulation_v1" },
            disclosure_ack: { type: "string", const: "alphacouncil.first_person_public_method_simulation.v1" },
            position_intent: { type: "string", enum: ["would_buy", "would_add", "would_hold", "would_watch", "would_pass", "would_avoid", "not_in_my_circle", "inputs_unavailable"] },
            voice: {
              type: "object",
              properties: {
                would_i_act: { type: "string", minLength: 1 },
                what_i_see: { type: "string", minLength: 1 },
                how_my_method_reads_it: { type: "string", minLength: 1 },
                where_i_disagree: { type: "string", minLength: 1 },
                what_changes_my_mind: { type: "string", minLength: 1 },
              },
            },
            key_findings: { type: "array", items: { type: "string" } },
            disagreements: { type: "array", items: { type: "string" } },
            what_would_change_my_mind: { type: "array", items: { type: "string" } },
            source_ids: { type: "array", items: { type: "string" } },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            stance: { type: "string", enum: MASTER_STANCES },
            verdict: { type: "string" },
            summary: { type: "string" },
          },
        },
        thread_id: { type: "string" },
      },
      required: ["run_id", "master", "packet"],
    }),
    tool("get_macro_snapshot", "Keyless DELAYED top-down macro context in one call: rate curve, dollar and credit, commodities, risk appetite and breadth, and cross-market indices, plus derived pairs (10Y-3M spread, copper/gold, HY/IG, equal-weight vs cap-weight). Use it to place a single name inside its macro environment. These are observations, not a regime call, and unavailable series are data gaps for open_questions.", {
      type: "object",
      properties: {
        blocks: {
          type: "array",
          items: { type: "string", enum: MACRO_BLOCKS.map((b) => b.id) },
          description: "Subset of macro blocks. Defaults to all.",
        },
      },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("list_council_options", "Browse the current analysts, presets, master catalog, rosters and verifiers without opening a selection session. This is informational only and cannot authorize a run. Every council run must still call begin_council_selection, display that frozen catalog, and confirm_master_selection.", {
      type: "object",
      properties: { language: { type: "string", description: "Language for the labels. Defaults to English." } },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    tool("get_options_chain", "Keyless DELAYED options chain digest from CBOE for one US-listed symbol: ATM implied-volatility term structure, 25-delta skew, put/call ratios on open interest and volume, the strikes holding the most open interest, and the ATM bid-ask spread as a share of mid. Contracts reporting iv = 0 (expired or deep in the money) are excluded rather than read as zero volatility. This is a snapshot with no history, so IV percentile or rank CANNOT be computed from it and must stay an open question. Non-US listings are generally absent and are reported as unavailable, never guessed.", {
      type: "object",
      properties: {
        symbol: { type: "string", description: "US-listed underlying, e.g. MU or BRK.B." },
        as_of: { type: "string", description: "ISO date used to compute days-to-expiry. Defaults to today." },
      },
      required: ["symbol"],
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("get_market_narrative", "What story the market is currently telling itself, read from keyless news feeds (Federal Reserve, SEC, WSJ, CNBC, Yahoo) and cross-checked against the macro tape. Returns ranked themes with their share of coverage, dated and linked sample headlines, and for each theme the actual market series that would corroborate it. Headline counts measure ATTENTION, never truth: where a theme leads coverage and its series has not moved, that divergence is the finding. Every item must carry a timestamp inside the window or it is reported as excluded. Themes come from a fixed lexicon, so a genuinely new narrative lands in unclassified_headlines rather than being discovered, and the output says so.", {
      type: "object",
      properties: {
        days: { type: "number", description: "Recency window in days. Defaults to 7." },
        as_of: { type: "string", description: "ISO date treated as now. Defaults to today." },
        extra_queries: {
          type: "array", items: { type: "string" },
          description: "Up to 4 extra Google News queries to fold in, e.g. a sector or a country.",
        },
        top: { type: "number", description: "How many themes to return. Defaults to 6." },
      },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("get_news", "Dated headlines for one symbol, one search query, or one company's SEC filings, from keyless feeds (Yahoo Finance RSS, Google News RSS, EDGAR Atom). Every item must carry a parsable timestamp inside the window; undated and out-of-window items are counted and sampled under excluded_outside_window rather than being shown as recent. Filings are the one source here that cannot be spun, so prefer them for anything material.", {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Ticker for the Yahoo per-name feed." },
        query: { type: "string", description: "Free-text Google News query, e.g. 'HBM supply Samsung'." },
        cik: { type: "string", description: "SEC CIK for the filings feed." },
        forms: { type: "string", description: "Filing type for the CIK feed. Defaults to 8-K." },
        days: { type: "number", description: "Recency window in days. Defaults to 14." },
        as_of: { type: "string", description: "ISO date treated as now. Defaults to today." },
      },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("get_company_sources", "Acquire a company-specific starter pack and freeze the company-agnostic source ladder before research. SEC filers receive CIK resolution, recent filings, filing-text issuer-domain discovery and official-page excerpts. Other listed markets fall back to quote-resolved issuer identity, dated cross-topic feeds, and the correct regulator/exchange search route. Returns the exact 52-item acquisition plan; every official, counterparty, market, local-history, disconfirming and derivation stage must be attempted before unavailable is allowed. Keyless; evidence stays separate from proxy/model outcomes and this tool is not an investment verdict.", {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Listed ticker, including market suffix where needed, e.g. AAPL, 0700.HK, 7203.T or 000660.KS." },
        cik: { type: "string", description: "Optional SEC CIK for a US filer; skips ticker resolution when supplied." },
        as_of: { type: "string", description: "YYYY-MM-DD research cutoff; defaults to today." },
      },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("get_social_pulse", "Keyless retail and technical-community discussion for a name or theme, from Reddit (searched inside the equity subreddits, not site-wide), Hacker News, and any Bluesky handles supplied. IMPORTANT: X / Twitter has NO free discovery channel -- Nitter search is dead, the X API bills per post and xAI bills per call -- so this does NOT cover professional FinTwit, and Reddit is not a substitute for it. Mention volume measures attention, never correctness. Nothing here may enter a conclusion alone; it is a lead to be confirmed against a filing or recorded in open_questions.", {
      type: "object",
      properties: {
        query: { type: "string", description: "Company name or theme to search for." },
        symbol: { type: "string", description: "Used as the query when query is absent." },
        subreddits: { type: "array", items: { type: "string" }, description: "Override the default equity subreddits." },
        handles: { type: "array", items: { type: "string" }, description: "Bluesky handles to read. Search needs auth; reading a named account does not." },
        days: { type: "number", description: "Recency window in days. Defaults to 7." },
        as_of: { type: "string", description: "ISO date treated as now." },
      },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("verify_x_post", "Confirm that one X post id exists and read back its text, author and date. Use it whenever a report or search result quotes a post: a decoded snowflake timestamp proves nothing, because any invented 19-digit id decodes to a plausible date, so existence has to be checked separately. This is verification only and cannot search or discover posts.", {
      type: "object",
      properties: { id: { type: "string", description: "Numeric X post id." } },
      required: ["id"],
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("record_verifier_verdict", "Record one Stage 2b verifier outcome against the seat that cited the claim. Verdicts that failed verification (contradicted, disagree, refuted) automatically reduce that seat's weight in the portfolio-manager synthesis; cannot_confirm and source_unreachable reduce it less. A seat is down-weighted, never silently erased.", {
      type: "object",
      properties: {
        run_id: { type: "string" },
        verifier: { type: "string", enum: registry().ids("verifier") },
        seat: { type: "string", description: "The seat whose claim was checked, e.g. bull_researcher or master_buffett." },
        verdict: { type: "string", description: "Must be one of the verifier's declared verdict_values." },
        claim: { type: "string" },
        note: { type: "string" },
      },
      required: ["run_id", "verifier", "seat", "verdict"],
    }),
    tool("record_verifier_batch", "Mandatory visible-run recorder for slow + all methods + all analysts. Record one complete batch from source_fidelity, rederivation, or refuter after all analyst packets and before any method seat. Every frozen material claim must appear exactly once; partial batches fail closed.", {
      type: "object",
      properties: {
        run_id: { type: "string" },
        verifier: { type: "string", enum: ["source_fidelity", "rederivation", "refuter"] },
        packet: { type: "object" },
        thread_id: { type: "string" },
        thread_title: { type: "string" },
      },
      required: ["run_id", "verifier", "packet"],
    }),
    tool("industry_brief", "Start from an industry rather than a ticker. Returns the participant list by position in the value chain -- INCLUDING the non-US names a SEC-only pipeline would silently drop, such as Korean and Japanese makers -- plus who actually drives demand, the questions a run must answer, how the industry behaves through a cycle, and which participants this pipeline can screen mechanically versus which need their own regulator's feed. Returns a frame, never a verdict.", {
      type: "object",
      properties: {
        industry: { type: "string", description: "Free text; ids and aliases in both languages, e.g. memory, 存储, HBM, DRAM." },
      },
      required: ["industry"],
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    tool("market_financials", "Structured financials for ANY market, degrading in a stated order: keyless regulator feed (SEC for US, TWSE for Taiwan), then a feed needing a free key (DART for Korea, EDINET for Japan) reported as not-configured rather than pretended away, then quotes plus search which always work. Never returns an empty result silently -- it says which feed is missing, why, and what to use instead.", {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Exchange symbol, e.g. 2408.TW, 000660.KS, 285A.T, 0700.HK." },
        corp_code: { type: "string", description: "Korea only: DART's 8-digit corp_code, which is not the ticker. Samsung Electronics is 00126380, SK hynix 00164779." },
        year: { type: "number", description: "Korea only: fiscal year. Defaults to last year." },
      },
      required: ["symbol"],
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("market_coverage", "Ask up front what this pipeline can and cannot fetch for a set of symbols, before building a report on them. Returns per-symbol whether structured financials are available, summary-only, or absent, and which environment variable would unlock a market. Names without a feed are still researchable from documents -- but every figure taken that way has to be labelled as such.", {
      type: "object",
      properties: { symbols: { type: "array", items: { type: "string" } } },
      required: ["symbols"],
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    tool("compose_research_brief", "Classify the instrument and assemble hard facts BEFORE analysts search. Operating companies may receive SEC Company Facts or local-market financials; ETFs and funds receive a holdings look-through contract; indices receive an aggregate-index contract. The result also carries quote, applicable filer profile, options/macro/industry context, explicit not-applicable routes, typed facts, and a prompt block. A searched number never silently overwrites a filed one. Pass the returned `grounding` object to plan_visible_run so every analyst prompt carries it.", {
      type: "object",
      properties: {
        symbol: common.symbol,
        cik: { type: "string", description: "SEC CIK; enables the filer profile and the mechanical screen." },
        industry: { type: "string", description: "Industry query; adds the value-chain participants including non-US names." },
        macro: { type: "boolean", default: true },
        as_of: { type: "string", description: "YYYY-MM-DD; only filings filed by this date are used." },
        language: common.language,
      },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("industry_coverage", "Ask what is actually known about an industry BEFORE researching it. Returns whether a curated value-chain map exists, whether SEC's SIC classification covers it, or neither -- with guidance for each case. SIC reaches every industry with a US filer; a curated map additionally carries chain position, non-US participants and demand drivers. Use this so a report never presents an uncurated participant list as if it were complete.", {
      type: "object",
      properties: { industry: { type: "string" } },
      required: ["industry"],
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    tool("industry_peers", "Find US filers related to a company using SEC's own SIC classification -- no curation and no model. Covers every industry with a US filer, including ones no curated map reaches. It gives no value-chain position and no non-US participants: for those prefer industry_brief where a map exists. Peer matching is by company name and is a starting universe, not an index membership list.", {
      type: "object",
      properties: {
        cik: { type: "string", description: "Anchor company CIK. Resolve one with list_us_universe." },
        limit: { type: "number", default: 25 },
      },
      required: ["cik"],
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("list_industries", "The industries that have a hand-maintained map. Deliberately a short list: an unmapped industry should be handled by research rather than by inventing a participant list.", {
      type: "object",
      properties: {},
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    tool("screen_ticker", "Run the mechanical elimination screen against an operating company's own SEC filings. It is not applicable to ETFs, funds or indices; use compose_research_brief so those instruments are classified and routed correctly. No language model is involved: seven hard rules (10y ROE, 5y cumulative FCF, interest cover, gross margin, OCF/NI, net margin, dilution) with three exemptions, and every rejection names the metric, value and threshold. Missing rules are skipped, never passes. Surviving is not a recommendation. US operating-company filers only.", {
      type: "object",
      properties: {
        cik: { type: "string", description: "SEC CIK. Use list_us_universe to resolve a ticker." },
        ticker: { type: "string", description: "US ticker, e.g. MU. Resolved to a CIK against the SEC universe, so supplying this is enough." },
        as_of: { type: "string", description: "YYYY-MM-DD. Only filings actually filed by this date are used, which is what keeps a historical screen free of look-ahead bias." },
      },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("screen_candidates", "Run the mechanical elimination screen over a list of candidates and report every rejection with the metric, the measured value and the threshold. This is the 'find me stocks' path, and no language model participates in it. Capped at 40 names: SEC is one request per company and rate-limits, so narrow the funnel first with industry_brief, industry_peers or list_us_universe. A fetch failure is reported as unavailable rather than eliminated, because dropping a name because SEC timed out would bias the survivors.", {
      type: "object",
      properties: {
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: { cik: { type: "string" }, ticker: { type: "string" } },
            required: ["cik"],
          },
          description: "Up to 40 companies.",
        },
        as_of: { type: "string", description: "YYYY-MM-DD. Only filings filed by this date are used." },
      },
      required: ["candidates"],
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("list_us_universe", "The full SEC list of US listed companies (~10k) as {cik, ticker, title}. Keyless. Use it to resolve a ticker to a CIK, or as the starting universe for a screen.", {
      type: "object",
      properties: {
        contains: { type: "string", description: "Case-insensitive filter on ticker or company name." },
        limit: { type: "number", default: 50 },
      },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("preflight_permissions", "MANDATORY before a visible run: check that the host actually grants the network tools the evidence agents need. Background subagents cannot raise an interactive permission prompt, so a missing allowlist entry blocks their searches SILENTLY and they answer from training knowledge while still filling in every report section. Returns status ok | blocked | unknown with a remedy.", {
      type: "object",
      properties: {
        roster: { type: "string", default: "default", description: "Which analyst roster the run will use." },
      },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    tool("get_quote", "Keyless DELAYED market data (Yahoo/Stooq, ~15m or EOD) for indices, index futures (incl. night session), FX, rates, vol, commodities, and stocks. Accepts plain names ('KOSPI','纳指期货','VIX','美元指数','10年美债','黄金') or raw tickers (^KS11, ES=F, 7203.T). Use for real index/futures/macro numbers; on error treat as a data gap (open_questions). Not real-time, not investment advice.", {
      type: "object",
      properties: {
        symbols: { type: "array", items: { type: "string" }, description: "Names or tickers, e.g. ['KOSPI','ES=F','VIX','美元指数']." },
        symbol: { type: "string", description: "Single name/ticker (alternative to symbols[])." },
      },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
  ];
}

export async function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments || {};
  if (name === "begin_council_selection") {
    const data = beginCouncilSelection(args);
    sendResult(id, jsonContent(renderSelectionCatalog(data), data));
    return;
  }
  if (name === "confirm_master_selection") {
    const data = confirmCouncilSelection(args);
    const fallbackContext = `ALPHACOUNCIL_CONFIRMATION_CONTEXT ${JSON.stringify({
      selection_id: data.selection_id,
      selection_receipt: data.selection_receipt,
      catalog_hash: data.catalog_hash,
      intent_hash: data.intent_hash,
      council_mode: data.council_mode,
      analyst_scope: data.analyst_scope,
      selected_analyst_count: data.selected_analyst_count,
      ...(data.recommendation_hash ? { recommendation_hash: data.recommendation_hash } : {}),
    })}`;
    const confirmation = localized(data.language, {
      en: `Confirmed ${data.selected_count} method seat(s) and ${data.selected_analyst_count} analyst seat(s) (${data.analyst_scope}) for ${data.symbol}. Use the one-time selection_receipt to start this run.`,
      zh: `已为 ${data.symbol} 分别确认 ${data.selected_count} 个方法席与 ${data.selected_analyst_count} 个分析席（${data.analyst_scope}）。请使用一次性 selection_receipt 启动本轮运行。`,
      ja: `${data.symbol} についてメソッド${data.selected_count}席と分析担当${data.selected_analyst_count}席（${data.analyst_scope}）を別々に確定しました。1回限りの selection_receipt を使用してください。`,
      ko: `${data.symbol}에 대해 방법론 ${data.selected_count}개 좌석과 분석가 ${data.selected_analyst_count}개 좌석(${data.analyst_scope})을 별도로 확정했습니다. 일회용 selection_receipt를 사용하십시오.`,
    });
    sendResult(id, jsonContent(`${fallbackContext}\n${confirmation}`, data));
    return;
  }
  if (name === "plan_visible_run") {
    const result = await withSelectedRun(args, "plan_visible_run", async (runArgs) => {
      const run = runArgs.existing_run || visibleRun(runArgs);
      if (run.visible_finalization) {
        const handoffPath = join(runPath(run.run_id), "user_response.md");
        return jsonContent(
          `Loaded finalized visible AlphaCouncil Agent run for ${run.symbol}: ${run.run_id}. Deliver the persisted handoff; start a new selected run to continue research.`,
          {
            run: { ...run, grounding: compactGrounding(run) },
            idempotent_replay: true,
            finalized: true,
            handoff_contract: "inline_user_response_v1",
            user_response_markdown: existsSync(handoffPath) ? readFileSync(handoffPath, "utf8") : "",
            artifacts: artifactPaths(run),
          },
        );
      }
      // Gather the established facts here rather than accepting them only when a host
      // remembers to pass them. Without this the whole visible path -- which is the path
      // Claude Code uses -- runs every analyst and every master with no filings, no quote and
      // no macro, and nothing in the output says so. Same reasoning as the preflight below:
      // the host that skips the optional step is exactly the host whose seats fail quietly.
      if (!run.grounding) {
        run.grounding = await gatherGrounding({ symbol: run.symbol, asOf: run.as_of, language: run.language })
          .catch((error) => ({
            error: String(error?.message || error),
            facts_unavailable: true,
            source_acquisition_plan: buildCompanySourceAcquisitionPlan({
              symbol: run.symbol,
              asOf: run.as_of,
              profile: {},
            }),
          }));
        saveRun(run);
      }
      const specs = visibleAgentSpecs(run, runArgs.prompt || "");
      // Planning settles every seat whose method cannot reach this security, writing those
      // opinions directly. They have to be persisted here or the completeness gate would keep
      // waiting for a report from a seat that will never be spawned.
      if (specs.masters_declined?.length) {
        saveRun(run);
        writeJson(join(runPath(run.run_id), "evidence.json"), run);
      }
      // Returned with the plan, not left to a separate opt-in call: a host that skips the
      // preflight is exactly the host whose subagents will fail silently.
      const preflight = preflightNetworkPermissions({ roster: runArgs.roster || "default" });
      return jsonContent(
        `${runArgs.existing_run ? "Loaded" : "Planned"} visible AlphaCouncil Agent run for ${run.symbol}: ${run.run_id}. `
        + `Network preflight: ${preflight.status}. `
        + `Established facts: ${run.grounding && !run.grounding.facts_unavailable ? "attached to every seat" : "UNAVAILABLE -- seats will run without filings or quotes, say so in the report"}.`,
        {
          run: { ...run, grounding: compactGrounding(run) },
          idempotent_replay: Boolean(runArgs.existing_run),
          preflight,
          ...specs,
          artifacts: {
            all_agents_md: join(runPath(run.run_id), "all_agents.md"),
            status_json: join(runPath(run.run_id), "status.json"),
            events_jsonl: join(runPath(run.run_id), "events.jsonl"),
          },
        },
      );
    });
    // Do not publish a completed RPC response while the exclusive run lock still exists.
    // A client is allowed to issue an immediate idempotent replay after receiving the
    // response; sending inside withSelectedRun made that replay race its finally-release.
    sendResult(id, result);
    return;
  }
  if (name === "record_visible_packet") {
    const run = recordVisiblePacket(args);
    sendResult(id, jsonContent(`Recorded visible evidence packet ${args.task} for ${run.symbol}: ${run.run_id}`, recordAck(run)));
    return;
  }
  if (name === "finalize_visible_run") {
    const result = finalizeVisibleRun(args);
    sendResult(id, jsonContent(
      `Finalized visible AlphaCouncil Agent run as incomplete for ${result.run.symbol}: ${result.run.run_id}. Deliver user_response_markdown without replacing its final method-seat ledger.`,
      recordAck(result.run, {
        decision: result.decision,
        idempotent_replay: result.idempotent_replay === true,
        report_quality: result.report_quality?.status,
        missing_report_items: result.report_quality?.missing || [],
        handoff_contract: "inline_user_response_v1",
        user_response_markdown: result.user_response_markdown || "",
      }),
    ));
    return;
  }
  if (name === "record_visible_decision") {
    const result = recordVisibleDecision(args);
    sendResult(id, jsonContent(
      `Recorded visible decision ${args.role}${args.round ? ` round ${args.round}` : ""} for ${result.run.symbol}: ${result.run.run_id}`,
      // decision and opinion are small and are what a caller reads back; only the full
      // run object is dropped.
      recordAck(result.run, {
        decision: result.decision,
        idempotent_replay: result.idempotent_replay === true,
        report_quality: result.report_quality?.status,
        missing_report_items: result.report_quality?.missing || [],
        ...(args.role === "portfolio_manager" ? {
          handoff_contract: "inline_user_response_v1",
          user_response_markdown: result.user_response_markdown || "",
        } : {}),
      }),
    ));
    return;
  }
  if (name === "record_master_opinion") {
    const result = recordMasterOpinion(args);
    sendResult(id, jsonContent(
      `Recorded master opinion ${args.master} (${result.opinion.stance}) for ${result.run.symbol}: ${result.recorded}/${result.expected} master seats in.`,
      recordAck(result.run, { opinion: result.opinion, recorded: result.recorded, expected: result.expected }),
    ));
    return;
  }
  if (name === "record_verifier_verdict") {
    const result = recordVerifierVerdict(args);
    const seat = result.weights.seats.find((s) => s.seat === args.seat);
    sendResult(id, jsonContent(
      `Recorded ${args.verifier} -> ${args.verdict} for ${args.seat}. Effective weight now ${seat ? seat.effective_weight : "n/a"}.`,
      result,
    ));
    return;
  }
  if (name === "record_verifier_batch") {
    const result = recordVerifierBatch(args);
    sendResult(id, jsonContent(
      `Recorded ${args.verifier} batch for ${result.run.symbol}: ${result.recorded}/${result.expected} material claims; gate ${result.audit.status}.`,
      recordAck(result.run, {
        verifier: args.verifier,
        recorded: result.recorded,
        expected: result.expected,
        verifier_audit: result.audit,
        idempotent_replay: result.idempotent_replay === true,
      }),
    ));
    return;
  }
  if (name === "industry_brief") {
    const brief = industryBrief(args.industry);
    const lines = [
      `${brief.title.en} / ${brief.title.zh}: ${brief.participants.length} mapped participants across ${brief.layers.length} chain layers.`,
      `Screenable from SEC filings: ${brief.coverage.sec_screenable.join(", ") || "none"}.`,
      `Need a local regulator feed: ${brief.coverage.needs_local_regulator_feed.map((p) => `${p.symbol} (${p.market})`).join(", ") || "none"}.`,
    ];
    sendResult(id, jsonContent(lines.join("\n"), brief));
    return;
  }
  if (name === "market_financials") {
    const result = await fetchMarketFinancials(args.symbol, { corp_code: args.corp_code, year: args.year });
    let text;
    if (result.financials) {
      const f = result.financials;
      const rows = [
        ["Revenue", metricValue(f.revenue, f.currency)],
        ["Gross profit", metricValue(f.gross_profit, f.currency)],
        ["Operating income", metricValue(f.operating_income, f.currency)],
        ["Net income", metricValue(f.net_income, f.currency)],
        ["EPS", String(f.eps ?? "n/a")],
      ];
      text = [
        table(["Line", `Value (${f.unit})`], rows,
          { title: `${f.company_name} ${f.gregorian_year ?? ""}Q${f.period.quarter} -- ${f.source}` }),
        `\n${f.note}`,
      ].join("\n");
    } else {
      text = [
        `${args.symbol} (${result.market}, ${result.regulator}): no structured feed.`,
        result.guidance,
        result.fallback?.quote ? `Quote: ${result.fallback.quote.price}. ${result.fallback.caveat}` : "",
      ].filter(Boolean).join("\n");
    }
    sendResult(id, jsonContent(text, result));
    return;
  }
  if (name === "market_coverage") {
    const coverage = coverageFor(args.symbols || []);
    const rows = coverage.rows.map((r) => [r.symbol, r.market, r.regulator, r.structured_financials, r.needs_env || r.reason?.slice(0, 50) || "-"]);
    const text = [
      table(["Symbol", "Market", "Regulator", "Structured financials", "Blocker"], rows, { title: "Data coverage" }),
      `\n${coverage.note}`,
    ].join("\n");
    sendResult(id, jsonContent(text, coverage));
    return;
  }
  if (name === "compose_research_brief") {
    const grounding = await gatherGrounding({
      symbol: args.symbol, cik: args.cik, industry: args.industry,
      macro: args.macro !== false, asOf: args.as_of, language: resolveLanguage(args),
    });
    const block = groundingBlock(grounding, resolveLanguage(args));
    const facts = [
      grounding.instrument ? `instrument (${grounding.instrument.asset_type}/${grounding.instrument.research_model})` : null,
      grounding.quote ? "quote" : null,
      grounding.filer ? "filer profile" : null,
      grounding.screen ? `screen (${grounding.screen.rules_computed}/${grounding.screen.rules_total} rules)` : null,
      grounding.macro ? `macro (${grounding.macro.derived.length} readings)` : null,
      grounding.industry?.participants ? `industry (${grounding.industry.participants.length} participants)` : null,
    ].filter(Boolean);
    sendResult(id, jsonContent(
      groundingDashboard(grounding, resolveLanguage(args)),
      { grounding, prompt_block: block, facts_available: facts, dashboard: groundingDashboard(grounding, resolveLanguage(args)) },
    ));
    return;
  }
  if (name === "industry_coverage") {
    const coverage = industryCoverage(args.industry);
    sendResult(id, jsonContent(
      `"${args.industry}": curated map ${coverage.curated ? `yes (${coverage.curated.id})` : "no"}, SIC group ${coverage.sic_group ? `yes (${coverage.sic_group.id})` : "no"}. ${coverage.guidance}`,
      coverage,
    ));
    return;
  }
  if (name === "industry_peers") {
    const result = await peersBySic(args);
    sendResult(id, jsonContent(
      `${result.anchor.name}: SIC ${result.sic ?? "unknown"} (${result.sic_description ?? "-"})${result.group ? `, group ${result.group.id}` : ""}. ${result.peers.length} name-matched peers.`,
      result,
    ));
    return;
  }
  if (name === "list_industries") {
    const industries = listIndustries();
    sendResult(id, jsonContent(
      `${industries.length} curated industry map(s): ${industries.map((i) => i.id).join(", ")}. `
      + `Plus ${SIC_GROUPS.length} SIC groups covering every US filer -- use industry_coverage to see which applies.`,
      { curated: industries, sic_groups: SIC_GROUPS },
    ));
    return;
  }
  if (name === "screen_ticker") {
    const result = await screenTicker(args);
    const zh = /中文|chinese|zh/i.test(String(args.language || ""));
    const rows = result.rules.map((r) => (r.skipped
      ? [label(r.label, zh), zh ? "无法计算" : "not computable", "-", skippedMark(zh)]
      : [label(r.label, zh), metricValue(r.value, r.unit), threshold(r.threshold, r.direction, r.unit), mark(r.passed)]));
    const text = [
      table(["Rule", "Measured", "Threshold", "Result"], rows, { title: `${result.ticker}: ${result.verdict}` }),
      result.exemptions.length ? `\nExempted: ${result.exemptions.map((e) => `${e.rule} (${e.reason})`).join("; ")}` : "",
      result.skipped_count ? `\n${result.skipped_count} rule(s) not computable from filings and NOT treated as passes.` : "",
    ].filter(Boolean).join("\n");
    sendResult(id, jsonContent(text, result));
    return;
  }
  if (name === "screen_candidates") {
    const result = await screenBatch({ candidates: args.candidates, asOf: args.as_of });
    const rows = [
      ...result.survivors.map((s2) => [s2.ticker, "survives", `${s2.rules_computed}/${s2.rules_total} rules`, "-"]),
      ...result.eliminated.map((e) => [e.ticker, "**eliminated**", "-",
        e.reasons.map((r) => `${r.rule} ${metricValue(r.measured, r.unit)} vs ${r.threshold}`).join("; ")]),
      ...result.unavailable.map((u) => [u.ticker, "_unavailable_", "-", u.error?.slice(0, 60) ?? ""]),
    ];
    const text = [
      table(["Ticker", "Verdict", "Coverage", "Eliminated by"], rows,
        { title: `Screened ${result.screened}: ${result.survivors.length} survive, ${result.eliminated.length} eliminated` }),
      "\nSurviving is not a recommendation -- these rules eliminate, they never select.",
    ].join("\n");
    sendResult(id, jsonContent(text, result));
    return;
  }
  if (name === "list_us_universe") {
    const all = await fetchUniverse();
    const needle = String(args.contains || "").trim().toLowerCase();
    const matched = needle
      ? all.filter((c) => c.ticker.toLowerCase().includes(needle) || c.title.toLowerCase().includes(needle))
      : all;
    const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, args.limit)) : 50;
    sendResult(id, jsonContent(
      `${matched.length} of ${all.length} US filers matched${needle ? ` "${args.contains}"` : ""}; returning ${Math.min(limit, matched.length)}.`,
      { total: all.length, matched: matched.length, companies: matched.slice(0, limit) },
    ));
    return;
  }
  if (name === "preflight_permissions") {
    const result = preflightNetworkPermissions({ roster: args.roster || "default" });
    sendResult(id, jsonContent(`Network permission preflight: ${result.status}. ${result.message}`, result));
    return;
  }
  if (name === "get_macro_snapshot") {
    const data = await getMacroSnapshot(args);
    const total = data.blocks.reduce((sum, block) => sum + block.members.length, 0);
    sendResult(id, jsonContent(
      `Macro snapshot: ${total - data.unavailable.length}/${total} series, ${data.derived.filter((d) => d.available).length}/${data.derived.length} derived measures.`,
      data,
    ));
    return;
  }
  if (name === "get_options_chain") {
    const data = await fetchOptionsChain(args.symbol, { asOf: args.as_of });
    if (!data.available) {
      sendResult(id, jsonContent(`No options chain for ${data.symbol}: ${data.reason}`, data));
      return;
    }
    const ref = data.reference_expiry;
    sendResult(id, jsonContent(
      `${data.symbol} options: ${data.contracts_with_iv}/${data.contracts_total} contracts with usable IV, `
      + `reference ATM IV ${ref ? (ref.atm_iv * 100).toFixed(1) + "% at " + ref.dte + "d (" + ref.expiry + ")" : "unavailable"}, `
      + `put/call OI ${data.open_interest.put_call_ratio ?? "n/a"}. Delayed. `
      + (data.iv_history?.status === "available"
        ? `Local ${data.iv_history.observation_count}-session ATM-IV percentile ${data.iv_history.percentile}.`
        : `IV-percentile history building (${data.iv_history?.observation_count || 0}/${data.iv_history?.minimum_observations || 60}); no percentile yet.`),
      data,
    ));
    return;
  }
  if (name === "get_market_narrative") {
    const data = await getMarketNarrative(args || {});
    const lead = data.themes[0];
    sendResult(id, jsonContent(
      `Market narrative over ${data.window_days}d: ${data.headlines_in_window} headlines in window `
      + `(${data.excluded_outside_window} excluded as stale or undated). `
      + (lead ? `Leading theme: ${lead.label.en} at ${lead.share_of_coverage_pct}% of coverage. ` : "No theme matched. ")
      + `${data.unclassified_headlines} headlines matched no known theme.`,
      data,
    ));
    return;
  }
  if (name === "get_news") {
    const specs = [];
    if (args.symbol) specs.push(tickerNewsFeed(args.symbol));
    if (args.query) specs.push(queryNewsFeed(args.query));
    if (args.cik) specs.push(filingsFeed(args.cik, args.forms || "8-K"));
    if (!specs.length) throw invalidParams("get_news needs at least one of symbol, query or cik");
    const data = await fetchFeeds(specs, { days: args.days ?? 14, asOf: args.as_of ?? null });
    sendResult(id, jsonContent(
      `${data.items.length} headlines in the last ${args.days ?? 14}d from ${data.feeds.filter((f) => f.ok).length}/${data.feeds.length} feeds; `
      + `${data.excluded_outside_window} excluded as stale or undated.`,
      data,
    ));
    return;
  }
  if (name === "get_company_sources") {
    const data = await getCompanySourceMap({
      symbol: args.symbol,
      cik: args.cik,
      asOf: args.as_of,
    });
    sendResult(id, jsonContent(
      `Company starter pack for ${data.symbol}: identity resolved via ${data.identity_resolution.mode}, ${data.starter_evidence.filings.length} regulator filings, ${data.starter_evidence.issuer_documents.length} issuer documents, ${data.starter_evidence.news.length} dated cross-topic leads, and ${data.coverage_item_count} frozen coverage routes.`,
      data,
    ));
    return;
  }
  if (name === "get_social_pulse") {
    const data = await getSocialPulse(args || {});
    sendResult(id, jsonContent(
      `Social pulse for ${data.query ?? "(no query)"}: ${data.counts.reddit} Reddit, ${data.counts.hackernews} HN, `
      + `${data.counts.bluesky} Bluesky over ${data.window_days}d. No free X discovery exists, so professional `
      + `FinTwit is NOT covered. Mentions measure attention, not correctness.`,
      data,
    ));
    return;
  }
  if (name === "verify_x_post") {
    const data = await verifyXPost(args.id);
    sendResult(id, jsonContent(
      data.exists ? `Post ${data.id} exists: @${data.author ?? "unknown"} on ${(data.created_at || "").slice(0, 10)}.`
        : `Post ${data.id} could not be confirmed: ${data.reason}.`,
      data,
    ));
    return;
  }
  if (name === "list_council_options") {
    const data = councilOptions({ language: args.language || "English" });
    const zh = /中文|chinese|zh/i.test(String(args.language || ""));
    // Named seats, not three abstractions. A user choosing what to spend on should see who
    // is in the room; "standard, 32 seats" hides both the composition and the omissions --
    // it hid five masters that the preset never actually ran.
    const analystRows = data.analysts.map((a) => [
      a.id, a.title, a.in_default ? (zh ? "默认" : "default") : (zh ? "可选" : "optional"), a.covers || "-",
    ]);
    const masterRows = data.masters.map((m) => [
      String(m.index), m.title, m.identity, m.method, m.best_for,
      `${m.maturity} · ${m.pack_format} · ${m.admission_level}`,
    ]);
    const text = [
      table(
        zh ? ["席位", "职责", "是否默认", "覆盖"] : ["Seat", "Role", "In default", "Covers"],
        analystRows, { title: zh ? `分析师 — ${data.analysts.length} 位可选，默认 ${data.default_analysts.length} 位` : `Analysts — ${data.analysts.length} available, ${data.default_analysts.length} in the default fan-out`, zh },
      ),
      "",
      table(
        zh ? ["编号", "大师", "身份", "核心方法", "最适合", "成熟度"] : ["No.", "Master", "Identity", "Method", "Best for", "Maturity"],
        masterRows, { title: zh ? `逐席大师目录 - 共 ${data.all_masters_count} 位` : `Individual master catalog - ${data.all_masters_count} lenses`, zh },
      ),
      "",
      table(
        zh ? ["预设", "内容", "席位", "相对成本"] : ["Preset", "What runs", "Seats", "Relative cost"],
        data.presets.map((p) => [p.id, p.label, `${p.seats}`, `~${p.rough_minutes}`]),
        { title: zh ? "快捷预设（也可以自己点名）" : "Shortcuts — or name the seats yourself", zh },
      ),
      "",
      zh
        ? "这是只读浏览。真正开始每一次委员会运行时，仍必须打开一次新的选择会话、展示被冻结的逐席名单，并让用户提交 1 位、任意多位或全选。用户已点名时只做预选，不能跳过本次提交。"
        : "This is browse-only. Every actual council run still needs a fresh selection session, the frozen individual catalog displayed, and a submitted choice of one, any number, or all. Named masters may be preselected but do not skip submission.",
    ].join("\n");
    sendResult(id, jsonContent(text, data));
    return;
  }
  if (name === "get_quote") {
    const data = await getQuotes(args);
    const ok = data.quotes.filter((q) => !q.error).length;
    sendResult(id, jsonContent(`Fetched ${ok}/${data.quotes.length} delayed quotes`, data));
    return;
  }
  if (name === "collect_evidence") {
    const result = await withSelectedRun(args, "collect_evidence", async (runArgs) => {
      const run = runArgs.existing_run || await collectEvidence(runArgs);
      return jsonContent(
        `${runArgs.existing_run ? "Loaded" : "Saved"} ${run.packets.length} evidence packets for ${run.symbol}: ${run.run_id}`,
        { ...run, idempotent_replay: Boolean(runArgs.existing_run) },
      );
    });
    sendResult(id, result);
    return;
  }
  if (name === "analyze_symbol") {
    const runInBackground = args.wait_for_completion === false
      || (args.wait_for_completion === undefined && args.dry_run !== true);
    if (runInBackground) {
      const started = startBackgroundSelectedRun(args, "analyze_symbol", async (runArgs) => {
        if (runArgs.existing_run) return loadExistingAnalysis(runArgs.existing_run);
        return analyzeSymbol(runArgs);
      });
      if (started.terminal_result) {
        const replay = started.terminal_result;
        const fallback = `Loaded AlphaCouncil Agent analysis for ${replay.run.symbol}: ${replay.run.run_id}`;
        sendResult(id, jsonContent(terminalHandoffText(replay.run, fallback), replay));
        return;
      }
      const accepted = started;
      sendResult(id, jsonContent(
        `Accepted AlphaCouncil Agent analysis for ${accepted.symbol}: ${accepted.run_id}. Poll read_run until status is terminal.`,
        accepted,
      ));
      return;
    }
    const result = await withSelectedRun(args, "analyze_symbol", async (runArgs) => {
      return runArgs.existing_run ? loadExistingAnalysis(runArgs.existing_run) : await analyzeSymbol(runArgs);
    });
    const fallback = `${result.idempotent_replay ? "Loaded" : "Saved"} AlphaCouncil Agent analysis for ${result.run.symbol}: ${result.run.run_id}`;
    sendResult(id, jsonContent(terminalHandoffText(result.run, fallback), result));
    return;
  }
  if (name === "read_run") {
    const detail = readRunDetail(args.detail);
    const idArg = args.run_id;
    const dir = runPath(idArg);
    const evidencePath = join(dir, "evidence.json");
    // Keep the historical existence requirement without parsing a multi-megabyte evidence
    // body for the default compact poll. Old runs without status.json still fall back to it.
    if (!existsSync(evidencePath)) readJson(evidencePath);
    const decisionPath = join(dir, "decision.json");
    const decision = existsSync(decisionPath) ? readJson(decisionPath) : null;
    const allAgentsPath = join(dir, "all_agents.md");
    const finalReportPath = join(dir, "final_report.md");
    const userResponsePath = join(dir, "user_response.md");
    const statusPath = join(dir, "status.json");
    const eventsPath = join(dir, "events.jsonl");
    const sourceManifestPath = join(dir, "source_manifest.json");
    const reportQualityPath = join(dir, "report_quality.json");
    const status = existsSync(statusPath) ? readJson(statusPath) : null;
    const reportQuality = existsSync(reportQualityPath) ? readJson(reportQualityPath) : null;
    const eventLog = readJsonl(eventsPath);
    let evidence = null;
    if (detail === "full" || !status) evidence = readJson(evidencePath);
    const taskIds = (status?.tasks || [])
      .map((task) => typeof task === "string" ? task : task?.task)
      .filter((task) => typeof task === "string");
    const artifactRun = evidence || { run_id: idArg, tasks: taskIds };
    const artifacts = {
      ...artifactPaths(artifactRun),
      all_agents_md: allAgentsPath,
      final_report_md: finalReportPath,
      user_response_md: userResponsePath,
      source_manifest_json: sourceManifestPath,
      status_json: statusPath,
      events_jsonl: eventsPath,
    };
    const userResponse = existsSync(userResponsePath) ? readFileSync(userResponsePath, "utf8") : "";
    const runStatus = status?.status || evidence?.status;
    const text = isTerminalAnalysis(runStatus) && userResponse
      ? userResponse
      : `Loaded AlphaCouncil Agent run ${idArg}`;
    if (detail === "compact") {
      sendResult(id, jsonContent(text, {
        status,
        decision: compactDecision(decision),
        report_quality: reportQuality,
        artifacts,
        events_summary: compactEventSummary(eventLog),
        user_response_markdown: userResponse,
      }));
      return;
    }
    sendResult(id, jsonContent(text, {
      evidence,
      decision,
      source_manifest: existsSync(sourceManifestPath) ? readJson(sourceManifestPath) : sourceManifest(evidence),
      report_quality: reportQuality,
      status,
      events: eventLog.entries,
      events_parse_errors: eventLog.parse_errors,
      artifacts,
      all_agents_markdown: existsSync(allAgentsPath) ? readFileSync(allAgentsPath, "utf8") : "",
      final_report_markdown: existsSync(finalReportPath) ? readFileSync(finalReportPath, "utf8") : "",
      user_response_markdown: userResponse,
    }));
    return;
  }
  if (name === "council_diagnostics") {
    if (!Array.isArray(args.run_ids) || args.run_ids.length < 1 || args.run_ids.length > 50
      || new Set(args.run_ids).size !== args.run_ids.length) {
      throw invalidParams("run_ids must contain 1-50 unique saved run IDs.");
    }
    const minimumCases = args.minimum_cases === undefined ? 3 : args.minimum_cases;
    if (!Number.isInteger(minimumCases) || minimumCases < 3 || minimumCases > 100) {
      throw invalidParams("minimum_cases must be an integer from 3 through 100.");
    }
    const runs = args.run_ids.map((runIdValue) => readJson(join(runPath(runIdValue), "evidence.json")));
    const diagnostics = diagnoseCouncilRuns(runs, { minimumCases });
    const verdict = diagnostics.behavioral_differentiation.verdict || "insufficient repeated cases";
    sendResult(id, jsonContent(
      `Council diagnostics: ${runs.length} run(s); behavioural differentiation ${verdict}; error N_eff unpublished (${diagnostics.independence.reason}).`,
      diagnostics,
    ));
    return;
  }
  if (name === "compare_summary_modes") {
    const modes = summaryModes(resolveLanguage(args));
    sendResult(id, jsonContent(JSON.stringify(modes, null, 2), { modes }));
    return;
  }
  throw methodNotFound(`Unknown tool: ${name}`);
}

export async function handleRequest(message) {
  const { id, method, params } = message;
  if (startupFailure && id !== undefined) {
    sendError(id, RpcCode.INTERNAL_ERROR, `alphacouncil-agent cannot serve requests: ${startupFailure}`);
    return;
  }
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: VERSION },
      instructions: "Use AlphaCouncil Agent to coordinate public-equity research subagents, save shared evidence packets, and produce manager-style long/short decisions.",
    });
    return;
  }
  if (method === "ping") {
    sendResult(id, {});
    return;
  }
  if (method === "tools/list") {
    sendResult(id, { tools: tools() });
    return;
  }
  if (method === "tools/call") {
    try {
      await handleToolCall(id, params);
    } catch (error) {
      // Previously every throw became INVALID_PARAMS, so a missing run directory or a
      // failed fetch was reported to the host as a caller mistake.
      const rpc = toRpcError(error);
      sendError(id, rpc.code, rpc.message, rpc.data);
    }
    return;
  }
  if (id !== undefined) {
    sendError(id, RpcCode.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/**
 * Set when the persona set fails to load. Every request then answers with an actionable
 * error instead of the server appearing healthy and producing empty prompts later.
 */
let startupFailure = null;

export function startStdioServer() {
  // stdout is the JSON-RPC frame channel; diagnostics must never go there.
  process.on("uncaughtException", (error) => {
    process.stderr.write(`[alphacouncil] uncaught exception: ${error?.stack || error}\n`);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[alphacouncil] unhandled rejection: ${reason?.stack || reason}\n`);
  });
  sweepStaleOutputs();
  // Keep expired selection/receipt records and recoverable dead-owner leases bounded in
  // real server operation, not only in unit tests. Cleanup itself is conservative: active,
  // foreign-host, malformed and symlinked lock artifacts are never guessed safe to remove.
  try {
    cleanupSelectionStore();
  } catch (error) {
    // Maintenance must not corrupt the JSON-RPC frame channel. Subsequent selection calls
    // still enforce their own locks and fail closed if the store is unsafe.
    process.stderr.write(`[alphacouncil] selection cleanup skipped: ${error?.message || error}\n`);
  }
  try {
    recoverInterruptedBackgroundRuns();
  } catch (error) {
    process.stderr.write(`[alphacouncil] background run recovery skipped: ${error?.message || error}\n`);
  }
  // Load personas eagerly. Lazy loading made `initialize` succeed against a missing or
  // malformed persona set, so the host believed the server was healthy and only found
  // out several tool calls later.
  try {
    registry();
  } catch (error) {
    startupFailure = error.message;
    process.stderr.write(`[alphacouncil] ${error.message}\n`);
  }
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      // Answering is strictly better than the old silent `catch {}`: the host learns
      // its frame was rejected instead of waiting for a reply that never comes.
      sendError(null, RpcCode.PARSE_ERROR, `invalid JSON frame: ${error.message}`);
      return;
    }
    void handleRequest(message);
  });
}
