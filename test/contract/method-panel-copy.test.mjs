import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { repoFile } from "../helpers/paths.mjs";

const files = [
  "mcp/lib/rpc.mjs",
  "mcp/lib/method-panel-recommendation.mjs",
  "docs/reference/method-panel-evidence.md",
];

test("new method-panel surfaces disclose advisory simulation status without expert or profit claims", () => {
  const combined = files.map((relativePath) => readFileSync(repoFile(relativePath), "utf8")).join("\n");
  assert.match(combined, /advisory method|方法模拟建议/iu);
  assert.match(combined, /full catalog remains|完整目录仍可选/iu);
  assert.match(combined, /explicit (?:submission|confirmation)|明确(?:提交|确认)/iu);
  assert.doesNotMatch(combined, /8\s*(?:位精选专家|selected experts?|curated experts?)/iu);
  assert.doesNotMatch(combined, /(?:guaranteed? profit|保证盈利|承诺盈利)/iu);
});
