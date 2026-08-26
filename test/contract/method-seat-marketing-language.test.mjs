import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
});
