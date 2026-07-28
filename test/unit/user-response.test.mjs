import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TASKS } from "../../mcp/lib/constants.mjs";
import { userResponseMarkdown } from "../../mcp/lib/markdown.mjs";

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
  assert.match(markdown, /NEEDS_MANAGER_REVIEW/);
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
  assert.match(markdown, /## 逐席大神方法输出/);
  assert.match(markdown, /中文专属方法席发言/);
  assert.match(markdown, /## 分析师逐席内容/);
  assert.match(markdown, /## 近期公司与行业新闻/);
  assert.match(markdown, /本轮没有取得 as_of 之前 120 天内且带日期的新闻来源/);
  for (const task of DEFAULT_TASKS) assert.match(markdown, new RegExp(`中文分析_${task}`));
});

test("Japanese handoff keeps the price, every analyst seat and the dedicated master statement in Japanese framing", () => {
  const markdown = userResponseMarkdown(localizedRun("日本語", "日本語分析", "日本語の専用メソッド席発言"), manager("日本語の最終判断"));
  assert.match(markdown, /AlphaCouncil 実行サマリー/);
  assert.match(markdown, /## システム記録価格/);
  assert.match(markdown, /512\.34 USD/);
  assert.match(markdown, /## メソッド席ごとの記録/);
  assert.match(markdown, /日本語の専用メソッド席発言/);
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
  assert.match(markdown, /## 방법론 좌석별 기록/);
  assert.match(markdown, /한국어 전용 방법론 좌석 발언/);
  assert.match(markdown, /## 분석가 좌석별 내용/);
  assert.match(markdown, /## 최근 기업 및 산업 뉴스/);
  assert.match(markdown, /as_of까지 120일 이내의 날짜가 있는 뉴스 출처를 확보하지 못했습니다/);
  for (const task of DEFAULT_TASKS) {
    assert.match(markdown, new RegExp(task));
    assert.match(markdown, new RegExp(`한국어분석_${task}`));
  }
  assert.doesNotMatch(markdown, /## Analyst Views by Seat|## System-Recorded Price/);
});
