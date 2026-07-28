import { test } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../../mcp/server.mjs";
import { assertReaderLanguage, readerLanguageStatus } from "../../mcp/lib/lang.mjs";

const { resolveLanguage, cleanLog, isDryRun } = __test__;

const ESC = String.fromCharCode(27);

test("language is inferred from the user prompt", () => {
  assert.equal(resolveLanguage({ prompt: "帮我看看 NOK" }), "中文");
  assert.equal(resolveLanguage({ prompt: "Can I enter NOK?" }), "English");
  assert.equal(resolveLanguage({ prompt: "QQQ を完全に分析してください" }), "日本語");
  assert.equal(resolveLanguage({ prompt: "QQQ를 완전히 분석해 주세요" }), "한국어");
  assert.equal(resolveLanguage({ language: "ko-KR" }), "한국어");
  assert.equal(resolveLanguage({ language: "fr-default", prompt: "中文提示" }), "fr-default");
});

test("reader language checks reject English worker prose for Chinese, Japanese and Korean runs", () => {
  for (const language of ["zh-CN", "ja-JP", "ko-KR"]) {
    const status = readerLanguageStatus("This worker ignored the requested reader language and returned English prose only.", language);
    assert.equal(status.status, "failed", language);
    assert.throws(() => assertReaderLanguage("English only output", language, "fixture"), /reader language mismatch/);
  }
  assert.equal(readerLanguageStatus("这段输出完全没有使用客户要求的英文。", "en-US").status, "failed");
  assert.equal(readerLanguageStatus("这是本轮证据摘要，数字和来源保持不变。", "zh-CN").status, "passed");
  assert.equal(readerLanguageStatus("これは今回の証拠要約で、数値と出典は変更しません。", "ja-JP").status, "passed");
  assert.equal(readerLanguageStatus("이번 실행의 증거 요약이며 숫자와 출처는 변경하지 않습니다.", "ko-KR").status, "passed");
  assert.equal(readerLanguageStatus("This evidence summary keeps all numbers and source identifiers unchanged.", "en-US").status, "passed");
  assert.equal(readerLanguageStatus("売上高100億円、営業利益20億円。", "ja-JP").status, "passed");
  assert.equal(readerLanguageStatus("売上高100億円、営業利益20億円。", "zh-CN").status, "failed");
  assert.equal(readerLanguageStatus("成長率改善、収益力上昇、財務健全。", "zh-CN").status, "failed");
  assert.equal(readerLanguageStatus("这段中文分析包括 Apple、EBITDA 和 FCF，但正文仍然是中文。", "en-US").status, "failed");
});

test("cleanLog strips ANSI escapes and truncates", () => {
  const cleaned = cleanLog(`${ESC}[31m${"x".repeat(5000)}`, 20);
  assert.ok(!cleaned.includes(ESC), "ANSI escapes must be stripped");
  assert.equal(cleaned.length, 20);
});

test("dry_run defaults to false so real subagents launch", () => {
  assert.equal(isDryRun({}), false);
  assert.equal(isDryRun({ dry_run: true }), true);
  assert.equal(isDryRun({ dry_run: false }), false);
});
