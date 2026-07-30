import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { repoRoot } from "../helpers/paths.mjs";

/**
 * "Strategic Transaction or NVIDIA Terms" was a required section heading in the report
 * contract, so every report for every company grew an NVIDIA-named section. NVDA was also
 * the example ticker in every README, the tool schema and the Codex starter prompts,
 * which made a general-purpose research tool read like an NVIDIA-specific one.
 *
 * Two separate rules:
 *
 * 1. No issuer NAME anywhere in scaffolding. A heading, a prompt or a schema description
 *    must never name a company.
 * 2. No single issuer as THE example. Examples are welcome -- they are how a reader
 *    learns the symbol format -- but they must span markets rather than anchor on one
 *    name. The banned list is what this repo previously over-used.
 */

const SCANNED_DIRS = ["mcp", "skills", "docs", "personas", "test", ".github", ".codex-plugin", ".claude-plugin"];
const SCANNED_FILES = ["README.md", "README.zh-CN.md", "README.ja.md", "CLAUDE.md", "AGENTS.md"];

const ISSUER_NAMES = /NVIDIA|英伟达|Berkshire Hathaway|Tesla, Inc/i;
// Word-boundary match so "NVDA" is caught but a longer token containing it is not.
const OVERUSED_TICKERS = /\bNVDA\b/;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // an optional directory that does not exist in this checkout
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
      continue;
    }
    if (/\.(mjs|md|json|yml|yaml)$/.test(entry)) yield path;
  }
}

function* scanned() {
  for (const dir of SCANNED_DIRS) yield* walk(join(repoRoot, dir));
  for (const file of SCANNED_FILES) yield join(repoRoot, file);
}

function offendersFor(pattern) {
  const hits = [];
  for (const file of scanned()) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // This file necessarily contains the banned strings; excluding it keeps the rule
    // self-consistent rather than requiring obfuscated regexes.
    if (file.endsWith("no-hardcoded-ticker.test.mjs")) continue;
    // A captured real run output names the issuers it researched, which is the whole
    // point of shipping it. The ban is on scaffolding -- prompts, schemas, headings --
    // choosing a company; it is not on a report having analyzed one.
    if (/docs[\\/]examples[\\/]final_report\./.test(relative(repoRoot, file))) continue;
    text.split("\n").forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${relative(repoRoot, file)}:${index + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  return hits;
}

test("no issuer name appears anywhere in the product", () => {
  const offenders = offendersFor(ISSUER_NAMES);
  assert.deepEqual(offenders, [], `issuer names must not appear:\n${offenders.join("\n")}`);
});

test("no single over-used ticker anchors the examples", () => {
  const offenders = offendersFor(OVERUSED_TICKERS);
  assert.deepEqual(offenders, [], `this ticker was over-used and is now banned:\n${offenders.join("\n")}`);
});

test("the shipped examples span more than one market", () => {
  // The plugin already handles HK, JP, KR, CN and TW symbols; the docs used to show only
  // a US mega-cap, which hid that entirely.
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const schema = readFileSync(join(repoRoot, "mcp/lib/rpc.mjs"), "utf8");
  const suffixes = [/\.HK\b/, /\.T\b/, /\.KS\b/, /\.SS\b/];
  const matched = suffixes.filter((pattern) => pattern.test(schema));
  assert.ok(matched.length >= 3, "the symbol schema must document non-US symbol formats");
  assert.ok(/AAPL|MSFT|0700\.HK|7203\.T/.test(readme), "the README quickstart needs a concrete example");
});
