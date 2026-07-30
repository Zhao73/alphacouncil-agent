import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { COUNCIL_PACES } from "../../mcp/lib/constants.mjs";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { startServer, structured } from "../helpers/rpc-client.mjs";

/**
 * The depth tier is asked at the selection gate, not typed as an argument.
 *
 * It is the second decision the gate takes, so it travels inside the receipt and is checked at
 * consumption like every other bound field: a user who approved fifteen minutes must not end up
 * running an hour, and the reverse must not happen either. A tier's total is a ceiling rather
 * than a forecast, so the menu publishes both — given only the ceiling a reader treats it as the
 * estimate and expects every fast run to take fifteen minutes.
 */

let dataDir;
let server;
let seq = 0;

before(async () => {
  dataDir = makeDataDir();
  server = startServer({ dataDir });
  await server.request("initialize", {});
});

after(async () => {
  await server.close();
  removeDataDir(dataDir);
});

async function gate({ prefill, choice, mode = "full" } = {}) {
  seq += 1;
  const prompt = `Analyse NOW at the gate (${seq}).`;
  const opened = structured(await server.callTool("begin_council_selection", {
    symbol: "NOW", language: "zh-CN", host: "claude-code", prompt, council_mode: mode,
    ...(prefill ? { council_pace: prefill } : {}),
  }));
  const confirmed = await server.callTool("confirm_master_selection", {
    selection_id: opened.selection_id,
    catalog_hash: opened.catalog_hash,
    display_ack: true,
    selected_master_ids: ["master_marks"],
    ...(choice ? { council_pace: choice } : {}),
  });
  return { opened, confirmed, prompt };
}

async function run(receipt, prompt, extra = {}) {
  seq += 1;
  return server.callTool("analyze_symbol", {
    symbol: "NOW", language: "zh-CN", prompt, council_mode: "full",
    run_id: `GATE-PACE-${seq}-${process.pid}`, dry_run: true, wait_for_completion: true,
    grounding: { facts_unavailable: true }, selection_receipt: receipt, ...extra,
  }, { timeoutMs: 60_000 });
}

test("the gate offers every tier with both its estimate and its ceiling", async () => {
  const { opened } = await gate();
  assert.equal(opened.pace_options.length, 3);
  assert.equal(opened.default_council_pace, "normal");
  assert.equal(opened.preselected_council_pace, null);

  for (const option of opened.pace_options) {
    const profile = COUNCIL_PACES[option.pace];
    assert.ok(profile, option.pace);
    assert.equal(option.hard_ceiling_ms, profile.total_ms);
    assert.equal(option.hard_ceiling_minutes, Math.round(profile.total_ms / 60000));
    // The estimate must be strictly below the ceiling, or publishing both says nothing.
    assert.ok(option.expected_ms < option.hard_ceiling_ms, option.pace);
    assert.ok(option.expected_minutes >= 1);
    // A user choosing a tier needs to see what the extra time is spent on.
    assert.ok(option.buys.zh.includes("证据席"), option.pace);
    assert.ok(option.buys.en.includes("evidence seat"), option.pace);
    assert.equal(option.debate_seconds_per_round, Math.round(profile.debate_ms / 1000));
  }
  assert.deepEqual(opened.pace_options.map((option) => option.expected_minutes), [12, 20, 44]);
  assert.deepEqual(opened.pace_options.map((option) => option.hard_ceiling_minutes), [15, 30, 60]);
  assert.deepEqual(opened.pace_options.filter((option) => option.is_default).map((o) => o.pace), ["normal"]);
});

test("the tier chosen at the gate binds into the receipt and reaches the run", async () => {
  const { confirmed, prompt } = await gate({ choice: "slow" });
  assert.equal(structured(confirmed).council_pace, "slow");
  // Omitted at execution: the gate's decision is what runs.
  const result = structured(await run(structured(confirmed).selection_receipt, prompt));
  assert.equal(result.run.council_pace, "slow");
  assert.equal(result.run.time_budget_ms, COUNCIL_PACES.slow.total_ms);
});

test("a named speed is a prefill the user can accept or overrule", async () => {
  // Same doctrine as a named master: the argument highlights a row, it never confirms one.
  const { opened, confirmed } = await gate({ prefill: "fast" });
  assert.equal(opened.preselected_council_pace, "fast");
  assert.equal(structured(confirmed).council_pace, "fast", "an unchanged prefill is accepted");

  const overruled = await gate({ prefill: "fast", choice: "slow" });
  assert.equal(structured(overruled.confirmed).council_pace, "slow", "the user's answer wins");

  const plain = await gate();
  assert.equal(structured(plain.confirmed).council_pace, "normal", "no answer means the default");
});

test("execution cannot switch the tier the user approved", async () => {
  const { confirmed, prompt } = await gate({ choice: "fast" });
  const receipt = structured(confirmed).selection_receipt;
  const response = await run(receipt, prompt, { council_pace: "slow" });
  assert.ok(response.error, "approving 15 minutes and running an hour must fail closed");
  assert.equal(response.error.data.reason, "COUNCIL_PACE_RECEIPT_MISMATCH");
  assert.equal(response.error.data.confirmed_council_pace, "fast");
  assert.equal(response.error.data.submitted_council_pace, "slow");
  assert.match(response.error.data.remedy, /start a new selection/);

  // Repeating the approved tier is fine; only changing it is not.
  const repeat = await gate({ choice: "fast" });
  const ok = structured(await run(structured(repeat.confirmed).selection_receipt, repeat.prompt, { council_pace: "fast" }));
  assert.equal(ok.run.council_pace, "fast");
});

test("quick has no tier to offer and refuses one", async () => {
  const { opened, confirmed } = await gate({ mode: "quick" });
  assert.deepEqual(opened.pace_options, []);
  assert.equal(opened.default_council_pace, null);
  assert.equal(structured(confirmed).council_pace, null);

  const rejected = await gate({ mode: "quick", choice: "slow" });
  assert.ok(rejected.confirmed.error);
  assert.equal(rejected.confirmed.error.data.reason, "QUICK_PACE_FORBIDDEN");
});

test("an unrecognised answer is rejected and the menu is offered again", async () => {
  const { confirmed } = await gate({ choice: "glacial" });
  assert.ok(confirmed.error);
  assert.equal(confirmed.error.data.reason, "INVALID_COUNCIL_PACE");
  assert.deepEqual(confirmed.error.data.allowed, ["fast", "normal", "slow"]);
  // Re-offering the menu is what lets the host re-ask rather than guess.
  assert.equal(confirmed.error.data.pace_options.length, 3);
});
