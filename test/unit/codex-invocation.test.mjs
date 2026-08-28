import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { __test__ } from "../../mcp/server.mjs";
import * as codexWorker from "../../mcp/lib/codex.mjs";

const { codexInvocation } = __test__;

// Both branches are pure functions of (args, platform, env), so they run on every OS in
// the matrix. That matters: the win32 branch shipped for months without ever executing
// on a Windows runner.

test("posix invocation calls codex directly and reads the prompt from stdin", () => {
  const invocation = codexInvocation(["exec", "-C", "/tmp/alpha council"], "linux", {
    ALPHACOUNCIL_AGENT_CODEX_CMD: "/opt/fixture/bin/codex",
  });
  assert.equal(invocation.command, "/opt/fixture/bin/codex");
  assert.equal(invocation.args.at(-1), "-");
  assert.equal(invocation.options.detached, true);
});

test("windows invocation goes through cmd.exe so codex.cmd resolves", () => {
  const invocation = codexInvocation(["exec", "-C", "C:\\Users\\Example User\\.alphacouncil-agent"], "win32", {
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    ALPHACOUNCIL_AGENT_CODEX_CMD: "codex",
  });
  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(invocation.args.slice(0, 3).join(" "), "/d /s /c");
  assert.ok(
    invocation.args[3].includes("\"C:\\Users\\Example User\\.alphacouncil-agent\""),
    "spaced paths must be quoted",
  );
  assert.ok(invocation.args[3].endsWith(" -"), "prompt must still be read from stdin");
});

test("windows invocation fails closed before cmd expansion or the 8191-character boundary", () => {
  assert.throws(
    () => codexInvocation(["exec", "-C", "C:\\Users\\%USERNAME%\\alpha"], "win32", {}),
    /cannot contain percent signs/u,
  );
  assert.throws(
    () => codexInvocation(["exec", "x".repeat(7800)], "win32", {}),
    /command line is .* maximum is 7800/u,
  );
});

test("Codex home resolution ignores conflicting shell HOME unless CODEX_HOME is explicit", () => {
  assert.equal(
    codexWorker.resolveCodexHome(
      { HOME: "/c/Users/MSYS", USERPROFILE: "C:\\Users\\Native" },
      "/native/home",
    ),
    join("/native/home", ".codex"),
  );
  assert.equal(
    codexWorker.resolveCodexHome(
      { CODEX_HOME: "/explicit/codex", HOME: "/wrong/home" },
      "/native/home",
    ),
    "/explicit/codex",
  );
});

test("leaf Codex workers ignore user plugins while retaining native web search", () => {
  assert.equal(typeof codexWorker.codexWorkerArgs, "function");
  const skillPath = "/tmp/user-skill/SKILL.md";
  const args = codexWorker.codexWorkerArgs("/tmp/worker-output.json", "/tmp/alpha-data", {
    disabledSkillPaths: [skillPath],
  });
  assert.ok(args.includes("--search"), "native live web search must remain available");
  assert.ok(args.includes("--ignore-user-config"), "global plugins and MCP servers must not reach leaf workers");
  assert.equal(args.filter((arg) => arg === "--ignore-user-config").length, 1);
  assert.ok(
    args.indexOf("--ignore-user-config") > args.indexOf("exec"),
    "--ignore-user-config is an exec-only flag and must follow the exec subcommand",
  );
  for (const feature of ["plugins", "apps", "tool_suggest", "multi_agent"]) {
    const index = args.indexOf(feature);
    assert.ok(index > 0 && args[index - 1] === "--disable", `${feature} must be disabled`);
    assert.ok(index < args.indexOf("exec"), `${feature} is a global feature flag`);
  }
  assert.ok(
    args.includes(`skills.config=[{path=${JSON.stringify(skillPath)},enabled=false}]`),
    "personal skills in the shared auth home must be disabled explicitly",
  );
});

test("frozen-fact and parse-repair workers can explicitly omit native search", () => {
  const args = codexWorker.codexWorkerArgs("/tmp/worker-output.json", "/tmp/alpha-data", { search: false });
  assert.equal(args.includes("--search"), false);
  assert.ok(args.includes("--ignore-user-config"));
  assert.equal(args.at(-1), "/tmp/worker-output.json");
  assert.equal(args.includes("exec"), true);
});

test("a leaf worker can bind Codex native structured output to a per-run schema", () => {
  const args = codexWorker.codexWorkerArgs("/tmp/worker-output.json", "/tmp/alpha-data", {
    outputSchema: "/tmp/verifier-output.schema.json",
  });
  const index = args.indexOf("--output-schema");
  assert.ok(index > args.indexOf("exec"));
  assert.equal(args[index + 1], "/tmp/verifier-output.schema.json");
});

test("leaf workers can pin an auditable model and reasoning effort", () => {
  const config = codexWorker.codexWorkerConfig({
    ALPHACOUNCIL_AGENT_CODEX_MODEL: "gpt-5.6-sol",
    ALPHACOUNCIL_AGENT_CODEX_REASONING_EFFORT: "max",
  });
  assert.deepEqual(config, {
    provider: "codex_cli",
    model: "gpt-5.6-sol",
    reasoning_effort: "max",
    model_source: "explicit_environment",
    reasoning_effort_source: "explicit_environment",
  });
  const args = codexWorker.codexWorkerArgs("/tmp/worker-output.json", "/tmp/alpha-data", {
    model: config.model,
    reasoningEffort: config.reasoning_effort,
  });
  assert.deepEqual(args.slice(args.indexOf("-m"), args.indexOf("-m") + 4), [
    "-m", "gpt-5.6-sol", "-c", "model_reasoning_effort=max",
  ]);
});

test("invalid explicit leaf-worker settings fail before a Codex process starts", () => {
  assert.throws(
    () => codexWorker.codexWorkerConfig({ ALPHACOUNCIL_AGENT_CODEX_MODEL: "bad model" }),
    /CODEX_MODEL/u,
  );
  assert.throws(
    () => codexWorker.codexWorkerConfig({ ALPHACOUNCIL_AGENT_CODEX_REASONING_EFFORT: "maximum" }),
    /CODEX_REASONING_EFFORT/u,
  );
});

test("fast runs freeze a stage-aware reasoning policy while keeping one model", () => {
  const env = { ALPHACOUNCIL_AGENT_CODEX_MODEL: "gpt-5.6-sol" };
  const runConfig = codexWorker.codexRunConfig(env, { councilPace: "fast" });
  assert.equal(runConfig.model, "gpt-5.6-sol");
  assert.equal(runConfig.reasoning_profile, "fast_stage_profile_v1");
  assert.equal(runConfig.pace_profile_conformance, "candidate_default");
  assert.deepEqual(
    Object.fromEntries(Object.entries(runConfig.stage_reasoning).map(([stage, item]) => [stage, item.reasoning_effort])),
    {
      evidence: "low",
      methods: "low",
      debate: "low",
      portfolio_manager: "medium",
      repair: "none",
    },
  );
  const repair = codexWorker.codexAttemptConfig(env, {
    councilPace: "fast",
    stage: "evidence",
    attemptKind: "parse_repair",
  });
  assert.equal(repair.reasoning_effort, "none");
  assert.equal(repair.reasoning_effort_source, "fast_stage_profile_v1");
  assert.equal(repair.reasoning_policy_stage, "repair");
});

test("stage-specific effort wins over global effort, which wins over the fast default", () => {
  const stage = codexWorker.codexAttemptConfig({
    ALPHACOUNCIL_AGENT_CODEX_REASONING_EFFORT: "medium",
    ALPHACOUNCIL_AGENT_CODEX_EVIDENCE_REASONING_EFFORT: "low",
  }, { councilPace: "fast", stage: "evidence", attemptKind: "primary" });
  assert.equal(stage.reasoning_effort, "low");
  assert.match(stage.reasoning_effort_source, /explicit_stage_environment/u);

  const global = codexWorker.codexAttemptConfig({
    ALPHACOUNCIL_AGENT_CODEX_REASONING_EFFORT: "medium",
  }, { councilPace: "fast", stage: "methods", attemptKind: "primary" });
  assert.equal(global.reasoning_effort, "medium");
  assert.equal(global.reasoning_effort_source, "explicit_environment");
});

test("fast rejects an unvalidated global high-or-deeper override before queueing", () => {
  assert.throws(
    () => codexWorker.codexRunConfig({
      ALPHACOUNCIL_AGENT_CODEX_REASONING_EFFORT: "max",
    }, { councilPace: "fast" }),
    /effective fast reasoning is not validated/u,
  );
  const diagnostic = codexWorker.codexRunConfig({
    ALPHACOUNCIL_AGENT_CODEX_REASONING_EFFORT: "max",
    ALPHACOUNCIL_AGENT_ALLOW_UNVALIDATED_FAST_REASONING: "true",
  }, { councilPace: "fast" });
  assert.equal(diagnostic.pace_profile_conformance, "overridden_unvalidated");
  assert.equal(diagnostic.stage_reasoning.evidence.reasoning_effort, "max");
});

test("fast validates the effective stage map rather than the legacy global field", () => {
  const medium = codexWorker.codexRunConfig({
    ALPHACOUNCIL_AGENT_CODEX_REASONING_EFFORT: "medium",
  }, { councilPace: "fast" });
  assert.equal(medium.pace_profile_conformance, "overridden_unvalidated");
  assert.ok(Object.values(medium.stage_reasoning).every((item) => item.reasoning_effort === "medium"));

  assert.throws(
    () => codexWorker.codexRunConfig({
      ALPHACOUNCIL_AGENT_CODEX_METHOD_REASONING_EFFORT: "max",
    }, { councilPace: "fast" }),
    /methods=max/u,
  );

  const safelyOverridden = codexWorker.codexRunConfig({
    ALPHACOUNCIL_AGENT_CODEX_REASONING_EFFORT: "max",
    ALPHACOUNCIL_AGENT_CODEX_EVIDENCE_REASONING_EFFORT: "low",
    ALPHACOUNCIL_AGENT_CODEX_METHOD_REASONING_EFFORT: "low",
    ALPHACOUNCIL_AGENT_CODEX_DEBATE_REASONING_EFFORT: "low",
    ALPHACOUNCIL_AGENT_CODEX_PM_REASONING_EFFORT: "medium",
    ALPHACOUNCIL_AGENT_CODEX_REPAIR_REASONING_EFFORT: "none",
  }, { councilPace: "fast" });
  assert.equal(safelyOverridden.pace_profile_conformance, "candidate_default");
  assert.equal(safelyOverridden.stage_reasoning.methods.source.includes("explicit_stage_environment"), true);
});

test("gpt-5.6-sol rejects unsupported reasoning values before a worker starts", () => {
  assert.throws(
    () => codexWorker.codexRunConfig({
      ALPHACOUNCIL_AGENT_CODEX_MODEL: "gpt-5.6-sol",
      ALPHACOUNCIL_AGENT_CODEX_REPAIR_REASONING_EFFORT: "minimal",
    }, { councilPace: "fast" }),
    /minimal is not supported by gpt-5\.6-sol/u,
  );
  assert.throws(
    () => codexWorker.codexWorkerConfig({
      ALPHACOUNCIL_AGENT_CODEX_MODEL: "gpt-5.6-sol",
      ALPHACOUNCIL_AGENT_CODEX_REASONING_EFFORT: "ultra",
    }),
    /ultra is not supported by gpt-5\.6-sol/u,
  );

  const stageOverridesWin = codexWorker.codexRunConfig({
    ALPHACOUNCIL_AGENT_CODEX_MODEL: "gpt-5.6-sol",
    ALPHACOUNCIL_AGENT_CODEX_REASONING_EFFORT: "minimal",
    ALPHACOUNCIL_AGENT_CODEX_EVIDENCE_REASONING_EFFORT: "low",
    ALPHACOUNCIL_AGENT_CODEX_METHOD_REASONING_EFFORT: "low",
    ALPHACOUNCIL_AGENT_CODEX_DEBATE_REASONING_EFFORT: "low",
    ALPHACOUNCIL_AGENT_CODEX_PM_REASONING_EFFORT: "medium",
    ALPHACOUNCIL_AGENT_CODEX_REPAIR_REASONING_EFFORT: "none",
  }, { councilPace: "fast" });
  assert.equal(stageOverridesWin.pace_profile_conformance, "candidate_default");
  assert.ok(Object.values(stageOverridesWin.stage_reasoning)
    .every((item) => item.source.startsWith("explicit_stage_environment:")));

  for (const unknownCapabilityId of [
    "provider/gpt-5.6-sol",
    "provider:gpt-5.6-sol",
    "gpt-5.6-sol-custom",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6-solution",
  ]) {
    assert.doesNotThrow(() => codexWorker.codexWorkerConfig({
      ALPHACOUNCIL_AGENT_CODEX_MODEL: unknownCapabilityId,
      ALPHACOUNCIL_AGENT_CODEX_REASONING_EFFORT: "minimal",
    }), `${unknownCapabilityId} must not inherit the exact canonical model allowlist`);
  }
});

test("unknown runtime stages fail closed instead of inheriting evidence reasoning", () => {
  assert.throws(
    () => codexWorker.codexReasoningPolicyStage("debtae_round_1", "primary"),
    /unknown Codex reasoning policy stage/u,
  );
  assert.throws(
    () => codexWorker.codexReasoningPolicyStage("debtae_round_1", "parse_repair"),
    /unknown Codex reasoning policy stage/u,
  );
});
