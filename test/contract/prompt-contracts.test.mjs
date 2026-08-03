import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TASKS } from "../../mcp/lib/constants.mjs";
import { CANONICAL_MASTER_IDS } from "../../mcp/lib/personas-v3/staging.mjs";
import { debatePrompt, masterVoicePrompt, taskPrompt } from "../../mcp/lib/prompts.mjs";
import { assertPromptContract, promptContractErrors } from "../helpers/prompt-contracts.mjs";
import { repoFile } from "../helpers/paths.mjs";

const contract = JSON.parse(readFileSync(repoFile("test/fixtures/prompt-contracts.v1.json"), "utf8"));
const goldenBytes = readFileSync(repoFile("test/fixtures/prompt-golden.json"));
const run = {
  run_id: "PROMPT-CONTRACT",
  symbol: "TEST",
  as_of: "2026-08-03",
  language: "English",
  council_mode: "full",
  council_pace: "normal",
  packets: [],
  grounding: null,
};

test("prompt golden changes require an explicit contract revision", () => {
  assert.equal(contract.schema_version, 1);
  assert.match(contract.contract_revision, /^\d{4}-\d{2}-\d{2}\.\d+$/u);
  assert.equal(createHash("sha256").update(goldenBytes).digest("hex"), contract.golden_sha256);
  for (const kind of ["breaking", "behavioral", "cosmetic"]) {
    assert.ok(contract.change_policy[kind]?.length > 0, `${kind} changes need an explicit policy`);
  }
});

test("every evidence prompt retains the executable output and tool boundaries", () => {
  for (const task of DEFAULT_TASKS) {
    const prompt = taskPrompt(task, "TEST", "2026-08-03", "Assess TEST", "en-US");
    assertPromptContract(prompt, contract.contracts.evidence, `evidence:${task}`);
  }
});

test("debate and portfolio-manager prompts retain their distinct contracts", () => {
  for (const role of ["bull_researcher", "bear_researcher"]) {
    assertPromptContract(debatePrompt(role, run, { round: 1 }), contract.contracts.debate, role);
  }
  assertPromptContract(
    debatePrompt("portfolio_manager", run, { bull: {}, bear: {} }),
    contract.contracts.portfolio_manager,
    "portfolio_manager",
  );
});

test(`all ${CANONICAL_MASTER_IDS.length} method voice prompts retain the frozen-stance boundary`, () => {
  const frozen = {
    stance: "cautious",
    verdict: "contract fixture",
    summary: "contract fixture",
    source_ids: [],
    what_would_change_my_mind: [],
  };
  for (const id of CANONICAL_MASTER_IDS) {
    assertPromptContract(masterVoicePrompt(id, run, frozen), contract.contracts.method_voice, id);
  }
});

test("negative controls prove that each required contract fragment is load-bearing", () => {
  const samples = {
    evidence: taskPrompt("market_data", "TEST", "2026-08-03", "Assess TEST", "en-US"),
    debate: debatePrompt("bull_researcher", run, { round: 1 }),
    portfolio_manager: debatePrompt("portfolio_manager", run, { bull: {}, bear: {} }),
    method_voice: masterVoicePrompt("master_buffett", run, {
      stance: "cautious", verdict: "fixture", summary: "fixture", source_ids: [],
    }),
  };
  for (const [name, prompt] of Object.entries(samples)) {
    for (const required of contract.contracts[name].required) {
      const mutated = prompt.replace(required, "REMOVED_BY_NEGATIVE_CONTROL");
      assert.notEqual(mutated, prompt, `${name} fixture did not contain ${required}`);
      assert.ok(
        promptContractErrors(mutated, contract.contracts[name]).some((error) => error.includes(required)),
        `${name} did not fail when ${required} was removed`,
      );
    }
  }
});
