import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoFile } from "../helpers/paths.mjs";

const read = (rel) => readFileSync(repoFile(rel), "utf8");

test("the governance skill is bundled with explicit gates and anti-rationalizations", () => {
  const governance = read("skills/agent-skills-governance/SKILL.md");
  for (const marker of ["addyosmani/agent-skills", "Stop Gates", "Anti-Rationalizations"]) {
    assert.match(governance, new RegExp(marker.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")));
  }
});

test("the runtime skill and both memory files reference the governance skill", () => {
  const targets = {
    "skills/alphacouncil-agent/SKILL.md": read("skills/alphacouncil-agent/SKILL.md"),
    "CLAUDE.md": read("CLAUDE.md"),
    "AGENTS.md": read("AGENTS.md"),
  };
  for (const [name, text] of Object.entries(targets)) {
    assert.match(text, /agent-skills-governance/, `${name} must reference the bundled governance skill`);
  }
});

// SKILL.md is not documentation, it is the runtime instruction Codex and OpenCode load.
// A tool the skill never names is a tool those hosts will not call: six shipped that way,
// including screen_ticker, and nothing failed -- the capability was simply invisible.
test("every data tool the server exposes is named in the runtime skill", async () => {
  const { tools } = await import("../../mcp/lib/rpc.mjs");
  const skill = readFileSync(repoFile("skills/alphacouncil-agent/SKILL.md"), "utf8");

  // Workflow plumbing is described in prose by the workflow sections; what must be listed
  // by name are the tools that fetch facts, because the alternative to calling them is
  // answering from memory.
  const PLUMBING = new Set([
    "plan_visible_run", "record_visible_packet", "record_visible_decision",
    "record_master_opinion", "record_verifier_verdict", "collect_evidence",
    "analyze_symbol", "read_run", "compare_summary_modes", "preflight_permissions",
    "list_industries",
  ]);
  const dataTools = tools().map((t) => t.name).filter((n) => !PLUMBING.has(n));
  const missing = dataTools.filter((n) => !skill.includes(n));
  assert.deepEqual(missing, [],
    `SKILL.md does not name these tools, so Codex and OpenCode will never call them: ${missing.join(", ")}`);
});

// A capability list that omits what the capability cannot do invites the agent to fill the
// gap from training data, which is the failure this whole project is built against.
test("the runtime skill carries the limits the tool payloads carry", () => {
  const skill = readFileSync(repoFile("skills/alphacouncil-agent/SKILL.md"), "utf8");
  assert.match(skill, /IV percentile is not computable/i);
  assert.match(skill, /no free discovery channel/i);
  assert.match(skill, /skipped screen rule is a gap/i);
});

// The master bench and the verifier pass were described only inside the Claude Code
// section, so on Codex and OpenCode the council ran evidence -> debate -> PM and the
// twenty-one lenses never executed at all. Same plugin, materially different product.
test("the master bench and verifiers are host-neutral, not Claude Code only", () => {
  const skill = readFileSync(repoFile("skills/alphacouncil-agent/SKILL.md"), "utf8");
  const visible = skill.slice(
    skill.indexOf("## Visible-First Workflow"),
    skill.indexOf("## Data Tools"),
  );
  assert.ok(visible.length > 500, "the visible workflow section must exist");
  assert.match(visible, /record_master_opinion/,
    "the workflow every host follows must run the master bench");
  assert.match(visible, /record_verifier_verdict/,
    "the workflow every host follows must run the verifiers");
  assert.match(visible, /out_of_scope/, "out_of_scope must be described as a conclusion, not an abstention");
  assert.match(visible, /incomplete/, "the bench gate must be stated where the workflow is");
});

// A council runs from 7 to 44 seats. Choosing silently spends the user's time and money on
// a shape they never agreed to -- and in the other direction, quietly runs four seats when
// they were promised twenty-one lenses.
test("every host is told to ask which council to run before starting", () => {
  const skill = readFileSync(repoFile("skills/alphacouncil-agent/SKILL.md"), "utf8");
  const stage0 = skill.slice(skill.indexOf("## Stage 0"), skill.indexOf("## Visible-First Workflow"));
  assert.ok(stage0.length > 400, "Stage 0 must exist ahead of the workflow");
  assert.match(stage0, /list_council_options/);
  // Naming each host matters: without it the instruction reads as Claude-Code-only, which
  // is exactly how the master bench ended up never running on Codex and OpenCode.
  for (const host of ["Claude Code", "Codex", "OpenCode", "Grok Build"]) {
    assert.ok(stage0.includes(host), `Stage 0 must say how to ask on ${host}`);
  }
  assert.match(stage0, /Do not ask when they have already told you/,
    "re-asking a user who already answered is an interruption");
});
