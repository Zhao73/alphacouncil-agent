import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { confirmMasterSelection, startServer, structured } from "../helpers/rpc-client.mjs";
import { DEFAULT_TASKS } from "../../mcp/lib/constants.mjs";
import { RpcCode } from "../../mcp/lib/errors.mjs";

let dataDir;
let server;

function idempotencyEvidencePacket(task) {
  const packet = {
    summary: `${task} state that must survive an idempotent replay of this fund fixture.`,
    claims: [{
      claim: `The ${task} idempotency fixture records one bounded fund observation.`,
      claim_type: "event_or_observation",
      evidence: "The dated fixture source directly supports the bounded observation.",
      confidence: "medium",
      source_ids: ["S1"],
    }],
    metrics: {},
    sources: [{
      id: "S1",
      title: `${task} idempotent selection fixture source`,
      url: `https://example.com/selection-idempotency-${task}`,
      published_at: "2026-08-01",
      retrieved_at: "2026-08-03",
    }],
    open_questions: [],
    confidence: "medium",
  };
  return packet;
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

test("all council entry points fail closed before a selection receipt", async () => {
  for (const name of ["plan_visible_run", "collect_evidence", "analyze_symbol"]) {
    const response = await server.callTool(name, { symbol: "AAPL", dry_run: true });
    assert.equal(response.error?.code, RpcCode.INVALID_PARAMS, name);
    assert.equal(response.error?.data?.reason, "MASTER_SELECTION_REQUIRED", name);
  }
  assert.equal(existsSync(join(dataDir, "runs")), false, "a rejected start must not create a run directory");
});

test("opening a selection returns a text-complete individual catalog without starting research", async () => {
  const response = await server.callTool("begin_council_selection", {
    symbol: "AAPL",
    language: "zh-CN",
    host: "codex",
    preselected_master_ids: ["master_buffett"],
  });
  const opened = structured(response);
  assert.equal(opened.status, "awaiting_user_selection");
  assert.ok(opened.masters.length >= 21);
  assert.equal(opened.minimum, 1);
  assert.equal(opened.maximum, opened.masters.length);
  assert.deepEqual(opened.preselected_master_ids, ["master_buffett"]);
  assert.match(opened.intent_hash, /^[a-f0-9]{64}$/);
  assert.ok(opened.masters.every((master) => master.index && master.id && master.identity && master.method && master.best_for));
  const text = response.result.content[0].text;
  assert.match(text, /1\. /);
  assert.match(text, /身份:/);
  assert.match(text, /all 全选/);
  assert.match(text, /\[已预选\]/);
  const context = JSON.parse(text.match(/^ALPHACOUNCIL_SELECTION_CONTEXT (\{.*\})$/m)?.[1] || "null");
  assert.deepEqual(context, {
    selection_id: opened.selection_id,
    catalog_hash: opened.catalog_hash,
    intent_hash: opened.intent_hash,
    expires_at: opened.expires_at,
    council_mode: "full",
    analyst_options: [{ scope: "core", count: 8 }, { scope: "all", count: 11 }],
  });
  assert.equal(existsSync(join(dataDir, "runs")), false);
});

test("selection and confirmation text use the requested supported language", async () => {
  const cases = [
    { language: "zh-CN", resolved: "中文", labels: [/身份:/, /方法:/, /适合:/, /成熟度:/, /提交选择后才会开始研究。/] },
    { language: "ja-JP", resolved: "日本語", labels: [/人物像:/, /手法:/, /適した対象:/, /成熟度:/, /選択を送信するまで調査は開始されません。/] },
    { language: "ko-KR", resolved: "한국어", labels: [/정체성:/, /방법:/, /적합 대상:/, /성숙도:/, /선택을 제출하기 전에는 조사를 시작하지 않습니다./] },
    { language: "en-US", resolved: "English", labels: [/Identity:/, /Method:/, /Best for:/, /Maturity:/, /Research starts only after this selection is submitted./] },
  ];

  for (const { language, resolved, labels } of cases) {
    const openedResponse = await server.callTool("begin_council_selection", {
      symbol: "QQQ",
      language,
      host: "codex",
      prompt: `locale handshake ${language}`,
    });
    const opened = structured(openedResponse);
    const openedText = openedResponse.result.content[0].text;
    for (const label of labels) assert.match(openedText, label, language);

    const confirmedResponse = await server.callTool("confirm_master_selection", {
      selection_id: opened.selection_id,
      catalog_hash: opened.catalog_hash,
      display_ack: true,
      selected_master_ids: ["master_buffett"],
      analyst_scope: "core",
    });
    const confirmed = structured(confirmedResponse);
    assert.equal(confirmed.language, resolved);
    const confirmedText = confirmedResponse.result.content[0].text;
    if (language === "zh-CN") assert.match(confirmedText, /分别确认 1 个方法席与 8 个分析席/);
    else if (language === "ja-JP") assert.match(confirmedText, /メソッド1席と分析担当8席/);
    else if (language === "ko-KR") assert.match(confirmedText, /방법론 1개 좌석과 분석가 8개 좌석/);
    else assert.match(confirmedText, /Confirmed 1 method seat\(s\) and 8 analyst seat\(s\)/);
  }
});

test("auto infers the prompt language and binds the same canonical locale through receipt consumption", async () => {
  const prompt = "QQQ を完全に分析し、各メソッド席の発言を表示してください。";
  const opened = structured(await server.callTool("begin_council_selection", {
    symbol: "QQQ", language: "auto", host: "codex", prompt,
  }));
  assert.equal(opened.language, "日本語");
  const confirmed = structured(await server.callTool("confirm_master_selection", {
    selection_id: opened.selection_id,
    catalog_hash: opened.catalog_hash,
    display_ack: true,
    selected_master_ids: ["master_buffett"],
    analyst_scope: "core",
  }));
  assert.equal(confirmed.language, "日本語");
  const runId = `SELECTION-AUTO-LOCALE-${process.pid}`;
  const planned = structured(await server.callTool("plan_visible_run", {
    symbol: "QQQ",
    language: "auto",
    prompt,
    run_id: runId,
    grounding: { facts_unavailable: true },
    selection_receipt: confirmed.selection_receipt,
  }));
  assert.equal(planned.run.language, "日本語");
  assert.equal(planned.run.master_selection.status, "consumed");
});

test("an omitted language is inferred consistently at selection and receipt consumption", async () => {
  const prompt = "请完整分析 QQQ，并显示每个分析师和大师方法席的中文发言。";
  const opened = structured(await server.callTool("begin_council_selection", {
    symbol: "QQQ", host: "codex", prompt,
  }));
  assert.equal(opened.language, "中文");
  const confirmed = structured(await server.callTool("confirm_master_selection", {
    selection_id: opened.selection_id,
    catalog_hash: opened.catalog_hash,
    display_ack: true,
    selected_master_ids: ["master_buffett"],
    analyst_scope: "core",
  }));
  assert.equal(confirmed.language, "中文");
  const runId = `SELECTION-OMITTED-LOCALE-${process.pid}`;
  const planned = structured(await server.callTool("plan_visible_run", {
    symbol: "QQQ",
    prompt,
    run_id: runId,
    grounding: { facts_unavailable: true },
    selection_receipt: confirmed.selection_receipt,
  }));
  assert.equal(planned.run.language, "中文");
  assert.equal(planned.run.master_selection.status, "consumed");
});

test("text-only MCP hosts can complete the selection handshake without structuredContent", async () => {
  const runsDir = join(dataDir, "runs");
  const runCountBefore = existsSync(runsDir) ? readdirSync(runsDir).length : 0;
  const openedResponse = await server.callTool("begin_council_selection", {
    symbol: "MELI",
    language: "English",
    host: "grok",
  });
  const openedText = openedResponse.result.content[0].text;
  const openedContext = JSON.parse(
    openedText.match(/^ALPHACOUNCIL_SELECTION_CONTEXT (\{.*\})$/m)?.[1] || "null",
  );
  assert.match(openedContext.selection_id, /^SEL-/);
  assert.match(openedContext.catalog_hash, /^[a-f0-9]{64}$/);
  assert.match(openedContext.intent_hash, /^[a-f0-9]{64}$/);

  const confirmedResponse = await server.callTool("confirm_master_selection", {
    selection_id: openedContext.selection_id,
    catalog_hash: openedContext.catalog_hash,
    display_ack: true,
    selected_master_ids: ["master_buffett"],
    analyst_scope: "core",
  });
  const confirmed = structured(confirmedResponse);
  const confirmedText = confirmedResponse.result.content[0].text;
  const confirmedContext = JSON.parse(
    confirmedText.match(/^ALPHACOUNCIL_CONFIRMATION_CONTEXT (\{.*\})$/m)?.[1] || "null",
  );
  assert.deepEqual(confirmedContext, {
    selection_id: confirmed.selection_id,
    selection_receipt: confirmed.selection_receipt,
    catalog_hash: confirmed.catalog_hash,
    intent_hash: confirmed.intent_hash,
    council_mode: "full",
    analyst_scope: "core",
    selected_analyst_count: 8,
  });
  assert.match(confirmedContext.selection_receipt, /^RCP-/);
  const runCountAfter = existsSync(runsDir) ? readdirSync(runsDir).length : 0;
  assert.equal(runCountAfter, runCountBefore, "selection and confirmation must not create a research run");
});

test("one selected master is frozen into the run and the receipt cannot create another run", async () => {
  const selection = await confirmMasterSelection(server, {
    symbol: "MSFT",
    selected_master_ids: ["master_buffett"],
  });
  const runId = `SELECTION-ONE-${process.pid}`;
  const planned = structured(await server.callTool("plan_visible_run", {
    symbol: "MSFT",
    run_id: runId,
    tasks: ["market_data"],
    grounding: { facts_unavailable: true },
    selection_receipt: selection.selection_receipt,
  }));
  assert.deepEqual(planned.run.masters, ["master_buffett"]);
  assert.equal(planned.run.master_selection.catalog_hash, selection.catalog_hash);
  assert.match(selection.selected_master_pack_hashes.master_buffett, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(planned.run.master_selection.selected_master_pack_hashes, selection.selected_master_pack_hashes);

  const status = JSON.parse(readFileSync(join(dataDir, "runs", runId, "status.json"), "utf8"));
  assert.equal(status.selected_master_count, 1);
  assert.equal(status.master_selection_status, "consumed");

  const replayId = `SELECTION-REPLAY-${process.pid}`;
  const replay = await server.callTool("plan_visible_run", {
    symbol: "MSFT",
    run_id: replayId,
    tasks: ["market_data"],
    grounding: { facts_unavailable: true },
    selection_receipt: selection.selection_receipt,
  });
  assert.equal(replay.error?.data?.reason, "MASTER_SELECTION_REPLAYED");
  assert.equal(existsSync(join(dataDir, "runs", replayId)), false);
});

test("a tampered per-seat pack hash is rejected before the receipt is consumed", async () => {
  const selection = await confirmMasterSelection(server, {
    symbol: "AMD",
    selected_master_ids: ["master_buffett"],
  });
  const receiptPath = join(dataDir, "selections", "receipts", `${selection.selection_receipt}.json`);
  const original = JSON.parse(readFileSync(receiptPath, "utf8"));
  const tampered = structuredClone(original);
  tampered.selected_master_pack_hashes.master_buffett = `sha256:${"0".repeat(64)}`;
  writeFileSync(receiptPath, `${JSON.stringify(tampered, null, 2)}\n`);

  const rejectedRunId = `SELECTION-PACK-HASH-REJECT-${process.pid}`;
  const rejected = await server.callTool("plan_visible_run", {
    symbol: "AMD",
    run_id: rejectedRunId,
    tasks: ["market_data"],
    grounding: { facts_unavailable: true },
    selection_receipt: selection.selection_receipt,
  });
  assert.equal(rejected.error?.data?.reason, "MASTER_SELECTION_HASH_MISMATCH");
  assert.equal(existsSync(join(dataDir, "runs", rejectedRunId)), false);

  // Restore the exact confirmed receipt. The failed integrity check must not burn it.
  writeFileSync(receiptPath, `${JSON.stringify(original, null, 2)}\n`);
  const accepted = await server.callTool("plan_visible_run", {
    symbol: "AMD",
    run_id: `SELECTION-PACK-HASH-VALID-${process.pid}`,
    tasks: ["market_data"],
    grounding: { facts_unavailable: true },
    selection_receipt: selection.selection_receipt,
  });
  assert.ok(accepted.result);
});

test("a tampered selection hash fails closed without burning the receipt", async () => {
  const selection = await confirmMasterSelection(server, {
    symbol: "ADBE",
    selected_master_ids: ["master_buffett", "master_taleb"],
  });
  const file = join(dataDir, "selections", "receipts", `${selection.selection_receipt}.json`);
  const original = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, `${JSON.stringify({ ...original, selection_hash: "0".repeat(64) }, null, 2)}\n`);

  const rejectedRunId = `SELECTION-HASH-REJECT-${process.pid}`;
  const rejected = await server.callTool("plan_visible_run", {
    symbol: "ADBE",
    run_id: rejectedRunId,
    tasks: ["market_data"],
    grounding: { facts_unavailable: true },
    selection_receipt: selection.selection_receipt,
  });
  assert.equal(rejected.error?.data?.reason, "MASTER_SELECTION_HASH_MISMATCH");
  assert.equal(existsSync(join(dataDir, "runs", rejectedRunId)), false);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).status, "confirmed");

  writeFileSync(file, `${JSON.stringify(original, null, 2)}\n`);
  const accepted = await server.callTool("plan_visible_run", {
    symbol: "ADBE",
    run_id: `SELECTION-HASH-VALID-${process.pid}`,
    tasks: ["market_data"],
    grounding: { facts_unavailable: true },
    selection_receipt: selection.selection_receipt,
  });
  assert.ok(accepted.result, "restoring the valid hash must leave the receipt usable");
});

test("a receipt file swapped across selection records is rejected without consuming either record", async () => {
  const first = await confirmMasterSelection(server, {
    symbol: "AMZN",
    selected_master_ids: ["master_buffett"],
  });
  const second = await confirmMasterSelection(server, {
    symbol: "AMZN",
    selected_master_ids: ["master_taleb"],
  });
  const firstFile = join(dataDir, "selections", "receipts", `${first.selection_receipt}.json`);
  const secondFile = join(dataDir, "selections", "receipts", `${second.selection_receipt}.json`);
  const firstRecord = JSON.parse(readFileSync(firstFile, "utf8"));
  const secondRecord = JSON.parse(readFileSync(secondFile, "utf8"));
  writeFileSync(firstFile, `${JSON.stringify(secondRecord, null, 2)}\n`);

  const rejectedRunId = `SELECTION-CROSS-RECORD-REJECT-${process.pid}`;
  const rejected = await server.callTool("plan_visible_run", {
    symbol: "AMZN",
    run_id: rejectedRunId,
    tasks: ["market_data"],
    grounding: { facts_unavailable: true },
    selection_receipt: first.selection_receipt,
  });
  assert.equal(rejected.error?.data?.reason, "MASTER_SELECTION_RECORD_MISMATCH");
  assert.deepEqual(rejected.error?.data?.mismatched_fields, ["selection_receipt"]);
  assert.equal(existsSync(join(dataDir, "runs", rejectedRunId)), false);
  assert.equal(JSON.parse(readFileSync(secondFile, "utf8")).status, "confirmed");

  writeFileSync(firstFile, `${JSON.stringify(firstRecord, null, 2)}\n`);
  const accepted = await server.callTool("plan_visible_run", {
    symbol: "AMZN",
    run_id: `SELECTION-CROSS-RECORD-VALID-${process.pid}`,
    tasks: ["market_data"],
    grounding: { facts_unavailable: true },
    selection_receipt: first.selection_receipt,
  });
  assert.ok(accepted.result, "the first receipt must remain usable after restoring its own record");
});

test("the same consumed receipt is idempotent only for the same run id", async () => {
  // This test targets receipt idempotency, not operating-company research. Use an explicit
  // fund classification instead of inventing a one-seat company dossier for ORCL.
  const selection = await confirmMasterSelection(server, { symbol: "QQQ", selection: "1" });
  const runId = `SELECTION-IDEMPOTENT-${process.pid}`;
  const args = {
    symbol: "QQQ",
    run_id: runId,
    tasks: DEFAULT_TASKS,
    grounding: {
      facts_unavailable: true,
      instrument: {
        asset_type: "etf",
        research_model: "fund_lookthrough",
        classification_source: "selection_idempotency_fixture",
      },
    },
    selection_receipt: selection.selection_receipt,
  };
  const first = await server.callTool("plan_visible_run", args);
  const firstPlan = structured(first);
  assert.equal(firstPlan.run.grounding.instrument.research_model, "fund_lookthrough");
  const recordedEvidence = structured(await server.callTool("record_visible_packet", {
    run_id: runId,
    task: "market_data",
    packet: idempotencyEvidencePacket("market_data"),
  }));
  assert.deepEqual(recordedEvidence.recorded_tasks, ["market_data"]);

  const selectedMaster = selection.selected_master_ids[0];
  const frozen = firstPlan.run.master_opinions.find((opinion) => opinion.master === selectedMaster);
  assert.ok(frozen, "the selected v3 method must have a frozen deterministic record");
  assert.equal(firstPlan.run.master_status[selectedMaster].status, "waiting");
  const second = await server.callTool("plan_visible_run", args);
  const replay = structured(second);
  assert.ok(firstPlan.run);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.run.packets.length, 1, "retry must not reset partial evidence");
  assert.equal(replay.run.master_opinions.length, 1, "retry must not reset the frozen master opinion");
  assert.equal(replay.run.master_status[selectedMaster].status, "waiting", "replay must not bypass the evidence barrier");
});

test("ten seats and all seats materialize in stable catalog order", async () => {
  const ten = await confirmMasterSelection(server, { symbol: "TSM", selection: "1-10" });
  assert.equal(ten.selected_count, 10);
  assert.equal(new Set(ten.selected_master_ids).size, 10);

  const all = await confirmMasterSelection(server, { symbol: "TSM", select_all: true });
  const opened = structured(await server.callTool("begin_council_selection", { symbol: "TSM" }));
  assert.equal(all.selected_count, opened.maximum);
  assert.deepEqual(all.selected_master_ids, opened.masters.map((master) => master.id));
});

test("legacy master arguments cannot override or bypass the confirmed selection", async () => {
  const noReceipt = await server.callTool("plan_visible_run", {
    symbol: "IBM",
    masters: ["master_buffett"],
  });
  assert.equal(noReceipt.error?.data?.reason, "MASTER_SELECTION_REQUIRED");

  const selection = await confirmMasterSelection(server, { symbol: "IBM" });
  const override = await server.callTool("plan_visible_run", {
    symbol: "IBM",
    run_id: `SELECTION-OVERRIDE-${process.pid}`,
    masters: ["master_simons"],
    selection_receipt: selection.selection_receipt,
  });
  assert.equal(override.error?.data?.reason, "MASTER_SELECTION_OVERRIDE_FORBIDDEN");
});

test("a receipt cannot be moved to a different prompt intent for the same symbol", async () => {
  const selection = await confirmMasterSelection(server, {
    symbol: "ADBE",
    prompt: "Long-term ownership case",
  });
  const mismatch = await server.callTool("plan_visible_run", {
    symbol: "ADBE",
    prompt: "Short-term event trade",
    run_id: `SELECTION-INTENT-${process.pid}`,
    selection_receipt: selection.selection_receipt,
  });
  assert.equal(mismatch.error?.data?.reason, "MASTER_SELECTION_INTENT_MISMATCH");
  assert.equal(existsSync(join(dataDir, "runs", `SELECTION-INTENT-${process.pid}`)), false);
});

test("an invalid run id is rejected without burning the receipt", async () => {
  const selection = await confirmMasterSelection(server, { symbol: "CRM" });
  const invalid = await server.callTool("plan_visible_run", {
    symbol: "CRM",
    run_id: "../../escape",
    selection_receipt: selection.selection_receipt,
  });
  assert.equal(invalid.error?.code, RpcCode.INVALID_PARAMS);
  assert.match(invalid.error?.message || "", /run_id is invalid/);

  const valid = await server.callTool("plan_visible_run", {
    symbol: "CRM",
    run_id: `SELECTION-VALID-AFTER-ERROR-${process.pid}`,
    tasks: ["market_data"],
    grounding: { facts_unavailable: true },
    selection_receipt: selection.selection_receipt,
  });
  assert.ok(valid.result, "the receipt should remain usable after pre-consumption validation fails");
});

test("headless visibility validation happens before receipt consumption", async () => {
  const selection = await confirmMasterSelection(server, { symbol: "INTC" });
  const blocked = await server.callTool("collect_evidence", {
    symbol: "INTC",
    visibility_required: true,
    selection_receipt: selection.selection_receipt,
  });
  assert.equal(blocked.error?.data?.reason, "VISIBLE_EXECUTION_REQUIRED");

  const planned = await server.callTool("plan_visible_run", {
    symbol: "INTC",
    run_id: `SELECTION-AFTER-PREFLIGHT-${process.pid}`,
    tasks: ["market_data"],
    grounding: { facts_unavailable: true },
    selection_receipt: selection.selection_receipt,
  });
  assert.ok(planned.result, "a pre-consumption validation error must not burn the receipt");
});

test("full analyze_symbol cannot masquerade as a complete council with synthesis disabled", async () => {
  const selection = await confirmMasterSelection(server, { symbol: "CSCO" });
  const blocked = await server.callTool("analyze_symbol", {
    symbol: "CSCO",
    synthesis: false,
    dry_run: true,
    tasks: ["market_data"],
    selection_receipt: selection.selection_receipt,
  });
  assert.equal(blocked.error?.data?.reason, "FULL_SYNTHESIS_REQUIRED");
  assert.equal(blocked.error?.data?.alternative_tool, "collect_evidence");

  const evidenceOnly = await server.callTool("collect_evidence", {
    symbol: "CSCO",
    run_id: `SELECTION-EVIDENCE-ONLY-${process.pid}`,
    dry_run: true,
    tasks: ["market_data"],
    selection_receipt: selection.selection_receipt,
  });
  assert.ok(evidenceOnly.result, "pre-consumption synthesis rejection must leave the receipt usable by collect_evidence");
  const evidenceOnlyStatus = JSON.parse(readFileSync(
    join(dataDir, "runs", `SELECTION-EVIDENCE-ONLY-${process.pid}`, "status.json"),
    "utf8",
  ));
  assert.equal(evidenceOnlyStatus.report_contract, "evidence_only_v1");
  assert.equal(evidenceOnlyStatus.full_council_equivalent, false);
  assert.equal(evidenceOnlyStatus.master_worker_contract, "not_requested_evidence_only");
});

test("visible full planning rejects synthesis overrides before consuming the receipt", async () => {
  const selection = await confirmMasterSelection(server, { symbol: "TXN" });
  const blocked = await server.callTool("plan_visible_run", {
    symbol: "TXN",
    synthesis: false,
    tasks: ["market_data"],
    selection_receipt: selection.selection_receipt,
  });
  assert.equal(blocked.error?.data?.reason, "VISIBLE_SYNTHESIS_OVERRIDE_FORBIDDEN");

  const planned = await server.callTool("plan_visible_run", {
    symbol: "TXN",
    run_id: `SELECTION-VISIBLE-NO-BYPASS-${process.pid}`,
    tasks: ["market_data"],
    grounding: { facts_unavailable: true },
    selection_receipt: selection.selection_receipt,
  });
  const result = structured(planned);
  assert.deepEqual(result.run.tasks, DEFAULT_TASKS);
});

test("concurrent retries create at most one council lifecycle", async () => {
  const selection = await confirmMasterSelection(server, { symbol: "QCOM" });
  const runId = `SELECTION-CONCURRENT-${process.pid}`;
  const args = {
    symbol: "QCOM",
    run_id: runId,
    dry_run: true,
    tasks: ["market_data"],
    selection_receipt: selection.selection_receipt,
  };
  const responses = await Promise.all([
    server.callTool("analyze_symbol", args),
    server.callTool("analyze_symbol", args),
  ]);
  assert.ok(responses.some((response) => response.result), "one caller must own the run");
  for (const response of responses.filter((item) => item.error)) {
    assert.equal(response.error.data?.reason, "RUN_IN_PROGRESS");
    assert.equal(response.error.data?.run_id, runId);
  }

  const events = readFileSync(join(dataDir, "runs", runId, "events.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.type === "run_started").length, 1);
  assert.equal(events.filter((event) => event.type === "masters_started").length, 1);
  assert.equal(events.filter((event) => event.type === "run_complete").length, 1);
});

test("confirmation rejects empty, conflicting, stale, and undisplayed selections", async () => {
  const opened = structured(await server.callTool("begin_council_selection", { symbol: "META" }));
  const base = { selection_id: opened.selection_id, catalog_hash: opened.catalog_hash, display_ack: true };

  const empty = await server.callTool("confirm_master_selection", { ...base, selected_master_ids: [] });
  assert.equal(empty.error?.data?.reason, "EMPTY_MASTER_SELECTION");

  const conflicting = await server.callTool("confirm_master_selection", {
    ...base,
    selected_master_ids: ["master_buffett"],
    select_all: true,
  });
  assert.equal(conflicting.error?.data?.reason, "MASTER_SELECTION_ONE_OF_REQUIRED");

  const stale = await server.callTool("confirm_master_selection", {
    ...base,
    catalog_hash: "stale",
    selected_master_ids: ["master_buffett"],
  });
  assert.equal(stale.error?.data?.reason, "STALE_MASTER_CATALOG");

  const undisplayed = await server.callTool("confirm_master_selection", {
    ...base,
    display_ack: false,
    selected_master_ids: ["master_buffett"],
  });
  assert.equal(undisplayed.error?.data?.reason, "MASTER_CATALOG_NOT_ACKNOWLEDGED");
});
