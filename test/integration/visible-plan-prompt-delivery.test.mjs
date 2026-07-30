import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

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

async function plan(server, { symbol, runId, masters, tasks }) {
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
    grounding: { facts_unavailable: true },
    selection_receipt: confirmed.selection_receipt,
  }));
}

const allAgents = (planned) => [
  ...planned.evidence_agents,
  ...planned.master_agents,
  ...planned.debate_agents,
];

test("every planned prompt is written to the run directory and reported by path", async () => {
  const planned = await plan(smallServer, {
    symbol: "AAPL",
    runId: `PROMPT-FILES-${process.pid}`,
    masters: ["master_buffett"],
    tasks: ["market_data"],
  });

  const agents = allAgents(planned);
  assert.ok(agents.length >= 4, "the plan must still return its agents");
  assert.equal(typeof planned.prompt_dir, "string");
  assert.equal(planned.prompts_inline, true, "a small plan must keep returning prompts inline");
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
    // `prompt_template`. Reading only one of them wrote empty files for the other.
    assert.equal(promptOf(agent), written, `${agent.role} inline copy must match the file`);
  }
});

test("a plan over the budget drops the inline copies and stays readable on disk", async () => {
  const planned = await plan(tinyBudgetServer, {
    symbol: "MSFT",
    runId: `PROMPT-BUDGET-${process.pid}`,
    masters: ["master_buffett", "master_marks"],
    tasks: ["market_data", "earnings_deep_dive"],
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
