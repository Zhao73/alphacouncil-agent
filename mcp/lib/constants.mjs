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
