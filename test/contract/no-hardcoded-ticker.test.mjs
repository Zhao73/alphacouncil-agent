import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { repoRoot } from "../helpers/paths.mjs";

// "Strategic Transaction or NVIDIA Terms" was a required section heading in the report
// contract, so every report for every company grew an NVIDIA-named section. Generic
// report scaffolding must never name a specific issuer.

const SCANNED_DIRS = ["mcp", "skills", "docs", "test/fixtures"];
// NVDA is a legitimate example ticker in tool descriptions, market aliases, prompts and
// test inputs. What must not appear is a company NAME baked into report scaffolding.
const FORBIDDEN = /NVIDIA|Berkshire Hathaway|Tesla, Inc/i;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
      continue;
    }
    if (/\.(mjs|md|json)$/.test(entry)) yield path;
  }
}

test("no issuer name is hardcoded into report scaffolding", () => {
  const offenders = [];
  for (const dir of SCANNED_DIRS) {
    for (const file of walk(join(repoRoot, dir))) {
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, index) => {
        if (FORBIDDEN.test(line)) {
          offenders.push(`${relative(repoRoot, file)}:${index + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
    }
  }
  assert.deepEqual(offenders, [], `issuer names must not appear in report scaffolding:\n${offenders.join("\n")}`);
});
