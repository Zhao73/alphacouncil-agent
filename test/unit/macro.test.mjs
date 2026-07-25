import { test } from "node:test";
import assert from "node:assert/strict";
import { MACRO_BLOCKS } from "../../mcp/lib/macro.mjs";
import { resolveMarketSymbol } from "../../mcp/lib/quotes.mjs";

// Offline: the suite must never hit the network. Live behaviour is exercised by hand.

test("every macro block declares why it matters, in both languages", () => {
  assert.ok(MACRO_BLOCKS.length >= 5);
  for (const block of MACRO_BLOCKS) {
    assert.match(block.id, /^[a-z_]+$/);
    // Chinese is dense: a complete title like 利率曲线 is four characters.
    for (const [field, min] of [["title", 2], ["why", 12]]) {
      assert.ok(block[field].zh?.length >= min, `${block.id}.${field} needs Chinese`);
      assert.ok(block[field].en?.length >= min, `${block.id}.${field} needs English`);
    }
    assert.ok(block.members.length >= 3, `${block.id} needs enough members to read a trend`);
  }
});

test("macro symbols are raw tickers, not aliases that could silently remap", () => {
  for (const block of MACRO_BLOCKS) {
    for (const member of block.members) {
      assert.equal(
        resolveMarketSymbol(member.symbol),
        member.symbol,
        `${member.symbol} is also an alias key; the snapshot must pin raw tickers`,
      );
      assert.ok(member.label?.length, `${member.symbol} needs a human label`);
    }
  }
});

test("block ids are unique and every derived pair has both legs present", () => {
  const ids = MACRO_BLOCKS.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length);
  const symbols = new Set(MACRO_BLOCKS.flatMap((b) => b.members.map((m) => m.symbol)));
  // Each derived measure is a ratio or spread; both legs must be fetchable together.
  for (const [a, b] of [["^TNX", "^IRX"], ["^TYX", "^FVX"], ["HG=F", "GC=F"], ["HYG", "LQD"], ["RSP", "SPY"]]) {
    assert.ok(symbols.has(a) && symbols.has(b), `derived pair ${a}/${b} is missing a leg`);
  }
});

test("an unknown block is rejected rather than silently ignored", async () => {
  const { getMacroSnapshot } = await import("../../mcp/lib/macro.mjs");
  await assert.rejects(() => getMacroSnapshot({ blocks: ["not_a_block"] }), /unknown macro block/);
});
