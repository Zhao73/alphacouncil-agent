/** Round-3, machine-only adjudication of extractor and skeptic semantic source reviews. */

import { CANONICAL_MASTER_COUNT } from "./staging.mjs";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { SEMANTIC_SOURCE_ADJUDICATION_CATALOG } from "../../../data/persona-v3-semantic-adjudications.v1.mjs";
import { defaultKnowledgeDir } from "./admission.mjs";
import { canonicalJson, canonicalValue, sha256 } from "./canonical.mjs";
import {
  defaultSemanticSourceExtractionRoot, extractArchivedSourceText, normalizeExtractedText,
  resolvePdfToText, semanticSourceExtractionArtifactHash,
  validateSemanticSourceExtractionArtifact,
} from "./semantic-source-extraction.mjs";
import {
  defaultSemanticSourceSkepticRoot, semanticSourceSkepticArtifactHash,
  validateSemanticSourceSkepticArtifact,
} from "./semantic-source-skeptic-review.mjs";
import { inspectSourceAcquisitions, sha256Bytes } from "./source-acquisition.mjs";
import { CANONICAL_MASTER_IDS, defaultStagingRoot } from "./staging.mjs";
import { defaultPersonaDir } from "../personas/registry.mjs";

const HASH = /^sha256:[a-f0-9]{64}$/u;
const VERDICTS = Object.freeze(["supported", "partial", "unsupported", "unverifiable"]);
const VERDICT_SET = new Set(VERDICTS);
const PIPELINE_ID = "alphacouncil_ai_semantic_source_adjudicator_v1";

export const SEMANTIC_SOURCE_ADJUDICATOR_PROMPT = [
  "Act as the independent third machine process after extraction and skeptic review.",
  "Reopen source.bin and independently recompute raw, record, extracted-text, locator, and snippet hashes.",
  "Compare the extractor proposition with every skeptic challenge and assign a final supported, partial, unsupported, or unverifiable verdict.",
  "Record agreements, disagreements, rationale, and unresolved authorship, scope, and date questions.",
  "Never impersonate a human, approve method attribution, create a signature, modify a human gate, or affect production.",
].join(" ");

export const SEMANTIC_ADJUDICATOR_MODEL_IDENTITY = Object.freeze({
  provider: "OpenAI",
  product: "Codex collaborating agent",
  model_family: "GPT-5",
  exact_deployment_id: "not_exposed_to_agent",
  agent_task_id: "/root/ai_formula_review_lane/source_semantic_adjudicator",
});

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

export function defaultSemanticSourceAdjudicationRoot({ stagingRoot = defaultStagingRoot() } = {}) {
  return process.env.ALPHACOUNCIL_SEMANTIC_SOURCE_ADJUDICATION_DIR
    || resolve(dirname(dirname(stagingRoot)), "ai-assisted-solo", "reviews", "persona-v3-ai-semantic-adjudications");
}

function promptIdentity() {
  return canonicalValue({
    prompt_id: "alphacouncil.source-semantic-adjudicator.round3.v1",
    prompt_hash: sha256({
      domain: "alphacouncil.semantic-source-adjudicator-prompt.v1",
      prompt_id: "alphacouncil.source-semantic-adjudicator.round3.v1",
      prompt: SEMANTIC_SOURCE_ADJUDICATOR_PROMPT,
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
      found.push({ page: pageIndex + 1, text_start: at, text_end: at + excerpt.length });
      start = at + Math.max(1, excerpt.length);
    }
  }
  return found;
}

function recomputeLocator(extraction, proposition) {
  const excerpt = normalizeExtractedText(proposition.evidence_excerpt);
  const found = occurrences(extraction, excerpt);
  const declared = proposition.locator;
  const match = declared.kind === "pdf_page"
    ? found.find((item) => item.page === declared.page) || found[0] || null
    : found[0] || null;
  const exact = declared.kind === "pdf_page"
    ? Boolean(match && match.page === declared.page && declared.text_start === null && declared.text_end === null)
    : Boolean(match && declared.page === null && declared.text_start === match.text_start && declared.text_end === match.text_end);
  return canonicalValue({
    status: exact ? "exact" : found.length ? "mismatch" : "unverifiable",
    kind: declared.kind,
    page: extraction.page_count > 1 ? match?.page ?? null : null,
    text_start: match?.text_start ?? null,
    text_end: match?.text_end ?? null,
    occurrence_count: found.length,
    section_claimed: declared.section,
    section_independently_bound: false,
  });
}

function recomputeSnippetHash(record, extraction, proposition) {
  return sha256({
    domain: "alphacouncil.semantic-source-evidence-snippet.v1",
    content_hash: record.content_hash,
    extracted_text_hash: extraction.extracted_text_hash,
    locator: proposition.locator,
    normalized_excerpt: normalizeExtractedText(proposition.evidence_excerpt),
  });
}

function finalSemanticVerdict({ bindingExact, judgment }) {
  if (!bindingExact) return "unverifiable";
  return judgment.verdict;
}

function independentRationale(verdict, judgment) {
  if (verdict === "unverifiable") return judgment
    ? "An exact content, locator, or snippet binding did not survive recomputation, so semantic support cannot be adjudicated."
    : "No source-bound method proposition exists in the extractor artifact, so this candidate remains semantically unverifiable.";
  return judgment.rationale;
}

function ambiguityQuestions(review) {
  const question = (kind, ambiguity) => ambiguity.status === "none_detected" ? []
    : [`${kind}: ${ambiguity.rationale}`];
  return canonicalValue({
    authorship: question("Authorship remains unresolved", review.authorship_ambiguity),
    scope: question("Scope remains unresolved", review.scope_ambiguity),
    date: question("Publication date remains unresolved", review.date_ambiguity),
  });
}

function reviewHash(review) {
  const { review_hash: ignored, ...subject } = review;
  return sha256({ domain: "alphacouncil.semantic-source-adjudication-proposition.v1", subject: canonicalValue(subject) });
}

function adjudicateProposition(record, extraction, proposition, skepticReview, judgment) {
  const locator = recomputeLocator(extraction, proposition);
  const snippetHash = recomputeSnippetHash(record, extraction, proposition);
  const bindingExact = locator.status === "exact"
    && snippetHash === proposition.snippet_hash
    && skepticReview.snippet_binding_status === "exact"
    && skepticReview.snippet_hash_claimed === proposition.snippet_hash
    && skepticReview.snippet_hash_recomputed === snippetHash
    && skepticReview.locator_verification.status === "exact";
  const verdict = finalSemanticVerdict({ bindingExact, judgment });
  const extractorAgreement = verdict === "supported" ? "agree"
    : verdict === "partial" ? "qualified" : verdict === "unsupported" ? "disagree" : "unverifiable";
  const skepticAgreement = verdict === skepticReview.support_verdict ? "agree" : "disagree";
  const agreements = [];
  const disagreements = [];
  if (extractorAgreement === "agree") agreements.push("The final adjudicator accepts the extractor proposition at its claimed semantic strength.");
  else if (extractorAgreement === "qualified") disagreements.push("The extractor's support-strength claim is narrowed to partial support after the skeptic challenge.");
  else disagreements.push("The extractor's support claim does not survive final adjudication.");
  if (skepticAgreement === "agree") agreements.push(`The adjudicator agrees with the skeptic's ${skepticReview.support_verdict} verdict.`);
  else disagreements.push(`The adjudicator rejects the skeptic's ${skepticReview.support_verdict} verdict.`);
  const subject = canonicalValue({
    proposition_id: proposition.proposition_id,
    statement: proposition.statement,
    exact_content_binding: {
      normalized_excerpt: normalizeExtractedText(proposition.evidence_excerpt),
      extractor_locator: proposition.locator,
      adjudicator_locator_recomputed: locator,
      extractor_snippet_hash: proposition.snippet_hash,
      skeptic_snippet_hash_claimed: skepticReview.snippet_hash_claimed,
      skeptic_snippet_hash_recomputed: skepticReview.snippet_hash_recomputed,
      adjudicator_snippet_hash_recomputed: snippetHash,
      binding_status: bindingExact ? "exact" : "unverifiable",
    },
    extractor_claim: {
      support_strength: proposition.support_strength,
      adjudicator_relation: extractorAgreement,
    },
    skeptic_claim: {
      support_verdict: skepticReview.support_verdict,
      support_rationale: skepticReview.support_rationale,
      challenges: skepticReview.challenges,
      adjudicator_relation: skepticAgreement,
    },
    final_verdict: verdict,
    final_rationale: independentRationale(verdict, judgment),
    agreements,
    disagreements,
    unresolved_questions: ambiguityQuestions(skepticReview),
  });
  return canonicalValue({ ...subject, review_hash: reviewHash(subject) });
}

function overallVerdict(reviews) {
  if (!reviews.length) return "unverifiable";
  for (const verdict of ["unsupported", "unverifiable", "partial", "supported"]) {
    if (reviews.some((review) => review.final_verdict === verdict)) return verdict;
  }
  return "unverifiable";
}

function artifactHash(artifact) {
  const { artifact_hash: ignored, ...subject } = artifact;
  return sha256({ domain: "alphacouncil.semantic-source-adjudication-artifact.v1", subject: canonicalValue(subject) });
}

export function semanticSourceAdjudicationArtifactHash(artifact) {
  return artifactHash(artifact);
}

function check(status, detail) {
  return canonicalValue({ status: status ? "pass" : "fail", detail });
}

function buildArtifact({ record, bytes, archivePath, extractorArtifact, extractorPath, skepticArtifact, skepticPath, judgments, pdftotext }) {
  const extraction = extractArchivedSourceText({ record, bytes, archivePath, pdftotext });
  const rawHash = sha256Bytes(bytes);
  const recordHash = sha256(record);
  const extractorHash = semanticSourceExtractionArtifactHash(extractorArtifact);
  const skepticHash = semanticSourceSkepticArtifactHash(skepticArtifact);
  const extractorValidation = validateSemanticSourceExtractionArtifact(extractorArtifact);
  const skepticValidation = validateSemanticSourceSkepticArtifact(skepticArtifact);
  const identityPass = [extractorArtifact, skepticArtifact].every((item) => item.persona_id === record.persona_id && item.candidate_id === record.candidate_id);
  const rawPass = rawHash === record.content_hash && bytes.length === record.byte_length
    && extractorArtifact.source_binding.content_hash === rawHash && skepticArtifact.source_binding.content_hash === rawHash;
  const recordPass = extractorArtifact.source_binding.record_hash === recordHash
    && skepticArtifact.source_binding.source_record_hash === recordHash
    && skepticArtifact.source_binding.source_record_hash_recomputed === recordHash;
  const textPass = extractorArtifact.source_binding.extracted_text_hash === extraction.extracted_text_hash
    && skepticArtifact.source_binding.extracted_text_hash === extraction.extracted_text_hash
    && skepticArtifact.source_binding.extracted_text_hash_recomputed === extraction.extracted_text_hash;
  const extractorPass = extractorValidation.length === 0 && extractorArtifact.artifact_hash === extractorHash;
  const skepticPass = skepticValidation.length === 0 && skepticArtifact.artifact_hash === skepticHash;
  const skepticById = new Map(skepticArtifact.proposition_reviews.map((item) => [item.proposition_id, item]));
  if (skepticById.size !== extractorArtifact.method_propositions.length
    || extractorArtifact.method_propositions.some((item) => !skepticById.has(item.proposition_id))) {
    throw new Error(`${record.candidate_id}: extractor and skeptic proposition ids differ`);
  }
  const reviews = extractorArtifact.method_propositions.map((item) => {
    const judgment = judgments.get(item.proposition_id);
    if (!judgment) throw new Error(`${item.proposition_id}: independent adjudicator judgment is missing`);
    return adjudicateProposition(record, extraction, item, skepticById.get(item.proposition_id), judgment);
  });
  const noPropositions = reviews.length === 0;
  const subject = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_ai_semantic_source_adjudication",
    pipeline_id: PIPELINE_ID,
    review_stage: "round_3_semantic_adjudication",
    reviewer_kind: "ai",
    role: "adjudicator",
    role_id: "ai_semantic_source_adjudicator_v1",
    prompt_identity: promptIdentity(),
    model_identity: SEMANTIC_ADJUDICATOR_MODEL_IDENTITY,
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
      source_record_hash: recordHash,
      extracted_text_hash_recomputed: extraction.extracted_text_hash,
      extracted_character_count_recomputed: extraction.extracted_character_count,
      page_count_recomputed: extraction.page_count,
      page_character_counts_recomputed: extraction.page_character_counts,
    },
    extractor_binding: {
      relative_path: extractorPath,
      declared_artifact_hash: extractorArtifact.artifact_hash,
      recomputed_artifact_hash: extractorHash,
      artifact_content_hash: sha256(extractorArtifact),
    },
    skeptic_binding: {
      relative_path: skepticPath,
      declared_artifact_hash: skepticArtifact.artifact_hash,
      recomputed_artifact_hash: skepticHash,
      artifact_content_hash: sha256(skepticArtifact),
    },
    binding_checks: {
      candidate_persona: check(identityPass, "acquisition, extractor, and skeptic candidate/persona identities must match"),
      raw_bytes: check(rawPass, "source.bin bytes and declared content hashes must match"),
      source_record: check(recordPass, "canonical acquisition record hashes must match"),
      extracted_text: check(textPass, "third-process extracted-text hash must match both prior lanes"),
      extractor_artifact: check(extractorPass, "extractor structure and domain hash must validate"),
      skeptic_artifact: check(skepticPass, "skeptic structure and domain hash must validate"),
    },
    proposition_adjudications: reviews,
    final_overall_verdict: overallVerdict(reviews),
    agreements: reviews.flatMap((review) => review.agreements),
    disagreements: reviews.flatMap((review) => review.disagreements),
    unresolved_questions: noPropositions ? {
      authorship: ["No readable proposition is available to resolve method authorship."],
      scope: ["No source-bound proposition is available to resolve method scope."],
      date: ["No human-approved publication-date anchor is available in this machine lane."],
    } : {
      authorship: reviews.flatMap((review) => review.unresolved_questions.authorship),
      scope: reviews.flatMap((review) => review.unresolved_questions.scope),
      date: reviews.flatMap((review) => review.unresolved_questions.date),
    },
    final_rationale: noPropositions
      ? independentRationale("unverifiable", null)
      : "Every proposition was independently rebound to source bytes and adjudicated after comparing the extractor claim with the skeptic challenge.",
  });
  return canonicalValue({ ...subject, artifact_hash: artifactHash(subject) });
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim());
}

export function validateSemanticSourceAdjudicationArtifact(artifact, { expected = null } = {}) {
  const errors = [];
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return ["adjudication artifact must be an object"];
  if (artifact.schema_version !== 1 || artifact.artifact_kind !== "persona_v3_ai_semantic_source_adjudication") errors.push("artifact identity is invalid");
  if (artifact.pipeline_id !== PIPELINE_ID || artifact.review_stage !== "round_3_semantic_adjudication" || artifact.role !== "adjudicator" || artifact.role_id !== "ai_semantic_source_adjudicator_v1") errors.push("adjudicator stage identity is invalid");
  if (artifact.reviewer_kind !== "ai" || artifact.human_reviewed !== false || artifact.method_attribution_approved !== false || artifact.production_effect !== "none") errors.push("machine-only boundary is invalid");
  if (!CANONICAL_MASTER_IDS.includes(artifact.persona_id) || typeof artifact.candidate_id !== "string") errors.push("candidate identity is invalid");
  for (const item of Object.values(artifact.binding_checks || {})) if (item?.status !== "pass" || typeof item.detail !== "string") errors.push("binding check did not pass");
  for (const value of Object.values(artifact.source_binding || {}).filter((item) => typeof item === "string" && item.startsWith("sha256:"))) if (!HASH.test(value)) errors.push("source binding hash is invalid");
  if (!Array.isArray(artifact.proposition_adjudications)) errors.push("proposition_adjudications must be an array");
  else for (const [index, review] of artifact.proposition_adjudications.entries()) {
    if (!VERDICT_SET.has(review.final_verdict)) errors.push(`proposition_adjudications[${index}] verdict is invalid`);
    if (review.exact_content_binding?.binding_status !== "exact") errors.push(`proposition_adjudications[${index}] exact binding failed`);
    for (const name of ["extractor_snippet_hash", "skeptic_snippet_hash_claimed", "skeptic_snippet_hash_recomputed", "adjudicator_snippet_hash_recomputed"]) {
      if (!HASH.test(review.exact_content_binding?.[name] || "")) errors.push(`proposition_adjudications[${index}].${name} is invalid`);
    }
    if (!isStringArray(review.agreements) || !isStringArray(review.disagreements)) errors.push(`proposition_adjudications[${index}] agreement arrays are invalid`);
    for (const kind of ["authorship", "scope", "date"]) if (!isStringArray(review.unresolved_questions?.[kind])) errors.push(`proposition_adjudications[${index}] unresolved ${kind} questions are invalid`);
    if (review.review_hash !== reviewHash(review)) errors.push(`proposition_adjudications[${index}] review_hash is invalid`);
  }
  if (!VERDICT_SET.has(artifact.final_overall_verdict) || artifact.final_overall_verdict !== overallVerdict(artifact.proposition_adjudications || [])) errors.push("final_overall_verdict is invalid");
  for (const kind of ["authorship", "scope", "date"]) if (!isStringArray(artifact.unresolved_questions?.[kind])) errors.push(`unresolved ${kind} questions are invalid`);
  if (!HASH.test(artifact.artifact_hash || "") || artifact.artifact_hash !== artifactHash(artifact)) errors.push("artifact_hash is invalid");
  if (expected && canonicalJson(artifact) !== canonicalJson(expected)) errors.push("artifact differs from third-process raw-source reconstruction");
  return errors;
}

function expectedEntries({ root, extractionRoot, skepticRoot, productionRoot, personaDir, pdftotext, now }) {
  const sourceRoot = safeRoot(root, "source staging root", { source: true });
  const extractorRoot = safeRoot(extractionRoot, "semantic extraction root");
  const skepticReviewRoot = safeRoot(skepticRoot, "semantic skeptic root");
  const inventory = inspectSourceAcquisitions({ root: sourceRoot, productionRoot, personaDir, now });
  const judgments = new Map(SEMANTIC_SOURCE_ADJUDICATION_CATALOG.map((item) => [item.proposition_id, item]));
  if (judgments.size !== SEMANTIC_SOURCE_ADJUDICATION_CATALOG.length) throw new Error("independent adjudicator catalog has duplicate proposition ids");
  for (const judgment of judgments.values()) {
    if (!VERDICT_SET.has(judgment.verdict) || typeof judgment.rationale !== "string" || !judgment.rationale.trim()) throw new Error(`${judgment.proposition_id}: independent adjudicator judgment is invalid`);
  }
  const entries = [];
  for (const seat of inventory.personas) for (const record of seat.records) {
    const relativePath = `${record.persona_id}/${record.candidate_id}.json`;
    const extractorArtifact = readJson(extractorRoot, relativePath, "semantic extractor artifact");
    const skepticArtifact = readJson(skepticReviewRoot, relativePath, "semantic skeptic artifact");
    const archivePath = join(sourceRoot, record.persona_id, record.archive_path);
    if (!within(join(sourceRoot, record.persona_id), archivePath) || lstatSync(archivePath).isSymbolicLink()) throw new Error(`${record.candidate_id}: source.bin path is unsafe`);
    const bytes = readFileSync(archivePath);
    const artifact = buildArtifact({ record, bytes, archivePath, extractorArtifact, extractorPath: relativePath, skepticArtifact, skepticPath: relativePath, judgments, pdftotext });
    entries.push({ record, artifact });
  }
  const expectedCandidateCount = new Set(SEMANTIC_SOURCE_ADJUDICATION_CATALOG
    .map((item) => item.proposition_id.split(":p", 1)[0])).size;
  if (entries.length !== expectedCandidateCount) throw new Error(`semantic adjudication requires exactly ${expectedCandidateCount} candidates; got ${entries.length}`);
  const propositionIds = new Set(entries.flatMap((entry) => entry.artifact.proposition_adjudications.map((item) => item.proposition_id)));
  if (propositionIds.size !== judgments.size || [...judgments.keys()].some((id) => !propositionIds.has(id))) throw new Error(`independent adjudicator catalog must cover every proposition exactly; got ${judgments.size}/${propositionIds.size}`);
  entries.sort((a, b) => `${a.record.persona_id}/${a.record.candidate_id}`.localeCompare(`${b.record.persona_id}/${b.record.candidate_id}`));
  return entries;
}

function counts(values) {
  return Object.fromEntries(VERDICTS.map((key) => [key, values.filter((value) => value === key).length]));
}

function buildIndex(entries) {
  const reviews = entries.flatMap((entry) => entry.artifact.proposition_adjudications);
  const subject = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_ai_semantic_source_adjudication_index",
    review_stage: "round_3_semantic_adjudication",
    reviewer_kind: "ai",
    role: "adjudicator",
    human_reviewed_count: 0,
    method_attribution_approved_count: 0,
    production_effect: "none",
    canonical_master_count: CANONICAL_MASTER_COUNT,
    seats_with_candidates: new Set(entries.map((entry) => entry.record.persona_id)).size,
    candidate_count: entries.length,
    proposition_adjudication_count: reviews.length,
    proposition_verdict_counts: counts(reviews.map((review) => review.final_verdict)),
    candidate_verdict_counts: counts(entries.map((entry) => entry.artifact.final_overall_verdict)),
    binding_pass_count: entries.filter((entry) => Object.values(entry.artifact.binding_checks).every((item) => item.status === "pass")).length,
    skeptic_agreement_count: reviews.filter((review) => review.skeptic_claim.adjudicator_relation === "agree").length,
    skeptic_disagreement_count: reviews.filter((review) => review.skeptic_claim.adjudicator_relation === "disagree").length,
    artifacts: entries.map((entry) => ({
      persona_id: entry.record.persona_id,
      candidate_id: entry.record.candidate_id,
      relative_path: `${entry.record.persona_id}/${entry.record.candidate_id}.json`,
      content_hash: entry.record.content_hash,
      extractor_artifact_hash: entry.artifact.extractor_binding.declared_artifact_hash,
      skeptic_artifact_hash: entry.artifact.skeptic_binding.declared_artifact_hash,
      adjudication_artifact_hash: entry.artifact.artifact_hash,
      final_overall_verdict: entry.artifact.final_overall_verdict,
      proposition_adjudication_count: entry.artifact.proposition_adjudications.length,
    })),
  });
  return canonicalValue({ ...subject, index_hash: sha256({ domain: "alphacouncil.semantic-source-adjudication-index.v1", subject }) });
}

function report(entries, outputRoot, errors = []) {
  const index = buildIndex(entries);
  return canonicalValue({ valid: errors.length === 0, root: resolve(outputRoot), valid_artifact_count: errors.length ? 0 : entries.length, ...index, production_write_count: 0, errors });
}

export function writeSemanticSourceAdjudications({
  root = defaultStagingRoot(),
  extractionRoot = defaultSemanticSourceExtractionRoot({ stagingRoot: root }),
  skepticRoot = defaultSemanticSourceSkepticRoot({ stagingRoot: root }),
  outputRoot = defaultSemanticSourceAdjudicationRoot({ stagingRoot: root }),
  productionRoot = defaultKnowledgeDir(), personaDir = defaultPersonaDir(),
  pdftotext = resolvePdfToText(), now = new Date(),
} = {}) {
  const entries = expectedEntries({ root, extractionRoot, skepticRoot, productionRoot, personaDir, pdftotext, now });
  const target = safeRoot(outputRoot, "semantic adjudication output root", { create: true });
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
  return canonicalValue({ ...report(entries, target), wrote_file_count: wrote });
}

export function inspectSemanticSourceAdjudications({
  root = defaultStagingRoot(),
  extractionRoot = defaultSemanticSourceExtractionRoot({ stagingRoot: root }),
  skepticRoot = defaultSemanticSourceSkepticRoot({ stagingRoot: root }),
  outputRoot = defaultSemanticSourceAdjudicationRoot({ stagingRoot: root }),
  productionRoot = defaultKnowledgeDir(), personaDir = defaultPersonaDir(),
  pdftotext = resolvePdfToText(), now = new Date(),
} = {}) {
  const entries = expectedEntries({ root, extractionRoot, skepticRoot, productionRoot, personaDir, pdftotext, now });
  const errors = [];
  if (!existsSync(outputRoot) || lstatSync(outputRoot).isSymbolicLink() || !statSync(outputRoot).isDirectory()) errors.push("semantic adjudication output root is missing or unsafe");
  else {
    const expectedTop = new Set([...new Set(entries.map((entry) => entry.record.persona_id)), "index.json"]);
    for (const item of readdirSync(outputRoot, { withFileTypes: true })) if (!expectedTop.has(item.name) || item.isSymbolicLink()) errors.push(`${item.name}: unexpected adjudication artifact`);
    for (const entry of entries) {
      const file = join(outputRoot, entry.record.persona_id, `${entry.record.candidate_id}.json`);
      if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) { errors.push(`${file}: missing or unsafe`); continue; }
      try {
        const artifact = JSON.parse(readFileSync(file, "utf8"));
        errors.push(...validateSemanticSourceAdjudicationArtifact(artifact, { expected: entry.artifact }).map((error) => `${entry.record.candidate_id}: ${error}`));
      } catch (error) { errors.push(`${entry.record.candidate_id}: ${error.message}`); }
    }
    const indexFile = join(outputRoot, "index.json");
    if (!existsSync(indexFile) || lstatSync(indexFile).isSymbolicLink() || !statSync(indexFile).isFile()) errors.push("semantic adjudication index is missing or unsafe");
    else {
      try { if (canonicalJson(JSON.parse(readFileSync(indexFile, "utf8"))) !== canonicalJson(buildIndex(entries))) errors.push("semantic adjudication index differs"); }
      catch (error) { errors.push(`semantic adjudication index: ${error.message}`); }
    }
  }
  return report(entries, outputRoot, errors);
}
