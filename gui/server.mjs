#!/usr/bin/env node
/**
 * AlphaCouncil run viewer -- a local, read-only window onto ~/.alphacouncil-agent/runs.
 *
 * Zero dependencies, binds to loopback only, and never mutates a run: the MCP server
 * owns the run directory, this process only reads it. Reports were effectively invisible
 * in a hidden dot-directory; this is the smallest thing that makes them readable.
 */
import { createServer } from "node:http";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";

const PORT = Number(process.env.ALPHACOUNCIL_GUI_PORT || 7999);
const DATA_DIR = process.env.ALPHACOUNCIL_AGENT_DATA_DIR || join(homedir(), ".alphacouncil-agent");
const RUNS_DIR = join(DATA_DIR, "runs");
const HTML = readFileSync(join(new URL(".", import.meta.url).pathname, "index.html"));

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const readJsonSafe = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};

function listRuns() {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((name) => {
      if (name.startsWith(".")) return false;
      try { return statSync(join(RUNS_DIR, name)).isDirectory(); } catch { return false; }
    })
    .map((name) => {
      const status = readJsonSafe(join(RUNS_DIR, name, "status.json")) || {};
      let mtime = 0;
      try { mtime = statSync(join(RUNS_DIR, name)).mtimeMs; } catch { /* listed anyway */ }
      return {
        run_id: name,
        symbol: status.symbol || name.split("-")[0],
        status: status.status || "unknown",
        phase: status.phase || null,
        council_mode: status.council_mode || null,
        council_pace: status.council_pace || null,
        language: status.language || null,
        started_at: status.started_at || null,
        mtime,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/** Resolve a file inside a run, refusing anything that escapes the run directory. */
function runFile(runId, name) {
  const dir = resolve(RUNS_DIR, runId);
  if (!dir.startsWith(resolve(RUNS_DIR) + sep)) return null;
  const file = resolve(dir, name);
  if (!file.startsWith(dir + sep)) return null;
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(HTML);
    }
    if (url.pathname === "/api/runs") return json(res, 200, listRuns());

    const match = url.pathname.match(/^\/api\/runs\/([^/]+)\/files$/);
    if (match) {
      const dir = resolve(RUNS_DIR, match[1]);
      if (!dir.startsWith(resolve(RUNS_DIR) + sep) || !existsSync(dir)) return json(res, 404, { error: "no such run" });
      const files = readdirSync(dir).filter((f) => {
        try { return statSync(join(dir, f)).isFile(); } catch { return false; }
      }).sort();
      return json(res, 200, { files, status: readJsonSafe(join(dir, "status.json")) });
    }

    const fileMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/file$/);
    if (fileMatch) {
      const file = runFile(fileMatch[1], url.searchParams.get("name") || "");
      if (!file) return json(res, 404, { error: "no such file" });
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(readFileSync(file));
    }
    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, 500, { error: String(error.message || error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`AlphaCouncil run viewer: http://127.0.0.1:${PORT}  (runs dir: ${RUNS_DIR})`);
});
