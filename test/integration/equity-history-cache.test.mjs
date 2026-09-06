import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";

const dataDir = makeDataDir();
const previous = process.env.ALPHACOUNCIL_AGENT_DATA_DIR;
process.env.ALPHACOUNCIL_AGENT_DATA_DIR = dataDir;
const { fetchEquityMarketHistory } = await import("../../mcp/lib/equity-history.mjs");
after(() => {
  removeDataDir(dataDir);
  if (previous === undefined) delete process.env.ALPHACOUNCIL_AGENT_DATA_DIR;
  else process.env.ALPHACOUNCIL_AGENT_DATA_DIR = previous;
});

test("history cache preserves observation time and cutoff, and refetches damaged or stale records", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    calls += 1;
    assert.equal(new URL(url).searchParams.get("range"), "10y");
    return new Response(JSON.stringify({ chart: { result: [{
      timestamp: ["2025-01-01", "2025-01-02", "2025-01-03"].map((day) => Date.parse(day) / 1000),
      indicators: { quote: [{ close: [100, 80, 120], volume: [10, 20, 30] }] },
    }] } }));
  });
  const first = await fetchEquityMarketHistory("TEST", { benchmarks: [] });
  assert.equal(first.available, true);
  assert.equal(first.subject.maximum_drawdown_observed, -0.2);
  assert.equal(first.source_records[0].cache_status, "fetched");
  const second = await fetchEquityMarketHistory("TEST", { benchmarks: [], asOf: "2025-01-02" });
  assert.equal(calls, 1);
  assert.equal(second.subject.latest_date, "2025-01-02");
  assert.equal(second.subject.session_count, 2);
  assert.equal(second.source_records[0].observed_at, first.source_records[0].observed_at);
  assert.equal(second.source_records[0].cache_status, "fresh");
  const dir = join(dataDir, "cache", "prices");
  const path = join(dir, readdirSync(dir)[0]);
  const cached = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...cached, observed_at: "2000-01-01T00:00:00Z" }));
  await fetchEquityMarketHistory("TEST", { benchmarks: [] });
  assert.equal(calls, 2);
  writeFileSync(path, "broken JSON");
  await fetchEquityMarketHistory("TEST", { benchmarks: [] });
  assert.equal(calls, 3);
});
