import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TASKS } from "../../mcp/lib/constants.mjs";
import { validateFinalReport, validateUserResponse } from "../../mcp/lib/gates.mjs";
import { finalReportMarkdown, userResponseMarkdown } from "../../mcp/lib/markdown.mjs";
import { compiledPersonaPacks } from "../../mcp/lib/personas-v3/registry.mjs";
import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";

function run(language, summary) {
  return {
    run_id: "BOUNDARY-1",
    symbol: "RKLB",
    language,
    packets: [{ task: "earnings_deep_dive", summary }],
  };
}

function manager(verdict = "bounded verdict") {
  return {
    rating: "Hold",
    winner: "balanced",
    confidence: "medium",
    verdict,
    valuation_range: "not available",
    position: "watch",
    invalidation: [],
  };
}

test("Chinese handoff summaries truncate at a sentence boundary", () => {
  const sentence = "这是一个完整句子。";
  const markdown = userResponseMarkdown(run("zh-CN", sentence.repeat(100)), manager());
  const line = markdown.split("\n").find((item) => item.startsWith("- 最新财报:"));
  assert.match(line, /。…$/u);
});

test("English handoff summaries truncate at a sentence boundary", () => {
  const sentence = "This sentence ends cleanly with verified evidence. ";
  const markdown = userResponseMarkdown(run("English", sentence.repeat(100)), manager());
  const line = markdown.split("\n").find((item) => item.startsWith("- Latest earnings:"));
  assert.match(line, /[.!?]…$/u);
});

test("handoff truncation never leaves an unpaired Unicode surrogate", () => {
  const markdown = userResponseMarkdown(run("zh-CN", "已核验。"), manager("🚀".repeat(800)));
  const line = markdown.split("\n").find((item) => item.startsWith("- 判断:"));
  const unpaired = [...line].some((character) => {
    if (character.length !== 1) return false;
    const code = character.charCodeAt(0);
    return code >= 0xD800 && code <= 0xDFFF;
  });
  assert.equal(unpaired, false);
  assert.match(line, /…$/u);
});

test("a failed manager path never becomes a synthetic Hold in the full handoff", () => {
  const markdown = userResponseMarkdown(run("English", "bounded evidence"), {
    ...manager("NEEDS_MANAGER_REVIEW"),
    decision_available: false,
    rating: null,
  });
  assert.match(markdown, /Rating: unavailable/);
  assert.match(markdown, /No investment rating was produced/);
  assert.match(markdown, /start a new run with a new seat selection/);
  assert.doesNotMatch(markdown, /NEEDS_MANAGER_REVIEW/);
  assert.doesNotMatch(markdown, /Rating: Hold/);
});

function localizedRun(language, analystWord, masterWord) {
  return {
    run_id: ({ "zh-CN": "LOCALE-ZH", "日本語": "LOCALE-JA", "한국어": "LOCALE-KO" })[language] || "LOCALE-EN",
    symbol: "QQQ",
    as_of: "2026-07-28",
    language,
    council_mode: "full",
    status: "complete",
    started_at: "2026-07-28T00:00:00.000Z",
    completed_at: "2026-07-28T00:10:00.000Z",
    deadline_at: "2026-07-28T00:30:00.000Z",
    grounding: {
      instrument: {
        asset_type: "etf",
        research_model: "fund_lookthrough",
        classification_source: "yahoo_chart_metadata",
      },
      quote: {
        price: 512.34,
        currency: "USD",
        quote_time: "2026-07-28T20:00:00Z",
        exchange: "NASDAQ",
        note: "fixture",
        source_url: "https://example.com/quote",
      },
    },
    tasks: [...DEFAULT_TASKS],
    task_status: Object.fromEntries(DEFAULT_TASKS.map((task) => [task, { task, status: "completed" }])),
    packets: DEFAULT_TASKS.map((task) => ({
      task,
      summary: `${analystWord}_${task}`,
      open_questions: [],
      confidence: "medium",
    })),
    masters: ["master_buffett"],
    master_status: { master_buffett: { master: "master_buffett", status: "completed" } },
    master_opinions: [{
      master: "master_buffett",
      stance: "out_of_scope",
      confidence: "medium",
      voice_statement: masterWord,
      dedicated_worker: { status: "completed" },
    }],
  };
}

test("Chinese handoff keeps the price, every analyst seat, recent-news boundary and the dedicated master statement", () => {
  const markdown = userResponseMarkdown(localizedRun("zh-CN", "中文分析", "中文专属方法席发言"), manager("中文最终判断"));
  assert.match(markdown, /AlphaCouncil 运行摘要/);
  assert.match(markdown, /## 系统记录价格/);
  assert.match(markdown, /512\.34 USD/);
  assert.match(markdown, /## 结尾：逐席方法陈词（不是本人引语） — 1/);
  assert.match(markdown, /中文专属方法席发言/);
  assert.match(markdown, /\[冻结记录: 证据范围外\/中; 陈词来源: 已完成; recorded\]/);
  assert.match(markdown, /\[已完成\/中\]/);
  assert.match(markdown, /## 分析师逐席内容/);
  assert.match(markdown, /## 近期公司与行业新闻/);
  assert.match(markdown, /本轮没有取得 as_of 之前 120 天内且带日期的新闻来源/);
  for (const task of DEFAULT_TASKS) assert.match(markdown, new RegExp(`中文分析_${task}`));
});

test("a slow full-council handoff reports its actual sixty-minute hard ceiling", () => {
  const fixture = localizedRun("zh-CN", "中文分析", "中文专属方法席发言");
  fixture.council_pace = "slow";
  fixture.time_budget_ms = 60 * 60 * 1000;
  const markdown = userResponseMarkdown(fixture, manager("中文最终判断"));
  assert.match(markdown, /本次插件托管运行硬上限 60 分钟/u);
  assert.doesNotMatch(markdown, /硬上限 30 分钟/u);
});

test("Japanese handoff keeps the price, every analyst seat and the dedicated master statement in Japanese framing", () => {
  const markdown = userResponseMarkdown(localizedRun("日本語", "日本語分析", "日本語の専用メソッド席発言"), manager("日本語の最終判断"));
  assert.match(markdown, /AlphaCouncil 実行サマリー/);
  assert.match(markdown, /## システム記録価格/);
  assert.match(markdown, /512\.34 USD/);
  assert.match(markdown, /## 最後：メソッド席ごとの最終見解（本人の発言・引用ではありません） — 1/);
  assert.match(markdown, /日本語の専用メソッド席発言/);
  assert.match(markdown, /\[凍結済み記録: 証拠範囲外\/中; 見解の生成元: 完了; recorded\]/);
  assert.match(markdown, /## 分析担当ごとの内容/);
  assert.match(markdown, /## 直近の企業・業界ニュース/);
  assert.match(markdown, /as_of までの120日間にある日付付きニュース出典を取得できませんでした/);
  for (const task of DEFAULT_TASKS) {
    assert.match(markdown, new RegExp(task));
    assert.match(markdown, new RegExp(`日本語分析_${task}`));
  }
  assert.doesNotMatch(markdown, /## Analyst Views by Seat|## System-Recorded Price/);
});

test("Korean handoff keeps the price, every analyst seat and the dedicated master statement in Korean framing", () => {
  const markdown = userResponseMarkdown(localizedRun("한국어", "한국어분석", "한국어 전용 방법론 좌석 발언"), manager("한국어 최종 판단"));
  assert.match(markdown, /AlphaCouncil 실행 요약/);
  assert.match(markdown, /## 시스템 기록 가격/);
  assert.match(markdown, /512\.34 USD/);
  assert.match(markdown, /## 마지막: 방법론 좌석별 최종 발언\(본인의 실제 발언이나 인용이 아님\) — 1/);
  assert.match(markdown, /한국어 전용 방법론 좌석 발언/);
  assert.match(markdown, /\[동결 기록: 증거 범위 밖\/중간; 발언 출처: 완료; recorded\]/);
  assert.match(markdown, /## 분석가 좌석별 내용/);
  assert.match(markdown, /## 최근 기업 및 산업 뉴스/);
  assert.match(markdown, /as_of까지 120일 이내의 날짜가 있는 뉴스 출처를 확보하지 못했습니다/);
  for (const task of DEFAULT_TASKS) {
    assert.match(markdown, new RegExp(task));
    assert.match(markdown, new RegExp(`한국어분석_${task}`));
  }
  assert.doesNotMatch(markdown, /## Analyst Views by Seat|## System-Recorded Price/);
});

test("a whole-roster handoff ends with one readable statement for every selected method", () => {
  const ids = compiledPersonaPacks().ids();
  assert.equal(ids.length, CANONICAL_MASTER_COUNT);
  const fixture = localizedRun("zh-CN", "中文分析", "unused");
  fixture.masters = ids;
  fixture.master_status = Object.fromEntries(ids.map((id) => [id, { master: id, status: "completed" }]));
  fixture.master_opinions = ids.map((id, index) => ({
    master: id,
    stance: "out_of_scope",
    confidence: "low",
    voice_status: "deterministic_fallback",
    statement_origin: "deterministic_scope_fallback",
    voice_statement: `第 ${index + 1} 席按自己的方法审视 QQQ；因缺少方法关键的时点一致事实，本轮不作方向判断。`,
  }));
  const markdown = userResponseMarkdown(fixture, manager("中文最终判断"));
  const heading = `## 结尾：逐席方法陈词（不是本人引语） — ${CANONICAL_MASTER_COUNT}`;
  assert.ok(markdown.includes(heading));
  const tail = markdown.slice(markdown.indexOf(heading));
  assert.equal((tail.match(/^-/gmu) || []).length, CANONICAL_MASTER_COUNT);
  for (const id of ids) assert.equal(tail.split(`(\`${id}\`)`).length - 1, 1, id);
  assert.ok(markdown.trimEnd().endsWith("<!-- alphacouncil:handoff-method-seat-tail:v1:end -->"), "the per-seat statements must be the final handoff section");
  assert.equal(validateUserResponse(markdown, fixture).status, "passed");
});

test("a full-roster handoff preserves 2,048 characters per method without clipping or reordering", () => {
  const ids = compiledPersonaPacks().ids();
  assert.equal(ids.length, CANONICAL_MASTER_COUNT);
  const fixture = localizedRun("en-US", "ANALYST_PRESSURE", "unused");
  fixture.masters = ids;
  fixture.master_status = Object.fromEntries(ids.map((id) => [id, { master: id, status: "completed" }]));
  const statements = ids.map((id, index) => {
    const begin = `SEAT_${String(index + 1).padStart(2, "0")}_BEGIN|`;
    const end = `|SEAT_${String(index + 1).padStart(2, "0")}_END`;
    const statement = `${begin}${"X".repeat(2_048 - begin.length - end.length)}${end}`;
    assert.equal(statement.length, 2_048, id);
    return statement;
  });
  fixture.master_opinions = ids.map((id, index) => ({
    master: id,
    stance: "cautious",
    confidence: "medium",
    voice_status: "completed",
    statement_origin: "dedicated_worker",
    voice_statement: statements[index],
    dedicated_worker: { status: "completed" },
  }));

  const markdown = userResponseMarkdown(fixture, manager("Pressure fixture verdict."));
  const tail = markdown.slice(markdown.indexOf("alphacouncil:handoff-method-seat-tail:v1:begin"));
  assert.equal(statements.reduce((sum, statement) => sum + statement.length, 0), CANONICAL_MASTER_COUNT * 2_048);
  for (const [index, id] of ids.entries()) {
    assert.equal(tail.split(`(\`${id}\`)`).length - 1, 1, id);
    assert.ok(tail.includes(statements[index]), `${id} statement was clipped`);
    if (index > 0) {
      assert.ok(tail.indexOf(statements[index - 1]) < tail.indexOf(statements[index]), `${id} was reordered`);
    }
  }
  assert.ok(markdown.trimEnd().endsWith("<!-- alphacouncil:handoff-method-seat-tail:v1:end -->"));
  assert.equal(validateUserResponse(markdown, fixture).status, "passed");

  const damaged = markdown.replace(statements[13].slice(-64), "…");
  const damagedQuality = validateUserResponse(damaged, fixture);
  assert.equal(damagedQuality.status, "needs_revision");
  assert.ok(damagedQuality.missing.some((item) => item.includes(ids[13])));
});

test("a seat's own conclusion reaches the handoff instead of being clipped away", () => {
  // The statement opens with the evidence and closes with the action, so a one-line budget
  // always cut the conclusion. On a real run this made seven seats that all spoke read as
  // seven seats that had not.
  const opening = `${"读到的事实与背景。".repeat(400)}`;
  const closing = "所以这一档我不建仓，91 美元附近才值得建仓。";
  const markdown = userResponseMarkdown({
    run_id: "LEAD-1",
    symbol: "NOW",
    language: "zh-CN",
    tasks: [],
    packets: [],
    masters: ["master_marks"],
    master_status: { master_marks: { master: "master_marks", status: "completed" } },
    master_opinions: [{
      master: "master_marks",
      stance: "opposed",
      confidence: "medium",
      voice_statement: `${opening}${closing}`,
      voice: {
        how_my_method_reads_it: "在评分之前已由硬否决决定：master_marks.euphoria。",
        would_i_act: "基于这些证据，本方法的立场是：would_pass。",
      },
      dedicated_worker: { status: "completed" },
    }],
  }, manager("最终判断"));

  assert.match(markdown, /master_marks\.euphoria/, "the decisive condition must be visible");
  assert.match(markdown, /本方法的立场是：would_pass/, "the action the seat would take must be visible");
  assert.ok(markdown.includes(`${opening}${closing}`), "the full recorded statement must be preserved verbatim");
  assert.ok(markdown.includes(closing), "the seat's closing judgement must survive the budget");
  assert.match(markdown, /\[冻结记录: 反对\/中; 陈词来源: 已完成; recorded\]/);
});

test("handoff localizes internal method origin tokens and preserves quote basis", () => {
  const fixture = localizedRun("zh-CN", "中文分析", "中文专属方法席发言");
  fixture.grounding.quote.quote_status = "last_regular_trade";
  fixture.grounding.quote.is_realtime = false;
  fixture.master_opinions[0].statement_origin = "dedicated_method_voice_worker";
  const markdown = userResponseMarkdown(fixture, manager("中文最终判断"));
  assert.match(markdown, /最近常规交易价/);
  assert.match(markdown, /realtime=否/);
  assert.match(markdown, /独立方法陈词代理/);
  assert.doesNotMatch(markdown, /dedicated_method_voice_worker/);
});

test("handoff closes a hard-refuted claim family and uses only PM-authoritative data gaps", () => {
  const fixture = localizedRun("zh-CN", "安全的未反证论断", "中文专属方法席发言");
  const packet = fixture.packets.find((item) => item.task === "earnings_deep_dive");
  packet.summary = "错误原摘要不得出现：5805 万美元。";
  packet.claims = [
    { claim: "错误逐条论断不得作为干净内容出现。", source_ids: ["earnings_deep_dive:S1"] },
    { claim: "安全的未反证论断。", source_ids: ["earnings_deep_dive:S2"] },
  ];
  packet.open_questions = ["过时的 packet 缺口不得进入最终交接。"];
  fixture.verifier_verdicts = [{
    verifier: "refuter",
    task: "earnings_deep_dive",
    claim_id: "earnings_deep_dive:C1",
    verdict: "refuted",
    claim: "错误逐条论断不得作为干净内容出现。",
    note: "复算不成立。",
  }];
  const decision = { ...manager("中文最终判断"), data_gaps: ["PM 确认仍存在的唯一缺口。"] };
  const markdown = userResponseMarkdown(fixture, decision);
  assert.doesNotMatch(markdown, /错误原摘要不得出现|过时的 packet 缺口/u);
  assert.equal(markdown.includes("安全的未反证论断。"), false);
  assert.match(markdown, /存在三重验证硬反证/u);
  assert.match(markdown, /上游错误污染依赖计算/u);
  assert.match(markdown, /PM 确认仍存在的唯一缺口/u);
  assert.equal((markdown.match(/`market_data`/g) || []).length, 1, "analyst ledger must not be duplicated");
});

test("an incomplete handoff ends with every selected seat and diagnoses a failed seat without inventing a view", () => {
  const run = {
    run_id: "FAILED-METHOD-TAIL",
    symbol: "IREN",
    language: "zh-CN",
    council_mode: "full",
    status: "incomplete",
    tasks: [],
    packets: [],
    masters: ["master_marks", "master_graham"],
    master_status: {
      master_marks: { master: "master_marks", status: "completed" },
      master_graham: {
        master: "master_graham",
        status: "failed",
        error: "v3_policy_execution_failed",
        error_code: "MISSING_NATIVE_OUTPUT",
      },
    },
    master_opinions: [{
      master: "master_marks",
      stance: "cautious",
      confidence: "medium",
      voice_statement: "Marks 方法席完整记录了周期位置、风险补偿和不建仓条件。",
      dedicated_worker: { status: "completed" },
    }, {
      master: "master_graham",
      stance: "constructive",
      confidence: "low",
      voice_statement: "这是未完成席位的中间记录，绝不能在失败终态冒充最终方法陈词。",
    }],
  };
  const markdown = userResponseMarkdown(run, { ...manager("NEEDS_MANAGER_REVIEW"), decision_available: false, rating: null });
  const tail = markdown.slice(markdown.indexOf("## 结尾：逐席方法陈词"));
  assert.match(tail, /Marks 方法席完整记录了周期位置、风险补偿和不建仓条件/);
  assert.match(tail, /master_graham/);
  assert.match(tail, /本席未产生方法陈词，也没有方向性观点；这不是看空票/);
  assert.match(tail, /确定性方法政策执行失败/);
  assert.match(tail, /技术原因已保存在运行状态和失败诊断工件中/);
  assert.doesNotMatch(tail, /MISSING_NATIVE_OUTPUT/);
  assert.match(tail, /statement_status=not_produced; seat_status=failed; not_a_directional_view=true/);
  assert.doesNotMatch(tail, /这是未完成席位的中间记录/);
  assert.doesNotMatch(tail, /master_graham.*建设性|master_graham.*反对/s);
  const quality = validateUserResponse(markdown, run);
  assert.equal(quality.status, "passed", quality.missing.join("; "));
  assert.deepEqual(quality.full_statement_master_ids, ["master_marks"]);
  assert.deepEqual(quality.explicit_failure_master_ids, ["master_graham"]);
});

test("an evidence-gate failure gives final_report and user_response the same complete 26-seat non-directional tail", () => {
  const ids = compiledPersonaPacks().ids();
  assert.equal(ids.length, CANONICAL_MASTER_COUNT);
  const fixture = localizedRun("zh-CN", "已完成证据席摘要", "unused");
  fixture.status = "incomplete";
  fixture.phase = "incomplete";
  fixture.task_status.insider_sec = {
    task: "insider_sec", status: "timed_out", error: "timeout", attempts: 2,
  };
  fixture.masters = ids;
  fixture.master_status = Object.fromEntries(ids.map((id) => [id, {
    master: id, status: "skipped", error: "evidence_gate_failed",
  }]));
  fixture.master_opinions = [];
  const fallback = { ...manager("NEEDS_MANAGER_REVIEW"), decision_available: false, rating: null };
  const finalReport = finalReportMarkdown(fixture, fallback);
  const handoff = userResponseMarkdown(fixture, fallback);
  const begin = "<!-- alphacouncil:handoff-method-seat-tail:v1:begin -->";
  const end = "<!-- alphacouncil:handoff-method-seat-tail:v1:end -->";
  const finalTail = finalReport.slice(finalReport.indexOf(begin));
  const handoffTail = handoff.slice(handoff.indexOf(begin));

  assert.equal(finalTail, handoffTail);
  assert.ok(finalReport.trimEnd().endsWith(end));
  assert.ok(handoff.trimEnd().endsWith(end));
  assert.equal((finalTail.match(/statement_status=not_produced/g) || []).length, CANONICAL_MASTER_COUNT);
  assert.equal((finalTail.match(/not_a_directional_view=true/g) || []).length, CANONICAL_MASTER_COUNT);
  assert.doesNotMatch(finalTail, /冻结记录:/);
  for (const id of ids) {
    assert.equal(finalTail.split(`<!-- alphacouncil:handoff-method-seat:v1:${id} -->`).length - 1, 1, id);
  }
  assert.equal(validateUserResponse(finalReport, fixture).status, "passed");
  const reportQuality = validateFinalReport(finalReport, fixture);
  assert.equal(reportQuality.status, "needs_revision");
  assert.equal(reportQuality.method_statement_coverage.selected_count, CANONICAL_MASTER_COUNT);
  assert.equal(reportQuality.method_statement_coverage.readable_count, 0);
  assert.equal(reportQuality.method_statement_coverage.rendered_count, 0);
});

test("the handoff gate rejects a clipped method statement even when the seat marker remains", () => {
  const fixture = localizedRun("zh-CN", "中文分析", "这是必须完整保留的逐席方法陈词，结尾包含不可丢失的行动判断。不要截断这句话。");
  const markdown = userResponseMarkdown(fixture, manager("中文最终判断"));
  const clipped = markdown.replace("结尾包含不可丢失的行动判断。不要截断这句话。", "…");
  const quality = validateUserResponse(clipped, fixture);
  assert.equal(quality.status, "needs_revision");
  assert.ok(quality.missing.includes("handoff truncated or replaced method-seat statement: master_buffett"));
});
