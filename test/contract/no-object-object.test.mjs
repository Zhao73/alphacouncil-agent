import { test } from "node:test";
import assert from "node:assert/strict";
import { groundingBlock } from "../../mcp/lib/grounding.mjs";
import { table, groundingDashboard } from "../../mcp/lib/tables.mjs";
import { weightTableMarkdown, resolveSeatWeights } from "../../mcp/lib/weights.mjs";
import { explainResult } from "../../mcp/lib/screen.mjs";
import { withCompletenessBanner, withVerificationBanner } from "../../mcp/lib/gates.mjs";

/**
 * A whole class of defect, guarded in one place.
 *
 * Labels in this codebase are {en, zh} objects. Any one of them reaching a template
 * literal renders as "[object Object]" -- which sits next to real numbers and reads as a
 * broken field rather than a missing one, so a reader distrusts the surrounding data
 * without being able to say what is wrong. It shipped in the grounding block's skipped-rule
 * list and in its macro readings, and it was invisible until a run was actually inspected.
 *
 * Fixing the two instances is not the fix. This is: every renderer, in both languages,
 * against fixtures whose labels are objects, asserting the string never appears.
 */

const LANGS = ["中文", "English"];

const GROUNDING = {
  as_of: "2026-07-26",
  quote: { symbol: "MU", price: 920.95, currency: "USD", change_pct: -6.99, source: "yahoo" },
  filer: { name: "MICRON TECHNOLOGY INC", sic: "3674", sic_description: "Semiconductors", exchanges: ["Nasdaq"] },
  screen: {
    verdict: "survives",
    rules_computed: 6,
    rules_total: 7,
    // Object labels everywhere -- this is the shape that actually ships.
    metrics: [
      { label: { en: "10-year average ROE", zh: "10年平均ROE" }, value: 10.03, unit: "%", threshold: 8, direction: "min", passed: true },
      { label: { en: "interest cover", zh: "利息保障倍数" }, value: 25.18, unit: "x", threshold: 2, direction: "min", passed: true },
    ],
    skipped: [{ rule: "dilution", label: { en: "5-year share dilution", zh: "5年股本稀释" } }, "ocf_ni"],
  },
  macro: {
    derived: [
      { id: "spread_10y_3m", label: { en: "10Y minus 3M", zh: "10年期减3个月" }, value: 0.874 },
      { id: "copper_gold", label: { en: "Copper / gold", zh: "铜金比" }, value: 0.001562 },
    ],
  },
  coverage: { rows: [], summary: { full: 1, summary_only: 0, none: 0 } },
  unavailable: [],
};

const hasObjectObject = (text) => String(text).includes("[object Object]");

test("groundingBlock renders every bilingual label in both languages", () => {
  for (const lang of LANGS) {
    const out = groundingBlock(GROUNDING, lang);
    assert.ok(!hasObjectObject(out), `groundingBlock leaked an object label in ${lang}:\n${out}`);
    assert.ok(out.length > 100, "the block must not be empty");
    // Both shipped shapes of a skipped rule must render. Rendering neither would print an
    // empty list, which reads as "nothing was skipped" -- the opposite of the line's job.
    assert.match(out, /ocf_ni/, "a bare-string skipped rule must render");
    assert.match(out, lang === "中文" ? /5年股本稀释/ : /5-year share dilution/, "an object skipped rule must render");
  }
});

test("the screen explanation renders object labels", () => {
  const result = {
    verdict: "eliminated",
    failures: [
      { label: { en: "5-year cumulative free cash flow", zh: "5年累计自由现金流" }, value: -33.5, unit: "bn", threshold: 0, years: 5 },
    ],
    exemptions: [{ rule: "dilution", reason: "acquisition-funded" }],
    skipped_count: 1,
    rules: [{}],
  };
  assert.ok(!hasObjectObject(explainResult(result, "INTC")));
});

test("the weight table renders seat labels", () => {
  const run = { masters: ["master_buffett", "master_munger"], tasks: ["market_data"], verifier_verdicts: [] };
  const weights = resolveSeatWeights(run);
  const out = weightTableMarkdown(weights);
  assert.ok(!hasObjectObject(out), `weight table leaked an object label:\n${out}`);
});

test("banners render the seats they name", () => {
  const status = {
    completeness: "incomplete",
    missing_evidence: ["market_data"],
    missing_debate: ["portfolio_manager"],
    missing_masters: ["master_marks"],
  };
  for (const lang of LANGS) {
    assert.ok(!hasObjectObject(withCompletenessBanner("body", status, lang)));
    assert.ok(!hasObjectObject(withVerificationBanner("body", { verification: "failed", missing_claim_source_ids: ["a:S1"] }, lang)));
  }
});

test("the table helper renders an object cell rather than stringifying it", () => {
  // The generic renderer is the last line of defence: whatever reaches a cell must not
  // arrive as "[object Object]", because at that point no caller can be blamed for it.
  const out = table(["A", "B"], [[{ en: "x", zh: "叉" }, 1]], { title: "t" });
  assert.ok(!hasObjectObject(out), `table() stringified an object cell:\n${out}`);
});

test("the grounding dashboard renders in both languages", () => {
  for (const lang of LANGS) {
    const out = groundingDashboard(GROUNDING, lang);
    assert.ok(!hasObjectObject(out), `dashboard leaked an object label in ${lang}:\n${out}`);
  }
});
