import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  auditPublicRelease,
  evaluatePublicReleaseSnapshot,
  formatPublicReleaseAudit,
  parseAboutClaims,
  REQUIRED_CANDIDATE_MATRIX_JOB_NAMES,
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

function successfulJobs(names, overrides = {}) {
  return names.map((name) => ({
    name,
    status: "completed",
    conclusion: "success",
    ...(overrides[name] || {}),
  }));
}

function workflowRun({ id, event, overrides = {} }) {
  return {
    id,
    event,
    status: "completed",
    conclusion: "success",
    head_sha: CANDIDATE_SHA,
    head_branch: source.candidate_ref,
    run_attempt: 1,
    pull_requests: event === "pull_request" ? [{
      number: 20,
      head: { ref: source.candidate_ref, sha: CANDIDATE_SHA },
      base: { ref: "main", sha: MAIN_SHA },
    }] : [],
    ...overrides,
  };
}

function successfulCandidateWorkflows(overrides = {}) {
  return {
    check_push: {
      run: workflowRun({ id: 101, event: "push" }),
      jobs: successfulJobs(REQUIRED_CANDIDATE_MATRIX_JOB_NAMES),
    },
    check_pull_request: {
      run: workflowRun({ id: 102, event: "pull_request" }),
      jobs: successfulJobs(REQUIRED_CANDIDATE_MATRIX_JOB_NAMES),
    },
    fuzz_pull_request: {
      run: workflowRun({ id: 103, event: "pull_request" }),
      jobs: successfulJobs(["transport-runtime"]),
    },
    ...overrides,
  };
}

function pull(overrides = {}) {
  return {
    number: 20,
    html_url: "https://github.com/Zhao73/alphacouncil-agent/pull/20",
    head: { ref: source.candidate_ref, sha: CANDIDATE_SHA },
    base: { ref: "main", sha: MAIN_SHA },
    draft: false,
    mergeable: true,
    mergeable_state: "clean",
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return evaluatePublicReleaseSnapshot({
    source: overrides.source || source,
    observedAt: "2026-08-28T00:00:00.000Z",
    github: {
      default_branch: "main",
      description: "26 provisional method lenses and 34 MCP tools. Research software, not investment advice.",
      topics: ["equity-research"],
      main_sha: MAIN_SHA,
      main_package_version: "1.5.0",
      candidate_sha: CANDIDATE_SHA,
      latest_release: { tag_name: "v1.5.0", published_at: "2026-08-28T00:00:00.000Z" },
      open_pulls: [pull()],
      candidate_pull: pull(),
      candidate_workflows: successfulCandidateWorkflows(),
      ...overrides.github,
    },
    npm: { dist_tags: { latest: "1.5.0" }, ...overrides.npm },
    phase: overrides.phase || "report",
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
      description: "27 investor-method lenses and 31 keyless tools. Not investment advice.",
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

test("candidate and publication gates are independently satisfiable", () => {
  const candidate = snapshot({
    phase: "candidate",
    github: {
      main_package_version: "1.4.1",
      latest_release: { tag_name: "v1.2.2" },
    },
    npm: { dist_tags: { latest: "1.0.15" } },
  });
  assert.equal(candidate.status, "drift_detected", "report still exposes public version drift");
  assert.equal(candidate.gate.status, "passed", "pre-merge gate does not require publication to have happened");

  const publicationSource = { ...source, candidate_ref: "main", candidate_sha: MAIN_SHA };
  const publication = snapshot({
    phase: "publication",
    source: publicationSource,
    github: {
      candidate_sha: MAIN_SHA,
      open_pulls: [],
      candidate_pull: null,
      candidate_workflows: {},
    },
  });
  assert.equal(publication.gate.status, "passed", "post-release gate does not require an open PR");
  assert.ok(publication.issues.some(({ code }) => code === "CANONICAL_PR_MISSING"));
});

test("publication rejects a source tree that is not current main", () => {
  const result = snapshot({ phase: "publication" });
  assert.equal(result.gate.status, "blocked");
  assert.ok(result.gate.issues.some(({ code }) => code === "PUBLICATION_SOURCE_NOT_MAIN"));
});

test("candidate gate checks exact base, non-draft mergeability and green workflow jobs", () => {
  const result = snapshot({
    phase: "candidate",
    github: {
      candidate_pull: pull({
        base: { ref: "main", sha: "c".repeat(40) },
        draft: true,
        mergeable: false,
        mergeable_state: "dirty",
      }),
      candidate_workflows: successfulCandidateWorkflows({
        check_push: {
          run: workflowRun({ id: 101, event: "push" }),
          jobs: successfulJobs(REQUIRED_CANDIDATE_MATRIX_JOB_NAMES, {
            [REQUIRED_CANDIDATE_MATRIX_JOB_NAMES[0]]: { conclusion: "failure" },
          }),
        },
      }),
    },
  });
  assert.equal(result.gate.status, "blocked");
  assert.deepEqual(new Set(result.gate.issues.map(({ code }) => code)), new Set([
    "CANDIDATE_BASE_SHA_DRIFT",
    "CANDIDATE_REQUIRED_JOBS_NOT_GREEN",
    "CANDIDATE_PR_CONFLICTING",
    "CANDIDATE_PR_DRAFT",
  ]));
});

test("candidate gate cannot pass on one arbitrary green check", () => {
  const result = snapshot({
    phase: "candidate",
    github: {
      candidate_workflows: {
        check_push: {
          run: workflowRun({ id: 101, event: "push" }),
          jobs: [{ name: "cosmetic", status: "completed", conclusion: "success" }],
        },
      },
    },
  });
  assert.equal(result.gate.status, "blocked");
  const missingJobs = result.gate.issues.find(({ code }) => code === "CANDIDATE_REQUIRED_JOBS_MISSING");
  assert.deepEqual(missingJobs?.jobs, REQUIRED_CANDIDATE_MATRIX_JOB_NAMES);
  assert.equal(result.gate.issues.filter(({ code }) => code === "CANDIDATE_WORKFLOW_RUN_MISSING").length, 2);
});

for (const [workflowKey, requiredNames] of [
  ["check_push", REQUIRED_CANDIDATE_MATRIX_JOB_NAMES],
  ["check_pull_request", REQUIRED_CANDIDATE_MATRIX_JOB_NAMES],
  ["fuzz_pull_request", ["transport-runtime"]],
]) {
  for (const missingName of requiredNames) {
    test(`${workflowKey} requires the exact ${missingName} job`, () => {
      const workflows = successfulCandidateWorkflows();
      workflows[workflowKey] = {
        ...workflows[workflowKey],
        jobs: workflows[workflowKey].jobs.filter(({ name }) => name !== missingName),
      };
      const result = snapshot({ phase: "candidate", github: { candidate_workflows: workflows } });
      assert.equal(result.gate.status, "blocked");
      const missing = result.gate.issues.find((entry) => (
        entry.code === "CANDIDATE_REQUIRED_JOBS_MISSING" && entry.workflow === workflowKey
      ));
      assert.deepEqual(missing?.jobs, [missingName]);
    });
  }
}

for (const [label, status, conclusion] of [
  ["skipped", "completed", "skipped"],
  ["neutral", "completed", "neutral"],
  ["pending", "in_progress", null],
  ["failure", "completed", "failure"],
]) {
  test(`a required ${label} job cannot satisfy the candidate gate`, () => {
    const workflows = successfulCandidateWorkflows();
    workflows.check_push = {
      ...workflows.check_push,
      jobs: successfulJobs(REQUIRED_CANDIDATE_MATRIX_JOB_NAMES, {
        [REQUIRED_CANDIDATE_MATRIX_JOB_NAMES[0]]: { status, conclusion },
      }),
    };
    const result = snapshot({ phase: "candidate", github: { candidate_workflows: workflows } });
    assert.equal(result.gate.status, "blocked");
    assert.ok(result.gate.issues.some(({ code }) => code === "CANDIDATE_REQUIRED_JOBS_NOT_GREEN"));
  });
}

test("pull-request workflow evidence binds the exact PR base and head", () => {
  const workflows = successfulCandidateWorkflows();
  workflows.check_pull_request = {
    ...workflows.check_pull_request,
    run: workflowRun({
      id: 102,
      event: "pull_request",
      overrides: {
        pull_requests: [{
          number: 20,
          head: { ref: source.candidate_ref, sha: CANDIDATE_SHA },
          base: { ref: "main", sha: "c".repeat(40) },
        }],
      },
    }),
  };
  const result = snapshot({ phase: "candidate", github: { candidate_workflows: workflows } });
  assert.equal(result.gate.status, "blocked");
  assert.ok(result.gate.issues.some(({ code }) => code === "CANDIDATE_WORKFLOW_CONTEXT_INVALID"));
});

test("workflow success cannot hide a pending workflow run", () => {
  const workflows = successfulCandidateWorkflows();
  workflows.fuzz_pull_request = {
    ...workflows.fuzz_pull_request,
    run: workflowRun({ id: 103, event: "pull_request", overrides: { status: "in_progress", conclusion: null } }),
  };
  const result = snapshot({ phase: "candidate", github: { candidate_workflows: workflows } });
  assert.equal(result.gate.status, "blocked");
  assert.ok(result.gate.issues.some(({ code }) => code === "CANDIDATE_WORKFLOW_NOT_GREEN"));
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

test("missing About counts and disclaimer are public-truth blockers", () => {
  const result = snapshot({ phase: "candidate", github: { description: "Inspectable equity research." } });
  assert.deepEqual(new Set(result.gate.issues.map(({ code }) => code)), new Set([
    "ABOUT_DISCLAIMER_MISSING",
    "ABOUT_PACK_COUNT_MISSING",
    "ABOUT_TOOL_COUNT_MISSING",
  ]));
});

test("remote audit uses public read-only endpoints and tolerates no GitHub release as missing evidence", async () => {
  const documents = new Map([
    ["https://api.github.com/repos/Zhao73/alphacouncil-agent", { default_branch: "main", description: "26 method lenses, 34 tools. Not investment advice.", topics: [] }],
    ["https://api.github.com/repos/Zhao73/alphacouncil-agent/commits/main", { sha: MAIN_SHA }],
    ["https://api.github.com/repos/Zhao73/alphacouncil-agent/contents/package.json?ref=main", { encoding: "base64", content: Buffer.from(JSON.stringify({ version: "1.5.0" })).toString("base64") }],
    [`https://api.github.com/repos/Zhao73/alphacouncil-agent/commits/${encodeURIComponent(source.candidate_ref)}`, { sha: CANDIDATE_SHA }],
    ["https://api.github.com/repos/Zhao73/alphacouncil-agent/pulls?state=open&per_page=100", [pull()]],
    ["https://api.github.com/repos/Zhao73/alphacouncil-agent/pulls/20", pull()],
    [`https://api.github.com/repos/Zhao73/alphacouncil-agent/actions/workflows/check.yml/runs?head_sha=${CANDIDATE_SHA}&per_page=100`, {
      workflow_runs: [workflowRun({ id: 102, event: "pull_request" }), workflowRun({ id: 101, event: "push" })],
    }],
    [`https://api.github.com/repos/Zhao73/alphacouncil-agent/actions/workflows/fuzz.yml/runs?head_sha=${CANDIDATE_SHA}&per_page=100`, {
      workflow_runs: [workflowRun({ id: 103, event: "pull_request" })],
    }],
    ["https://api.github.com/repos/Zhao73/alphacouncil-agent/actions/runs/101/jobs?filter=latest&per_page=100", {
      jobs: successfulJobs(REQUIRED_CANDIDATE_MATRIX_JOB_NAMES),
    }],
    ["https://api.github.com/repos/Zhao73/alphacouncil-agent/actions/runs/102/jobs?filter=latest&per_page=100", {
      jobs: successfulJobs(REQUIRED_CANDIDATE_MATRIX_JOB_NAMES),
    }],
    ["https://api.github.com/repos/Zhao73/alphacouncil-agent/actions/runs/103/jobs?filter=latest&per_page=100", {
      jobs: successfulJobs(["transport-runtime"]),
    }],
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
  assert.match(result.stdout, /--check exits 2 when the selected phase gate is blocked/u);
  assert.match(result.stdout, /--phase report\|candidate\|publication/u);
});
