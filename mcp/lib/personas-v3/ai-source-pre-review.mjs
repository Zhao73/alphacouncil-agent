/**
 * Machine-only pre-review for archived PersonaPack v3 source candidates.
 *
 * This lane is deliberately separate from source adjudication. It can verify archive
 * integrity and produce role-separated questions, but it cannot create a source anchor,
 * a human attestation, a trusted-reviewer quorum, or any production eligibility.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { defaultKnowledgeDir } from "./admission.mjs";
import { canonicalJson, canonicalValue, sha256 } from "./canonical.mjs";
import { inspectSourceAcquisitions, sha256Bytes } from "./source-acquisition.mjs";
import { CANONICAL_MASTER_IDS, defaultStagingRoot } from "./staging.mjs";
import { defaultPersonaDir } from "../personas/registry.mjs";

const HASH = /^sha256:[a-f0-9]{64}$/u;
const CANDIDATE_ID = /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/u;
const ARTIFACT_FILE = /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]\.json$/u;
const PIPELINE_ID = "alphacouncil_ai_source_prereview_v1";

export const AI_SOURCE_PRE_REVIEW_ROLES = Object.freeze({
  extractor: Object.freeze({
    role_id: "ai_source_extractor_v1",
    prompt_id: "alphacouncil.source-prereview.extractor.v1",
    prompt: [
      "Act only as a machine source-integrity extractor.",
      "Bind observations to the archived bytes and acquisition record supplied in this run.",
      "Do not infer semantic claims, authorship, dates, locators, grades, or method attribution when they were not extracted and verified.",
      "Never claim human review or production approval.",
    ].join(" "),
  }),
  skeptic: Object.freeze({
    role_id: "ai_source_skeptic_v1",
    prompt_id: "alphacouncil.source-prereview.skeptic.v1",
    prompt: [
      "Act independently as a machine source-review skeptic.",
      "Look for missing evidence needed to bind an exact proposition to archived source bytes.",
      "Treat absent semantic extraction, exact locators, publication facts, and attribution as unresolved rather than filling them from model memory.",
      "Never claim human review or production approval.",
    ].join(" "),
  }),
  adjudicator: Object.freeze({
    role_id: "ai_source_adjudicator_v1",
    prompt_id: "alphacouncil.source-prereview.adjudicator.v1",
    prompt: [
      "Act as a machine-only adjudicator of the extractor and skeptic outputs.",
      "Resolve only whether machine pre-review is complete enough for human follow-up; do not convert it into source approval.",
      "Any missing semantic proposition or exact locator requires deferral.",
      "Never sign, impersonate a human, satisfy a human quorum, or grant production effect.",
    ].join(" "),
  }),
});

const TOP_FIELDS = Object.freeze([
  "schema_version", "artifact_kind", "pipeline_id", "reviewer_kind", "assurance_class",
  "human_reviewed", "human_claims", "semantic_review_performed", "method_attribution_approved",
  "production_effect", "persona_id", "candidate_id", "source_binding", "roles",
  "verdict", "disagreement", "open_questions", "machine_limitations", "artifact_hash",
]);
const ROLE_FIELDS = Object.freeze([
  "role", "role_id", "reviewer_kind", "execution_mode", "prompt_id", "prompt_hash",
  "reads_other_role_outputs", "input_role_output_hashes", "input_binding_hash", "verdict",
  "observations", "concerns", "open_questions", "output_hash",
]);
const SOURCE_FIELDS = Object.freeze([
  "record_relative_path", "archive_relative_path", "record_hash", "content_hash", "byte_length",
  "content_type", "retrieved_at", "final_url", "source_bytes_reverified", "format_probe",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inside(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function exactKeys(value, expected, label, errors) {
  if (!isObject(value)) { errors.push(`${label} must be an object`); return false; }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) errors.push(`${label} fields are invalid`);
  return true;
}

function nonEmptyStrings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function formatProbe(bytes, contentType) {
  const head = bytes.subarray(0, Math.min(bytes.length, 4096));
  if (head.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf_magic";
  const text = head.toString("utf8").replace(/^\uFEFF/u, "").trimStart().toLowerCase();
  if (text.startsWith("<!doctype html") || text.startsWith("<html") || text.includes("<html")) return "html_markup";
  if (String(contentType || "").toLowerCase().includes("text/")) return "declared_text_unclassified";
  return "opaque_binary";
}

function roleSubject({
  role, sourceBinding, observations, concerns, openQuestions, verdict,
  inputRoleOutputHashes = [], readsOtherRoleOutputs = false,
}) {
  const contract = AI_SOURCE_PRE_REVIEW_ROLES[role];
  const promptHash = sha256({
    domain: "alphacouncil.ai-source-prereview.prompt.v1",
    prompt_id: contract.prompt_id,
    prompt: contract.prompt,
  });
  const inputBindingHash = sha256({
    domain: "alphacouncil.ai-source-prereview.input.v1",
    role_id: contract.role_id,
    prompt_hash: promptHash,
    record_hash: sourceBinding.record_hash,
    content_hash: sourceBinding.content_hash,
    byte_length: sourceBinding.byte_length,
    input_role_output_hashes: inputRoleOutputHashes,
  });
  return canonicalValue({
    role,
    role_id: contract.role_id,
    reviewer_kind: "ai",
    execution_mode: "deterministic_machine_preflight",
    prompt_id: contract.prompt_id,
    prompt_hash: promptHash,
    reads_other_role_outputs: readsOtherRoleOutputs,
    input_role_output_hashes: inputRoleOutputHashes,
    input_binding_hash: inputBindingHash,
    verdict,
    observations,
    concerns,
    open_questions: openQuestions,
  });
}

function withOutputHash(subject) {
  return canonicalValue({
    ...subject,
    output_hash: sha256({ domain: "alphacouncil.ai-source-prereview.role-output.v1", subject }),
  });
}

function commonOpenQuestions() {
  return [
    "Which exact page, section, filing item, or timestamp supports a proposed method proposition?",
    "Who is the verified author or speaker for that exact passage?",
    "What published_at and public_at values are supported by the archived material?",
  ];
}

function artifactWithoutHash(record, bytes) {
  const sourceBinding = canonicalValue({
    record_relative_path: `personas-v3/${record.persona_id}/acquisitions/candidates/${record.candidate_id}/record.json`,
    archive_relative_path: `personas-v3/${record.persona_id}/${record.archive_path}`,
    record_hash: sha256(record),
    content_hash: record.content_hash,
    byte_length: record.byte_length,
    content_type: record.content_type,
    retrieved_at: record.retrieved_at,
    final_url: record.final_url,
    source_bytes_reverified: sha256Bytes(bytes) === record.content_hash && bytes.length === record.byte_length,
    format_probe: formatProbe(bytes, record.content_type),
  });
  const questions = commonOpenQuestions();
  const extractor = withOutputHash(roleSubject({
    role: "extractor",
    sourceBinding,
    verdict: "archive_integrity_verified_semantics_unreviewed",
    observations: [
      "The archived byte stream matches the acquisition record's content hash and byte length.",
      `The declared content type is ${record.content_type ?? "unknown"}; the deterministic format probe is ${sourceBinding.format_probe}.`,
      "This bootstrap pass did not extract or verify a semantic proposition, authorship claim, date, grade, or exact locator.",
    ],
    concerns: ["Archive integrity alone does not establish method-defining evidence."],
    openQuestions: questions,
  }));
  const skeptic = withOutputHash(roleSubject({
    role: "skeptic",
    sourceBinding,
    verdict: "production_approval_unsupported",
    observations: [
      "The acquisition remains retrieved_unadjudicated.",
      `The acquisition's human_review.status remains ${record.human_review.status}.`,
      "The machine input contains no verified exact locator or proposition-to-passage binding.",
    ],
    concerns: [
      "No exact passage has been bound to a method proposition.",
      "Authorship, publication timing, source grade, and scope remain unresolved in this pre-review.",
    ],
    openQuestions: questions,
  }));
  const priorHashes = [extractor.output_hash, skeptic.output_hash];
  const adjudicator = withOutputHash(roleSubject({
    role: "adjudicator",
    sourceBinding,
    inputRoleOutputHashes: priorHashes,
    readsOtherRoleOutputs: true,
    verdict: "requires_human_review",
    observations: [
      "The extractor established archive integrity but explicitly performed no semantic review.",
      "The skeptic found no verified proposition-to-locator binding for production use.",
      "The two independent first-pass roles agree that machine pre-review cannot approve this source.",
    ],
    concerns: ["Promoting this artifact would confuse machine triage with trusted human source adjudication."],
    openQuestions: questions,
  }));
  return canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_ai_source_prereview",
    pipeline_id: PIPELINE_ID,
    reviewer_kind: "ai",
    assurance_class: "machine_pre_review_only",
    human_reviewed: false,
    human_claims: false,
    semantic_review_performed: false,
    method_attribution_approved: false,
    production_effect: "none",
    persona_id: record.persona_id,
    candidate_id: record.candidate_id,
    source_binding: sourceBinding,
    roles: [extractor, skeptic, adjudicator],
    verdict: "requires_human_review",
    disagreement: {
      present: false,
      role_verdicts: [extractor.verdict, skeptic.verdict, adjudicator.verdict],
      explanation: "The roles have different scopes but agree that no source approval or method attribution is established.",
    },
    open_questions: questions,
    machine_limitations: [
      "This artifact is deterministic machine triage, not an independent human review.",
      "It does not contain a verified semantic extraction or exact source locator.",
      "It is unsigned, cannot enter a trusted reviewer registry, and cannot satisfy source-review quorum.",
    ],
  });
}

export function buildAiSourcePreReviewArtifact({ record, bytes }) {
  if (!isObject(record)) throw new Error("source acquisition record is required");
  if (!Buffer.isBuffer(bytes)) throw new Error("archived source bytes must be a Buffer");
  if (sha256Bytes(bytes) !== record.content_hash || bytes.length !== record.byte_length) {
    throw new Error(`${record.persona_id}/${record.candidate_id}: archived bytes do not match acquisition record`);
  }
  const subject = artifactWithoutHash(record, bytes);
  return Object.freeze(canonicalValue({
    ...subject,
    artifact_hash: sha256({ domain: "alphacouncil.ai-source-prereview.artifact.v1", subject }),
  }));
}

export function aiSourcePreReviewArtifactHash(artifact) {
  if (!isObject(artifact)) return null;
  const { artifact_hash: ignored, ...subject } = artifact;
  return sha256({ domain: "alphacouncil.ai-source-prereview.artifact.v1", subject: canonicalValue(subject) });
}

export function validateAiSourcePreReviewArtifact(artifact, { record, bytes } = {}) {
  const errors = [];
  if (!exactKeys(artifact, TOP_FIELDS, "AI source pre-review", errors)) return errors;
  if (artifact.schema_version !== 1) errors.push("AI source pre-review.schema_version must be 1");
  if (artifact.artifact_kind !== "persona_v3_ai_source_prereview") errors.push("AI source pre-review.artifact_kind is invalid");
  if (artifact.pipeline_id !== PIPELINE_ID) errors.push("AI source pre-review.pipeline_id is invalid");
  if (artifact.reviewer_kind !== "ai") errors.push("AI source pre-review.reviewer_kind must be ai");
  if (artifact.assurance_class !== "machine_pre_review_only") errors.push("AI source pre-review.assurance_class is invalid");
  for (const field of ["human_reviewed", "human_claims", "semantic_review_performed", "method_attribution_approved"]) {
    if (artifact[field] !== false) errors.push(`AI source pre-review.${field} must remain false`);
  }
  if (artifact.production_effect !== "none") errors.push("AI source pre-review.production_effect must be none");
  if (!CANONICAL_MASTER_IDS.includes(artifact.persona_id)) errors.push("AI source pre-review.persona_id is invalid");
  if (!CANDIDATE_ID.test(artifact.candidate_id || "")) errors.push("AI source pre-review.candidate_id is invalid");
  if (!exactKeys(artifact.source_binding, SOURCE_FIELDS, "AI source pre-review.source_binding", errors)) return errors;
  if (!HASH.test(artifact.source_binding.content_hash || "") || !HASH.test(artifact.source_binding.record_hash || "")) {
    errors.push("AI source pre-review source hashes are invalid");
  }
  if (artifact.source_binding.source_bytes_reverified !== true) errors.push("AI source pre-review must reverify archived bytes");
  if (!Array.isArray(artifact.roles) || artifact.roles.length !== 3) errors.push("AI source pre-review must contain exactly three role outputs");
  else {
    const expectedRoles = ["extractor", "skeptic", "adjudicator"];
    const roleIds = new Set();
    const promptHashes = new Set();
    for (const [index, role] of artifact.roles.entries()) {
      if (!exactKeys(role, ROLE_FIELDS, `AI source pre-review.roles[${index}]`, errors)) continue;
      if (role.role !== expectedRoles[index]) errors.push(`AI source pre-review.roles[${index}].role is invalid`);
      if (role.reviewer_kind !== "ai") errors.push(`AI source pre-review.roles[${index}].reviewer_kind must be ai`);
      if (role.execution_mode !== "deterministic_machine_preflight") errors.push(`AI source pre-review.roles[${index}].execution_mode is invalid`);
      const contract = AI_SOURCE_PRE_REVIEW_ROLES[role.role];
      if (!contract || role.role_id !== contract.role_id || role.prompt_id !== contract.prompt_id) {
        errors.push(`AI source pre-review.roles[${index}] does not match its registered role contract`);
      } else {
        const expectedPromptHash = sha256({
          domain: "alphacouncil.ai-source-prereview.prompt.v1",
          prompt_id: contract.prompt_id,
          prompt: contract.prompt,
        });
        if (role.prompt_hash !== expectedPromptHash) errors.push(`AI source pre-review.roles[${index}].prompt_hash is invalid`);
      }
      for (const field of ["prompt_hash", "input_binding_hash", "output_hash"]) {
        if (!HASH.test(role[field] || "")) errors.push(`AI source pre-review.roles[${index}].${field} is invalid`);
      }
      for (const field of ["observations", "concerns", "open_questions"]) {
        if (!nonEmptyStrings(role[field])) errors.push(`AI source pre-review.roles[${index}].${field} must contain non-empty strings`);
      }
      if (!Array.isArray(role.input_role_output_hashes)
        || !role.input_role_output_hashes.every((hash) => HASH.test(hash))) {
        errors.push(`AI source pre-review.roles[${index}].input_role_output_hashes is invalid`);
      }
      const expectedInputBindingHash = sha256({
        domain: "alphacouncil.ai-source-prereview.input.v1",
        role_id: role.role_id,
        prompt_hash: role.prompt_hash,
        record_hash: artifact.source_binding.record_hash,
        content_hash: artifact.source_binding.content_hash,
        byte_length: artifact.source_binding.byte_length,
        input_role_output_hashes: role.input_role_output_hashes,
      });
      if (role.input_binding_hash !== expectedInputBindingHash) errors.push(`AI source pre-review.roles[${index}].input_binding_hash is invalid`);
      const { output_hash: ignoredOutputHash, ...outputSubject } = role;
      const expectedOutputHash = sha256({
        domain: "alphacouncil.ai-source-prereview.role-output.v1",
        subject: canonicalValue(outputSubject),
      });
      if (role.output_hash !== expectedOutputHash) errors.push(`AI source pre-review.roles[${index}].output_hash is invalid`);
      roleIds.add(role.role_id);
      promptHashes.add(role.prompt_hash);
    }
    if (roleIds.size !== 3) errors.push("AI source pre-review role IDs must be distinct");
    if (promptHashes.size !== 3) errors.push("AI source pre-review role prompts must be distinct");
    if (artifact.roles[0].reads_other_role_outputs !== false || artifact.roles[0].input_role_output_hashes.length !== 0
      || artifact.roles[1].reads_other_role_outputs !== false || artifact.roles[1].input_role_output_hashes.length !== 0) {
      errors.push("AI extractor and skeptic must remain independent of other role outputs");
    }
    if (artifact.roles[2].reads_other_role_outputs !== true
      || canonicalJson(artifact.roles[2].input_role_output_hashes)
        !== canonicalJson([artifact.roles[0].output_hash, artifact.roles[1].output_hash])) {
      errors.push("AI adjudicator must bind the extractor and skeptic output hashes in order");
    }
  }
  if (artifact.verdict !== "requires_human_review") errors.push("AI source pre-review.verdict must require human review");
  if (!exactKeys(artifact.disagreement, ["present", "role_verdicts", "explanation"], "AI source pre-review.disagreement", errors)
    || typeof artifact.disagreement.present !== "boolean"
    || !nonEmptyStrings(artifact.disagreement.role_verdicts) || typeof artifact.disagreement.explanation !== "string") {
    errors.push("AI source pre-review.disagreement is invalid");
  }
  if (!nonEmptyStrings(artifact.open_questions)) errors.push("AI source pre-review.open_questions are required");
  if (!nonEmptyStrings(artifact.machine_limitations)) errors.push("AI source pre-review.machine_limitations are required");
  if (!HASH.test(artifact.artifact_hash || "") || aiSourcePreReviewArtifactHash(artifact) !== artifact.artifact_hash) {
    errors.push("AI source pre-review.artifact_hash is invalid");
  }
  if (record && bytes) {
    try {
      const expected = buildAiSourcePreReviewArtifact({ record, bytes });
      if (canonicalJson(expected) !== canonicalJson(artifact)) errors.push("AI source pre-review differs from deterministic source-bound output");
    } catch (error) {
      errors.push(error.message);
    }
  }
  return errors;
}

export function defaultAiSourcePreReviewRoot({ stagingRoot = defaultStagingRoot() } = {}) {
  return process.env.ALPHACOUNCIL_AI_SOURCE_PREREVIEW_DIR
    || resolve(dirname(dirname(stagingRoot)), "ai-assisted-solo", "reviews", "persona-v3-ai-source-prereviews");
}

function expectedPreReviews({ root, productionRoot, personaDir, now }) {
  const inventory = inspectSourceAcquisitions({ root, productionRoot, personaDir, now });
  const entries = [];
  for (const seat of inventory.personas) {
    for (const record of seat.records) {
      const archive = join(root, record.persona_id, record.archive_path);
      const bytes = readFileSync(archive);
      entries.push({
        persona_id: record.persona_id,
        candidate_id: record.candidate_id,
        record,
        bytes,
        artifact: buildAiSourcePreReviewArtifact({ record, bytes }),
      });
    }
  }
  entries.sort((a, b) => `${a.persona_id}/${a.candidate_id}`.localeCompare(`${b.persona_id}/${b.candidate_id}`));
  return { inventory, entries };
}

function indexSubject(entries) {
  const personas = CANONICAL_MASTER_IDS.map((personaId) => ({
    persona_id: personaId,
    candidate_count: entries.filter((entry) => entry.persona_id === personaId).length,
  }));
  return canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_ai_source_prereview_index",
    reviewer_kind: "ai",
    assurance_class: "machine_pre_review_only",
    human_reviewed_count: 0,
    human_claim_count: 0,
    production_effect: "none",
    canonical_master_count: CANONICAL_MASTER_IDS.length,
    seats_with_candidates: personas.filter((seat) => seat.candidate_count > 0).length,
    candidate_count: entries.length,
    role_output_count: entries.length * 3,
    verdict_counts: { requires_human_review: entries.length },
    personas,
    artifacts: entries.map((entry) => ({
      persona_id: entry.persona_id,
      candidate_id: entry.candidate_id,
      relative_path: `${entry.persona_id}/${entry.candidate_id}.json`,
      content_hash: entry.record.content_hash,
      artifact_hash: entry.artifact.artifact_hash,
    })),
  });
}

export function buildAiSourcePreReviewIndex(entries) {
  const subject = indexSubject(entries);
  return canonicalValue({
    ...subject,
    index_hash: sha256({ domain: "alphacouncil.ai-source-prereview.index.v1", subject }),
  });
}

function safeReadJson(file, errors) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { errors.push(`${file}: invalid JSON (${error.message})`); return null; }
}

function physicalDirectory(path, label, errors) {
  if (!existsSync(path)) { errors.push(`${label} is missing`); return false; }
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory()) {
    errors.push(`${label} must be a physical directory`);
    return false;
  }
  return true;
}

export function inspectAiSourcePreReviews({
  root = defaultStagingRoot(),
  preReviewRoot = defaultAiSourcePreReviewRoot({ stagingRoot: root }),
  productionRoot = defaultKnowledgeDir(),
  personaDir = defaultPersonaDir(),
  now = new Date(),
} = {}) {
  const errors = [];
  const expected = expectedPreReviews({ root, productionRoot, personaDir, now });
  const expectedIndex = buildAiSourcePreReviewIndex(expected.entries);
  if (inside(resolve(productionRoot), resolve(preReviewRoot))) errors.push("AI pre-review root must not be inside production knowledge");
  if (!physicalDirectory(preReviewRoot, "AI pre-review root", errors)) {
    return canonicalValue({ valid: false, candidate_count: expected.entries.length, valid_artifact_count: 0, errors });
  }
  const allowedSeats = new Set(expected.entries.map((entry) => entry.persona_id));
  for (const item of readdirSync(preReviewRoot, { withFileTypes: true })) {
    if (item.name === "index.json" && item.isFile()) continue;
    if (!allowedSeats.has(item.name) || !item.isDirectory() || item.isSymbolicLink()) {
      errors.push(`${item.name}: unexpected or unsafe AI pre-review artifact`);
    }
  }
  let validArtifactCount = 0;
  const expectedFilesBySeat = new Map();
  for (const entry of expected.entries) {
    if (!expectedFilesBySeat.has(entry.persona_id)) expectedFilesBySeat.set(entry.persona_id, new Set());
    expectedFilesBySeat.get(entry.persona_id).add(`${entry.candidate_id}.json`);
  }
  for (const [personaId, expectedFiles] of expectedFilesBySeat) {
    const seatDir = join(preReviewRoot, personaId);
    if (!physicalDirectory(seatDir, personaId, errors)) continue;
    for (const item of readdirSync(seatDir, { withFileTypes: true })) {
      if (!expectedFiles.has(item.name) || !ARTIFACT_FILE.test(item.name)
        || !item.isFile() || item.isSymbolicLink()) {
        errors.push(`${personaId}/${item.name}: unexpected or unsafe AI pre-review artifact`);
      }
    }
  }
  for (const entry of expected.entries) {
    const seatDir = join(preReviewRoot, entry.persona_id);
    const file = join(seatDir, `${entry.candidate_id}.json`);
    if (!existsSync(seatDir) || lstatSync(seatDir).isSymbolicLink() || !statSync(seatDir).isDirectory()) continue;
    if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) {
      errors.push(`${entry.persona_id}/${entry.candidate_id}.json is missing or unsafe`);
      continue;
    }
    const artifact = safeReadJson(file, errors);
    if (!artifact) continue;
    const validation = validateAiSourcePreReviewArtifact(artifact, { record: entry.record, bytes: entry.bytes });
    errors.push(...validation.map((error) => `${entry.persona_id}/${entry.candidate_id}: ${error}`));
    if (!validation.length) validArtifactCount += 1;
  }
  const indexFile = join(preReviewRoot, "index.json");
  const index = existsSync(indexFile) && !lstatSync(indexFile).isSymbolicLink() && statSync(indexFile).isFile()
    ? safeReadJson(indexFile, errors) : null;
  if (!index) errors.push("index.json is missing or unsafe");
  else if (canonicalJson(index) !== canonicalJson(expectedIndex)) errors.push("index.json differs from deterministic source-bound inventory");
  return canonicalValue({
    valid: errors.length === 0,
    root: resolve(preReviewRoot),
    canonical_master_count: CANONICAL_MASTER_IDS.length,
    seats_with_candidates: new Set(expected.entries.map((entry) => entry.persona_id)).size,
    candidate_count: expected.entries.length,
    valid_artifact_count: validArtifactCount,
    role_output_count: validArtifactCount * 3,
    human_reviewed_count: 0,
    human_claim_count: 0,
    production_write_count: 0,
    index_hash: expectedIndex.index_hash,
    errors,
  });
}

export function writeAiSourcePreReviews({
  root = defaultStagingRoot(),
  preReviewRoot = defaultAiSourcePreReviewRoot({ stagingRoot: root }),
  productionRoot = defaultKnowledgeDir(),
  personaDir = defaultPersonaDir(),
  now = new Date(),
} = {}) {
  const expected = expectedPreReviews({ root, productionRoot, personaDir, now });
  const output = resolve(preReviewRoot);
  const production = existsSync(productionRoot) ? realpathSync(productionRoot) : resolve(productionRoot);
  if (inside(production, output)) throw new Error("AI pre-review root must not be inside production knowledge");
  if (existsSync(output) && (lstatSync(output).isSymbolicLink() || !statSync(output).isDirectory())) {
    throw new Error("AI pre-review root must be a physical directory");
  }
  mkdirSync(output, { recursive: true });
  let wrote = 0;
  for (const entry of expected.entries) {
    const seatDir = join(output, entry.persona_id);
    if (existsSync(seatDir) && (lstatSync(seatDir).isSymbolicLink() || !statSync(seatDir).isDirectory())) {
      throw new Error(`${entry.persona_id}: AI pre-review seat path is unsafe`);
    }
    mkdirSync(seatDir, { recursive: true });
    const file = join(seatDir, `${entry.candidate_id}.json`);
    const serialized = `${JSON.stringify(entry.artifact, null, 2)}\n`;
    if (existsSync(file)) {
      if (lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) throw new Error(`${file}: unsafe artifact path`);
      if (readFileSync(file, "utf8") !== serialized) throw new Error(`${file}: existing artifact differs; refusing overwrite`);
    } else {
      writeFileSync(file, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      wrote += 1;
    }
  }
  const index = buildAiSourcePreReviewIndex(expected.entries);
  const indexFile = join(output, "index.json");
  const serializedIndex = `${JSON.stringify(index, null, 2)}\n`;
  if (existsSync(indexFile)) {
    if (lstatSync(indexFile).isSymbolicLink() || !statSync(indexFile).isFile()) throw new Error(`${indexFile}: unsafe index path`);
    if (readFileSync(indexFile, "utf8") !== serializedIndex) throw new Error(`${indexFile}: existing index differs; refusing overwrite`);
  } else {
    writeFileSync(indexFile, serializedIndex, { encoding: "utf8", flag: "wx", mode: 0o600 });
    wrote += 1;
  }
  const report = inspectAiSourcePreReviews({ root, preReviewRoot: output, productionRoot, personaDir, now });
  if (!report.valid) throw new Error(`written AI source pre-reviews failed validation:\n- ${report.errors.join("\n- ")}`);
  return canonicalValue({ ...report, wrote_file_count: wrote });
}
