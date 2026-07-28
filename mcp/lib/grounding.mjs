import { fetchQuote } from "./quotes.mjs";
import { invalidParams } from "./errors.mjs";
import { getMacroSnapshot } from "./macro.mjs";
import { fetchOptionsChain } from "./options.mjs";
import { screenTicker } from "./screen.mjs";
import { resolveIndustry, industryCoverage } from "./industry.mjs";
import { fetchSubmissions, fetchUniverse } from "./sec.mjs";
import { fetchMarketFinancials, coverageFor, marketFor } from "./markets.mjs";
import { inclusiveCutoffTime } from "./personas-v3/source-anchor.mjs";
import { adaptGroundingToTypedFacts } from "./personas-v3/grounding-adapter.mjs";
import { classifyInstrument, instrumentResearchChecklist, isFundOrIndex } from "./instruments.mjs";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * Current quote, option, macro and unversioned industry feeds cannot reconstruct a past
 * information set. A date-only cutoff includes that whole UTC day; an exact timestamp is
 * allowed only while it has not already passed. Historical runs must use an archived fact
 * pack instead of relabelling today's snapshot with an old date.
 */
export function liveSnapshotPolicy(asOf, { now = new Date() } = {}) {
  if (asOf === null || asOf === undefined || asOf === "") {
    return { allowed: true, reason: "current_run_without_cutoff", cutoff_time: null };
  }
  const cutoff = inclusiveCutoffTime(asOf);
  if (!Number.isFinite(cutoff)) {
    throw invalidParams(`as_of must be YYYY-MM-DD or a zoned timestamp, got ${JSON.stringify(asOf)}`);
  }
  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowTime)) throw new Error("grounding now must be a valid timestamp");
  const allowed = cutoff >= nowTime;
  return {
    allowed,
    reason: allowed
      ? (DATE_ONLY.test(asOf) ? "cutoff_includes_current_utc_day" : "cutoff_not_yet_passed")
      : "historical_cutoff_requires_archived_fact_pack",
    cutoff_time: new Date(cutoff).toISOString(),
  };
}

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
 * @param {boolean} [options.options] include the delayed CBOE option-chain digest for US listings
 * @param {string} [options.asOf]     only use filings filed by this date
 */
export async function gatherGrounding({
  symbol,
  cik,
  industry,
  macro = true,
  options = true,
  asOf = null,
  now = new Date(),
  signal,
} = {}) {
  const snapshotPolicy = liveSnapshotPolicy(asOf, { now });
  const gatheredAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const out = {
    as_of: asOf,
    gathered_at: gatheredAt,
    point_in_time_policy: snapshotPolicy,
    unavailable: [],
    not_applicable: [],
  };
  const jobs = [];
  let quoteJob = null;

  if (symbol && snapshotPolicy.allowed) {
    quoteJob = safely("quote", () => fetchQuote(symbol, { signal })).then((r) => {
      if (r.ok && !r.value?.error) out.quote = r.value;
      else out.unavailable.push(r.ok ? `quote: ${r.value.error}` : r.error);
    });
    jobs.push(quoteJob);
  } else if (symbol) {
    out.unavailable.push("quote: historical cutoff requires an archived point-in-time price; current snapshot was not fetched");
  }

  if (macro && snapshotPolicy.allowed) {
    jobs.push(safely("macro", () => getMacroSnapshot({ blocks: ["rates", "dollar_liquidity", "commodities"], signal })).then((r) => {
      if (!r.ok) { out.unavailable.push(r.error); return; }
      out.macro = {
        derived: r.value.derived.filter((d) => d.available).map((d) => ({ id: d.id, label: d.label, value: d.value })),
        unavailable: r.value.unavailable,
      };
    }));
  } else if (macro) {
    out.unavailable.push("macro: historical cutoff requires archived observations; current market snapshots were not fetched");
  }

  // Classification is a routing decision, so wait for the already-started quote metadata
  // before choosing SEC/company versus fund/index paths. Macro continues in parallel.
  if (quoteJob) await quoteJob;
  out.instrument = classifyInstrument({ symbol, quote: out.quote });

  // Without this, a caller that has a ticker but not a CIK gets no filer profile and no
  // mechanical screen -- the filings half of "established facts" disappears and nothing
  // in the output says it was skipped. Fund registrants still get their submissions profile,
  // but never an operating-company Company Facts screen.
  const symbolMarket = marketFor(symbol);
  const secRegistrantCandidate = symbolMarket?.id === "US"
    && !["index", "future", "fx", "crypto"].includes(out.instrument.asset_type);
  if (!cik && symbol && secRegistrantCandidate && snapshotPolicy.allowed) {
    const mapping = await safely("SEC ticker mapping", () => fetchUniverse({ signal }));
    if (mapping.ok) {
      const match = mapping.value.find((row) => String(row.ticker).toUpperCase() === String(symbol).toUpperCase());
      cik = match?.cik;
      if (match) {
        out.sec_ticker_match = { cik: match.cik, ticker: match.ticker, title: match.title };
        out.instrument = classifyInstrument({ symbol, quote: out.quote, filer: { title: match.title } });
      }
    } else {
      out.unavailable.push(mapping.error);
    }
  } else if (!cik && symbol && secRegistrantCandidate) {
    out.unavailable.push("SEC ticker mapping: historical cutoff requires an explicit point-in-time CIK; today's ticker universe was not fetched");
  }

  // Persona methods must receive the same shape the options calculator actually returns.
  // Do not manufacture realised volatility, a friction-adjusted edge, or event coverage:
  // the delayed CBOE snapshot does not contain any of them. Its explicit `unavailable`
  // entries remain attached to the grounding so downstream policies see gaps as gaps.
  if (symbol && options && symbolMarket?.id === "US" && !out.instrument.index_like && snapshotPolicy.allowed) {
    jobs.push(safely("options chain", () => fetchOptionsChain(symbol, { asOf, signal })).then((r) => {
      if (r.ok && r.value?.available) out.options = r.value;
      else out.unavailable.push(r.ok ? `options chain: ${r.value?.reason || "unavailable"}` : r.error);
    }));
  } else if (symbol && options && symbolMarket?.id === "US" && !out.instrument.index_like) {
    out.unavailable.push("options chain: historical cutoff requires an archived chain; current CBOE snapshot was not fetched");
  } else if (symbol && options && out.instrument.index_like) {
    out.not_applicable.push("CBOE equity/ETF option-chain adapter: direct cash-index symbol is not supported; use the appropriate listed derivative or ETF proxy explicitly");
  }

  if (cik) {
    if (snapshotPolicy.allowed) {
      // Resolve the registrant before deciding whether Company Facts applies. Scheduling
      // both in parallel recreated the QQQ bug when quote metadata was unavailable: the
      // screen started under an equity fallback before the fund name arrived.
      const filer = await safely("filer profile", () => fetchSubmissions(cik, { signal }));
      if (filer.ok) {
        out.filer = filer.value;
        out.instrument = classifyInstrument({ symbol, quote: out.quote, filer: out.filer });
      } else out.unavailable.push(filer.error);
    } else {
      out.unavailable.push("filer profile: SEC submissions metadata is current, not point-in-time versioned; it was excluded from the historical information set");
    }
    if (out.instrument.sec_companyfacts_applicable) jobs.push(safely("screen", () => screenTicker({ cik, ticker: symbol, asOf, signal })).then((r) => {
      if (!r.ok) { out.unavailable.push(r.error); return; }
      const s = r.value;
      const metricSourceIds = (metric) => (metric.source_records || []).map((source) => (
        `sec:companyfacts:${s.cik}:${source.tag}:${source.accession || source.filed}:${source.period_end}`
      ));
      const metrics = s.rules.filter((x) => !x.skipped).map((x) => ({
        rule: x.id,
        label: x.label,
        value: x.value,
        unit: x.unit,
        threshold: x.threshold,
        direction: x.direction,
        passed: x.passed,
        period_start: x.period_start || null,
        period_end: x.period_end || null,
        fiscal_year: x.fiscal_year || null,
        public_at: x.public_at || null,
        source_ids: metricSourceIds(x),
      }));
      out.screen = {
        cik: s.cik,
        verdict: s.verdict,
        rules_computed: s.evaluated_count,
        rules_total: s.rules.length,
        // Only the computed rules: a skipped rule is not a fact about the company.
        metrics,
        public_at: metrics.map((metric) => metric.public_at).filter(Boolean).sort().at(-1) || null,
        failures: s.failures.map((f) => ({ rule: f.id, value: f.value, unit: f.unit, threshold: f.threshold })),
        exemptions: s.exemptions,
        skipped: s.rules.filter((x) => x.skipped).map((x) => ({ rule: x.id, label: x.label })),
      };
    }));
    else out.not_applicable.push(`operating-company SEC Company Facts screen: not applicable to ${out.instrument.asset_type}`);
  }

  // Non-US symbols never reach the SEC path, so without this they arrived at the analyst
  // with nothing but a price.
  if (symbol && symbolMarket && symbolMarket.id !== "US" && !isFundOrIndex(out.instrument) && snapshotPolicy.allowed) {
    jobs.push(safely("market financials", () => fetchMarketFinancials(symbol, { signal })).then((r) => {
      if (!r.ok) { out.unavailable.push(r.error); return; }
      out.market = r.value;
      if (!r.value.financials) out.unavailable.push(`structured financials for ${symbol}: ${r.value.guidance}`);
    }));
  } else if (symbol && symbolMarket && symbolMarket.id !== "US" && !isFundOrIndex(out.instrument)) {
    out.unavailable.push(`structured financials for ${symbol}: this adapter is not point-in-time versioned; current data was not fetched for a historical cutoff`);
  } else if (symbol && isFundOrIndex(out.instrument)) {
    out.not_applicable.push(`operating-company structured financials: not applicable to ${out.instrument.asset_type}; use look-through or aggregate index evidence`);
  }

  if (industry && snapshotPolicy.allowed) {
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
  } else if (industry) {
    out.unavailable.push("industry map: the curated map is not publication-versioned and was excluded from the historical information set");
  }

  await Promise.all(jobs);

  // Coverage across every symbol in play, so a report cannot quietly become US-only.
  const inPlay = [symbol, ...(out.industry?.participants || []).map((p) => p.symbol)].filter(Boolean);
  if (inPlay.length && !isFundOrIndex(out.instrument)) out.coverage = coverageFor([...new Set(inPlay)]);
  else if (symbol && isFundOrIndex(out.instrument)) {
    out.coverage = {
      rows: [{
        symbol,
        market: symbolMarket?.id || "market",
        structured_financials: "not applicable",
        reason: `${out.instrument.asset_type} requires holdings/index look-through rather than issuer financial statements`,
      }],
      summary: { full: 0, summary_only: 0, none: 0, not_applicable: 1 },
      note: "Fund/index research uses dated holdings, methodology and aggregate or look-through evidence.",
    };
  }
  const typed = adaptGroundingToTypedFacts(out, {
    asOf: asOf || gatheredAt,
    knowledgeAsOf: asOf || gatheredAt,
  });
  out.typed_fact_pack = typed.fact_pack;
  out.typed_fact_sources = typed.sources;
  out.typed_fact_diagnostics = typed.diagnostics;
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
/**
 * A skipped rule arrives either as a bare id or as {rule, label}. Handling only the object
 * form silently rendered an empty list -- which reads as "nothing was skipped", the exact
 * opposite of what the line exists to say.
 */
const skippedName = (entry, chinese) =>
  (typeof entry === "string" ? entry : localized(entry?.label, chinese) || entry?.rule) || String(entry ?? "");

/** Render a bilingual label. Every {en, zh} value must pass through here before display. */
const localized = (label, chinese) => {
  if (label == null) return "";
  if (typeof label === "string") return label;
  return (chinese ? label.zh : label.en) ?? label.en ?? label.zh ?? "";
};

export function groundingBlock(grounding, language = "English") {
  const chinese = /中文|chinese|zh/i.test(String(language));
  if (!grounding || (!grounding.instrument && !grounding.quote && !grounding.screen && !grounding.options && !grounding.macro && !grounding.industry)) return "";

  const lines = [];
  const head = chinese
    ? "## 已确立的事实（来自申报原文与交易所数据，不是你的记忆）"
    : "## Established facts (from filings and exchange data, not from your memory)";
  lines.push(head);

  if (grounding.instrument) {
    const i = grounding.instrument;
    lines.push(chinese
      ? `- 资产类型：${i.asset_type}｜研究模型 ${i.research_model}｜识别来源 ${i.classification_source}`
      : `- Instrument: ${i.asset_type} | research model ${i.research_model} | classified by ${i.classification_source}`);
  }

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
      lines.push(`  - ${localized(m.label, chinese)}: ${fmt(m.value, m.unit)} (${m.direction === "max" ? "max" : "min"} ${m.threshold}) ${m.passed ? "pass" : "FAIL"}`);
    }
    if (s.skipped.length) {
      lines.push(chinese
        ? `  - 无法从申报计算，未按通过处理：${s.skipped.map((x) => skippedName(x, chinese)).join("、")}`
        : `  - Not computable from filings and NOT treated as passes: ${s.skipped.map((x) => skippedName(x, chinese)).join(", ")}`);
    }
  }
  if (grounding.options?.available) {
    const o = grounding.options;
    const reference = o.reference_expiry;
    const skew = o.skew_25delta;
    const atm = Number.isFinite(reference?.atm_iv) ? `${(reference.atm_iv * 100).toFixed(1)}%` : "n/a";
    const skewPoints = Number.isFinite(skew?.put_minus_call) ? (skew.put_minus_call * 100).toFixed(2) : "n/a";
    lines.push(chinese
      ? `- 期权链（延迟，${o.source || "CBOE"}）：参考到期 ${reference?.expiry || "n/a"}｜ATM IV ${atm}｜25-delta put-call skew ${skewPoints} 波动率点`
      : `- Options chain (delayed, ${o.source || "CBOE"}): reference expiry ${reference?.expiry || "n/a"} | ATM IV ${atm} | 25-delta put-minus-call skew ${skewPoints} vol points`);
    if (o.unavailable?.length) {
      lines.push(chinese
        ? `  - 此快照无法提供：${o.unavailable.join("；")}`
        : `  - Not supplied by this snapshot: ${o.unavailable.join("; ")}`);
    }
  }
  if (grounding.macro?.derived?.length) {
    lines.push(chinese ? "- 宏观读数：" : "- Macro readings:");
    // Derived labels are {en, zh}; interpolating the object printed "[object Object]"
    // next to a real number, which reads as a broken field rather than a missing one.
    for (const d of grounding.macro.derived) {
      const name = localized(d.label, chinese) || d.id;
      lines.push(`  - ${name}: ${d.value}`);
    }
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
  if (grounding.not_applicable?.length) {
    lines.push(chinese ? `- 明确不适用（不是数据抓取错误）：${grounding.not_applicable.join("；")}`
      : `- Explicitly not applicable (not a retrieval failure): ${grounding.not_applicable.join("; ")}`);
  }

  const instrumentChecklist = instrumentResearchChecklist(grounding.instrument, language);
  if (instrumentChecklist) lines.push("", instrumentChecklist);

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
