const GITHUB_API = "https://api.github.com";
const NPM_REGISTRY = "https://registry.npmjs.org";
const SLUG_PART = /^[A-Za-z0-9_.-]+$/u;
const SHA = /^[a-f0-9]{40}$/u;
const AUDIT_PHASES = new Set(["report", "candidate", "publication"]);
export const REQUIRED_CANDIDATE_MATRIX_JOB_NAMES = Object.freeze([
  "check (ubuntu-latest, node 18)",
  "check (ubuntu-latest, node 20)",
  "check (ubuntu-latest, node 22)",
  "check (ubuntu-latest, node 24)",
  "check (windows-latest, node 20)",
  "check (macos-latest, node 20)",
]);
export const REQUIRED_CANDIDATE_CHECK_NAMES = Object.freeze([
  ...REQUIRED_CANDIDATE_MATRIX_JOB_NAMES,
  "transport-runtime",
]);

export class PublicReleaseAuditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PublicReleaseAuditError";
    this.code = code;
  }
}

function assertSlug(value, label) {
  if (typeof value !== "string" || !SLUG_PART.test(value)) {
    throw new PublicReleaseAuditError("INVALID_IDENTIFIER", `${label} contains unsupported characters`);
  }
  return value;
}

function issue(code, layer, message, fields = {}) {
  return Object.freeze({ code, layer, message, ...fields });
}

function stripVersionTag(tag) {
  return typeof tag === "string" && /^v\d/u.test(tag) ? tag.slice(1) : tag ?? null;
}

function extractCount(description, patterns) {
  for (const pattern of patterns) {
    const match = String(description || "").match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

export function parseAboutClaims(description) {
  return Object.freeze({
    pack_count: extractCount(description, [
      /\b(\d+)\s+(?:provisional\s+)?(?:investor[- ]method\s+)?(?:method\s+)?(?:lenses?|seats?)\b/iu,
      /\b(\d+)\s+physical\s+(?:v3\s+)?packs?\b/iu,
    ]),
    tool_count: extractCount(description, [
      /\b(\d+)\s+(?:keyless\s+)?(?:MCP\s+)?tools?\b/iu,
    ]),
  });
}

function decodePackageFile(document, label) {
  if (!document || document.encoding !== "base64" || typeof document.content !== "string") {
    throw new PublicReleaseAuditError("PACKAGE_FILE_INVALID", `${label} did not return base64 package.json content`);
  }
  try {
    return JSON.parse(Buffer.from(document.content.replace(/\s+/gu, ""), "base64").toString("utf8"));
  } catch (error) {
    throw new PublicReleaseAuditError("PACKAGE_FILE_INVALID", `${label} package.json is invalid: ${error.message}`);
  }
}

async function fetchJson(fetchImpl, url, { headers, timeoutMs, allowNotFound = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { headers, signal: controller.signal });
  } catch (error) {
    const reason = error?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : error.message;
    throw new PublicReleaseAuditError("REMOTE_REQUEST_FAILED", `${url} ${reason}`);
  } finally {
    clearTimeout(timer);
  }
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    throw new PublicReleaseAuditError("REMOTE_RESPONSE_INVALID", `${url} returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new PublicReleaseAuditError("REMOTE_RESPONSE_INVALID", `${url} returned invalid JSON: ${error.message}`);
  }
}

function versionAlignmentIssues({ source, github, npm }) {
  const errors = [];
  const releaseVersion = stripVersionTag(github.latest_release?.tag_name);
  const npmLatest = npm.dist_tags?.latest ?? null;
  const publicVersions = [github.main_package_version, releaseVersion, npmLatest];
  if (publicVersions.some((value) => !value)) {
    errors.push(issue(
      "PUBLIC_VERSION_MISSING",
      "publication",
      "main package, latest GitHub Release and npm latest must all be observable before publication alignment can pass",
      { main: github.main_package_version, github_release: releaseVersion, npm_latest: npmLatest },
    ));
  } else if (publicVersions.some((value) => value !== source.version)) {
    errors.push(issue(
      "PUBLIC_VERSION_DRIFT",
      "publication",
      `publication must match source=${source.version}: main=${publicVersions[0]} GitHub=${publicVersions[1]} npm=${publicVersions[2]}`,
      { source: source.version, main: publicVersions[0], github_release: publicVersions[1], npm_latest: publicVersions[2] },
    ));
  }
  if (source.main_sha && github.main_sha !== source.main_sha) {
    errors.push(issue(
      "LOCAL_MAIN_STALE",
      "source",
      `local origin/main ${source.main_sha} does not match GitHub ${github.main_sha}`,
      { expected: github.main_sha, actual: source.main_sha },
    ));
  }
  return errors;
}

function sourceIssues({ source }) {
  return source.worktree_dirty ? [issue(
    "SOURCE_WORKTREE_DIRTY",
    "source",
    "working-tree content is not represented by candidate_sha; commit or discard the scoped changes before treating this audit as a release gate",
  )] : [];
}

function workflowRunMatchesContext(run, { source, github, exactPull, event }) {
  if (!run || run.event !== event || run.head_sha !== source.candidate_sha || run.head_branch !== source.candidate_ref) {
    return false;
  }
  if (event !== "pull_request") return true;
  return Array.isArray(run.pull_requests) && run.pull_requests.some((pull) => (
    pull?.number === exactPull?.number
    && pull?.head?.ref === source.candidate_ref
    && pull?.head?.sha === source.candidate_sha
    && pull?.base?.ref === github.default_branch
    && pull?.base?.sha === github.main_sha
  ));
}

function latestWorkflowRun(runs, context) {
  return [...runs]
    .filter((run) => workflowRunMatchesContext(run, context))
    .sort((left, right) => (
      Number(right?.run_attempt || 0) - Number(left?.run_attempt || 0)
      || Number(right?.id || 0) - Number(left?.id || 0)
    ))[0] || null;
}

function candidateWorkflowIssues({ source, github, exactPull }) {
  const errors = [];
  const workflows = github.candidate_workflows || {};
  const required = [
    { key: "check_push", event: "push", jobs: REQUIRED_CANDIDATE_MATRIX_JOB_NAMES },
    { key: "check_pull_request", event: "pull_request", jobs: REQUIRED_CANDIDATE_MATRIX_JOB_NAMES },
    { key: "fuzz_pull_request", event: "pull_request", jobs: ["transport-runtime"] },
  ];

  for (const requirement of required) {
    const observed = workflows[requirement.key] || null;
    const run = observed?.run || null;
    if (!run) {
      errors.push(issue(
        "CANDIDATE_WORKFLOW_RUN_MISSING",
        "candidate",
        `${requirement.key} has no workflow run for the exact candidate context`,
        { workflow: requirement.key },
      ));
      continue;
    }
    if (!workflowRunMatchesContext(run, { source, github, exactPull, event: requirement.event })) {
      errors.push(issue(
        "CANDIDATE_WORKFLOW_CONTEXT_INVALID",
        "candidate",
        `${requirement.key} does not bind the exact candidate head${requirement.event === "pull_request" ? " and PR base/head" : ""}`,
        { workflow: requirement.key, run_id: run.id ?? null },
      ));
      continue;
    }
    if (run.status !== "completed" || run.conclusion !== "success") {
      errors.push(issue(
        "CANDIDATE_WORKFLOW_NOT_GREEN",
        "candidate",
        `${requirement.key} is not completed/success`,
        { workflow: requirement.key, run_id: run.id ?? null, status: run.status ?? null, conclusion: run.conclusion ?? null },
      ));
    }

    const jobs = Array.isArray(observed.jobs) ? observed.jobs : [];
    const byName = new Map(requirement.jobs.map((name) => [name, []]));
    for (const job of jobs) {
      if (byName.has(job?.name)) byName.get(job.name).push(job);
    }
    const missing = requirement.jobs.filter((name) => byName.get(name).length === 0);
    const unhealthy = requirement.jobs.filter((name) => {
      const matches = byName.get(name);
      return matches.length > 0 && !matches.some((job) => job?.status === "completed" && job?.conclusion === "success");
    });
    if (missing.length) {
      errors.push(issue(
        "CANDIDATE_REQUIRED_JOBS_MISSING",
        "candidate",
        `${requirement.key} is missing ${missing.length} required job(s)`,
        { workflow: requirement.key, run_id: run.id ?? null, jobs: missing },
      ));
    }
    if (unhealthy.length) {
      errors.push(issue(
        "CANDIDATE_REQUIRED_JOBS_NOT_GREEN",
        "candidate",
        `${requirement.key} has ${unhealthy.length} required job(s) without a completed success`,
        {
          workflow: requirement.key,
          run_id: run.id ?? null,
          jobs: unhealthy.map((name) => ({
            name,
            observed: byName.get(name).map((job) => ({ status: job?.status, conclusion: job?.conclusion })),
          })),
        },
      ));
    }
  }
  return errors;
}

function freezeCandidateWorkflows(workflows = {}) {
  return Object.freeze(Object.fromEntries([
    "check_push",
    "check_pull_request",
    "fuzz_pull_request",
  ].map((key) => {
    const observed = workflows[key] || null;
    if (!observed) return [key, null];
    const run = observed.run || null;
    return [key, Object.freeze({
      run: run ? Object.freeze({
        id: run.id ?? null,
        event: run.event ?? null,
        status: run.status ?? null,
        conclusion: run.conclusion ?? null,
        head_sha: run.head_sha ?? null,
        head_branch: run.head_branch ?? null,
        pull_requests: Object.freeze((run.pull_requests || []).map((pull) => Object.freeze({
          number: pull?.number ?? null,
          head_ref: pull?.head?.ref ?? null,
          head_sha: pull?.head?.sha ?? null,
          base_ref: pull?.base?.ref ?? null,
          base_sha: pull?.base?.sha ?? null,
        }))),
      }) : null,
      jobs: Object.freeze((observed.jobs || []).map((job) => Object.freeze({
        name: job?.name ?? null,
        status: job?.status ?? null,
        conclusion: job?.conclusion ?? null,
      }))),
    })];
  })));
}

function candidateIssues({ source, github }) {
  const errors = [];
  if (github.candidate_sha !== source.candidate_sha) {
    errors.push(issue(
      "CANDIDATE_REF_DRIFT",
      "candidate",
      `remote candidate ${github.candidate_sha ?? "<missing>"} does not match local HEAD ${source.candidate_sha}`,
      { expected: source.candidate_sha, actual: github.candidate_sha },
    ));
  }
  const matching = github.open_pulls.filter((pull) => (
    pull?.head?.ref === source.candidate_ref
    && pull?.base?.ref === github.default_branch
  ));
  const exact = matching.filter((pull) => pull?.head?.sha === source.candidate_sha);
  if (exact.length !== 1) {
    errors.push(issue(
      exact.length > 1 ? "CANONICAL_PR_AMBIGUOUS" : matching.length ? "CANONICAL_PR_STALE" : "CANONICAL_PR_MISSING",
      "candidate",
      exact.length > 1
        ? `${exact.length} open PRs point to the exact candidate HEAD`
        : matching.length
          ? `candidate PR head does not point to ${source.candidate_sha}`
          : `no open PR carries ${source.candidate_ref} into ${github.default_branch}`,
      { matching_prs: matching.map((pull) => pull.number), exact_prs: exact.map((pull) => pull.number) },
    ));
  }
  const exactPullSummary = exact[0] ?? null;
  const exactPull = exactPullSummary && github.candidate_pull?.number === exactPullSummary.number
    ? github.candidate_pull
    : exactPullSummary;
  if (exactPull) {
    if (exactPull.base?.sha !== github.main_sha) {
      errors.push(issue(
        "CANDIDATE_BASE_SHA_DRIFT",
        "candidate",
        `candidate PR base ${exactPull.base?.sha ?? "<missing>"} does not match current ${github.default_branch} ${github.main_sha}`,
      ));
    }
    if (exactPull.draft !== false) {
      errors.push(issue(
        exactPull.draft === true ? "CANDIDATE_PR_DRAFT" : "CANDIDATE_DRAFT_STATE_UNKNOWN",
        "candidate",
        exactPull.draft === true ? "candidate PR is still a draft" : "candidate PR draft state is not observable",
      ));
    }
    if (exactPull.mergeable !== true || exactPull.mergeable_state !== "clean") {
      errors.push(issue(
        exactPull.mergeable === false || exactPull.mergeable_state === "dirty"
          ? "CANDIDATE_PR_CONFLICTING"
          : "CANDIDATE_MERGEABILITY_NOT_CLEAN",
        "candidate",
        `candidate PR must be mergeable and clean; mergeable=${String(exactPull.mergeable)} state=${exactPull.mergeable_state ?? "<missing>"}`,
      ));
    }
    errors.push(...candidateWorkflowIssues({ source, github, exactPull }));
  }
  return { errors, exactPull };
}

function aboutIssues({ source, github }) {
  const errors = [];
  const claims = parseAboutClaims(github.description);
  if (claims.pack_count === null) {
    errors.push(issue("ABOUT_PACK_COUNT_MISSING", "public_truth", "GitHub About does not state the measured method-pack/seat count"));
  } else if (claims.pack_count !== source.pack_count) {
    errors.push(issue(
      "ABOUT_PACK_COUNT_DRIFT",
      "public_truth",
      `GitHub About claims ${claims.pack_count} method packs/seats; source measures ${source.pack_count}`,
      { claimed: claims.pack_count, measured: source.pack_count },
    ));
  }
  if (claims.tool_count === null) {
    errors.push(issue("ABOUT_TOOL_COUNT_MISSING", "public_truth", "GitHub About does not state the measured MCP tool count"));
  } else if (claims.tool_count !== source.tool_count) {
    errors.push(issue(
      "ABOUT_TOOL_COUNT_DRIFT",
      "public_truth",
      `GitHub About claims ${claims.tool_count} tools; source measures ${source.tool_count}`,
      { claimed: claims.tool_count, measured: source.tool_count },
    ));
  }
  if (!/(?:not\s+investment\s+advice|不构成投资建议|投資助言ではない)/iu.test(String(github.description || ""))) {
    errors.push(issue(
      "ABOUT_DISCLAIMER_MISSING",
      "public_truth",
      "GitHub About must state that the project is research software, not investment advice",
    ));
  }
  return { errors, claims };
}

function layerStatus(errors, layer) {
  return errors.some((entry) => entry.layer === layer) ? "drift_detected" : "aligned";
}

function publicationSourceIssues({ source, github }) {
  if (source.candidate_sha === github.main_sha) return [];
  return [issue(
    "PUBLICATION_SOURCE_NOT_MAIN",
    "publication",
    `publication checks must run from ${github.default_branch}@${github.main_sha}; source is ${source.candidate_sha}`,
    { expected: github.main_sha, actual: source.candidate_sha },
  )];
}

function gateIssues(errors, phase) {
  if (phase === "candidate") {
    return errors.filter((entry) => ["source", "candidate", "public_truth"].includes(entry.layer));
  }
  if (phase === "publication") {
    return errors.filter((entry) => ["source", "publication", "public_truth"].includes(entry.layer));
  }
  return errors;
}

export function evaluatePublicReleaseSnapshot({ source, github, npm, observedAt, phase = "report" }) {
  if (!source || !github || !npm) throw new TypeError("source, github and npm snapshots are required");
  if (!AUDIT_PHASES.has(phase)) throw new PublicReleaseAuditError("INVALID_PHASE", `phase must be one of ${[...AUDIT_PHASES].join(", ")}`);
  if (!SHA.test(source.candidate_sha)) throw new PublicReleaseAuditError("INVALID_SHA", "candidate_sha must be a 40-character lowercase Git SHA");
  if (source.main_sha && !SHA.test(source.main_sha)) throw new PublicReleaseAuditError("INVALID_SHA", "main_sha must be null or a 40-character lowercase Git SHA");
  const candidate = candidateIssues({ source, github });
  const about = aboutIssues({ source, github });
  const errors = Object.freeze([
    ...sourceIssues({ source }),
    ...versionAlignmentIssues({ source, github, npm }),
    ...candidate.errors,
    ...about.errors,
    ...(phase === "publication" ? publicationSourceIssues({ source, github }) : []),
  ].sort((left, right) => left.layer.localeCompare(right.layer) || left.code.localeCompare(right.code)));
  const selectedGateIssues = Object.freeze(gateIssues(errors, phase));
  const layers = Object.freeze({
    source: layerStatus(errors, "source"),
    candidate: layerStatus(errors, "candidate"),
    public_truth: layerStatus(errors, "public_truth"),
    publication: layerStatus(errors, "publication"),
  });
  return Object.freeze({
    schema: "alphacouncil_public_release_audit_v1",
    schema_version: 1,
    observed_at: observedAt,
    status: errors.length ? "drift_detected" : "aligned",
    source: Object.freeze({ ...source }),
    github: Object.freeze({
      default_branch: github.default_branch,
      main_sha: github.main_sha,
      main_package_version: github.main_package_version,
      candidate_sha: github.candidate_sha,
      latest_release: github.latest_release,
      about: Object.freeze({ description: github.description, topics: Object.freeze([...(github.topics || [])]), claims: about.claims }),
      canonical_pr: candidate.exactPull ? Object.freeze({
        number: candidate.exactPull.number,
        url: candidate.exactPull.html_url,
        head_sha: candidate.exactPull.head.sha,
        base_sha: candidate.exactPull.base?.sha ?? null,
        draft: candidate.exactPull.draft ?? null,
        mergeable: candidate.exactPull.mergeable ?? null,
        mergeable_state: candidate.exactPull.mergeable_state ?? null,
        workflows: freezeCandidateWorkflows(github.candidate_workflows),
      }) : null,
      open_prs: Object.freeze(github.open_pulls.map((pull) => Object.freeze({ number: pull.number, url: pull.html_url, head_ref: pull.head?.ref, head_sha: pull.head?.sha, base_ref: pull.base?.ref }))),
    }),
    npm: Object.freeze({ latest: npm.dist_tags?.latest ?? null, next: npm.dist_tags?.next ?? null, rc: npm.dist_tags?.rc ?? null }),
    layers,
    issues: errors,
    gate: Object.freeze({
      phase,
      status: selectedGateIssues.length ? "blocked" : "passed",
      issues: selectedGateIssues,
    }),
  });
}

export async function auditPublicRelease({
  owner,
  repository,
  packageName,
  source,
  fetchImpl = globalThis.fetch,
  githubToken = null,
  timeoutMs = 15_000,
  now = () => new Date(),
  phase = "report",
} = {}) {
  assertSlug(owner, "owner");
  assertSlug(repository, "repository");
  assertSlug(packageName, "packageName");
  if (typeof fetchImpl !== "function") throw new PublicReleaseAuditError("FETCH_UNAVAILABLE", "a fetch implementation is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new PublicReleaseAuditError("TIMEOUT_INVALID", "timeoutMs must be an integer from 1000 to 60000");
  }
  if (!AUDIT_PHASES.has(phase)) throw new PublicReleaseAuditError("INVALID_PHASE", `phase must be one of ${[...AUDIT_PHASES].join(", ")}`);
  const repoUrl = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const githubHeaders = {
    Accept: "application/vnd.github+json",
    "User-Agent": "alphacouncil-public-release-audit",
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
  };
  const common = { headers: githubHeaders, timeoutMs };
  const repoDocument = await fetchJson(fetchImpl, repoUrl, common);
  const defaultBranch = repoDocument.default_branch;
  assertSlug(defaultBranch, "default branch");
  const ref = encodeURIComponent(source.candidate_ref);
  const candidateSha = encodeURIComponent(source.candidate_sha);
  const [
    mainCommit,
    mainPackageFile,
    candidateCommit,
    latestRelease,
    openPulls,
    checkWorkflowRunsDocument,
    fuzzWorkflowRunsDocument,
    npmDocument,
  ] = await Promise.all([
    fetchJson(fetchImpl, `${repoUrl}/commits/${encodeURIComponent(defaultBranch)}`, common),
    fetchJson(fetchImpl, `${repoUrl}/contents/package.json?ref=${encodeURIComponent(defaultBranch)}`, common),
    fetchJson(fetchImpl, `${repoUrl}/commits/${ref}`, { ...common, allowNotFound: true }),
    fetchJson(fetchImpl, `${repoUrl}/releases/latest`, { ...common, allowNotFound: true }),
    fetchJson(fetchImpl, `${repoUrl}/pulls?state=open&per_page=100`, common),
    fetchJson(fetchImpl, `${repoUrl}/actions/workflows/check.yml/runs?head_sha=${candidateSha}&per_page=100`, common),
    fetchJson(fetchImpl, `${repoUrl}/actions/workflows/fuzz.yml/runs?head_sha=${candidateSha}&per_page=100`, common),
    fetchJson(fetchImpl, `${NPM_REGISTRY}/${encodeURIComponent(packageName)}`, {
      headers: { Accept: "application/json", "User-Agent": "alphacouncil-public-release-audit" },
      timeoutMs,
    }),
  ]);
  if (!Array.isArray(openPulls)) throw new PublicReleaseAuditError("REMOTE_RESPONSE_INVALID", "GitHub pulls response must be an array");
  const matchingPulls = openPulls.filter((pull) => (
    pull?.head?.ref === source.candidate_ref
    && pull?.head?.sha === source.candidate_sha
    && pull?.base?.ref === defaultBranch
  ));
  const candidatePull = matchingPulls.length === 1
    ? await fetchJson(fetchImpl, `${repoUrl}/pulls/${matchingPulls[0].number}`, common)
    : null;
  if (!Array.isArray(checkWorkflowRunsDocument?.workflow_runs) || !Array.isArray(fuzzWorkflowRunsDocument?.workflow_runs)) {
    throw new PublicReleaseAuditError("REMOTE_RESPONSE_INVALID", "GitHub workflow-runs responses must contain arrays");
  }
  const workflowContext = {
    source,
    github: { default_branch: defaultBranch, main_sha: mainCommit?.sha ?? null },
    exactPull: candidatePull,
  };
  const selectedRuns = {
    check_push: latestWorkflowRun(checkWorkflowRunsDocument.workflow_runs, { ...workflowContext, event: "push" }),
    check_pull_request: latestWorkflowRun(checkWorkflowRunsDocument.workflow_runs, { ...workflowContext, event: "pull_request" }),
    fuzz_pull_request: latestWorkflowRun(fuzzWorkflowRunsDocument.workflow_runs, { ...workflowContext, event: "pull_request" }),
  };
  const selectedEntries = Object.entries(selectedRuns);
  const jobDocuments = await Promise.all(selectedEntries.map(([, run]) => (
    run
      ? fetchJson(fetchImpl, `${repoUrl}/actions/runs/${encodeURIComponent(String(run.id))}/jobs?filter=latest&per_page=100`, common)
      : Promise.resolve({ jobs: [] })
  )));
  const candidateWorkflows = Object.fromEntries(selectedEntries.map(([key, run], index) => {
    const jobs = jobDocuments[index]?.jobs;
    if (!Array.isArray(jobs)) {
      throw new PublicReleaseAuditError("REMOTE_RESPONSE_INVALID", `GitHub ${key} jobs response must contain an array`);
    }
    return [key, { run, jobs }];
  }));
  const mainPackage = decodePackageFile(mainPackageFile, defaultBranch);
  return evaluatePublicReleaseSnapshot({
    source,
    observedAt: now().toISOString(),
    phase,
    github: {
      default_branch: defaultBranch,
      description: repoDocument.description ?? "",
      topics: repoDocument.topics || [],
      main_sha: mainCommit?.sha ?? null,
      main_package_version: mainPackage.version ?? null,
      candidate_sha: candidateCommit?.sha ?? null,
      latest_release: latestRelease ? {
        tag_name: latestRelease.tag_name ?? null,
        published_at: latestRelease.published_at ?? null,
        target_commitish: latestRelease.target_commitish ?? null,
        html_url: latestRelease.html_url ?? null,
      } : null,
      open_pulls: openPulls,
      candidate_pull: candidatePull,
      candidate_workflows: candidateWorkflows,
    },
    npm: { dist_tags: npmDocument?.["dist-tags"] || {} },
  });
}

export function formatPublicReleaseAudit(result) {
  const lines = [
    `public-release-audit: ${result.status}`,
    `source=${result.source.version}@${result.source.candidate_sha}`,
    `main=${result.github.main_package_version}@${result.github.main_sha}`,
    `github_release=${stripVersionTag(result.github.latest_release?.tag_name) ?? "none"}`,
    `npm_latest=${result.npm.latest ?? "none"}`,
    `canonical_pr=${result.github.canonical_pr?.number ?? "none"}`,
    `gate.${result.gate.phase}=${result.gate.status}`,
    `about_counts=${result.github.about.claims.pack_count ?? "none"}/${result.github.about.claims.tool_count ?? "none"}`,
  ];
  for (const [layer, status] of Object.entries(result.layers)) lines.push(`layer.${layer}=${status}`);
  for (const entry of result.issues) lines.push(`[${entry.code}] ${entry.message}`);
  return lines.join("\n");
}
