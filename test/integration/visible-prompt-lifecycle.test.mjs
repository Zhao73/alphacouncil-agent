import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ALL_ANALYST_TASKS } from "../../mcp/lib/constants.mjs";
import { expectedCoverageItems } from "../../mcp/lib/company-dossier.mjs";
import { materialEvidenceClaims, normalizeVerifierBatch } from "../../mcp/lib/verification.mjs";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { confirmMasterSelection, startServer, structured } from "../helpers/rpc-client.mjs";

const AS_OF = "2026-08-28";
const HARD_FINDING = "VERIFIER-LIFECYCLE-HARD-FINDING: the frozen fixture claim is contradicted.";

function source(id, title, url) {
  return { id, title, url, published_at: AS_OF, retrieved_at: AS_OF };
}

function evidencePacket(task) {
  const packet = {
    summary: `${task} completed a bounded slow-all lifecycle fixture with explicit source lineage.`,
    claims: [{
      claim: `${task} records one material fixture observation for the verification lifecycle.`,
      claim_type: "event_or_observation",
      evidence: "The dated fixture source directly supports this bounded observation.",
      confidence: "medium",
      source_ids: ["S1"],
    }],
    metrics: { fixture_value: 1 },
    sources: [source("S1", `${task} lifecycle source`, `https://example.com/lifecycle/${task}`)],
    open_questions: [],
    coverage_items: expectedCoverageItems(task).map((id) => ({
      id,
      status: "covered",
      source_ids: ["S1"],
      note: "The dated fixture source covers this company-dossier contract item.",
    })),
    confidence: "medium",
    information_richness: "B",
  };
  if (task === "news_industry_management") {
    const regulatorUrl = "https://regulator.example/lifecycle-filing";
    const issuerUrl = "https://issuer.example/lifecycle-news";
    const regulator = {
      title: "Regulator lifecycle filing",
      published_at: AS_OF,
      url: regulatorUrl,
      source_id: "S1",
    };
    const issuer = {
      title: "Issuer lifecycle release",
      published_at: AS_OF,
      url: issuerUrl,
      source_id: "S2",
    };
    packet.sources = [
      source("S1", regulator.title, regulatorUrl),
      source("S2", issuer.title, issuerUrl),
    ];
    packet.official_source_coverage = {
      status: "complete",
      regulator: {
        status: "complete",
        entry_url: "https://regulator.example/lifecycle-filings",
        checked_through: AS_OF,
        latest_dated_item: regulator,
        dated_items_checked: [regulator],
        gap: null,
      },
      issuer: {
        status: "complete",
        entry_url: "https://issuer.example/lifecycle-newsroom",
        checked_through: AS_OF,
        latest_dated_item: issuer,
        dated_items_checked: [issuer],
        gap: null,
      },
    };
  }
  return packet;
}

function verifierPacket(verifier, run, { hardFinding = false } = {}) {
  const sourceById = new Map((run.packets || []).flatMap((packet) => (
    (packet.sources || []).map((item) => [item.id, item])
  )));
  return {
    verifier,
    run_id: run.run_id,
    results: materialEvidenceClaims(run).map((claim, index) => {
      if (verifier === "source_fidelity") {
        return {
          claim_id: claim.claim_id,
          verdict: "supported",
          note: "Every cited fixture URL directly supports the complete bounded claim.",
          checked_urls: claim.source_ids.map((id) => sourceById.get(id)?.url).filter(Boolean),
          queries: [],
          excerpt: "The dated fixture evidence directly supports the bounded observation.",
          rederivation: "",
        };
      }
      if (verifier === "rederivation") {
        return {
          claim_id: claim.claim_id,
          verdict: "agree",
          note: "An independent fixture calculation reproduced the bounded observation.",
          checked_urls: [`https://independent.example/rederive/${encodeURIComponent(claim.claim_id)}`],
          queries: [`independently rederive ${claim.claim_id}`],
          excerpt: "",
          rederivation: "The independently located fixture inputs reproduce the recorded result.",
        };
      }
      const refuted = hardFinding && index === 0;
      return {
        claim_id: claim.claim_id,
        verdict: refuted ? "refuted" : "stands",
        note: refuted
          ? HARD_FINDING
          : "A concrete search for contrary fixture evidence found no contradiction.",
        checked_urls: refuted
          ? [`https://counter.example/refute/${encodeURIComponent(claim.claim_id)}`]
          : [],
        queries: [`contradict disconfirm supersede ${claim.claim_id}`],
        excerpt: "",
        rederivation: "",
      };
    }),
  };
}

test("the final verifier batch regenerates every pending method prompt with hard findings", async (t) => {
  const dataDir = makeDataDir();
  const server = startServer({ dataDir });
  t.after(async () => {
    await server.close();
    removeDataDir(dataDir);
  });
  await server.request("initialize", {});

  const symbol = "ACME";
  const runId = `VISIBLE-VERIFIER-LIFECYCLE-${process.pid}`;
  const selection = await confirmMasterSelection(server, {
    symbol,
    language: "English",
    select_all: true,
    council_pace: "slow",
    analyst_scope: "all",
  });
  const planned = structured(await server.callTool("plan_visible_run", {
    symbol,
    as_of: AS_OF,
    language: "English",
    run_id: runId,
    grounding: {
      gathered_at: `${AS_OF}T12:00:00Z`,
      facts_unavailable: true,
      instrument: {
        symbol,
        name: "ACME slow-all lifecycle fixture",
        instrument_type: "equity",
        research_model: "operating_company",
        exchange: "NYSE",
        currency: "USD",
      },
    },
    selection_receipt: selection.selection_receipt,
  }));
  assert.deepEqual(planned.run.tasks, ALL_ANALYST_TASKS);
  assert.equal(planned.master_agents.length, 26);

  for (const task of ALL_ANALYST_TASKS) {
    structured(await server.callTool("record_visible_packet", {
      run_id: runId,
      task,
      thread_id: `thread-${runId}-${task}`,
      thread_title: `AlphaCouncil Agent ${symbol} ${task} evidence thread`,
      packet: evidencePacket(task),
    }));
  }

  const evidencePath = join(dataDir, "runs", runId, "evidence.json");
  let run = JSON.parse(readFileSync(evidencePath, "utf8"));
  const method = planned.master_agents.find((agent) => agent.role === "master_buffett");
  assert.ok(method?.prompt_file);

  // Simulate the exact crash window in which the immutable verifier file reached disk but the
  // process died before evidence.json recorded those rows or the completed verifier status.
  const sourceFidelityPacket = verifierPacket("source_fidelity", run);
  const frozenSourceFidelity = normalizeVerifierBatch(
    sourceFidelityPacket,
    run,
    "source_fidelity",
    { client: true },
  );
  writeFileSync(
    join(dataDir, "runs", runId, "verification.source_fidelity.json"),
    `${JSON.stringify(frozenSourceFidelity, null, 2)}\n`,
    "utf8",
  );
  const recovered = structured(await server.callTool("record_verifier_batch", {
    run_id: runId,
    verifier: "source_fidelity",
    packet: sourceFidelityPacket,
  }));
  assert.equal(recovered.idempotent_replay, true);
  assert.equal(recovered.recovered_run_state, true);
  assert.equal(recovered.verifier_audit.coverage_complete, false);
  assert.equal(recovered.refreshed_prompt_count, 0);
  run = JSON.parse(readFileSync(evidencePath, "utf8"));
  assert.equal(run.verifier_status.source_fidelity.status, "completed");
  assert.equal(run.verifier_verdicts.filter((row) => row.verifier === "source_fidelity").length, 11);

  for (const verifier of ["rederivation"]) {
    const result = structured(await server.callTool("record_verifier_batch", {
      run_id: runId,
      verifier,
      thread_id: `thread-${runId}-${verifier}`,
      thread_title: `AlphaCouncil Agent ${symbol} ${verifier}`,
      packet: verifierPacket(verifier, run),
    }));
    assert.equal(result.verifier_audit.coverage_complete, false);
    assert.equal(result.refreshed_prompt_count, 0);
    assert.equal(result.recovered_run_state, false);
    run = JSON.parse(readFileSync(evidencePath, "utf8"));
  }

  const beforeFinalVerifier = readFileSync(method.prompt_file, "utf8");
  const finalPacket = verifierPacket("refuter", run, { hardFinding: true });
  const final = structured(await server.callTool("record_verifier_batch", {
    run_id: runId,
    verifier: "refuter",
    thread_id: `thread-${runId}-refuter`,
    thread_title: `AlphaCouncil Agent ${symbol} refuter`,
    packet: finalPacket,
  }));
  const afterFinalVerifier = readFileSync(method.prompt_file, "utf8");

  assert.equal(final.verifier_audit.coverage_complete, true);
  assert.equal(final.verifier_audit.status, "completed_with_findings");
  assert.equal(final.refreshed_prompt_count, 26);
  assert.notEqual(afterFinalVerifier, beforeFinalVerifier);
  assert.match(afterFinalVerifier, /Hard findings JSON:/u);
  assert.match(afterFinalVerifier, new RegExp(HARD_FINDING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(afterFinalVerifier, /SERVER-REFRESHED METHOD INPUT/u);

  // Simulate a second crash boundary: rows/status were saved by updateVerifierStatus, but the
  // derived policy and phase had not reached their following save yet.
  const partiallySaved = JSON.parse(readFileSync(evidencePath, "utf8"));
  partiallySaved.verification_policy.status = "pending";
  partiallySaved.phase = "visible_verification";
  writeFileSync(evidencePath, `${JSON.stringify(partiallySaved, null, 2)}\n`, "utf8");
  const derivedRecovery = structured(await server.callTool("record_verifier_batch", {
    run_id: runId,
    verifier: "refuter",
    packet: finalPacket,
  }));
  assert.equal(derivedRecovery.idempotent_replay, true);
  assert.equal(derivedRecovery.recovered_run_state, true);
  assert.equal(derivedRecovery.verifier_audit.status, "completed_with_findings");
  const derivedPersisted = JSON.parse(readFileSync(evidencePath, "utf8"));
  assert.equal(derivedPersisted.verification_policy.status, "completed_with_findings");
  assert.equal(derivedPersisted.phase, "visible_methods");

  const replay = structured(await server.callTool("record_verifier_batch", {
    run_id: runId,
    verifier: "refuter",
    packet: finalPacket,
  }));
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.recovered_run_state, false);
  assert.equal(replay.refreshed_prompt_count, 26,
    "an identical replay must repair every method prompt after an interrupted refresh");

  // A verifier replay may happen after method work has already advanced the run. Recovery is
  // monotonic: it may repair an earlier crash boundary, but it must never rewind debate work.
  const debatePhase = JSON.parse(readFileSync(evidencePath, "utf8"));
  debatePhase.phase = "visible_debate";
  writeFileSync(evidencePath, `${JSON.stringify(debatePhase, null, 2)}\n`, "utf8");
  const debateReplay = structured(await server.callTool("record_verifier_batch", {
    run_id: runId,
    verifier: "refuter",
    packet: finalPacket,
  }));
  assert.equal(debateReplay.idempotent_replay, true);
  assert.equal(debateReplay.recovered_run_state, false);
  const debatePersisted = JSON.parse(readFileSync(evidencePath, "utf8"));
  assert.equal(debatePersisted.phase, "visible_debate");

  // A newer runtime may introduce a phase this checkout cannot interpret. Treat it as an
  // incompatible state instead of silently rewriting it to an older phase.
  debatePersisted.phase = "future_visible_review";
  writeFileSync(evidencePath, `${JSON.stringify(debatePersisted, null, 2)}\n`, "utf8");
  const unknownPhaseBytes = readFileSync(evidencePath, "utf8");
  const unknownPhaseReplay = await server.callTool("record_verifier_batch", {
    run_id: runId,
    verifier: "refuter",
    packet: finalPacket,
  });
  assert.ok(unknownPhaseReplay.error);
  assert.equal(unknownPhaseReplay.error.data.reason, "VISIBLE_PHASE_UNKNOWN");
  assert.equal(readFileSync(evidencePath, "utf8"), unknownPhaseBytes,
    "an unknown phase must fail closed without rewriting persisted state");
});
