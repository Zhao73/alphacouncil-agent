import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { taskPrompt, debatePrompt } from "../../mcp/lib/prompts.mjs";
import { DEFAULT_TASKS, DEBATE_ROLES } from "../../mcp/lib/constants.mjs";
import { repoFile } from "../helpers/paths.mjs";

/**
 * Golden snapshot captured from the implementation that had every prompt inlined in
 * mcp/lib/prompts.mjs, before the persona files existed. Moving prompt text out of code
 * must not change a single byte of what a subagent receives.
 *
 * Editing a persona body is a deliberate act: regenerate this file and review the diff.
 *
 * The evidence-file path in a debate prompt is an absolute path under the data dir, which
 * differs per machine. It is scrubbed to a token on both sides -- baking a developer's
 * $HOME into the fixture made every CI platform fail while passing locally.
 */
const scrub = (text) => String(text).replace(/[^\s"]*[/\\]runs[/\\]GOLDEN[/\\]evidence\.json/g, "<EVIDENCE_JSON>");
const golden = JSON.parse(readFileSync(repoFile("test/fixtures/prompt-golden.json"), "utf8"));

const CASES = [
  ["zh_with_prompt", "帮我看看 NOK", "auto"],
  ["zh_no_prompt", "", "zh-CN"],
  ["en_with_prompt", "Can I enter NOK?", "auto"],
  ["en_no_prompt", "", "en-US"],
];

test("every evidence prompt matches the pre-refactor golden", () => {
  for (const task of DEFAULT_TASKS) {
    for (const [label, userPrompt, language] of CASES) {
      const key = `${task}|${label}`;
      assert.ok(golden.task_prompts[key], `golden is missing ${key}`);
      assert.equal(scrub(taskPrompt(task, "NOK", "2026-06-22", userPrompt, language)), golden.task_prompts[key], key);
    }
  }
});

test("every debate prompt matches the pre-refactor golden", () => {
  const run = { run_id: "GOLDEN", symbol: "NOK", as_of: "2026-06-22", packets: [] };
  for (const role of DEBATE_ROLES) {
    for (const language of ["中文", "English"]) {
      for (const [suffix, context] of [["", {}], ["|r3", { round: 3 }]]) {
        const key = `${role}|${language}${suffix}`;
        assert.ok(golden.debate_prompts[key], `golden is missing ${key}`);
        assert.equal(scrub(debatePrompt(role, { ...run, language }, context)), golden.debate_prompts[key], key);
      }
    }
  }
});

test("the golden covers every shipped task and role", () => {
  for (const task of DEFAULT_TASKS) {
    assert.ok(golden.task_prompts[`${task}|en_no_prompt`], `${task} has no golden entry`);
  }
  for (const role of DEBATE_ROLES) {
    assert.ok(golden.debate_prompts[`${role}|English`], `${role} has no golden entry`);
  }
});
