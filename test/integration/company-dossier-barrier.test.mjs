import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_TASKS } from "../../mcp/lib/constants.mjs";
import {
  COMPANY_DOSSIER_CONTRACT_ID,
  expectedCoverageItems,
} from "../../mcp/lib/company-dossier.mjs";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { confirmMasterSelection, startServer, structured } from "../helpers/rpc-client.mjs";

const AS_OF = "2026-07-28";
const SELECTED_MASTER = "master_simons";

function source(id, title, url) {
  return {
    id,
    title,
    url,
    published_at: AS_OF,
    retrieved_at: AS_OF,
  };
}

function officialItem(sourceId, title, url) {
  return {
    title,
    published_at: AS_OF,
    url,
    source_id: sourceId,
  };
}

function evidencePacket(task, { omitLastCoverageItem = false } = {}) {
  const requiredCoverage = expectedCoverageItems(task);
  const coverageIds = omitLastCoverageItem
    ? requiredCoverage.slice(0, -1)
    : requiredCoverage;
  const packet = {
    summary: `${task} completed its bounded integration-fixture research and retained explicit source lineage.`,
    claims: [{
      claim: `${task} records one material fixture observation for the shared company dossier.`,
      claim_type: "event_or_observation",
      evidence: "The dated fixture source directly supports this bounded observation.",
      confidence: "medium",
      source_ids: ["S1"],
    }],
    metrics: { fixture_value: 1 },
    sources: [source("S1", `${task} fixture source`, `https://example.com/${task}`)],
    open_questions: [],
    coverage_items: coverageIds.map((id) => ({
      id,
      status: "covered",
      source_ids: ["S1"],
      note: "The fixture source covers this contract item for barrier testing.",
    })),
    confidence: "medium",
    information_richness: "B",
  };

  if (task === "news_industry_management") {
    const regulatorUrl = "https://regulator.example/filing";
    const issuerUrl = "https://issuer.example/news";
    const regulatorItem = officialItem("S1", "Regulator fixture filing", regulatorUrl);
    const issuerItem = officialItem("S2", "Issuer fixture release", issuerUrl);
    packet.sources = [
      source("S1", regulatorItem.title, regulatorUrl),
      source("S2", issuerItem.title, issuerUrl),
    ];
    packet.official_source_coverage = {
      status: "complete",
      regulator: {
        status: "complete",
        entry_url: "https://regulator.example/filings",
        checked_through: AS_OF,
        latest_dated_item: regulatorItem,
        dated_items_checked: [regulatorItem],
        gap: null,
      },
      issuer: {
        status: "complete",
        entry_url: "https://issuer.example/newsroom",
        checked_through: AS_OF,
        latest_dated_item: issuerItem,
        dated_items_checked: [issuerItem],
        gap: null,
      },
    };
  }

  return packet;
}

function frozenStance(planned) {
  const seat = [...(planned.masters_completed || []), ...(planned.masters_declined || [])]
    .find((item) => item.master === SELECTED_MASTER);
  assert.ok(seat, `${SELECTED_MASTER} must have a frozen result in the visible plan`);
  return seat.stance;
}

function methodVoicePacket(stance, companyDossierHash) {
  const positionIntent = {
    constructive: "would_buy",
    cautious: "would_hold",
    opposed: "would_pass",
    out_of_scope: "not_in_my_circle",
  }[stance];
  assert.ok(positionIntent, `unexpected frozen stance: ${stance}`);
  return {
    master: SELECTED_MASTER,
    acknowledged_stance: stance,
    voice_mode: "first_person_public_method_simulation_v1",
    disclosure_ack: "alphacouncil.first_person_public_method_simulation.v1",
    position_intent: positionIntent,
    voice: {
      would_i_act: "I would keep the frozen action and would not manufacture a different vote.",
      what_i_see: "I see the complete dated fixture dossier and its explicit coverage ledger.",
      how_my_method_reads_it: "I apply my method only to the frozen facts and their recorded limits.",
      where_i_disagree: "I disagree with any conclusion that silently adds evidence outside this dossier.",
      what_changes_my_mind: "I would reassess only after a dated source changes a method-critical fact.",
    },
    key_findings: ["The shared dossier records all eight mandatory evidence roles."],
    disagreements: ["No omitted source may be treated as supporting evidence."],
    what_would_change_my_mind: ["A contradictory dated primary source would require reassessment."],
    source_ids: ["market_data:S1"],
    confidence: "medium",
    company_dossier_hash_ack: companyDossierHash,
  };
}

test("operating-company dossier materializes only after the eight-packet barrier and hash-binds downstream", async (t) => {
  const dataDir = makeDataDir();
  const server = startServer({ dataDir });
  t.after(async () => {
    await server.close();
    removeDataDir(dataDir);
  });
  await server.request("initialize", {});

  const runId = `COMPANY-DOSSIER-BARRIER-${process.pid}`;
  const symbol = "ACME";
  const selection = await confirmMasterSelection(server, {
    symbol,
    language: "English",
    selected_master_ids: [SELECTED_MASTER],
  });
  const planned = structured(await server.callTool("plan_visible_run", {
    symbol,
    as_of: AS_OF,
    language: "English",
    run_id: runId,
    tasks: DEFAULT_TASKS,
    grounding: {
      gathered_at: `${AS_OF}T12:00:00Z`,
      facts_unavailable: true,
      instrument: {
        symbol,
        name: "Acme Fixture Corporation",
        instrument_type: "equity",
        research_model: "operating_company",
        exchange: "NASDAQ",
        currency: "USD",
      },
    },
    selection_receipt: selection.selection_receipt,
  }));

  assert.deepEqual(planned.run.tasks, DEFAULT_TASKS);
  assert.equal(planned.prompts_inline, false, "company downstream prompts must stay file-backed until the dossier exists");
  const stance = frozenStance(planned);
  const runDir = join(dataDir, "runs", runId);
  const evidencePath = join(runDir, "evidence.json");
  const dossierPath = join(runDir, "company_dossier.json");
  const finalTask = DEFAULT_TASKS.at(-1);

  for (const task of DEFAULT_TASKS.slice(0, -1)) {
    structured(await server.callTool("record_visible_packet", {
      run_id: runId,
      task,
      thread_id: `thread-${task}`,
      thread_title: `${task} evidence fixture`,
      packet: evidencePacket(task),
    }));
    assert.equal(existsSync(dossierPath), false, `dossier appeared before ${finalTask} completed`);
  }

  const beforeFinalPacket = readFileSync(evidencePath, "utf8");
  const earlyMaster = await server.callTool("record_master_opinion", {
    run_id: runId,
    master: SELECTED_MASTER,
    packet: methodVoicePacket(stance, `sha256:${"0".repeat(64)}`),
  });
  assert.equal(earlyMaster.error?.data?.reason, "VISIBLE_MASTER_EVIDENCE_INCOMPLETE");
  assert.deepEqual(earlyMaster.error?.data?.missing_evidence, [finalTask]);

  const incompleteFinal = await server.callTool("record_visible_packet", {
    run_id: runId,
    task: finalTask,
    thread_id: `thread-${finalTask}-incomplete`,
    thread_title: `${finalTask} incomplete evidence fixture`,
    packet: evidencePacket(finalTask, { omitLastCoverageItem: true }),
  });
  assert.equal(incompleteFinal.error?.data?.reason, "COMPANY_DOSSIER_COVERAGE_MISMATCH");
  assert.deepEqual(incompleteFinal.error?.data?.coverage?.missing, expectedCoverageItems(finalTask).slice(-1));
  assert.equal(readFileSync(evidencePath, "utf8"), beforeFinalPacket, "rejected coverage must not mutate the run");
  assert.equal(existsSync(dossierPath), false, "an incomplete eighth packet must not materialize a dossier");
  const blockedAfterCoverageGap = await server.callTool("record_master_opinion", {
    run_id: runId,
    master: SELECTED_MASTER,
    packet: methodVoicePacket(stance, `sha256:${"0".repeat(64)}`),
  });
  assert.equal(blockedAfterCoverageGap.error?.data?.reason, "VISIBLE_MASTER_EVIDENCE_INCOMPLETE");
  assert.deepEqual(blockedAfterCoverageGap.error?.data?.missing_evidence, [finalTask]);

  structured(await server.callTool("record_visible_packet", {
    run_id: runId,
    task: finalTask,
    thread_id: `thread-${finalTask}`,
    thread_title: `${finalTask} evidence fixture`,
    packet: evidencePacket(finalTask),
  }));

  const persisted = JSON.parse(readFileSync(evidencePath, "utf8"));
  const dossier = JSON.parse(readFileSync(dossierPath, "utf8"));
  assert.equal(persisted.packets.length, DEFAULT_TASKS.length);
  assert.ok(DEFAULT_TASKS.every((task) => persisted.task_status[task]?.status === "completed"));
  assert.equal(persisted.company_dossier.contract_id, COMPANY_DOSSIER_CONTRACT_ID);
  assert.equal(persisted.company_dossier.status, "complete");
  assert.equal(persisted.company_dossier.content_hash, dossier.content_hash);
  assert.equal(dossier.coverage.status, "complete");
  assert.deepEqual(dossier.packets.map((packet) => packet.task), DEFAULT_TASKS);

  const wrongHash = `sha256:${"f".repeat(64)}`;
  assert.notEqual(wrongHash, dossier.content_hash);
  const beforeWrongAck = readFileSync(evidencePath, "utf8");
  const wrongAck = await server.callTool("record_master_opinion", {
    run_id: runId,
    master: SELECTED_MASTER,
    thread_id: "thread-master-wrong-ack",
    packet: methodVoicePacket(stance, wrongHash),
  });
  assert.equal(wrongAck.error?.data?.reason, "COMPANY_DOSSIER_HASH_ACK_MISMATCH");
  assert.equal(wrongAck.error?.data?.expected_company_dossier_hash, dossier.content_hash);
  assert.equal(wrongAck.error?.data?.supplied_company_dossier_hash, wrongHash);
  assert.equal(readFileSync(evidencePath, "utf8"), beforeWrongAck, "wrong hash ack must not mutate the run");

  const originalDossierText = readFileSync(dossierPath, "utf8");
  const tamperedDossier = JSON.parse(originalDossierText);
  tamperedDossier.symbol = "TAMPERED";
  writeFileSync(dossierPath, `${JSON.stringify(tamperedDossier, null, 2)}\n`);
  const tamperedAck = await server.callTool("record_master_opinion", {
    run_id: runId,
    master: SELECTED_MASTER,
    thread_id: "thread-master-tampered-dossier",
    packet: methodVoicePacket(stance, dossier.content_hash),
  });
  assert.equal(tamperedAck.error?.data?.reason, "COMPANY_DOSSIER_ARTIFACT_INTEGRITY_FAILURE");
  assert.equal(readFileSync(evidencePath, "utf8"), beforeWrongAck, "tampered dossier rejection must not mutate run state");
  writeFileSync(dossierPath, originalDossierText);

  const originalEvidenceText = readFileSync(evidencePath, "utf8");
  const tamperedEvidence = JSON.parse(originalEvidenceText);
  tamperedEvidence.packets[0].summary = "TAMPERED CURRENT RUN EVIDENCE";
  writeFileSync(evidencePath, `${JSON.stringify(tamperedEvidence, null, 2)}\n`);
  const mismatchedRunAck = await server.callTool("record_master_opinion", {
    run_id: runId,
    master: SELECTED_MASTER,
    thread_id: "thread-master-mismatched-run-evidence",
    packet: methodVoicePacket(stance, dossier.content_hash),
  });
  assert.equal(mismatchedRunAck.error?.data?.reason, "COMPANY_DOSSIER_ARTIFACT_INTEGRITY_FAILURE");
  assert.match(mismatchedRunAck.error?.data?.diagnostic || "", /input binding/u);
  writeFileSync(evidencePath, originalEvidenceText);

  const accepted = structured(await server.callTool("record_master_opinion", {
    run_id: runId,
    master: SELECTED_MASTER,
    thread_id: "thread-master-correct-ack",
    packet: methodVoicePacket(stance, dossier.content_hash),
  }));
  assert.equal(accepted.opinion.voice_status, "completed");
  assert.equal(accepted.opinion.company_dossier_hash, dossier.content_hash);

  const frozenEvidence = readFileSync(evidencePath, "utf8");
  const frozenDossier = readFileSync(dossierPath, "utf8");
  const conflictingPacket = evidencePacket(DEFAULT_TASKS[0]);
  conflictingPacket.summary = `${conflictingPacket.summary} This conflicting replay must not replace frozen evidence.`;
  const conflictingReplay = await server.callTool("record_visible_packet", {
    run_id: runId,
    task: DEFAULT_TASKS[0],
    thread_id: `thread-${DEFAULT_TASKS[0]}-conflict`,
    thread_title: `${DEFAULT_TASKS[0]} conflicting evidence fixture`,
    packet: conflictingPacket,
  });
  assert.ok(conflictingReplay.error, "a completed dossier must reject a conflicting evidence replay");
  assert.equal(readFileSync(evidencePath, "utf8"), frozenEvidence, "frozen evidence must not be overwritten downstream");
  assert.equal(readFileSync(dossierPath, "utf8"), frozenDossier, "the materialized dossier hash must remain frozen");
});
