import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { selectorCard } from "../../mcp/lib/master-catalog.mjs";
import { repoFile } from "../helpers/paths.mjs";

const publicFiles = [
  "README.md",
  "README.zh-CN.md",
  "PRODUCT.md",
  "docs/INSTALL.md",
  "docs/reference/README.en.md",
  "docs/reference/README.zh-CN.md",
  "docs/reference/run-bundles.md",
  "mcp/lib/council-options.mjs",
  "mcp/lib/master-catalog.mjs",
];

const banned = [
  /8\s*位精选专家/iu,
  /8\s*(?:selected|curated)\s+experts?/iu,
  /26\s*位(?:真人|真实|独立)专家/iu,
  /26\s+(?:human|real|independent)\s+experts?/iu,
  /26\s+(?:independently trained|independent)\s+models?/iu,
  /(?:保证|承诺).{0,12}(?:盈利|赚钱|收益)/iu,
  /guaranteed?.{0,12}(?:profit|return)/iu,
];

const truthSurfaceFiles = [
  "README.md",
  "README.zh-CN.md",
  "README.ja.md",
  "docs/INSTALL.md",
  "docs/reference/README.en.md",
  "docs/reference/README.zh-CN.md",
  "docs/reference/README.ja.md",
];

const misleadingPublicClaims = [
  /API_keys-none_required/iu,
  /A real run, in real time/iu,
  /一次真实运行的实录|一份完整真实报告/iu,
  /実際の実行の録画|完全な実レポート/iu,
  /Auditable,\s*never hallucinated/iu,
  /可审计\s*[,，]\s*不瞎编/iu,
  /監査可能[、,]\s*幻覚なし/iu,
  /Tools\s*[—-]\s*34,\s*all keyless/iu,
  /34\s*个工具\s*[,，]\s*零\s*API\s*密钥/iu,
  /34\s*個[、,]\s*すべてキー不要/iu,
];

test("public selector and launch copy do not market method seats as human experts, independent models, or profit guarantees", () => {
  for (const relativePath of publicFiles) {
    // Explicit denials are the required disclosure, not a forbidden claim. Remove only the
    // exact negated phrases before scanning for positive marketing language.
    const text = readFileSync(repoFile(relativePath), "utf8")
      .replace(/not 26 human experts/giu, "")
      .replace(/not 26 independently trained models/giu, "")
      .replace(/不是\s*26\s*位(?:真人|真实|独立)专家/gu, "")
      .replace(/不是\s*26\s*个(?:独立训练|独立)模型/gu, "");
    for (const pattern of banned) {
      assert.doesNotMatch(text, pattern, `${relativePath} violates ${pattern}`);
    }
  }

  const mastersRoot = repoFile("knowledge/solo-test/masters");
  for (const entry of readdirSync(mastersRoot, { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const manifest = JSON.parse(readFileSync(join(mastersRoot, entry.name, "manifest.json"), "utf8"));
    assert.equal(manifest.identity.maturity, "operator_lens", `${entry.name} maturity drifted`);
    const identities = Object.values(manifest.selection.identity);
    for (const identity of identities) {
      assert.doesNotMatch(identity, /method model|方法模型|メソッドモデル|방법론 모델/iu, `${entry.name} overstates maturity`);
    }
    assert.match(identities.join("\n"), /provisional project-derived method lens/iu, `${entry.name} omits provisional identity`);
  }
});

test("compatibility selector cards disclose the provisional non-person identity in all public languages", () => {
  const mastersRoot = repoFile("knowledge/solo-test/masters");
  const locales = [
    ["English", /project-derived provisional method lens.*not the named person's words or current view/iu],
    ["中文", /项目派生的临时方法视角.*不代表具名人物本人言论或当前观点/iu],
    ["日本語", /プロジェクト派生の暫定メソッド視点.*本人の発言や現在の見解ではありません/iu],
    ["한국어", /프로젝트에서 파생된 임시 방법론 관점.*본인의 발언이나 현재 견해가 아닙니다/iu],
  ];
  for (const entry of readdirSync(mastersRoot, { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const manifest = JSON.parse(readFileSync(join(mastersRoot, entry.name, "manifest.json"), "utf8"));
    const persona = {
      id: entry.name,
      title: manifest.title || { en: entry.name, zh: entry.name },
      philosophy_tags: manifest.philosophy_tags || [],
    };
    for (const [language, disclosure] of locales) {
      const card = selectorCard(persona, language);
      assert.match(card.identity, disclosure, `${entry.name}:${language} omits the non-person disclosure`);
      assert.doesNotMatch(card.identity, /method model|方法模型|メソッドモデル|방법론 모델/iu);
    }
  }
});

test("public truth surfaces do not present historical media or optional-key coverage as current proof", () => {
  for (const relativePath of truthSurfaceFiles) {
    const text = readFileSync(repoFile(relativePath), "utf8");
    for (const pattern of misleadingPublicClaims) {
      assert.doesNotMatch(text, pattern, `${relativePath} violates ${pattern}`);
    }
  }

  for (const relativePath of ["README.md", "README.zh-CN.md", "README.ja.md"]) {
    const text = readFileSync(repoFile(relativePath), "utf8");
    assert.doesNotMatch(text, /assets\/demo(?:-zh)?\.gif|assets\/run-example\.png/iu);
    assert.match(text, /assets\/demo\.mp4/iu);
  }

  const historicalReport = readFileSync(repoFile("docs/examples/final_report.SOX.zh.md"), "utf8");
  assert.match(historicalReport, /历史(?:委员会报告)?工件/iu);
  assert.match(historicalReport, /不能证明当前版本的数据准确性/iu);
});
