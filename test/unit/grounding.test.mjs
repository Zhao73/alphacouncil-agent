import { test } from "node:test";
import assert from "node:assert/strict";
import { gatherGrounding, groundingBlock, liveSnapshotPolicy } from "../../mcp/lib/grounding.mjs";
import { groundingForHeadlessRun } from "../../mcp/lib/orchestrator.mjs";
import { taskPrompt } from "../../mcp/lib/prompts.mjs";
import { adaptGroundingToTypedFacts } from "../../mcp/lib/personas-v3/grounding-adapter.mjs";
import { planMasterSeats } from "../../mcp/lib/personas/engine.mjs";

const sample = {
  quote: { symbol: "MU", price: 100, currency: "USD", change_pct: -2.5, source: "yahoo" },
  filer: { name: "MICRON TECHNOLOGY INC", sic: 3674, sic_description: "Semiconductors", exchanges: ["Nasdaq"] },
  screen: {
    verdict: "survives", rules_computed: 6, rules_total: 7,
    metrics: [{ rule: "gross_margin", label: "long-run gross margin below 15%", value: 27.17, unit: "%", threshold: 15, passed: true }],
    failures: [], exemptions: [], skipped: ["dilution"],
  },
  macro: { derived: [{ id: "spread_10y_3m", label: "10Y minus 3M", value: 0.874 }], unavailable: [] },
  industry: { participants: [{ name: "SK hynix", symbol: "000660.KS" }, { name: "YMTC", symbol: null }] },
  unavailable: [],
};

test("historical cutoffs refuse current-only snapshots instead of relabelling them", () => {
  const now = new Date("2026-07-27T12:00:00.000Z");
  assert.deepEqual(liveSnapshotPolicy("2026-07-26", { now }), {
    allowed: false,
    reason: "historical_cutoff_requires_archived_fact_pack",
    cutoff_time: "2026-07-26T23:59:59.999Z",
  });
  assert.equal(liveSnapshotPolicy("2026-07-27", { now }).allowed, true);
  assert.equal(liveSnapshotPolicy("2026-07-27T11:59:59.999Z", { now }).allowed, false);
  assert.equal(liveSnapshotPolicy("2026-07-27T12:00:00.000Z", { now }).allowed, true);
  assert.throws(() => liveSnapshotPolicy("2026-07-27T12:00:00", { now }), /as_of must be/);
});

test("historical grounding stays network-free without an explicit point-in-time CIK", async () => {
  const grounding = await gatherGrounding({
    symbol: "NOK",
    asOf: "2026-07-26",
    now: new Date("2026-07-27T12:00:00.000Z"),
  });
  assert.equal(grounding.quote, undefined);
  assert.equal(grounding.options, undefined);
  assert.equal(grounding.macro, undefined);
  assert.equal(grounding.screen, undefined);
  assert.equal(grounding.typed_fact_pack.facts.length, 0);
  assert.ok(grounding.unavailable.some((item) => /explicit point-in-time CIK/.test(item)));
  assert.ok(grounding.unavailable.some((item) => /archived chain/.test(item)));
  assert.ok(grounding.unavailable.some((item) => /archived observations/.test(item)));
});

test("an empty grounding renders nothing rather than an empty heading", () => {
  assert.equal(groundingBlock(null), "");
  assert.equal(groundingBlock({ unavailable: [] }), "");
});

test("headless production gathers grounding instead of taking the prompt fallback", async () => {
  let calls = 0;
  const result = await groundingForHeadlessRun(
    { symbol: "TEST", asOf: "2026-07-27", grounding: null, dryRun: false },
    async (args) => {
      calls += 1;
      assert.deepEqual(args, { symbol: "TEST", asOf: "2026-07-27" });
      return { quote: { price: 10 } };
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, { quote: { price: 10 } });
});

test("headless grounding failure becomes explicit missing facts, never model-memory permission", async () => {
  const result = await groundingForHeadlessRun(
    { symbol: "TEST", asOf: "2026-07-27", grounding: null, dryRun: false },
    async () => { throw new Error("feed unavailable"); },
  );
  assert.equal(result.facts_unavailable, true);
  assert.match(result.unavailable[0], /feed unavailable/);
});

test("quick grounding wait is bounded and becomes an explicit gap", async () => {
  let aborted = false;
  const result = await groundingForHeadlessRun(
    { symbol: "TEST", asOf: "2026-07-27", grounding: null, dryRun: false, timeoutMs: 20 },
    async ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; resolve({ quote: { price: 10 } }); }, { once: true });
    }),
  );
  assert.equal(result.facts_unavailable, true);
  assert.match(result.unavailable[0], /quick grounding timed out after 20ms/);
  assert.equal(aborted, true);
});

test("dry runs stay network-free", async () => {
  const result = await groundingForHeadlessRun(
    { symbol: "TEST", asOf: "2026-07-27", grounding: null, dryRun: true },
    async () => { throw new Error("must not be called"); },
  );
  assert.equal(result, null);
});

test("the block carries the actual figures, not a summary of them", () => {
  const block = groundingBlock(sample, "English");
  assert.match(block, /MICRON TECHNOLOGY INC/);
  assert.match(block, /27\.17%/);
  assert.match(block, /0\.874/);
  assert.match(block, /SK hynix \(000660\.KS\)/);
  assert.match(block, /YMTC \(unlisted\)/, "an unlisted participant must still be named");
});

test("ETF grounding exposes the look-through route and Company Facts as not applicable", () => {
  const grounding = {
    instrument: {
      asset_type: "etf",
      research_model: "fund_lookthrough",
      classification_source: "yahoo_chart_metadata",
      fund_like: true,
    },
    quote: { symbol: "QQQ", price: 600, currency: "USD", source: "yahoo" },
    not_applicable: ["operating-company SEC Company Facts screen: not applicable to etf"],
  };
  const block = groundingBlock(grounding, "English");
  assert.match(block, /Instrument: etf \| research model fund_lookthrough/);
  assert.match(block, /Company Facts screen: not applicable to etf/);
  assert.match(block, /ETF\/fund-specific research contract/);
  assert.match(block, /never add them into ETF revenue or EPS/i);
  const prompt = taskPrompt("earnings_deep_dive", "QQQ", "2026-07-28", "", "English", grounding);
  assert.match(prompt, /dated holdings\/weights/);
  assert.match(prompt, /do not seek fund revenue/i);
});

test("every full-council evidence role receives an ETF-specific assignment", () => {
  const grounding = {
    instrument: {
      asset_type: "etf",
      research_model: "fund_lookthrough",
      classification_source: "yahoo_chart_metadata",
      fund_like: true,
    },
  };
  const expected = {
    market_data: /top-ten and sector concentration/i,
    earnings_deep_dive: /holdings-level earnings look-through/i,
    forward_expectations: /coverage percentage/i,
    quant_factor: /Distinguish the tradable fund from the cash index/i,
    valuation_long_short: /Never add a handful of constituent financial statements/i,
    news_industry_management: /sponsor and index-provider changes/i,
    insider_sec: /Constituent Form 4 filings are issuer activity/i,
    ib_event_analysis: /reconstitution, rebalances/i,
  };
  for (const [task, pattern] of Object.entries(expected)) {
    const prompt = taskPrompt(task, "QQQ", "2026-07-28", "", "English", grounding);
    assert.match(prompt, pattern, task);
    assert.match(prompt, /## etf task override/);
  }
});

// The rules are the point of the block; facts alone would just be more context to
// paraphrase.
test("the block forbids a searched number overwriting a filed one", () => {
  const en = groundingBlock(sample, "English");
  assert.match(en, /never overwrites a filed number/);
  assert.match(en, /report BOTH with their sources/);
  const zh = groundingBlock(sample, "中文");
  assert.match(zh, /不得覆盖申报数字/);
  assert.match(zh, /两个都写出来/);
});

test("a skipped rule is presented as a gap, never as a pass", () => {
  const en = groundingBlock(sample, "English");
  assert.match(en, /NOT treated as passes: dilution/);
  const zh = groundingBlock(sample, "中文");
  assert.match(zh, /未按通过处理：dilution/);
});

test("retrieval failures are surfaced and marked un-fillable from memory", () => {
  const block = groundingBlock({ ...sample, unavailable: ["quote: HTTP 500"] }, "English");
  assert.match(block, /quote: HTTP 500/);
  assert.match(block, /continue through the source ladder/);
  assert.match(block, /never fill them from memory/);
});

test("every item in the frozen adaptive starter pack reaches each analyst prompt", () => {
  const grounding = {
    instrument: {
      asset_type: "equity",
      research_model: "operating_company",
      classification_source: "SEC",
    },
    company_starter_evidence: {
      window_days: 45,
      source_status: "succeeded",
      filings: [{
        form: "8-K",
        filing_date: "2026-08-01",
        accession: "0001652044-26-000001",
        primary_document_url: "https://www.sec.gov/Archives/example.htm",
      }],
      issuer_documents: [{
        title: "Alphabet Investor Relations",
        url: "https://abc.xyz/investor/",
        content_hash: "sha256:fixture",
        excerpt: "Official issuer excerpt unique to the frozen starter pack.",
      }],
      news: [
        {
          topic: "customers_suppliers_capacity",
          title: "First unique dated lead",
          link: "https://example.com/first",
          published_at: "2026-08-04T12:00:00.000Z",
        },
        {
          topic: "regulation_litigation",
          title: "Last unique dated lead",
          link: "https://example.com/last",
          published_at: "2026-08-03T12:00:00.000Z",
        },
      ],
      feed_attempts: [{ ok: true }, { ok: false }],
    },
  };
  const prompt = taskPrompt("news_industry_management", "GOOGL", "2026-08-05", "", "English", grounding);
  assert.match(prompt, /0001652044-26-000001/u);
  assert.match(prompt, /Official issuer excerpt unique/u);
  assert.match(prompt, /First unique dated lead/u);
  assert.match(prompt, /Last unique dated lead/u);
  assert.match(prompt, /feeds 1\/2 succeeded/u);
});

test("the canonical option-chain digest is rendered with its explicit data gaps", () => {
  const block = groundingBlock({
    options: {
      available: true,
      source: "CBOE delayed quotes",
      reference_expiry: { expiry: "2026-08-15", atm_iv: 0.45 },
      skew_25delta: { put_minus_call: 0.0033 },
      open_interest: { calls: 4500, puts: 5300, put_call_ratio: 1.1778 },
      largest_open_interest_strikes: [
        { strike: 90, open_interest: 5000, vs_spot_pct: -10 },
        { strike: 110, open_interest: 4000, vs_spot_pct: 10 },
      ],
      unavailable: ["realised volatility: not in this feed"],
    },
  }, "English");
  assert.match(block, /ATM IV 45\.0%/);
  assert.match(block, /skew 0\.33 vol points/);
  assert.match(block, /Open interest: calls 4,500 \| puts 5,300 \| put\/call OI ratio 1\.1778/);
  assert.match(block, /Largest-OI strikes and concentrations: 90 \(OI 5,000, -10% vs spot\)/);
  assert.match(block, /realised volatility: not in this feed/);
});

test("grounding renders the measured age of a weekend close instead of a fixed 15-minute claim", () => {
  const grounding = {
    quote: {
      symbol: "EXM",
      price: 177.87,
      currency: "USD",
      source: "yahoo",
      quote_time: "2026-07-31T20:00:01.000Z",
      gathered_at: "2026-08-03T08:50:27.762Z",
      stale_age_seconds: 219027,
      stale_age_hours: 60.84,
      quote_basis: "regular_market_price",
      quote_status: "regular_close",
      is_realtime: false,
    },
  };
  const en = groundingBlock(grounding, "English");
  assert.match(en, /Quote \(regular-session close, yahoo\)/);
  assert.match(en, /observed 2026-07-31T20:00:01\.000Z -> gathered 2026-08-03T08:50:27\.762Z/);
  assert.match(en, /measured age 60\.84h/);
  assert.doesNotMatch(en, /15m|15-minute/iu);
  const zh = groundingBlock(grounding, "中文");
  assert.match(zh, /常规交易时段收盘价/);
  assert.match(zh, /实际陈旧 60\.84 小时/);
});

test("grounding exposes the authoritative latest SEC submission and feed coverage", () => {
  const block = groundingBlock({
    filer: {
      name: "EXAMPLE CORP",
      sic: 3674,
      sic_description: "Semiconductors",
      exchanges: ["Nasdaq"],
      submissions_url: "https://data.sec.gov/submissions/CIK0001045810.json",
      submissions_retrieved_at: "2026-08-03T08:50:27.762Z",
      recent_filings_count: 247,
      recent_filings: [{ form: "SCHEDULE 13G" }],
      latest_filing: {
        form: "SCHEDULE 13G",
        filing_date: "2026-07-20",
        accepted_at: "2026-07-20T12:34:56.000Z",
        accession: "0001045810-26-000062",
        primary_document_url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000062/primary.htm",
      },
    },
  }, "English");
  assert.match(block, /Authoritative SEC submissions feed: 247 recent rows; 1 exposed/);
  assert.match(block, /Latest SEC filing by accepted\/filed order \(not search recency\): 2026-07-20 SCHEDULE 13G/);
  assert.match(block, /0001045810-26-000062/);
  assert.match(block, /https:\/\/www\.sec\.gov\/Archives\//);
});

test("grounding reaches the analyst prompt and stays after the role brief", () => {
  const plain = taskPrompt("market_data", "MU", "2026-07-26", "", "en-US");
  const grounded = taskPrompt("market_data", "MU", "2026-07-26", "", "en-US", sample);
  assert.ok(grounded.length > plain.length);
  assert.match(grounded, /Established facts/);
  assert.match(grounded, /27\.17%/);
  // The analyst must know its job before being told what is already settled.
  assert.ok(
    grounded.indexOf("Task: market_data") < grounded.indexOf("Established facts"),
    "the role brief must come before the grounding",
  );
});

test("a prompt without grounding is unchanged, so the golden still holds", () => {
  assert.equal(
    taskPrompt("quant_factor", "MU", "2026-07-26", "", "en-US"),
    taskPrompt("quant_factor", "MU", "2026-07-26", "", "en-US", null),
  );
});

// ---- non-US coverage inside the grounding block ----------------------------

test("names with no structured feed are named, with the rule for citing them", () => {
  const block = groundingBlock({
    quote: { symbol: "2408.TW", price: 100, source: "yahoo" },
    coverage: {
      rows: [
        { symbol: "2408.TW", structured_financials: "summary only" },
        { symbol: "000660.KS", structured_financials: "no" },
        { symbol: "285A.T", structured_financials: "no" },
      ],
    },
    unavailable: [],
  }, "English");
  assert.match(block, /No structured financial feed for: 000660\.KS, 285A\.T/);
  assert.match(block, /primary document you actually read/);
  assert.ok(!block.includes("2408.TW, 000660"), "a summary-only feed is not the same as none");
});

test("a non-US filing is rendered with its currency, unit and calendar", () => {
  const block = groundingBlock({
    quote: { symbol: "2408.TW", price: 100, source: "yahoo" },
    market: {
      financials: {
        source: "TWSE OpenAPI", company_name: "南亞科", currency: "TWD",
        unit: "thousands as filed", gregorian_year: 2026, period: { quarter: 1 },
        revenue: 49086932, gross_profit: 33325482, operating_income: 30111283, eps: 8.41,
      },
    },
    unavailable: [],
  }, "English");
  assert.match(block, /TWSE OpenAPI filing \(2026Q1, TWD thousands as filed\)/);
  assert.match(block, /49,086,932/);
  assert.match(block, /EPS 8\.41/);
});

/**
 * The market's own valuation is a US company's yardstick, and its absence must be visible.
 *
 * Three seats -- Marks, Damodaran and Asness -- require `index.aggregate_earnings_yield`, which
 * describes the market rather than the subject. A build that shipped without the block that
 * fetches it produced runs where those seats declined with `unmet: index.aggregate_earnings_yield`
 * and the grounding said nothing at all, so an unexplained abstention read as a verdict. These
 * tests pin both halves of the contract: a live cutoff enqueues the fetch, and a historical
 * cutoff that cannot serve it names the gap.
 */
test("a historical US company run names the market yardstick it could not fetch", async () => {
  const grounding = await gatherGrounding({
    symbol: "AAPL",
    asOf: "2026-07-26",
    now: new Date("2026-07-27T12:00:00.000Z"),
  });
  assert.equal(grounding.market_valuation, undefined);
  assert.ok(
    grounding.unavailable.some((item) => /market valuation for \^GSPC/.test(item)),
    `historical grounding hid the missing market yardstick: ${JSON.stringify(grounding.unavailable)}`,
  );
});

/**
 * A basket's evidence IS its holdings, so a cutoff that cannot serve them must say so.
 *
 * The fund/index block had the same silence as the market-valuation block above, with more at
 * stake: an operating company keeps its filings and its screen, but a fund whose holdings,
 * look-through aggregates and basket news are all skipped reaches the seats with a price and
 * no account of why nothing else is there.
 */
test("a historical fund run names the holdings and basket news it could not fetch", async () => {
  const grounding = await gatherGrounding({
    symbol: "QQQ",
    asOf: "2026-07-26",
    now: new Date("2026-07-27T12:00:00.000Z"),
  });
  assert.equal(grounding.instrument.fund_like, true);
  assert.equal(grounding.instrument_aggregate, undefined);
  assert.equal(grounding.basket_news, undefined);
  assert.ok(
    grounding.unavailable.some((item) => /holdings, look-through aggregates and basket news for QQQ/.test(item)),
    `historical fund grounding hid its own missing evidence: ${JSON.stringify(grounding.unavailable)}`,
  );
});

/**
 * The market-level facts a company run carries must survive the typed-fact lineage check.
 *
 * Facts reaching the adapter without a `public_at` at or before the cutoff and an https
 * `source_url` are dropped as `missing_source_lineage` and never reach a seat, which is how a
 * whole council once abstained while the grounding looked complete. The shape asserted here is
 * the one `valuationFacts` actually emits for ^GSPC.
 */
test("the market's earnings yield reaches the typed pack and unblocks the seats that need it", () => {
  const asOf = "2026-07-27";
  const marketFact = {
    fact_id: "index.aggregate_earnings_yield",
    value: 0.03973,
    value_kind: "ratio",
    unit: "decimal",
    ratio_denominator: "price",
    source_kind: "market_snapshot",
    source_url: "https://www.wsj.com/market-data/stocks/peyields?type=mdc_peAndYields",
    public_at: "2026-07-24T00:00:00.000Z",
    observation_date: "2026-07-24",
    basis: "wsj_index_basis",
    title: "S&P 500 Index valuation (wsj_index_basis)",
    confidence: 0.8,
    method: "reciprocal_of_wsj_index_basis_trailing_pe",
  };
  const grounding = {
    as_of: asOf,
    gathered_at: "2026-07-27T12:00:00.000Z",
    market_valuation: { symbol: "^GSPC", research_model: "index_aggregate", facts: [marketFact] },
  };

  const adapted = adaptGroundingToTypedFacts(grounding, { asOf });
  const yieldFact = adapted.fact_pack.facts.find((fact) => fact.fact_id === "index.aggregate_earnings_yield");
  assert.ok(yieldFact, "the market earnings yield was dropped before any seat could read it");
  assert.equal(yieldFact.value, 0.03973);
  assert.equal(adapted.diagnostics.length, 0);
  assert.ok(adapted.sources.some((source) => source.url.startsWith("https://")));

  // The same fact without lineage is refused rather than passed on unsourced.
  const unsourced = adaptGroundingToTypedFacts({
    ...grounding,
    market_valuation: { facts: [{ ...marketFact, source_url: null }] },
  }, { asOf });
  assert.equal(unsourced.fact_pack.facts.length, 0);
  assert.deepEqual(unsourced.diagnostics.map((item) => item.code), ["missing_source_lineage"]);

  // What the seats actually see: the yardstick leaves their unmet list.
  const unmetFor = (typedPack) => {
    const plan = planMasterSeats({ symbol: "AAPL", as_of: asOf, grounding: { typed_fact_pack: typedPack } },
      ["master_damodaran", "master_marks", "master_asness"]);
    return Object.fromEntries([...plan.completed, ...plan.declined, ...plan.blocked]
      .map((seat) => [seat.id, seat.preDecision?.eligibility?.missing_required_fact_types || []]));
  };
  const without = unmetFor(adaptGroundingToTypedFacts({ as_of: asOf }, { asOf }).fact_pack);
  const with_ = unmetFor(adapted.fact_pack);
  for (const seat of ["master_damodaran", "master_marks", "master_asness"]) {
    assert.ok(
      without[seat].includes("index.aggregate_earnings_yield"),
      `${seat} was expected to require the market earnings yield`,
    );
    assert.ok(
      !with_[seat].includes("index.aggregate_earnings_yield"),
      `${seat} still reports the market earnings yield as unmet: ${JSON.stringify(with_[seat])}`,
    );
  }
});
