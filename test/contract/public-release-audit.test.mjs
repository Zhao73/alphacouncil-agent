import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  auditPublicRelease,
  evaluatePublicReleaseSnapshot,
  formatPublicReleaseAudit,
  parseAboutClaims,
} from "../../scripts/lib/public-release-audit.mjs";

const CANDIDATE_SHA = "a".repeat(40);
const MAIN_SHA = "b".repeat(40);
const source = Object.freeze({
  version: "1.5.0",
  candidate_ref: "claude/phase2-evidence-speed",
  candidate_sha: CANDIDATE_SHA,
  main_sha: MAIN_SHA,
  pack_count: 26,
  tool_count: 34,
});

function pull(overrides = {}) {
  return {
    number: 20,
    html_url: "https://github.com/Zhao73/alphacouncil-agent/pull/20",
    head: { ref: source.candidate_ref, sha: CANDIDATE_SHA },
    base: { ref: "main" },
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return evaluatePublicReleaseSnapshot({
    source: overrides.source || source,
    observedAt: "2026-08-28T00:00:00.000Z",
    github: {
      default_branch: "main",
      description: "26 provisional method lenses and 34 MCP tools.",
      topics: ["equity-research"],
      main_sha: MAIN_SHA,
      main_package_version: "1.5.0",
      candidate_sha: CANDIDATE_SHA,
      latest_release: { tag_name: "v1.5.0", published_at: "2026-08-28T00:00:00.000Z" },
      open_pulls: [pull()],
      ...overrides.github,
    },
    npm: { dist_tags: { latest: "1.5.0" }, ...overrides.npm },
  });
}

test("an aligned snapshot keeps source, PR, About and publication as separate layers", () => {
  const result = snapshot();
  assert.equal(result.status, "aligned");
  assert.deepEqual(result.layers, { source: "aligned", candidate: "aligned", public_truth: "aligned", publication: "aligned" });
  assert.equal(result.github.canonical_pr.number, 20);
  assert.match(formatPublicReleaseAudit(result), /^public-release-audit: aligned/mu);
});

test("stale About counts, old public versions and a stale PR are all reported", () => {
  const result = snapshot({
    github: {
      description: "27 investor-method lenses and 31 keyless tools.",
      main_package_version: "1.4.1",
      latest_release: { tag_name: "v1.2.2" },
      open_pulls: [pull({ number: 14, head: { ref: source.candidate_ref, sha: "c".repeat(40) } })],
    },
    npm: { dist_tags: { latest: "1.0.15" } },
  });
  assert.equal(result.status, "drift_detected");
  assert.deepEqual(new Set(result.issues.map(({ code }) => code)), new Set([
    "ABOUT_PACK_COUNT_DRIFT",
    "ABOUT_TOOL_COUNT_DRIFT",
    "CANONICAL_PR_STALE",
    "PUBLIC_VERSION_DRIFT",
  ]));
  assert.equal(result.github.canonical_pr, null);
});

test("publication stays drifted when every public surface consistently trails the source", () => {
  const result = snapshot({
    github: {
      main_package_version: "1.4.1",
      latest_release: { tag_name: "v1.4.1" },
    },
    npm: { dist_tags: { latest: "1.4.1" } },
  });
  const versionIssue = result.issues.find(({ code }) => code === "PUBLIC_VERSION_DRIFT");
  assert.equal(result.layers.publication, "drift_detected");
  assert.equal(versionIssue?.source, "1.5.0");
  assert.match(versionIssue?.message || "", /source=1\.5\.0/u);
});

test("a dirty worktree cannot masquerade as the audited candidate commit", () => {
  const result = snapshot({ source: { ...source, worktree_dirty: true } });
  assert.equal(result.layers.source, "drift_detected");
  assert.ok(result.issues.some(({ code }) => code === "SOURCE_WORKTREE_DIRTY"));
});

test("About parsing is count-specific and does not invent absent claims", () => {
  assert.deepEqual(parseAboutClaims("Inspectable equity research."), { pack_count: null, tool_count: null });
  assert.deepEqual(parseAboutClaims("26 method seats; 34 MCP tools."), { pack_count: 26, tool_count: 34 });
});

test("remote audit uses public read-only endpoints and tolerates no GitHub release as missing evidence", async () => {
  const documents = new Map([
    ["https://api.github.com/repos/Zhao73/alphacouncil-agent", { default_branch: "main", description: "26 method lenses, 34 tools", topics: [] }],
    ["https://api.github.com/repos/Zhao73/alphacouncil-agent/commits/main", { sha: MAIN_SHA }],
    ["https://api.github.com/repos/Zhao73/alphacouncil-agent/contents/package.json?ref=main", { encoding: "base64", content: Buffer.from(JSON.stringify({ version: "1.5.0" })).toString("base64") }],
    [`https://api.github.com/repos/Zhao73/alphacouncil-agent/commits/${encodeURIComponent(source.candidate_ref)}`, { sha: CANDIDATE_SHA }],
    ["https://api.github.com/repos/Zhao73/alphacouncil-agent/pulls?state=open&per_page=100", [pull()]],
    ["https://registry.npmjs.org/alphacouncil-agent", { "dist-tags": { latest: "1.5.0" } }],
  ]);
  const fetchImpl = async (url) => {
    if (url.endsWith("/releases/latest")) return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    const value = documents.get(url);
    assert.notEqual(value, undefined, `unexpected URL ${url}`);
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await auditPublicRelease({
    owner: "Zhao73",
    repository: "alphacouncil-agent",
    packageName: "alphacouncil-agent",
    source,
    fetchImpl,
    now: () => new Date("2026-08-28T00:00:00.000Z"),
  });
  assert.ok(result.issues.some(({ code }) => code === "PUBLIC_VERSION_MISSING"));
  assert.equal(result.github.latest_release, null);
});

test("public audit CLI documents report and strict-check exit behavior", () => {
  const result = spawnSync(process.execPath, ["scripts/audit-public-release.mjs", "--help"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--check exits 2 on drift/u);
});
