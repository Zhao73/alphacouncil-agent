/** Round-2, machine-only skeptic review of round-1 semantic source extractions. */

import { CANONICAL_MASTER_COUNT } from "./staging.mjs";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { SEMANTIC_SOURCE_SKEPTIC_REVIEW_CATALOG } from "../../../data/persona-v3-semantic-skeptic-reviews.v1.mjs";
import { defaultKnowledgeDir } from "./admission.mjs";
import { canonicalJson, canonicalValue, sha256 } from "./canonical.mjs";
import {
  defaultSemanticSourceExtractionRoot, extractArchivedSourceText, normalizeExtractedText,
  resolvePdfToText, semanticSourceExtractionArtifactHash,
  validateSemanticSourceExtractionArtifact,
} from "./semantic-source-extraction.mjs";
import { inspectSourceAcquisitions, sha256Bytes } from "./source-acquisition.mjs";
import { CANONICAL_MASTER_IDS, defaultStagingRoot } from "./staging.mjs";
import { defaultPersonaDir } from "../personas/registry.mjs";

const HASH = /^sha256:[a-f0-9]{64}$/u;
const VERDICTS = new Set(["supported", "partial", "unsupported", "unverifiable"]);
const AMBIGUITY = new Set(["none_detected", "limited", "material", "unknown"]);
const PIPELINE_ID = "alphacouncil_ai_semantic_source_skeptic_v1";
const ARTIFACT_FIELDS = new Set([
  "schema_version", "artifact_kind", "pipeline_id", "review_stage", "reviewer_kind", "role",
  "role_id", "prompt_identity", "model_identity", "reviewed_on", "human_reviewed",
  "method_attribution_approved", "production_effect", "persona_id", "candidate_id",
  "source_binding", "extractor_binding", "binding_checks", "readability_recheck",
  "proposition_reviews", "overall_verdict", "challenges", "open_questions", "artifact_hash",
]);
const REVIEW_FIELDS = new Set([
  "proposition_id", "proposed_statement", "proposed_support_strength",
  "proposed_evidence_excerpt", "proposed_locator", "snippet_hash_claimed",
  "snippet_hash_recomputed", "snippet_binding_status", "locator_verification",
  "support_verdict", "support_rationale", "authorship_ambiguity", "scope_ambiguity",
  "date_ambiguity", "challenges", "open_questions", "review_hash",
]);

export const SEMANTIC_SOURCE_SKEPTIC_PROMPT = [
  "Act independently from the round-1 extractor and reopen the archived source bytes.",
  "Recompute candidate, persona, raw-byte, source-record, extracted-text, locator, and snippet bindings.",
  "Judge whether each exact snippet supports the proposed proposition as supported, partial, unsupported, or unverifiable.",
  "Challenge authorship, scope, and publication-date ambiguity; record open questions rather than copying extractor prose.",
  "Never impersonate a human, approve method attribution, write an adjudicator result, or affect production.",
].join(" ");

export const SEMANTIC_SKEPTIC_MODEL_IDENTITY = Object.freeze({
  provider: "OpenAI",
  product: "Codex collaborating agent",
  model_family: "GPT-5",
  exact_deployment_id: "not_exposed_to_agent",
  agent_task_id: "/root/ai_formula_review_lane",
});

function strings(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim());
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort());
}

function within(root, target) {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function safeRoot(root, label, { create = false, source = false } = {}) {
  const resolved = resolve(root);
  const parts = resolved.split(sep);
  const isolatedReviewRoot = parts.includes("staging")
    || (parts.includes("ai-assisted-solo") && parts.includes("reviews"));
  if (source ? !parts.includes("staging") : !isolatedReviewRoot) {
    throw new Error(`${label} must remain in an isolated staging or AI-assisted review tree`);
  }
  if (!existsSync(resolved)) {
    if (!create) throw new Error(`${label} is missing`);
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
  }
  if (lstatSync(resolved).isSymbolicLink() || !statSync(resolved).isDirectory()) throw new Error(`${label} is unsafe`);
  return resolved;
}

function readJson(root, relativePath, label) {
  const file = resolve(root, relativePath);
  if (!within(root, file) || !existsSync(file) || lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) {
    throw new Error(`${label} is missing or unsafe: ${relativePath}`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

export function defaultSemanticSourceSkepticRoot({ stagingRoot = defaultStagingRoot() } = {}) {
  return process.env.ALPHACOUNCIL_SEMANTIC_SOURCE_SKEPTIC_DIR
    || resolve(dirname(dirname(stagingRoot)), "ai-assisted-solo", "reviews", "persona-v3-ai-semantic-skeptic-reviews");
}

function promptIdentity() {
  return canonicalValue({
    prompt_id: "alphacouncil.source-semantic-skeptic.round2.v1",
    prompt_hash: sha256({
      domain: "alphacouncil.semantic-source-skeptic-prompt.v1",
      prompt_id: "alphacouncil.source-semantic-skeptic.round2.v1",
      prompt: SEMANTIC_SOURCE_SKEPTIC_PROMPT,
    }),
  });
}

function occurrences(extraction, excerpt) {
  const found = [];
  for (const [pageIndex, text] of extraction.pages.entries()) {
    let start = 0;
    while (start <= text.length - excerpt.length) {
      const at = text.indexOf(excerpt, start);
      if (at < 0) break;
      found.push({ page: pageIndex + 1, start: at, end: at + excerpt.length });
      start = at + Math.max(1, excerpt.length);
    }
  }
  return found;
}

function verifyLocator(extraction, proposition) {
  const excerpt = normalizeExtractedText(proposition.evidence_excerpt);
  const found = occurrences(extraction, excerpt);
  const declared = proposition.locator;
  let match = null;
  let exact = false;
  if (declared.kind === "pdf_page") {
    match = found.find((item) => item.page === declared.page) || found[0] || null;
    exact = Boolean(match && match.page === declared.page && declared.text_start === null && declared.text_end === null);
  } else {
    match = found[0] || null;
    exact = Boolean(match && declared.page === null && declared.text_start === match.start && declared.text_end === match.end);
  }
  return canonicalValue({
    status: exact ? "exact" : found.length ? "mismatch" : "unverifiable",
    declared_kind: declared.kind,
    declared_page: declared.page,
    actual_page: match && extraction.page_count > 1 ? match.page : null,
    actual_text_start: match?.start ?? null,
    actual_text_end: match?.end ?? null,
    occurrence_count: found.length,
    section_label_status: declared.section ? "extractor_label_not_independently_bound" : "absent",
  });
}

function snippetHash(record, extraction, proposition) {
  return sha256({
    domain: "alphacouncil.semantic-source-evidence-snippet.v1",
    content_hash: record.content_hash,
    extracted_text_hash: extraction.extracted_text_hash,
    locator: proposition.locator,
    normalized_excerpt: normalizeExtractedText(proposition.evidence_excerpt),
  });
}

function reviewHash(review) {
  const { review_hash: ignored, ...subject } = review;
  return sha256({ domain: "alphacouncil.semantic-source-skeptic-proposition-review.v1", subject: canonicalValue(subject) });
}

function propositionReview(record, extraction, proposition, judgment) {
  const locator = verifyLocator(extraction, proposition);
  const recomputedSnippetHash = snippetHash(record, extraction, proposition);
  const snippetBindingStatus = locator.status === "unverifiable" ? "unverifiable"
    : recomputedSnippetHash === proposition.snippet_hash && locator.status === "exact" ? "exact" : "mismatch";
  const supportVerdict = snippetBindingStatus === "exact" ? judgment.verdict : "unverifiable";
  const subject = canonicalValue({
    proposition_id: proposition.proposition_id,
    proposed_statement: proposition.statement,
    proposed_support_strength: proposition.support_strength,
    proposed_evidence_excerpt: proposition.evidence_excerpt,
    proposed_locator: proposition.locator,
    snippet_hash_claimed: proposition.snippet_hash,
    snippet_hash_recomputed: recomputedSnippetHash,
    snippet_binding_status: snippetBindingStatus,
    locator_verification: locator,
    support_verdict: supportVerdict,
    support_rationale: snippetBindingStatus === "exact"
      ? judgment.support_rationale
      : "The exact source/locator/snippet binding did not survive independent recomputation, so semantic support is unverifiable.",
    authorship_ambiguity: judgment.authorship_ambiguity,
    scope_ambiguity: judgment.scope_ambiguity,
    date_ambiguity: judgment.date_ambiguity,
    challenges: snippetBindingStatus === "exact" ? judgment.challenges : [...judgment.challenges, "Binding mismatch blocks semantic reliance."],
    open_questions: judgment.open_questions,
  });
  return canonicalValue({ ...subject, review_hash: reviewHash(subject) });
}

function check(status, detail) {
  return canonicalValue({ status: status ? "pass" : "fail", detail });
}

function independentReadability(extraction, propositionCount) {
  const text = extraction.pages.join(" ");
  if (extraction.extraction_error || extraction.extracted_character_count === 0 || /["']_waf_/iu.test(text.slice(0, 500))) {
    return { status: "unreadable", reason: "Independent byte reopening produced no usable prose or an opaque WAF payload." };
  }
  if (propositionCount > 0) return { status: "readable", reason: "Independent extraction located every proposed evidence excerpt in readable text." };
  return { status: "partial", reason: "Independent extraction produced some text but no safely reviewable method proposition." };
}

function overallVerdict(reviews) {
  if (!reviews.length) return "unverifiable";
  for (const verdict of ["unsupported", "unverifiable", "partial", "supported"]) {
    if (reviews.some((review) => review.support_verdict === verdict)) return verdict;
  }
  return "unverifiable";
}

function artifactHash(artifact) {
  const { artifact_hash: ignored, ...subject } = artifact;
  return sha256({ domain: "alphacouncil.semantic-source-skeptic-artifact.v1", subject: canonicalValue(subject) });
}

export function semanticSourceSkepticArtifactHash(artifact) {
  return artifactHash(artifact);
}

function buildArtifact({ record, bytes, archivePath, extractorArtifact, extractorPath, judgment, pdftotext }) {
  const extraction = extractArchivedSourceText({ record, bytes, archivePath, pdftotext });
  const rawHash = sha256Bytes(bytes);
  const recordHash = sha256(record);
  const extractorHash = semanticSourceExtractionArtifactHash(extractorArtifact);
  const extractorValidation = validateSemanticSourceExtractionArtifact(extractorArtifact);
  const candidateIdentityPass = extractorArtifact.persona_id === record.persona_id
    && extractorArtifact.candidate_id === record.candidate_id
    && judgment.persona_id === record.persona_id && judgment.candidate_id === record.candidate_id;
  const rawPass = rawHash === record.content_hash && bytes.length === record.byte_length
    && extractorArtifact.source_binding.content_hash === record.content_hash
    && extractorArtifact.source_binding.byte_length === record.byte_length;
  const recordPass = extractorArtifact.source_binding.record_hash === recordHash;
  const textPass = extractorArtifact.source_binding.extracted_text_hash === extraction.extracted_text_hash
    && extractorArtifact.source_binding.extracted_character_count === extraction.extracted_character_count
    && canonicalJson(extractorArtifact.source_binding.page_character_counts) === canonicalJson(extraction.page_character_counts);
  const extractorPass = extractorValidation.length === 0 && extractorArtifact.artifact_hash === extractorHash;
  const propositionById = new Map(extractorArtifact.method_propositions.map((item) => [item.proposition_id, item]));
  const judgments = new Map(judgment.proposition_reviews.map((item) => [item.proposition_id, item]));
  if (propositionById.size !== judgments.size || [...propositionById.keys()].some((id) => !judgments.has(id))) {
    throw new Error(`${record.candidate_id}: skeptic catalog and extractor proposition ids differ`);
  }
  const reviews = extractorArtifact.method_propositions.map((item) => propositionReview(record, extraction, item, judgments.get(item.proposition_id)));
  const readability = independentReadability(extraction, reviews.length);
  const subject = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_ai_semantic_source_skeptic_review",
    pipeline_id: PIPELINE_ID,
    review_stage: "round_2_semantic_skeptic",
    reviewer_kind: "ai",
    role: "skeptic",
    role_id: "ai_semantic_source_skeptic_v1",
    prompt_identity: promptIdentity(),
    model_identity: SEMANTIC_SKEPTIC_MODEL_IDENTITY,
    reviewed_on: "2026-07-27",
    human_reviewed: false,
    method_attribution_approved: false,
    production_effect: "none",
    persona_id: record.persona_id,
    candidate_id: record.candidate_id,
    source_binding: {
      content_hash: record.content_hash,
      byte_length: record.byte_length,
      raw_bytes_hash_recomputed: rawHash,
      raw_bytes_reverified: rawPass,
      source_record_hash: extractorArtifact.source_binding.record_hash,
      source_record_hash_recomputed: recordHash,
      extracted_text_hash: extractorArtifact.source_binding.extracted_text_hash,
      extracted_text_hash_recomputed: extraction.extracted_text_hash,
    },
    extractor_binding: {
      relative_path: extractorPath,
      declared_artifact_hash: extractorArtifact.artifact_hash,
      recomputed_artifact_hash: extractorHash,
      artifact_content_hash: sha256(extractorArtifact),
      proposition_count: extractorArtifact.method_propositions.length,
    },
    binding_checks: {
      candidate_persona: check(candidateIdentityPass, "extractor, acquisition, and skeptic catalog candidate/persona identities must match"),
      raw_bytes: check(rawPass, "source.bin byte length and SHA-256 must match acquisition and extractor bindings"),
      source_record: check(recordPass, "acquisition record canonical hash must match the extractor binding"),
      extracted_text: check(textPass, "independent extraction hash, length, and page counts must match"),
      extractor_artifact: check(extractorPass, "extractor artifact domain hash and structural validation must pass"),
    },
    readability_recheck: {
      extractor_status: extractorArtifact.readability.status,
      independent_status: readability.status,
      status_match: extractorArtifact.readability.status === readability.status,
      reason: readability.reason,
    },
    proposition_reviews: reviews,
    overall_verdict: overallVerdict(reviews),
    challenges: judgment.challenges,
    open_questions: judgment.open_questions,
  });
  return canonicalValue({ ...subject, artifact_hash: artifactHash(subject) });
}

function validateAmbiguity(value, path, errors) {
  if (!value || !AMBIGUITY.has(value.status) || typeof value.rationale !== "string" || !value.rationale.trim()) errors.push(`${path} is invalid`);
}

export function validateSemanticSourceSkepticArtifact(artifact, { expected = null } = {}) {
  const errors = [];
  if (!exactKeys(artifact, ARTIFACT_FIELDS)) return ["skeptic artifact fields are invalid"];
  if (artifact.schema_version !== 1 || artifact.artifact_kind !== "persona_v3_ai_semantic_source_skeptic_review") errors.push("artifact identity is invalid");
  if (artifact.pipeline_id !== PIPELINE_ID || artifact.review_stage !== "round_2_semantic_skeptic" || artifact.role !== "skeptic" || artifact.role_id !== "ai_semantic_source_skeptic_v1") errors.push("skeptic stage identity is invalid");
  if (artifact.reviewer_kind !== "ai" || artifact.human_reviewed !== false || artifact.method_attribution_approved !== false || artifact.production_effect !== "none") errors.push("machine-only boundary is invalid");
  if (!CANONICAL_MASTER_IDS.includes(artifact.persona_id) || typeof artifact.candidate_id !== "string") errors.push("candidate identity is invalid");
  for (const value of Object.values(artifact.source_binding || {}).filter((item) => typeof item === "string" && item.startsWith("sha256:"))) if (!HASH.test(value)) errors.push("source binding hash is invalid");
  for (const [name, value] of Object.entries(artifact.binding_checks || {})) if (value?.status !== "pass" || typeof value.detail !== "string") errors.push(`binding_checks.${name} did not pass`);
  if (artifact.readability_recheck?.status_match !== true) errors.push("readability recheck differs");
  if (!Array.isArray(artifact.proposition_reviews)) errors.push("proposition_reviews must be an array");
  else for (const [index, review] of artifact.proposition_reviews.entries()) {
    if (!exactKeys(review, REVIEW_FIELDS)) { errors.push(`proposition_reviews[${index}] fields are invalid`); continue; }
    if (!VERDICTS.has(review.support_verdict) || !HASH.test(review.snippet_hash_claimed) || !HASH.test(review.snippet_hash_recomputed)) errors.push(`proposition_reviews[${index}] verdict/hash is invalid`);
    if (review.snippet_binding_status !== "exact" || review.locator_verification?.status !== "exact") errors.push(`proposition_reviews[${index}] source binding did not pass`);
    validateAmbiguity(review.authorship_ambiguity, `proposition_reviews[${index}].authorship_ambiguity`, errors);
    validateAmbiguity(review.scope_ambiguity, `proposition_reviews[${index}].scope_ambiguity`, errors);
    validateAmbiguity(review.date_ambiguity, `proposition_reviews[${index}].date_ambiguity`, errors);
    if (!strings(review.challenges) || !strings(review.open_questions)) errors.push(`proposition_reviews[${index}] challenges/open questions are invalid`);
    if (review.review_hash !== reviewHash(review)) errors.push(`proposition_reviews[${index}] review_hash is invalid`);
  }
  if (!VERDICTS.has(artifact.overall_verdict) || artifact.overall_verdict !== overallVerdict(artifact.proposition_reviews || [])) errors.push("overall_verdict is invalid");
  if (!strings(artifact.challenges) || !strings(artifact.open_questions)) errors.push("candidate challenges/open questions are invalid");
  if (!HASH.test(artifact.artifact_hash || "") || artifact.artifact_hash !== artifactHash(artifact)) errors.push("artifact_hash is invalid");
  if (expected && canonicalJson(artifact) !== canonicalJson(expected)) errors.push("artifact differs from independent raw-source reconstruction");
  return errors;
}

function expectedEntries({ root, extractionRoot, productionRoot, personaDir, pdftotext, now }) {
  const sourceRoot = safeRoot(root, "source staging root", { source: true });
  const extractorRoot = safeRoot(extractionRoot, "semantic extraction root");
  const inventory = inspectSourceAcquisitions({ root: sourceRoot, productionRoot, personaDir, now });
  const catalog = new Map(SEMANTIC_SOURCE_SKEPTIC_REVIEW_CATALOG.map((item) => [item.candidate_id, item]));
  const entries = [];
  for (const seat of inventory.personas) for (const record of seat.records) {
    const judgment = catalog.get(record.candidate_id);
    if (!judgment || judgment.persona_id !== record.persona_id) throw new Error(`${record.candidate_id}: skeptic catalog identity is missing or mismatched`);
    const extractorPath = `${record.persona_id}/${record.candidate_id}.json`;
    const extractorArtifact = readJson(extractorRoot, extractorPath, "semantic extractor artifact");
    const archivePath = join(sourceRoot, record.persona_id, record.archive_path);
    if (!within(join(sourceRoot, record.persona_id), archivePath) || lstatSync(archivePath).isSymbolicLink()) throw new Error(`${record.candidate_id}: source.bin path is unsafe`);
    const bytes = readFileSync(archivePath);
    const artifact = buildArtifact({ record, bytes, archivePath, extractorArtifact, extractorPath, judgment, pdftotext });
    entries.push({ record, artifact });
  }
  if (catalog.size !== entries.length) throw new Error(`skeptic review requires exactly ${catalog.size} candidates; got ${entries.length}/${catalog.size}`);
  entries.sort((a, b) => `${a.record.persona_id}/${a.record.candidate_id}`.localeCompare(`${b.record.persona_id}/${b.record.candidate_id}`));
  return entries;
}

function counts(values, keys) {
  return Object.fromEntries(keys.map((key) => [key, values.filter((value) => value === key).length]));
}

function buildIndex(entries) {
  const reviews = entries.flatMap((entry) => entry.artifact.proposition_reviews);
  const subject = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_ai_semantic_source_skeptic_index",
    review_stage: "round_2_semantic_skeptic",
    reviewer_kind: "ai",
    role: "skeptic",
    human_reviewed_count: 0,
    method_attribution_approved_count: 0,
    production_effect: "none",
    canonical_master_count: CANONICAL_MASTER_COUNT,
    seats_with_candidates: new Set(entries.map((entry) => entry.record.persona_id)).size,
    candidate_count: entries.length,
    proposition_review_count: reviews.length,
    proposition_verdict_counts: counts(reviews.map((review) => review.support_verdict), [...VERDICTS]),
    candidate_verdict_counts: counts(entries.map((entry) => entry.artifact.overall_verdict), [...VERDICTS]),
    binding_pass_count: entries.filter((entry) => Object.values(entry.artifact.binding_checks).every((item) => item.status === "pass")).length,
    artifacts: entries.map((entry) => ({
      persona_id: entry.record.persona_id,
      candidate_id: entry.record.candidate_id,
      relative_path: `${entry.record.persona_id}/${entry.record.candidate_id}.json`,
      content_hash: entry.record.content_hash,
      extractor_artifact_hash: entry.artifact.extractor_binding.declared_artifact_hash,
      skeptic_artifact_hash: entry.artifact.artifact_hash,
      overall_verdict: entry.artifact.overall_verdict,
      proposition_review_count: entry.artifact.proposition_reviews.length,
    })),
  });
  return canonicalValue({ ...subject, index_hash: sha256({ domain: "alphacouncil.semantic-source-skeptic-index.v1", subject }) });
}

function outputReport(entries, outputRoot, errors = []) {
  const index = buildIndex(entries);
  return canonicalValue({
    valid: errors.length === 0,
    root: resolve(outputRoot),
    valid_artifact_count: errors.length ? 0 : entries.length,
    ...index,
    production_write_count: 0,
    errors,
  });
}

export function writeSemanticSourceSkepticReviews({
  root = defaultStagingRoot(),
  extractionRoot = defaultSemanticSourceExtractionRoot({ stagingRoot: root }),
  outputRoot = defaultSemanticSourceSkepticRoot({ stagingRoot: root }),
  productionRoot = defaultKnowledgeDir(), personaDir = defaultPersonaDir(),
  pdftotext = resolvePdfToText(), now = new Date(),
} = {}) {
  const entries = expectedEntries({ root, extractionRoot, productionRoot, personaDir, pdftotext, now });
  const target = safeRoot(outputRoot, "semantic skeptic output root", { create: true });
  let wrote = 0;
  for (const entry of entries) {
    const seatDir = join(target, entry.record.persona_id);
    mkdirSync(seatDir, { recursive: true, mode: 0o700 });
    const file = join(seatDir, `${entry.record.candidate_id}.json`);
    const serialized = `${JSON.stringify(entry.artifact, null, 2)}\n`;
    if (existsSync(file)) {
      if (lstatSync(file).isSymbolicLink() || readFileSync(file, "utf8") !== serialized) throw new Error(`${file}: differs; refusing overwrite`);
    } else { writeFileSync(file, serialized, { flag: "wx", mode: 0o600 }); wrote += 1; }
  }
  const index = buildIndex(entries);
  const indexFile = join(target, "index.json");
  const serialized = `${JSON.stringify(index, null, 2)}\n`;
  if (existsSync(indexFile)) {
    if (lstatSync(indexFile).isSymbolicLink() || readFileSync(indexFile, "utf8") !== serialized) throw new Error(`${indexFile}: differs; refusing overwrite`);
  } else { writeFileSync(indexFile, serialized, { flag: "wx", mode: 0o600 }); wrote += 1; }
  return canonicalValue({ ...outputReport(entries, target), wrote_file_count: wrote });
}

export function inspectSemanticSourceSkepticReviews({
  root = defaultStagingRoot(),
  extractionRoot = defaultSemanticSourceExtractionRoot({ stagingRoot: root }),
  outputRoot = defaultSemanticSourceSkepticRoot({ stagingRoot: root }),
  productionRoot = defaultKnowledgeDir(), personaDir = defaultPersonaDir(),
  pdftotext = resolvePdfToText(), now = new Date(),
} = {}) {
  const entries = expectedEntries({ root, extractionRoot, productionRoot, personaDir, pdftotext, now });
  const errors = [];
  if (!existsSync(outputRoot) || lstatSync(outputRoot).isSymbolicLink() || !statSync(outputRoot).isDirectory()) errors.push("semantic skeptic output root is missing or unsafe");
  else {
    const expectedTop = new Set([...new Set(entries.map((entry) => entry.record.persona_id)), "index.json"]);
    for (const item of readdirSync(outputRoot, { withFileTypes: true })) if (!expectedTop.has(item.name) || item.isSymbolicLink()) errors.push(`${item.name}: unexpected skeptic artifact`);
    for (const entry of entries) {
      const file = join(outputRoot, entry.record.persona_id, `${entry.record.candidate_id}.json`);
      if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) { errors.push(`${file}: missing or unsafe`); continue; }
      try {
        const artifact = JSON.parse(readFileSync(file, "utf8"));
        errors.push(...validateSemanticSourceSkepticArtifact(artifact, { expected: entry.artifact }).map((error) => `${entry.record.candidate_id}: ${error}`));
      } catch (error) { errors.push(`${entry.record.candidate_id}: ${error.message}`); }
    }
    const indexFile = join(outputRoot, "index.json");
    if (!existsSync(indexFile) || lstatSync(indexFile).isSymbolicLink() || !statSync(indexFile).isFile()) errors.push("semantic skeptic index is missing or unsafe");
    else {
      try { if (canonicalJson(JSON.parse(readFileSync(indexFile, "utf8"))) !== canonicalJson(buildIndex(entries))) errors.push("semantic skeptic index differs"); }
      catch (error) { errors.push(`semantic skeptic index: ${error.message}`); }
    }
  }
  return outputReport(entries, outputRoot, errors);
}
