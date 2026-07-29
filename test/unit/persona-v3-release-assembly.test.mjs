import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CANONICAL_MASTER_IDS } from "../../mcp/lib/personas-v3/staging.mjs";
import { sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import { formulaApprovalEvidenceRelativePath } from "../../mcp/lib/personas-v3/formula-review-attestations.mjs";
import { verifyReleaseFormulaReviewEvidence } from "../../mcp/lib/personas-v3/release-formula-evidence.mjs";
import {
  PERSONA_RELEASE_COMPONENTS,
  acquirePersonaReleaseLock,
  assemblePersonaRelease,
  planPersonaRelease,
  validateCanonicalReleaseEntries,
  verifyPersonaRelease,
} from "../../mcp/lib/personas-v3/releases.mjs";
import {
  compileApprovedFormulaSpec,
  planPersonaV3FormulaPipeline,
} from "../../scripts/lib/persona-v3-formula-pipeline.mjs";
import { REPO_ROOT } from "../../scripts/lib/persona-v3-build-specs.mjs";
import { parseArgs as parseAssembleArgs } from "../../scripts/assemble-persona-v3-release.mjs";
import {
  TRUSTED_SOURCE_REVIEW_KEYS,
  createEmptyReleaseAdjudicationRoot,
  installApprovedReleaseSource,
  releaseSourceEvidenceOptions,
} from "../helpers/persona-v3-release-source-evidence.mjs";
import {
  TEST_FORMULA_REVIEWERS,
  TRUSTED_FORMULA_REVIEW_KEYS,
  approvedFormulaSpec,
  signedFormulaApprovalBundle,
} from "../helpers/persona-v3-formula-review-evidence.mjs";
import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";
import { PLANNED_TOOL_COUNT } from "../../data/persona-v3-build-specs.v1.mjs";

const FORMULA_ENTRIES = planPersonaV3FormulaPipeline().inventory.entries;

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function componentHashMap(personaId, treeHash) {
  return Object.fromEntries([...PERSONA_RELEASE_COMPONENTS, "voice"]
    .map((name) => [name, sha256({ personaId, treeHash, name })]));
}

function fixtureInspector({ personaId, tree }) {
  return {
    pack_version: "0.9.0",
    source_cutoff: "2026-07-27",
    pack_hash: sha256({ personaId, tree: tree.tree_hash, kind: "pack" }),
    corpus_hash: sha256({ personaId, tree: tree.tree_hash, kind: "corpus" }),
    policy_hash: sha256({ personaId, tree: tree.tree_hash, kind: "policy" }),
    tool_graph_hash: sha256({ personaId, tree: tree.tree_hash, kind: "tools" }),
    component_hashes: componentHashMap(personaId, tree.tree_hash),
    admission_level: "operational",
    operational_clear: true,
    candidate_clear: false,
    physical_corpus_counts: { physical_v3_pack: 1, dedicated_tools: 2 },
    delta_to_operational: {},
    delta_to_candidate: { dedicated_tools: 1 },
    method_model_experiment_status: { status: "not_started" },
  };
}

function createPack(root, personaId) {
  const pack = join(root, personaId);
  const componentsDir = join(pack, "components");
  const voiceDir = join(pack, "voice");
  mkdirSync(componentsDir, { recursive: true });
  mkdirSync(voiceDir);
  const components = {};
  for (const name of PERSONA_RELEASE_COMPONENTS) {
    components[name] = `components/${name}.json`;
    if (name === "tools") continue;
    writeJson(join(pack, components[name]), name === "sources" ? []
      : { schema_version: 1, status: "passed", component: name });
  }
  const tools = [];
  for (const entry of FORMULA_ENTRIES.filter((candidate) => candidate.persona_id === personaId)) {
    const spec = approvedFormulaSpec(entry);
    const bundle = signedFormulaApprovalBundle(spec);
    const prototypeDocument = JSON.parse(readFileSync(join(REPO_ROOT, spec.prototype_provenance.source_path), "utf8"));
    tools.push(compileApprovedFormulaSpec(spec, {
      prototypeDocument,
      approvalBundle: bundle,
      trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
      now: new Date("2026-07-27T12:00:00.000Z"),
    }));
    const evidenceFile = join(pack, formulaApprovalEvidenceRelativePath(personaId, entry.tool_id));
    mkdirSync(join(evidenceFile, ".."), { recursive: true });
    writeJson(evidenceFile, bundle);
  }
  writeJson(join(pack, components.tools), tools);
  writeFileSync(join(voiceDir, "en.md"), `Production voice for ${personaId}.\n`);
  writeFileSync(join(voiceDir, "zh.md"), `${personaId} 生产表达层。\n`);
  writeJson(join(pack, "manifest.json"), {
    schema_version: 3,
    pack_version: "0.9.0",
    identity: { persona_id: personaId, source_cutoff: "2026-07-27" },
    components,
    voice: { load_after_decision_freeze: true, en: "voice/en.md", zh: "voice/zh.md" },
  });
  return pack;
}

function workspace(t) {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "alphacouncil-release-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sourceRoot = join(dir, "source");
  const releaseRoot = join(dir, "releases");
  const adjudicationRoot = join(dir, "adjudication");
  mkdirSync(sourceRoot);
  for (const id of CANONICAL_MASTER_IDS) createPack(sourceRoot, id);
  createEmptyReleaseAdjudicationRoot(adjudicationRoot);
  return { dir, sourceRoot, releaseRoot, adjudicationRoot };
}

function options(paths, releaseId = "0.9.0-rc.1") {
  return {
    ...paths,
    ...releaseSourceEvidenceOptions(paths.adjudicationRoot),
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
    releaseId,
    inspectPack: fixtureInspector,
    now: new Date("2026-07-27T12:00:00.000Z"),
  };
}

test("check-only planning validates one physical pack per canonical seat without creating a release root", (t) => {
  const paths = workspace(t);
  const result = planPersonaRelease(options(paths));
  assert.equal(result.mode, "check_only");
  assert.equal(result.canonical_master_count, CANONICAL_MASTER_COUNT);
  assert.deepEqual(result.packs.map((pack) => pack.persona_id), [...CANONICAL_MASTER_IDS]);
  assert.ok(result.packs.every((pack) => pack.admission.level === "operational"));
  assert.ok(result.packs.every((pack) => Object.keys(pack.component_hashes).length === 14));
  assert.match(result.release_manifest_hash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(result.release_manifest.formula_review_evidence.planned_tool_count, PLANNED_TOOL_COUNT);
  assert.equal(result.formula_review_evidence.verified_bindings.length, PLANNED_TOOL_COUNT);
  assert.equal(existsSync(paths.releaseRoot), false, "default planning must not mutate the release store");
});

test("source roster rejects 25, 27, duplicate and non-canonical seats", (t) => {
  const paths = workspace(t);
  rmSync(join(paths.sourceRoot, CANONICAL_MASTER_IDS.at(-1)), { recursive: true });
  assert.throws(() => planPersonaRelease(options(paths)), new RegExp(`exactly ${CANONICAL_MASTER_COUNT} unique canonical masters`, "u"));

  createPack(paths.sourceRoot, CANONICAL_MASTER_IDS.at(-1));
  createPack(paths.sourceRoot, "master_not_canonical");
  assert.throws(() => planPersonaRelease(options(paths)), new RegExp(`exactly ${CANONICAL_MASTER_COUNT} unique canonical masters`, "u"));
  assert.throws(
    () => validateCanonicalReleaseEntries([...CANONICAL_MASTER_IDS.slice(0, 25), CANONICAL_MASTER_IDS[0]]),
    new RegExp(`exactly ${CANONICAL_MASTER_COUNT} unique canonical masters`, "u"),
  );
});

test("release assembly binds method-defining sources to two valid Ed25519 ledger approvals", (t) => {
  const paths = workspace(t);
  const personaId = CANONICAL_MASTER_IDS[0];
  const installed = installApprovedReleaseSource({ ...paths, personaId });
  const planned = planPersonaRelease(options(paths));
  assert.equal(planned.release_manifest.source_review_evidence.method_defining_source_count, 1);
  assert.equal(planned.source_review_evidence.verified_bindings.length, 1);
  assert.equal(planned.source_review_evidence.verified_bindings[0].anchor_hash, installed.anchorHash);
  assert.deepEqual(
    planned.source_review_evidence.verified_bindings[0].reviewer_principal_ids,
    ["Source Reviewer A", "Source Reviewer B"],
  );
  assert.match(planned.release_manifest.source_review_evidence.evidence_hash, /^sha256:[a-f0-9]{64}$/u);
});

test("pack reviewer_ids, missing evidence and invalid signed evidence cannot authorize release assembly", (t) => {
  const paths = workspace(t);
  const personaId = CANONICAL_MASTER_IDS[0];
  const installed = installApprovedReleaseSource({ ...paths, personaId });
  const sourceFile = join(paths.sourceRoot, personaId, "components", "sources.json");
  writeJson(sourceFile, [{
    ...installed.anchor,
    adjudication: {
      ...installed.anchor.adjudication,
      reviewer_ids: ["Forged Reviewer A", "Forged Reviewer B"],
    },
  }]);
  assert.throws(() => planPersonaRelease(options(paths)), /reviewer_ids do not match verified signer principals/u);

  writeJson(sourceFile, [installed.anchor]);
  assert.throws(
    () => planPersonaRelease({ ...options(paths), adjudicationRoot: undefined }),
    /source adjudication root must be an explicit absolute path/u,
  );
  assert.throws(
    () => planPersonaRelease({ ...options(paths), trustedReviewerKeys: {} }),
    /at least two distinct trusted source_review principals/u,
  );

  const ledgerFile = join(paths.adjudicationRoot, personaId, "source-adjudication-ledger.json");
  const tamperedLedger = JSON.parse(readFileSync(ledgerFile, "utf8"));
  const last = tamperedLedger.records[0].review_attestations.at(-1);
  last.signature = `ed25519:${"A".repeat(86)}`;
  const withoutHash = { ...last };
  delete withoutHash.attestation_hash;
  last.attestation_hash = sha256(withoutHash);
  tamperedLedger.records[0].attestation_chain_head = last.attestation_hash;
  writeJson(ledgerFile, tamperedLedger);
  assert.throws(() => planPersonaRelease(options(paths)), /not trusted \(invalid_signature\)/u);

  assert.equal(Object.keys(TRUSTED_SOURCE_REVIEW_KEYS).length, 2);
});

test("release assembly rejects missing, duplicate and replayed formula evidence before publication", (t) => {
  const missing = workspace(t);
  const firstEntry = FORMULA_ENTRIES[0];
  unlinkSync(join(missing.sourceRoot, firstEntry.persona_id,
    formulaApprovalEvidenceRelativePath(firstEntry.persona_id, firstEntry.tool_id)));
  assert.throws(() => planPersonaRelease(options(missing)), /formula approval bundle.*missing/u);

  const duplicate = workspace(t);
  const toolsFile = join(duplicate.sourceRoot, firstEntry.persona_id, "components", "tools.json");
  const tools = JSON.parse(readFileSync(toolsFile, "utf8"));
  tools.push(tools[0]);
  writeJson(toolsFile, tools);
  assert.throws(() => planPersonaRelease(options(duplicate)), /exactly its planned unique formula tools/u);

  const replay = workspace(t);
  const secondEntry = FORMULA_ENTRIES[1];
  const firstBundle = join(replay.sourceRoot, firstEntry.persona_id,
    formulaApprovalEvidenceRelativePath(firstEntry.persona_id, firstEntry.tool_id));
  const secondBundle = join(replay.sourceRoot, secondEntry.persona_id,
    formulaApprovalEvidenceRelativePath(secondEntry.persona_id, secondEntry.tool_id));
  writeFileSync(secondBundle, readFileSync(firstBundle));
  assert.throws(() => planPersonaRelease(options(replay)), /does not match formula evidence|bundled formula spec/u);
});

test("draft, pending, missing component, symlink and sub-operational inputs fail closed", (t) => {
  const paths = workspace(t);
  const id = CANONICAL_MASTER_IDS[0];
  const tools = join(paths.sourceRoot, id, "components", "tools.json");
  writeJson(tools, { status: "draft" });
  assert.throws(() => planPersonaRelease(options(paths)), /draft or pending values remain/u);

  writeJson(tools, { status: "pending_human_adjudication" });
  assert.throws(() => planPersonaRelease(options(paths)), /draft or pending values remain/u);

  writeJson(tools, { status: "passed" });
  unlinkSync(tools);
  assert.throws(() => planPersonaRelease(options(paths)), /component is missing/u);

  writeJson(tools, { status: "passed" });
  const target = join(paths.sourceRoot, id, "components", "doctrine.json");
  unlinkSync(tools);
  symlinkSync(target, tools);
  assert.throws(() => planPersonaRelease(options(paths)), /plain file/u);

  unlinkSync(tools);
  writeJson(tools, { status: "passed" });
  assert.throws(() => planPersonaRelease({
    ...options(paths),
    inspectPack: (context) => ({ ...fixtureInspector(context), admission_level: "operator_lens", operational_clear: false }),
  }), /below the release floor|did not clear/u);
});

test("write assembly fsyncs and commits once by same-filesystem atomic rename", (t) => {
  const paths = workspace(t);
  let renames = 0;
  const result = assemblePersonaRelease({
    ...options(paths),
    renameImpl(from, to) {
      assert.equal(statSync(from).dev, statSync(paths.releaseRoot).dev);
      renames += 1;
      renameSync(from, to);
    },
  });
  assert.equal(renames, 1);
  assert.equal(result.mode, "write");
  assert.equal(result.commit_strategy, "same_filesystem_fsync_atomic_rename");
  assert.equal(result.status, "verified");
  assert.equal(result.canonical_master_count, CANONICAL_MASTER_COUNT);
  assert.equal(existsSync(join(paths.releaseRoot, "0.9.0-rc.1", "release-manifest.json")), true);
  assert.equal(existsSync(join(paths.releaseRoot, ".release.lock")), false);
  assert.throws(() => assemblePersonaRelease(options(paths)), /immutable and already exists/u);

  const second = assemblePersonaRelease(options(paths, "0.9.0-rc.2"));
  assert.equal(second.status, "verified");
  assert.equal(existsSync(join(paths.releaseRoot, "0.9.0-rc.1")), true, "old release must be retained");
  assert.equal(existsSync(join(paths.releaseRoot, "0.9.0-rc.2")), true);
});

test("release verification detects physical mutation and unsafe release paths", (t) => {
  const paths = workspace(t);
  assemblePersonaRelease(options(paths));
  const verified = verifyPersonaRelease({
    releaseId: "0.9.0-rc.1",
    releaseRoot: paths.releaseRoot,
    inspectPack: fixtureInspector,
    trustedReviewerKeys: TRUSTED_SOURCE_REVIEW_KEYS,
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
  });
  assert.equal(verified.status, "verified");
  assert.throws(() => verifyPersonaRelease({
    releaseId: "0.9.0-rc.1",
    releaseRoot: paths.releaseRoot,
    inspectPack: fixtureInspector,
    trustedReviewerKeys: TRUSTED_SOURCE_REVIEW_KEYS,
  }), /formula reviewer key registry|formula review requires at least two/u);
  assert.throws(() => verifyPersonaRelease({
    releaseId: "0.9.0-rc.1",
    releaseRoot: paths.releaseRoot,
    inspectPack: fixtureInspector,
    trustedReviewerKeys: TRUSTED_SOURCE_REVIEW_KEYS,
    trustedFormulaReviewerKeys: {},
  }), /formula review requires at least two/u);
  const formulaKeyId = Object.keys(TRUSTED_FORMULA_REVIEW_KEYS)[0];
  const revokedFormulaKeys = {
    ...TRUSTED_FORMULA_REVIEW_KEYS,
    [formulaKeyId]: { ...TRUSTED_FORMULA_REVIEW_KEYS[formulaKeyId], revoked: true },
  };
  assert.throws(() => verifyPersonaRelease({
    releaseId: "0.9.0-rc.1",
    releaseRoot: paths.releaseRoot,
    inspectPack: fixtureInspector,
    trustedReviewerKeys: TRUSTED_SOURCE_REVIEW_KEYS,
    trustedFormulaReviewerKeys: revokedFormulaKeys,
  }), /not identical to the external trust registry|at least two distinct trusted formula_review principals/u);

  const embeddedEvidence = JSON.parse(readFileSync(
    join(paths.releaseRoot, "0.9.0-rc.1", "formula-review-evidence.json"), "utf8",
  ));
  const extraFormulaKey = generateKeyPairSync("ed25519");
  assert.doesNotThrow(() => verifyReleaseFormulaReviewEvidence({
    packsRoot: join(paths.releaseRoot, "0.9.0-rc.1", "masters"),
    evidence: embeddedEvidence,
    trustedFormulaReviewerKeys: {
      ...TRUSTED_FORMULA_REVIEW_KEYS,
      "test.formula-reviewer-c": {
        public_key: extraFormulaKey.publicKey,
        principal_id: "Formula Reviewer C",
        purposes: ["formula_review"],
      },
    },
  }));
  const substituted = JSON.parse(JSON.stringify(embeddedEvidence));
  substituted.trusted_formula_reviewer_keys[0].public_key = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" });
  substituted.trusted_key_registry_hash = sha256(substituted.trusted_formula_reviewer_keys);
  assert.throws(() => verifyReleaseFormulaReviewEvidence({
    packsRoot: join(paths.releaseRoot, "0.9.0-rc.1", "masters"),
    evidence: substituted,
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
  }), /not identical to the external trust registry/u);
  const voice = join(paths.releaseRoot, "0.9.0-rc.1", "masters", CANONICAL_MASTER_IDS[0], "voice", "en.md");
  writeFileSync(voice, "tampered\n");
  assert.throws(() => verifyPersonaRelease({
    releaseId: "0.9.0-rc.1",
    releaseRoot: paths.releaseRoot,
    inspectPack: fixtureInspector,
    trustedReviewerKeys: TRUSTED_SOURCE_REVIEW_KEYS,
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
  }), /manifest no longer matches physical packs/u);
});

test("exclusive release lock rejects contention and releases only its own inode", (t) => {
  const paths = workspace(t);
  const lock = acquirePersonaReleaseLock(paths.releaseRoot, "fixture");
  assert.throws(() => acquirePersonaReleaseLock(paths.releaseRoot, "contender"), /exclusive publication lock/u);
  assert.equal(lock.release(), true);
  assert.equal(lock.release(), false);
});

test("assembly CLI is check-only by default and requires explicit --write", () => {
  const required = [
    "--release-id", "0.9.0-rc.1",
    "--source-root", "/tmp/source",
    "--adjudication-root", "/tmp/adjudication",
    "--trusted-reviewer-keys", "/tmp/reviewer-keys.json",
    "--trusted-formula-reviewer-keys", "/tmp/formula-reviewer-keys.json",
  ];
  const args = parseAssembleArgs(required);
  assert.equal(args.write, false);
  assert.equal(parseAssembleArgs([...required, "--write"]).write, true);
  assert.throws(() => parseAssembleArgs(["--release-id", "x"]), /source-root is required/u);
  assert.throws(
    () => parseAssembleArgs(["--release-id", "x", "--source-root", "/tmp/source"]),
    /adjudication-root is required/u,
  );
});
