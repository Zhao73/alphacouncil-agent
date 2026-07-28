import { test } from "node:test";
import assert from "node:assert/strict";

import { userResponseMarkdown } from "../../mcp/lib/markdown.mjs";

function run(language, summary) {
  return {
    run_id: "BOUNDARY-1",
    symbol: "RKLB",
    language,
    packets: [{ task: "earnings_deep_dive", summary }],
  };
}

function manager(verdict = "bounded verdict") {
  return {
    rating: "Hold",
    winner: "balanced",
    confidence: "medium",
    verdict,
    valuation_range: "not available",
    position: "watch",
    invalidation: [],
  };
}

test("Chinese handoff summaries truncate at a sentence boundary", () => {
  const sentence = "这是一个完整句子。";
  const markdown = userResponseMarkdown(run("zh-CN", sentence.repeat(100)), manager());
  const line = markdown.split("\n").find((item) => item.startsWith("- 最新财报:"));
  assert.match(line, /。…$/u);
});

test("English handoff summaries truncate at a sentence boundary", () => {
  const sentence = "This sentence ends cleanly with verified evidence. ";
  const markdown = userResponseMarkdown(run("English", sentence.repeat(100)), manager());
  const line = markdown.split("\n").find((item) => item.startsWith("- Latest earnings:"));
  assert.match(line, /[.!?]…$/u);
});

test("handoff truncation never leaves an unpaired Unicode surrogate", () => {
  const markdown = userResponseMarkdown(run("zh-CN", "已核验。"), manager("🚀".repeat(800)));
  const line = markdown.split("\n").find((item) => item.startsWith("- 判断:"));
  const unpaired = [...line].some((character) => {
    if (character.length !== 1) return false;
    const code = character.charCodeAt(0);
    return code >= 0xD800 && code <= 0xDFFF;
  });
  assert.equal(unpaired, false);
  assert.match(line, /…$/u);
});

test("a failed manager path never becomes a synthetic Hold in the full handoff", () => {
  const markdown = userResponseMarkdown(run("English", "bounded evidence"), {
    ...manager("NEEDS_MANAGER_REVIEW"),
    decision_available: false,
    rating: null,
  });
  assert.match(markdown, /Rating: unavailable/);
  assert.match(markdown, /NEEDS_MANAGER_REVIEW/);
  assert.doesNotMatch(markdown, /Rating: Hold/);
});
