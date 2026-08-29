import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MINIMUM_NPM_VERSION,
  RELEASE_WORKFLOW,
  ReleaseWorkflowError,
  assertNpmVersion,
  assertReleaseTag,
  checkReleaseWorkflow,
  parseWorkflowYaml,
  validateReleaseWorkflow,
} from "../../scripts/check-release-workflow.mjs";
import { repoFile } from "../helpers/paths.mjs";

const workflowText = () => readFileSync(repoFile(RELEASE_WORKFLOW), "utf8");

test("release workflow parses and satisfies the two-job OIDC contract", () => {
  const parsed = parseWorkflowYaml(workflowText());
  assert.deepEqual(Object.keys(parsed.jobs), ["publish", "github-release"]);
  assert.deepEqual(validateReleaseWorkflow(workflowText()), []);
  assert.deepEqual(checkReleaseWorkflow(), {
    workflow: ".github/workflows/release.yml",
    jobs: 2,
    node: "24",
    setupNode: "v7",
    npmMinimum: "11.5.1",
    packageVersion: "1.6.0",
    t3: "static_guard_rehearsal",
    publish: "not_run",
    githubRelease: "not_run",
  });
});

test("release tag guard accepts only v plus the exact package version", () => {
  assert.equal(assertReleaseTag("v1.5.0", "1.5.0"), "v1.5.0");
  for (const tag of ["1.5.0", "v1.5.1", "v1.5.0-extra", "", "v1.5.0; npm publish"]) {
    assert.throws(() => assertReleaseTag(tag, "1.5.0"), ReleaseWorkflowError);
  }
});

test("npm guard enforces the Trusted Publishing minimum without invoking npm", () => {
  assert.equal(MINIMUM_NPM_VERSION, "11.5.1");
  for (const version of ["11.5.1", "11.17.0", "12.0.0", "12.0.0-beta.1"]) {
    assert.equal(assertNpmVersion(version), version);
  }
  for (const version of ["11.5.0", "11.5.1-beta.1", "10.99.99", "latest", "v11.5.1"]) {
    assert.throws(() => assertNpmVersion(version), ReleaseWorkflowError);
  }
});

test("workflow gate rejects weakened OIDC permissions and npm token fallback", () => {
  const weakened = workflowText().replace("id-token: write", "id-token: read");
  assert.ok(validateReleaseWorkflow(weakened).some((error) => error.includes("id-token: write")));

  const tokenFallback = workflowText().replace(
    "npm publish --access public",
    "NODE_AUTH_TOKEN=fallback npm publish --access public",
  );
  assert.ok(validateReleaseWorkflow(tokenFallback).some((error) => error.includes("token fallback")));
});

test("workflow gate rejects reordered checks and a release job detached from publish", () => {
  const sourceStep = "      - name: Run source checks\n        run: npm run check\n";
  const workStep = "      - name: Run ChatGPT Work gateway tests\n        run: npm run work:test\n";
  const reordered = workflowText().replace(`${sourceStep}${workStep}`, `${workStep}${sourceStep}`);
  assert.ok(validateReleaseWorkflow(reordered).some((error) => error.includes("reviewed checkout/setup/guard/install/source/work/package/publish order")));

  const detached = workflowText().replace("    needs: publish\n", "");
  assert.ok(validateReleaseWorkflow(detached).some((error) => error.includes("need the successful publish job")));
});

test("workflow gate requires both idempotent GitHub release branches", () => {
  const noEdit = workflowText().replace(
    'gh release edit "$RELEASE_TAG" --verify-tag --title "$RELEASE_TAG" --latest',
    'echo "release already exists"',
  );
  assert.ok(validateReleaseWorkflow(noEdit).some((error) => error.includes("stable GitHub releases")));

  const noCreate = workflowText().replace(
    'gh release create "$RELEASE_TAG" --verify-tag --generate-notes --title "$RELEASE_TAG" --latest',
    'echo "release is missing"',
  );
  assert.ok(validateReleaseWorkflow(noCreate).some((error) => error.includes("stable GitHub releases")));
});

test("workflow gate requires release consistency and main ancestry before install", () => {
  const noConsistency = workflowText().replace(
    '          node scripts/check-release-consistency.mjs --tag "$RELEASE_TAG"',
    '          echo "consistency skipped"',
  );
  assert.ok(validateReleaseWorkflow(noConsistency).some((error) => error.includes("validate the tag")));

  const noAncestry = workflowText().replace(
    '          git fetch --no-tags --unshallow origin main:refs/remotes/origin/main',
    '          echo "unshallow skipped"',
  );
  assert.ok(validateReleaseWorkflow(noAncestry).some((error) => error.includes("unshallow fallback")));
});

test("workflow gate rejects a publish command that can route prereleases to latest", () => {
  const untagged = workflowText().replace(
    'npm publish --access public --tag "$(node scripts/check-release-consistency.mjs --dist-tag "$RELEASE_TAG")"',
    "npm publish --access public",
  );
  assert.ok(validateReleaseWorkflow(untagged).some((error) => error.includes("latest-or-rc dist-tag")));
});

test("workflow gate rejects an rc GitHub release marked latest", () => {
  const rcLatest = workflowText().replace(
    'gh release edit "$RELEASE_TAG" --verify-tag --title "$RELEASE_TAG" --prerelease',
    'gh release edit "$RELEASE_TAG" --verify-tag --title "$RELEASE_TAG" --latest',
  );
  assert.ok(validateReleaseWorkflow(rcLatest).some((error) => error.includes("rc GitHub releases")));
});

test("workflow YAML parser fails closed on duplicate keys and tabs", () => {
  assert.throws(
    () => parseWorkflowYaml("name: Release\nname: Duplicate\n"),
    /duplicate key name/u,
  );
  assert.throws(
    () => parseWorkflowYaml("name: Release\n\tjobs: null\n"),
    /must not contain tabs/u,
  );
});
