import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { repoFile } from "../helpers/paths.mjs";

const STARTERS = Object.freeze([
  {
    source: "mcp/lib/feeds.mjs",
    symbols: ["parseFeed", "applyRecencyGate"],
    testPath: "test/unit/feeds.test.mjs",
    boundary: "do not add a network call",
  },
  {
    source: "mcp/lib/quotes.mjs",
    symbols: ["parseYahooChart", "parseStooqCsv"],
    testPath: "test/unit/quotes.test.mjs",
    boundary: "do not add a live fetch",
  },
  {
    source: "mcp/lib/lang.mjs",
    symbols: ["readerLanguageStatus"],
    testPath: "test/unit/lang.test.mjs",
    boundary: "do not weaken the threshold",
  },
  {
    source: "mcp/lib/tables.mjs",
    symbols: ["table", "metricValue"],
    testPath: "test/unit/markets.test.mjs",
    boundary: "do not change report contracts",
  },
]);

function exportedFunctionPattern(symbol) {
  return new RegExp(`export\\s+function\\s+${symbol}\\b`, "u");
}

test("suggested contribution starters resolve to real files and exports", () => {
  const guide = readFileSync(repoFile("CONTRIBUTING.md"), "utf8");
  assert.match(guide, /## Where to start/u);
  assert.match(guide, /Add the failing test first, make the smallest fix/u);

  for (const starter of STARTERS) {
    assert.ok(existsSync(repoFile(starter.source)), `${starter.source} must exist`);
    assert.ok(existsSync(repoFile(starter.testPath)), `${starter.testPath} must exist`);
    assert.ok(guide.includes(`\`${starter.source}\``), `${starter.source} must be documented`);
    assert.ok(guide.includes(`\`${starter.testPath}\``), `${starter.testPath} must be documented`);
    assert.ok(guide.includes(starter.boundary), `${starter.source} must keep its bounded task`);

    const source = readFileSync(repoFile(starter.source), "utf8");
    for (const symbol of starter.symbols) {
      assert.match(source, exportedFunctionPattern(symbol));
      assert.ok(guide.includes(`\`${symbol}\``), `${symbol} must be documented`);
    }
  }
});

test("commit-message guidance stays short, safe, and independently verifiable", () => {
  const guide = readFileSync(repoFile("CONTRIBUTING.md"), "utf8");
  const section = guide.split("## Commit messages\n").at(1);
  assert.ok(section);
  assert.match(section, /git commit -F \/path\/to\/message\.txt/u);
  assert.match(section, /<<'MSG'/u);
  assert.match(section, /git show -s --format=%B HEAD/u);
  assert.match(section, /Do not\namend a published or tagged commit/u);
  assert.doesNotMatch(section, /It happened once here|silently deletes|worse outcome than an imperfect message/u);
  assert.ok(section.split("\n").filter(Boolean).length <= 14, "commit guidance must remain concise");
});

test("WP5 does not add a placeholder conduct policy without a private reporting route", () => {
  // This is a temporary WP5 guard, not a permanent ban. When the WP7 owner checklist's
  // private-contact action is completed, add the real CoC and update this assertion together.
  assert.equal(existsSync(repoFile("CODE_OF_CONDUCT.md")), false);
});
