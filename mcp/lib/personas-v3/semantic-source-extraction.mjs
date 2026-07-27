/** Round-1, machine-labelled semantic extraction from archived source bytes. */

import { spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { SEMANTIC_SOURCE_REVIEW_CATALOG } from "../../../data/persona-v3-semantic-source-reviews.v1.mjs";
import { defaultKnowledgeDir } from "./admission.mjs";
import { canonicalJson, canonicalValue, sha256 } from "./canonical.mjs";
import { inspectSourceAcquisitions, sha256Bytes } from "./source-acquisition.mjs";
import { CANONICAL_MASTER_IDS, defaultStagingRoot } from "./staging.mjs";
import { defaultPersonaDir } from "../personas/registry.mjs";

const HASH = /^sha256:[a-f0-9]{64}$/u;
const REVIEW_STATUSES = new Set(["readable", "partial", "unreadable"]);
const SUPPORT = new Set(["direct", "partial", "contextual"]);
const PIPELINE_ID = "alphacouncil_ai_semantic_source_extractor_v1";
const PDF_MAX_BUFFER = 96 * 1024 * 1024;

export const SEMANTIC_SOURCE_EXTRACTOR_PROMPT = [
  "Read only the archived source bytes supplied for one PersonaPack candidate.",
  "Extract a concise source summary and only method propositions directly supported by the readable material.",
  "Bind every proposition to an exact short excerpt and PDF page or HTML text offset.",
  "Record contradictions, ambiguities, and open questions; use partial or unreadable when the archive is insufficient.",
  "Do not use model memory to fill missing source content, impersonate a human, approve method attribution, or affect production.",
].join(" ");

export const SEMANTIC_EXTRACTOR_MODEL_IDENTITY = Object.freeze({
  provider: "OpenAI",
  product: "Codex collaborating agent",
  model_family: "GPT-5",
  exact_deployment_id: "not_exposed_to_agent",
  agent_task_id: "/root/ai_source_review_lane",
});

function decodeEntities(value) {
  const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"', rsquo: "’", lsquo: "‘", ndash: "–", mdash: "—" };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? match;
  });
}

export function normalizeExtractedText(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function htmlText(bytes) {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const withoutInvisible = decoded
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(script|style|noscript|svg|nav|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<(br|hr)\b[^>]*\/?\s*>/giu, "\n")
    .replace(/<\/(p|div|section|article|header|h[1-6]|li|tr|table)\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ");
  return normalizeExtractedText(decodeEntities(withoutInvisible));
}

export function resolvePdfToText(explicit = process.env.ALPHACOUNCIL_PDFTOTEXT) {
  const candidates = [
    explicit,
    "/opt/homebrew/bin/pdftotext",
    "/usr/local/bin/pdftotext",
    "/usr/bin/pdftotext",
    join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/bin/pdftotext"),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)
    && !lstatSync(candidate).isSymbolicLink() && statSync(candidate).isFile()) ?? null;
}

function pdfText(archivePath, pdftotext) {
  if (!pdftotext) return { error: "pdftotext_unavailable", pages: [] };
  const result = spawnSync(pdftotext, ["-layout", "-enc", "UTF-8", archivePath, "-"], {
    encoding: "utf8",
    maxBuffer: PDF_MAX_BUFFER,
    timeout: 120_000,
  });
  if (result.error) return { error: `pdftotext_error:${result.error.message}`, pages: [] };
  if (result.status !== 0) return { error: `pdftotext_exit_${result.status}:${String(result.stderr).trim()}`, pages: [] };
  const pages = result.stdout.split("\f").map(normalizeExtractedText);
  while (pages.length > 1 && pages.at(-1) === "") pages.pop();
  return { error: null, pages };
}

export function extractArchivedSourceText({ record, bytes, archivePath, pdftotext = resolvePdfToText() }) {
  if (sha256Bytes(bytes) !== record.content_hash || bytes.length !== record.byte_length) {
    throw new Error(`${record.persona_id}/${record.candidate_id}: raw archive binding failed`);
  }
  const isPdf = String(record.content_type || "").toLowerCase().includes("pdf");
  const extracted = isPdf ? pdfText(archivePath, pdftotext) : { error: null, pages: [htmlText(bytes)] };
  const pageCharacterCounts = extracted.pages.map((page) => page.length);
  const textSubject = {
    extractor: isPdf ? "poppler_pdftotext_layout_utf8" : "alphacouncil_html_visible_text_v1",
    pages: extracted.pages,
  };
  return canonicalValue({
    extraction_tool: textSubject.extractor,
    extraction_error: extracted.error,
    page_count: extracted.pages.length,
    page_character_counts: pageCharacterCounts,
    extracted_character_count: pageCharacterCounts.reduce((sum, count) => sum + count, 0),
    extracted_text_hash: sha256({ domain: "alphacouncil.semantic-source-extracted-text.v1", ...textSubject }),
    pages: extracted.pages,
  });
}

function locateEvidence(extraction, excerpt, { section = null, expected_page: expectedPage = null } = {}) {
  const normalized = normalizeExtractedText(excerpt);
  for (const [index, pageText] of extraction.pages.entries()) {
    const start = pageText.indexOf(normalized);
    if (start < 0) continue;
    const pageNumber = index + 1;
    if (expectedPage !== null && expectedPage !== pageNumber) {
      throw new Error(`excerpt page drift: expected ${expectedPage}, found ${pageNumber}`);
    }
    return canonicalValue({
      kind: extraction.page_count > 1 ? "pdf_page" : "html_text_offset",
      page: extraction.page_count > 1 ? pageNumber : null,
      section,
      text_start: extraction.page_count > 1 ? null : start,
      text_end: extraction.page_count > 1 ? null : start + normalized.length,
    });
  }
  throw new Error(`evidence excerpt not found in extracted archive text: ${normalized.slice(0, 100)}`);
}

function proposition(record, extraction, item, index) {
  const excerpt = normalizeExtractedText(item.evidence_excerpt);
  const locator = locateEvidence(extraction, excerpt, item.locator);
  return canonicalValue({
    proposition_id: `${record.candidate_id}:p${index + 1}`,
    statement: item.statement,
    support_strength: item.support_strength,
    locator,
    evidence_excerpt: excerpt,
    snippet_hash: sha256({
      domain: "alphacouncil.semantic-source-evidence-snippet.v1",
      content_hash: record.content_hash,
      extracted_text_hash: extraction.extracted_text_hash,
      locator,
      normalized_excerpt: excerpt,
    }),
  });
}

function artifactSubject({ record, extraction, review }) {
  const promptHash = sha256({
    domain: "alphacouncil.semantic-source-extractor-prompt.v1",
    prompt_id: "alphacouncil.source-semantic-extractor.round1.v1",
    prompt: SEMANTIC_SOURCE_EXTRACTOR_PROMPT,
  });
  const methodPropositions = review.method_propositions.map((item, index) => proposition(record, extraction, item, index));
  return canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_ai_semantic_source_extraction",
    pipeline_id: PIPELINE_ID,
    review_stage: "round_1_semantic_extraction",
    reviewer_kind: "ai",
    role: "extractor",
    role_id: "ai_semantic_source_extractor_v1",
    prompt_identity: {
      prompt_id: "alphacouncil.source-semantic-extractor.round1.v1",
      prompt_hash: promptHash,
    },
    model_identity: SEMANTIC_EXTRACTOR_MODEL_IDENTITY,
    reviewed_on: "2026-07-27",
    human_reviewed: false,
    method_attribution_approved: false,
    production_effect: "none",
    persona_id: record.persona_id,
    candidate_id: record.candidate_id,
    source_binding: {
      content_hash: record.content_hash,
      byte_length: record.byte_length,
      record_hash: sha256(record),
      content_type: record.content_type,
      final_url: record.final_url,
      retrieved_at: record.retrieved_at,
      raw_bytes_reverified: true,
      extraction_tool: extraction.extraction_tool,
      extraction_error: extraction.extraction_error,
      extracted_text_hash: extraction.extracted_text_hash,
      extracted_character_count: extraction.extracted_character_count,
      page_count: extraction.page_count,
      page_character_counts: extraction.page_character_counts,
    },
    readability: { status: review.readability, reason: review.readability_reason },
    language: review.language,
    source_type: review.source_type,
    concise_summary: review.concise_summary,
    method_propositions: methodPropositions,
    contradictions_ambiguities: review.contradictions_ambiguities,
    open_questions: review.open_questions,
  });
}

export function buildSemanticSourceExtractionArtifact({ record, bytes, archivePath, review, pdftotext }) {
  const extraction = extractArchivedSourceText({ record, bytes, archivePath, pdftotext });
  const subject = artifactSubject({ record, extraction, review });
  return canonicalValue({
    ...subject,
    artifact_hash: sha256({ domain: "alphacouncil.semantic-source-extraction-artifact.v1", subject }),
  });
}

export function semanticSourceExtractionArtifactHash(artifact) {
  const { artifact_hash: ignored, ...subject } = artifact;
  return sha256({ domain: "alphacouncil.semantic-source-extraction-artifact.v1", subject: canonicalValue(subject) });
}

function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim());
}

export function validateSemanticSourceExtractionArtifact(artifact, { expected = null } = {}) {
  const errors = [];
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return ["semantic extraction must be an object"];
  if (artifact.schema_version !== 1 || artifact.artifact_kind !== "persona_v3_ai_semantic_source_extraction") errors.push("artifact identity is invalid");
  if (artifact.pipeline_id !== PIPELINE_ID || artifact.review_stage !== "round_1_semantic_extraction") errors.push("pipeline/review stage is invalid");
  if (artifact.reviewer_kind !== "ai" || artifact.role !== "extractor" || artifact.role_id !== "ai_semantic_source_extractor_v1") errors.push("machine extractor role identity is invalid");
  if (artifact.human_reviewed !== false || artifact.method_attribution_approved !== false || artifact.production_effect !== "none") errors.push("human/production boundary is invalid");
  if (!CANONICAL_MASTER_IDS.includes(artifact.persona_id) || typeof artifact.candidate_id !== "string") errors.push("candidate identity is invalid");
  if (!HASH.test(artifact.source_binding?.content_hash || "") || !HASH.test(artifact.source_binding?.record_hash || "")
    || !HASH.test(artifact.source_binding?.extracted_text_hash || "") || artifact.source_binding?.raw_bytes_reverified !== true) errors.push("source binding is invalid");
  if (!REVIEW_STATUSES.has(artifact.readability?.status) || typeof artifact.readability?.reason !== "string") errors.push("readability is invalid");
  if (typeof artifact.language !== "string" || typeof artifact.source_type !== "string" || typeof artifact.concise_summary !== "string") errors.push("semantic metadata is invalid");
  if (!Array.isArray(artifact.method_propositions)) errors.push("method_propositions must be an array");
  else for (const [index, item] of artifact.method_propositions.entries()) {
    if (typeof item.statement !== "string" || !SUPPORT.has(item.support_strength)) errors.push(`method_propositions[${index}] statement/support is invalid`);
    if (!HASH.test(item.snippet_hash || "") || typeof item.evidence_excerpt !== "string" || !item.evidence_excerpt.trim()) errors.push(`method_propositions[${index}] evidence is invalid`);
    if (!item.locator || !["pdf_page", "html_text_offset"].includes(item.locator.kind)) errors.push(`method_propositions[${index}] locator is invalid`);
  }
  if (!strings(artifact.contradictions_ambiguities) || !strings(artifact.open_questions)) errors.push("ambiguities/open questions must be non-empty string arrays");
  if (!HASH.test(artifact.artifact_hash || "") || semanticSourceExtractionArtifactHash(artifact) !== artifact.artifact_hash) errors.push("artifact_hash is invalid");
  if (expected && canonicalJson(artifact) !== canonicalJson(expected)) errors.push("artifact differs from deterministic raw-source reconstruction");
  return errors;
}

export function defaultSemanticSourceExtractionRoot({ stagingRoot = defaultStagingRoot() } = {}) {
  return process.env.ALPHACOUNCIL_SEMANTIC_SOURCE_EXTRACTION_DIR
    || resolve(dirname(dirname(stagingRoot)), "ai-assisted-solo", "reviews", "persona-v3-ai-semantic-extractions");
}

function expectedEntries({ root, productionRoot, personaDir, pdftotext, now }) {
  const inventory = inspectSourceAcquisitions({ root, productionRoot, personaDir, now });
  const catalog = new Map(SEMANTIC_SOURCE_REVIEW_CATALOG.map((item) => [item.candidate_id, item]));
  const entries = [];
  for (const seat of inventory.personas) for (const record of seat.records) {
    const review = catalog.get(record.candidate_id);
    if (!review) throw new Error(`${record.candidate_id}: semantic review catalog entry is missing`);
    if (review.persona_id !== record.persona_id) throw new Error(`${record.candidate_id}: catalog persona mismatch`);
    const archivePath = join(root, record.persona_id, record.archive_path);
    const bytes = readFileSync(archivePath);
    const artifact = buildSemanticSourceExtractionArtifact({ record, bytes, archivePath, review, pdftotext });
    entries.push({ record, review, artifact, archivePath, bytes });
  }
  if (catalog.size !== entries.length) throw new Error(`semantic review catalog has ${catalog.size} entries for ${entries.length} acquisitions`);
  entries.sort((a, b) => `${a.record.persona_id}/${a.record.candidate_id}`.localeCompare(`${b.record.persona_id}/${b.record.candidate_id}`));
  return entries;
}

function buildIndex(entries) {
  const subject = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_ai_semantic_source_extraction_index",
    review_stage: "round_1_semantic_extraction",
    reviewer_kind: "ai",
    role: "extractor",
    human_reviewed_count: 0,
    method_attribution_approved_count: 0,
    production_effect: "none",
    canonical_master_count: 26,
    seats_with_candidates: new Set(entries.map((entry) => entry.record.persona_id)).size,
    candidate_count: entries.length,
    readability_counts: Object.fromEntries(["readable", "partial", "unreadable"].map((status) => [status, entries.filter((entry) => entry.artifact.readability.status === status).length])),
    proposition_count: entries.reduce((sum, entry) => sum + entry.artifact.method_propositions.length, 0),
    artifacts: entries.map((entry) => ({
      persona_id: entry.record.persona_id,
      candidate_id: entry.record.candidate_id,
      relative_path: `${entry.record.persona_id}/${entry.record.candidate_id}.json`,
      content_hash: entry.record.content_hash,
      artifact_hash: entry.artifact.artifact_hash,
      readability: entry.artifact.readability.status,
      proposition_count: entry.artifact.method_propositions.length,
    })),
  });
  return canonicalValue({ ...subject, index_hash: sha256({ domain: "alphacouncil.semantic-source-extraction-index.v1", subject }) });
}

export function writeSemanticSourceExtractions({
  root = defaultStagingRoot(), outputRoot = defaultSemanticSourceExtractionRoot({ stagingRoot: root }),
  productionRoot = defaultKnowledgeDir(), personaDir = defaultPersonaDir(), pdftotext = resolvePdfToText(), now = new Date(),
} = {}) {
  const entries = expectedEntries({ root, productionRoot, personaDir, pdftotext, now });
  mkdirSync(outputRoot, { recursive: true });
  let wrote = 0;
  for (const entry of entries) {
    const seatDir = join(outputRoot, entry.record.persona_id);
    mkdirSync(seatDir, { recursive: true });
    const file = join(seatDir, `${entry.record.candidate_id}.json`);
    const serialized = `${JSON.stringify(entry.artifact, null, 2)}\n`;
    if (existsSync(file)) {
      if (readFileSync(file, "utf8") !== serialized) throw new Error(`${file}: differs; refusing overwrite`);
    } else { writeFileSync(file, serialized, { flag: "wx", mode: 0o600 }); wrote += 1; }
  }
  const index = buildIndex(entries);
  const indexFile = join(outputRoot, "index.json");
  const serializedIndex = `${JSON.stringify(index, null, 2)}\n`;
  if (existsSync(indexFile)) {
    if (readFileSync(indexFile, "utf8") !== serializedIndex) throw new Error(`${indexFile}: differs; refusing overwrite`);
  } else { writeFileSync(indexFile, serializedIndex, { flag: "wx", mode: 0o600 }); wrote += 1; }
  return { ...inspectSemanticSourceExtractions({ root, outputRoot, productionRoot, personaDir, pdftotext, now }), wrote_file_count: wrote };
}

export function inspectSemanticSourceExtractions({
  root = defaultStagingRoot(), outputRoot = defaultSemanticSourceExtractionRoot({ stagingRoot: root }),
  productionRoot = defaultKnowledgeDir(), personaDir = defaultPersonaDir(), pdftotext = resolvePdfToText(), now = new Date(),
} = {}) {
  const entries = expectedEntries({ root, productionRoot, personaDir, pdftotext, now });
  const errors = [];
  let validArtifactCount = 0;
  if (!existsSync(outputRoot) || lstatSync(outputRoot).isSymbolicLink() || !statSync(outputRoot).isDirectory()) errors.push("semantic extraction output root is missing or unsafe");
  else {
    const expectedSeats = new Set(entries.map((entry) => entry.record.persona_id));
    for (const item of readdirSync(outputRoot, { withFileTypes: true })) {
      if (item.name === "index.json" && item.isFile()) continue;
      if (!expectedSeats.has(item.name) || !item.isDirectory() || item.isSymbolicLink()) errors.push(`${item.name}: unexpected output artifact`);
    }
    for (const entry of entries) {
      const file = join(outputRoot, entry.record.persona_id, `${entry.record.candidate_id}.json`);
      if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) { errors.push(`${file}: missing or unsafe`); continue; }
      let artifact;
      try { artifact = JSON.parse(readFileSync(file, "utf8")); } catch (error) { errors.push(`${file}: ${error.message}`); continue; }
      const validation = validateSemanticSourceExtractionArtifact(artifact, { expected: entry.artifact });
      errors.push(...validation.map((error) => `${entry.record.candidate_id}: ${error}`));
      if (!validation.length) validArtifactCount += 1;
    }
    const indexFile = join(outputRoot, "index.json");
    if (!existsSync(indexFile) || lstatSync(indexFile).isSymbolicLink() || !statSync(indexFile).isFile()) errors.push("semantic extraction index is missing or unsafe");
    else {
      try { if (canonicalJson(JSON.parse(readFileSync(indexFile, "utf8"))) !== canonicalJson(buildIndex(entries))) errors.push("semantic extraction index differs"); }
      catch (error) { errors.push(`semantic extraction index: ${error.message}`); }
    }
  }
  const index = buildIndex(entries);
  return canonicalValue({
    valid: errors.length === 0,
    root: resolve(outputRoot),
    candidate_count: entries.length,
    valid_artifact_count: validArtifactCount,
    seats_with_candidates: index.seats_with_candidates,
    readability_counts: index.readability_counts,
    proposition_count: index.proposition_count,
    human_reviewed_count: 0,
    method_attribution_approved_count: 0,
    production_write_count: 0,
    index_hash: index.index_hash,
    errors,
  });
}
