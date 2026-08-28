import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import os from "node:os";

export const DATA_DIR = process.env.ALPHACOUNCIL_AGENT_DATA_DIR || join(os.homedir(), ".alphacouncil-agent");
export const RUNS_DIR = join(DATA_DIR, "runs");
export const SELECTIONS_DIR = join(DATA_DIR, "selections");
export const SERVER_NAME = "alphacouncil-agent";
// Single source of truth for the version. Resolved from import.meta.url, never process.cwd(),
// because hosts launch this server from arbitrary working directories.
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
export const CLAIM_READY_METHOD_VOICE_STATUS = "model_voice";

const RUNTIME_FINGERPRINT_FILES = Object.freeze([
  "package.json",
  "mcp/server.mjs",
  "mcp/generated/runtime-validators.mjs",
  "mcp/lib/codex.mjs",
  "mcp/lib/company-dossier.mjs",
  "mcp/lib/company-source-acquisition.mjs",
  "mcp/lib/constants.mjs",
  "mcp/lib/council-selection.mjs",
  "mcp/lib/grounding.mjs",
  "mcp/lib/manager-report.mjs",
  "mcp/lib/markdown.mjs",
  "mcp/lib/method-panel-recommendation.mjs",
  "mcp/lib/method-seat-evidence.mjs",
  "mcp/lib/method-vocabulary-contract.mjs",
  "mcp/lib/orchestrator.mjs",
  "mcp/lib/packets.mjs",
  "mcp/lib/prompts.mjs",
  "mcp/lib/runtime-validation.mjs",
  "mcp/lib/rpc.mjs",
  "mcp/lib/timing-ledger.mjs",
  "mcp/lib/timing-replay.mjs",
  "mcp/lib/verification.mjs",
  "scripts/export-run-bundle.mjs",
  "scripts/lib/run-bundle.mjs",
  "scripts/verify-run-bundle.mjs",
  "schemas/run-bundle-v1.schema.json",
  "schemas/timing-ledger-v1.schema.json",
  "schemas/runtime-evidence-packet-v1.schema.json",
  "schemas/runtime-headless-portfolio-manager-decision-v1.schema.json",
  "schemas/runtime-method-voice-v1.schema.json",
]);

function criticalRuntimeSourceHash() {
  const hash = createHash("sha256");
  for (const relativePath of RUNTIME_FINGERPRINT_FILES) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(join(PACKAGE_ROOT, relativePath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function gitRuntimeIdentity() {
  try {
    const options = { cwd: PACKAGE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
    const commit = execFileSync("git", ["rev-parse", "--verify", "HEAD"], options).trim();
    const trackedChanges = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=no"],
      options,
    ).trim();
    return {
      git_commit: /^[0-9a-f]{40}$/u.test(commit) ? commit : null,
      git_tracked_tree_dirty: trackedChanges.length > 0,
    };
  } catch {
    return { git_commit: null, git_tracked_tree_dirty: null };
  }
}

// Every saved run carries both the semantic package version and a hash of the critical
// executable/schema surface. A packaged plugin may not contain .git, so the source hash is
// mandatory while the commit is best-effort. This distinguishes "code edited" from a run
// actually produced by the installed bytes without requiring any external service or API.
export const RUNTIME_BUILD_IDENTITY = Object.freeze({
  contract_id: "alphacouncil_runtime_build_v1",
  package_version: VERSION,
  critical_source_sha256: criticalRuntimeSourceHash(),
  critical_source_files: [...RUNTIME_FINGERPRINT_FILES],
  ...gitRuntimeIdentity(),
});
export const CODEX_CMD = process.env.ALPHACOUNCIL_AGENT_CODEX_CMD || "codex";
// Eight roles, down from eleven. The three removed were merged rather than dropped:
// the earnings call is part of the earnings read, sell-side revisions are part of the
// forward-expectations read, and "industry voices" and "industry news" were searching the
// same ground. Fewer, wider roles means fewer duplicated searches for the same facts.
export const DEFAULT_TASKS = [
  "market_data",
  "earnings_deep_dive",
  "forward_expectations",
  "quant_factor",
  "valuation_long_short",
  "news_industry_management",
  "insider_sec",
  "ib_event_analysis",
];
// The three breadth seats are useful, but were previously reachable only through a caller-
// supplied `tasks` override. That made "all" ambiguous: a user could select every method
// while the run still launched only the eight default analysts. The selection receipt now
// binds one of two explicit analyst scopes, and the all scope always means these eleven seats.
export const OPTIONAL_ANALYST_TASKS = [
  "macro_regime",
  "market_narrative",
  "social_pulse",
];
export const ALL_ANALYST_TASKS = Object.freeze([
  ...DEFAULT_TASKS,
  ...OPTIONAL_ANALYST_TASKS,
]);
export const ANALYST_SCOPES = Object.freeze(["core", "all"]);
// The three `all`-scope seats that add context but own none of the operating-company dossier's
// 52 acquisition routes. They are breadth, not foundation, so both the packet layer and the
// completeness gate treat them differently from the eight mandatory core roles.
export const SUPPLEMENTAL_ANALYST_TASKS = Object.freeze(["macro_regime", "market_narrative", "social_pulse"]);
// A first-class bounded council for users who explicitly ask for a quick read. Keep this
// list independent of DEFAULT_TASKS ordering: the previous `slice(0, 4)` silently omitted
// company/industry news, which was the main thing many quick-read users asked for.
export const QUICK_TASKS = [
  "market_data",
  "earnings_deep_dive",
  "valuation_long_short",
  "news_industry_management",
];
export const COUNCIL_MODES = ["full", "quick"];
export const RATINGS = ["Buy", "Overweight", "Hold", "Underweight", "Sell"];
export const DEBATE_ROLES = ["bull_researcher", "bear_researcher", "portfolio_manager"];
export const MASTER_STANCES = ["constructive", "cautious", "opposed", "out_of_scope"];
export const TERMINAL_STATES = Object.freeze(["complete", "degraded", "incomplete"]);
export const PM_ABSENCE_REASONS = Object.freeze([
  "not_started_global_deadline",
  "skipped_upstream_gate",
  "failed",
]);
export const TERMINAL_REPORT_CONTRACTS = Object.freeze({
  quick: Object.freeze({ id: "quick_v1", debate_rounds_required: 1, full_council_equivalent: false }),
  full: Object.freeze({ id: "full_v2", debate_rounds_required: 3, full_council_equivalent: true }),
});
// product_design / creative_production / sales were removed: each described itself as
// "not for investment summary". Unknown values fall back to public_equity, so a host
// still passing an old name degrades cleanly instead of erroring.
export const OUTPUT_MODES = [
  "chat",
  "documents",
  "pdf",
  "presentations",
  "data_analytics",
  "public_equity",
  "investment_banking",
];
/**
 * The report contract, as a structured registry.
 *
 * `aliases` are matched against normalized headings; the LONGEST matching alias wins, so
 * a heading like "Quant Factor / Technical Risk View" is assigned to `quant` rather than
 * being allowed to satisfy `risks`. `min_body` is the number of non-space characters the
 * section body must carry, calibrated against the manager fallback report, which emits
 * several legitimately terse sections ("## Confidence\nmedium").
 */
/**
 * Anchors for the system-owned publication sections.
 *
 * The quality gate must never locate these by heading text. A PM-authored section is
 * relabelled rather than deleted, and several of those localized commentary titles legally
 * contain a section alias -- the Japanese label "PMによるメソッド席の説明" contains the
 * `master_bench` alias "メソッド席". Heading assignment keeps the richest body, so the
 * commentary could win the assignment and every per-seat coverage check would then fail
 * against PM prose, leaving the report permanently unpublishable in ja/ko.
 */
export const RECORDED_BENCH_MARKER_PREFIX = "alphacouncil:recorded-master-bench:v1:";
export const RECORDED_INSTRUMENT_MARKER_PREFIX = "alphacouncil:recorded-instrument-structure:v1:";
export const HANDOFF_METHOD_TAIL_MARKER = "alphacouncil:handoff-method-seat-tail:v1:begin";
export const HANDOFF_METHOD_TAIL_END_MARKER = "alphacouncil:handoff-method-seat-tail:v1:end";
export const HANDOFF_METHOD_SEAT_MARKER_PREFIX = "alphacouncil:handoff-method-seat:v1:";

export const REPORT_SECTIONS = [
  { id: "conclusion", aliases: ["结论", "conclusion", "結論", "결론"], min_body: 6 },
  { id: "analyst_work_log", aliases: ["分析师工作记录", "analyst work log", "アナリスト作業記録", "分析担当作業記録", "분석가 작업 기록"], min_body: 12, per_task: true },
  { id: "debate_record", aliases: ["多空辩论记录", "bull bear debate", "debate record", "強気弱気討論記録", "多空討論記録", "롱 숏 토론 기록", "강세 약세 토론 기록"], min_body: 20 },
  // Required only when a bench actually ran. A report that spends ten master seats and
  // then mentions none of them is the defect this entry exists to catch; a screen-only
  // run that never selected one must not be failed for omitting it.
  { id: "master_bench", aliases: ["大师席", "master席位", "master bench", "master lens", "マスターベンチ", "マスター・ベンチ", "メソッド席", "마스터 벤치", "방법론 좌석"], min_body: 20, when_masters: true },
  { id: "instrument_structure", aliases: ["基金与指数结构", "ETF与指数结构", "资产结构与穿透", "fund and index structure", "instrument structure and look through", "ETF index structure", "ファンドと指数の構造", "資産構造とルックスルー", "펀드와 지수 구조", "자산 구조 및 룩스루"], min_body: 40, when_fund_or_index: true },
  { id: "market_expectations", aliases: ["市场预期", "market expectations", "市場予想", "市場期待", "시장 기대"], min_body: 8 },
  { id: "analyst_rating", aliases: ["分析师评级", "analyst rating", "target price", "アナリスト評価", "目標株価", "애널리스트 등급", "목표가"], min_body: 8 },
  { id: "earnings_call", aliases: ["电话会", "earnings call", "決算説明会", "실적 발표 콜"], min_body: 8 },
  { id: "quant", aliases: ["量化", "quant", "クオンツ", "定量", "퀀트", "정량"], min_body: 8 },
  { id: "news", aliases: ["新闻", "news", "ニュース", "뉴스"], min_body: 8 },
  { id: "short_interest", aliases: ["short interest", "borrow", "空売り", "貸株", "공매도", "대차"], min_body: 8 },
  { id: "strategic_transaction", aliases: ["战略交易", "strategic transaction", "banking event", "戦略取引", "銀行イベント", "전략적 거래", "금융 이벤트"], min_body: 8 },
  { id: "valuation", aliases: ["估值", "valuation", "バリュエーション", "企業価値評価", "가치평가"], min_body: 8 },
  // Required, and deliberately not called "target price". A single number pretends to a
  // precision nobody has; what a reader needs is the price at which the case changes.
  // Three master lenses already demand this -- Marks asks at what price it stops being
  // "leave it", Graham asks for a calculable floor, Thorp asks for a size -- and the PM
  // used to be able to skip it with "the cycle position is undetermined".
  { id: "price_levels", aliases: ["价位", "入场价位", "price levels", "entry level", "价格条件", "価格条件", "エントリー価格", "가격 조건", "진입 가격"], min_body: 30 },
  { id: "catalysts", aliases: ["催化剂", "catalyst", "catalysts", "カタリスト", "材料", "촉매"], min_body: 8 },
  { id: "risks", aliases: ["风险", "risk", "risks", "リスク", "위험"], min_body: 8 },
  { id: "position", aliases: ["仓位", "position", "ポジション", "配分", "포지션"], min_body: 8 },
  { id: "short_term", aliases: ["短线", "short term", "短期", "단기"], min_body: 6 },
  { id: "medium_term", aliases: ["中期", "medium term", "중기"], min_body: 6 },
  { id: "long_term", aliases: ["长期", "long term", "長期", "장기"], min_body: 6 },
  { id: "data_gaps", aliases: ["数据缺口", "data gaps", "unavailable data", "データ欠落", "利用不可データ", "데이터 공백", "사용 불가 데이터"], min_body: 8 },
  { id: "invalidation", aliases: ["反证", "invalidation", "無効化条件", "反証条件", "무효화 조건", "반증 조건"], min_body: 8 },
  { id: "confidence", aliases: ["置信", "confidence", "信頼度", "신뢰도"], min_body: 3 },
  { id: "source_table", aliases: ["来源表", "source table", "出典表", "ソース表", "출처 표"], min_body: 6 },
];

// Quick reports are deliberately a different publication scope. Requiring the full
// 23-section memo would force the short PM call to regenerate the same long report that
// the quick path exists to avoid. The quality result records this scope explicitly.
const QUICK_REPORT_SECTION_IDS = new Set([
  "conclusion",
  "analyst_work_log",
  "debate_record",
  "master_bench",
  "instrument_structure",
  "earnings_call",
  "news",
  "valuation",
  "price_levels",
  "risks",
  "position",
  "data_gaps",
  "confidence",
  "source_table",
]);
export const QUICK_REPORT_SECTIONS = REPORT_SECTIONS.filter(({ id }) => QUICK_REPORT_SECTION_IDS.has(id));

/** Bodies that look like a section but say nothing. */
export const PLACEHOLDER_BODIES = [
  "", "-", "n/a", "na", "tbd", "todo", "none", "- none", "待补充", "- 待补充", "无", "- 无",
];

/** @deprecated Superseded by REPORT_SECTIONS; kept only for external readers. */
export const REPORT_SECTION_TERMS = [
  ["结论", "Conclusion"],
  ["分析师工作记录", "Analyst Work Log"],
  ["多空辩论记录", "Bull/Bear Debate"],
  ["市场预期", "Market Expectations"],
  ["分析师评级", "Analyst Rating"],
  ["电话会", "Earnings Call"],
  ["量化", "Quant"],
  ["新闻", "News"],
  ["short interest", "Short Interest"],
  ["战略交易", "Strategic Transaction"],
  ["估值", "Valuation"],
  ["催化剂", "Catalyst"],
  ["风险", "Risk"],
  ["仓位", "Position"],
  ["短线", "Short-Term"],
  ["中期", "Medium-Term"],
  ["长期", "Long-Term"],
  ["数据缺口", "Data Gaps"],
  ["反证", "Invalidation"],
  ["置信", "Confidence"],
  ["来源表", "Source Table"],
];

/**
 * Every tunable that used to be a bare number inline. Frozen so a typo is a TypeError
 * in strict mode rather than a silent global retune.
 */
export const LIMITS = Object.freeze({
  /** Rolling cap on captured child stdout/stderr. */
  LOG_TAIL_BYTES: 20000,
  /** Cap applied when a log is cleaned for display or storage. */
  CLEAN_LOG_BYTES: 4000,
  /** Cap for one-line summaries in handoffs and fallback reports. */
  CLIP_CHARS: 520,
  /** How often a long-running Codex child reports that it is still alive. */
  HEARTBEAT_MS: 30000,
  /** Grace period between SIGTERM and SIGKILL for a timed-out child. */
  SIGKILL_GRACE_MS: 5000,
  /**
   * Non-overridable public ceiling for a plugin-managed full council: the slowest pace's
   * budget. The ceiling a given call is actually held to is its pace's `total_ms`, which is
   * lower for `fast` and `normal`; this is only the outer bound of the schema.
   */
  FULL_HARD_MAX_MS: 60 * 60 * 1000,
  /**
   * An operator cap on the full-council budget, or null when unset.
   *
   * This used to double as the default budget with a hard 30-minute clamp, which silently held
   * the 60-minute pace to 30. The default now comes from the selected pace; this only ever
   * lowers it, which is what "operators may only lower it" was always meant to say.
   */
  FULL_TOTAL_OVERRIDE_MS: Number.isFinite(Number(process.env.ALPHACOUNCIL_FULL_TOTAL_MS))
    && Number(process.env.ALPHACOUNCIL_FULL_TOTAL_MS) > 0
    ? Math.max(1_000, Number(process.env.ALPHACOUNCIL_FULL_TOTAL_MS))
    : null,
  /** Fallback budget for a code path that has no run budget to read. Not a ceiling. */
  FULL_TOTAL_MS: Math.max(1_000, Math.min(
    Number(process.env.ALPHACOUNCIL_FULL_TOTAL_MS) || 30 * 60 * 1000,
    60 * 60 * 1000,
  )),
  /** Deterministic grounding is useful, but it may not hold the whole run hostage. */
  FULL_GROUNDING_MS: 30 * 1000,
  // Grounding settles at its own budget and returns a partial result. This is only the
  // backstop for a call that never returns at all, so it sits just beyond the budget.
  GROUNDING_SETTLE_HEADROOM_MS: 5 * 1000,
  /** All selected full evidence seats (eight core or eleven all-scope) launch in one wave. */
  FULL_EVIDENCE_MS: Math.max(1_000, Math.min(
    Number(process.env.ALPHACOUNCIL_FULL_EVIDENCE_MS) || 6 * 60 * 1000,
    6 * 60 * 1000,
  )),
  /** Every selected method gets one isolated explanation worker after its decision freezes. */
  FULL_MASTER_MS: Math.max(1_000, Math.min(
    Number(process.env.ALPHACOUNCIL_FULL_MASTER_MS) || 2 * 60 * 1000,
    2 * 60 * 1000,
  )),
  /** Three verifier roles run concurrently; the cap is per verifier, not per claim. */
  FULL_VERIFIER_MS: Math.max(1_000, Math.min(
    Number(process.env.ALPHACOUNCIL_FULL_VERIFIER_MS) || 10 * 60 * 1000,
    10 * 60 * 1000,
  )),
  /** Bull and bear run together inside each of the three full-council rounds. */
  FULL_DEBATE_MS: Math.max(1_000, Math.min(
    Number(process.env.ALPHACOUNCIL_FULL_DEBATE_MS) || 150 * 1000,
    150 * 1000,
  )),
  /** The PM is the final model call and receives its own bounded slice. */
  FULL_PM_MS: Math.max(1_000, Math.min(
    Number(process.env.ALPHACOUNCIL_FULL_PM_MS) || 180 * 1000,
    180 * 1000,
  )),
  /** Reserved for forced child settlement, deterministic assembly and atomic persistence. */
  FULL_FINALIZE_RESERVE_MS: 45 * 1000,
  /** Absolute ceiling for one no-search transport/schema repair; the stage helper usually lowers it. */
  PARSE_REPAIR_MS: 4 * 60 * 1000,
  /** A repair may consume at most this fraction of its pace-specific stage budget. */
  PARSE_REPAIR_STAGE_FRACTION: 2 / 3,
  PARSE_REPAIR_INPUT_CHARS: 80 * 1000,
  // Eleven is the complete analyst roster. Keeping the whole roster in one wave preserves the
  // pace budget when analyst_scope=all instead of quietly turning three optional seats into a
  // second twelve-minute wave.
  FULL_EVIDENCE_CONCURRENCY: 11,
  FULL_MASTER_CONCURRENCY: 13,
  FULL_VERIFIER_CONCURRENCY: 3,
  /** Each verifier processes bounded claim chunks in parallel so six real chunks fit the slow-stage cap. */
  FULL_VERIFIER_CHUNK_CONCURRENCY: 3,
  /** Bound one verifier response so an all-scope claim ledger cannot overflow JSON transport. */
  FULL_VERIFIER_CLAIMS_PER_BATCH: 20,
  /** Fidelity opens every cited URL; smaller chunks reduce missed-source attention failures. */
  FULL_SOURCE_FIDELITY_CLAIMS_PER_BATCH: 10,
  /** Also bound per-claim URL obligations; repeated URLs across claims still require separate result coverage. */
  FULL_SOURCE_FIDELITY_URLS_PER_BATCH: 12,
  /** URL-weighted fidelity chunks run in bounded parallel waves inside the verifier-stage ceiling. */
  FULL_SOURCE_FIDELITY_CHUNK_CONCURRENCY: 6,
  /** Non-overridable public ceiling for a quick council, including retries and synthesis. */
  QUICK_HARD_MAX_MS: 10 * 60 * 1000,
  /** Default quick budget. Operators may lower it for stricter environments, never raise it. */
  QUICK_TOTAL_MS: Math.max(1_000, Math.min(
    Number(process.env.ALPHACOUNCIL_QUICK_TOTAL_MS) || 10 * 60 * 1000,
    10 * 60 * 1000,
  )),
  /** Maximum time quick mode waits for deterministic grounding before recording a gap. */
  QUICK_GROUNDING_MS: 20 * 1000,
  /** Per evidence worker cap; all four evidence roles launch in one wave. */
  QUICK_EVIDENCE_MS: Math.max(1_000, Math.min(
    Number(process.env.ALPHACOUNCIL_QUICK_EVIDENCE_MS) || 210 * 1000,
    210 * 1000,
  )),
  /** Per method-seat cap; all selected quick seats launch in one wave. */
  QUICK_MASTER_MS: Math.max(1_000, Math.min(
    Number(process.env.ALPHACOUNCIL_QUICK_MASTER_MS) || 90 * 1000,
    90 * 1000,
  )),
  /** Per quick bull/bear or PM call cap inside the global quick budget. */
  QUICK_SYNTHESIS_MS: Math.max(1_000, Math.min(
    Number(process.env.ALPHACOUNCIL_QUICK_SYNTHESIS_MS) || 90 * 1000,
    90 * 1000,
  )),
  /** Time reserved for deterministic fallback, report assembly and atomic persistence. */
  QUICK_FINALIZE_RESERVE_MS: 20 * 1000,
  /** Below this evidence coverage, a quick run is incomplete rather than degraded. */
  QUICK_MIN_SUCCESSFUL_TASKS: Math.max(1, Math.min(
    QUICK_TASKS.length,
    Math.trunc(Number(process.env.ALPHACOUNCIL_QUICK_MIN_SUCCESSFUL_TASKS) || 2),
  )),
  CONCURRENCY_MIN: 1,
  CONCURRENCY_MAX: 26,
  CONCURRENCY_DEFAULT: Number(process.env.ALPHACOUNCIL_AGENT_CONCURRENCY) || 8,
  /** A selection is deliberately short-lived and may create exactly one council run. */
  SELECTION_TTL_MS: Number(process.env.ALPHACOUNCIL_SELECTION_TTL_MS) || 60 * 60 * 1000,
  /** Selection lock metadata advertises this lease, but a live owner is never pre-empted. */
  SELECTION_LOCK_LEASE_MS: 2 * 60 * 1000,
  /** A same-host dead PID must remain dead for this minimum lock age before recovery. */
  SELECTION_LOCK_DEAD_GRACE_MS: 5 * 1000,
  /** Keep expired selection/receipt records briefly so callers receive an expiry reason. */
  SELECTION_EXPIRED_RETENTION_MS: 24 * 60 * 60 * 1000,
  /** Bound one cleanup pass; a corrupt directory cannot turn begin-selection into a sweep. */
  SELECTION_CLEANUP_MAX_FILES: 2000,
  /** Minimum non-space characters before a final report is considered a real report. */
  REPORT_MIN_CHARS: 1600,
  REPORT_MIN_CHARS_DRY: 600,
  REPORT_MIN_CHARS_QUICK: 700,
  /** Timeout for one keyless quote fetch. */
  QUOTE_FETCH_MS: 8000,
  /** Cap on symbols per get_quote call. */
  QUOTE_MAX_SYMBOLS: 25,
  /** Age after which a leftover Codex output file is swept at startup. */
  STALE_OUTPUT_MS: 24 * 60 * 60 * 1000,
});

/**
 * Full-council pace profiles.
 *
 * A total budget alone does not change how deep an analysis goes. What bounds each worker is
 * its per-stage cap, so raising only the total leaves a 60-minute run finishing in twenty
 * minutes with forty idle, and lowering only the total starves the later stages and terminates
 * `incomplete` with the debate missing. Each pace therefore carries a complete, self-consistent
 * set of caps, and `COUNCIL_PACE_STAGE_TOTAL` proves the stages fit inside the total.
 *
 * Bull and bear run together inside a round, so three rounds cost `3 * debate_ms`, not six.
 *
 * `slow` is where additional configured depth comes from: six minutes per side per round
 * instead of three, and twelve minutes per evidence seat instead of six.
 */
export const COUNCIL_PACES = Object.freeze({
  // `fast` is a configured fifteen-minute ceiling with a 14m20s stage allocation.
  // It is not a measured completion claim: observed completion remains unvalidated until a
  // representative host run produces a timing ledger that passes the terminal contract.
  fast: Object.freeze({
    pace: "fast",
    total_ms: 15 * 60 * 1000,
    grounding_ms: 20 * 1000,
    evidence_ms: 240 * 1000,
    // Semantic acquisition-ledger repair is no-search but commonly needed after an otherwise
    // complete evidence packet. Keep this inside the 240-second seat lifecycle rather than
    // handing a late packet whatever few milliseconds happen to remain.
    evidence_repair_reserve_ms: 20 * 1000,
    // Live Work-gateway runs completed 25/26 voices, but one silent worker consumed the old
    // primary window and then received a cold retry too short to finish. Give one primary the
    // complete two-minute lifecycle instead; a successful primary may still use whatever time
    // remains for format repair. The two-wave serial worst case stays inside the 15-minute total.
    master_ms: 120 * 1000,
    master_repair_reserve_ms: 0,
    master_waves: 2,
    verifier_ms: 0,
    debate_ms: 85 * 1000,
    debate_repair_reserve_ms: 15 * 1000,
    pm_ms: 90 * 1000,
    pm_repair_reserve_ms: 15 * 1000,
    finalize_reserve_ms: 15 * 1000,
  }),
  // `normal` is a thirty-minute ceiling with a twenty-five-minute configured stage allocation.
  // The three-minute debate cap leaves `slow` at twice the per-round allowance.
  normal: Object.freeze({
    pace: "normal",
    total_ms: 30 * 60 * 1000,
    grounding_ms: 30 * 1000,
    evidence_ms: 6 * 60 * 1000,
    evidence_repair_reserve_ms: 0,
    master_ms: 3 * 60 * 1000,
    master_repair_reserve_ms: 0,
    master_waves: 2,
    verifier_ms: 0,
    debate_ms: 180 * 1000,
    debate_repair_reserve_ms: 0,
    pm_ms: 180 * 1000,
    pm_repair_reserve_ms: 0,
    finalize_reserve_ms: 45 * 1000,
  }),
  slow: Object.freeze({
    pace: "slow",
    total_ms: 60 * 60 * 1000,
    grounding_ms: 45 * 1000,
    evidence_ms: 12 * 60 * 1000,
    evidence_repair_reserve_ms: 0,
    // Leaves at least 90s of total scheduling headroom while reserving a short final
    // language-only repair after the normal worker and transport repair.
    master_ms: (4 * 60 * 1000) + 15 * 1000,
    master_repair_reserve_ms: 0,
    master_waves: 2,
    // `slow + all methods + all analysts` spends this bounded stage on all three verifier
    // roles. The workers run in parallel, so the stage costs one cap rather than three.
    verifier_ms: 10 * 60 * 1000,
    debate_ms: 6 * 60 * 1000,
    debate_repair_reserve_ms: 0,
    pm_ms: 8 * 60 * 1000,
    pm_repair_reserve_ms: 0,
    finalize_reserve_ms: 60 * 1000,
  }),
});

export const DEFAULT_COUNCIL_PACE = "normal";
export const COUNCIL_PACE_NAMES = Object.freeze(Object.keys(COUNCIL_PACES));

/** Serial worst case for one full council at a pace: grounding, evidence wave, method wave, three debate rounds, PM, persistence. */
export const COUNCIL_PACE_STAGE_TOTAL = (profile) => profile.grounding_ms
  + profile.evidence_ms
  + (profile.master_ms * (profile.master_waves || 1))
  + (profile.verifier_ms || 0)
  + (3 * profile.debate_ms)
  + profile.pm_ms
  + profile.finalize_reserve_ms;

/** The pace a call runs at. An unknown or absent name is the default, never an error. */
export function councilPaceProfile(name) {
  return COUNCIL_PACES[String(name || "").toLowerCase()] || COUNCIL_PACES[DEFAULT_COUNCIL_PACE];
}
