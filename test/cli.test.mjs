import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isolateHome } from "./helpers.mjs";

const home = isolateHome();
const bin = fileURLToPath(new URL("../bin/alpha.mjs", import.meta.url));
const fake = fileURLToPath(new URL("./fake-backend.mjs", import.meta.url));
const { resolveTarget } = await import("../src/cli/main.mjs");

function alpha(args, env = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, ALPHA_HOME: home, ALPHA_OFFLINE: "1", ALPHA_BACKEND_MODULE: fake, NO_COLOR: "1", LANG: "en_US.UTF-8", ...env },
  });
}

test("ticker detection from free text", async () => {
  const none = async () => null;
  assert.deepEqual(await resolveTarget(["NVDA"], { search: none }), { symbol: "NVDA", question: "" });
  assert.deepEqual(await resolveTarget(["AAPL", "is", "it", "a", "buy?"], { search: none }), { symbol: "AAPL", question: "is it a buy?" });
  assert.deepEqual(await resolveTarget(["0700.HK 现在值得买吗？"], { search: none }), { symbol: "0700.HK", question: "现在值得买吗？" });
  assert.deepEqual(await resolveTarget(["tsla 值得买吗"], { search: none }), { symbol: "TSLA", question: "值得买吗" });
  const search = async (q) => (/microsoft/i.test(q) ? { symbol: "MSFT", name: "Microsoft" } : null);
  assert.deepEqual(await resolveTarget(["is", "microsoft", "cheap"], { search }), { symbol: "MSFT", question: "is microsoft cheap" });
  assert.equal(await resolveTarget(["hello there friend"], { search: none }), null);
});

test("research run prints progress and the summary card, then reuses it", () => {
  const r = alpha(["TEST", "--plain"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /deep research · engine fake/);
  assert.match(r.stdout, /Business & earnings: done/);
  assert.match(r.stdout, /Overweight ▲/);
  assert.match(r.stdout, /status complete/);
  const again = alpha(["TEST"]);
  assert.match(again.stdout, /Showing a report from \d+ min ago/);
  const fresh = alpha(["TEST", "--fresh", "--json"]);
  const run = JSON.parse(fresh.stdout);
  assert.equal(run.state, "complete");
  assert.equal(run.mode, "deep");
});

test("fast mode, failures and exit code for incomplete runs", () => {
  const fast = alpha(["TEST", "--fast", "--json"]);
  assert.deepEqual(Object.keys(JSON.parse(fast.stdout).desks), ["all"]);
  const bad = alpha(["FAIL", "--plain"], { FAKE_FAIL: "Business & earnings|Expectations & valuation|News, industry & catalysts" });
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /incomplete/);
});

test("runs, show, ask and help", () => {
  alpha(["ASKME", "--plain"]);
  assert.match(alpha(["runs"]).stdout, /ASKME/);
  assert.match(alpha(["show", "ASKME", "--raw"]).stdout, /^# ASKME/);
  const a = alpha(["ask", "ASKME", "what", "about", "rates?"]);
  assert.match(a.stdout, /answer to: what about rates\?/);
  assert.match(alpha(["--help"]).stdout, /alpha ask/);
  const nope = alpha(["hello there friend"]);
  assert.equal(nope.status, 1);
  assert.match(nope.stderr, /ticker/);
});
