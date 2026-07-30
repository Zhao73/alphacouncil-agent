import { spawn } from "node:child_process";
import { once } from "node:events";
import { repoRoot, serverEntry } from "./paths.mjs";

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Spawn the MCP server over stdio and resolve each request by its JSON-RPC id.
 *
 * The old selfcheck fired requests, slept a fixed 800ms, then killed the child and
 * parsed whatever had arrived. That is a race: on a slow or Windows runner the
 * responses simply had not been written yet, and the failure looked like a logic bug.
 */
export function startServer({ dataDir, cwd = repoRoot, env = {} } = {}) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(dataDir ? { ALPHACOUNCIL_AGENT_DATA_DIR: dataDir } : {}),
      ...env,
    },
  });

  const pending = new Map();
  const responses = [];
  const stderr = [];
  let buffer = "";
  let exited = null;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) handleLine(line);
      index = buffer.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      rejectAll(new Error(`server wrote a non-JSON line to stdout: ${line} (${error.message})`));
      return;
    }
    responses.push(message);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  function rejectAll(error) {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  }

  child.on("close", (code, signal) => {
    exited = { code, signal };
    rejectAll(new Error(`server exited (code=${code} signal=${signal}) with requests still pending. stderr: ${stderr.join("")}`));
  });
  child.on("error", (error) => rejectAll(error));

  let nextId = 1;

  function request(method, params, { id = nextId++, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (exited) return Promise.reject(new Error("server already exited"));
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${method} (id=${JSON.stringify(id)})`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      pending.set(id, { resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  }

  const callTool = (name, args, options) => request("tools/call", { name, arguments: args }, options);

  async function close() {
    if (!exited) {
      child.stdin.end();
      await once(child, "close");
    }
    return { responses, stderr: stderr.join("") };
  }

  return { child, request, callTool, close, responses, stderrChunks: stderr };
}

/** Unwrap the structuredContent of a tools/call response, failing loudly on a JSON-RPC error. */
export function structured(response) {
  if (response.error) {
    throw new Error(`tool call failed: ${response.error.code} ${response.error.message}`);
  }
  return response.result?.structuredContent;
}

/** Open and confirm the mandatory per-run master chooser in integration tests. */
export async function confirmMasterSelection(server, {
  symbol,
  selected_master_ids = ["master_buffett"],
  selection,
  select_all,
  language = "English",
  prompt = "",
  host = "test",
  council_mode = "full",
  // The depth tier is the gate's second decision, so a fixture picks it here rather than at
  // execution time -- the receipt binds it and execution may no longer change it.
  council_pace,
} = {}) {
  const opened = structured(await server.callTool("begin_council_selection", {
    symbol, language, prompt, host, council_mode,
  }));
  const choice = selection !== undefined
    ? { selection }
    : select_all === true
      ? { select_all: true }
      : { selected_master_ids };
  return structured(await server.callTool("confirm_master_selection", {
    selection_id: opened.selection_id,
    catalog_hash: opened.catalog_hash,
    display_ack: true,
    ...choice,
    ...(council_pace ? { council_pace } : {}),
  }));
}
