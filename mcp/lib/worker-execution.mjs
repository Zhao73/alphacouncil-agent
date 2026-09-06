import { AsyncLocalStorage } from "node:async_hooks";
import { codexRunConfig, runCodex } from "./codex.mjs";

const workers = new AsyncLocalStorage();

export function withWorkerExecution(execution, operation) {
  return workers.run(execution, operation);
}

export function workerExecutionConfig(options = {}) {
  const execution = workers.getStore();
  return execution?.getConfig?.(options) || execution?.config || codexRunConfig(process.env, options);
}

export function workerCancellationSignal() {
  return workers.getStore()?.signal;
}

export function assertWorkerNotCancelled() {
  workerCancellationSignal()?.throwIfAborted();
}

export function runWorker(prompt, timeoutMs, onStart, onHeartbeat, runtime = {}) {
  const execution = workers.getStore();
  assertWorkerNotCancelled();
  return (execution?.run || runCodex)(prompt, timeoutMs, onStart, onHeartbeat, {
    ...runtime,
    ...(execution?.signal ? { signal: execution.signal } : {}),
  });
}
