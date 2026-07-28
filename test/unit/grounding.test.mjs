import { test } from "node:test";
import assert from "node:assert/strict";
import { gatherGrounding, groundingBlock, liveSnapshotPolicy } from "../../mcp/lib/grounding.mjs";
import { groundingForHeadlessRun } from "../../mcp/lib/orchestrator.mjs";
import { taskPrompt } from "../../mcp/lib/prompts.mjs";

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
  assert.match(block, /must NOT be filled from memory/);
});

test("the canonical option-chain digest is rendered with its explicit data gaps", () => {
  const block = groundingBlock({
    options: {
      available: true,
      source: "CBOE delayed quotes",
      reference_expiry: { expiry: "2026-08-15", atm_iv: 0.45 },
      skew_25delta: { put_minus_call: 0.0033 },
      unavailable: ["realised volatility: not in this feed"],
    },
  }, "English");
  assert.match(block, /ATM IV 45\.0%/);
  assert.match(block, /skew 0\.33 vol points/);
  assert.match(block, /realised volatility: not in this feed/);
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
