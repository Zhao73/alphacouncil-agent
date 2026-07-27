import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { computePersonaArtifactHashes, sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import { signReleaseApproval } from "../../mcp/lib/personas-v3/release-approvals.mjs";
import { buildReleaseFormulaReviewEvidence } from "../../mcp/lib/personas-v3/release-formula-evidence.mjs";
import {
  PersonaProductionRootError,
  PERSONA_PRODUCTION_ROOT_ENV,
  resolveActivePersonaKnowledgeDir,
} from "../../mcp/lib/personas-v3/production-root.mjs";
import { CANONICAL_MASTER_IDS } from "../../mcp/lib/personas-v3/staging.mjs";
import {
  TRUSTED_FORMULA_REVIEW_KEYS,
  installFormulaEvidenceIntoPack,
} from "../helpers/persona-v3-formula-review-evidence.mjs";

const RELEASE_SIGNERS = ["a", "b"].map((suffix) => ({
  keyId: `release:key-${suffix}`,
  principal: `Release Reviewer ${suffix.toUpperCase()}`,
  ...generateKeyPairSync("ed25519"),
}));
const SOURCE_SIGNERS = ["a", "b"].map((suffix) => ({
  keyId: `source-review:key-${suffix}`,
  principal: `Source Reviewer ${suffix.toUpperCase()}`,
  ...generateKeyPairSync("ed25519"),
}));
const TRUSTED_RELEASE_KEYS = Object.fromEntries(RELEASE_SIGNERS.map((signer) => [signer.keyId, {
  public_key: signer.publicKey,
  principal_id: signer.principal,
  purposes: ["persona_release"],
}]));
const TRUSTED_REVIEWER_KEYS = Object.fromEntries(SOURCE_SIGNERS.map((signer) => [signer.keyId, {
  public_key: signer.publicKey,
  principal_id: signer.principal,
  purposes: ["source_review"],
}]));

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), "alphacouncil-production-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacy = join(root, "legacy");
  const releases = join(root, "releases");
  mkdirSync(legacy);
  mkdirSync(releases);
  return { root, legacy, releases };
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function treeInventory(root, dir = root, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) treeInventory(root, file, files);
    else {
      const bytes = readFileSync(file);
      files.push({
        path: relative(root, file).split(sep).join("/"),
        byte_length: bytes.length,
        content_hash: sha256(bytes.toString("base64")),
      });
    }
  }
  return files;
}

function reviewerKeySnapshot() {
  return SOURCE_SIGNERS.map((signer) => ({
    key_id: signer.keyId,
    public_key: signer.publicKey.export({ type: "spki", format: "pem" }),
    principal_id: signer.principal,
    revoked: false,
    not_before: null,
    not_after: null,
    purposes: ["source_review"],
  })).sort((a, b) => a.key_id.localeCompare(b.key_id));
}

function resolveOptions(paths) {
  return {
    releaseRoot: paths.releases,
    legacyDir: paths.legacy,
    trustedReleaseKeys: TRUSTED_RELEASE_KEYS,
    trustedReviewerKeys: TRUSTED_REVIEWER_KEYS,
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
    now: new Date("2026-07-27T12:00:00.000Z"),
  };
}

function activeRelease(paths, { releaseId = "0.9.0-rc.1", mutatePointer = {}, mutateManifest = {} } = {}) {
  const release = join(paths.releases, releaseId);
  const masters = join(release, "masters");
  const pointers = join(paths.releases, "pointers");
  const approvals = join(paths.releases, "approvals");
  mkdirSync(masters, { recursive: true });
  mkdirSync(pointers, { recursive: true });
  mkdirSync(approvals, { recursive: true });
  const ids = [...CANONICAL_MASTER_IDS];
  const packs = ids.map((personaId) => {
    const pack = join(masters, personaId);
    mkdirSync(join(pack, "components"), { recursive: true });
    mkdirSync(join(pack, "voice"));
    const components = Object.fromEntries([
      "sources", "doctrine", "decision_cases", "failures", "counterfactuals",
      "research_policy", "decision_policy", "tools", "memory_policy", "golden_cases",
      "pairwise_cases", "calibration_cases", "experiments",
    ].map((name) => [name, `components/${name}.json`]));
    const collectionNames = new Set([
      "sources", "doctrine", "decision_cases", "failures", "counterfactuals",
      "tools", "golden_cases", "pairwise_cases", "calibration_cases",
    ]);
    const componentValues = {};
    for (const [name, path] of Object.entries(components)) {
      componentValues[name] = collectionNames.has(name) ? [] : { schema_version: 1, component: name };
      writeJson(join(pack, path), componentValues[name]);
    }
    installFormulaEvidenceIntoPack(pack, personaId, components.tools);
    componentValues.tools = JSON.parse(readFileSync(join(pack, components.tools), "utf8"));
    writeFileSync(join(pack, "voice", "en.md"), "production voice\n");
    writeFileSync(join(pack, "voice", "zh.md"), "生产表达\n");
    const packManifest = {
      schema_version: 3,
      pack_version: "0.9.0",
      identity: { persona_id: personaId, source_cutoff: "2026-07-27" },
      components,
      voice: { load_after_decision_freeze: true, en: "voice/en.md", zh: "voice/zh.md" },
    };
    writeJson(join(pack, "manifest.json"), packManifest);
    const hashes = computePersonaArtifactHashes({
      manifest: packManifest,
      components: componentValues,
      voice: { en: "production voice", zh: "生产表达" },
    });
    return {
      persona_id: personaId,
      relative_path: `masters/${personaId}`,
      pack_version: "0.9.0",
      source_cutoff: "2026-07-27",
      tree_hash: sha256(treeInventory(pack)),
      artifact_subject_hash: hashes.artifact_subject_hash,
      pack_hash: sha256({ personaId, fixture: "pack" }),
      corpus_hash: hashes.corpus_hash,
      policy_hash: hashes.policy_hash,
      tool_graph_hash: hashes.tool_graph_hash,
      prompt_hash: hashes.prompt_hash,
      component_hashes: hashes.component_hashes,
      admission: {
        level: "operational",
        operational_clear: true,
        candidate_clear: false,
        counts: {},
        delta_to_operational: {},
        delta_to_candidate: {},
        method_model_experiment_status: "not_started",
      },
    };
  });
  const trustedReviewerKeys = reviewerKeySnapshot();
  const ledgers = ids.map((personaId) => ({
    schema_version: 1,
    artifact_kind: "source_adjudication_ledger",
    persona_id: personaId,
    records: [],
  }));
  const ledgerInventory = ledgers.map((ledger) => ({ persona_id: ledger.persona_id, ledger_hash: sha256(ledger) }));
  const sourceReviewEvidence = {
    schema_version: 1,
    artifact_kind: "persona_v3_release_source_review_evidence",
    verified_at: "2026-07-27T00:00:00.000Z",
    canonical_master_count: 26,
    trusted_reviewer_keys: trustedReviewerKeys,
    trusted_key_registry_hash: sha256(trustedReviewerKeys),
    ledger_inventory_hash: sha256(ledgerInventory),
    method_defining_source_count: 0,
    ledgers,
    verified_bindings: [],
  };
  writeJson(join(release, "source-review-evidence.json"), sourceReviewEvidence);
  const formulaReviewEvidence = buildReleaseFormulaReviewEvidence({
    packsRoot: masters,
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
    verifiedAt: "2026-07-27T12:00:00.000Z",
  });
  writeJson(join(release, "formula-review-evidence.json"), formulaReviewEvidence);
  const manifest = {
    schema_version: 1,
    artifact_kind: "persona_v3_release_manifest",
    release_id: releaseId,
    release_status: "assembled_immutable",
    assembled_at: "2026-07-27T00:00:00.000Z",
    canonical_master_count: 26,
    canonical_master_ids: ids,
    canonical_catalog_hash: `sha256:${"a".repeat(64)}`,
    source_inventory_hash: sha256(packs.map((pack) => ({
      persona_id: pack.persona_id,
      tree_hash: pack.tree_hash,
      pack_hash: pack.pack_hash,
      admission: pack.admission.level,
    }))),
    source_review_evidence: {
      relative_path: "source-review-evidence.json",
      evidence_hash: sha256(sourceReviewEvidence),
      trusted_key_registry_hash: sourceReviewEvidence.trusted_key_registry_hash,
      ledger_inventory_hash: sourceReviewEvidence.ledger_inventory_hash,
      method_defining_source_count: 0,
    },
    formula_review_evidence: {
      relative_path: "formula-review-evidence.json",
      evidence_hash: sha256(formulaReviewEvidence),
      trusted_key_registry_hash: formulaReviewEvidence.trusted_key_registry_hash,
      formula_binding_inventory_hash: formulaReviewEvidence.formula_binding_inventory_hash,
      planned_tool_count: 52,
    },
    masters_directory: "masters",
    packs,
    ...mutateManifest,
  };
  writeJson(join(release, "release-manifest.json"), manifest);
  const approvalHeader = {
    schema_version: 1,
    artifact_kind: "persona_v3_release_approval_bundle",
    operation: "cutover",
    release_id: releaseId,
    release_manifest_hash: sha256(manifest),
    previous_release_id: null,
  };
  const approval = {
    ...approvalHeader,
    approvals: RELEASE_SIGNERS.map((signer, index) => signReleaseApproval(approvalHeader, {
      reviewer_id: signer.principal,
      signer_key_id: signer.keyId,
      approved_at: `2026-07-27T0${index + 1}:00:00.000Z`,
    }, { privateKey: signer.privateKey, signerKeyId: signer.keyId })),
  };
  const approvalHash = sha256(approval);
  writeJson(join(approvals, `${approvalHash.slice("sha256:".length)}.json`), approval);
  const pointer = {
    schema_version: 1,
    artifact_kind: "persona_v3_current_pointer",
    pointer_version: 1,
    operation: "cutover",
    release_id: releaseId,
    release_manifest_hash: sha256(manifest),
    previous_release_id: null,
    approval_hash: approvalHash,
    approver_key_ids: RELEASE_SIGNERS.map((signer) => signer.keyId).sort(),
    created_at: "2026-07-27T01:00:00.000Z",
    ...mutatePointer,
  };
  writeJson(join(paths.releases, "current.json"), pointer);
  writeJson(join(pointers, "00000001.json"), pointer);
  writeJson(join(paths.releases, "cutover-ever.json"), {
    schema_version: 1,
    artifact_kind: "persona_v3_cutover_ever_marker",
    first_pointer_version: 1,
    highest_pointer_version: 1,
    first_cutover_at: pointer.created_at,
    updated_at: pointer.created_at,
  });
  return { release, masters, manifest, approval, pointer, sourceReviewEvidence, formulaReviewEvidence };
}

test("legacy root remains the migration fallback until a release pointer exists", (t) => {
  const paths = temp(t);
  assert.equal(resolveActivePersonaKnowledgeDir({
    releaseRoot: paths.releases,
    legacyDir: paths.legacy,
  }), paths.legacy);
  assert.throws(() => resolveActivePersonaKnowledgeDir({
    releaseRoot: paths.releases,
    legacyDir: paths.legacy,
    requireActiveRelease: true,
  }), PersonaProductionRootError);
  assert.equal(PERSONA_PRODUCTION_ROOT_ENV.trusted_formula_review_keys,
    "ALPHACOUNCIL_TRUSTED_FORMULA_REVIEW_KEYS");
});

test("missing current fails closed after any release-operation evidence and explicit knowledge cannot bypass it", (t) => {
  for (const evidence of ["pointer", "approval", "marker"]) {
    const paths = temp(t);
    const override = join(paths.root, `override-${evidence}`);
    mkdirSync(override);
    if (evidence === "pointer") {
      mkdirSync(join(paths.releases, "pointers"));
      writeJson(join(paths.releases, "pointers", "00000001.json"), { interrupted: true });
    } else if (evidence === "approval") {
      mkdirSync(join(paths.releases, "approvals"));
      writeJson(join(paths.releases, "approvals", "interrupted.json"), { interrupted: true });
    } else {
      writeJson(join(paths.releases, "cutover-ever.json"), { interrupted: true });
    }
    assert.throws(() => resolveActivePersonaKnowledgeDir({
      releaseRoot: paths.releases,
      legacyDir: paths.legacy,
      knowledgeDir: override,
    }), /current\.json is missing/u, evidence);
  }
});

test("explicit knowledge cannot bypass a valid activated release or strict release mode", (t) => {
  const paths = temp(t);
  const override = join(paths.root, "override");
  mkdirSync(override);
  const active = activeRelease(paths);
  assert.equal(resolveActivePersonaKnowledgeDir({
    ...resolveOptions(paths),
    knowledgeDir: override,
  }), realpathSync(active.masters));

  const neverActivated = temp(t);
  assert.throws(() => resolveActivePersonaKnowledgeDir({
    releaseRoot: neverActivated.releases,
    legacyDir: neverActivated.legacy,
    knowledgeDir: override,
    requireActiveRelease: true,
  }), /current\.json is missing/u);
});

test("a hash-bound immutable pointer selects one complete release masters root", (t) => {
  const paths = temp(t);
  const active = activeRelease(paths);
  assert.equal(resolveActivePersonaKnowledgeDir({
    ...resolveOptions(paths),
  }), realpathSync(active.masters));
});

test("pointer history, manifest and release count tampering fail closed", (t) => {
  const paths = temp(t);
  const active = activeRelease(paths);
  writeJson(join(paths.releases, "pointers", "00000001.json"), {
    ...active.pointer,
    operation: "rollback",
  });
  assert.throws(() => resolveActivePersonaKnowledgeDir(resolveOptions(paths)), /initial cutover|differs from immutable history/u);

  writeJson(join(paths.releases, "pointers", "00000001.json"), active.pointer);
  writeJson(join(paths.releases, "pointers", "00000002.json"), {
    ...active.pointer,
    pointer_version: 2,
    release_id: "0.9.0-rc.2",
    previous_release_id: active.pointer.release_id,
    created_at: "2026-07-27T02:00:00.000Z",
  });
  assert.throws(() => resolveActivePersonaKnowledgeDir(resolveOptions(paths)), /history is incomplete|latest immutable history/u);
  rmSync(join(paths.releases, "pointers", "00000002.json"));
  writeJson(join(active.release, "release-manifest.json"), { ...active.manifest, canonical_master_count: 25 });
  assert.throws(() => resolveActivePersonaKnowledgeDir(resolveOptions(paths)), /exactly 26/);
});

test("active release rejects missing or mutated source-review evidence", (t) => {
  const paths = temp(t);
  const active = activeRelease(paths);
  writeJson(join(active.release, "source-review-evidence.json"), { ...active.sourceReviewEvidence, verified_bindings: [{}] });
  assert.throws(
    () => resolveActivePersonaKnowledgeDir(resolveOptions(paths)),
    /source-review evidence bindings do not match/u,
  );
});

test("active release requires external trust roots and rejects revoked, wrong-purpose, approval and pack tampering", (t) => {
  const paths = temp(t);
  const active = activeRelease(paths);
  assert.throws(() => resolveActivePersonaKnowledgeDir({
    releaseRoot: paths.releases,
    legacyDir: paths.legacy,
    trustedReviewerKeys: TRUSTED_REVIEWER_KEYS,
    now: new Date("2026-07-27T12:00:00.000Z"),
  }), /approval failed cryptographic verification/u);
  assert.throws(() => resolveActivePersonaKnowledgeDir({
    releaseRoot: paths.releases,
    legacyDir: paths.legacy,
    trustedReleaseKeys: TRUSTED_RELEASE_KEYS,
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
    now: new Date("2026-07-27T12:00:00.000Z"),
  }), /trusted source-review key registry is required/u);

  assert.throws(() => resolveActivePersonaKnowledgeDir({
    releaseRoot: paths.releases,
    legacyDir: paths.legacy,
    trustedReleaseKeys: TRUSTED_RELEASE_KEYS,
    trustedReviewerKeys: TRUSTED_REVIEWER_KEYS,
    now: new Date("2026-07-27T12:00:00.000Z"),
  }), /trusted formula reviewer key registry|formula review requires at least two/u);

  const revokedReleaseKeys = {
    ...TRUSTED_RELEASE_KEYS,
    [RELEASE_SIGNERS[0].keyId]: { ...TRUSTED_RELEASE_KEYS[RELEASE_SIGNERS[0].keyId], revoked: true },
  };
  assert.throws(() => resolveActivePersonaKnowledgeDir({
    ...resolveOptions(paths),
    trustedReleaseKeys: revokedReleaseKeys,
  }), /approval failed cryptographic verification/u);

  const wrongPurposeReviewerKeys = {
    ...TRUSTED_REVIEWER_KEYS,
    [SOURCE_SIGNERS[0].keyId]: {
      ...TRUSTED_REVIEWER_KEYS[SOURCE_SIGNERS[0].keyId],
      purposes: ["persona_release"],
    },
  };
  assert.throws(() => resolveActivePersonaKnowledgeDir({
    ...resolveOptions(paths),
    trustedReviewerKeys: wrongPurposeReviewerKeys,
  }), /not identical to the external trust registry/u);

  const formulaKeyIds = Object.keys(TRUSTED_FORMULA_REVIEW_KEYS);
  const wrongPurposeFormulaKeys = {
    ...TRUSTED_FORMULA_REVIEW_KEYS,
    [formulaKeyIds[0]]: {
      ...TRUSTED_FORMULA_REVIEW_KEYS[formulaKeyIds[0]],
      purposes: ["source_review"],
    },
  };
  assert.throws(() => resolveActivePersonaKnowledgeDir({
    ...resolveOptions(paths),
    trustedFormulaReviewerKeys: wrongPurposeFormulaKeys,
  }), /not identical to the external trust registry|at least two distinct trusted formula_review principals/u);

  const approvalFile = join(paths.releases, "approvals", `${active.pointer.approval_hash.slice("sha256:".length)}.json`);
  writeJson(approvalFile, { ...active.approval, approvals: active.approval.approvals.slice(0, 1) });
  assert.throws(() => resolveActivePersonaKnowledgeDir(resolveOptions(paths)), /approval hash does not match/u);
  writeJson(approvalFile, active.approval);

  writeFileSync(join(active.masters, CANONICAL_MASTER_IDS[0], "voice", "en.md"), "tampered voice\n");
  assert.throws(() => resolveActivePersonaKnowledgeDir(resolveOptions(paths)), /physical tree hash does not match/u);
});

test("symlinked active release directories are rejected", {
  skip: process.platform === "win32",
}, (t) => {
  const paths = temp(t);
  const active = activeRelease(paths);
  const outside = join(paths.root, "outside-masters");
  mkdirSync(outside);
  rmSync(active.masters, { recursive: true });
  symlinkSync(outside, active.masters);
  assert.throws(() => resolveActivePersonaKnowledgeDir(resolveOptions(paths)), /plain directory/);
});
