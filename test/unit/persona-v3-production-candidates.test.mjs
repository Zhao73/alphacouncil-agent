import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import buildInventory from "../../data/persona-v3-build-specs.v1.mjs";
import { formulaApprovalEvidenceRelativePath } from "../../mcp/lib/personas-v3/formula-review-attestations.mjs";
import {
  inspectPersonaV3ProductionCandidates,
  PersonaV3ProductionCandidateError,
  PRODUCTION_CANDIDATE_DIRNAME,
} from "../../scripts/lib/persona-v3-production-candidates.mjs";
import {
  compileApprovedFormulaSpec,
  planPersonaV3FormulaPipeline,
} from "../../scripts/lib/persona-v3-formula-pipeline.mjs";
import { parseArgs } from "../../scripts/check-persona-v3-production-candidates.mjs";
import {
  TRUSTED_FORMULA_REVIEW_KEYS,
  approvedFormulaSpec,
  signedFormulaApprovalBundle,
} from "../helpers/persona-v3-formula-review-evidence.mjs";
import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";
import { PLANNED_TOOL_COUNT } from "../../data/persona-v3-build-specs.v1.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts/check-persona-v3-production-candidates.mjs");
const HASH = `sha256:${"a".repeat(64)}`;

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-production-candidates-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const staging = join(dir, "staging");
  const candidateRoot = join(staging, PRODUCTION_CANDIDATE_DIRNAME);
  const productionRoot = join(dir, "production");
  mkdirSync(staging);
  mkdirSync(productionRoot);
  return { dir, staging, candidateRoot, productionRoot };
}

function fakeDependencies({ admission = "candidate", extraTool = false, duplicateTool = false, toolsByPersona = null } = {}) {
  const expectedTools = new Map(buildInventory.seats.map((seat) => [
    seat.persona_id,
    seat.planned_dedicated_tools.map((tool) => tool.tool_id),
  ]));
  return {
    loadPack(packDir) {
      const personaId = basename(packDir);
      const approved = toolsByPersona?.get(personaId);
      if (approved) {
        const tools = [...approved];
        if (extraTool && personaId === buildInventory.seats[0].persona_id) tools.push({ ...tools[0], id: `${personaId}.additional_candidate_tool` });
        if (duplicateTool && personaId === buildInventory.seats[0].persona_id) tools.push({ ...tools[0] });
        return { components: { tools } };
      }
      const ids = [...expectedTools.get(personaId)];
      if (extraTool && personaId === buildInventory.seats[0].persona_id) {
        ids.push(`${personaId}.additional_candidate_tool`);
      }
      return { components: { tools: ids.map((id) => ({ id })) } };
    },
    compilePack() {
      return {
        pack_hash: HASH,
        corpus_hash: HASH,
        policy_hash: HASH,
        tool_graph_hash: HASH,
        prompt_hash: HASH,
      };
    },
    inspectAdmission() {
      return {
        admission_level: admission,
        operational_clear: true,
        candidate_clear: admission !== "operational",
        method_model_ready: admission === "method_model",
        source_anchor_errors: [],
        delta_to_operational: {},
        delta_to_candidate: admission === "operational" ? { propositions: 15 } : {},
      };
    },
  };
}

function installApprovedFormulaEvidence(candidateRoot) {
  const toolsByPersona = new Map(buildInventory.seats.map((seat) => [seat.persona_id, []]));
  for (const entry of planPersonaV3FormulaPipeline().inventory.entries) {
    const spec = approvedFormulaSpec(entry);
    const bundle = signedFormulaApprovalBundle(spec);
    const prototypeDocument = JSON.parse(readFileSync(join(REPO_ROOT, spec.prototype_provenance.source_path), "utf8"));
    const tool = compileApprovedFormulaSpec(spec, {
      prototypeDocument,
      approvalBundle: bundle,
      trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
      now: new Date("2026-07-27T12:00:00.000Z"),
    });
    toolsByPersona.get(entry.persona_id).push(tool);
    const evidenceFile = join(candidateRoot, entry.persona_id,
      formulaApprovalEvidenceRelativePath(entry.persona_id, entry.tool_id));
    mkdirSync(join(evidenceFile, ".."), { recursive: true });
    writeFileSync(evidenceFile, `${JSON.stringify(bundle, null, 2)}\n`);
  }
  return toolsByPersona;
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

test("a missing isolated candidate tree reports zero without creating files", (t) => {
  const paths = workspace(t);
  const report = inspectPersonaV3ProductionCandidates({
    root: paths.candidateRoot,
    productionRoot: paths.productionRoot,
  });

  assert.equal(report.candidate_root_exists, false);
  assert.deepEqual(report.summary, {
    physical_candidate_count: 0,
    loader_valid_count: 0,
    operational_candidate_count: 0,
    candidate_admission_count: 0,
    method_model_count: 0,
    planned_tool_coverage_count: 0,
    formula_approval_evidence_count: 0,
    missing_physical_candidate_count: CANONICAL_MASTER_COUNT,
    missing_planned_tool_count: PLANNED_TOOL_COUNT,
    missing_formula_approval_evidence_count: PLANNED_TOOL_COUNT,
    gate_clear: false,
    release_assembled: false,
    production_promoted: false,
  });
  assert.equal(report.production_effect, "none");
  assert.equal(existsSync(paths.candidateRoot), false);
  assert.deepEqual(readdirSync(paths.staging), []);
});

test("the gate requires every canonical seat physical packs and every planned tool planned tools", (t) => {
  const paths = workspace(t);
  mkdirSync(paths.candidateRoot);
  for (const seat of buildInventory.seats) mkdirSync(join(paths.candidateRoot, seat.persona_id));
  const toolsByPersona = installApprovedFormulaEvidence(paths.candidateRoot);

  const report = inspectPersonaV3ProductionCandidates({
    root: paths.candidateRoot,
    productionRoot: paths.productionRoot,
    requiredAdmission: "candidate",
    ...fakeDependencies({ admission: "candidate", toolsByPersona }),
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
    now: new Date("2026-07-27T12:00:00.000Z"),
  });

  assert.equal(report.summary.physical_candidate_count, CANONICAL_MASTER_COUNT);
  assert.equal(report.summary.candidate_admission_count, CANONICAL_MASTER_COUNT);
  assert.equal(report.summary.planned_tool_coverage_count, PLANNED_TOOL_COUNT);
  assert.equal(report.summary.formula_approval_evidence_count, PLANNED_TOOL_COUNT);
  assert.equal(report.summary.gate_clear, true);
  assert.equal(report.summary.release_assembled, false);
  assert.equal(report.summary.production_promoted, false);
  assert.deepEqual(report.seats[0].unexpected_tool_ids, []);
});

test("duplicates, extras and missing or replayed formula evidence fail the exact planned-tool gate", (t) => {
  const paths = workspace(t);
  mkdirSync(paths.candidateRoot);
  for (const seat of buildInventory.seats) mkdirSync(join(paths.candidateRoot, seat.persona_id));
  const toolsByPersona = installApprovedFormulaEvidence(paths.candidateRoot);
  for (const mutation of [{ extraTool: true }, { duplicateTool: true }]) {
    const report = inspectPersonaV3ProductionCandidates({
      root: paths.candidateRoot,
      productionRoot: paths.productionRoot,
      requiredAdmission: "candidate",
      ...fakeDependencies({ admission: "candidate", toolsByPersona, ...mutation }),
      trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
      now: new Date("2026-07-27T12:00:00.000Z"),
    });
    assert.equal(report.summary.gate_clear, false);
  }

  const first = planPersonaV3FormulaPipeline().inventory.entries[0];
  const second = planPersonaV3FormulaPipeline().inventory.entries[1];
  const from = join(paths.candidateRoot, first.persona_id,
    formulaApprovalEvidenceRelativePath(first.persona_id, first.tool_id));
  const to = join(paths.candidateRoot, second.persona_id,
    formulaApprovalEvidenceRelativePath(second.persona_id, second.tool_id));
  writeFileSync(to, readFileSync(from));
  const replay = inspectPersonaV3ProductionCandidates({
    root: paths.candidateRoot,
    productionRoot: paths.productionRoot,
    requiredAdmission: "candidate",
    ...fakeDependencies({ admission: "candidate", toolsByPersona }),
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
    now: new Date("2026-07-27T12:00:00.000Z"),
  });
  assert.equal(replay.summary.gate_clear, false);
  assert.ok(replay.summary.formula_approval_evidence_count < PLANNED_TOOL_COUNT);
});

test("a loader failure remains a visible invalid physical candidate", (t) => {
  const paths = workspace(t);
  const personaId = buildInventory.seats[0].persona_id;
  mkdirSync(join(paths.candidateRoot, personaId), { recursive: true });
  const report = inspectPersonaV3ProductionCandidates({
    root: paths.candidateRoot,
    productionRoot: paths.productionRoot,
    loadPack() { throw new Error("fixture load failure"); },
  });
  const seat = report.seats.find((item) => item.persona_id === personaId);

  assert.equal(report.summary.physical_candidate_count, 1);
  assert.equal(report.summary.loader_valid_count, 0);
  assert.equal(report.summary.gate_clear, false);
  assert.equal(seat.status, "invalid_physical_candidate");
  assert.deepEqual(seat.errors, [{ name: "Error", message: "fixture load failure" }]);
});

test("candidate inspection rejects overlap with the production knowledge root", (t) => {
  const paths = workspace(t);
  mkdirSync(paths.candidateRoot);
  assert.throws(() => inspectPersonaV3ProductionCandidates({
    root: paths.candidateRoot,
    productionRoot: paths.candidateRoot,
  }), PersonaV3ProductionCandidateError);
});

test("a lexical staging path cannot escape through a symlinked ancestor", {
  skip: process.platform === "win32",
}, (t) => {
  const paths = workspace(t);
  const linkedParent = join(paths.dir, "linked");
  const outside = join(paths.dir, "outside");
  mkdirSync(linkedParent);
  mkdirSync(outside);
  symlinkSync(outside, join(linkedParent, "staging"));
  const escapedRoot = join(linkedParent, "staging", PRODUCTION_CANDIDATE_DIRNAME);
  mkdirSync(escapedRoot);

  assert.throws(() => inspectPersonaV3ProductionCandidates({
    root: escapedRoot,
    productionRoot: paths.productionRoot,
  }), /physically resolve below a staging directory/u);
});

test("a broken candidate-root symlink is unsafe rather than an empty tree", {
  skip: process.platform === "win32",
}, (t) => {
  const paths = workspace(t);
  symlinkSync(join(paths.dir, "missing-target"), paths.candidateRoot);
  assert.throws(() => inspectPersonaV3ProductionCandidates({
    root: paths.candidateRoot,
    productionRoot: paths.productionRoot,
  }), /candidate root must be a plain directory/u);
});

test("CLI check is read-only while gate fails closed for an empty tree", (t) => {
  const paths = workspace(t);
  const checked = run(["--check", "--json", "--root", paths.candidateRoot]);
  assert.equal(checked.status, 0, checked.stderr);
  const report = JSON.parse(checked.stdout);
  assert.equal(report.summary.physical_candidate_count, 0);
  assert.equal(report.summary.gate_clear, false);
  assert.equal(report.summary.release_assembled, false);
  assert.equal(report.summary.production_promoted, false);
  assert.equal(existsSync(paths.candidateRoot), false);

  const gated = run(["--gate", "--root", paths.candidateRoot]);
  assert.equal(gated.status, 1, gated.stderr);
  assert.match(gated.stdout, new RegExp(`Physical candidates: 0/${CANONICAL_MASTER_COUNT}`, "u"));
  assert.match(gated.stdout, /Gate clear: false/u);
  assert.equal(existsSync(paths.candidateRoot), false);
});

test("CLI argument parsing keeps inspection and admission gates explicit", () => {
  assert.deepEqual(parseArgs(["--json", "--gate", "--require-admission", "method_model"]), {
    root: null,
    personaDir: null,
    requireAdmission: "method_model",
    trustedFormulaReviewerKeysFile: null,
    gate: true,
    json: true,
    help: false,
  });
  assert.throws(() => parseArgs(["--root"]), /requires a value/u);
  assert.throws(() => parseArgs(["--unknown"]), /unknown argument/u);
});
