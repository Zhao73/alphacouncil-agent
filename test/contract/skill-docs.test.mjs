import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
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

// CLAUDE.md is an instruction file, not a description of one. It listed three roles that
// had been merged away -- sell_side_revisions, earnings_call_transcript and
// management_industry_voices -- so an agent reading it would try to dispatch seats that do
// not exist. Stale docs are a bug when the doc is loaded as a prompt.
test("CLAUDE.md names the roles that actually exist", async () => {
  const { DEFAULT_TASKS, DEBATE_ROLES } = await import("../../mcp/lib/constants.mjs");
  const { registry } = await import("../../mcp/lib/personas/registry.mjs");
  const claude = readFileSync(repoFile("CLAUDE.md"), "utf8");

  for (const id of [...DEFAULT_TASKS, ...DEBATE_ROLES]) {
    assert.ok(claude.includes(`\`${id}\``), `CLAUDE.md must name ${id}`);
  }
  const known = new Set(registry().all().map((p) => p.id));
  const cited = [...claude.matchAll(/`([a-z][a-z0-9_]{4,40})`/g)].map((m) => m[1]);
  const ghosts = cited.filter((id) => /^(market_data|earnings_|forward_|sell_side|quant_|valuation_|news_|management_|insider_|ib_|macro_|social_|bull_|bear_|portfolio_)/.test(id) && !known.has(id));
  assert.deepEqual(ghosts, [], `CLAUDE.md dispatches roles that no longer exist: ${ghosts.join(", ")}`);
});

// Three of the four hosts read generated agent files, and none of them were in the npm
// package: an install gave you the server and no subagent definitions.
test("the npm package ships the files every host actually reads", () => {
  const pkg = JSON.parse(readFileSync(repoFile("package.json"), "utf8"));
  for (const needed of [
    "mcp/", "personas/", "skills/",
    ".claude-plugin/", ".codex-plugin/", ".mcp.json",
    ".claude/agents/", "opencode.json", ".opencode/agent/",
    ".grok/agents/", ".grok/config.toml",
  ]) {
    assert.ok(pkg.files.includes(needed), `package.json files must include ${needed}`);
  }
});

// Four hosts, four different places to look for a slash command. Authoring them once and
// generating the copies is the only way `/alphacouncil` means the same thing everywhere.
test("every slash command reaches every host that has a command directory", () => {
  const authored = readdirSync(repoFile("commands")).filter((f) => f.endsWith(".md"));
  // Not a count: the set deliberately collapsed from four commands to one entry with modes,
  // and an assertion on "at least four" would have blocked that as if it were a regression.
  assert.ok(authored.length >= 1, "at least one command must ship");
  for (const file of authored) {
    const source = readFileSync(repoFile(`commands/${file}`), "utf8");
    assert.match(source, /^---\ndescription: .+/m, `${file} needs a description for the host menu`);
    for (const dir of [".claude/commands", ".opencode/command", ".grok/commands"]) {
      const copy = readFileSync(repoFile(`${dir}/${file}`), "utf8");
      assert.equal(copy, source, `${dir}/${file} drifted from commands/${file}`);
    }
  }
});

test("the plugin manifest and the npm package both declare the commands", () => {
  const plugin = JSON.parse(readFileSync(repoFile(".claude-plugin/plugin.json"), "utf8"));
  assert.equal(plugin.commands, "./commands/", "Claude Code loads commands from the manifest");
  const pkg = JSON.parse(readFileSync(repoFile("package.json"), "utf8"));
  for (const d of ["commands/", ".claude/commands/", ".opencode/command/", ".grok/commands/"]) {
    assert.ok(pkg.files.includes(d), `package.json files must include ${d}`);
  }
});

// One entry point with modes only works if the entry point documents them. Without this the
// collapse from four commands to one loses the discoverability the four provided.
test("the single command entry documents every mode it routes to", () => {
  const alpha = readFileSync(repoFile("commands/alpha.md"), "utf8");
  for (const mode of ["quick", "screen", "options", "news", "market"]) {
    assert.ok(alpha.includes(mode), `/alpha must document its ${mode} mode`);
  }
  assert.match(alpha, /empty/i, "an argument-less invocation must list what it can do rather than guessing");
  assert.match(alpha, /no model spend|costs nothing/i,
    "the modes that spawn no subagents must be marked, since that is what the user is choosing between");
});

// The package.json files array was assembled by hand and gaps surfaced one at a time: the
// host agent directories in one release, then docs/INSTALL.md -- the page an npm user reads
// specifically to learn how to invoke the thing -- in the next. This asserts the property
// instead of the individual entries.
test("every consumer-facing tracked file is in the npm package", () => {
  const tracked = execSync("git ls-files", { encoding: "utf8", cwd: repoFile(".") }).trim().split("\n");
  const packed = JSON.parse(execSync("npm pack --dry-run --json", {
    encoding: "utf8", cwd: repoFile("."), stdio: ["pipe", "pipe", "ignore"],
  }))[0].files.map((f) => f.path);
  const inPackage = new Set(packed);

  // Everything a person reads to install, use, or evaluate the package.
  const consumerFacing = tracked.filter((f) =>
    /^(docs\/|commands\/|README|CHANGELOG|LICENSE|SECURITY|CONTRIBUTING)/.test(f));
  const missing = consumerFacing.filter((f) => !inPackage.has(f));
  assert.deepEqual(missing, [],
    `these ship in the repo but not to anyone who installs it: ${missing.join(", ")}`);
});
