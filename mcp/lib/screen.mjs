import { fetchCompanyFacts, annualSeries, CONCEPTS } from "./sec.mjs";
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

function values(facts, key, asOf) {
  const found = annualSeries(facts, CONCEPTS[key], { asOf });
  return found ? found.series.map((e) => ({ end: e.end, filed: e.filed, val: e.val })) : [];
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

  add("roe_10y", "10-year average ROE below 8%", () => {
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
    return { passed: avg >= 0.08, value: pct(avg), unit: "%", threshold: 8, years: roes.length };
  });

  add("fcf_5y", "5-year cumulative free cash flow negative", () => {
    const o = last(ocf, 5);
    const c = last(capex, 5);
    if (o.length < 3 || c.length < 3) return null;
    const n = Math.min(o.length, c.length);
    const total = sum(o.slice(-n).map((x) => x.val)) - sum(c.slice(-n).map((x) => x.val));
    return { passed: total >= 0, value: Number((total / 1e9).toFixed(2)), unit: "USD bn", threshold: 0, years: n };
  });

  add("interest_cover", "EBIT / interest below 2x", () => {
    const ebit = last(operatingIncome, 1)[0];
    const int = last(interest, 1)[0];
    if (!ebit || !int || int.val === 0) return null;
    const cover = ebit.val / Math.abs(int.val);
    return { passed: cover >= 2, value: Number(cover.toFixed(2)), unit: "x", threshold: 2 };
  });

  add("gross_margin", "long-run gross margin below 15%", () => {
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
    return { passed: avg >= 0.15, value: pct(avg), unit: "%", threshold: 15, years: margins.length };
  });

  add("ocf_over_ni", "5-year OCF / net income below 0.7", () => {
    const o = last(ocf, 5);
    const ni = last(netIncome, 5);
    if (o.length < 3 || ni.length < 3) return null;
    const n = Math.min(o.length, ni.length);
    const totalNi = sum(ni.slice(-n).map((x) => x.val));
    if (totalNi <= 0) return null;
    const ratio = sum(o.slice(-n).map((x) => x.val)) / totalNi;
    return { passed: ratio >= 0.7, value: Number(ratio.toFixed(2)), unit: "x", threshold: 0.7, years: n };
  });

  add("net_margin", "long-run net margin below 5%", () => {
    const ni = last(netIncome, 5);
    const rev = last(revenue, 5);
    if (ni.length < 3 || rev.length < 3) return null;
    const n = Math.min(ni.length, rev.length);
    const totalRev = sum(rev.slice(-n).map((x) => x.val));
    if (totalRev <= 0) return null;
    const margin = sum(ni.slice(-n).map((x) => x.val)) / totalRev;
    return { passed: margin >= 0.05, value: pct(margin), unit: "%", threshold: 5, years: n };
  });

  add("dilution", "5-year share count up more than 20%", () => {
    const s = last(shares, 5);
    if (s.length < 3) return null;
    const first = s[0].val;
    const latest = s[s.length - 1].val;
    if (!(first > 0)) return null;
    const change = latest / first - 1;
    return { passed: change <= 0.20, value: pct(change), unit: "%", threshold: 20, years: s.length };
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
      lines.push(`  - ${f.label}: measured ${f.value}${f.unit === "%" ? "%" : ` ${f.unit}`} against a threshold of ${f.threshold}${f.years ? ` over ${f.years}y` : ""}`);
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
  if (!cik) throw invalidParams("screenTicker needs a cik");
  const facts = await fetchCompanyFacts(cik);
  const result = evaluateRules(facts, { asOf });
  return { ticker: ticker || facts.entityName, cik, entity: facts.entityName, as_of: asOf, ...result };
}
