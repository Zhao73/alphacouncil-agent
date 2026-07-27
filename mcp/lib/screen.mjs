import { fetchUniverse, fetchCompanyFacts, annualSeries, CONCEPTS } from "./sec.mjs";
import { invalidParams } from "./errors.mjs";

/**
 * Mechanical elimination screen. No language model is involved.
 *
 * This is the layer that makes stock-finding honest: an LLM asked to "recommend some
 * stocks" returns the names most frequent in its training data attached to hallucinated
 * figures. Here every rejection names the metric, the computed value and the threshold,
 * so any verdict can be checked or argued with.
 *
 * The rules eliminate; they never select. Surviving is not a recommendation, it means
 * "worth spending research time on".
 */

const pct = (x) => (x === null ? null : Number((x * 100).toFixed(2)));
const last = (series, n) => series.slice(-n);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/**
 * XBRL reports share counts under the `shares` unit, not `USD`. Requesting the default unit
 * for a share concept returns nothing, so the dilution rule reported `skipped` for every
 * company that has ever been screened -- seven rules advertised, six ever computed, and the
 * skip looked exactly like a genuine data gap.
 */
const UNIT_BY_CONCEPT = { sharesOutstanding: "shares" };

function values(facts, key, asOf) {
  const found = annualSeries(facts, CONCEPTS[key], { asOf, unit: UNIT_BY_CONCEPT[key] || "USD" });
  return found ? found.series.map((e) => ({
    start: e.start || null,
    end: e.end,
    filed: e.filed,
    val: e.val,
    accn: e.accn || null,
    tag: e.tag || found.tag,
  })) : [];
}

function ruleProvenance(series) {
  const rows = series.flat().filter((entry) => entry?.filed && entry?.end);
  const starts = rows.map((entry) => entry.start).filter(Boolean).sort();
  const ends = rows.map((entry) => entry.end).filter(Boolean).sort();
  const filed = rows.map((entry) => entry.filed).filter(Boolean).sort();
  const sourceRecords = [];
  const seen = new Set();
  for (const entry of rows) {
    const key = `${entry.tag}:${entry.accn || "no-accn"}:${entry.filed}:${entry.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sourceRecords.push({
      tag: entry.tag,
      accession: entry.accn,
      filed: entry.filed,
      period_end: entry.end,
    });
  }
  return {
    period_start: starts[0] || null,
    period_end: ends.at(-1) || null,
    fiscal_year: ends.length ? Number(ends.at(-1).slice(0, 4)) : null,
    public_at: filed.at(-1) || null,
    source_records: sourceRecords,
  };
}

/**
 * Seven elimination rules with three exemptions.
 * Each returns { id, passed, value, threshold, reason } or { skipped } when the inputs
 * are not available -- a missing input is never silently treated as a pass.
 */
export function evaluateRules(facts, { asOf = null } = {}) {
  const revenue = values(facts, "revenue", asOf);
  const netIncome = values(facts, "netIncome", asOf);
  const grossProfit = values(facts, "grossProfit", asOf);
  const operatingIncome = values(facts, "operatingIncome", asOf);
  const ocf = values(facts, "operatingCashFlow", asOf);
  const capex = values(facts, "capex", asOf);
  const equity = values(facts, "equity", asOf);
  const interest = values(facts, "interestExpense", asOf);
  const shares = values(facts, "sharesOutstanding", asOf);

  const rules = [];
  const add = (id, label, compute) => {
    try {
      const result = compute();
      rules.push(result === null ? { id, label, skipped: true, reason: "inputs unavailable in filings" } : { id, label, ...result });
    } catch (error) {
      rules.push({ id, label, skipped: true, reason: `could not compute: ${error.message}` });
    }
  };

  add("roe_10y", { en: "10-year average ROE", zh: "10年平均ROE" }, () => {
    const ni = last(netIncome, 10);
    const eq = last(equity, 10);
    if (ni.length < 5 || eq.length < 5) return null;
    const n = Math.min(ni.length, eq.length);
    const roes = [];
    for (let i = 0; i < n; i += 1) {
      const e = eq[eq.length - n + i].val;
      if (e > 0) roes.push(ni[ni.length - n + i].val / e);
    }
    if (roes.length < 5) return null;
    const avg = sum(roes) / roes.length;
    return {
      passed: avg >= 0.08, value: pct(avg), unit: "%", threshold: 8, direction: "min", years: roes.length,
      ...ruleProvenance([ni.slice(-n), eq.slice(-n)]),
    };
  });

  add("fcf_5y", { en: "5-year cumulative free cash flow", zh: "5年累计自由现金流" }, () => {
    const o = last(ocf, 5);
    const c = last(capex, 5);
    if (o.length < 3 || c.length < 3) return null;
    const n = Math.min(o.length, c.length);
    const total = sum(o.slice(-n).map((x) => x.val)) - sum(c.slice(-n).map((x) => x.val));
    // Raw dollars, not billions rounded to two places: rounding erased the entire figure
    // for anything below ~$5m, which is most of the small-cap universe.
    return {
      passed: total >= 0, value: Math.round(total), unit: "USD", threshold: 0, direction: "min", years: n,
      ...ruleProvenance([o.slice(-n), c.slice(-n)]),
    };
  });

  add("interest_cover", { en: "EBIT / interest cover", zh: "利息保障倍数" }, () => {
    const ebit = last(operatingIncome, 1)[0];
    const int = last(interest, 1)[0];
    if (!ebit || !int || int.val === 0) return null;
    const cover = ebit.val / Math.abs(int.val);
    return {
      passed: cover >= 2, value: Number(cover.toFixed(2)), unit: "x", threshold: 2, direction: "min",
      ...ruleProvenance([[ebit, int]]),
    };
  });

  add("gross_margin", { en: "long-run gross margin", zh: "长期毛利率" }, () => {
    const gp = last(grossProfit, 5);
    const rev = last(revenue, 5);
    if (gp.length < 3 || rev.length < 3) return null;
    const n = Math.min(gp.length, rev.length);
    const margins = [];
    for (let i = 0; i < n; i += 1) {
      const r = rev[rev.length - n + i].val;
      if (r > 0) margins.push(gp[gp.length - n + i].val / r);
    }
    if (!margins.length) return null;
    const avg = sum(margins) / margins.length;
    return {
      passed: avg >= 0.15, value: pct(avg), unit: "%", threshold: 15, direction: "min", years: margins.length,
      ...ruleProvenance([gp.slice(-n), rev.slice(-n)]),
    };
  });

  add("ocf_over_ni", { en: "5-year OCF / net income", zh: "5年经营现金流/净利" }, () => {
    const o = last(ocf, 5);
    const ni = last(netIncome, 5);
    if (o.length < 3 || ni.length < 3) return null;
    const n = Math.min(o.length, ni.length);
    const totalNi = sum(ni.slice(-n).map((x) => x.val));
    if (totalNi <= 0) return null;
    const ratio = sum(o.slice(-n).map((x) => x.val)) / totalNi;
    return {
      passed: ratio >= 0.7, value: Number(ratio.toFixed(2)), unit: "x", threshold: 0.7, direction: "min", years: n,
      ...ruleProvenance([o.slice(-n), ni.slice(-n)]),
    };
  });

  add("net_margin", { en: "long-run net margin", zh: "长期净利率" }, () => {
    const ni = last(netIncome, 5);
    const rev = last(revenue, 5);
    if (ni.length < 3 || rev.length < 3) return null;
    const n = Math.min(ni.length, rev.length);
    const totalRev = sum(rev.slice(-n).map((x) => x.val));
    if (totalRev <= 0) return null;
    const margin = sum(ni.slice(-n).map((x) => x.val)) / totalRev;
    return {
      passed: margin >= 0.05, value: pct(margin), unit: "%", threshold: 5, direction: "min", years: n,
      ...ruleProvenance([ni.slice(-n), rev.slice(-n)]),
    };
  });

  add("dilution", { en: "5-year share dilution", zh: "5年股本稀释" }, () => {
    const s = last(shares, 5);
    if (s.length < 3) return null;
    const first = s[0].val;
    const latest = s[s.length - 1].val;
    if (!(first > 0)) return null;
    const change = latest / first - 1;
    return {
      passed: change <= 0.20, value: pct(change), unit: "%", threshold: 20, direction: "max", years: s.length,
      ...ruleProvenance([s]),
    };
  });

  // Exemptions. These are the only legitimate way past a failed rule -- a good story is
  // not, and the screen deliberately gives no mechanism for one.
  const exemptions = [];
  const rule = (id) => rules.find((r) => r.id === id);
  const failed = (id) => rule(id) && rule(id).passed === false;

  const gm = rule("gross_margin");
  const historyYears = revenue.length;
  if (failed("roe_10y") && historyYears < 10 && gm?.value > 30 && last(ocf, 2).every((x) => x.val > 0)) {
    exemptions.push({
      rule: "roe_10y",
      reason: `listed under 10 years (${historyYears}y of filings) with gross margin ${gm.value}% and positive recent operating cash flow`,
    });
  }
  if (failed("fcf_5y") && gm?.value > 50) {
    exemptions.push({ rule: "fcf_5y", reason: `gross margin ${gm.value}% suggests reinvestment rather than an unprofitable model -- verify manually` });
  }
  if (failed("net_margin") && rule("ocf_over_ni") && rule("ocf_over_ni").value > 1.5) {
    exemptions.push({ rule: "net_margin", reason: `OCF/NI of ${rule("ocf_over_ni").value}x indicates heavy non-cash charges depressing reported margin` });
  }

  const exempted = new Set(exemptions.map((e) => e.rule));
  const failures = rules.filter((r) => r.passed === false && !exempted.has(r.id));
  const skipped = rules.filter((r) => r.skipped);

  return {
    rules,
    exemptions,
    failures,
    skipped_count: skipped.length,
    verdict: failures.length === 0 ? "survives" : "eliminated",
    // Data coverage is reported, never assumed: a company that failed nothing because
    // nothing could be computed is not the same as one that passed.
    evaluated_count: rules.length - skipped.length,
  };
}

export function explainResult(result, ticker) {
  const lines = [`${ticker}: ${result.verdict}`];
  if (result.failures.length) {
    lines.push("eliminated by:");
    for (const f of result.failures) {
      lines.push(`  - ${typeof f.label === "string" ? f.label : f.label.en}: measured ${f.value}${f.unit === "%" ? "%" : ` ${f.unit}`} against a threshold of ${f.threshold}${f.years ? ` over ${f.years}y` : ""}`);
    }
  }
  if (result.exemptions.length) {
    lines.push("exempted:");
    for (const e of result.exemptions) lines.push(`  - ${e.rule}: ${e.reason}`);
  }
  if (result.skipped_count) {
    lines.push(`${result.skipped_count} of ${result.rules.length} rules could not be computed from filings and were NOT treated as passes.`);
  }
  return lines.join("\n");
}

export async function screenTicker({ cik, ticker, asOf = null }) {
  // The tool schema offers `ticker`, so callers pass one. Demanding a CIK anyway turned a
  // documented argument into an error and made the caller go look up an identifier the
  // universe file already holds -- the opposite of working without configuration.
  let resolved = cik;
  if (!resolved && ticker) {
    const wanted = String(ticker).trim().toUpperCase();
    const universe = await fetchUniverse();
    const hit = universe.find((row) => String(row.ticker).toUpperCase() === wanted);
    if (!hit) {
      throw invalidParams(
        `no US filer with ticker "${ticker}" in the SEC universe. `
        + "Non-US listings are absent from it; supply a cik, or use market_coverage to see what this market supports.",
      );
    }
    resolved = hit.cik;
  }
  if (!resolved) throw invalidParams("screenTicker needs a cik or a ticker");
  const cikUsed = resolved;
  const facts = await fetchCompanyFacts(cikUsed);
  const result = evaluateRules(facts, { asOf });
  return { ticker: ticker || facts.entityName, cik: cikUsed, resolved_from_ticker: !cik && Boolean(ticker), entity: facts.entityName, as_of: asOf, ...result };
}


/**
 * Screen a list of candidates and report every elimination with its reason.
 *
 * Deliberately bounded rather than "screen the whole market": each company is one SEC
 * request at ~120ms, so 10,000 filers is twenty minutes of requests SEC would rightly
 * throttle. A funnel narrows first -- by industry, index, or a name list -- and this
 * layer eliminates mechanically from what is handed to it.
 */
export async function screenBatch({ candidates = [], asOf = null, concurrency = 3 } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw invalidParams("screenBatch needs candidates: [{cik, ticker}]");
  }
  if (candidates.length > 40) {
    throw invalidParams(`too many candidates (${candidates.length}). Narrow the funnel first -- SEC is one request per company and rate-limits. Cap is 40.`);
  }

  const results = [];
  const queue = [...candidates];
  const worker = async () => {
    while (queue.length) {
      const candidate = queue.shift();
      try {
        results.push(await screenTicker({ ...candidate, asOf }));
      } catch (error) {
        // A fetch failure is a data gap, never an elimination: silently dropping a name
        // because SEC timed out would bias the survivors.
        results.push({
          ticker: candidate.ticker || candidate.cik,
          cik: candidate.cik,
          verdict: "unavailable",
          error: String(error.message || error),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(4, concurrency)) }, worker));

  const survivors = results.filter((r) => r.verdict === "survives");
  const eliminated = results.filter((r) => r.verdict === "eliminated");
  const unavailable = results.filter((r) => r.verdict === "unavailable");

  return {
    as_of: asOf,
    screened: results.length,
    survivors: survivors.map((r) => ({
      ticker: r.ticker,
      cik: r.cik,
      entity: r.entity,
      rules_computed: r.evaluated_count,
      rules_total: r.rules.length,
      exemptions: r.exemptions,
    })),
    eliminated: eliminated.map((r) => ({
      ticker: r.ticker,
      cik: r.cik,
      // The whole point: never "did not pass", always which metric at which value.
      reasons: r.failures.map((f) => ({
        rule: f.id,
        label: f.label,
        measured: f.value,
        unit: f.unit,
        threshold: f.threshold,
        years: f.years,
      })),
    })),
    unavailable: unavailable.map((r) => ({ ticker: r.ticker, cik: r.cik, error: r.error })),
    disclaimer:
      "Surviving is not a recommendation. These rules eliminate; they never select. A survivor is a name worth "
      + "spending research time on, and the council still has to run. Rules whose inputs were missing from the "
      + "filings were skipped rather than passed, so check rules_computed before treating a survivor as clean.",
  };
}
