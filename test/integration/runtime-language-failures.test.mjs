import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { confirmMasterSelection, startServer, structured } from "../helpers/rpc-client.mjs";

function languageFailureCodex(dataDir, failureTarget) {
  const driver = join(dataDir, `fake-language-${failureTarget}.mjs`);
  const log = join(dataDir, `fake-language-${failureTarget}.jsonl`);
  writeFileSync(driver, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const parseRepair = prompt.includes("PARSE-ONLY TRANSPORT REPAIR");
const task = /Task:\\s*(market_data)/u.exec(prompt)?.[1] || null;
const originalMaster = /dedicated, isolated method-seat explanation worker[^\\n]*\\((master_[a-z0-9_]+)\\)/iu.exec(prompt)?.[1] || null;
const repairMaster = /Master ID:\\s*(master_[a-z0-9_]+)/u.exec(prompt)?.[1] || null;
const master = originalMaster || repairMaster;
const role = /You are the bull_researcher|Role: bull_researcher|你站在多头一方/i.test(prompt) ? "bull_researcher"
  : /You are the bear_researcher|Role: bear_researcher|你站在空头一方/i.test(prompt) ? "bear_researcher"
  : /You are the portfolio_manager|Role: portfolio_manager|你是最终 Portfolio Manager/i.test(prompt) ? "portfolio_manager"
  : master || task || "unknown";
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ role, parseRepair, search: args.includes("--search") }) + "\\n");

let packet;
if (task) {
  packet = {
    summary: "本证据席位返回经过约束的中文摘要，并明确保留所有未知事项。",
    claims: [{ claim: "这是一条用于运行时语言回归的中文事实。", evidence: "证据来自本地固定测试夹具。", confidence: "low", source_ids: ["S1"] }],
    metrics: {},
    sources: [{ id: "S1", title: "本地测试来源", url: "https://example.com/runtime-language", published_at: "2026-07-28", retrieved_at: "2026-07-28" }],
    open_questions: ["生产运行仍需核验真实数据来源。"], confidence: "low", information_richness: "C"
  };
} else if (master) {
  const frozenLine = prompt.split("\\n").find((line) => line.startsWith("Frozen method result JSON: "));
  const frozen = frozenLine ? JSON.parse(frozenLine.slice("Frozen method result JSON: ".length)) : null;
  const stance = frozen?.stance || /required acknowledged stance:\\s*([^;]+)/u.exec(prompt)?.[1]?.trim() || "out_of_scope";
  const wrong = ${JSON.stringify(failureTarget)} === "master";
  packet = wrong
    ? {
      master, acknowledged_stance: stance,
      statement: "This valid master statement deliberately remains in the wrong reader language after repair.",
      key_findings: ["The dedicated method worker ignored the requested Chinese language."],
      disagreements: ["The language contract is not satisfied."],
      what_would_change_my_mind: ["A valid Chinese reader-facing statement is required."],
      source_ids: ["market_data:S1"], confidence: "low"
    }
    : {
      master, acknowledged_stance: stance,
      statement: "本方法席仅解释已经冻结的判断，不增加任何新事实。",
      key_findings: ["冻结事实不足时必须明确拒绝补造。"], disagreements: ["不得把方法代理误写成真人原话。"],
      what_would_change_my_mind: ["新的可核验一手证据可能改变判断。"],
      source_ids: ["market_data:S1"], confidence: "low"
    };
} else {
  const wrong = ${JSON.stringify(failureTarget)} === "debate" && role === "bull_researcher";
  packet = wrong
    ? {
      verdict: "Wrong-language bull case", rating: "Hold", winner: "unknown",
      summary: "This valid debate packet deliberately remains in the wrong reader language after repair.",
      long_thesis: ["The bull worker ignored the requested Chinese language."], short_thesis: ["The language contract remains unsatisfied."],
      valuation_range: "No supported range is asserted.", catalysts: ["A future filing"], risks: ["Execution risk"],
      position: "Keep exposure bounded.", invalidation: ["New primary evidence"], source_ids: ["market_data:S1"],
      confidence: "low", questions: [], questions_answered: [], report_markdown: ""
    }
    : {
      verdict: "中文辩论测试结论", rating: "Hold", winner: "unknown",
      summary: "本辩论席位使用中文陈述，并且只引用冻结证据。",
      long_thesis: ["经营证据仍需后续正式文件确认。"], short_thesis: ["估值与执行风险仍未消除。"],
      valuation_range: "本夹具不提供未经支持的估值区间。", catalysts: ["下一份正式文件"], risks: ["执行风险"],
      position: "保持有限仓位", invalidation: ["新的主要证据推翻当前判断"], source_ids: ["market_data:S1"],
      confidence: "low", questions: [], questions_answered: [], report_markdown: ""
    };
}
writeFileSync(output, JSON.stringify(packet));
`);
  if (process.platform !== "win32") {
    chmodSync(driver, 0o755);
    return { driver, log };
  }
  const wrapper = join(dataDir, `fake-language-${failureTarget}.cmd`);
  writeFileSync(wrapper, `@"${process.execPath}" "${driver}" %*\r\n`);
  return { driver: wrapper, log };
}

function readJsonl(path) {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function runChineseFullFailure(failureTarget) {
  const dataDir = makeDataDir();
  const fake = languageFailureCodex(dataDir, failureTarget);
  const server = startServer({
    dataDir,
    env: {
      ALPHACOUNCIL_AGENT_CODEX_CMD: fake.driver,
      // The subject here is the voice worker's language gate, so the seat has to get a worker.
      // On an ETF this seat abstains, and an abstaining seat no longer spends one by default.
      ...(failureTarget === "master" ? { ALPHACOUNCIL_VOICE_ABSTAINING_SEATS: "1" } : {}),
    },
  });
  await server.request("initialize", {});
  const prompt = "请用中文运行本地固定夹具，并在语言不匹配时失败关闭。";
  const selection = await confirmMasterSelection(server, {
    symbol: "QQQ", language: "中文", prompt, selected_master_ids: ["master_buffett"],
  });
  const runId = `RUNTIME-LANGUAGE-${failureTarget.toUpperCase()}-${process.pid}`;
  const result = structured(await server.callTool("analyze_symbol", {
    symbol: "QQQ", run_id: runId, as_of: "2026-07-28", language: "中文", prompt,
    council_mode: "full", tasks: ["market_data"], total_timeout_ms: 30_000,
    timeout_ms: 5_000, synthesis_timeout_ms: 5_000, wait_for_completion: true,
    grounding: { facts_unavailable: true, unavailable: ["本地测试夹具"] },
    selection_receipt: selection.selection_receipt,
  }, { timeoutMs: 45_000 }));
  return { dataDir, fake, server, runId, result };
}

test("master valid JSON remains reader_language_mismatch after one bounded repair", async () => {
  const fixture = await runChineseFullFailure("master");
  try {
    const { dataDir, fake, runId, result } = fixture;
    assert.equal(result.run.status, "incomplete");
    assert.equal(result.run.master_status.master_buffett.status, "failed");
    assert.equal(result.run.master_status.master_buffett.error, "reader_language_mismatch");
    const diagnostic = JSON.parse(readFileSync(join(dataDir, "runs", runId, "master_buffett.failure.json"), "utf8"));
    assert.equal(diagnostic.failure_kind, "reader_language_mismatch");
    assert.match(diagnostic.public_summary, /错误语言/);
    const launches = readJsonl(fake.log).filter((item) => item.role === "master_buffett");
    assert.equal(launches.length, 2);
    assert.deepEqual(launches.map((item) => item.parseRepair), [false, true]);
    assert.equal(launches[1].search, false);
  } finally {
    await fixture.server.close();
    removeDataDir(fixture.dataDir);
  }
});

test("debate valid JSON remains reader_language_mismatch after one bounded repair", async () => {
  const fixture = await runChineseFullFailure("debate");
  try {
    const { dataDir, fake, runId, result } = fixture;
    assert.equal(result.run.status, "incomplete");
    const dir = join(dataDir, "runs", runId);
    const bull = JSON.parse(readFileSync(join(dir, "bull_researcher.json"), "utf8"));
    assert.equal(bull.failure_kind, "reader_language_mismatch", JSON.stringify(bull, null, 2));
    assert.match(bull.summary, /错误语言/);
    const events = readJsonl(join(dir, "events.jsonl"));
    const repairs = events.filter((event) => event.type === "agent_parse_repair" && event.role === "bull_researcher");
    assert.equal(repairs.length, 1);
    assert.equal(repairs[0].reason, "reader_language_mismatch");
    assert.equal(events.some((event) => event.type === "debate_round" && event.round === 2), false);
    const bullLaunches = readJsonl(fake.log).filter((item) => item.role === "bull_researcher");
    assert.equal(bullLaunches.length, 2);
    assert.deepEqual(bullLaunches.map((item) => item.parseRepair), [false, true]);
    assert.equal(bullLaunches[1].search, false);
  } finally {
    await fixture.server.close();
    removeDataDir(fixture.dataDir);
  }
});
