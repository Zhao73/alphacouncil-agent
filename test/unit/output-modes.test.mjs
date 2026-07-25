import { test } from "node:test";
import assert from "node:assert/strict";
import { summaryModes, outputModeInstruction } from "../../mcp/lib/output-modes.mjs";
import { OUTPUT_MODES } from "../../mcp/lib/constants.mjs";

const CJK = /[㐀-鿿぀-ヿ]/;

test("the mode list carries no self-described non-investment modes", () => {
  assert.deepEqual(
    OUTPUT_MODES,
    ["chat", "documents", "pdf", "presentations", "data_analytics", "public_equity", "investment_banking"],
  );
  assert.deepEqual(summaryModes().map((m) => m.mode), OUTPUT_MODES);
  assert.ok(!summaryModes().some((m) => m.fit === "not_for_investment_summary"));
});

// best_for/effect were Chinese-only strings interpolated straight into English prompts.
test("an English PM prompt contains no Chinese mode copy", () => {
  for (const mode of OUTPUT_MODES) {
    const instruction = outputModeInstruction(mode, "English");
    assert.ok(!CJK.test(instruction), `mode ${mode} leaked CJK into an English prompt:\n${instruction}`);
  }
});

test("a Chinese PM prompt uses the Chinese mode copy", () => {
  const instruction = outputModeInstruction("public_equity", "中文");
  assert.match(instruction, /最终报告语言：中文/);
  assert.ok(CJK.test(instruction));
});

test("summaryModes switches language for every mode", () => {
  const en = summaryModes("English");
  const zh = summaryModes("中文");
  assert.equal(en.length, zh.length);
  for (const [index, mode] of en.entries()) {
    assert.ok(!CJK.test(mode.best_for), `${mode.mode}.best_for must be English`);
    assert.ok(!CJK.test(mode.effect), `${mode.mode}.effect must be English`);
    assert.ok(CJK.test(zh[index].best_for), `${mode.mode}.best_for must have Chinese copy`);
  }
});

test("a retired mode name degrades to public_equity instead of erroring", () => {
  for (const retired of ["sales", "product_design", "creative_production", "nonsense"]) {
    const instruction = outputModeInstruction(retired, "English");
    assert.match(instruction, /Final output mode: public_equity/);
  }
});
