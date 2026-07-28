import { readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export const DATA_DIR = process.env.ALPHACOUNCIL_AGENT_DATA_DIR || join(os.homedir(), ".alphacouncil-agent");
export const RUNS_DIR = join(DATA_DIR, "runs");
export const SELECTIONS_DIR = join(DATA_DIR, "selections");
export const SERVER_NAME = "alphacouncil-agent";
// Single source of truth for the version. Resolved from import.meta.url, never process.cwd(),
// because hosts launch this server from arbitrary working directories.
export const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
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
export const REPORT_SECTIONS = [
  { id: "conclusion", aliases: ["结论", "conclusion", "結論", "결론"], min_body: 6 },
  { id: "analyst_work_log", aliases: ["分析师工作记录", "analyst work log", "アナリスト作業記録", "分析担当作業記録", "분석가 작업 기록"], min_body: 12, per_task: true },
  { id: "debate_record", aliases: ["多空辩论记录", "bull bear debate", "debate record", "強気弱気討論記録", "多空討論記録", "롱 숏 토론 기록", "강세 약세 토론 기록"], min_body: 20 },
  // Required only when a bench actually ran. A report that spends ten master seats and
  // then mentions none of them is the defect this entry exists to catch; a screen-only
  // run that never selected one must not be failed for omitting it.
  { id: "master_bench", aliases: ["大师席", "master席位", "master bench", "master lens", "マスターベンチ", "メソッド席", "마스터 벤치", "방법론 좌석"], min_body: 20, when_masters: true },
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
  /** Default per-subagent Codex timeout. */
  CODEX_TIMEOUT_MS: Number(process.env.ALPHACOUNCIL_AGENT_TIMEOUT_MS) || 600000,
  /** Non-overridable public ceiling for a plugin-managed full council. */
  FULL_HARD_MAX_MS: 30 * 60 * 1000,
  /** Default full-council queue-to-persistence budget. Operators may only lower it. */
  FULL_TOTAL_MS: Math.max(1_000, Math.min(
    Number(process.env.ALPHACOUNCIL_FULL_TOTAL_MS) || 30 * 60 * 1000,
    30 * 60 * 1000,
  )),
  /** Deterministic grounding is useful, but it may not hold the whole run hostage. */
  FULL_GROUNDING_MS: 30 * 1000,
  /** All eight full evidence seats launch in one wave under this per-seat cap. */
  FULL_EVIDENCE_MS: Math.max(1_000, Math.min(
    Number(process.env.ALPHACOUNCIL_FULL_EVIDENCE_MS) || 6 * 60 * 1000,
    6 * 60 * 1000,
  )),
  /** Every selected method gets one isolated explanation worker after its decision freezes. */
  FULL_MASTER_MS: Math.max(1_000, Math.min(
    Number(process.env.ALPHACOUNCIL_FULL_MASTER_MS) || 2 * 60 * 1000,
    2 * 60 * 1000,
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
  /** A malformed response gets one short, no-search transport-only repair. */
  PARSE_REPAIR_MS: 30 * 1000,
  PARSE_REPAIR_INPUT_CHARS: 80 * 1000,
  FULL_EVIDENCE_CONCURRENCY: 8,
  FULL_MASTER_CONCURRENCY: 13,
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
