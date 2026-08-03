import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { DEFAULT_TASKS } from "../../mcp/lib/constants.mjs";
import { expectedCoverageItems } from "../../mcp/lib/company-dossier.mjs";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { startServer, structured } from "../helpers/rpc-client.mjs";

/**
 * A visible plan carries one full prompt per agent and every prompt embeds the grounding. A real
 * eight-seat run returned 311,007 characters in one tool result and the host rejected all of it
 * for exceeding its result ceiling: the plan was built correctly and then discarded. What drives
 * that size is the embedded grounding rather than the seat count -- a bench-wide plan with no
 * grounding is well inside the budget. Prompts now always land in the run directory, and the
 * result states whether it also carries them inline.
 */

let dataDir;
let smallServer;
let tinyBudgetServer;

before(async () => {
  dataDir = makeDataDir();
  smallServer = startServer({ dataDir });
  await smallServer.request("initialize", {});
  // A deliberately tiny budget proves the switch without needing a megabyte of real grounding.
  tinyBudgetServer = startServer({
    dataDir,
    env: { ALPHACOUNCIL_VISIBLE_INLINE_PROMPT_CHARS: "1000" },
  });
  await tinyBudgetServer.request("initialize", {});
});

after(async () => {
  await smallServer.close();
  await tinyBudgetServer.close();
  removeDataDir(dataDir);
});

const promptOf = (agent) => (typeof agent.prompt_template === "string" || agent.prompt_template === null
  ? agent.prompt_template
  : agent.prompt);

async function plan(server, {
  symbol,
  runId,
  masters,
  tasks,
  researchModel = "operating_company",
}) {
  const prompt = `Analyse ${symbol} and show every analyst and method seat.`;
  const opened = structured(await server.callTool("begin_council_selection", {
    symbol, language: "en", host: "codex", prompt,
  }));
  const confirmed = structured(await server.callTool("confirm_master_selection", {
    selection_id: opened.selection_id,
    catalog_hash: opened.catalog_hash,
    display_ack: true,
    ...(masters === "all" ? { select_all: true } : { selected_master_ids: masters }),
  }));
  return structured(await server.callTool("plan_visible_run", {
    symbol,
    language: "en",
    prompt,
    run_id: runId,
    tasks,
    grounding: {
      facts_unavailable: true,
      instrument: {
        symbol,
        name: `${symbol} prompt-delivery fixture`,
        instrument_type: researchModel === "operating_company" ? "equity" : "etf",
        research_model: researchModel,
        exchange: "NASDAQ",
        currency: "USD",
      },
    },
    selection_receipt: confirmed.selection_receipt,
  }));
}

const allAgents = (planned) => [
  ...planned.evidence_agents,
  ...planned.master_agents,
  ...planned.debate_agents,
];

test("an operating-company full plan keeps all prompts file-backed until the dossier barrier", async () => {
  const planned = await plan(smallServer, {
    symbol: "AAPL",
    runId: `PROMPT-FILES-${process.pid}`,
    masters: ["master_buffett"],
    tasks: ["market_data"],
  });

  const agents = allAgents(planned);
  assert.deepEqual(planned.run.tasks, DEFAULT_TASKS, "a selected full run cannot shrink the eight-seat evidence roster");
  assert.equal(planned.evidence_agents.length, 8);
  assert.equal(
    DEFAULT_TASKS.reduce((sum, task) => sum + expectedCoverageItems(task).length, 0),
    52,
    "the operating-company evidence roster must retain all 52 coverage items",
  );
  assert.ok(agents.length >= 12, "the plan must still return evidence, method, debate, and PM agents");
  assert.equal(typeof planned.prompt_dir, "string");
  assert.equal(planned.prompts_inline, false,
    "pre-dossier downstream prompt copies would become stale after the evidence barrier");
  assert.ok(planned.prompt_chars_total > 0);

  for (const agent of agents) {
    assert.ok(agent.prompt_file, `${agent.role} must report a prompt file`);
    assert.ok(existsSync(agent.prompt_file), `${agent.role} prompt file must exist`);
    const written = readFileSync(agent.prompt_file, "utf8").replace(/\n$/, "");
    assert.ok(written.trim().length > 0, `${agent.role} prompt file must not be empty`);
    assert.equal(agent.prompt_chars, written.length, agent.role);
    // A path outside the run's prompt directory would be a traversal, not a plan.
    assert.ok(agent.prompt_file.startsWith(planned.prompt_dir));
    // Both agent shapes must be externalized: evidence carries `prompt`, the rest
    // `prompt_template`. Operating-company plans deliberately return neither body inline.
    assert.equal(promptOf(agent), null, `${agent.role} must be read from its prompt_file`);
  }

  for (const agent of planned.evidence_agents) {
    const written = readFileSync(agent.prompt_file, "utf8");
    const coverageIds = expectedCoverageItems(agent.role);
    assert.ok(coverageIds.length > 0, `${agent.role} must own company-dossier coverage`);
    for (const id of coverageIds) {
      assert.match(written, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${agent.role}:${id}`);
    }
  }
});

test("a small non-company plan still returns prompt copies inline as well as on disk", async () => {
  const planned = await plan(smallServer, {
    symbol: "SPY",
    runId: `PROMPT-INLINE-${process.pid}`,
    masters: ["master_buffett"],
    tasks: ["market_data"],
    researchModel: "fund_lookthrough",
  });

  assert.equal(planned.prompts_inline, true);
  for (const agent of allAgents(planned)) {
    const written = readFileSync(agent.prompt_file, "utf8").replace(/\n$/, "");
    assert.equal(promptOf(agent), written, `${agent.role} inline copy must match the file`);
  }
});

test("a plan over the budget drops the inline copies and stays readable on disk", async () => {
  const planned = await plan(tinyBudgetServer, {
    symbol: "SPY",
    runId: `PROMPT-BUDGET-${process.pid}`,
    masters: ["master_buffett", "master_marks"],
    tasks: ["market_data", "earnings_deep_dive"],
    researchModel: "fund_lookthrough",
  });

  assert.ok(planned.prompt_chars_total > 1000, `saw ${planned.prompt_chars_total}`);
  assert.equal(planned.prompts_inline, false);
  const agents = allAgents(planned);
  assert.ok(agents.length >= 5);
  for (const agent of agents) {
    assert.equal(promptOf(agent), null, `${agent.role} must not be returned inline`);
    assert.ok(existsSync(agent.prompt_file), `${agent.role} prompt must still be readable on disk`);
    assert.ok(readFileSync(agent.prompt_file, "utf8").trim().length > 0);
    assert.ok(agent.prompt_chars > 0, `${agent.role} must still report its size`);
  }
  // The whole point: the prompt bodies are no longer in the result, so its size no longer
  // scales with the grounding embedded in them.
  const payload = JSON.stringify(planned);
  for (const agent of agents) {
    const body = readFileSync(agent.prompt_file, "utf8");
    const distinctive = JSON.stringify(body.slice(200, 400)).slice(1, -1);
    assert.ok(distinctive.length > 20, "the fixture must produce a prompt worth checking");
    assert.ok(!payload.includes(distinctive),
      `${agent.role} prompt body must not be embedded in the returned plan`);
  }
});
