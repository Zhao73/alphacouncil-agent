import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_CMD, DATA_DIR, LIMITS } from "./constants.mjs";
import { MAX_WORKER_JSON_CHARS } from "./bounded-json.mjs";
import { appendLimited } from "./text.mjs";

const OUTPUT_DIAGNOSTIC_BYTES = 4096;
// parseJsonTransport limits JavaScript characters, while this layer sees UTF-8 bytes. A valid
// CJK-heavy payload may use three bytes per character (and supplementary Unicode four), so the
// pre-read ceiling must preserve every payload the downstream character contract can accept.
export const MAX_WORKER_OUTPUT_BYTES = MAX_WORKER_JSON_CHARS * 4;

const USAGE_LIMIT_PATTERN = /(?:you(?:'|’)ve hit your usage limit|usage limit[^\r\n]{0,160}purchase more credits|purchase more credits[^\r\n]{0,160}usage limit)/iu;
const USAGE_LIMIT_RETRY_PATTERN = /try again at ([A-Za-z]{3,9} \d{1,2}(?:st|nd|rd|th)?, \d{4} \d{1,2}:\d{2} (?:AM|PM))/iu;
const CODEX_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,127}$/u;
const CODEX_REASONING_EFFORTS = new Set([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
]);
const GPT_56_SOL_REASONING_EFFORTS = new Set([
  "none", "low", "medium", "high", "xhigh", "max",
]);
const FAST_REASONING_PROFILE = Object.freeze({
  evidence: "low",
  methods: "low",
  debate: "low",
  portfolio_manager: "medium",
  repair: "none",
});
const STAGE_REASONING_ENV = Object.freeze({
  evidence: "ALPHACOUNCIL_AGENT_CODEX_EVIDENCE_REASONING_EFFORT",
  methods: "ALPHACOUNCIL_AGENT_CODEX_METHOD_REASONING_EFFORT",
  debate: "ALPHACOUNCIL_AGENT_CODEX_DEBATE_REASONING_EFFORT",
  portfolio_manager: "ALPHACOUNCIL_AGENT_CODEX_PM_REASONING_EFFORT",
  repair: "ALPHACOUNCIL_AGENT_CODEX_REPAIR_REASONING_EFFORT",
});

function optionalWorkerSetting(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function assertModelReasoningEffort(model, reasoningEffort, label) {
  // Only the canonical ID was verified against the live Codex CLI. Provider namespaces,
  // aliases and future suffixes may route to different capability sets and must not inherit
  // this allowlist by pattern guesswork.
  if (model !== "gpt-5.6-sol" || !reasoningEffort) return;
  if (GPT_56_SOL_REASONING_EFFORTS.has(reasoningEffort)) return;
  throw new Error(
    `${label}=${reasoningEffort} is not supported by ${model}; use one of ${[...GPT_56_SOL_REASONING_EFFORTS].join(", ")}`,
  );
}

/** Resolve and validate the non-secret Codex leaf-worker settings recorded with every run. */
export function codexWorkerConfig(env = process.env, { validateModelReasoning = true } = {}) {
  const model = optionalWorkerSetting(env.ALPHACOUNCIL_AGENT_CODEX_MODEL);
  const reasoningEffort = optionalWorkerSetting(env.ALPHACOUNCIL_AGENT_CODEX_REASONING_EFFORT);
  if (model && !CODEX_MODEL_PATTERN.test(model)) {
    throw new Error(
      "ALPHACOUNCIL_AGENT_CODEX_MODEL must be a 1-128 character Codex model identifier",
    );
  }
  if (reasoningEffort && !CODEX_REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error(
      `ALPHACOUNCIL_AGENT_CODEX_REASONING_EFFORT must be one of ${[...CODEX_REASONING_EFFORTS].join(", ")}`,
    );
  }
  if (validateModelReasoning) {
    assertModelReasoningEffort(model, reasoningEffort, "ALPHACOUNCIL_AGENT_CODEX_REASONING_EFFORT");
  }
  return Object.freeze({
    provider: "codex_cli",
    model,
    reasoning_effort: reasoningEffort,
    model_source: model ? "explicit_environment" : "codex_default",
    reasoning_effort_source: reasoningEffort ? "explicit_environment" : "codex_default",
  });
}

export function codexReasoningPolicyStage(stage, attemptKind) {
  const runtimeStage = String(stage || "");
  const knownRuntimeStage = runtimeStage === "evidence"
    || runtimeStage === "verification"
    || runtimeStage === "methods"
    || runtimeStage === "portfolio_manager"
    || /^debate_round_[1-3]$/u.test(runtimeStage);
  const syntheticRepairStage = runtimeStage === "repair" && attemptKind === "parse_repair";
  if (!knownRuntimeStage && !syntheticRepairStage) {
    throw new Error(`unknown Codex reasoning policy stage: ${runtimeStage || "<empty>"}`);
  }
  if (attemptKind === "parse_repair") return "repair";
  if (runtimeStage === "methods") return "methods";
  if (runtimeStage === "portfolio_manager") return "portfolio_manager";
  if (runtimeStage === "evidence" || runtimeStage === "verification") return "evidence";
  return "debate";
}

function explicitBoolean(value) {
  return /^(?:1|true|yes)$/iu.test(String(value || "").trim());
}

function assertReasoningEffort(value, label) {
  if (value && !CODEX_REASONING_EFFORTS.has(value)) {
    throw new Error(
      `${label} must be one of ${[...CODEX_REASONING_EFFORTS].join(", ")}`,
    );
  }
}

/**
 * Resolve the immutable per-attempt policy for one run.
 *
 * Explicit stage settings win over the legacy global setting. The fast profile is used only
 * when neither was supplied; it keeps search/explanation calls at low, reserves medium for the
 * PM, and makes no-search repairs mechanical. A global high-or-deeper fast run is rejected
 * before queueing unless the operator explicitly marks it as an unvalidated diagnostic.
 */
export function codexAttemptConfig(env = process.env, {
  councilPace = null,
  stage = "evidence",
  attemptKind = "primary",
} = {}) {
  // Parse the global setting without validating its model compatibility yet: an explicit
  // stage setting has higher precedence and may replace an unsupported global fallback.
  const base = codexWorkerConfig(env, { validateModelReasoning: false });
  const policyStage = codexReasoningPolicyStage(stage, attemptKind);
  const stageEnv = STAGE_REASONING_ENV[policyStage];
  const stageEffort = optionalWorkerSetting(env[stageEnv]);
  assertReasoningEffort(stageEffort, stageEnv);
  const fastDefault = councilPace === "fast" ? FAST_REASONING_PROFILE[policyStage] : null;
  const reasoningEffort = stageEffort || base.reasoning_effort || fastDefault;
  assertModelReasoningEffort(base.model, reasoningEffort, stageEnv);
  const reasoningSource = stageEffort
    ? `explicit_stage_environment:${stageEnv}`
    : base.reasoning_effort
      ? "explicit_environment"
      : fastDefault
        ? "fast_stage_profile_v1"
        : "codex_default";
  return Object.freeze({
    ...base,
    reasoning_effort: reasoningEffort,
    reasoning_effort_source: reasoningSource,
    reasoning_policy_stage: policyStage,
    reasoning_profile: councilPace === "fast" ? "fast_stage_profile_v1" : "uniform_or_codex_default",
  });
}

/** Validate and describe the complete worker policy before a run directory is queued. */
export function codexRunConfig(env = process.env, { councilPace = null } = {}) {
  const base = codexWorkerConfig(env, { validateModelReasoning: false });
  const allowUnvalidated = explicitBoolean(env.ALPHACOUNCIL_AGENT_ALLOW_UNVALIDATED_FAST_REASONING);
  const stages = Object.fromEntries(Object.keys(FAST_REASONING_PROFILE).map((stage) => {
    const attemptKind = stage === "repair" ? "parse_repair" : "primary";
    const runtimeStage = stage === "debate" ? "debate_round_1" : stage;
    const config = codexAttemptConfig(env, { councilPace, stage: runtimeStage, attemptKind });
    return [stage, {
      reasoning_effort: config.reasoning_effort,
      source: config.reasoning_effort_source,
    }];
  }));
  const deepFastStages = councilPace === "fast"
    ? Object.entries(stages)
      .filter(([, config]) => ["high", "xhigh", "max", "ultra"].includes(config.reasoning_effort))
      .map(([stage, config]) => `${stage}=${config.reasoning_effort}`)
    : [];
  if (deepFastStages.length && !allowUnvalidated) {
    throw new Error(
      `effective fast reasoning is not validated (${deepFastStages.join(", ")}); `
      + "use normal/slow, lower the effective stage settings, or explicitly set "
      + "ALPHACOUNCIL_AGENT_ALLOW_UNVALIDATED_FAST_REASONING=true for a diagnostic run",
    );
  }
  const matchesFastCandidate = councilPace === "fast"
    && Object.entries(FAST_REASONING_PROFILE)
      .every(([stage, effort]) => stages[stage]?.reasoning_effort === effort);
  return Object.freeze({
    ...base,
    reasoning_profile: councilPace === "fast" ? "fast_stage_profile_v1" : "uniform_or_codex_default",
    stage_reasoning: stages,
    pace_profile_conformance: councilPace !== "fast"
      ? "not_applicable"
      : matchesFastCandidate ? "candidate_default" : "overridden_unvalidated",
  });
}

/** Classify process failures before callers reduce every provider rejection to exit code 1. */
export function workerExecutionFailureKind(result = {}) {
  if (result.deadline_exhausted) return "global_deadline";
  if (result.timedOut) return "timeout";
  const stderr = String(result.stderr || "");
  if (USAGE_LIMIT_PATTERN.test(stderr)) return "usage_limit_exhausted";
  if (/invalid_json_schema|Invalid schema for response_format/iu.test(stderr)) {
    return "output_schema_rejected";
  }
  if (/context_length_exceeded|maximum context length/iu.test(stderr)) {
    return "context_length_exceeded";
  }
  return `exit_code_${Number.isInteger(result.code) ? result.code : "unknown"}`;
}

/** Return only the provider-authored retry timestamp, never the surrounding stderr body. */
export function workerUsageLimitRetryHint(result = {}) {
  const match = String(result.stderr || "").match(USAGE_LIMIT_RETRY_PATTERN);
  return match?.[1] || null;
}

function readExactly(fd, length, position = 0) {
  const output = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const bytesRead = readSync(fd, output, offset, length - offset, position + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === length ? output : output.subarray(0, offset);
}

/**
 * Read a worker output without ever allocating a buffer proportional to an untrusted file.
 * Oversized files are rejected before decoding; only bounded prefix/tail diagnostics and a
 * fingerprint of those samples plus the byte count are retained. Do not hash the entire bad
 * file: an attacker-controlled multi-gigabyte output must not turn rejection into an I/O stall.
 */
export function readWorkerOutputBounded(
  path,
  { maxBytes = MAX_WORKER_OUTPUT_BYTES, diagnosticBytes = OUTPUT_DIAGNOSTIC_BYTES } = {},
) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= maxBytes) {
      return {
        text: readExactly(fd, size).toString("utf8"),
        output_bytes: size,
        output_too_large: false,
      };
    }

    const sampleSize = Math.min(Math.max(0, Math.floor(Number(diagnosticBytes) || 0)), size, 64 * 1024);
    const prefix = readExactly(fd, sampleSize);
    const tail = readExactly(fd, sampleSize, Math.max(0, size - sampleSize));
    const fingerprint = createHash("sha256")
      .update(`bytes:${size}\n`)
      .update(prefix)
      .update(tail)
      .digest("hex");
    return {
      text: "",
      output_bytes: size,
      output_too_large: true,
      output_fingerprint_sha256: fingerprint,
      output_hash_scope: "byte_count_plus_prefix_tail",
      output_prefix: prefix.toString("utf8"),
      output_tail: tail.toString("utf8"),
      max_output_bytes: maxBytes,
    };
  } finally {
    closeSync(fd);
  }
}

export function quoteCmdArg(value) {
  const text = String(value);
  if (!text) return "\"\"";
  if (!/[ \t"&|<>^]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

export function codexInvocation(args, platform = process.platform, env = process.env) {
  const fullArgs = [...args, "-"];
  if (platform === "win32") {
    return {
      command: env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", [env.ALPHACOUNCIL_AGENT_CODEX_CMD || CODEX_CMD, ...fullArgs].map(quoteCmdArg).join(" ")],
      options: { detached: false, windowsHide: true },
    };
  }
  return {
    command: env.ALPHACOUNCIL_AGENT_CODEX_CMD || CODEX_CMD,
    args: fullArgs,
    options: { detached: true },
  };
}

export function stopChild(child, force = false) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(child.pid), "/t"];
    if (force) args.push("/f");
    const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
    killer.on("error", () => child.kill(force ? "SIGKILL" : "SIGTERM"));
    return;
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

/**
 * Build one isolated leaf-worker invocation.
 *
 * Native `--search` is the worker's evidence channel. User config is deliberately ignored:
 * otherwise every globally enabled plugin/MCP server is inherited and a leaf can call a
 * second Codex-backed search bridge, creating recursive workers and multi-minute nested
 * timeouts. Authentication still comes from CODEX_HOME according to the Codex CLI contract.
 */
export function codexWorkerArgs(
  outFile,
  dataDir = DATA_DIR,
  { search = true, outputSchema = null, model = null, reasoningEffort = null } = {},
) {
  const workerConfig = codexWorkerConfig({
    ALPHACOUNCIL_AGENT_CODEX_MODEL: model || "",
    ALPHACOUNCIL_AGENT_CODEX_REASONING_EFFORT: reasoningEffort || "",
  });
  return [
    ...(search ? ["--search"] : []),
    "-s",
    "read-only",
    "-a",
    "never",
    ...(workerConfig.model ? ["-m", workerConfig.model] : []),
    ...(workerConfig.reasoning_effort
      ? ["-c", `model_reasoning_effort=${workerConfig.reasoning_effort}`]
      : []),
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    ...(outputSchema ? ["--output-schema", outputSchema] : []),
    "-C",
    dataDir,
    "-o",
    outFile,
  ];
}

export function runCodex(prompt, timeoutMs, onStart = () => {}, onHeartbeat = () => {}, runtime = {}) {
  return new Promise((resolvePromise) => {
    const workerDataDir = runtime.dataDir || DATA_DIR;
    const runtimeEnv = { ...process.env, ...(runtime.env || {}) };
    // Validate operator-supplied settings before allocating a per-worker runtime directory.
    // A bad model name must fail without starting a process or leaking temporary state.
    const requestedWorkerConfig = runtime.workerConfig || codexWorkerConfig(runtimeEnv);
    const validatedWorkerConfig = codexWorkerConfig({
      ALPHACOUNCIL_AGENT_CODEX_MODEL: requestedWorkerConfig.model || "",
      ALPHACOUNCIL_AGENT_CODEX_REASONING_EFFORT: requestedWorkerConfig.reasoning_effort || "",
    });
    const workerConfig = Object.freeze({
      ...validatedWorkerConfig,
      model_source: requestedWorkerConfig.model_source || validatedWorkerConfig.model_source,
      reasoning_effort_source:
        requestedWorkerConfig.reasoning_effort_source || validatedWorkerConfig.reasoning_effort_source,
      ...(requestedWorkerConfig.reasoning_policy_stage
        ? { reasoning_policy_stage: requestedWorkerConfig.reasoning_policy_stage }
        : {}),
      ...(requestedWorkerConfig.reasoning_profile
        ? { reasoning_profile: requestedWorkerConfig.reasoning_profile }
        : {}),
    });
    mkdirSync(workerDataDir, { recursive: true });
    // Some Codex builds still start installed MCP plugins even with --ignore-user-config.
    // A nested AlphaCouncil server must never scan or recover the parent run. Isolate only
    // plugin runtime data; authentication still comes from the caller's CODEX_HOME and the
    // worker's output/cwd remain in workerDataDir.
    const ownsLeafRuntimeDir = !runtime.leafRuntimeDir;
    const leafRuntimeDir = runtime.leafRuntimeDir
      || mkdtempSync(join(runtime.leafRuntimeRoot || tmpdir(), "alphacouncil-leaf-"));
    const childEnv = {
      ...runtimeEnv,
      ALPHACOUNCIL_AGENT_DATA_DIR: leafRuntimeDir,
    };
    const outFile = join(workerDataDir, `codex-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    const args = codexWorkerArgs(outFile, workerDataDir, {
      search: runtime.search !== false,
      outputSchema: runtime.outputSchema || null,
      model: workerConfig.model,
      reasoningEffort: workerConfig.reasoning_effort,
    });
    const invocation = codexInvocation(args, process.platform, childEnv);
    const spawnWorker = runtime.spawn || spawn;
    const stopWorker = runtime.stopChild || stopChild;
    const killGraceMs = Number.isFinite(runtime.sigkillGraceMs)
      ? Math.max(0, runtime.sigkillGraceMs)
      : LIMITS.SIGKILL_GRACE_MS;
    let child;
    try {
      child = spawnWorker(invocation.command, invocation.args, {
        cwd: workerDataDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
        ...invocation.options,
      });
    } catch (error) {
      // A synchronous ENOENT/EACCES never crossed a process boundary. Resolve it as a
      // not_started attempt after cleanup so every caller receives the same result envelope.
      try { unlinkSync(outFile); } catch {}
      if (ownsLeafRuntimeDir) {
        try { rmSync(leafRuntimeDir, { recursive: true, force: true }); } catch {}
      }
      resolvePromise({
        ok: false,
        code: null,
        text: "",
        stderr: String(error.message || error),
        stdout: "",
        outFile,
        timedOut: false,
        spawn_error: true,
        timing: {
          started_at: null,
          finished_at: null,
          elapsed_ms: 0,
          timed_out: false,
          forced_settle: false,
          pid: null,
          outcome: "not_started",
          duration_scope: "local_child_spawn_to_settlement_wall_time",
        },
      });
      return;
    }
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.parse(startedAt);
    const absoluteDeadlineMs = Number.isFinite(runtime.absoluteDeadlineMs)
      ? Number(runtime.absoluteDeadlineMs)
      : null;
    // The timeout timer starts only after spawn. Re-clamp here so process startup cannot push
    // timeout + SIGKILL settlement beyond the caller's absolute seat/round deadline.
    const remainingAfterSpawnMs = absoluteDeadlineMs === null
      ? null
      : Math.max(0, absoluteDeadlineMs - startedAtMs);
    const effectiveKillGraceMs = remainingAfterSpawnMs === null
      ? killGraceMs
      : Math.min(killGraceMs, remainingAfterSpawnMs);
    const workerTimeoutMs = absoluteDeadlineMs === null
      ? Math.max(0, timeoutMs)
      : Math.max(0, Math.min(timeoutMs, remainingAfterSpawnMs - effectiveKillGraceMs));
    const timingPid = Number.isInteger(child.pid) && child.pid > 0 ? child.pid : null;
    child.stdin.on("error", () => {});
    child.stdin.end(prompt, "utf8");
    onStart({
      pid: child.pid,
      output: outFile,
      started_at: startedAt,
      worker_timeout_ms: workerTimeoutMs,
      settlement_grace_ms: effectiveKillGraceMs,
      worker_execution_config: workerConfig,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let heartbeat = null;
    let timer = null;
    let killTimer = null;
    const finish = (value, outcome = "failed") => {
      if (settled) return;
      settled = true;
      const finishedAt = new Date().toISOString();
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      if (killTimer) clearTimeout(killTimer);
      // The caller already has the text by now. Nothing deleted this before, so every
      // analyst of every run left one file behind in DATA_DIR forever.
      try {
        unlinkSync(outFile);
      } catch {
        // Codex may never have created it (spawn error, immediate timeout).
      }
      if (ownsLeafRuntimeDir) {
        try { rmSync(leafRuntimeDir, { recursive: true, force: true }); } catch {}
      }
      resolvePromise({
        ...value,
        timing: {
          started_at: startedAt,
          finished_at: finishedAt,
          elapsed_ms: Math.max(0, Date.parse(finishedAt) - startedAtMs),
          timed_out: value.timedOut === true,
          forced_settle: value.forced_settle === true,
          pid: timingPid,
          outcome,
          duration_scope: "local_child_spawn_to_settlement_wall_time",
          worker_timeout_ms: workerTimeoutMs,
          settlement_grace_ms: effectiveKillGraceMs,
          worker_execution_config: workerConfig,
        },
      });
    };
    heartbeat = setInterval(() => {
      onHeartbeat({ pid: child.pid, output: outFile, elapsed_ms: Date.now() - startedAtMs });
    }, LIMITS.HEARTBEAT_MS);
    const forceSettle = () => {
      if (settled) return;
      stopWorker(child, true);
      // Do not trust a broken process tree to emit `close`. The worker deadline plus the
      // grace period is a hard settlement boundary; any output written afterwards is
      // rejected and removed by the late close handler or the startup sweeper.
      finish({
        ok: false,
        code: null,
        text: "",
        stderr: appendLimited(stderr, "\nworker did not close after SIGKILL grace"),
        stdout,
        outFile,
        timedOut: true,
        forced_settle: true,
      }, "timed_out");
    };
    const beginTimeout = () => {
      if (settled) return;
      timedOut = true;
      stopWorker(child);
      if (settled) return;
      if (effectiveKillGraceMs === 0) {
        forceSettle();
        return;
      }
      killTimer = setTimeout(forceSettle, effectiveKillGraceMs);
    };
    // Drain both pipes; switch to streaming logs if a progress UI needs live CLI output.
    child.stdout.on("data", (chunk) => { stdout = appendLimited(stdout, chunk.toString()); });
    child.stderr.on("data", (chunk) => { stderr = appendLimited(stderr, chunk.toString()); });
    child.on("error", (error) => {
      finish({ ok: false, code: null, text: "", stderr: String(error.message || error), stdout, outFile, timedOut }, "spawn_failed");
    });
    child.on("close", (code) => {
      if (settled) {
        try { unlinkSync(outFile); } catch {}
        return;
      }
      let output = { text: "", output_bytes: 0, output_too_large: false };
      try {
        if (existsSync(outFile)) output = readWorkerOutputBounded(outFile);
      } catch (error) {
        finish({
          ok: false,
          code,
          ...output,
          output_read_error: true,
          stderr: appendLimited(stderr, `\nworker output could not be read: ${error.message || error}`),
          stdout,
          outFile,
          timedOut,
        }, timedOut ? "timed_out" : "failed");
        return;
      }
      if (output.output_too_large) {
        stderr = appendLimited(
          stderr,
          `\nworker output exceeded ${output.max_output_bytes} bytes; bytes=${output.output_bytes}; fingerprint_sha256=${output.output_fingerprint_sha256}`,
        );
      }
      // A cooperative child may flush a valid-looking output and exit zero after it has
      // received our timeout signal. The deadline still won: post-timeout output must never
      // be promoted into evidence merely because shutdown happened cleanly.
      const ok = !timedOut && code === 0 && !output.output_too_large && output.text.trim().length > 0;
      finish({
        ok,
        code,
        ...output,
        stderr,
        stdout,
        outFile,
        timedOut,
      }, timedOut ? "timed_out" : ok ? "completed" : "failed");
    });
    if (absoluteDeadlineMs !== null && remainingAfterSpawnMs === 0) {
      // Synchronous process startup already consumed the lifecycle. Terminate and settle now;
      // adding the configured grace here would move the attempt past its absolute deadline.
      beginTimeout();
    } else {
      timer = setTimeout(beginTimeout, workerTimeoutMs);
    }
  });
}

/**
 * Delete Codex output files left behind by older versions (and by any run killed
 * between spawn and finish). Called once at server start; never throws.
 */
export function sweepStaleOutputs(now = Date.now()) {
  let removed = 0;
  let entries;
  try {
    entries = readdirSync(DATA_DIR);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (!/^codex-\d+-[0-9a-f]+\.txt$/.test(name)) continue;
    const path = join(DATA_DIR, name);
    try {
      if (now - statSync(path).mtimeMs < LIMITS.STALE_OUTPUT_MS) continue;
      unlinkSync(path);
      removed += 1;
    } catch {
      // Another process may have removed it, or it may not be ours to delete.
    }
  }
  return removed;
}

export async function mapLimit(items, limit, worker, onError) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        if (!onError) throw error;
        results[index] = await onError(error, items[index], index);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
  return results;
}
