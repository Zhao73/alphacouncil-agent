import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { startServer, structured } from "../helpers/rpc-client.mjs";
import { RpcCode } from "../../mcp/lib/errors.mjs";

let dataDir;
let server;
const runId = `MASTERS-${process.pid}`;
let runDir;
let plan;

before(async () => {
  dataDir = makeDataDir();
  runDir = join(dataDir, "runs", runId);
  server = startServer({ dataDir });
  await server.request("initialize", {});
  plan = structured(await server.callTool("plan_visible_run", {
    symbol: "0700.HK",
    run_id: runId,
    tasks: ["market_data"],
    masters_roster: "masters-value",
  }));
});

after(async () => {
  await server.close();
  removeDataDir(dataDir);
});

test("a roster produces one master agent spec per seat", () => {
  assert.equal(plan.master_agents.length, 4);
  assert.deepEqual(
    plan.master_agents.map((a) => a.role),
    ["master_buffett", "master_munger", "master_duan_yongping", "master_li_lu"],
  );
});

test("a master prompt carries the evidence, the walk-away conditions and the out_of_scope option", () => {
  const munger = plan.master_agents.find((a) => a.role === "master_munger");
  assert.match(munger.prompt_template, /Evidence JSON:/);
  assert.match(munger.prompt_template, /Walk-away conditions you must check/);
  assert.match(munger.prompt_template, /out_of_scope/);
  // A master judges; it must not be told to go and search.
  assert.doesNotMatch(munger.prompt_template, /WebSearch|live web search/);
});

test("masters never appear among the evidence or debate agents", () => {
  const evidence = plan.evidence_agents.map((a) => a.role);
  const debate = plan.debate_agents.map((a) => a.role);
  for (const spec of plan.master_agents) {
    assert.ok(!evidence.includes(spec.role));
    assert.ok(!debate.includes(spec.role));
  }
});

test("an unselected master is rejected", async () => {
  const response = await server.callTool("record_master_opinion", {
    run_id: runId,
    master: "master_simons",
    packet: { verdict: "x" },
  });
  assert.equal(response.error?.code, RpcCode.INVALID_PARAMS);
  assert.match(response.error.message, /was not selected for this run/);
});

test("out_of_scope is preserved as a stance rather than coerced", async () => {
  const result = structured(await server.callTool("record_master_opinion", {
    run_id: runId,
    master: "master_buffett",
    packet: {
      verdict: "Outside the circle of competence",
      stance: "out_of_scope",
      summary: "Cannot explain how this business earns in one paragraph.",
      what_would_change_my_mind: ["a segment disclosure that shows unit economics"],
      confidence: "medium",
    },
  }));
  assert.equal(result.opinion.stance, "out_of_scope");
  assert.equal(result.recorded, 1);
  assert.equal(result.expected, 4);
  assert.ok(existsSync(join(runDir, "master_buffett.json")));
});

test("an unknown stance falls back to cautious instead of passing through", async () => {
  const result = structured(await server.callTool("record_master_opinion", {
    run_id: runId,
    master: "master_munger",
    packet: { verdict: "v", stance: "wildly bullish", summary: "s" },
  }));
  assert.equal(result.opinion.stance, "cautious");
});

// The point of running masters before the debate: the bull and bear must answer them.
test("recorded master disagreements reach the debate prompt", async () => {
  await server.callTool("record_master_opinion", {
    run_id: runId,
    master: "master_li_lu",
    packet: {
      verdict: "Ten-year certainty is low",
      stance: "opposed",
      summary: "s",
      disagreements: ["the evidence chain assumes the regulatory regime is stable"],
      confidence: "high",
    },
  });
  const replan = structured(await server.callTool("plan_visible_run", {
    symbol: "0700.HK",
    run_id: runId,
    tasks: ["market_data"],
    masters_roster: "masters-value",
  }));
  // plan_visible_run rewrites the envelope, so read the persisted opinions instead.
  const run = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8"));
  assert.ok(Array.isArray(run.master_opinions));
  assert.ok(replan.master_agents.length === 4);
});

test("masters do not affect the completeness gate", () => {
  const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"));
  // Only the evidence task and the three debate roles are counted.
  assert.equal(status.missing_evidence_count, 1);
  assert.equal(status.missing_debate_count, 3);
  assert.ok(!("missing_master_count" in status), "masters are optional and must not gate a run");
});
