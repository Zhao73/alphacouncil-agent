#!/usr/bin/env node
/** Exercise the installed MCP server, mandatory selector and one-use receipt without network. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const serverEntry = join(root, "mcp", "server.mjs");
const TIMEOUT_MS = 30_000;

function startServer(dataDir) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: { ...process.env, ALPHACOUNCIL_AGENT_DATA_DIR: dataDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const stderr = [];
  let buffer = "";
  let nextId = 1;
  let exited = false;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          for (const waiter of pending.values()) waiter.reject(new Error(`non-JSON server output: ${error.message}`));
          pending.clear();
          return;
        }
        const waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  child.on("close", (code, signal) => {
    exited = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`server exited code=${code} signal=${signal}; stderr=${stderr.join("")}`));
    }
    pending.clear();
  });

  function request(method, params = {}) {
    if (exited) return Promise.reject(new Error("server already exited"));
    const id = nextId++;
    const promise = new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`timeout waiting for ${method}`));
      }, TIMEOUT_MS);
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  }

  async function close() {
    if (!exited) {
      child.stdin.end();
      await once(child, "close");
    }
  }

  return {
    child,
    request,
    callTool: (name, args) => request("tools/call", { name, arguments: args }),
    close,
    stderr,
  };
}

function structured(response) {
  assert.equal(response.error, undefined, response.error?.message || "tool call failed");
  assert.ok(response.result?.structuredContent, "tool response must expose structuredContent");
  return response.result.structuredContent;
}

export async function runPackageSmoke() {
  const dataDir = mkdtempSync(join(tmpdir(), "alphacouncil-package-smoke-"));
  const server = startServer(dataDir);
  try {
    const initialized = await server.request("initialize", {});
    assert.ok(initialized.result, "MCP initialize must succeed");

    const listed = await server.request("tools/list", {});
    const tools = listed.result?.tools || [];
    assert.equal(tools.length, 31, "installed server must expose exactly 31 MCP tools");
    const names = new Set(tools.map((tool) => tool.name));
    for (const required of ["begin_council_selection", "confirm_master_selection", "plan_visible_run", "analyze_symbol"]) {
      assert.ok(names.has(required), `installed server is missing ${required}`);
    }

    const localeCases = [
      { language: "en-US", prompt: "bounded installed-package smoke", script: /[A-Za-z]/u },
      { language: "zh-CN", prompt: "安装包有界烟雾测试", script: /\p{Script=Han}/u },
      { language: "ja-JP", prompt: "インストール済みパッケージの有界スモークテスト", script: /[\p{Script=Hiragana}\p{Script=Katakana}]/u },
      { language: "ko-KR", prompt: "설치 패키지의 제한된 스모크 테스트", script: /\p{Script=Hangul}/u },
    ];
    let opened;
    let prompt;
    for (const locale of localeCases) {
      const catalog = structured(await server.callTool("begin_council_selection", {
        symbol: "AAPL",
        language: locale.language,
        host: "package-smoke",
        prompt: locale.prompt,
      }));
      assert.equal(catalog.masters.length, 26, `${locale.language} installed catalog must contain exactly 26 seats`);
      for (const master of catalog.masters) {
        for (const field of ["identity", "method", "best_for", "maturity_label"]) {
          assert.match(master[field], locale.script, `${locale.language} ${master.id}.${field}`);
        }
      }
      if (locale.language === "zh-CN") {
        opened = catalog;
        prompt = locale.prompt;
      }
    }

    const confirmed = structured(await server.callTool("confirm_master_selection", {
      selection_id: opened.selection_id,
      catalog_hash: opened.catalog_hash,
      display_ack: true,
      selected_master_ids: ["master_buffett"],
    }));
    assert.deepEqual(confirmed.selected_master_ids, ["master_buffett"]);

    const runId = `PACKAGE-SMOKE-${process.pid}`;
    const planned = structured(await server.callTool("plan_visible_run", {
      symbol: "AAPL",
      language: "zh-CN",
      prompt,
      run_id: runId,
      tasks: ["market_data"],
      grounding: { facts_unavailable: true },
      selection_receipt: confirmed.selection_receipt,
    }));
    assert.deepEqual(planned.run.masters, ["master_buffett"]);

    const replay = await server.callTool("plan_visible_run", {
      symbol: "AAPL",
      language: "zh-CN",
      prompt,
      run_id: `${runId}-REPLAY`,
      tasks: ["market_data"],
      grounding: { facts_unavailable: true },
      selection_receipt: confirmed.selection_receipt,
    });
    assert.equal(replay.error?.data?.reason, "MASTER_SELECTION_REPLAYED");

    process.stdout.write(`package-smoke: passed tools=${tools.length} catalog=26 locales=4 selected=1 replay_rejected=true\n`);
    return { tools: tools.length, catalog: 26, locales: 4, selected: 1, replay_rejected: true };
  } finally {
    if (!server.child.killed) await server.close().catch(() => server.child.kill());
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  runPackageSmoke().catch((error) => {
    process.stderr.write(`package smoke failed: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
