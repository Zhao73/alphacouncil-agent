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
 * Pair two annual series by fiscal period end, newest last, capped at n pairs.
 *
 * Pairing by array position instead put every year after a gap onto the wrong
 * counterpart -- a filer that stopped tagging InterestExpense had this year's EBIT
 * divided by a two-year-old interest figure, and an equity series missing one middle
 * year shifted a decade of ROE by one year -- while the provenance block still showed
 * a clean range. A year present on only one side is dropped, never matched to a
 * neighbour; the pair count is what the rule reports as its coverage.
 */
const pairByEnd = (a, b, n) => {
  const byEnd = new Map(b.map((row) => [row.end, row]));
  return a.filter((row) => byEnd.has(row.end)).slice(-n).map((row) => [row, byEnd.get(row.end)]);
};

/**
 * XBRL reports share counts under the `shares` unit, not `USD`. Requesting the default unit
 * for a share concept returns nothing, so the dilution rule reported `skipped` for every
 * company that has ever been screened -- seven rules advertised, six ever computed, and the
 * skip looked exactly like a genuine data gap.
 */
const UNIT_BY_CONCEPT = { sharesOutstanding: "shares" };

// SEC CompanyFacts exposes the declared split conversion ratio as a dimensionless
// us-gaap fact. It is intentionally kept separate from CONCEPTS: this is not an annual
// operating metric, and 10-Q/8-K facts can be the first official record of the split.
const SPLIT_RATIO_TAGS = [
  "StockholdersEquityNoteStockSplitConversionRatio1",
  "StockholdersEquityNoteStockSplitConversionRatio",
];
const SPLIT_LIKE_TOLERANCE = 0.08;
const SPLIT_EVENT_CLUSTER_DAYS = 93;

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
 * Dilution is measured between two instant share-count observations.  A split ratio's
 * duration describes the corporate-action event, not the start of the share-count coverage
 * used by the calculation.  Keep split records in source lineage while pinning the metric
 * period to the oldest and newest share observations themselves.
 */
function dilutionProvenance(shares, splitRows) {
  return {
    ...ruleProvenance([shares, splitRows]),
    period_start: shares[0]?.end || null,
    period_end: shares.at(-1)?.end || null,
  };
}

const relativeError = (actual, expected) => Math.abs(actual / expected - 1);

/**
 * A discontinuity close to an integer multiple is split-like, not proof of a split.
 * Without an official conversion ratio it must trigger manual review rather than being
 * scored as dilution. Ordinary issuance such as 1.5x remains an economic share change.
 */
function splitLikeTransition(previous, current) {
  if (!(previous?.val > 0) || !(current?.val > 0)) return null;
  const ratio = current.val / previous.val;
  const magnitude = Math.max(ratio, 1 / ratio);
  const nearestInteger = Math.round(magnitude);
  if (nearestInteger < 2 || nearestInteger > 100) return null;
  if (relativeError(magnitude, nearestInteger) > SPLIT_LIKE_TOLERANCE) return null;
  return {
    from_period: previous.end,
    to_period: current.end,
    observed_ratio: Number(ratio.toFixed(6)),
    near_integer_factor: nearestInteger,
  };
}

/**
 * Read dated, public SEC XBRL split-ratio facts and collapse repeated contexts for the
 * same event. A cluster with conflicting ratios is retained but marked unreliable.
 */
function splitRatioEvents(facts, shares, asOf) {
  const cutoff = asOf ? Date.parse(asOf) : null;
  const windowStart = Date.parse(shares[0]?.end);
  const windowEnd = Math.max(
    ...shares.flatMap((row) => [Date.parse(row.end), Date.parse(row.filed)]).filter(Number.isFinite),
  );
  const rows = [];

  for (const tag of SPLIT_RATIO_TAGS) {
    const entries = facts?.facts?.["us-gaap"]?.[tag]?.units?.pure;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const eventTime = Date.parse(entry.end);
      const filedTime = Date.parse(entry.filed);
      if (!Number.isFinite(entry.val) || !(entry.val > 0) || relativeError(entry.val, 1) < 0.001) continue;
      if (!Number.isFinite(eventTime) || !Number.isFinite(filedTime)) continue;
      if (cutoff && filedTime > cutoff) continue;
      // A later filing may retrospectively restate a pre-split comparison, so the event
      // may occur after that comparison's period end but never after its filing date.
      if (eventTime < windowStart || eventTime > windowEnd) continue;
      rows.push({
        start: entry.start || null,
        end: entry.end,
        filed: entry.filed,
        val: entry.val,
        accn: entry.accn || null,
        form: entry.form || null,
        tag,
      });
    }
  }

  rows.sort((a, b) => Date.parse(a.end) - Date.parse(b.end));
  const clusters = [];
  for (const row of rows) {
    const prior = clusters.at(-1);
    const daysSincePrior = prior
      ? (Date.parse(row.end) - Date.parse(prior.rows.at(-1).end)) / 86400000
      : Infinity;
    if (!prior || daysSincePrior > SPLIT_EVENT_CLUSTER_DAYS) {
      clusters.push({ rows: [row] });
    } else {
      prior.rows.push(row);
    }
  }

  return clusters.map((cluster) => {
    const factors = [];
    for (const row of cluster.rows) {
      if (!factors.some((factor) => relativeError(row.val, factor) <= 0.01)) factors.push(row.val);
    }
    return {
      rows: cluster.rows,
      reliable: factors.length === 1,
      factor: factors.length === 1 ? factors[0] : null,
      reported_factors: factors,
      event_period_end: cluster.rows.map((row) => row.end).sort().at(-1),
    };
  });
}

/**
 * Match official split events to the discontinuities they explain. Blindly dividing by
 * every split fact is unsafe because many filers restate every historical share value onto
 * the current basis, leaving no discontinuity to adjust.
 */
function reviewSplitAdjustments(facts, shares, asOf) {
  const transitions = shares.slice(1).map((current, index) => ({
    previous: shares[index],
    current,
    ratio: current.val / shares[index].val,
    splitLike: splitLikeTransition(shares[index], current),
  })).filter((transition) => Number.isFinite(transition.ratio) && transition.ratio > 0);
  const splitLike = transitions.filter((transition) => transition.splitLike);
  if (!splitLike.length) return { status: "not_needed", factor: 1, sourceRows: [] };

  const events = splitRatioEvents(facts, shares, asOf);
  const reliableEvents = events.filter((event) => event.reliable);
  const usedTransitions = new Set();
  const matched = [];

  for (const event of reliableEvents) {
    let best = null;
    for (let index = 0; index < transitions.length; index += 1) {
      if (usedTransitions.has(index)) continue;
      const transition = transitions[index];
      for (const effectiveFactor of [event.factor, 1 / event.factor]) {
        const error = relativeError(transition.ratio, effectiveFactor);
        if (error <= SPLIT_LIKE_TOLERANCE && (!best || error < best.error)) {
          best = { index, transition, effectiveFactor, error };
        }
      }
    }
    if (best) {
      usedTransitions.add(best.index);
      matched.push({ event, ...best });
    }
  }

  const unmatchedSplitLike = splitLike.filter((transition) =>
    !matched.some((item) => item.transition === transition));
  if (unmatchedSplitLike.length) {
    const conflicting = events.filter((event) => !event.reliable);
    const reason = conflicting.length
      ? `split-like share-count jump found, but official XBRL split ratios conflict (${conflicting.flatMap((event) => event.reported_factors).join(", ")})`
      : reliableEvents.length
        ? "split-like share-count jump found, but no official XBRL split ratio consistently matches it"
        : "split-like share-count jump found without a reliable official XBRL split ratio";
    return {
      status: "needs_manual_adjustment",
      reason,
      transitions: unmatchedSplitLike.map((transition) => transition.splitLike),
      sourceRows: events.flatMap((event) => event.rows),
    };
  }

  const factor = matched.reduce((product, item) => product * item.effectiveFactor, 1);
  return {
    status: "verified_xbrl",
    factor,
    sourceRows: matched.flatMap((item) => item.event.rows),
    events: matched.map((item) => ({
      reported_factor: item.event.factor,
      effective_factor: Number(item.effectiveFactor.toFixed(6)),
      event_period_end: item.event.event_period_end,
      observed_ratio: Number(item.transition.ratio.toFixed(6)),
    })),
  };
}

/**
 * Seven elimination rules with three exemptions.
 * Each returns { id, passed, value, threshold, reason } or { skipped } when the inputs
 * are not available -- a missing input is never silently treated as a pass.
 */
/**
 * Gross profit, direct where the filer tagged it and revenue less cost of revenue where not.
 *
 * The subtraction is the filer's own arithmetic on the filer's own figures, matched by period
 * end so a year is never differenced against a different year. Years the filer did tag keep the
 * tagged value: a direct number always beats a reconstructed one.
 */
export function derivedGrossProfit(direct, revenue, cost) {
  if (direct?.length) return direct;
  if (!revenue?.length || !cost?.length) return direct || [];
  const costByEnd = new Map(cost.map((row) => [row.end, row]));
  const derived = [];
  for (const row of revenue) {
    const paired = costByEnd.get(row.end);
    if (!paired || !Number.isFinite(paired.val)) continue;
    derived.push({
      ...row,
      val: row.val - paired.val,
      tag: `${row.tag} - ${paired.tag}`,
      derived_from: [row.tag, paired.tag],
    });
  }
  return derived;
}

export function evaluateRules(facts, { asOf = null } = {}) {
  const revenue = values(facts, "revenue", asOf);
  const netIncome = values(facts, "netIncome", asOf);
  // Derived where the filer did not tag it directly, from two figures it did publish.
  const grossProfit = derivedGrossProfit(values(facts, "grossProfit", asOf), values(facts, "revenue", asOf), values(facts, "costOfRevenue", asOf));
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
    const pairs = pairByEnd(netIncome, equity, 10);
    if (pairs.length < 5) return null;
    const roes = pairs.filter(([, e]) => e.val > 0).map(([n, e]) => n.val / e.val);
    if (roes.length < 5) return null;
    const avg = sum(roes) / roes.length;
    return {
      passed: avg >= 0.08, value: pct(avg), unit: "%", threshold: 8, direction: "min", years: roes.length,
      ...ruleProvenance([pairs.map(([n]) => n), pairs.map(([, e]) => e)]),
    };
  });

  add("fcf_5y", { en: "5-year cumulative free cash flow", zh: "5年累计自由现金流" }, () => {
    const pairs = pairByEnd(ocf, capex, 5);
    if (pairs.length < 3) return null;
    const total = sum(pairs.map(([o, c]) => o.val - c.val));
    // Raw dollars, not billions rounded to two places: rounding erased the entire figure
    // for anything below ~$5m, which is most of the small-cap universe.
    return {
      passed: total >= 0, value: Math.round(total), unit: "USD", threshold: 0, direction: "min", years: pairs.length,
      ...ruleProvenance([pairs.map(([o]) => o), pairs.map(([, c]) => c)]),
    };
  });

  add("interest_cover", { en: "EBIT / interest cover", zh: "利息保障倍数" }, () => {
    // The interest figure must belong to the same period as the latest EBIT. A filer that
    // stops tagging InterestExpense gets a skip here, not a ratio built on old debt.
    const pairs = pairByEnd(last(operatingIncome, 1), interest, 1);
    if (!pairs.length) return null;
    const [ebit, int] = pairs[0];
    if (int.val === 0) return null;
    const cover = ebit.val / Math.abs(int.val);
    return {
      passed: cover >= 2, value: Number(cover.toFixed(2)), unit: "x", threshold: 2, direction: "min",
      ...ruleProvenance([[ebit, int]]),
    };
  });

  add("gross_margin", { en: "long-run gross margin", zh: "长期毛利率" }, () => {
    const pairs = pairByEnd(grossProfit, revenue, 5);
    if (pairs.length < 3) return null;
    const margins = pairs.filter(([, r]) => r.val > 0).map(([g, r]) => g.val / r.val);
    if (!margins.length) return null;
    const avg = sum(margins) / margins.length;
    return {
      passed: avg >= 0.15, value: pct(avg), unit: "%", threshold: 15, direction: "min", years: margins.length,
      ...ruleProvenance([pairs.map(([g]) => g), pairs.map(([, r]) => r)]),
    };
  });

  add("ocf_over_ni", { en: "5-year OCF / net income", zh: "5年经营现金流/净利" }, () => {
    const pairs = pairByEnd(ocf, netIncome, 5);
    if (pairs.length < 3) return null;
    const totalNi = sum(pairs.map(([, n]) => n.val));
    if (totalNi <= 0) return null;
    const ratio = sum(pairs.map(([o]) => o.val)) / totalNi;
    return {
      passed: ratio >= 0.7, value: Number(ratio.toFixed(2)), unit: "x", threshold: 0.7, direction: "min", years: pairs.length,
      ...ruleProvenance([pairs.map(([o]) => o), pairs.map(([, n]) => n)]),
    };
  });

  add("net_margin", { en: "long-run net margin", zh: "长期净利率" }, () => {
    const pairs = pairByEnd(netIncome, revenue, 5);
    if (pairs.length < 3) return null;
    const totalRev = sum(pairs.map(([, r]) => r.val));
    if (totalRev <= 0) return null;
    const margin = sum(pairs.map(([n]) => n.val)) / totalRev;
    return {
      passed: margin >= 0.05, value: pct(margin), unit: "%", threshold: 5, direction: "min", years: pairs.length,
      ...ruleProvenance([pairs.map(([n]) => n), pairs.map(([, r]) => r)]),
    };
  });

  add("dilution", { en: "5-year share dilution", zh: "5年股本稀释" }, () => {
    const s = last(shares, 5);
    if (s.length < 3) return null;
    const first = s[0].val;
    const latest = s[s.length - 1].val;
    if (!(first > 0) || !(latest > 0)) return null;
    const rawChange = latest / first - 1;
    const splitReview = reviewSplitAdjustments(facts, s, asOf);
    if (splitReview.status === "needs_manual_adjustment") {
      return {
        skipped: true,
        reason: splitReview.reason,
        adjustment_status: "needs_manual_adjustment",
        raw_value: pct(rawChange),
        unit: "%",
        threshold: 20,
        direction: "max",
        years: s.length,
        split_like_transitions: splitReview.transitions,
        ...dilutionProvenance(s, splitReview.sourceRows),
      };
    }
    const change = latest / (first * splitReview.factor) - 1;
    return {
      passed: change <= 0.20, value: pct(change), unit: "%", threshold: 20, direction: "max", years: s.length,
      ...(splitReview.status === "verified_xbrl" ? {
        raw_value: pct(rawChange),
        adjustment_status: "verified_xbrl",
        split_adjustment: {
          factor: Number(splitReview.factor.toFixed(6)),
          source: "SEC CompanyFacts us-gaap split conversion ratio",
          reason: "official XBRL split ratio aligns with the observed share-count discontinuity",
          events: splitReview.events,
        },
      } : {}),
      ...dilutionProvenance(s, splitReview.sourceRows),
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
    for (const skipped of result.rules.filter((rule) => rule.skipped)) {
      lines.push(`  - ${typeof skipped.label === "string" ? skipped.label : skipped.label.en}: ${skipped.reason}`);
    }
  }
  return lines.join("\n");
}

export async function screenTicker({ cik, ticker, asOf = null, signal }) {
  // The tool schema offers `ticker`, so callers pass one. Demanding a CIK anyway turned a
  // documented argument into an error and made the caller go look up an identifier the
  // universe file already holds -- the opposite of working without configuration.
  let resolved = cik;
  if (!resolved && ticker) {
    const wanted = String(ticker).trim().toUpperCase();
    const universe = await fetchUniverse({ signal });
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
  const facts = await fetchCompanyFacts(cikUsed, { signal });
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
