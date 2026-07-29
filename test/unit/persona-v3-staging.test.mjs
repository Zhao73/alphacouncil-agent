import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadV3Packs } from "../../mcp/lib/personas-v3/loader.mjs";
import {
  CANONICAL_MASTER_COUNT,
  CANONICAL_MASTER_IDS,
  canonicalMasterBlueprints,
  inspectPersonaV3Staging,
  scaffoldPersonaV3Staging,
} from "../../mcp/lib/personas-v3/staging.mjs";

const ZERO_HASH = `sha256:${"0".repeat(64)}`;

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-v3-staging-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stagingRoot = join(dir, "staging");
  const productionRoot = join(dir, "production");
  mkdirSync(productionRoot);
  return { dir, stagingRoot, productionRoot };
}

function stagingOptions(paths) {
  return { root: paths.stagingRoot, productionRoot: paths.productionRoot };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sourceAnchor(personaId, status = "pending") {
  return {
    schema_version: 1,
    source_id: `${personaId}:source:01`,
    source_kind: "primary_text",
    grade: "A",
    author: "A real source author",
    title: "A retrieved primary method document",
    url: "https://example.test/primary-method-document",
    published_at: "2020-01-01",
    public_at: "2020-01-01",
    known_at: "2020-01-01",
    retrieved_at: "2026-07-27",
    locator: { section: "Decision method" },
    summary: "A reviewable paraphrase of one method proposition in the retrieved document.",
    content_hash: ZERO_HASH,
    supports: [],
    adjudication: {
      status,
      reviewer_ids: status === "approved" ? ["reviewer-a", "reviewer-b"] : [],
      reviewed_at: status === "approved" ? "2026-07-27" : null,
      notes: "",
    },
  };
}

test("the staging roster is an explicit exact match for the canonical master personas", () => {
  const blueprints = canonicalMasterBlueprints();
  assert.equal(CANONICAL_MASTER_IDS.length, CANONICAL_MASTER_COUNT);
  assert.equal(blueprints.length, CANONICAL_MASTER_COUNT);
  assert.deepEqual(blueprints.map((persona) => persona.persona_id), [...CANONICAL_MASTER_IDS]);
  assert.equal(new Set(CANONICAL_MASTER_IDS).size, CANONICAL_MASTER_COUNT);
});

test("factory creates the non-runnable scaffolds and is idempotent without overwriting", (t) => {
  const paths = workspace(t);
  const first = scaffoldPersonaV3Staging(stagingOptions(paths));
  assert.equal(first.canonical_master_count, CANONICAL_MASTER_COUNT);
  // index + two templates + one scaffold and one empty queue per seat.
  assert.equal(first.created.length, 3 + CANONICAL_MASTER_COUNT * 2);
  assert.equal(first.existing.length, 0);

  for (const id of CANONICAL_MASTER_IDS) {
    assert.equal(existsSync(join(paths.stagingRoot, id, "scaffold.json")), true);
    assert.equal(existsSync(join(paths.stagingRoot, id, "source-adjudication-queue.json")), true);
    assert.equal(existsSync(join(paths.stagingRoot, id, "manifest.json")), false);
    const scaffold = readJson(join(paths.stagingRoot, id, "scaffold.json"));
    assert.equal(scaffold.production_guard.production_eligible, false);
    assert.equal(scaffold.production_guard.registry_registration_allowed, false);
    assert.deepEqual(scaffold.production_guard.release_approvals, []);
    assert.equal(Object.hasOwn(scaffold, "maturity"), false);
    assert.equal(Object.hasOwn(scaffold, "admission"), false);
  }

  const second = scaffoldPersonaV3Staging(stagingOptions(paths));
  assert.equal(second.created.length, 0);
  assert.equal(second.existing.length, 3 + CANONICAL_MASTER_COUNT * 2);

  const report = inspectPersonaV3Staging(stagingOptions(paths));
  assert.equal(report.invalid_count, 0);
  assert.equal(report.unsafe_artifact_count, 0);
  assert.equal(report.production_eligible_count, 0);
  assert.equal(report.physical_v3_pack_count, 0);
  assert.deepEqual(report.phases, { scaffolded: CANONICAL_MASTER_COUNT });

  // Staging is a sibling tree. The production loader sees no v3 pack from it.
  const production = loadV3Packs({ dir: paths.productionRoot });
  assert.equal(production.packs.length, 0);
  assert.equal(production.legacy_ids.length, 0);
});

test("factory refuses staging within production or production within staging", (t) => {
  const paths = workspace(t);
  assert.throws(() => scaffoldPersonaV3Staging({
    root: join(paths.productionRoot, "staging"),
    productionRoot: paths.productionRoot,
  }), /physically disjoint/);
  const outerStaging = join(paths.dir, "outer-staging");
  mkdirSync(outerStaging);
  assert.throws(() => scaffoldPersonaV3Staging({
    root: outerStaging,
    productionRoot: join(outerStaging, "production"),
  }), /physically disjoint/);
});

test("a production manifest or self-promotion claim makes staging invalid", (t) => {
  const paths = workspace(t);
  scaffoldPersonaV3Staging(stagingOptions(paths));
  const id = CANONICAL_MASTER_IDS[0];
  writeJson(join(paths.stagingRoot, id, "manifest.json"), { schema_version: 3 });
  let report = inspectPersonaV3Staging(stagingOptions(paths));
  assert.equal(report.unsafe_artifact_count, 1);
  assert.match(report.global_errors.join("\n"), /production_manifest is forbidden/);

  rmSync(join(paths.stagingRoot, id, "manifest.json"));
  const scaffoldFile = join(paths.stagingRoot, id, "scaffold.json");
  const scaffold = readJson(scaffoldFile);
  scaffold.production_guard.production_eligible = true;
  writeJson(scaffoldFile, scaffold);
  report = inspectPersonaV3Staging(stagingOptions(paths));
  assert.equal(report.invalid_count, 1);
  assert.match(report.personas[0].errors.join("\n"), /production_eligible must remain false/);
  assert.equal(report.production_eligible_count, 0);
});

test("source queues distinguish pending work from genuinely dual-reviewed method material", (t) => {
  const paths = workspace(t);
  scaffoldPersonaV3Staging(stagingOptions(paths));
  const id = CANONICAL_MASTER_IDS[0];
  const queueFile = join(paths.stagingRoot, id, "source-adjudication-queue.json");
  const queue = readJson(queueFile);
  queue.records.push(sourceAnchor(id, "pending"));
  writeJson(queueFile, queue);

  let report = inspectPersonaV3Staging(stagingOptions(paths));
  let seat = report.personas.find((persona) => persona.persona_id === id);
  assert.equal(seat.phase, "source_adjudication");
  assert.deepEqual(seat.source_counts, { total: 1, pending: 1, approved: 0, rejected: 0, method_defining: 0 });

  queue.records = [sourceAnchor(id, "approved")];
  writeJson(queueFile, queue);
  report = inspectPersonaV3Staging(stagingOptions(paths));
  seat = report.personas.find((persona) => persona.persona_id === id);
  assert.equal(seat.errors.length, 0);
  assert.equal(seat.source_counts.approved, 1);
  assert.equal(seat.source_counts.method_defining, 1);
  assert.equal(seat.production_eligible, false);
});

test("duplicate content hashes cannot inflate independent staging source progress", (t) => {
  const paths = workspace(t);
  scaffoldPersonaV3Staging(stagingOptions(paths));
  const id = CANONICAL_MASTER_IDS[0];
  const queueFile = join(paths.stagingRoot, id, "source-adjudication-queue.json");
  const first = sourceAnchor(id, "approved");
  const second = { ...sourceAnchor(id, "approved"), source_id: `${id}:source:02` };
  const queue = readJson(queueFile);
  queue.records = [first, second];
  writeJson(queueFile, queue);
  const report = inspectPersonaV3Staging(stagingOptions(paths));
  const seat = report.personas.find((persona) => persona.persona_id === id);
  assert.equal(seat.phase, "invalid");
  assert.match(seat.errors.join("\n"), /duplicate content_hash/);
  assert.equal(seat.source_counts.method_defining, 1);
});
