import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { deriveStaticImportClosure } from "../../scripts/lib/package-inventory.mjs";
import { repoFile, repoRoot } from "../helpers/paths.mjs";

test("every orchestrator worker call crosses the one shared attempt recorder", () => {
  const source = readFileSync(repoFile("mcp/lib/orchestrator.mjs"), "utf8");
  const workerSource = readFileSync(repoFile("mcp/lib/worker-execution.mjs"), "utf8");
  const directWorkerCalls = [...source.matchAll(/\brunWorker\s*\(/gu)].length;
  const recordedCalls = [...source.matchAll(/\brunRecordedCodexAttempt\s*\(/gu)].length;
  assert.equal(
    directWorkerCalls,
    1,
    "runWorker must occur only inside runRecordedCodexAttempt; six orchestration sites use the wrapper",
  );
  const recorder = source.match(/^async function runRecordedCodexAttempt\([\s\S]*?^\}/mu)?.[0];
  assert.ok(recorder, "the shared attempt recorder must remain defined");
  assert.match(recorder, /\bawait runWorker\s*\(/u);
  assert.doesNotMatch(source, /\b(?:runCodex|runApiWorker)\s*\(/u, "orchestration cannot call an adapter directly");
  assert.match(source, /import\s+\{[^}]*\brunWorker\b[^}]*\}\s+from\s+"\.\/worker-execution\.mjs"/u);
  const worker = workerSource.match(/^export function runWorker\([\s\S]*?^\}/mu)?.[0];
  assert.ok(worker, "the shared worker entry point must remain defined");
  const adapterDispatch = /\(execution\?\.run\s*\|\|\s*runCodex\)\s*\(/gu;
  assert.equal([...workerSource.matchAll(adapterDispatch)].length, 1, "one dispatch selects the scoped adapter or original Codex transport");
  assert.match(worker, adapterDispatch);
  assert.ok(recordedCalls >= 7, "the shared wrapper definition plus all six existing call sites must remain observable");
  assert.match(source, /function\s+recordWorkerAttempt\b/u);
  assert.match(source, /"worker_attempt_started"/u);
  assert.match(source, /"worker_attempt_finished"/u);
  for (const kind of ["primary", "timeout_retry", "parse_repair"]) {
    assert.ok(source.includes(`attempt_kind: "${kind}"`), `missing attempt_kind ${kind}`);
  }
});

test("offline timing replay has a static closure with no process or network capability", () => {
  const closure = deriveStaticImportClosure(repoRoot, "mcp/lib/timing-replay.mjs");
  assert.deepEqual(closure.unresolved, []);
  assert.deepEqual(closure.dynamic, []);
  for (const forbidden of ["node:child_process", "node:net", "node:http", "node:https"]) {
    assert.ok(!closure.external.includes(forbidden), `${forbidden} is forbidden in offline replay closure`);
  }
  assert.ok(
    !closure.files.some((path) => path === "mcp/lib/codex.mjs" || path.endsWith("/codex.mjs")),
    "offline replay must not import the Codex worker transport",
  );
});
