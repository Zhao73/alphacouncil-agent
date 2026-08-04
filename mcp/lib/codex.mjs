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
export function codexWorkerArgs(outFile, dataDir = DATA_DIR, { search = true, outputSchema = null } = {}) {
  return [
    ...(search ? ["--search"] : []),
    "-s",
    "read-only",
    "-a",
    "never",
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
    mkdirSync(workerDataDir, { recursive: true });
    // Some Codex builds still start installed MCP plugins even with --ignore-user-config.
    // A nested AlphaCouncil server must never scan or recover the parent run. Isolate only
    // plugin runtime data; authentication still comes from the caller's CODEX_HOME and the
    // worker's output/cwd remain in workerDataDir.
    const ownsLeafRuntimeDir = !runtime.leafRuntimeDir;
    const leafRuntimeDir = runtime.leafRuntimeDir
      || mkdtempSync(join(runtime.leafRuntimeRoot || tmpdir(), "alphacouncil-leaf-"));
    const childEnv = {
      ...process.env,
      ...(runtime.env || {}),
      ALPHACOUNCIL_AGENT_DATA_DIR: leafRuntimeDir,
    };
    const outFile = join(workerDataDir, `codex-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    const args = codexWorkerArgs(outFile, workerDataDir, {
      search: runtime.search !== false,
      outputSchema: runtime.outputSchema || null,
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
      // Promise executors turn the rethrow into a rejection. Clean the directory first:
      // a synchronous ENOENT/EACCES must not leak one private plugin runtime per attempt.
      try { unlinkSync(outFile); } catch {}
      if (ownsLeafRuntimeDir) {
        try { rmSync(leafRuntimeDir, { recursive: true, force: true }); } catch {}
      }
      throw error;
    }
    child.stdin.on("error", () => {});
    child.stdin.end(prompt, "utf8");
    onStart({ pid: child.pid, output: outFile });
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
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
      resolvePromise(value);
    };
    const heartbeat = setInterval(() => {
      onHeartbeat({ pid: child.pid, output: outFile, elapsed_ms: Date.now() - startedAt });
    }, LIMITS.HEARTBEAT_MS);
    const timer = setTimeout(() => {
      timedOut = true;
      stopWorker(child);
      killTimer = setTimeout(() => {
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
        });
      }, killGraceMs);
    }, timeoutMs);
    // Drain both pipes; switch to streaming logs if a progress UI needs live CLI output.
    child.stdout.on("data", (chunk) => { stdout = appendLimited(stdout, chunk.toString()); });
    child.stderr.on("data", (chunk) => { stderr = appendLimited(stderr, chunk.toString()); });
    child.on("error", (error) => {
      finish({ ok: false, code: null, text: "", stderr: String(error.message || error), stdout, outFile, timedOut });
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
        });
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
      finish({
        ok: !timedOut && code === 0 && !output.output_too_large && output.text.trim().length > 0,
        code,
        ...output,
        stderr,
        stdout,
        outFile,
        timedOut,
      });
    });
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
