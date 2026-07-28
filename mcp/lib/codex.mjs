import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CODEX_CMD, DATA_DIR, LIMITS } from "./constants.mjs";
import { appendLimited } from "./text.mjs";

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
export function codexWorkerArgs(outFile, dataDir = DATA_DIR, { search = true } = {}) {
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
    "-C",
    dataDir,
    "-o",
    outFile,
  ];
}

export function runCodex(prompt, timeoutMs, onStart = () => {}, onHeartbeat = () => {}, runtime = {}) {
  return new Promise((resolvePromise) => {
    mkdirSync(DATA_DIR, { recursive: true });
    const outFile = join(DATA_DIR, `codex-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    const args = codexWorkerArgs(outFile, DATA_DIR, { search: runtime.search !== false });
    const invocation = codexInvocation(args);
    const spawnWorker = runtime.spawn || spawn;
    const stopWorker = runtime.stopChild || stopChild;
    const killGraceMs = Number.isFinite(runtime.sigkillGraceMs)
      ? Math.max(0, runtime.sigkillGraceMs)
      : LIMITS.SIGKILL_GRACE_MS;
    const child = spawnWorker(invocation.command, invocation.args, {
      cwd: DATA_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      ...invocation.options,
    });
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
      let text = "";
      if (existsSync(outFile)) text = readFileSync(outFile, "utf8");
      // A cooperative child may flush a valid-looking output and exit zero after it has
      // received our timeout signal. The deadline still won: post-timeout output must never
      // be promoted into evidence merely because shutdown happened cleanly.
      finish({ ok: !timedOut && code === 0 && text.trim().length > 0, code, text, stderr, stdout, outFile, timedOut });
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
