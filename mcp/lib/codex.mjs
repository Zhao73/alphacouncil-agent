import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_CMD, DATA_DIR } from "./constants.mjs";
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
  return { command: CODEX_CMD, args: fullArgs, options: { detached: true } };
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

export function runCodex(prompt, timeoutMs, onStart = () => {}, onHeartbeat = () => {}) {
  return new Promise((resolvePromise) => {
    mkdirSync(DATA_DIR, { recursive: true });
    const outFile = join(DATA_DIR, `codex-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    const args = [
      "--search",
      "-s",
      "read-only",
      "-a",
      "never",
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "-C",
      DATA_DIR,
      "-o",
      outFile,
    ];
    const invocation = codexInvocation(args);
    const child = spawn(invocation.command, invocation.args, {
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
      resolvePromise(value);
    };
    const heartbeat = setInterval(() => {
      onHeartbeat({ pid: child.pid, output: outFile, elapsed_ms: Date.now() - startedAt });
    }, 30000);
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild(child);
      killTimer = setTimeout(() => {
        stopChild(child, true);
      }, 5000);
    }, timeoutMs);
    // ponytail: drain both pipes; switch to streaming logs if progress UI needs live CLI output.
    child.stdout.on("data", (chunk) => { stdout = appendLimited(stdout, chunk.toString()); });
    child.stderr.on("data", (chunk) => { stderr = appendLimited(stderr, chunk.toString()); });
    child.on("error", (error) => {
      finish({ ok: false, code: null, text: "", stderr: String(error.message || error), stdout, outFile, timedOut });
    });
    child.on("close", (code) => {
      let text = "";
      if (existsSync(outFile)) text = readFileSync(outFile, "utf8");
      finish({ ok: code === 0 && text.trim().length > 0, code, text, stderr, stdout, outFile, timedOut });
    });
  });
}

export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
  return results;
}
