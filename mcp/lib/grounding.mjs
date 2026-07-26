import { fetchQuote } from "./quotes.mjs";
import { getMacroSnapshot } from "./macro.mjs";
import { screenTicker } from "./screen.mjs";
import { resolveIndustry, industryCoverage } from "./industry.mjs";
import { fetchSubmissions } from "./sec.mjs";
import { fetchMarketFinancials, coverageFor, marketFor } from "./markets.mjs";

/**
 * Hard facts, assembled before any analyst starts searching.
 *
 * The gap this closes: the tools already knew Micron's filed cash flow and the current
 * 10-year yield, and the analysts did not. Each one went off and searched from nothing,
 * free to report a number from a news summary that contradicts the filing without anyone
 * noticing. Grounding puts the deterministic facts in the prompt first and changes what
 * the search is FOR -- from producing numbers to explaining and challenging numbers that
 * are already established.
 *
 * The discipline that makes this work rather than just adding context: a searched number
 * never silently overwrites a filed one. A contradiction is reported as a contradiction.
 */

async function safely(label, fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    // A gap stays a visible gap. Grounding that silently omits a failed source would be
    // worse than no grounding, because the prompt would look complete.
    return { ok: false, error: `${label}: ${String(error?.message || error)}` };
  }
}

/**
 * @param {object} options
 * @param {string} [options.symbol]   exchange ticker, for the quote
 * @param {string} [options.cik]      SEC CIK, for filings and the screen
 * @param {string} [options.industry] industry query, for the chain map
 * @param {boolean} [options.macro]   include the macro snapshot
 * @param {string} [options.asOf]     only use filings filed by this date
 */
export async function gatherGrounding({ symbol, cik, industry, macro = true, asOf = null } = {}) {
  const jobs = [];
  const out = { as_of: asOf, gathered_at: new Date().toISOString(), unavailable: [] };

  if (symbol) {
    jobs.push(safely("quote", () => fetchQuote(symbol)).then((r) => {
      if (r.ok && !r.value?.error) out.quote = r.value;
      else out.unavailable.push(r.ok ? `quote: ${r.value.error}` : r.error);
    }));
  }

  if (cik) {
    jobs.push(safely("filer profile", () => fetchSubmissions(cik)).then((r) => {
      if (r.ok) out.filer = r.value;
      else out.unavailable.push(r.error);
    }));
    jobs.push(safely("screen", () => screenTicker({ cik, ticker: symbol, asOf })).then((r) => {
      if (!r.ok) { out.unavailable.push(r.error); return; }
      const s = r.value;
      out.screen = {
        verdict: s.verdict,
        rules_computed: s.evaluated_count,
        rules_total: s.rules.length,
        // Only the computed rules: a skipped rule is not a fact about the company.
        metrics: s.rules.filter((x) => !x.skipped).map((x) => ({
          rule: x.id, label: x.label, value: x.value, unit: x.unit, threshold: x.threshold, passed: x.passed,
        })),
        failures: s.failures.map((f) => ({ rule: f.id, value: f.value, unit: f.unit, threshold: f.threshold })),
        exemptions: s.exemptions,
        skipped: s.rules.filter((x) => x.skipped).map((x) => x.id),
      };
    }));
  }

  if (macro) {
    jobs.push(safely("macro", () => getMacroSnapshot({ blocks: ["rates", "dollar_liquidity", "commodities"] })).then((r) => {
      if (!r.ok) { out.unavailable.push(r.error); return; }
      out.macro = {
        derived: r.value.derived.filter((d) => d.available).map((d) => ({ id: d.id, label: d.label, value: d.value })),
        unavailable: r.value.unavailable,
      };
    }));
  }

  // Non-US symbols never reach the SEC path, so without this they arrived at the analyst
  // with nothing but a price.
  if (symbol && marketFor(symbol)?.id !== "US") {
    jobs.push(safely("market financials", () => fetchMarketFinancials(symbol)).then((r) => {
      if (!r.ok) { out.unavailable.push(r.error); return; }
      out.market = r.value;
      if (!r.value.financials) out.unavailable.push(`structured financials for ${symbol}: ${r.value.guidance}`);
    }));
  }

  if (industry) {
    const curated = resolveIndustry(industry);
    out.industry = {
      query: industry,
      coverage: industryCoverage(industry),
      ...(curated
        ? {
          id: curated.id,
          title: curated.title,
          participants: curated.layers.flatMap((l) => l.participants.map((p) => ({ ...p, layer: l.layer }))),
          demand_drivers: curated.demand_drivers,
          key_questions: curated.key_questions,
          cyclicality: curated.cyclicality,
        }
        : {}),
    };
  }

  await Promise.all(jobs);

  // Coverage across every symbol in play, so a report cannot quietly become US-only.
  const inPlay = [symbol, ...(out.industry?.participants || []).map((p) => p.symbol)].filter(Boolean);
  if (inPlay.length) out.coverage = coverageFor([...new Set(inPlay)]);
  return out;
}

const fmt = (value, unit) => {
  if (value === null || value === undefined) return "n/a";
  if (unit === "%") return `${value}%`;
  if (unit === "USD") return Math.abs(value) >= 1e9 ? `$${(value / 1e9).toFixed(2)}bn` : `$${value.toLocaleString("en-US")}`;
  return unit ? `${value} ${unit}` : String(value);
};

/**
 * Render grounding as a prompt block.
 *
 * The instructions are the substance here. Facts alone would just be more context for a
 * model to paraphrase; what changes behaviour is telling it what these facts are FOR and
 * what it may not do with them.
 */
export function groundingBlock(grounding, language = "English") {
  const chinese = /中文|chinese|zh/i.test(String(language));
  if (!grounding || (!grounding.quote && !grounding.screen && !grounding.macro && !grounding.industry)) return "";

  const lines = [];
  const head = chinese
    ? "## 已确立的事实（来自申报原文与交易所数据，不是你的记忆）"
    : "## Established facts (from filings and exchange data, not from your memory)";
  lines.push(head);

  if (grounding.filer) {
    lines.push(chinese
      ? `- 主体：${grounding.filer.name}｜SIC ${grounding.filer.sic ?? "未知"}（${grounding.filer.sic_description ?? "-"}）｜交易所 ${grounding.filer.exchanges.join(", ") || "未知"}`
      : `- Filer: ${grounding.filer.name} | SIC ${grounding.filer.sic ?? "unknown"} (${grounding.filer.sic_description ?? "-"}) | exchange ${grounding.filer.exchanges.join(", ") || "unknown"}`);
  }
  if (grounding.quote) {
    const q = grounding.quote;
    lines.push(chinese
      ? `- 行情（延迟约15分钟，${q.source}）：${q.symbol} ${q.price}${q.currency ? " " + q.currency : ""}${q.change_pct != null ? `，${q.change_pct > 0 ? "+" : ""}${q.change_pct}%` : ""}`
      : `- Quote (~15m delayed, ${q.source}): ${q.symbol} ${q.price}${q.currency ? " " + q.currency : ""}${q.change_pct != null ? `, ${q.change_pct > 0 ? "+" : ""}${q.change_pct}%` : ""}`);
  }
  if (grounding.screen) {
    const s = grounding.screen;
    lines.push(chinese
      ? `- 硬指标筛选：${s.verdict === "survives" ? "通过" : "淘汰"}（${s.rules_computed}/${s.rules_total} 条可算）`
      : `- Mechanical screen: ${s.verdict} (${s.rules_computed} of ${s.rules_total} rules computable)`);
    for (const m of s.metrics) {
      lines.push(`  - ${m.label}: ${fmt(m.value, m.unit)} (threshold ${m.threshold}) ${m.passed ? "pass" : "FAIL"}`);
    }
    if (s.skipped.length) {
      lines.push(chinese
        ? `  - 无法从申报计算，未按通过处理：${s.skipped.join(", ")}`
        : `  - Not computable from filings and NOT treated as passes: ${s.skipped.join(", ")}`);
    }
  }
  if (grounding.macro?.derived?.length) {
    lines.push(chinese ? "- 宏观读数：" : "- Macro readings:");
    for (const d of grounding.macro.derived) lines.push(`  - ${d.label}: ${d.value}`);
  }
  if (grounding.market?.financials) {
    const f = grounding.market.financials;
    lines.push(chinese
      ? `- ${f.source} 申报（${f.gregorian_year ?? f.period.year}Q${f.period.quarter}，${f.currency} ${f.unit}）：营收 ${f.revenue?.toLocaleString() ?? "n/a"}｜毛利 ${f.gross_profit?.toLocaleString() ?? "n/a"}｜营业利益 ${f.operating_income?.toLocaleString() ?? "n/a"}｜EPS ${f.eps ?? "n/a"}`
      : `- ${f.source} filing (${f.gregorian_year ?? f.period.year}Q${f.period.quarter}, ${f.currency} ${f.unit}): revenue ${f.revenue?.toLocaleString() ?? "n/a"} | gross profit ${f.gross_profit?.toLocaleString() ?? "n/a"} | operating income ${f.operating_income?.toLocaleString() ?? "n/a"} | EPS ${f.eps ?? "n/a"}`);
  }
  if (grounding.coverage?.rows?.length) {
    const none = grounding.coverage.rows.filter((r) => r.structured_financials === "no").map((r) => r.symbol);
    if (none.length) {
      lines.push(chinese
        ? `- 以下标的没有结构化财务源，任何关于它们的财务数字必须来自你读到的原始文件并注明出处：${none.join("、")}`
        : `- No structured financial feed for: ${none.join(", ")}. Any financial figure for these must come from a primary document you actually read, and be cited as such.`);
    }
  }
  if (grounding.industry?.participants?.length) {
    const names = grounding.industry.participants.map((p) => `${p.name}${p.symbol ? ` (${p.symbol})` : " (unlisted)"}`);
    lines.push(chinese
      ? `- 产业链参与者（含非美，名单为人工维护）：${names.join("、")}`
      : `- Value-chain participants (includes non-US; list is hand-maintained): ${names.join(", ")}`);
  }
  if (grounding.unavailable?.length) {
    lines.push(chinese ? `- 取不到的数据（属于数据缺口，禁止用记忆补）：${grounding.unavailable.join("；")}`
      : `- Could not be retrieved -- these are data gaps and must NOT be filled from memory: ${grounding.unavailable.join("; ")}`);
  }

  lines.push("");
  lines.push(chinese
    ? [
      "**这些事实改变你搜索的目的。** 它们已经确立，不需要你再去找一遍。你联网搜索是为了：",
      "1. **解释**这些数字为什么是这样——是什么业务变化导致的？",
      "2. **补上**它们没覆盖的：最新一季、指引、管理层表态、竞争与监管动向、非美同业。",
      "3. **挑战**它们：有没有公开信息说明这些数字会在下一期发生方向性变化？",
      "",
      "铁律：",
      "- **搜到的数字不得覆盖申报数字。** 两者冲突时，两个都写出来、都给来源、明确指出这是冲突，并说明可能的口径差异（期间、GAAP/non-GAAP、币种、是否含一次性项）。让读者看到分歧，不要替读者选。",
      "- 上面标为「无法计算」或「取不到」的，是真实的数据缺口。写进 open_questions，不要用你的背景知识填。",
      "- 引用上面的事实时注明来自申报/交易所，与你搜到的来源分开标注。",
    ].join("\n")
    : [
      "**These facts change what your search is for.** They are already established; do not go and re-find them. Search in order to:",
      "1. **Explain** why the numbers look like this -- what change in the business produced them?",
      "2. **Extend** what they do not cover: the latest quarter, guidance, management commentary, competitive and regulatory developments, non-US peers.",
      "3. **Challenge** them: is there public information indicating these figures change direction next period?",
      "",
      "Hard rules:",
      "- **A searched number never overwrites a filed number.** Where they conflict, report BOTH with their sources, say plainly that they conflict, and identify the likely reason (different period, GAAP vs non-GAAP, currency, inclusion of one-off items). Show the reader the disagreement rather than resolving it for them.",
      "- Anything marked not computable or not retrieved above is a genuine data gap. Put it in open_questions; do not fill it from background knowledge.",
      "- When you cite a fact from above, mark it as filing or exchange data, distinct from sources you found by searching.",
    ].join("\n"));

  return lines.join("\n");
}
