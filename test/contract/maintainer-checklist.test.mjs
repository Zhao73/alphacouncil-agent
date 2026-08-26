import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { repoFile } from "../helpers/paths.mjs";

const CHECKLIST = "docs/plans/v1.5-maintainer-checklist.md";
const normalizeProse = (value) => value.replace(/\s+/gu, " ");

test("v1.5 maintainer checklist keeps every action unchecked and owner-only", () => {
  const document = readFileSync(repoFile(CHECKLIST), "utf8");
  const checkboxLines = document.split("\n").filter((line) => /^- \[[ xX]\]/u.test(line));

  assert.equal(checkboxLines.length, 7);
  assert.ok(checkboxLines.every((line) => line.startsWith("- [ ] **Owner-only —")));
  assert.doesNotMatch(document, /^- \[[xX]\]/gmu);
  assert.match(document, /This branch has not performed or verified any/u);
  assert.match(document, /publication \(T4\).*installed-host run \(T5\).*`not_run`/su);
});

test("maintainer checklist names every frozen owner action and real repository target", () => {
  const document = readFileSync(repoFile(CHECKLIST), "utf8");
  const prose = normalizeProse(document);
  for (const required of [
    "npm Trusted Publishing",
    "Zhao73/alphacouncil-agent",
    "workflow filename `release.yml`",
    ".github/workflows/release.yml",
    "`v1.5.0`",
    "private conduct-reporting address",
    "`CODE_OF_CONDUCT.md`",
    "`test/contract/contributing.test.mjs`",
    "GitHub Discussions",
    "`scripts/check-packaged-host-parity.mjs`",
    "Evaluate naming overlap",
    "`assets/demo.mp4`",
  ]) {
    assert.ok(prose.includes(required), `maintainer checklist must include ${required}`);
  }

  for (const path of [
    ".github/workflows/release.yml",
    "test/contract/contributing.test.mjs",
    "scripts/check-packaged-host-parity.mjs",
    "assets/demo.mp4",
  ]) {
    assert.ok(existsSync(repoFile(path)), `${path} must resolve from the checklist`);
  }
});

test("maintainer checklist never promotes source evidence into registry or live-host proof", () => {
  const document = readFileSync(repoFile(CHECKLIST), "utf8");
  const prose = normalizeProse(document);
  assert.match(prose, /Source and tarball checks are T1\/T2/u);
  assert.match(prose, /release-workflow rehearsal is T3/u);
  assert.match(prose, /Do not mark an item done/u);
  assert.match(prose, /do not move or reuse the tag/u);
  assert.match(prose, /do not weaken parity checks/u);
  assert.match(prose, /do not expand this item into an unreviewed campaign/u);
});
