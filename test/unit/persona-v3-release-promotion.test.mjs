import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import { signReleaseApproval } from "../../mcp/lib/personas-v3/release-approvals.mjs";
import { verifyPhysicalReleaseOperations } from "../../mcp/lib/personas-v3/ga-external-evidence.mjs";
import {
  PERSONA_RELEASE_COMPONENTS,
  assemblePersonaRelease,
  planPersonaReleasePointer,
  promotePersonaRelease,
  resolveCurrentPersonaRelease,
} from "../../mcp/lib/personas-v3/releases.mjs";
import { CANONICAL_MASTER_IDS } from "../../mcp/lib/personas-v3/staging.mjs";
import { parseArgs as parsePromoteArgs } from "../../scripts/promote-persona-v3-release.mjs";
import {
  TRUSTED_SOURCE_REVIEW_KEYS,
  createEmptyReleaseAdjudicationRoot,
  releaseSourceEvidenceOptions,
} from "../helpers/persona-v3-release-source-evidence.mjs";
import {
  TRUSTED_FORMULA_REVIEW_KEYS,
  installFormulaEvidenceIntoPack,
} from "../helpers/persona-v3-formula-review-evidence.mjs";
import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";

const RELEASE_SIGNERS = [
  { keyId: "release:key-a", principal: "Release Reviewer A", ...generateKeyPairSync("ed25519") },
  { keyId: "release:key-b", principal: "Release Reviewer B", ...generateKeyPairSync("ed25519") },
];
const TRUSTED_RELEASE_KEYS = Object.fromEntries(RELEASE_SIGNERS.map((signer) => [signer.keyId, {
  public_key: signer.publicKey,
  principal_id: signer.principal,
  purposes: ["persona_release"],
}]));

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function physicalBinding(root, relativePath) {
  const bytes = readFileSync(join(root, relativePath));
  const value = JSON.parse(bytes.toString("utf8"));
  return {
    relative_path: relativePath,
    file_hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    artifact_hash: sha256(value),
  };
}

function operationBinding(root, pointer) {
  return {
    pointer_history: physicalBinding(root, `pointers/${String(pointer.pointer_version).padStart(8, "0")}.json`),
    approval: physicalBinding(root, `approvals/${pointer.approval_hash.slice("sha256:".length)}.json`),
    release_manifest: physicalBinding(root, `${pointer.release_id}/release-manifest.json`),
    previous_release_manifest: physicalBinding(root, `${pointer.previous_release_id}/release-manifest.json`),
  };
}

function inspector({ personaId, tree }) {
  const hash = (name) => sha256({ personaId, tree: tree.tree_hash, name });
  return {
    pack_version: "0.9.0",
    source_cutoff: "2026-07-27",
    pack_hash: hash("pack"),
    corpus_hash: hash("corpus"),
    policy_hash: hash("policy"),
    tool_graph_hash: hash("tools"),
    component_hashes: Object.fromEntries([...PERSONA_RELEASE_COMPONENTS, "voice"].map((name) => [name, hash(name)])),
    admission_level: "operational",
    operational_clear: true,
    candidate_clear: false,
    physical_corpus_counts: { physical_v3_pack: 1 },
    delta_to_operational: {},
    delta_to_candidate: {},
    method_model_experiment_status: { status: "not_started" },
  };
}

function createSource(root) {
  mkdirSync(root);
  for (const personaId of CANONICAL_MASTER_IDS) {
    const pack = join(root, personaId);
    mkdirSync(join(pack, "c"), { recursive: true });
    mkdirSync(join(pack, "v"));
    const components = {};
    for (const name of PERSONA_RELEASE_COMPONENTS) {
      components[name] = `c/${name}.json`;
      if (name === "tools") continue;
      writeJson(join(pack, components[name]), name === "sources" ? []
        : { schema_version: 1, status: "passed", component: name });
    }
    installFormulaEvidenceIntoPack(pack, personaId, components.tools);
    writeFileSync(join(pack, "v", "en.md"), "production voice\n");
    writeFileSync(join(pack, "v", "zh.md"), "生产表达\n");
    writeJson(join(pack, "manifest.json"), {
      schema_version: 3,
      pack_version: "0.9.0",
      identity: { persona_id: personaId, source_cutoff: "2026-07-27" },
      components,
      voice: { load_after_decision_freeze: true, en: "v/en.md", zh: "v/zh.md" },
    });
  }
}

function workspace(t) {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "alphacouncil-promotion-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sourceRoot = join(dir, "source");
  const releaseRoot = join(dir, "releases");
  const adjudicationRoot = join(dir, "adjudication");
  createSource(sourceRoot);
  createEmptyReleaseAdjudicationRoot(adjudicationRoot);
  for (const releaseId of ["0.9.0-rc.1", "0.9.0-rc.2"]) {
    assemblePersonaRelease({
      releaseId,
      sourceRoot,
      releaseRoot,
      inspectPack: inspector,
      now: new Date("2026-07-27T12:00:00.000Z"),
      ...releaseSourceEvidenceOptions(adjudicationRoot),
      trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
    });
  }
  return { dir, sourceRoot, releaseRoot, adjudicationRoot };
}

function approvalOptions(paths, releaseId, operation, previousReleaseId, approvedAt = "2026-07-27T12:30:00.000Z") {
  const manifest = JSON.parse(readFileSync(join(paths.releaseRoot, releaseId, "release-manifest.json"), "utf8"));
  const header = {
    schema_version: 1,
    artifact_kind: "persona_v3_release_approval_bundle",
    operation,
    release_id: releaseId,
    release_manifest_hash: sha256(manifest),
    previous_release_id: previousReleaseId,
  };
  return {
    approvalDocument: {
      ...header,
      approvals: RELEASE_SIGNERS.map((signer, index) => signReleaseApproval(header, {
        reviewer_id: signer.principal,
        signer_key_id: signer.keyId,
        approved_at: new Date(Date.parse(approvedAt) + index * 1_000).toISOString(),
      }, { privateKey: signer.privateKey, signerKeyId: signer.keyId })),
    },
    trustedReleaseKeys: TRUSTED_RELEASE_KEYS,
    trustedReviewerKeys: TRUSTED_SOURCE_REVIEW_KEYS,
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
  };
}

test("cutover and rollback use versioned pointers and retain every old release", (t) => {
  const paths = workspace(t);
  const preview = planPersonaReleasePointer({
    releaseId: "0.9.0-rc.1",
    releaseRoot: paths.releaseRoot,
    inspectPack: inspector,
    now: new Date("2026-07-27T13:00:00.000Z"),
    ...approvalOptions(paths, "0.9.0-rc.1", "cutover", null),
  });
  assert.equal(preview.mode, "check_only");
  assert.equal(preview.pointer.pointer_version, 1);
  assert.equal(existsSync(join(paths.releaseRoot, "current.json")), false);
  const missingFormulaTrust = approvalOptions(paths, "0.9.0-rc.1", "cutover", null);
  delete missingFormulaTrust.trustedFormulaReviewerKeys;
  assert.throws(() => planPersonaReleasePointer({
    releaseId: "0.9.0-rc.1",
    releaseRoot: paths.releaseRoot,
    inspectPack: inspector,
    now: new Date("2026-07-27T13:00:00.000Z"),
    ...missingFormulaTrust,
  }), /formula reviewer key registry|formula review requires at least two/u);

  const first = promotePersonaRelease({
    releaseId: "0.9.0-rc.1",
    operation: "cutover",
    releaseRoot: paths.releaseRoot,
    inspectPack: inspector,
    now: new Date("2026-07-27T13:00:00.000Z"),
    ...approvalOptions(paths, "0.9.0-rc.1", "cutover", null),
  });
  assert.equal(first.pointer.pointer_version, 1);
  assert.equal(first.pointer.previous_release_id, null);
  assert.equal(first.activation_marker.highest_pointer_version, 1);

  const second = promotePersonaRelease({
    releaseId: "0.9.0-rc.2",
    operation: "cutover",
    releaseRoot: paths.releaseRoot,
    inspectPack: inspector,
    now: new Date("2026-07-27T14:00:00.000Z"),
    ...approvalOptions(paths, "0.9.0-rc.2", "cutover", "0.9.0-rc.1"),
  });
  assert.equal(second.pointer.pointer_version, 2);
  assert.equal(second.pointer.previous_release_id, "0.9.0-rc.1");

  const rollback = promotePersonaRelease({
    releaseId: "0.9.0-rc.1",
    operation: "rollback",
    releaseRoot: paths.releaseRoot,
    inspectPack: inspector,
    now: new Date("2026-07-27T15:00:00.000Z"),
    ...approvalOptions(paths, "0.9.0-rc.1", "rollback", "0.9.0-rc.2"),
  });
  assert.equal(rollback.pointer.pointer_version, 3);
  assert.equal(rollback.pointer.previous_release_id, "0.9.0-rc.2");
  assert.equal(rollback.current.pointer.release_id, "0.9.0-rc.1");
  assert.equal(rollback.activation_marker.highest_pointer_version, 3);
  assert.equal(rollback.old_releases_retained, true);
  assert.equal(existsSync(join(paths.releaseRoot, "0.9.0-rc.1")), true);
  assert.equal(existsSync(join(paths.releaseRoot, "0.9.0-rc.2")), true);
  assert.equal(JSON.parse(readFileSync(join(paths.releaseRoot, "cutover-ever.json"), "utf8")).highest_pointer_version, 3);
  assert.deepEqual(readdirSync(join(paths.releaseRoot, "pointers")).sort(), ["00000001.json", "00000002.json", "00000003.json"]);

  const current = resolveCurrentPersonaRelease({
    releaseRoot: paths.releaseRoot,
    inspectPack: inspector,
    trustedReleaseKeys: TRUSTED_RELEASE_KEYS,
    trustedReviewerKeys: TRUSTED_SOURCE_REVIEW_KEYS,
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
    now: new Date("2026-07-27T16:00:00.000Z"),
  });
  assert.equal(current.status, "current_verified");
  assert.equal(current.release.release_id, "0.9.0-rc.1");
  assert.throws(() => planPersonaReleasePointer({
    releaseId: "0.9.0-rc.1",
    operation: "rollback",
    releaseRoot: paths.releaseRoot,
    inspectPack: inspector,
    trustedReleaseKeys: TRUSTED_RELEASE_KEYS,
    trustedReviewerKeys: TRUSTED_SOURCE_REVIEW_KEYS,
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
    now: new Date("2026-07-27T16:00:00.000Z"),
  }), /rollback target must differ/u);

  assert.throws(() => planPersonaReleasePointer({
    releaseId: "0.9.0-rc.2",
    operation: "cutover",
    releaseRoot: paths.releaseRoot,
    inspectPack: inspector,
    trustedReleaseKeys: TRUSTED_RELEASE_KEYS,
    trustedReviewerKeys: TRUSTED_SOURCE_REVIEW_KEYS,
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
    now: new Date("2026-07-27T16:00:00.000Z"),
  }), /signed release approval bundle is required/u);
});

test("current pointer tampering and symlinks fail closed", (t) => {
  const paths = workspace(t);
  promotePersonaRelease({
    releaseId: "0.9.0-rc.1",
    operation: "cutover",
    releaseRoot: paths.releaseRoot,
    inspectPack: inspector,
    now: new Date("2026-07-27T13:00:00.000Z"),
    ...approvalOptions(paths, "0.9.0-rc.1", "cutover", null),
  });
  const currentFile = join(paths.releaseRoot, "current.json");
  const original = JSON.parse(readFileSync(currentFile, "utf8"));
  writeJson(currentFile, { ...original, release_manifest_hash: `sha256:${"0".repeat(64)}` });
  assert.throws(() => resolveCurrentPersonaRelease({
    releaseRoot: paths.releaseRoot,
    inspectPack: inspector,
    trustedReleaseKeys: TRUSTED_RELEASE_KEYS,
    trustedReviewerKeys: TRUSTED_SOURCE_REVIEW_KEYS,
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
  }), /differs from its immutable history/u);

  unlinkSync(currentFile);
  symlinkSync(join(paths.releaseRoot, "pointers", "00000001.json"), currentFile);
  assert.throws(() => resolveCurrentPersonaRelease({
    releaseRoot: paths.releaseRoot,
    inspectPack: inspector,
    trustedReleaseKeys: TRUSTED_RELEASE_KEYS,
    trustedReviewerKeys: TRUSTED_SOURCE_REVIEW_KEYS,
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
  }), /plain file/u);
});

test("stale current, missing marker and non-contiguous history fail closed", (t) => {
  const paths = workspace(t);
  promotePersonaRelease({
    releaseId: "0.9.0-rc.1",
    operation: "cutover",
    releaseRoot: paths.releaseRoot,
    inspectPack: inspector,
    now: new Date("2026-07-27T13:00:00.000Z"),
    ...approvalOptions(paths, "0.9.0-rc.1", "cutover", null),
  });
  unlinkSync(join(paths.releaseRoot, "cutover-ever.json"));
  assert.throws(() => resolveCurrentPersonaRelease({
    releaseRoot: paths.releaseRoot,
    inspectPack: inspector,
    trustedReleaseKeys: TRUSTED_RELEASE_KEYS,
    trustedReviewerKeys: TRUSTED_SOURCE_REVIEW_KEYS,
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
  }), /activation marker is missing/u);
});

test("physical GA operation evidence proves cutover, rollback, retained old release and final candidate current", (t) => {
  const paths = workspace(t);
  const promote = (releaseId, operation, previousReleaseId, hour) => promotePersonaRelease({
    releaseId,
    operation,
    releaseRoot: paths.releaseRoot,
    inspectPack: inspector,
    now: new Date(`2026-07-27T${hour}:00:00.000Z`),
    ...approvalOptions(
      paths,
      releaseId,
      operation,
      previousReleaseId,
      `2026-07-27T${String(Number(hour) - 1).padStart(2, "0")}:30:00.000Z`,
    ),
  });
  promote("0.9.0-rc.1", "cutover", null, "13");
  const cutover = promote("0.9.0-rc.2", "cutover", "0.9.0-rc.1", "14");
  const rollback = promote("0.9.0-rc.1", "rollback", "0.9.0-rc.2", "15");
  const finalCutover = promote("0.9.0-rc.2", "cutover", "0.9.0-rc.1", "16");
  const releaseOperations = {
    cutover: operationBinding(paths.releaseRoot, cutover.pointer),
    rollback: operationBinding(paths.releaseRoot, rollback.pointer),
    final_cutover: operationBinding(paths.releaseRoot, finalCutover.pointer),
    current_pointer: physicalBinding(paths.releaseRoot, "current.json"),
    activation_marker: physicalBinding(paths.releaseRoot, "cutover-ever.json"),
  };
  const options = {
    releaseRoot: paths.releaseRoot,
    releaseOperations,
    verifiedRelease: finalCutover.current.release,
    inspectPack: inspector,
    trustedReleaseKeys: TRUSTED_RELEASE_KEYS,
    trustedSourceReviewerKeys: TRUSTED_SOURCE_REVIEW_KEYS,
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
    now: new Date("2026-07-27T17:00:00.000Z"),
  };
  const verified = verifyPhysicalReleaseOperations(options);
  assert.equal(verified.valid, true);
  assert.equal(verified.cutover, "passed");
  assert.equal(verified.rollback, "passed");
  assert.equal(verified.current_release_id, "0.9.0-rc.2");
  assert.equal(verified.retained_release_id, "0.9.0-rc.1");
  assert.deepEqual(verified.approval_principal_ids, ["Release Reviewer A", "Release Reviewer B"]);

  assert.throws(() => verifyPhysicalReleaseOperations({
    ...options,
    releaseOperations: {
      ...releaseOperations,
      rollback: {
        ...releaseOperations.rollback,
        approval: { ...releaseOperations.rollback.approval, file_hash: sha256("arbitrary passed string") },
      },
    },
  }), /does not match its signed physical binding/u);
  assert.throws(() => verifyPhysicalReleaseOperations({
    ...options,
    trustedReleaseKeys: Object.fromEntries(Object.entries(TRUSTED_RELEASE_KEYS).map(([key, value]) => [key, {
      ...value,
      purposes: ["persona_release_evidence"],
    }])),
  }), /external persona_release verification/u);

  rmSync(join(paths.releaseRoot, "0.9.0-rc.1"), { recursive: true });
  assert.throws(() => verifyPhysicalReleaseOperations(options), /previous release manifest is missing|missing:/u);
});

test("promotion CLI exposes verify/cutover/rollback/current and defaults to preview", () => {
  assert.deepEqual(
    {
      action: parsePromoteArgs(["--cutover", "0.9.0-rc.1", "--approval", "/tmp/approval.json"]).action,
      write: parsePromoteArgs(["--cutover", "0.9.0-rc.1", "--approval", "/tmp/approval.json"]).write,
    },
    { action: "cutover", write: false },
  );
  assert.equal(parsePromoteArgs(["--rollback", "0.9.0-rc.1", "--approval", "/tmp/approval.json", "--write"]).write, true);
  assert.equal(parsePromoteArgs(["--verify", "0.9.0-rc.1"]).action, "verify");
  assert.equal(parsePromoteArgs(["--current"]).action, "current");
  assert.equal(parsePromoteArgs([
    "--current",
    "--trusted-release-keys", "/tmp/release-keys.json",
    "--trusted-reviewer-keys", "/tmp/reviewer-keys.json",
    "--trusted-formula-reviewer-keys", "/tmp/formula-reviewer-keys.json",
  ]).trustedReviewerKeysFile, "/tmp/reviewer-keys.json");
  assert.equal(parsePromoteArgs([
    "--verify", "0.9.0-rc.1",
    "--trusted-formula-reviewer-keys", "/tmp/formula-reviewer-keys.json",
  ]).trustedFormulaReviewerKeysFile, "/tmp/formula-reviewer-keys.json");
  assert.equal(parsePromoteArgs([
    "--verify", "0.9.0-rc.1",
    "--trusted-reviewer-keys", "/tmp/reviewer-keys.json",
  ]).trustedReviewerKeysFile, "/tmp/reviewer-keys.json");
  assert.throws(() => parsePromoteArgs(["--verify", "x", "--write"]), /valid only/u);
  assert.throws(() => parsePromoteArgs([
    "--verify", "x", "--trusted-release-keys", "/tmp/release-keys.json",
  ]), /only used for current/u);
  assert.throws(() => parsePromoteArgs(["--cutover", "a", "--approval", "/tmp/a", "--rollback", "b"]), /choose exactly one/u);
  assert.throws(() => parsePromoteArgs(["--cutover", "a"]), /--approval is required/u);
});

test("release manifest schema fixes the count at 26 and admission at operational or higher", () => {
  const schema = JSON.parse(readFileSync(new URL("../../schemas/persona-v3-release-manifest-v1.schema.json", import.meta.url), "utf8"));
  const sourceEvidenceSchema = JSON.parse(readFileSync(new URL("../../schemas/persona-v3-release-source-review-evidence-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.canonical_master_count.const, CANONICAL_MASTER_COUNT);
  assert.equal(schema.properties.source_review_evidence.properties.relative_path.const, "source-review-evidence.json");
  assert.equal(schema.properties.packs.minItems, CANONICAL_MASTER_COUNT);
  assert.equal(schema.$defs.pack.properties.admission.properties.operational_clear.const, true);
  assert.deepEqual(schema.$defs.pack.properties.admission.properties.level.enum, ["operational", "candidate", "method_model"]);
  assert.equal(sourceEvidenceSchema.properties.canonical_master_count.const, CANONICAL_MASTER_COUNT);
  assert.equal(sourceEvidenceSchema.properties.ledgers.minItems, CANONICAL_MASTER_COUNT);
  assert.equal(sourceEvidenceSchema.$defs.binding.properties.reviewer_principal_ids.minItems, 2);
});
