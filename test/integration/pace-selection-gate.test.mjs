import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

function legacySelectionHash(receipt) {
  const payload = {
    schema_version: receipt.schema_version,
    selection_receipt: receipt.selection_receipt,
    selection_id: receipt.selection_id,
    symbol: receipt.symbol,
    council_mode: receipt.council_mode,
    catalog_hash: receipt.catalog_hash,
    request_hash: receipt.request_hash,
    intent_hash: receipt.intent_hash,
    selected_master_ids: receipt.selected_master_ids,
    selected_master_pack_hashes: receipt.selected_master_pack_hashes,
    selection_mode: receipt.selection_mode,
    created_at: receipt.created_at,
    expires_at: receipt.expires_at,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function selectionFiles(confirmed) {
  return {
    selection: join(dataDir, "selections", `${confirmed.selection_id}.json`),
    receipt: join(dataDir, "selections", "receipts", `${confirmed.selection_receipt}.json`),
  };
}

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
    ...(mode === "quick" ? {} : { analyst_scope: "core" }),
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
  assert.deepEqual(opened.pace_options.map((option) => option.expected_minutes), [13, 22, 58]);
  assert.deepEqual(opened.pace_options.map((option) => option.hard_ceiling_minutes), [15, 30, 60]);
  assert.deepEqual(opened.pace_options.filter((option) => option.is_default).map((o) => o.pace), ["normal"]);
});

test("the tier chosen at the gate binds into the receipt and reaches the run", async () => {
  const { confirmed, prompt } = await gate({ choice: "slow" });
  assert.equal(structured(confirmed).council_pace, "slow");
  assert.equal(structured(confirmed).selection_hash_version, 3);
  // Omitted at execution: the gate's decision is what runs.
  const result = structured(await run(structured(confirmed).selection_receipt, prompt));
  assert.equal(result.run.council_pace, "slow");
  assert.equal(result.run.time_budget_ms, COUNCIL_PACES.slow.total_ms);
});

test("an omitted execution pace validates a 40-minute timeout against the slow receipt", async () => {
  const gated = await gate({ choice: "slow" });
  const receipt = structured(gated.confirmed).selection_receipt;
  const result = structured(await run(receipt, gated.prompt, {
    total_timeout_ms: 40 * 60 * 1000,
  }));
  assert.equal(result.run.council_pace, "slow");
  assert.equal(result.run.time_budget_ms, 40 * 60 * 1000);
});

test("an omitted execution pace rejects 20 minutes for fast without consuming the receipt", async () => {
  const gated = await gate({ choice: "fast" });
  const receipt = structured(gated.confirmed).selection_receipt;
  const rejected = await run(receipt, gated.prompt, {
    total_timeout_ms: 20 * 60 * 1000,
  });
  assert.equal(rejected.error?.data?.reason, "FULL_TOTAL_TIMEOUT_EXCEEDS_MAX");
  assert.equal(rejected.error?.data?.council_pace, "fast");
  assert.equal(rejected.error?.data?.maximum_ms, COUNCIL_PACES.fast.total_ms);

  const retried = structured(await run(receipt, gated.prompt, {
    total_timeout_ms: COUNCIL_PACES.fast.total_ms,
  }));
  assert.equal(retried.run.council_pace, "fast");
  assert.equal(retried.run.time_budget_ms, COUNCIL_PACES.fast.total_ms);
});

test("a still-valid legacy v1 receipt remains consumable across the hash upgrade", async () => {
  const gated = await gate({ choice: "fast" });
  const confirmed = structured(gated.confirmed);
  const files = selectionFiles(confirmed);
  const selection = JSON.parse(readFileSync(files.selection, "utf8"));
  const receipt = JSON.parse(readFileSync(files.receipt, "utf8"));

  delete selection.selection_hash_version;
  delete receipt.selection_hash_version;
  receipt.selection_hash = legacySelectionHash(receipt);
  writeFileSync(files.selection, `${JSON.stringify(selection, null, 2)}\n`);
  writeFileSync(files.receipt, `${JSON.stringify(receipt, null, 2)}\n`);

  const result = structured(await run(confirmed.selection_receipt, gated.prompt));
  assert.equal(result.run.council_pace, "fast");
  assert.equal(result.run.master_selection.selection_hash_version, 1);
});

test("v2 detects a pace mutation even when both local records were changed together", async () => {
  const gated = await gate({ choice: "fast" });
  const confirmed = structured(gated.confirmed);
  const files = selectionFiles(confirmed);
  const selection = JSON.parse(readFileSync(files.selection, "utf8"));
  const receipt = JSON.parse(readFileSync(files.receipt, "utf8"));
  selection.council_pace = "slow";
  receipt.council_pace = "slow";
  writeFileSync(files.selection, `${JSON.stringify(selection, null, 2)}\n`);
  writeFileSync(files.receipt, `${JSON.stringify(receipt, null, 2)}\n`);

  const rejected = await run(confirmed.selection_receipt, gated.prompt);
  assert.equal(rejected.error?.data?.reason, "MASTER_SELECTION_HASH_MISMATCH");
});

test("v2 rejects a missing quick pace field instead of treating it as null", async () => {
  const gated = await gate({ mode: "quick" });
  const confirmed = structured(gated.confirmed);
  const files = selectionFiles(confirmed);
  const selection = JSON.parse(readFileSync(files.selection, "utf8"));
  const receipt = JSON.parse(readFileSync(files.receipt, "utf8"));
  delete selection.council_pace;
  delete receipt.council_pace;
  writeFileSync(files.selection, `${JSON.stringify(selection, null, 2)}\n`);
  writeFileSync(files.receipt, `${JSON.stringify(receipt, null, 2)}\n`);

  seq += 1;
  const rejected = await server.callTool("analyze_symbol", {
    symbol: "NOW", language: "zh-CN", prompt: gated.prompt, council_mode: "quick",
    run_id: `GATE-QUICK-MISSING-PACE-${seq}-${process.pid}`, dry_run: true,
    wait_for_completion: true, selection_receipt: confirmed.selection_receipt,
  }, { timeoutMs: 60_000 });
  assert.equal(rejected.error?.data?.reason, "MASTER_SELECTION_HASH_MISMATCH");
});

test("legacy v1 still requires an explicit pace field on both records", async () => {
  const gated = await gate({ mode: "quick" });
  const confirmed = structured(gated.confirmed);
  const files = selectionFiles(confirmed);
  const selection = JSON.parse(readFileSync(files.selection, "utf8"));
  const receipt = JSON.parse(readFileSync(files.receipt, "utf8"));
  delete selection.selection_hash_version;
  delete receipt.selection_hash_version;
  delete selection.council_pace;
  delete receipt.council_pace;
  receipt.selection_hash = legacySelectionHash(receipt);
  writeFileSync(files.selection, `${JSON.stringify(selection, null, 2)}\n`);
  writeFileSync(files.receipt, `${JSON.stringify(receipt, null, 2)}\n`);

  seq += 1;
  const rejected = await server.callTool("analyze_symbol", {
    symbol: "NOW", language: "zh-CN", prompt: gated.prompt, council_mode: "quick",
    run_id: `GATE-QUICK-V1-MISSING-PACE-${seq}-${process.pid}`, dry_run: true,
    wait_for_completion: true, selection_receipt: confirmed.selection_receipt,
  }, { timeoutMs: 60_000 });
  assert.equal(rejected.error?.data?.reason, "MASTER_SELECTION_RECORD_MISMATCH");
  assert.ok(rejected.error?.data?.mismatched_fields.includes("council_pace"));
});

test("legacy v1 full receipts cannot replace the confirmed pace with null in both records", async () => {
  const gated = await gate({ choice: "fast" });
  const confirmed = structured(gated.confirmed);
  const files = selectionFiles(confirmed);
  const selection = JSON.parse(readFileSync(files.selection, "utf8"));
  const receipt = JSON.parse(readFileSync(files.receipt, "utf8"));
  delete selection.selection_hash_version;
  delete receipt.selection_hash_version;
  selection.council_pace = null;
  receipt.council_pace = null;
  receipt.selection_hash = legacySelectionHash(receipt);
  writeFileSync(files.selection, `${JSON.stringify(selection, null, 2)}\n`);
  writeFileSync(files.receipt, `${JSON.stringify(receipt, null, 2)}\n`);

  const rejected = await run(confirmed.selection_receipt, gated.prompt);
  assert.equal(rejected.error?.data?.reason, "MASTER_SELECTION_RECORD_MISMATCH");
  assert.ok(rejected.error?.data?.mismatched_fields.includes("council_pace"));
});

test("an explicit null hash version is invalid rather than a legacy fallback", async () => {
  const gated = await gate({ choice: "fast" });
  const confirmed = structured(gated.confirmed);
  const files = selectionFiles(confirmed);
  const selection = JSON.parse(readFileSync(files.selection, "utf8"));
  const receipt = JSON.parse(readFileSync(files.receipt, "utf8"));
  selection.selection_hash_version = null;
  receipt.selection_hash_version = null;
  writeFileSync(files.selection, `${JSON.stringify(selection, null, 2)}\n`);
  writeFileSync(files.receipt, `${JSON.stringify(receipt, null, 2)}\n`);

  const rejected = await run(confirmed.selection_receipt, gated.prompt);
  assert.equal(rejected.error?.data?.reason, "MASTER_SELECTION_HASH_VERSION_UNSUPPORTED");
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

test("an already confirmed selection cannot be replayed with another pace", async () => {
  seq += 1;
  const prompt = `Confirm one pace only (${seq}).`;
  const opened = structured(await server.callTool("begin_council_selection", {
    symbol: "NOW", language: "zh-CN", host: "claude-code", prompt, council_mode: "full",
  }));
  const first = structured(await server.callTool("confirm_master_selection", {
    selection_id: opened.selection_id,
    catalog_hash: opened.catalog_hash,
    display_ack: true,
    selected_master_ids: ["master_marks"],
    council_pace: "fast",
    analyst_scope: "core",
  }));
  const changed = await server.callTool("confirm_master_selection", {
    selection_id: opened.selection_id,
    catalog_hash: opened.catalog_hash,
    display_ack: true,
    selected_master_ids: ["master_marks"],
    council_pace: "slow",
    analyst_scope: "core",
  });
  assert.ok(changed.error);
  assert.equal(changed.error.data.reason, "MASTER_SELECTION_ALREADY_CONFIRMED");
  assert.equal(changed.error.data.confirmed_council_pace, "fast");
  assert.equal(changed.error.data.submitted_council_pace, "slow");

  const replay = structured(await server.callTool("confirm_master_selection", {
    selection_id: opened.selection_id,
    catalog_hash: opened.catalog_hash,
    display_ack: true,
    selected_master_ids: ["master_marks"],
    council_pace: "fast",
    analyst_scope: "core",
  }));
  assert.equal(replay.selection_receipt, first.selection_receipt);
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

  // The rejected call must not consume the receipt; a new run id can still use the approved pace.
  const ok = structured(await run(receipt, prompt, { council_pace: "fast" }));
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
