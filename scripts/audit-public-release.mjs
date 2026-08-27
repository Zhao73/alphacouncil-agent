#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { measureReleaseCounts } from "./check-release-consistency.mjs";
import {
  auditPublicRelease,
  formatPublicReleaseAudit,
} from "./lib/public-release-audit.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function usage() {
  return [
    "Usage: node scripts/audit-public-release.mjs [--candidate-ref REF] [--repository OWNER/REPO] [--json] [--check]",
    "",
    "Read-only audit of source, candidate PR, GitHub About/Release and npm latest.",
    "Default report mode exits 0 when drift is observed; --check exits 2 on drift.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { repository: "Zhao73/alphacouncil-agent", candidateRef: null, json: false, check: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--candidate-ref") options.candidateRef = argv[++index];
    else if (arg === "--repository") options.repository = argv[++index];
    else throw new Error(`unknown argument: ${arg}\n${usage()}`);
  }
  return options;
}

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    const [owner, repository, extra] = options.repository.split("/");
    if (!owner || !repository || extra) throw new Error(`--repository must be OWNER/REPO\n${usage()}`);
    const packageDocument = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
    const counts = await measureReleaseCounts(repoRoot);
    const candidateRef = options.candidateRef || git(["branch", "--show-current"]);
    if (!candidateRef) throw new Error("detached HEAD requires --candidate-ref REF");
    const result = await auditPublicRelease({
      owner,
      repository,
      packageName: packageDocument.name,
      githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null,
      source: {
        version: packageDocument.version,
        candidate_ref: candidateRef,
        candidate_sha: git(["rev-parse", "HEAD"]),
        main_sha: git(["rev-parse", "origin/main"]),
        worktree_dirty: Boolean(git(["status", "--porcelain"])),
        pack_count: counts.packCount,
        tool_count: counts.toolCount,
      },
    });
    process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatPublicReleaseAudit(result)}\n`);
    if (options.check && result.status !== "aligned") process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`public release audit failed [${error.code || "PUBLIC_RELEASE_AUDIT_ERROR"}]: ${error.message}\n`);
  process.exitCode = 1;
}
