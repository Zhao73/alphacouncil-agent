import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const abortModule = new URL("../../mcp/lib/abort.mjs", import.meta.url).href;

test("a linked deadline keeps an otherwise idle process alive until abort", () => {
  const script = `
import { linkedAbort } from ${JSON.stringify(abortModule)};
const linked = linkedAbort(20);
await new Promise((resolve) => linked.signal.addEventListener("abort", resolve, { once: true }));
process.stdout.write(linked.signal.aborted ? "aborted" : "not-aborted");
linked.cleanup();
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    timeout: 2_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "aborted");
});
