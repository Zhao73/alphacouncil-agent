import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { confirmMasterSelection, startServer, structured } from "../helpers/rpc-client.mjs";
import { DEFAULT_TASKS } from "../../mcp/lib/constants.mjs";

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
const languageRepair = prompt.includes("FINAL LANGUAGE-ONLY TRANSPORT REPAIR");
const tasks = ${JSON.stringify(DEFAULT_TASKS)};
const regularTask = tasks.find((id) => [
  "Task:" + id,
  "Task: " + id,
  "任务：" + id,
  "任务： " + id,
].some((marker) => prompt.includes(marker))) || null;
const repairTask = /Target task:\\s*([a-z_]+)/u.exec(prompt)?.[1] || null;
const task = regularTask || (tasks.includes(repairTask) ? repairTask : null);
const originalMaster = /dedicated, isolated method-seat explanation worker[^\\n]*\\((master_[a-z0-9_]+)\\)/iu.exec(prompt)?.[1] || null;
const repairMaster = /Master ID:\\s*(master_[a-z0-9_]+)/u.exec(prompt)?.[1] || null;
const master = originalMaster || repairMaster;
const role = /You are the bull_researcher|Role: bull_researcher|你站在多头一方/i.test(prompt) ? "bull_researcher"
  : /You are the bear_researcher|Role: bear_researcher|你站在空头一方/i.test(prompt) ? "bear_researcher"
  : /You are the portfolio_manager|Role: portfolio_manager|你是最终 Portfolio Manager/i.test(prompt) ? "portfolio_manager"
  : master || task || "unknown";
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ role, parseRepair, languageRepair, search: args.includes("--search") }) + "\\n");

let packet;
if (task) {
  const source = {
    id: "S1",
    title: task + " 本地测试来源",
    url: "https://example.com/runtime-language/" + task,
    published_at: "2026-07-28",
    retrieved_at: "2026-07-28"
  };
  const coverageItem = {
    title: source.title,
    published_at: source.published_at,
    url: source.url,
    source_id: "S1"
  };
  packet = {
    summary: "本证据席位返回经过约束的中文摘要，并明确保留所有未知事项：" + task + "。",
    claims: [{ claim: "这是一条用于运行时语言回归的中文事实：" + task + "。", claim_type: "event_or_observation", evidence: "证据来自本地固定测试夹具。", confidence: "low", source_ids: ["S1"] }],
    metrics: {},
    sources: [source],
    open_questions: ["生产运行仍需核验真实数据来源。"], confidence: "low", information_richness: "C",
    ...(task === "news_industry_management" ? {
      official_source_coverage: {
        status: "complete",
        regulator: {
          status: "complete",
          entry_url: "https://example.com/runtime-language/regulator",
          checked_through: "2026-07-28",
          latest_dated_item: { ...coverageItem, record_id: "fixture-regulator-record" },
          dated_items_checked: [{ ...coverageItem, record_id: "fixture-regulator-record" }],
          gap: null
        },
        issuer: {
          status: "complete",
          entry_url: "https://example.com/runtime-language/issuer",
          checked_through: "2026-07-28",
          latest_dated_item: coverageItem,
          dated_items_checked: [coverageItem],
          gap: null
        }
      }
    } : {})
  };
} else if (master) {
  const frozenLine = prompt.split("\\n").find((line) => line.startsWith("Frozen method result JSON: "));
  const frozen = frozenLine ? JSON.parse(frozenLine.slice("Frozen method result JSON: ".length)) : null;
  const stance = frozen?.stance || /required acknowledged stance:\\s*([^;]+)/u.exec(prompt)?.[1]?.trim() || "out_of_scope";
  const wrong = ${JSON.stringify(failureTarget)} === "master"
    || (${JSON.stringify(failureTarget)} === "master_recover" && !languageRepair);
  packet = wrong
    ? {
      master, acknowledged_stance: stance,
      voice_mode: "first_person_public_method_simulation_v1",
      disclosure_ack: "alphacouncil.first_person_public_method_simulation.v1",
      position_intent: ({ constructive: "would_buy", cautious: "would_hold", opposed: "would_pass", out_of_scope: "not_in_my_circle" })[stance],
      voice: {
        would_i_act: "I would keep this statement in the wrong reader language after repair.",
        what_i_see: "I see that the dedicated method worker ignored the requested Chinese language.",
        how_my_method_reads_it: "I apply my method in English even though this fixture requires Chinese.",
        where_i_disagree: "I disagree with the requested language contract in this negative control.",
        what_changes_my_mind: "I would need a valid Chinese reader-facing statement."
      },
      key_findings: ["The dedicated method worker ignored the requested Chinese language."],
      disagreements: ["The language contract is not satisfied."],
      what_would_change_my_mind: ["A valid Chinese reader-facing statement is required."],
      source_ids: ["market_data:S1"], confidence: "low"
    }
    : {
      master, acknowledged_stance: stance,
      voice_mode: "first_person_public_method_simulation_v1",
      disclosure_ack: "alphacouncil.first_person_public_method_simulation.v1",
      position_intent: ({ constructive: "would_buy", cautious: "would_hold", opposed: "would_pass", out_of_scope: "not_in_my_circle" })[stance],
      voice: {
        would_i_act: "我只会遵守已经冻结的判断，不增加方向。",
        what_i_see: "我看到本轮冻结事实仍然不足。",
        how_my_method_reads_it: "我按自己的方法解释记录，不增加任何新事实。",
        where_i_disagree: "我不同意把方法模拟误写成真人原话。",
        what_changes_my_mind: "我只会在新的可核验一手证据出现时改变判断。"
      },
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
    council_mode: "full", tasks: DEFAULT_TASKS, total_timeout_ms: 30_000,
    timeout_ms: 5_000, synthesis_timeout_ms: 5_000, wait_for_completion: true,
    grounding: {
      instrument: {
        asset_type: "etf",
        research_model: "fund_lookthrough",
        classification_source: "test_fixture",
      },
      facts_unavailable: true,
      unavailable: ["本地测试夹具"],
    },
    selection_receipt: selection.selection_receipt,
  }, { timeoutMs: 45_000 }));
  return { dataDir, fake, server, runId, result };
}

test("master valid JSON remains reader_language_mismatch after bounded transport and language repairs", async () => {
  const fixture = await runChineseFullFailure("master");
  try {
    const { dataDir, fake, runId, result } = fixture;
    assert.equal(result.run.status, "incomplete");
    assert.equal(
      result.run.master_status.master_buffett.status,
      "failed",
      JSON.stringify(result.run.task_status, null, 2),
    );
    assert.equal(result.run.master_status.master_buffett.error, "reader_language_mismatch");
    const diagnostic = JSON.parse(readFileSync(join(dataDir, "runs", runId, "master_buffett.failure.json"), "utf8"));
    assert.equal(diagnostic.failure_kind, "reader_language_mismatch");
    assert.match(diagnostic.public_summary, /错误语言/);
    const launches = readJsonl(fake.log).filter((item) => item.role === "master_buffett");
    assert.equal(launches.length, 3);
    assert.deepEqual(launches.map((item) => item.parseRepair), [false, true, false]);
    assert.deepEqual(launches.map((item) => item.languageRepair), [false, false, true]);
    assert.equal(launches[1].search, false);
    assert.equal(launches[2].search, false);
  } finally {
    await fixture.server.close();
    removeDataDir(fixture.dataDir);
  }
});

test("a final language-only repair can recover a contract-valid method voice without changing its stance", async () => {
  const fixture = await runChineseFullFailure("master_recover");
  try {
    const { fake, result } = fixture;
    // The shared fake PM is intentionally too small for a full_v2 completion; this test owns
    // only the method-language barrier.
    assert.equal(result.run.master_status.master_buffett.status, "completed");
    const opinion = result.run.master_opinions.find((item) => item.master === "master_buffett");
    assert.ok(opinion);
    assert.equal(opinion.voice_language, "中文");
    const launches = readJsonl(fake.log).filter((item) => item.role === "master_buffett");
    assert.equal(launches.length, 3);
    assert.deepEqual(launches.map((item) => item.languageRepair), [false, false, true]);
    assert.ok(launches.every((item) => !item.search));
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
