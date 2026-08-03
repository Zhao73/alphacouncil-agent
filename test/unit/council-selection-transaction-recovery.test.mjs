import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeJson } from "../../mcp/lib/fsutil.mjs";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";

const dataDir = makeDataDir();
const previousDataDir = process.env.ALPHACOUNCIL_AGENT_DATA_DIR;
process.env.ALPHACOUNCIL_AGENT_DATA_DIR = dataDir;

const moduleUrl = new URL("../../mcp/lib/council-selection.mjs", import.meta.url);
let restartSequence = 0;

async function restartSelectionModule() {
  restartSequence += 1;
  return import(`${moduleUrl.href}?transaction-restart=${restartSequence}`);
}

const initialModule = await restartSelectionModule();

after(() => {
  removeDataDir(dataDir);
  if (previousDataDir === undefined) delete process.env.ALPHACOUNCIL_AGENT_DATA_DIR;
  else process.env.ALPHACOUNCIL_AGENT_DATA_DIR = previousDataDir;
});

function selectionFile(selectionId) {
  return join(dataDir, "selections", `${selectionId}.json`);
}

function receiptFile(receiptId) {
  return join(dataDir, "selections", "receipts", `${receiptId}.json`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function failWrite(number, { afterCommit = false, capture } = {}) {
  let writes = 0;
  return {
    writeJson(path, value, options) {
      writes += 1;
      capture?.({ writes, path, value: structuredClone(value) });
      if (writes === number && !afterCommit) throw new Error(`injected write failure ${number}`);
      writeJson(path, value, options);
      if (writes === number && afterCommit) throw new Error(`injected post-commit failure ${number}`);
    },
  };
}

function v2ReceiptHash(receipt) {
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
    selection_hash_version: receipt.selection_hash_version,
    council_pace: receipt.council_pace,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function openSelection(api, suffix, now) {
  const prompt = `transaction recovery fixture ${suffix}`;
  const opened = api.beginCouncilSelection({
    symbol: "MSFT",
    language: "en-US",
    prompt,
    host: "transaction-test",
    council_mode: "full",
  }, { now });
  const confirmation = {
    selection_id: opened.selection_id,
    catalog_hash: opened.catalog_hash,
    display_ack: true,
    selected_master_ids: ["master_buffett", "master_taleb"],
    council_pace: "fast",
  };
  return { opened, confirmation, prompt };
}

test("confirmation keeps one stable receipt id even when the first durable write fails", async () => {
  const now = Date.parse("2026-08-03T01:00:00.000Z");
  const { opened, confirmation } = openSelection(initialModule, "confirm-first", now);
  let preparedSelection;

  assert.throws(
    () => initialModule.confirmCouncilSelection(confirmation, {
      now: now + 1_000,
      io: failWrite(1, {
        capture: ({ writes, value }) => {
          if (writes === 1) preparedSelection = value;
        },
      }),
    }),
    /injected write failure 1/u,
  );
  assert.match(preparedSelection.selection_receipt, /^RCP-[0-9a-f-]{36}$/iu);
  assert.equal(readJson(selectionFile(opened.selection_id)).status, "awaiting_user_selection");

  const restarted = await restartSelectionModule();
  const recovered = restarted.confirmCouncilSelection(confirmation, { now: now + 2_000 });
  assert.equal(recovered.selection_receipt, preparedSelection.selection_receipt);
  const receipt = readJson(receiptFile(recovered.selection_receipt));
  assert.equal(receipt.selection_hash, v2ReceiptHash(receipt));
});

test("confirmation rebuilds the exact bound receipt after its second write fails", async () => {
  const now = Date.parse("2026-08-03T02:00:00.000Z");
  const { opened, confirmation } = openSelection(initialModule, "confirm-second", now);

  assert.throws(
    () => initialModule.confirmCouncilSelection(confirmation, {
      now: now + 1_000,
      io: failWrite(2),
    }),
    /injected write failure 2/u,
  );
  const prepared = readJson(selectionFile(opened.selection_id));
  assert.equal(prepared.status, "confirmed");
  assert.equal(prepared.receipt_recovery.authority, "selection_record");
  assert.equal(prepared.receipt_recovery.selection_receipt, prepared.selection_receipt);
  assert.equal(existsSync(receiptFile(prepared.selection_receipt)), false);

  const restarted = await restartSelectionModule();
  const recovered = restarted.confirmCouncilSelection(confirmation, { now: now + 2_000 });
  assert.equal(recovered.selection_receipt, prepared.selection_receipt);
  const receipt = readJson(receiptFile(recovered.selection_receipt));
  assert.equal(receipt.selection_hash, v2ReceiptHash(receipt));
  assert.equal(receipt.selection_hash, prepared.receipt_recovery.selection_hash);
  assert.deepEqual(receipt.selected_master_ids, prepared.selected_master_ids);
  assert.deepEqual(receipt.selected_master_pack_hashes, recovered.selected_master_pack_hashes);
  assert.equal(receipt.council_pace, "fast");

  const replay = restarted.confirmCouncilSelection(confirmation, { now: now + 3_000 });
  assert.equal(replay.selection_receipt, recovered.selection_receipt);
  assert.deepEqual(readJson(receiptFile(recovered.selection_receipt)), receipt);

  assert.throws(
    () => restarted.confirmCouncilSelection({ ...confirmation, council_pace: "slow" }, { now: now + 4_000 }),
    (error) => error?.data?.reason === "MASTER_SELECTION_ALREADY_CONFIRMED",
  );
  assert.throws(
    () => restarted.confirmCouncilSelection({
      ...confirmation,
      selected_master_ids: ["master_buffett"],
    }, { now: now + 5_000 }),
    (error) => error?.data?.reason === "MASTER_SELECTION_ALREADY_CONFIRMED",
  );
});

test("consumption repairs a receipt-first split only for the same bound run", async () => {
  const now = Date.parse("2026-08-03T03:00:00.000Z");
  const { opened, confirmation, prompt } = openSelection(initialModule, "consume-second", now);
  const confirmed = initialModule.confirmCouncilSelection(confirmation, { now: now + 1_000 });
  const runId = "SELECTION-TRANSACTION-RECOVERY-A";
  const consume = {
    selection_receipt: confirmed.selection_receipt,
    symbol: "MSFT",
    language: "en-US",
    prompt,
    council_mode: "full",
    council_pace: "fast",
    run_id: runId,
  };

  assert.throws(
    () => initialModule.consumeCouncilSelection(consume, {
      now: now + 2_000,
      io: failWrite(2),
    }),
    /injected write failure 2/u,
  );
  const splitReceipt = readJson(receiptFile(confirmed.selection_receipt));
  const splitSelection = readJson(selectionFile(opened.selection_id));
  assert.equal(splitReceipt.status, "consumed");
  assert.equal(splitReceipt.consumed_by_run_id, runId);
  assert.equal(splitReceipt.selection_hash, v2ReceiptHash(splitReceipt));
  assert.equal(splitSelection.status, "confirmed");

  const restarted = await restartSelectionModule();
  assert.throws(
    () => restarted.consumeCouncilSelection({ ...consume, prompt: `${prompt} changed` }, { now: now + 3_000 }),
    (error) => error?.data?.reason === "MASTER_SELECTION_INTENT_MISMATCH",
  );
  assert.equal(readJson(selectionFile(opened.selection_id)).status, "confirmed", "binding failure must not repair state");

  const recovered = restarted.consumeCouncilSelection(consume, { now: now + 4_000 });
  assert.equal(recovered.status, "consumed");
  assert.equal(recovered.consumed_by_run_id, runId);
  const repairedSelection = readJson(selectionFile(opened.selection_id));
  const repairedReceipt = readJson(receiptFile(confirmed.selection_receipt));
  assert.equal(repairedSelection.status, "consumed");
  assert.equal(repairedSelection.consumed_by_run_id, runId);
  assert.equal(repairedSelection.consumed_at, repairedReceipt.consumed_at);
  assert.deepEqual(repairedReceipt, splitReceipt, "repair must not rewrite the authoritative receipt");
  assert.equal(repairedReceipt.selection_hash, v2ReceiptHash(repairedReceipt));

  const idempotent = restarted.consumeCouncilSelection(consume, { now: now + 5_000 });
  assert.equal(idempotent.consumed_by_run_id, runId);
  assert.throws(
    () => restarted.consumeCouncilSelection({ ...consume, run_id: "SELECTION-TRANSACTION-RECOVERY-B" }, {
      now: now + 6_000,
    }),
    (error) => error?.data?.reason === "MASTER_SELECTION_REPLAYED"
      && error?.data?.consumed_by_run_id === runId,
  );
});

test("a pre-expiry partial consumption remains recoverable by the same run after TTL", async () => {
  const now = Date.parse("2026-08-03T04:00:00.000Z");
  const { opened, confirmation, prompt } = openSelection(initialModule, "consume-after-expiry", now);
  const confirmed = initialModule.confirmCouncilSelection(confirmation, { now: now + 1_000 });
  const expiresAt = Date.parse(opened.expires_at);
  const runId = "SELECTION-TRANSACTION-RECOVERY-AFTER-TTL";
  const consume = {
    selection_receipt: confirmed.selection_receipt,
    symbol: "MSFT",
    language: "en-US",
    prompt,
    council_mode: "full",
    council_pace: "fast",
    run_id: runId,
  };

  assert.throws(
    () => initialModule.consumeCouncilSelection(consume, {
      now: expiresAt - 1_000,
      io: failWrite(2),
    }),
    /injected write failure 2/u,
  );
  const originalReceipt = readJson(receiptFile(confirmed.selection_receipt));
  assert.equal(originalReceipt.status, "consumed");
  assert.ok(Date.parse(originalReceipt.consumed_at) <= expiresAt);
  assert.equal(readJson(selectionFile(opened.selection_id)).status, "confirmed");

  const restarted = await restartSelectionModule();
  writeJson(receiptFile(confirmed.selection_receipt), {
    ...originalReceipt,
    consumed_at: new Date(expiresAt + 1).toISOString(),
  });
  assert.throws(
    () => restarted.consumeCouncilSelection(consume, { now: expiresAt + 60 * 60 * 1_000 }),
    (error) => error?.data?.reason === "MASTER_SELECTION_RECORD_MISMATCH"
      && error?.data?.mismatched_fields.includes("receipt.consumed_at_after_expires_at"),
  );
  assert.equal(
    readJson(selectionFile(opened.selection_id)).status,
    "confirmed",
    "an invalid partial audit must fail closed without marking the selection expired",
  );

  writeJson(receiptFile(confirmed.selection_receipt), originalReceipt);
  const recovered = restarted.consumeCouncilSelection(consume, { now: expiresAt + 60 * 60 * 1_000 });
  assert.equal(recovered.status, "consumed");
  assert.equal(recovered.consumed_by_run_id, runId);
  const repairedSelection = readJson(selectionFile(opened.selection_id));
  assert.equal(repairedSelection.status, "consumed");
  assert.equal(repairedSelection.consumed_at, originalReceipt.consumed_at);
  assert.equal(repairedSelection.consumed_by_run_id, runId);

  const idempotent = restarted.consumeCouncilSelection(consume, { now: expiresAt + 2 * 60 * 60 * 1_000 });
  assert.equal(idempotent.consumed_by_run_id, runId);
  assert.throws(
    () => restarted.consumeCouncilSelection({ ...consume, run_id: `${runId}-OTHER` }, {
      now: expiresAt + 2 * 60 * 60 * 1_000,
    }),
    (error) => error?.data?.reason === "MASTER_SELECTION_REPLAYED"
      && error?.data?.consumed_by_run_id === runId,
  );
});
