import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { confirmMasterSelection, startServer, structured } from "../helpers/rpc-client.mjs";

function observabilityCodex(dataDir, { forgedMaster = null, delays = {} } = {}) {
  const driver = join(dataDir, "fake-master-observability.mjs");
  const log = join(dataDir, "master-observability.jsonl");
  writeFileSync(driver, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const task = /Task:\\s*(market_data)/u.exec(prompt)?.[1] || null;
const originalMaster = /dedicated, isolated method-seat explanation worker[^\\n]*\\((master_[a-z0-9_]+)\\)/iu.exec(prompt)?.[1] || null;
const repairMaster = /Master ID:\\s*(master_[a-z0-9_]+)/u.exec(prompt)?.[1] || null;
const master = originalMaster || repairMaster;
const parseRepair = prompt.includes("PARSE-ONLY TRANSPORT REPAIR");
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ role: master || task || "unknown", parseRepair }) + "\\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let packet;
if (task) {
  packet = {
    summary: "The bounded market fixture supplies one dated source for runtime observability.",
    claims: [{ claim: "The runtime fixture has one bounded fact.", evidence: "The local dated fixture is the complete test evidence.", confidence: "low", source_ids: ["S1"] }],
    metrics: {},
    sources: [{ id: "S1", title: "Runtime observability fixture", url: "https://example.com/runtime-observability", published_at: "2026-08-01", retrieved_at: "2026-08-03" }],
    open_questions: [], confidence: "low", information_richness: "C"
  };
} else if (master) {
  await sleep((${JSON.stringify(delays)})[master] || 20);
  const frozenLine = prompt.split("\\n").find((line) => line.startsWith("Frozen method result JSON: "));
  const frozen = frozenLine ? JSON.parse(frozenLine.slice("Frozen method result JSON: ".length)) : null;
  const stance = frozen?.stance || /required acknowledged stance:\\s*([^;]+)/u.exec(prompt)?.[1]?.trim() || "out_of_scope";
  packet = {
    master, acknowledged_stance: stance,
    voice_mode: "first_person_public_method_simulation_v1",
    disclosure_ack: "alphacouncil.first_person_public_method_simulation.v1",
    position_intent: ({ constructive: "would_buy", cautious: "would_hold", opposed: "would_pass", out_of_scope: "not_in_my_circle" })[stance],
    voice: {
      would_i_act: master === ${JSON.stringify(forgedMaster)} ? "I keep SENSITIVE-WORKER-BODY-MUST-NOT-BE-PERSISTED inside the rejected output." : "I would preserve the frozen stance and take no unsupported action.",
      what_i_see: "I see only the bounded fixture evidence supplied to this method.",
      how_my_method_reads_it: "I apply the method to the frozen record without adding facts.",
      where_i_disagree: "I disagree with any claim that extends beyond the cited fixture.",
      what_changes_my_mind: "I would reconsider only after a new dated source enters the record."
    },
    key_findings: ["The method remains bound to the frozen record."],
    disagreements: ["No uncited extension is permitted."],
    what_would_change_my_mind: ["A new dated source could change the frozen inputs."],
    source_ids: [master === ${JSON.stringify(forgedMaster)} ? "market_data:SENSITIVE-FORGED-SOURCE-ID-MUST-NOT-BE-PERSISTED" : "market_data:S1"],
    confidence: "low"
  };
} else {
  process.exit(19);
}
writeFileSync(output, JSON.stringify(packet));
`);
  if (process.platform !== "win32") chmodSync(driver, 0o755);
  return { driver, log };
}

async function waitForStatus(path, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const status = JSON.parse(readFileSync(path, "utf8"));
      if (predicate(status)) return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`status predicate was not satisfied within ${timeoutMs}ms`);
}

test("a provenance mismatch fails fast and persists a bounded attempt-1 diagnostic", async () => {
  const dataDir = makeDataDir();
  const fake = observabilityCodex(dataDir, { forgedMaster: "master_buffett" });
  const server = startServer({ dataDir, env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.driver } });
  try {
    await server.request("initialize", {});
    const selection = await confirmMasterSelection(server, {
      symbol: "QQQ", selected_master_ids: ["master_buffett"],
    });
    const runId = `MASTER-PROVENANCE-${process.pid}`;
    const result = structured(await server.callTool("analyze_symbol", {
      symbol: "QQQ", run_id: runId, as_of: "2026-08-03",
      tasks: ["market_data"], synthesis: false, wait_for_completion: true,
      grounding: { facts_unavailable: true, unavailable: ["fixture"] },
      selection_receipt: selection.selection_receipt,
      timeout_ms: 5_000, total_timeout_ms: 15_000,
    }, { timeoutMs: 20_000 }));
    const dir = join(dataDir, "runs", runId);
    const attemptPath = join(dir, "master_buffett.attempt-1.failure.json");
    const finalPath = join(dir, "master_buffett.failure.json");
    const launches = readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const diagnostic = JSON.parse(readFileSync(attemptPath, "utf8"));

    assert.equal(result.run.master_status.master_buffett.status, "failed");
    assert.equal(result.run.master_status.master_buffett.error, "source_provenance_mismatch");
    assert.equal(result.run.master_status.master_buffett.attempts, 1);
    assert.deepEqual(launches.filter((item) => item.role === "master_buffett").map((item) => item.parseRepair), [false]);
    assert.equal(diagnostic.failure_kind, "source_provenance_mismatch");
    assert.equal(diagnostic.provenance.reason, "SOURCE_PROVENANCE_MISMATCH");
    assert.equal(diagnostic.provenance.unknown_source_ids_hashed, true);
    assert.equal(diagnostic.provenance.unknown_source_ids.length, 1);
    assert.match(diagnostic.provenance.unknown_source_ids[0], /^sha256:[0-9a-f]{64}$/u);
    assert.ok(diagnostic.output_chars > 0 && diagnostic.output_bytes > 0);
    assert.match(diagnostic.output_sha256, /^sha256:[0-9a-f]{64}$/u);
    assert.doesNotMatch(
      readFileSync(attemptPath, "utf8"),
      /SENSITIVE-(?:WORKER-BODY|FORGED-SOURCE-ID)-MUST-NOT-BE-PERSISTED/u,
    );
    assert.doesNotMatch(
      readFileSync(finalPath, "utf8"),
      /SENSITIVE-(?:WORKER-BODY|FORGED-SOURCE-ID)-MUST-NOT-BE-PERSISTED/u,
    );
    if (process.platform !== "win32") {
      assert.equal(statSync(attemptPath).mode & 0o777, 0o600);
      assert.equal(statSync(finalPath).mode & 0o777, 0o600);
    }
    const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.type === "master_parse_repair"), false);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

test("each terminal master is canonical before the barrier and survives interrupted-run recovery", async () => {
  const dataDir = makeDataDir();
  const fake = observabilityCodex(dataDir, {
    delays: { master_buffett: 40, master_munger: 10_000 },
  });
  const server = startServer({ dataDir, env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.driver } });
  let recoveryServer = null;
  let serverStopped = false;
  try {
    await server.request("initialize", {});
    const selection = await confirmMasterSelection(server, {
      symbol: "QQQ", selected_master_ids: ["master_buffett", "master_munger"],
    });
    const runId = `MASTER-SETTLEMENT-${process.pid}`;
    const accepted = structured(await server.callTool("analyze_symbol", {
      symbol: "QQQ", run_id: runId, as_of: "2026-08-03",
      tasks: ["market_data"], synthesis: false, wait_for_completion: false,
      grounding: { facts_unavailable: true, unavailable: ["fixture"] },
      selection_receipt: selection.selection_receipt,
      timeout_ms: 20_000, total_timeout_ms: 30_000,
    }));
    assert.equal(accepted.accepted, true);
    const dir = join(dataDir, "runs", runId);
    const statusPath = join(dir, "status.json");
    const midBarrier = await waitForStatus(statusPath, (status) => {
      const masters = Object.fromEntries(status.masters.map((item) => [item.master, item]));
      return masters.master_buffett?.status === "completed"
        && masters.master_munger?.status === "running";
    });
    const masters = Object.fromEntries(midBarrier.masters.map((item) => [item.master, item]));
    assert.equal(masters.master_buffett.status, "completed");
    assert.equal(masters.master_munger.status, "running");
    assert.equal(existsSync(join(dir, "master_buffett.json")), true);
    assert.equal(existsSync(join(dir, "master_munger.json")), false);

    const canonicalMidBarrier = JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8"));
    assert.deepEqual(canonicalMidBarrier.master_opinions.map((opinion) => opinion.master), ["master_buffett"]);
    assert.equal(canonicalMidBarrier.master_status.master_buffett.status, "completed");
    assert.equal(canonicalMidBarrier.master_status.master_munger.status, "running");

    const pendingWorkerPid = masters.master_munger.pid;
    const closed = once(server.child, "close");
    server.child.kill("SIGKILL");
    if (Number.isInteger(pendingWorkerPid)) {
      try {
        process.kill(process.platform === "win32" ? pendingWorkerPid : -pendingWorkerPid, "SIGKILL");
      } catch {
        // The worker may have exited in the narrow interval after the status snapshot.
      }
    }
    await closed;
    serverStopped = true;

    recoveryServer = startServer({ dataDir, env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.driver } });
    await recoveryServer.request("initialize", {});
    const recovered = JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8"));
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.phase, "server_interrupted");
    assert.deepEqual(recovered.master_opinions.map((opinion) => opinion.master), ["master_buffett"]);
    assert.equal(recovered.master_status.master_buffett.status, "completed");
    assert.equal(recovered.master_status.master_munger.status, "failed");
    assert.equal(recovered.master_status.master_munger.error, "server_interrupted");
  } finally {
    if (!serverStopped) await server.close();
    if (recoveryServer) await recoveryServer.close();
    removeDataDir(dataDir);
  }
});
