import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
    "plan_visible_run", "record_visible_packet", "finalize_visible_run", "record_visible_decision",
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
  assert.match(skill, /IV percentile needs local history/i);
  assert.match(skill, /at least 60 daily observations/i);
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
  assert.match(visible, /record_verifier_batch/,
    "the workflow every host follows must run the verifiers");
  assert.match(visible, /out_of_scope/, "out_of_scope must be described as a conclusion, not an abstention");
  assert.match(visible, /incomplete/, "the bench gate must be stated where the workflow is");
});

test("the headless skill never holds a full council inside one MCP response", () => {
  const skill = readFileSync(repoFile("skills/alphacouncil-agent/SKILL.md"), "utf8");
  const headless = skill.slice(skill.indexOf("## Headless MCP Workflow"), skill.indexOf("## Claude Code Parallel Path"));
  assert.match(headless, /wait_for_completion=false/);
  assert.match(headless, /poll `read_run(?:\(run_id\))?`/i);
  assert.match(headless, /complete.*incomplete.*needs_verification.*failed/is);
  assert.match(headless, /verification_scope/,
    "headless users must be told which verification gate actually ran");
  assert.match(headless, /slow \+ all methods \+ all analysts/i,
    "headless must state the exact triple-verifier trigger");
  assert.match(headless, /verifier_zero/,
    "headless users must be able to distinguish zero verifier output from completion");
});

// A council runs from 7 to 44 seats, and the bench is where that varies. One question, so
// the user configures the run without being interviewed; and it names each host, because
// leaving that implicit is how the bench ended up never running on Codex and OpenCode.
test("every host asks for methods and the independent analyst scope once before starting", () => {
  const skill = readFileSync(repoFile("skills/alphacouncil-agent/SKILL.md"), "utf8");
  const stage0 = skill.slice(skill.indexOf("## Stage 0"), skill.indexOf("## Visible-First Workflow"));
  assert.ok(stage0.length > 400, "Stage 0 must exist ahead of the workflow");
  assert.match(stage0, /list_council_options/);
  for (const host of ["Claude Code", "Codex", "OpenCode", "Grok Build"]) {
    assert.ok(skill.includes(host), `the workflow must say how to ask on ${host}`);
  }
  assert.match(stage0, /Skip the question entirely/,
    "re-asking a user who already answered is an interruption");
  assert.match(stage0, /core = 8.*all = 11/is,
    "the two explicit analyst choices must be shown with their exact seat counts");
  assert.match(stage0, /Never collapse.*all methods.*all analysts/is,
    "method all and analyst all must remain independent choices");
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

// CLAUDE.md and AGENTS.md are executable host instructions. A stale Claude-only rule once
// allowed a full run with two missing method voices to reach debate and PM even though the
// runtime gate had already become all-or-nothing. Keep both hosts aligned with that gate.
test("full method-voice failure stops every host before debate and PM", () => {
  const authorities = {
    "CLAUDE.md": read("CLAUDE.md"),
    "AGENTS.md": read("AGENTS.md"),
  };

  for (const [name, text] of Object.entries(authorities)) {
    assert.match(text,
      /(?:every selected method[\s\S]{0,100}real `model_voice`|real `model_voice`[\s\S]{0,100}every selected method)/i,
      `${name} must require every selected full-run method voice`);
    assert.match(text, /(?:timeout|times out)[\s\S]{0,240}stop(?:s)?\s+before Bull\/Bear and PM/i,
      `${name} must stop before debate and PM when a selected method voice fails`);
  }
  assert.doesNotMatch(authorities["CLAUDE.md"],
    /Whether the debate and PM run at all[\s\S]{0,300}near-complete bench/i,
    "Claude Code must not retain the superseded full-run quorum rule");
});

// Three of the four hosts read generated agent files, and none of them were in the npm
// package: an install gave you the server and no subagent definitions.
test("the npm package ships the files every host actually reads", () => {
  const pkg = JSON.parse(readFileSync(repoFile("package.json"), "utf8"));
  for (const needed of [
    "mcp/", "personas/", "skills/",
    ".claude-plugin/", ".codex-plugin/", "codex.mcp.json",
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

test("the npm tarball excludes PersonaPack staging and every raw acquisition artifact", () => {
  const packed = JSON.parse(execSync("npm pack --dry-run --json", {
    encoding: "utf8", cwd: repoFile("."), stdio: ["pipe", "pipe", "ignore"],
  }))[0].files.map((file) => file.path);

  const leaked = packed.filter((path) =>
    path.startsWith("knowledge/staging/")
    || path.includes("/acquisitions/")
    || /(?:^|\/)source\.bin$/u.test(path));
  assert.deepEqual(leaked, [],
    `raw PersonaPack staging/acquisition artifacts leaked into npm: ${leaked.join(", ")}`);
  assert.ok(packed.some((path) => path.startsWith("knowledge/masters/")),
    "the package must still ship admitted production master manifests");
  assert.ok(packed.includes("docs/persona-v3-deterministic-policy.md"),
    "the package must ship the PersonaPack v3 deterministic policy consumed by operators");
  const reviewJson = packed.filter((path) => path.startsWith("knowledge/ai-assisted-solo/reviews/") && path.endsWith(".json"));
  const repoReviewJson = execSync("git ls-files knowledge/ai-assisted-solo/reviews", { cwd: repoFile("."), encoding: "utf8" })
    .split("\n").filter((path) => path.endsWith(".json") && existsSync(repoFile(path)));
  assert.equal(reviewJson.length, repoReviewJson.length,
    "the package must ship the complete hash-verifiable AI review capsule");
  assert.equal(packed.some((path) => path.startsWith("knowledge/ai-assisted-solo/host-e2e/")), false,
    "machine-local host failure evidence with workstation paths must not ship");
});
