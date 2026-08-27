#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const RELEASE_WORKFLOW = ".github/workflows/release.yml";
export const MINIMUM_NPM_VERSION = "11.5.1";

export class ReleaseWorkflowError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseWorkflowError";
  }
}

function indentation(line) {
  const match = line.match(/^ */u);
  return match ? match[0].length : 0;
}

function meaningful(lines, start) {
  for (let index = start; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed && !trimmed.startsWith("#")) return { index, indent: indentation(lines[index]) };
  }
  return null;
}

function parseScalar(raw, lineNumber) {
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new ReleaseWorkflowError(`line ${lineNumber}: invalid double-quoted scalar (${error.message})`);
    }
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) {
      throw new ReleaseWorkflowError(`line ${lineNumber}: invalid single-quoted scalar`);
    }
    return raw.slice(1, -1).replace(/''/gu, "'");
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~") return null;
  if (/^-?\d+$/u.test(raw)) return Number(raw);
  return raw;
}

function splitEntry(text, lineNumber) {
  const match = text.match(/^([A-Za-z0-9_.-]+):(.*)$/u);
  if (!match) throw new ReleaseWorkflowError(`line ${lineNumber}: unsupported mapping entry`);
  return { key: match[1], rest: match[2].trimStart() };
}

function setUnique(target, key, value, lineNumber) {
  if (Object.hasOwn(target, key)) {
    throw new ReleaseWorkflowError(`line ${lineNumber}: duplicate key ${key}`);
  }
  target[key] = value;
}

function parseBlockScalar(lines, start, parentIndent) {
  let end = start;
  let contentIndent = null;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && indentation(line) <= parentIndent) break;
    if (line.trim()) contentIndent = Math.min(contentIndent ?? Infinity, indentation(line));
    end += 1;
  }
  if (contentIndent === null) return { value: "", next: end };
  const value = lines.slice(start, end)
    .map((line) => (line.trim() ? line.slice(contentIndent) : ""))
    .join("\n");
  return { value: `${value}\n`, next: end };
}

function parseMapping(lines, start, indent, initial = {}) {
  const value = initial;
  let index = start;
  while (index < lines.length) {
    const next = meaningful(lines, index);
    if (!next) return { value, next: lines.length };
    index = next.index;
    if (next.indent < indent) return { value, next: index };
    if (next.indent > indent) {
      throw new ReleaseWorkflowError(`line ${index + 1}: unexpected indentation`);
    }
    const trimmed = lines[index].trim();
    if (trimmed === "-" || trimmed.startsWith("- ")) return { value, next: index };

    const entry = splitEntry(trimmed, index + 1);
    if (entry.rest === "|" || entry.rest === "|-") {
      const block = parseBlockScalar(lines, index + 1, indent);
      setUnique(value, entry.key, entry.rest === "|-" ? block.value.replace(/\n$/u, "") : block.value, index + 1);
      index = block.next;
      continue;
    }
    if (entry.rest) {
      setUnique(value, entry.key, parseScalar(entry.rest, index + 1), index + 1);
      index += 1;
      continue;
    }

    const child = meaningful(lines, index + 1);
    if (!child || child.indent <= indent) {
      setUnique(value, entry.key, null, index + 1);
      index += 1;
      continue;
    }
    if (child.indent !== indent + 2) {
      throw new ReleaseWorkflowError(`line ${child.index + 1}: nested mappings must use two-space indentation`);
    }
    const parsed = parseNode(lines, child.index, child.indent);
    setUnique(value, entry.key, parsed.value, index + 1);
    index = parsed.next;
  }
  return { value, next: index };
}

function parseSequence(lines, start, indent) {
  const value = [];
  let index = start;
  while (index < lines.length) {
    const next = meaningful(lines, index);
    if (!next) return { value, next: lines.length };
    index = next.index;
    if (next.indent < indent) return { value, next: index };
    if (next.indent > indent) throw new ReleaseWorkflowError(`line ${index + 1}: unexpected indentation`);

    const trimmed = lines[index].trim();
    if (trimmed !== "-" && !trimmed.startsWith("- ")) return { value, next: index };
    const rest = trimmed.slice(1).trimStart();
    if (!rest) {
      const child = meaningful(lines, index + 1);
      if (!child || child.indent !== indent + 2) {
        throw new ReleaseWorkflowError(`line ${index + 1}: sequence item needs a two-space-indented value`);
      }
      const parsed = parseNode(lines, child.index, child.indent);
      value.push(parsed.value);
      index = parsed.next;
      continue;
    }

    if (/^[A-Za-z0-9_.-]+:/u.test(rest)) {
      const entry = splitEntry(rest, index + 1);
      if (!entry.rest) {
        throw new ReleaseWorkflowError(`line ${index + 1}: inline sequence mapping needs a scalar value`);
      }
      const item = {};
      setUnique(item, entry.key, parseScalar(entry.rest, index + 1), index + 1);
      const parsed = parseMapping(lines, index + 1, indent + 2, item);
      value.push(parsed.value);
      index = parsed.next;
      continue;
    }

    value.push(parseScalar(rest, index + 1));
    index += 1;
  }
  return { value, next: index };
}

function parseNode(lines, start, indent) {
  const trimmed = lines[start].trim();
  return trimmed === "-" || trimmed.startsWith("- ")
    ? parseSequence(lines, start, indent)
    : parseMapping(lines, start, indent);
}

/** Parse the deliberately small YAML subset used by the release workflow. */
export function parseWorkflowYaml(text) {
  if (typeof text !== "string" || !text.trim()) throw new ReleaseWorkflowError("workflow YAML is empty");
  if (text.includes("\t")) throw new ReleaseWorkflowError("workflow YAML must not contain tabs");
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const first = meaningful(lines, 0);
  if (!first || first.indent !== 0) throw new ReleaseWorkflowError("workflow YAML must start at column zero");
  const parsed = parseNode(lines, first.index, 0);
  const trailing = meaningful(lines, parsed.next);
  if (trailing) throw new ReleaseWorkflowError(`line ${trailing.index + 1}: trailing YAML was not parsed`);
  return parsed.value;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value, expected) {
  return isRecord(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function requireCondition(errors, condition, message) {
  if (!condition) errors.push(message);
}

function stepByName(job, name) {
  return Array.isArray(job?.steps) ? job.steps.find((step) => step?.name === name) : null;
}

function exactRun(step) {
  return typeof step?.run === "string" ? step.run.trim() : "";
}

export function validateReleaseWorkflow(text) {
  const errors = [];
  let workflow;
  try {
    workflow = parseWorkflowYaml(text);
  } catch (error) {
    return [`workflow YAML parse failed: ${error.message}`];
  }

  requireCondition(errors, sameKeys(workflow, ["name", "on", "jobs"]), "workflow must contain only name, on and jobs at top level");
  requireCondition(errors, workflow.name === "Release", "workflow name must be Release");
  requireCondition(errors, sameKeys(workflow.on, ["push"]), "release workflow must trigger only on push");
  requireCondition(
    errors,
    sameKeys(workflow.on?.push, ["tags"])
      && Array.isArray(workflow.on.push.tags)
      && workflow.on.push.tags.length === 1
      && workflow.on.push.tags[0] === "v*",
    "release workflow must trigger on exactly v* tags",
  );
  requireCondition(errors, sameKeys(workflow.jobs, ["publish", "github-release"]), "release workflow must contain exactly publish and github-release jobs");

  const publish = workflow.jobs?.publish;
  const githubRelease = workflow.jobs?.["github-release"];
  requireCondition(errors, publish?.["runs-on"] === "ubuntu-latest", "publish must use a GitHub-hosted ubuntu-latest runner");
  requireCondition(
    errors,
    sameKeys(publish?.permissions, ["contents", "id-token"])
      && publish.permissions.contents === "read"
      && publish.permissions["id-token"] === "write",
    "publish permissions must be exactly contents: read and id-token: write",
  );

  const expectedPublishSteps = [
    "Check out tagged source",
    "Set up Node for npm Trusted Publishing",
    "Verify tag and npm version",
    "Verify release consistency",
    "Verify tag is on main",
    "Install exact dependencies",
    "Run source checks",
    "Run packaged-host checks",
    "Publish package through OIDC",
  ];
  requireCondition(
    errors,
    Array.isArray(publish?.steps)
      && JSON.stringify(publish.steps.map((step) => step?.name)) === JSON.stringify(expectedPublishSteps),
    "publish steps must keep the reviewed checkout/setup/guard/install/T1/T2/publish order",
  );

  const checkout = stepByName(publish, expectedPublishSteps[0]);
  const setup = stepByName(publish, expectedPublishSteps[1]);
  const guard = stepByName(publish, expectedPublishSteps[2]);
  const consistency = stepByName(publish, expectedPublishSteps[3]);
  const mainGuard = stepByName(publish, expectedPublishSteps[4]);
  const install = stepByName(publish, expectedPublishSteps[5]);
  const sourceCheck = stepByName(publish, expectedPublishSteps[6]);
  const packageCheck = stepByName(publish, expectedPublishSteps[7]);
  const publishStep = stepByName(publish, expectedPublishSteps[8]);

  requireCondition(errors, checkout?.uses === "actions/checkout@v7", "release checkout action must use the reviewed current major v7");
  requireCondition(errors, setup?.uses === "actions/setup-node@v7", "release setup-node action must use the reviewed current major v7");
  requireCondition(
    errors,
    sameKeys(setup?.with, ["node-version", "registry-url", "package-manager-cache"])
      && setup.with["node-version"] === "24"
      && setup.with["registry-url"] === "https://registry.npmjs.org"
      && setup.with["package-manager-cache"] === false,
    "setup-node must use Node 24, npmjs and disabled package-manager caching",
  );

  const guardRun = exactRun(guard);
  requireCondition(errors, guard?.env?.RELEASE_TAG === "${{ github.ref_name }}", "tag guard must read github.ref_name through RELEASE_TAG");
  requireCondition(errors, guardRun.includes("npm --version"), "release guard must print npm --version");
  requireCondition(
    errors,
    guardRun.includes('node scripts/check-release-workflow.mjs --assert-tag "$RELEASE_TAG"'),
    "release guard must assert tag equality against package.json",
  );
  requireCondition(
    errors,
    guardRun.includes('node scripts/check-release-workflow.mjs --assert-npm-version "$(npm --version)"'),
    `release guard must enforce npm >=${MINIMUM_NPM_VERSION}`,
  );
  requireCondition(
    errors,
    sameKeys(publish?.outputs, ["dist_tag"])
      && publish.outputs.dist_tag === "${{ steps.release-consistency.outputs.dist_tag }}",
    "publish must expose the checked dist-tag from the release-consistency step",
  );
  requireCondition(errors, consistency?.id === "release-consistency", "release consistency step must expose the release-consistency id");
  requireCondition(errors, consistency?.env?.RELEASE_TAG === "${{ github.ref_name }}", "release consistency must bind github.ref_name");
  requireCondition(
    errors,
    exactRun(consistency) === [
      'node scripts/check-release-consistency.mjs --tag "$RELEASE_TAG"',
      'echo "dist_tag=$(node scripts/check-release-consistency.mjs --dist-tag "$RELEASE_TAG")" >> "$GITHUB_OUTPUT"',
    ].join("\n"),
    "release consistency must validate the tag and expose its reviewed dist-tag before install",
  );

  const mainGuardRun = exactRun(mainGuard);
  const shallowFetch = "git fetch --no-tags --depth=200 origin main:refs/remotes/origin/main";
  const ancestorCheck = 'git merge-base --is-ancestor "$GITHUB_SHA" origin/main';
  const unshallowFetch = "git fetch --no-tags --unshallow origin main:refs/remotes/origin/main";
  requireCondition(errors, mainGuardRun.includes(shallowFetch), "main ancestry guard must fetch a bounded origin/main history first");
  requireCondition(errors, (mainGuardRun.match(new RegExp(ancestorCheck.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu")) ?? []).length === 2, "main ancestry guard must fail, unshallow if needed, and assert the tag commit again");
  requireCondition(errors, mainGuardRun.includes('git rev-parse --is-shallow-repository'), "main ancestry guard must inspect shallow checkout state");
  requireCondition(errors, mainGuardRun.includes(unshallowFetch), "main ancestry guard must support an unshallow fallback");
  requireCondition(errors, exactRun(install) === "npm ci", "release install must be exactly npm ci");
  requireCondition(errors, exactRun(sourceCheck) === "npm run check", "release T1 step must run npm run check");
  requireCondition(errors, exactRun(packageCheck) === "npm run test:package", "release T2 step must run npm run test:package");
  requireCondition(errors, publishStep?.env?.RELEASE_TAG === "${{ github.ref_name }}", "release publish must bind github.ref_name for dist-tag selection");
  requireCondition(
    errors,
    exactRun(publishStep) === 'npm publish --access public --tag "$(node scripts/check-release-consistency.mjs --dist-tag "$RELEASE_TAG")"',
    "release publish must use the checked latest-or-rc dist-tag",
  );

  requireCondition(errors, githubRelease?.needs === "publish", "github-release must need the successful publish job");
  requireCondition(errors, githubRelease?.["runs-on"] === "ubuntu-latest", "github-release must use ubuntu-latest");
  requireCondition(
    errors,
    sameKeys(githubRelease?.permissions, ["contents"])
      && githubRelease.permissions.contents === "write",
    "github-release permissions must be exactly contents: write",
  );
  requireCondition(errors, githubRelease?.env?.GH_TOKEN === "${{ github.token }}", "github-release must use the bounded GitHub token");
  requireCondition(errors, githubRelease?.env?.GH_REPO === "${{ github.repository }}", "github-release must bind the current repository explicitly");
  requireCondition(errors, githubRelease?.env?.RELEASE_TAG === "${{ github.ref_name }}", "github-release must bind the pushed tag");
  requireCondition(
    errors,
    githubRelease?.env?.DIST_TAG === "${{ needs.publish.outputs.dist_tag }}",
    "github-release must consume the publish job's checked dist-tag",
  );
  requireCondition(errors, Array.isArray(githubRelease?.steps) && githubRelease.steps.length === 1, "github-release must have one create-or-edit step");

  const releaseRun = exactRun(stepByName(githubRelease, "Create or refresh release"));
  requireCondition(errors, (releaseRun.match(/gh release view "\$RELEASE_TAG"/gu) ?? []).length === 2, "github-release must check whether stable and rc releases exist");
  const rcBranch = releaseRun.match(/if \[ "\$DIST_TAG" = "rc" \]; then([\s\S]*?)elif \[ "\$DIST_TAG" = "latest" \]; then/u)?.[1] ?? "";
  const latestBranch = releaseRun.match(/elif \[ "\$DIST_TAG" = "latest" \]; then([\s\S]*?)\nelse\n\s+echo "unsupported release dist-tag/u)?.[1] ?? "";
  requireCondition(
    errors,
    rcBranch.includes('gh release edit "$RELEASE_TAG" --verify-tag --title "$RELEASE_TAG" --prerelease')
      && rcBranch.includes('gh release create "$RELEASE_TAG" --verify-tag --generate-notes --title "$RELEASE_TAG" --prerelease')
      && !rcBranch.includes("--latest"),
    "rc GitHub releases must use --prerelease and must not use --latest",
  );
  requireCondition(
    errors,
    latestBranch.includes('gh release edit "$RELEASE_TAG" --verify-tag --title "$RELEASE_TAG" --latest')
      && latestBranch.includes('gh release create "$RELEASE_TAG" --verify-tag --generate-notes --title "$RELEASE_TAG" --latest')
      && !latestBranch.includes("--prerelease"),
    "stable GitHub releases must use --latest and must not use --prerelease",
  );
  requireCondition(errors, rcBranch.includes("else") && latestBranch.includes("else"), "release creation must remain the missing-release branch for rc and stable tags");

  const forbiddenTokenFallback = /\bNODE_AUTH_TOKEN\b|\bNPM_TOKEN\b|secrets\.[A-Za-z0-9_]*NPM|_authToken|npm\s+(?:login|adduser)|--provenance\b/iu;
  requireCondition(errors, !forbiddenTokenFallback.test(text), "release workflow must not contain an npm token fallback, npm login or manual provenance flag");
  requireCondition(errors, (text.match(/npm publish/gu) ?? []).length === 1, "release workflow must contain exactly one npm publish command");

  return errors;
}

function parseSemver(value, label) {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u);
  if (!match) throw new ReleaseWorkflowError(`${label} is not a semantic version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function compareSemver(left, right) {
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

export function assertReleaseTag(tag, packageVersion) {
  parseSemver(packageVersion, "package version");
  const expected = `v${packageVersion}`;
  if (tag !== expected) {
    throw new ReleaseWorkflowError(`release tag must equal ${expected}; received ${tag || "<empty>"}`);
  }
  return expected;
}

export function assertNpmVersion(version, minimum = MINIMUM_NPM_VERSION) {
  const actual = parseSemver(version, "npm version");
  const floor = parseSemver(minimum, "minimum npm version");
  if (compareSemver(actual, floor) < 0) {
    throw new ReleaseWorkflowError(`npm ${minimum} or newer is required; received ${version}`);
  }
  return String(version);
}

export function checkReleaseWorkflow(root = repoRoot) {
  const workflowPath = resolve(root, RELEASE_WORKFLOW);
  const text = readFileSync(workflowPath, "utf8");
  const errors = validateReleaseWorkflow(text);
  if (errors.length > 0) {
    throw new ReleaseWorkflowError(`release workflow contract failed:\n- ${errors.join("\n- ")}`);
  }
  const packageVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  assertReleaseTag(`v${packageVersion}`, packageVersion);
  assertNpmVersion(MINIMUM_NPM_VERSION);
  return Object.freeze({
    workflow: RELEASE_WORKFLOW,
    jobs: 2,
    node: "24",
    setupNode: "v7",
    npmMinimum: MINIMUM_NPM_VERSION,
    packageVersion,
    t3: "static_guard_rehearsal",
    publish: "not_run",
    githubRelease: "not_run",
  });
}

function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--check") {
    const result = checkReleaseWorkflow();
    process.stdout.write(
      `release-workflow-check: passed version=${result.packageVersion} jobs=${result.jobs} node=${result.node} setup-node=${result.setupNode} npm>=${result.npmMinimum} t3=${result.t3} publish=${result.publish} github_release=${result.githubRelease}\n`,
    );
    return;
  }
  if (args.length === 2 && args[0] === "--assert-tag") {
    const packageVersion = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).version;
    assertReleaseTag(args[1], packageVersion);
    process.stdout.write(`release-tag-check: passed tag=${args[1]} version=${packageVersion}\n`);
    return;
  }
  if (args.length === 2 && args[0] === "--assert-npm-version") {
    assertNpmVersion(args[1]);
    process.stdout.write(`release-npm-check: passed npm=${args[1]} minimum=${MINIMUM_NPM_VERSION}\n`);
    return;
  }
  throw new ReleaseWorkflowError("usage: check-release-workflow.mjs --check | --assert-tag TAG | --assert-npm-version VERSION");
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`release workflow check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
