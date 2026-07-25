import { readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export const DATA_DIR = process.env.ALPHACOUNCIL_AGENT_DATA_DIR || join(os.homedir(), ".alphacouncil-agent");
export const RUNS_DIR = join(DATA_DIR, "runs");
export const SERVER_NAME = "alphacouncil-agent";
// Single source of truth for the version. Resolved from import.meta.url, never process.cwd(),
// because hosts launch this server from arbitrary working directories.
export const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
export const CODEX_CMD = process.env.ALPHACOUNCIL_AGENT_CODEX_CMD || "codex";
export const DEFAULT_TASKS = [
  "market_data",
  "earnings_deep_dive",
  "forward_expectations",
  "sell_side_revisions",
  "earnings_call_transcript",
  "quant_factor",
  "valuation_long_short",
  "news_industry_management",
  "management_industry_voices",
  "insider_sec",
  "ib_event_analysis",
];
export const RATINGS = ["Buy", "Overweight", "Hold", "Underweight", "Sell"];
export const DEBATE_ROLES = ["bull_researcher", "bear_researcher", "portfolio_manager"];
export const OUTPUT_MODES = [
  "chat",
  "documents",
  "pdf",
  "presentations",
  "data_analytics",
  "product_design",
  "creative_production",
  "public_equity",
  "investment_banking",
  "sales",
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
  { id: "conclusion", aliases: ["结论", "conclusion"], min_body: 6 },
  { id: "analyst_work_log", aliases: ["分析师工作记录", "analyst work log"], min_body: 12, per_task: true },
  { id: "debate_record", aliases: ["多空辩论记录", "bull bear debate", "debate record"], min_body: 20 },
  { id: "market_expectations", aliases: ["市场预期", "market expectations"], min_body: 8 },
  { id: "analyst_rating", aliases: ["分析师评级", "analyst rating", "target price"], min_body: 8 },
  { id: "earnings_call", aliases: ["电话会", "earnings call"], min_body: 8 },
  { id: "quant", aliases: ["量化", "quant"], min_body: 8 },
  { id: "news", aliases: ["新闻", "news"], min_body: 8 },
  { id: "short_interest", aliases: ["short interest", "borrow"], min_body: 8 },
  { id: "strategic_transaction", aliases: ["战略交易", "strategic transaction", "banking event"], min_body: 8 },
  { id: "valuation", aliases: ["估值", "valuation"], min_body: 8 },
  { id: "catalysts", aliases: ["催化剂", "catalyst"], min_body: 8 },
  { id: "risks", aliases: ["风险", "risk"], min_body: 8 },
  { id: "position", aliases: ["仓位", "position"], min_body: 8 },
  { id: "short_term", aliases: ["短线", "short term"], min_body: 6 },
  { id: "medium_term", aliases: ["中期", "medium term"], min_body: 6 },
  { id: "long_term", aliases: ["长期", "long term"], min_body: 6 },
  { id: "data_gaps", aliases: ["数据缺口", "data gaps", "unavailable data"], min_body: 8 },
  { id: "invalidation", aliases: ["反证", "invalidation"], min_body: 8 },
  { id: "confidence", aliases: ["置信", "confidence"], min_body: 3 },
  { id: "source_table", aliases: ["来源表", "source table"], min_body: 6 },
];

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
  CONCURRENCY_MIN: 1,
  CONCURRENCY_MAX: 6,
  CONCURRENCY_DEFAULT: Number(process.env.ALPHACOUNCIL_AGENT_CONCURRENCY) || 3,
  /** Minimum non-space characters before a final report is considered a real report. */
  REPORT_MIN_CHARS: 1600,
  REPORT_MIN_CHARS_DRY: 600,
  /** Timeout for one keyless quote fetch. */
  QUOTE_FETCH_MS: 8000,
  /** Cap on symbols per get_quote call. */
  QUOTE_MAX_SYMBOLS: 25,
  /** Age after which a leftover Codex output file is swept at startup. */
  STALE_OUTPUT_MS: 24 * 60 * 60 * 1000,
});
