#!/usr/bin/env node

import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPersonaV3GaReport,
  GA_ADMISSION_LEVELS,
  GA_DEFAULT_COUNT,
  GA_DEFAULT_MIN_ADMISSION,
  renderPersonaV3GaReport,
} from "../mcp/lib/personas-v3/ga-gate.mjs";

function valueFlag(argv, index, name) {
  const token = argv[index];
  if (token === name) {
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    return { value: argv[index + 1], consumed: 2 };
  }
  if (token.startsWith(`${name}=`)) {
    const value = token.slice(name.length + 1);
    if (!value) throw new Error(`${name} requires a value`);
    return { value, consumed: 1 };
  }
  return null;
}

export function parseArgs(argv = []) {
  const args = {
    json: false,
    help: false,
    requireCount: GA_DEFAULT_COUNT,
    requireMinAdmission: GA_DEFAULT_MIN_ADMISSION,
    forbidLegacy: false,
    forbidPromptLens: false,
    requireReleaseEvidence: true,
    expectedVersion: null,
    personaDir: null,
    knowledgeDir: null,
    stagingDir: null,
    packageJsonPath: null,
    releaseRoot: null,
    releaseId: null,
    releaseManifestPath: null,
    releaseEvidencePath: null,
    trustedSourceReviewerKeysFile: null,
    trustedFormulaReviewerKeysFile: null,
    trustedReleaseEvidenceKeysFile: null,
    trustedReleaseKeysFile: null,
    trustedExperimentAdjudicationKeysFile: null,
  };
  for (let index = 0; index < argv.length;) {
    const token = argv[index];
    if (token === "--json") { args.json = true; index += 1; continue; }
    if (token === "--help" || token === "-h") { args.help = true; index += 1; continue; }
    if (token === "--forbid-legacy") { args.forbidLegacy = true; index += 1; continue; }
    if (token === "--forbid-prompt-lens") { args.forbidPromptLens = true; index += 1; continue; }
    if (token === "--require-release-evidence") { args.requireReleaseEvidence = true; index += 1; continue; }

    const count = valueFlag(argv, index, "--require-count");
    if (count) {
      const parsed = Number(count.value);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error("--require-count must be a positive integer");
      args.requireCount = parsed;
      index += count.consumed;
      continue;
    }
    const admission = valueFlag(argv, index, "--require-min-admission");
    if (admission) {
      if (!GA_ADMISSION_LEVELS.includes(admission.value)) {
        throw new Error(`--require-min-admission must be one of ${GA_ADMISSION_LEVELS.join("|")}`);
      }
      args.requireMinAdmission = admission.value;
      index += admission.consumed;
      continue;
    }
    const version = valueFlag(argv, index, "--expected-version");
    if (version) {
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version.value)) {
        throw new Error("--expected-version must be a semantic version");
      }
      args.expectedVersion = version.value;
      index += version.consumed;
      continue;
    }
    const releaseId = valueFlag(argv, index, "--release-id");
    if (releaseId) {
      args.releaseId = releaseId.value;
      index += releaseId.consumed;
      continue;
    }
    const pathFlags = [
      ["--personas-dir", "personaDir"],
      ["--knowledge-dir", "knowledgeDir"],
      ["--staging-dir", "stagingDir"],
      ["--package-json", "packageJsonPath"],
      ["--release-root", "releaseRoot"],
      ["--release-manifest", "releaseManifestPath"],
      ["--release-evidence", "releaseEvidencePath"],
      ["--trusted-source-reviewer-keys", "trustedSourceReviewerKeysFile"],
      ["--trusted-formula-reviewer-keys", "trustedFormulaReviewerKeysFile"],
      ["--trusted-release-evidence-keys", "trustedReleaseEvidenceKeysFile"],
      ["--trusted-release-keys", "trustedReleaseKeysFile"],
      ["--trusted-experiment-adjudication-keys", "trustedExperimentAdjudicationKeysFile"],
    ];
    let matched = false;
    for (const [flag, key] of pathFlags) {
      const parsed = valueFlag(argv, index, flag);
      if (!parsed) continue;
      args[key] = resolve(parsed.value);
      index += parsed.consumed;
      matched = true;
      break;
    }
    if (matched) continue;
    throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

export function usage() {
  return [
    "Usage: node scripts/check-persona-v3-ga.mjs [options]",
    "",
    "Read-only PersonaPack v3 GA gate. Defaults to the full canonical roster at operational or higher.",
    "",
    "Options:",
    "  --json                         Emit the stable JSON report",
    "  --require-count N              Required canonical/physical/loader count (default 26)",
    "  --require-min-admission LEVEL  prompt_lens|operator_lens|operational|candidate|method_model",
    "  --forbid-legacy                Fail when any legacy v2 pack remains",
    "  --forbid-prompt-lens           Fail when any prompt_lens seat remains",
    "  --expected-version VERSION     Required GA version shared by package, release and hosts",
    "  --require-release-evidence     Compatibility flag; physical release evidence is always required",
    "  --personas-dir PATH            Override the canonical persona directory",
    "  --knowledge-dir PATH           Override the production PersonaPack directory",
    "  --staging-dir PATH             Override the optional staging-observability directory",
    "  --package-json PATH            Physical repository package.json (default: this package)",
    "  --release-root PATH            Immutable release-store root",
    "  --release-id ID                Immutable release directory ID",
    "  --release-manifest PATH        Unsupported standalone-manifest migration diagnostic",
    "  --release-evidence PATH        Signed physical host/package/experiment evidence index",
    "  --trusted-source-reviewer-keys PATH",
    "                                 Trusted source-review Ed25519 public-key registry",
    "  --trusted-formula-reviewer-keys PATH",
    "                                 Trusted formula-review Ed25519 public-key registry",
    "  --trusted-release-evidence-keys PATH",
    "                                 Trusted Ed25519 public-key registry (or use ALPHACOUNCIL_TRUSTED_RELEASE_EVIDENCE_KEYS)",
    "  --trusted-release-keys PATH    Trusted persona_release Ed25519 public-key registry for physical pointer operations",
    "  --trusted-experiment-adjudication-keys PATH",
    "                                 Trusted experiment-adjudicator Ed25519 public-key registry",
    "  --help                         Show this help",
    "",
  ].join("\n");
}

function readPhysicalJson(file, label) {
  let stat;
  try { stat = lstatSync(file); } catch (error) {
    throw new Error(`${label} is unreadable (${error.code || error.message})`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a physical regular file`);
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (error) {
    throw new Error(`${label} is invalid JSON (${error.message})`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  const report = buildPersonaV3GaReport({
    ...(args.personaDir ? { personaDir: args.personaDir } : {}),
    ...(args.knowledgeDir ? { knowledgeDir: args.knowledgeDir } : {}),
    ...(args.stagingDir ? { stagingDir: args.stagingDir } : {}),
    ...(args.packageJsonPath ? { packageJsonPath: args.packageJsonPath } : {}),
    ...(args.releaseRoot ? { releaseRoot: args.releaseRoot } : {}),
    ...(args.releaseId ? { releaseId: args.releaseId } : {}),
    ...(args.releaseManifestPath ? { releaseManifestPath: args.releaseManifestPath } : {}),
    ...(args.releaseEvidencePath ? { releaseEvidencePath: args.releaseEvidencePath } : {}),
    ...(args.trustedReleaseEvidenceKeysFile ? {
      trustedReleaseEvidenceKeys: readPhysicalJson(
        args.trustedReleaseEvidenceKeysFile,
        "trusted release evidence key registry",
      ),
    } : {}),
    ...(args.trustedReleaseKeysFile ? {
      trustedReleaseKeys: readPhysicalJson(
        args.trustedReleaseKeysFile,
        "trusted persona release key registry",
      ),
    } : {}),
    ...(args.trustedSourceReviewerKeysFile ? {
      trustedSourceReviewerKeys: readPhysicalJson(
        args.trustedSourceReviewerKeysFile,
        "trusted source reviewer key registry",
      ),
    } : {}),
    ...(args.trustedFormulaReviewerKeysFile ? {
      trustedFormulaReviewerKeys: readPhysicalJson(
        args.trustedFormulaReviewerKeysFile,
        "trusted formula reviewer key registry",
      ),
    } : {}),
    ...(args.trustedExperimentAdjudicationKeysFile ? {
      trustedExperimentAdjudicationKeys: readPhysicalJson(
        args.trustedExperimentAdjudicationKeysFile,
        "trusted experiment adjudication key registry",
      ),
    } : {}),
    requirements: {
      require_count: args.requireCount,
      require_min_admission: args.requireMinAdmission,
      forbid_legacy: args.forbidLegacy,
      forbid_prompt_lens: args.forbidPromptLens,
      require_release_evidence: args.requireReleaseEvidence,
      expected_version: args.expectedVersion,
    },
  });
  process.stdout.write(args.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderPersonaV3GaReport(report));
  return report.status === "passed" ? 0 : 1;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`PersonaPack v3 GA gate failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
