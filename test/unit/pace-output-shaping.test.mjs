import { test } from "node:test";
import assert from "node:assert/strict";

import { COUNCIL_PACE_NAMES } from "../../mcp/lib/constants.mjs";
import { debatePrompt, masterVoicePrompt, paceShapingInstruction, taskPrompt } from "../../mcp/lib/prompts.mjs";

/**
 * A tier is a timeout, and a timeout is not a plan.
 *
 * The three depth tiers shipped with the same prompt for all of them, so `fast` asked a worker
 * for the identical output with 40% less time. That does not buy a faster good packet; it buys
 * one the worker could not finish, arriving as `degraded` or not at all. For an LLM call the wall
 * clock is dominated by generated tokens, so running faster without losing information means
 * asking for the same information in less prose.
 *
 * The line every tier holds: claims, figures, scoped source IDs, required report sections and the
 * decision are never what gets cut.
 */

const run = (pace) => ({
  run_id: "SHAPE", symbol: "NOW", as_of: "2026-07-30", language: "中文", packets: [], council_pace: pace,
});
const enRun = (pace) => ({ ...run(pace), language: "English" });

test("the default tier's prompts are byte-identical to no tier at all", () => {
  // The reviewed prompt golden is captured without a pace. If `normal` added a single character
  // the golden would drift on every task and role, and the drift would be meaningless.
  for (const task of ["market_data", "insider_sec"]) {
    assert.equal(
      taskPrompt(task, "NOW", "2026-07-30", "", "中文", null, "normal"),
      taskPrompt(task, "NOW", "2026-07-30", "", "中文", null),
      task,
    );
  }
  for (const role of ["bull_researcher", "bear_researcher", "portfolio_manager"]) {
    assert.equal(debatePrompt(role, run("normal"), {}), debatePrompt(role, run(undefined), {}), role);
  }
  assert.equal(paceShapingInstruction("normal", "bull_researcher", true), "");
  assert.equal(paceShapingInstruction(undefined, "bull_researcher", true), "");
});

test("fast and slow reach every worker prompt, in the run's language", () => {
  for (const pace of ["fast", "slow"]) {
    const zh = debatePrompt("bull_researcher", run(pace), {});
    const en = debatePrompt("bull_researcher", enRun(pace), {});
    assert.match(zh, new RegExp(`${pace} 档`), `zh debate ${pace}`);
    assert.match(en, new RegExp(`${pace} tier`), `en debate ${pace}`);

    assert.match(taskPrompt("market_data", "NOW", "2026-07-30", "", "中文", null, pace), new RegExp(`${pace} 档`));
    assert.match(taskPrompt("market_data", "NOW", "2026-07-30", "", "en-US", null, pace), new RegExp(`${pace} tier`));

    const voice = masterVoicePrompt("master_buffett", enRun(pace), { stance: "out_of_scope", verdict: "v", summary: "s" });
    assert.match(voice, new RegExp(`${pace} tier`), `master voice ${pace}`);
  }
});

test("out-of-scope guidance blocks only the seat's own trade action, not evidence vocabulary", () => {
  const voice = masterVoicePrompt("master_forensic_short", enRun("fast"), {
    stance: "out_of_scope", verdict: "v", summary: "s",
  });
  assert.match(voice, /never couple this method's first-person subject/u);
  assert.match(voice, /short interest or sell-side consensus.*remain allowed/u);
  assert.match(voice, /third-party recommendations.*remain allowed/u);
  assert.match(voice, /Do not write 'I would not buy\/sell\/short/u);
  assert.doesNotMatch(voice, /Avoid these literal action words/u);
});

test("fast compresses prose and never the evidence discipline", () => {
  for (const chinese of [true, false]) {
    const text = paceShapingInstruction("fast", "bull_researcher", chinese);
    // What must survive: the figure, the scoped source ID, and the refusal to fill from memory.
    assert.match(text, chinese ? /作用域来源 ID/ : /scoped source ID/);
    assert.match(text, chinese ? /<task>:S<n>/ : /<task>:S<n>/);
    assert.match(text, chinese ? /凭记忆补数字则永远不可接受/ : /filling a number from memory never is/);
    // What gets cut: restatement, not content.
    assert.match(text, chinese ? /不要复述证据原文/ : /Do not re-quote evidence/);
    assert.match(text, chinese ? /压缩的是叙述，不是内容/ : /Compress the prose, not the content/);
    // Dropping an argument is allowed; shortening all of them into fragments is not.
    assert.match(text, chinese ? /其余舍弃而不是缩写成半句/ : /drop the rest rather than shortening/);
  }
});

test("fast never lets the report shed a section, and protects the actionable parts", () => {
  // The report gate requires every contract section with a minimum body. If fast shaping told
  // the PM to be brief without this, a fast run would fail its own report gate.
  for (const chinese of [true, false]) {
    const pm = paceShapingInstruction("fast", "portfolio_manager", chinese);
    assert.match(pm, chinese ? /必需章节仍必须齐备/ : /must still be present and non-empty/);
    assert.match(pm, chinese ? /简洁只能来自散文，不能来自删章节/ : /terseness comes out of prose, never out of sections/);
    assert.match(pm, chinese ? /价位阶梯与失效条件不得压缩成一句话/ : /Price levels and invalidation conditions may not be compressed/);
    // The argument cap belongs to a debater, not to the report.
    assert.doesNotMatch(pm, chinese ? /论点条数上限/ : /At most 6 arguments/);
  }
  const debater = paceShapingInstruction("fast", "bull_researcher", false);
  assert.match(debater, /At most 6 arguments/);
});

test("slow buys derivation depth, not permission to repeat itself", () => {
  for (const chinese of [true, false]) {
    const text = paceShapingInstruction("slow", "bear_researcher", chinese);
    assert.match(text, chinese ? /多步推算要逐步写出/ : /step by step/);
    assert.match(text, chinese ? /证伪条件/ : /falsification conditions/);
    // The failure mode of a big budget is padding, so the tier says so itself.
    assert.match(text, chinese ? /更长不等于更好/ : /Longer is not better/);
  }
});

test("quick keeps its own shaping instead of receiving a tier's", () => {
  // Quick already tells its single round to give 4-6 arguments and skip the long report. Adding
  // a tier's shaping on top would be two different length budgets in one prompt.
  const quickRun = { ...run("fast"), council_mode: "quick" };
  const text = debatePrompt("bull_researcher", quickRun, {});
  assert.doesNotMatch(text, /fast 档/);
  assert.match(text, /4–6 条论点|4-6 highest-information/);
});

test("an unknown tier shapes nothing rather than inventing a budget", () => {
  for (const value of ["glacial", "", null, undefined, 7]) {
    assert.equal(paceShapingInstruction(value, "bull_researcher", true), "");
  }
  // Every shipped name is either silent (normal) or shapes (fast, slow).
  const shaping = COUNCIL_PACE_NAMES.map((name) => paceShapingInstruction(name, "bull_researcher", false));
  assert.equal(shaping.filter((text) => text.length > 0).length, 2);
});
