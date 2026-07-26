import { test } from "node:test";
import assert from "node:assert/strict";
import { groundingBlock } from "../../mcp/lib/grounding.mjs";
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

test("an empty grounding renders nothing rather than an empty heading", () => {
  assert.equal(groundingBlock(null), "");
  assert.equal(groundingBlock({ unavailable: [] }), "");
});

test("the block carries the actual figures, not a summary of them", () => {
  const block = groundingBlock(sample, "English");
  assert.match(block, /MICRON TECHNOLOGY INC/);
  assert.match(block, /27\.17%/);
  assert.match(block, /0\.874/);
  assert.match(block, /SK hynix \(000660\.KS\)/);
  assert.match(block, /YMTC \(unlisted\)/, "an unlisted participant must still be named");
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
