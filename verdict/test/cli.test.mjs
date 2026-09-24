import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isolateHome } from "./helpers.mjs";

const home = isolateHome();
const bin = fileURLToPath(new URL("../bin/verdict.mjs", import.meta.url));
const fake = fileURLToPath(new URL("./fake-backend.mjs", import.meta.url));
const { resolveTarget } = await import("../src/engine/target.mjs");

function verdict(args, env = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, VERDICT_HOME: home, VERDICT_OFFLINE: "1", VERDICT_BACKEND_MODULE: fake, NO_COLOR: "1", LANG: "en_US.UTF-8", ...env },
  });
}

test("ticker detection", async () => {
  const none = async () => null;
  assert.deepEqual(await resolveTarget("NVDA", { search: none }), { symbol: "NVDA", question: "" });
  assert.deepEqual(await resolveTarget("is AAPL a buy?", { search: none }), { symbol: "AAPL", question: "is a buy?" });
  assert.deepEqual(await resolveTarget("0700.HK 现在值得买吗？", { search: none }), { symbol: "0700.HK", question: "现在值得买吗？" });
  assert.deepEqual(await resolveTarget("tsla 值得买吗", { search: none }), { symbol: "TSLA", question: "值得买吗" });
  assert.deepEqual(await resolveTarget("IS IT A BUY NVDA", { search: none }), { symbol: "NVDA", question: "IS IT A BUY" });
  const search = async (q) => (/microsoft/i.test(q) ? { symbol: "MSFT" } : null);
  assert.deepEqual(await resolveTarget("is microsoft cheap", { search }), { symbol: "MSFT", question: "is microsoft cheap" });
  assert.equal(await resolveTarget("hello there friend", { search: none }), null);
});

test("research prints the verdict card; a repeat reuses it; --json and --fast work", () => {
  const r = verdict(["TEST", "--plain"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /VERDICT/);
  assert.match(r.stdout, /OVERWEIGHT ▲/);
  assert.match(r.stdout, /PRICE LEVELS/);
  assert.match(r.stdout, /report\.html/);
  assert.match(verdict(["TEST"]).stdout, /↺ \d+ min/);
  const run = JSON.parse(verdict(["TEST", "--fresh", "--json"]).stdout);
  assert.equal(run.state, "complete");
  assert.deepEqual(Object.keys(JSON.parse(verdict(["TEST", "--fast", "--json"]).stdout).desks), ["all"]);
});

test("incomplete runs exit 2; unknown input exits 1", () => {
  const bad = verdict(["FAIL", "--plain"], { FAKE_FAIL: "Business & earnings|Expectations & valuation|News, industry & catalysts" });
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /INCOMPLETE/);
  const nope = verdict(["hello there friend"]);
  assert.equal(nope.status, 1);
  assert.match(nope.stderr, /ticker/i);
});

test("compare, watch, track, history, show, ask, export", () => {
  const cmp = JSON.parse(verdict(["compare", "AAA", "BBB", "--json"]).stdout);
  assert.equal(cmp.ranking.ranking[0].symbol, "AAA");
  assert.equal(cmp.rows.length, 2);
  verdict(["ASKME", "--plain"]);
  const w = verdict(["watch", "add", "ASKME"]);
  assert.match(w.stdout, /ASKME/);
  assert.match(w.stdout, /Overweight/);
  assert.match(verdict(["history"]).stdout, /ASKME/);
  assert.match(verdict(["show", "ASKME"]).stdout, /PRICE LEVELS/);
  assert.match(verdict(["ask", "ASKME", "what", "about", "rates?"]).stdout, /answer to: what about rates\?/);
  const ex = spawnSync(process.execPath, [bin, "export", "ASKME"], { cwd: home, encoding: "utf8", env: { ...process.env, VERDICT_HOME: home, NO_COLOR: "1" } });
  assert.match(ex.stdout, /ASKME-verdict-.*\.html/);
  assert.match(verdict(["track"]).stdout, /TRACK RECORD/);
  assert.match(verdict(["--help"]).stdout, /verdict demo/);
});

test("demo runs offline on the fictional company", () => {
  const r = verdict(["demo", "--plain"], { VERDICT_BACKEND_MODULE: "", VERDICT_DEMO_SPEED: "0" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Acme Robotics \(fictional demo\)/);
  assert.match(r.stdout, /OVERWEIGHT/);
  assert.match(r.stdout, /175-195/);
});
