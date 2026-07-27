/**
 * Read-only status gate for the isolated AI-assisted solo assurance profile.
 *
 * This module deliberately does not import or call the production release assembler, the
 * production loader, human source/formula attestation code, or the formal GA gate. Machine
 * cross-review can improve local test visibility; it can never be translated into a human
 * approval, production admission, method_model, or formal-GA claim.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalValue, sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import {
  validateAiSourcePreReviewArtifact as validateSourcePreReviewContract,
} from "../../mcp/lib/personas-v3/ai-source-pre-review.mjs";
import { assessErrorNeff } from "../../mcp/lib/personas-v3/n-eff.mjs";
import { inspectPersonaV3SoloTestPacks } from "./persona-v3-solo-test-packs.mjs";
import {
  AI_MACHINE_SIMULATION_RUN_IDS,
  verifyAIMachineSimulationTree,
} from "./persona-v3-ai-machine-simulations.mjs";
import {
  EXTERNAL_HOST_IDS,
  checkExternalHostE2eFile,
} from "./external-host-e2e-artifacts.mjs";
import {
  inspectSemanticSourceExtractions,
  validateSemanticSourceExtractionArtifact,
} from "../../mcp/lib/personas-v3/semantic-source-extraction.mjs";
import {
  inspectSemanticSourceSkepticReviews,
  validateSemanticSourceSkepticArtifact,
} from "../../mcp/lib/personas-v3/semantic-source-skeptic-review.mjs";
import {
  inspectSemanticSourceAdjudications,
  validateSemanticSourceAdjudicationArtifact,
} from "../../mcp/lib/personas-v3/semantic-source-adjudication.mjs";

export const AI_ASSISTED_SOLO_PROFILE_ID = "ai_assisted_solo";
export const AI_ASSISTED_SOLO_ASSURANCE = "machine_cross_review_only";
export const DEFAULT_AI_ASSISTED_SOLO_PROFILE = fileURLToPath(new URL(
  "../../data/persona-v3-ai-assisted-solo-profile.v1.json",
  import.meta.url,
));
export const AI_SOURCE_ROLE_IDS = Object.freeze(["extractor", "skeptic", "adjudicator"]);
export const AI_FORMULA_ROLE_IDS = Object.freeze(["deriver", "adversarial_checker", "adjudicator"]);

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HASH = /^sha256:[a-f0-9]{64}$/u;
const FORMULA_SUBJECT_DOMAIN = "alphacouncil.persona-v3.ai-formula-review-subject.v1";
const FORMULA_PROMPT_DOMAIN = "alphacouncil.persona-v3.ai-formula-review-prompt.v1";
const FORMULA_ARTIFACT_DOMAIN = "alphacouncil.persona-v3.ai-formula-cross-review-artifact.v1";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bytesHash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function omit(value, field) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

function inside(base, target) {
  const back = relative(base, target);
  return back === "" || (back !== ".." && !back.startsWith(`..${sep}`) && !isAbsolute(back));
}

function physicalBytes(file, label) {
  const absolute = resolve(file);
  let descriptor;
  try {
    if (!existsSync(absolute)) throw new Error(`${label} is missing: ${absolute}`);
    if (lstatSync(absolute).isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${absolute}`);
    descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    if (!fstatSync(descriptor).isFile()) throw new Error(`${label} must be a physical regular file: ${absolute}`);
    return Object.freeze({
      path: realpathSync(absolute),
      bytes: readFileSync(descriptor),
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function physicalJson(file, label) {
  const opened = physicalBytes(file, label);
  try {
    return Object.freeze({ ...opened, value: JSON.parse(opened.bytes.toString("utf8")) });
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function physicalDirectory(path, label, { optional = false } = {}) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    if (optional) return null;
    throw new Error(`${label} is missing: ${absolute}`);
  }
  if (lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isDirectory()) {
    throw new Error(`${label} must be a physical, non-symlinked directory: ${absolute}`);
  }
  return realpathSync(absolute);
}

function safeArtifactPath(root, recorded, label) {
  if (typeof recorded !== "string" || !recorded.trim()) throw new Error(`${label} must be a non-empty path`);
  const target = isAbsolute(recorded) ? resolve(recorded) : resolve(root, recorded);
  if (!inside(root, target)) throw new Error(`${label} escapes repository root`);
  const opened = physicalBytes(target, label);
  if (!inside(root, opened.path)) throw new Error(`${label} resolves outside repository root`);
  return opened;
}

function recursiveJsonFiles(root, exclusions = new Set()) {
  if (!root) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = resolve(directory, entry.name);
      if (!inside(root, target)) throw new Error(`artifact scan escaped root: ${target}`);
      if (entry.isSymbolicLink()) throw new Error(`artifact tree contains a symlink: ${target}`);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith(".json") && !exclusions.has(entry.name)) files.push(target);
    }
  };
  visit(root);
  return files;
}

function validateDistinctRolePrompts(roles, expectedIds, path, errors) {
  if (!isObject(roles)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const actual = Object.keys(roles).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expectedIds].sort())) {
    errors.push(`${path} must contain exactly ${expectedIds.join(", ")}`);
    return;
  }
  const roleIds = [];
  const promptIds = [];
  const promptHashes = [];
  for (const expected of expectedIds) {
    const role = roles[expected];
    if (!isObject(role)) { errors.push(`${path}.${expected} must be an object`); continue; }
    if (role.role_id !== expected) errors.push(`${path}.${expected}.role_id must be ${expected}`);
    if (typeof role.prompt_id !== "string" || !role.prompt_id.trim()) errors.push(`${path}.${expected}.prompt_id is required`);
    if (!HASH.test(role.prompt_hash || "")) errors.push(`${path}.${expected}.prompt_hash is invalid`);
    roleIds.push(role.role_id);
    promptIds.push(role.prompt_id);
    promptHashes.push(role.prompt_hash);
  }
  if (new Set(roleIds).size !== expectedIds.length) errors.push(`${path} role IDs must be distinct`);
  if (new Set(promptIds).size !== expectedIds.length) errors.push(`${path} prompt IDs must be distinct`);
  if (new Set(promptHashes).size !== expectedIds.length) errors.push(`${path} prompt hashes must be distinct`);
}

export function validateAiSourcePrereviewArtifact(artifact, options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const sourcePathRoot = Object.hasOwn(options, "sourcePathRoot")
    ? options.sourcePathRoot
    : resolve(repoRoot, "knowledge/staging");
  const errors = [];
  if (!isObject(artifact)) return { valid: false, errors: ["artifact must be an object"] };
  const binding = artifact.source_binding;
  let record = null;
  let bytes = null;
  if (!isObject(binding)) errors.push("source_binding must be an object");
  else if (sourcePathRoot !== null) {
    try {
      const opened = safeArtifactPath(resolve(sourcePathRoot), binding.record_relative_path, "source acquisition record");
      record = JSON.parse(opened.bytes.toString("utf8"));
    } catch (error) { errors.push(error.message); }
    try {
      bytes = safeArtifactPath(resolve(sourcePathRoot), binding.archive_relative_path, "archived source bytes").bytes;
    } catch (error) { errors.push(error.message); }
  }
  if (record && bytes) errors.push(...validateSourcePreReviewContract(artifact, { record, bytes }));
  else errors.push(...validateSourcePreReviewContract(artifact));
  return canonicalValue({
    valid: errors.length === 0,
    errors,
    persona_id: artifact.persona_id || null,
    candidate_id: artifact.candidate_id || null,
    artifact_hash: artifact.artifact_hash || null,
    verification_mode: record && bytes ? "raw_revalidated" : "packaged_capsule_only",
  });
}

export function validateAiFormulaCrossReviewArtifact(artifact, { reviewSchema = null } = {}) {
  const errors = [];
  if (!isObject(artifact)) return { valid: false, errors: ["artifact must be an object"] };
  if (artifact.schema_version !== 1 || artifact.artifact_kind !== "persona_v3_ai_formula_cross_review") errors.push("formula cross-review header is invalid");
  if (artifact.reviewer_kind !== "ai" || artifact.assurance_class !== "provisional_ai_cross_review") errors.push("formula cross-review must use AI-only assurance");
  if (artifact.execution_mode !== "deterministic_review_harness") errors.push("formula cross-review execution mode is invalid");
  if (artifact.human_reviewed !== false || artifact.human_claims !== false) errors.push("formula cross-review must explicitly deny human review and human claims");
  if (artifact.production_effect !== "none" || artifact.production_eligible !== false || artifact.method_model_eligible !== false) errors.push("formula cross-review must have no production or method-model effect");
  if (!Array.isArray(artifact.role_sequence) || JSON.stringify(artifact.role_sequence) !== JSON.stringify(AI_FORMULA_ROLE_IDS)) errors.push("formula role_sequence is invalid");
  validateDistinctRolePrompts(artifact.roles, AI_FORMULA_ROLE_IDS, "roles", errors);

  if (reviewSchema !== null) {
    const expected = sha256(reviewSchema);
    if (artifact.review_schema_hash !== expected) errors.push(`review_schema_hash mismatch; expected ${expected}`);
  } else if (!HASH.test(artifact.review_schema_hash || "")) errors.push("review_schema_hash is invalid");
  const expectedSubject = sha256({ hash_domain: FORMULA_SUBJECT_DOMAIN, subject: artifact.review_subject });
  if (artifact.review_subject_hash !== expectedSubject) errors.push(`review_subject_hash mismatch; expected ${expectedSubject}`);

  for (const roleId of AI_FORMULA_ROLE_IDS) {
    const role = artifact.roles?.[roleId];
    if (!isObject(role)) continue;
    if (role.reviewer_kind !== "ai" || role.human_principal !== false) errors.push(`roles.${roleId} must be an AI non-human principal`);
    if (role.subject_hash !== artifact.review_subject_hash) errors.push(`roles.${roleId}.subject_hash mismatch`);
    const expectedPrompt = sha256({
      hash_domain: FORMULA_PROMPT_DOMAIN,
      prompt_id: role.prompt_id,
      prompt_text: role.prompt_text,
    });
    if (role.prompt_hash !== expectedPrompt) errors.push(`roles.${roleId}.prompt_hash mismatch; expected ${expectedPrompt}`);
    const expectedRole = sha256(omit(role, "artifact_hash"));
    if (role.artifact_hash !== expectedRole) errors.push(`roles.${roleId}.artifact_hash mismatch; expected ${expectedRole}`);
    if (artifact.role_artifact_hashes?.[roleId] !== role.artifact_hash) errors.push(`role_artifact_hashes.${roleId} mismatch`);
  }
  if (!HASH.test(artifact.review_artifact_hash || "")) errors.push("review_artifact_hash is invalid");
  else {
    const expected = sha256({
      hash_domain: FORMULA_ARTIFACT_DOMAIN,
      artifact: omit(artifact, "review_artifact_hash"),
    });
    if (artifact.review_artifact_hash !== expected) errors.push(`review_artifact_hash mismatch; expected ${expected}`);
  }
  return canonicalValue({
    valid: errors.length === 0,
    errors,
    persona_id: artifact.persona_id || null,
    tool_id: artifact.tool_id || null,
    review_artifact_hash: artifact.review_artifact_hash || null,
  });
}

function scanSourceReviews(root, required, repoRoot, sourceAcquisitionRoot) {
  const errors = [];
  let directory = null;
  try { directory = physicalDirectory(root, "AI source prereview root", { optional: true }); } catch (error) { errors.push(error.message); }
  let sourceDirectory = null;
  try {
    sourceDirectory = physicalDirectory(sourceAcquisitionRoot, "source acquisition root", { optional: true });
  } catch (error) { errors.push(error.message); }
  const reviews = [];
  if (directory) {
    let files = [];
    try { files = recursiveJsonFiles(directory, new Set(["index.json"])); } catch (error) { errors.push(error.message); }
    for (const file of files) {
      try {
        const opened = physicalJson(file, "AI source prereview");
        const checked = validateAiSourcePrereviewArtifact(opened.value, {
          repoRoot,
          sourcePathRoot: sourceDirectory,
        });
        if (!checked.valid) errors.push(...checked.errors.map((item) => `${relative(directory, file)}: ${item}`));
        else reviews.push({
          ...checked,
          content_hash: opened.value.source_binding.content_hash,
          physical_file_hash: bytesHash(opened.bytes),
          file: opened.path,
        });
      } catch (error) { errors.push(`${relative(directory, file)}: ${error.message}`); }
    }
  }
  const unique = new Set(reviews.map((review) => `${review.persona_id}\u0000${review.candidate_id}`));
  if (unique.size !== reviews.length) errors.push("AI source prereviews contain duplicate persona/candidate bindings");
  if (directory) {
    try {
      const index = physicalJson(resolve(directory, "index.json"), "AI source prereview index").value;
      if (index.reviewer_kind !== "ai" || index.assurance_class !== "machine_pre_review_only"
        || index.human_reviewed_count !== 0 || index.human_claim_count !== 0 || index.production_effect !== "none") {
        errors.push("AI source prereview index crosses the machine-only boundary");
      }
      const expectedHash = sha256({
        domain: "alphacouncil.ai-source-prereview.index.v1",
        subject: omit(index, "index_hash"),
      });
      if (index.index_hash !== expectedHash) errors.push(`AI source prereview index_hash mismatch; expected ${expectedHash}`);
      const byPath = new Map(reviews.map((review) => [
        relative(directory, review.file).split(sep).join("/"),
        review,
      ]));
      if (!Array.isArray(index.artifacts) || index.artifacts.length !== reviews.length) errors.push("AI source prereview index artifact count mismatch");
      else for (const binding of index.artifacts) {
        const review = byPath.get(binding.relative_path);
        if (!review || binding.persona_id !== review.persona_id || binding.candidate_id !== review.candidate_id
          || binding.artifact_hash !== review.artifact_hash || binding.content_hash !== review.content_hash) {
          errors.push(`AI source prereview index binding mismatch: ${binding.relative_path}`);
        }
      }
    } catch (error) { errors.push(error.message); }
  }
  return canonicalValue({
    status: reviews.length === required && errors.length === 0 ? "passed" : "blocked",
    completed: reviews.length,
    required,
    reviewer_kind: "ai",
    human_review_satisfied: false,
    verification_mode: sourceDirectory ? "raw_revalidated" : "packaged_capsule_only",
    raw_source_revalidated_count: sourceDirectory ? reviews.length : 0,
    physical_artifact_hashes: reviews.map((review) => review.physical_file_hash).sort(),
    errors: [...new Set(errors)],
  });
}

function scanFormulaReviews(root, required, repoRoot) {
  const errors = [];
  let directory = null;
  try { directory = physicalDirectory(root, "AI formula review root", { optional: true }); } catch (error) { errors.push(error.message); }
  let schema = null;
  try { schema = physicalJson(resolve(repoRoot, "schemas/persona-v3-ai-formula-cross-review-v1.schema.json"), "AI formula review schema").value; } catch (error) { errors.push(error.message); }
  const reviews = [];
  if (directory) {
    let files = [];
    try { files = recursiveJsonFiles(directory, new Set(["review-manifest.json"])); } catch (error) { errors.push(error.message); }
    for (const file of files) {
      try {
        const opened = physicalJson(file, "AI formula cross-review");
        const checked = validateAiFormulaCrossReviewArtifact(opened.value, { reviewSchema: schema });
        if (!checked.valid) errors.push(...checked.errors.map((item) => `${relative(directory, file)}: ${item}`));
        else reviews.push({
          ...checked,
          canonical_content_hash: sha256(opened.value),
          physical_file_hash: bytesHash(opened.bytes),
          file: opened.path,
        });
      } catch (error) { errors.push(`${relative(directory, file)}: ${error.message}`); }
    }
  }
  const unique = new Set(reviews.map((review) => `${review.persona_id}\u0000${review.tool_id}`));
  if (unique.size !== reviews.length) errors.push("AI formula reviews contain duplicate persona/tool bindings");
  if (directory) {
    try {
      const manifest = physicalJson(resolve(directory, "review-manifest.json"), "AI formula review manifest").value;
      if (manifest.reviewer_kind !== "ai" || manifest.assurance_class !== "provisional_ai_cross_review"
        || manifest.human_reviewed !== false || manifest.human_claims !== false
        || manifest.human_reviewer_count !== 0 || manifest.signature_count !== 0 || manifest.approval_count !== 0
        || manifest.production_effect !== "none" || manifest.production_eligible !== false || manifest.method_model_eligible !== false) {
        errors.push("AI formula review manifest crosses the machine-only boundary");
      }
      const expectedHash = sha256({
        hash_domain: "alphacouncil.persona-v3.ai-formula-cross-review-manifest.v1",
        manifest: omit(manifest, "manifest_hash"),
      });
      if (manifest.manifest_hash !== expectedHash) errors.push(`AI formula review manifest_hash mismatch; expected ${expectedHash}`);
      const byPath = new Map(reviews.map((review) => [
        relative(directory, review.file).split(sep).join("/"),
        review,
      ]));
      if (!Array.isArray(manifest.bindings) || manifest.bindings.length !== reviews.length) errors.push("AI formula review manifest binding count mismatch");
      else for (const binding of manifest.bindings) {
        const review = byPath.get(binding.path);
        if (!review || binding.persona_id !== review.persona_id || binding.tool_id !== review.tool_id
          || binding.review_artifact_hash !== review.review_artifact_hash
          || binding.review_file_content_hash !== review.canonical_content_hash) {
          errors.push(`AI formula review manifest binding mismatch: ${binding.path}`);
        }
      }
    } catch (error) { errors.push(error.message); }
  }
  return canonicalValue({
    status: reviews.length === required && errors.length === 0 ? "passed" : "blocked",
    completed: reviews.length,
    required,
    reviewer_kind: "ai",
    human_review_satisfied: false,
    physical_artifact_hashes: reviews.map((review) => review.physical_file_hash).sort(),
    errors: [...new Set(errors)],
  });
}

function semanticCoverage(report, required, verificationMode = "raw_revalidated") {
  return canonicalValue({
    status: report.valid === true && report.valid_artifact_count === required ? "passed" : "blocked",
    completed: report.valid_artifact_count || 0,
    required,
    reviewer_kind: "ai",
    human_review_satisfied: false,
    production_effect: "none",
    verification_mode: verificationMode,
    raw_source_revalidated_count: verificationMode === "raw_revalidated"
      ? (report.valid_artifact_count || 0)
      : 0,
    index_hash: report.index_hash || null,
    proposition_count: report.proposition_count
      ?? report.proposition_review_count
      ?? report.proposition_adjudication_count
      ?? 0,
    errors: report.errors || [],
  });
}

function semanticIndexBindingMatches(stage, binding, artifact) {
  if (!isObject(binding) || !isObject(artifact)
    || binding.persona_id !== artifact.persona_id
    || binding.candidate_id !== artifact.candidate_id
    || binding.content_hash !== artifact.source_binding?.content_hash) return false;
  if (stage === "extraction") {
    return binding.artifact_hash === artifact.artifact_hash
      && binding.readability === artifact.readability?.status
      && binding.proposition_count === artifact.method_propositions?.length;
  }
  if (stage === "skeptic") {
    return binding.extractor_artifact_hash === artifact.extractor_binding?.declared_artifact_hash
      && binding.skeptic_artifact_hash === artifact.artifact_hash
      && binding.overall_verdict === artifact.overall_verdict
      && binding.proposition_review_count === artifact.proposition_reviews?.length;
  }
  return binding.extractor_artifact_hash === artifact.extractor_binding?.declared_artifact_hash
    && binding.skeptic_artifact_hash === artifact.skeptic_binding?.declared_artifact_hash
    && binding.adjudication_artifact_hash === artifact.artifact_hash
    && binding.final_overall_verdict === artifact.final_overall_verdict
    && binding.proposition_adjudication_count === artifact.proposition_adjudications?.length;
}

function semanticUpstreamErrors(stage, artifact, upstreams) {
  const errors = [];
  const verify = (kind, binding, source) => {
    const relativePath = binding?.relative_path;
    const upstream = typeof relativePath === "string" ? source?.get(relativePath) : null;
    if (!upstream) {
      errors.push(`${artifact.candidate_id}: ${kind} upstream artifact is missing: ${relativePath || "<missing path>"}`);
      return;
    }
    if (binding.declared_artifact_hash !== upstream.artifact_hash
      || binding.recomputed_artifact_hash !== upstream.artifact_hash
      || binding.artifact_content_hash !== sha256(upstream)) {
      errors.push(`${artifact.candidate_id}: ${kind} upstream binding mismatch`);
    }
  };
  if (stage === "skeptic") verify("extractor", artifact.extractor_binding, upstreams.extraction);
  if (stage === "adjudication") {
    verify("extractor", artifact.extractor_binding, upstreams.extraction);
    verify("skeptic", artifact.skeptic_binding, upstreams.skeptic);
  }
  return errors;
}

function scanSemanticCapsule(root, required, {
  stage,
  validator,
  indexDomain,
  propositionField,
  upstreams = {},
}) {
  const errors = [];
  let directory = null;
  try { directory = physicalDirectory(root, `semantic ${stage} capsule root`, { optional: true }); }
  catch (error) { errors.push(error.message); }
  const artifacts = [];
  if (directory) {
    let files = [];
    try { files = recursiveJsonFiles(directory, new Set(["index.json"])); }
    catch (error) { errors.push(error.message); }
    for (const file of files) {
      try {
        const value = physicalJson(file, `semantic ${stage} artifact`).value;
        const validation = validator(value);
        if (validation.length) errors.push(...validation.map((item) => `${relative(directory, file)}: ${item}`));
        else {
          errors.push(...semanticUpstreamErrors(stage, value, upstreams));
          artifacts.push({
            value,
            path: relative(directory, file).split(sep).join("/"),
          });
        }
      } catch (error) { errors.push(`${relative(directory, file)}: ${error.message}`); }
    }
  }
  const unique = new Set(artifacts.map(({ value }) => `${value.persona_id}\u0000${value.candidate_id}`));
  if (unique.size !== artifacts.length) errors.push(`semantic ${stage} capsule contains duplicate persona/candidate bindings`);
  let indexHash = null;
  let propositionCount = 0;
  if (directory) {
    try {
      const index = physicalJson(resolve(directory, "index.json"), `semantic ${stage} index`).value;
      indexHash = index.index_hash || null;
      propositionCount = index[propositionField] || 0;
      if (index.reviewer_kind !== "ai" || index.human_reviewed_count !== 0
        || index.method_attribution_approved_count !== 0 || index.production_effect !== "none") {
        errors.push(`semantic ${stage} index crosses the machine-only boundary`);
      }
      const expectedHash = sha256({ domain: indexDomain, subject: omit(index, "index_hash") });
      if (index.index_hash !== expectedHash) errors.push(`semantic ${stage} index_hash mismatch; expected ${expectedHash}`);
      const byPath = new Map(artifacts.map((entry) => [entry.path, entry.value]));
      if (!Array.isArray(index.artifacts) || index.artifacts.length !== artifacts.length
        || index.candidate_count !== artifacts.length) {
        errors.push(`semantic ${stage} index artifact count mismatch`);
      } else for (const binding of index.artifacts) {
        if (!semanticIndexBindingMatches(stage, binding, byPath.get(binding.relative_path))) {
          errors.push(`semantic ${stage} index binding mismatch: ${binding.relative_path}`);
        }
      }
    } catch (error) { errors.push(error.message); }
  }
  const valid = artifacts.length === required && errors.length === 0;
  return {
    coverage: canonicalValue({
      status: valid ? "passed" : "blocked",
      completed: valid ? artifacts.length : 0,
      required,
      reviewer_kind: "ai",
      human_review_satisfied: false,
      production_effect: "none",
      verification_mode: "packaged_capsule_only",
      raw_source_revalidated_count: 0,
      index_hash: indexHash,
      proposition_count: propositionCount,
      errors: [...new Set(errors)],
    }),
    byPath: new Map(artifacts.map((entry) => [entry.path, entry.value])),
  };
}

function scanSemanticReviews(paths, requirements) {
  const rawStagingRoot = resolve(paths.source_acquisition_root, "personas-v3");
  const rawAvailable = existsSync(rawStagingRoot);
  if (!rawAvailable) {
    const extractionCapsule = scanSemanticCapsule(
      paths.semantic_extraction_root,
      requirements.ai_semantic_extractions,
      {
        stage: "extraction",
        validator: validateSemanticSourceExtractionArtifact,
        indexDomain: "alphacouncil.semantic-source-extraction-index.v1",
        propositionField: "proposition_count",
      },
    );
    const skepticCapsule = scanSemanticCapsule(
      paths.semantic_skeptic_root,
      requirements.ai_semantic_skeptic_reviews,
      {
        stage: "skeptic",
        validator: validateSemanticSourceSkepticArtifact,
        indexDomain: "alphacouncil.semantic-source-skeptic-index.v1",
        propositionField: "proposition_review_count",
        upstreams: { extraction: extractionCapsule.byPath },
      },
    );
    const adjudicationCapsule = scanSemanticCapsule(
      paths.semantic_adjudication_root,
      requirements.ai_semantic_adjudications,
      {
        stage: "adjudication",
        validator: validateSemanticSourceAdjudicationArtifact,
        indexDomain: "alphacouncil.semantic-source-adjudication-index.v1",
        propositionField: "proposition_adjudication_count",
        upstreams: { extraction: extractionCapsule.byPath, skeptic: skepticCapsule.byPath },
      },
    );
    const extraction = extractionCapsule.coverage;
    const skeptic = skepticCapsule.coverage;
    const adjudication = adjudicationCapsule.coverage;
    return canonicalValue({
      status: [extraction, skeptic, adjudication].every((item) => item.status === "passed") ? "passed" : "blocked",
      extraction,
      skeptic,
      adjudication,
    });
  }
  const extractionReport = inspectSemanticSourceExtractions({
    root: rawStagingRoot,
    outputRoot: paths.semantic_extraction_root,
  });
  const skepticReport = inspectSemanticSourceSkepticReviews({
    root: rawStagingRoot,
    extractionRoot: paths.semantic_extraction_root,
    outputRoot: paths.semantic_skeptic_root,
  });
  const adjudicationReport = inspectSemanticSourceAdjudications({
    root: rawStagingRoot,
    extractionRoot: paths.semantic_extraction_root,
    skepticRoot: paths.semantic_skeptic_root,
    outputRoot: paths.semantic_adjudication_root,
  });
  const extraction = semanticCoverage(extractionReport, requirements.ai_semantic_extractions);
  const skeptic = semanticCoverage(skepticReport, requirements.ai_semantic_skeptic_reviews);
  const adjudication = semanticCoverage(adjudicationReport, requirements.ai_semantic_adjudications);
  return canonicalValue({
    status: [extraction, skeptic, adjudication].every((item) => item.status === "passed") ? "passed" : "blocked",
    extraction,
    skeptic,
    adjudication,
  });
}

function scanExperimentCoverage(root, required) {
  const errors = [];
  let verified = null;
  try {
    const directory = physicalDirectory(root, "AI-assisted experiment root", { optional: true });
    if (directory) verified = verifyAIMachineSimulationTree({ root: directory });
  } catch (error) { errors.push(error.message); }
  const ids = verified?.completed_run_ids || [];
  return canonicalValue({
    status: ids.length === required && errors.length === 0 ? "passed" : "blocked",
    completed: ids.length,
    required,
    completed_run_ids: ids,
    required_run_ids: [...AI_MACHINE_SIMULATION_RUN_IDS],
    evidence_class: "machine_simulation",
    deterministic_execution_count: verified?.deterministic_execution_count || 0,
    executed_count: verified?.executed_count || 0,
    blocked_fail_closed_count: verified?.blocked_fail_closed_count || 0,
    network_call_count: verified?.network_call_count || 0,
    human_reference_count: 0,
    canonical_experiment_completed: 0,
    canonical_experiment_required: 8,
    formal_h_status: "not_run",
    formal_experiment_effect: "none",
    manifest_hash: verified?.manifest_hash || null,
    errors: [...new Set(errors)],
  });
}

function scanHostCoverage(root, required) {
  const errors = [];
  let directory = null;
  try { directory = physicalDirectory(root, "AI-assisted live-host root", { optional: true }); } catch (error) { errors.push(error.message); }
  const passed = new Map();
  if (directory) {
    let files = [];
    try { files = recursiveJsonFiles(directory); } catch (error) { errors.push(error.message); }
    for (const file of files) {
      try {
        const opened = physicalJson(file, "live-host artifact");
        if (opened.value?.artifact_kind !== "alphacouncil_external_host_e2e_result") continue;
        const checked = checkExternalHostE2eFile(file);
        if (!checked.valid) errors.push(...checked.errors.map((item) => `${relative(directory, file)}: ${item}`));
        else if (opened.value.status === "passed") passed.set(opened.value.host_id, checked.file_hash);
      } catch (error) { errors.push(`${relative(directory, file)}: ${error.message}`); }
    }
  }
  const ids = [...passed.keys()].sort();
  return canonicalValue({
    status: ids.length === required && errors.length === 0 ? "passed" : "blocked",
    completed: ids.length,
    required,
    passed_host_ids: ids,
    required_host_ids: [...EXTERNAL_HOST_IDS],
    errors: [...new Set(errors)],
  });
}

function nEffStatus(file) {
  if (!existsSync(file)) return canonicalValue({
    status: "missing",
    n_eff: null,
    confidence_interval_95: null,
    artifact_present: false,
    disclosure_complete: false,
    formal_n_eff_effect: "none",
    reasons: ["no physical preregistered resolved-outcome N_eff artifact"],
  });
  try {
    const opened = physicalJson(file, "N_eff artifact");
    if (opened.value.artifact_kind === "persona_v3_ai_assisted_n_eff_disclosure") {
      const artifact = opened.value;
      const expected = artifactHashForDisclosure(artifact);
      const valid = artifact.schema_version === 1
        && artifact.evidence_class === "machine_simulation"
        && artifact.n_eff === null
        && artifact.status === "insufficient_resolved_outcomes"
        && artifact.reason === "insufficient_resolved_outcomes"
        && artifact.resolved_outcome_count === 0
        && artifact.minimum_required === 36
        && artifact.formal_n_eff_effect === "none"
        && artifact.formal_experiment_effect === "none"
        && artifact.formal_ga_effect === "none"
        && artifact.artifact_hash === expected;
      if (!valid) throw new Error(`AI-assisted N_eff disclosure is invalid; expected artifact hash ${expected}`);
      return canonicalValue({
        status: "insufficient_resolved_outcomes",
        n_eff: null,
        confidence_interval_95: null,
        artifact_present: true,
        disclosure_complete: true,
        formal_n_eff_effect: "none",
        reasons: ["insufficient_resolved_outcomes"],
      });
    }
    // Empty trusted keys are intentional: this profile cannot self-trust an artifact signer.
    const result = assessErrorNeff(opened.value, { trustedSignerKeys: {} });
    return canonicalValue({
      status: result.status === "publishable" ? "publishable" : "invalid",
      n_eff: result.n_eff,
      confidence_interval_95: result.confidence_interval_95,
      artifact_present: true,
      disclosure_complete: result.status === "publishable",
      formal_n_eff_effect: "none",
      reasons: result.reasons,
    });
  } catch (error) {
    return canonicalValue({
      status: "invalid",
      n_eff: null,
      confidence_interval_95: null,
      artifact_present: true,
      disclosure_complete: false,
      formal_n_eff_effect: "none",
      reasons: [error.message],
    });
  }
}

function artifactHashForDisclosure(artifact) {
  const subject = Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== "artifact_hash"));
  return sha256({ hash_domain: "alphacouncil.ai-assisted-solo.n-eff-disclosure.v1", subject });
}

export function loadAiAssistedSoloProfile(file = DEFAULT_AI_ASSISTED_SOLO_PROFILE) {
  const profile = physicalJson(file, "AI-assisted solo profile").value;
  const errors = [];
  const constants = {
    schema_version: 1,
    profile_id: AI_ASSISTED_SOLO_PROFILE_ID,
    package_channel: "solo_test",
    assurance_class: AI_ASSISTED_SOLO_ASSURANCE,
    human_review_satisfied: false,
    human_claims_allowed: false,
    formal_ga_effect: "none",
    production_effect: "none",
    production_eligible: false,
    method_model_eligible: false,
  };
  for (const [field, expected] of Object.entries(constants)) {
    if (profile[field] !== expected) errors.push(`${field} must be ${JSON.stringify(expected)}`);
  }
  const expectedRequirements = {
    physical_solo_packs: 26,
    ai_source_prereviews: 32,
    ai_semantic_extractions: 32,
    ai_semantic_skeptic_reviews: 32,
    ai_semantic_adjudications: 32,
    ai_formula_cross_reviews: 52,
    independent_roles_per_review: 3,
    automated_experiment_runs: 8,
    live_hosts: 4,
    packaged_review_verification: "artifact_and_index_hashes_without_raw_sources",
    n_eff_disclosure: "null_with_insufficient_resolved_outcomes_or_publishable",
  };
  for (const [field, expected] of Object.entries(expectedRequirements)) {
    if (profile.requirements?.[field] !== expected) errors.push(`requirements.${field} must be ${JSON.stringify(expected)}`);
  }
  if (errors.length) throw new Error(`invalid AI-assisted solo profile:\n- ${errors.join("\n- ")}`);
  return canonicalValue(profile);
}

export function inspectAiAssistedSoloStatus(options = {}) {
  const repoRoot = resolve(options.repoRoot || REPO_ROOT);
  const profile = options.profile || loadAiAssistedSoloProfile(options.profileFile);
  const paths = Object.fromEntries(Object.entries(profile.artifact_paths).map(([key, value]) => [key, resolve(repoRoot, value)]));
  const integrityErrors = [];

  let packReport = null;
  try {
    const packageVersion = physicalJson(resolve(repoRoot, "package.json"), "package metadata").value.version;
    const packOptions = Object.fromEntries(Object.entries({
      root: options.packRoot || paths.solo_pack_root,
      formulaRoot: options.formulaRoot,
      personaDir: options.personaDir,
      packVersion: options.packVersion || packageVersion,
    }).filter(([, value]) => value !== undefined));
    packReport = inspectPersonaV3SoloTestPacks(packOptions);
  } catch (error) { integrityErrors.push(`solo packs: ${error.message}`); }
  const packCompleted = packReport?.summary?.physical_pack_count || 0;
  const packErrors = packReport?.seats?.flatMap((seat) => seat.errors.map((item) => `${seat.persona_id}: ${item}`)) || [];
  const soloPacks = canonicalValue({
    status: packReport?.summary?.ready_for_solo_testing === true
      && packCompleted === profile.requirements.physical_solo_packs ? "passed" : "blocked",
    completed: packCompleted,
    required: profile.requirements.physical_solo_packs,
    readiness_hash: packReport?.readiness_hash || null,
    production_loader_rejection_count: packReport?.summary?.production_loader_rejection_count || 0,
    errors: packErrors,
  });

  const sourceAcquisitionRoot = options.sourceAcquisitionRoot || paths.source_acquisition_root;
  const source = scanSourceReviews(
    options.sourceReviewRoot || paths.source_review_root,
    profile.requirements.ai_source_prereviews,
    repoRoot,
    sourceAcquisitionRoot,
  );
  const semantic = scanSemanticReviews({ ...paths, source_acquisition_root: sourceAcquisitionRoot }, profile.requirements);
  const formula = scanFormulaReviews(options.formulaReviewRoot || paths.formula_review_root, profile.requirements.ai_formula_cross_reviews, repoRoot);
  const aiReviews = canonicalValue({
    status: source.status === "passed" && semantic.status === "passed" && formula.status === "passed" ? "passed" : "blocked",
    source,
    semantic,
    formula,
  });
  const experiments = scanExperimentCoverage(options.experimentRoot || paths.experiment_root, profile.requirements.automated_experiment_runs);
  const hosts = scanHostCoverage(options.hostE2eRoot || paths.host_e2e_root, profile.requirements.live_hosts);
  const neff = nEffStatus(options.nEffFile || paths.n_eff_file);

  integrityErrors.push(
    ...source.errors,
    ...semantic.extraction.errors,
    ...semantic.skeptic.errors,
    ...semantic.adjudication.errors,
    ...formula.errors,
    ...experiments.errors,
    ...hosts.errors,
  );
  if (neff.status === "invalid") integrityErrors.push(...neff.reasons.map((item) => `N_eff: ${item}`));
  const integrityStatus = integrityErrors.length ? "failed" : "passed";
  const localReady = integrityStatus === "passed" && soloPacks.status === "passed" && aiReviews.status === "passed";
  const releaseReady = localReady && experiments.status === "passed" && hosts.status === "passed" && neff.disclosure_complete === true;
  const blockers = [];
  if (soloPacks.status !== "passed") blockers.push(`physical solo packs ${soloPacks.completed}/${soloPacks.required}`);
  if (source.status !== "passed") blockers.push(`AI source prereviews ${source.completed}/${source.required}`);
  if (semantic.extraction.status !== "passed") blockers.push(`AI semantic extractions ${semantic.extraction.completed}/${semantic.extraction.required}`);
  if (semantic.skeptic.status !== "passed") blockers.push(`AI semantic skeptic reviews ${semantic.skeptic.completed}/${semantic.skeptic.required}`);
  if (semantic.adjudication.status !== "passed") blockers.push(`AI semantic adjudications ${semantic.adjudication.completed}/${semantic.adjudication.required}`);
  if (formula.status !== "passed") blockers.push(`AI formula cross-reviews ${formula.completed}/${formula.required}`);
  if (experiments.status !== "passed") blockers.push(`automated experiment runs ${experiments.completed}/${experiments.required}`);
  if (hosts.status !== "passed") blockers.push(`live host E2E ${hosts.completed}/${hosts.required}`);
  if (!neff.disclosure_complete) blockers.push(`N_eff disclosure ${neff.status}`);
  if (integrityStatus === "failed") blockers.push(`artifact integrity failed with ${integrityErrors.length} error(s)`);

  const subject = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_ai_assisted_solo_status",
    profile_id: AI_ASSISTED_SOLO_PROFILE_ID,
    assurance_class: AI_ASSISTED_SOLO_ASSURANCE,
    human_review_satisfied: false,
    formal_ga_effect: "none",
    production_eligible: false,
    method_model_eligible: false,
    integrity_status: integrityStatus,
    local_test_status: localReady ? "ready" : "blocked",
    release_status: releaseReady ? "ready" : "blocked",
    solo_packs: soloPacks,
    ai_review_coverage: aiReviews,
    automated_experiment_coverage: experiments,
    live_host_coverage: hosts,
    n_eff: neff,
    blockers: [...new Set(blockers)],
    integrity_errors: [...new Set(integrityErrors)],
  });
  return Object.freeze(canonicalValue({
    ...subject,
    report_hash: sha256({ hash_domain: "alphacouncil.persona-v3.ai-assisted-solo-status.v1", subject }),
  }));
}

export function renderAiAssistedSoloStatus(report) {
  return [
    "# PersonaPack v3 AI-assisted solo status",
    "",
    "> Machine cross-review only. Human review remains unsatisfied and formal GA effect is none.",
    "",
    `Integrity: ${report.integrity_status}`,
    `Local AI-assisted test status: ${report.local_test_status}`,
    `AI-assisted release status: ${report.release_status}`,
    `Solo packs: ${report.solo_packs.completed}/${report.solo_packs.required}`,
    `AI source prereviews: ${report.ai_review_coverage.source.completed}/${report.ai_review_coverage.source.required} (${report.ai_review_coverage.source.verification_mode})`,
    `AI semantic extractions: ${report.ai_review_coverage.semantic.extraction.completed}/${report.ai_review_coverage.semantic.extraction.required} (${report.ai_review_coverage.semantic.extraction.verification_mode})`,
    `AI semantic skeptic reviews: ${report.ai_review_coverage.semantic.skeptic.completed}/${report.ai_review_coverage.semantic.skeptic.required} (${report.ai_review_coverage.semantic.skeptic.verification_mode})`,
    `AI semantic adjudications: ${report.ai_review_coverage.semantic.adjudication.completed}/${report.ai_review_coverage.semantic.adjudication.required} (${report.ai_review_coverage.semantic.adjudication.verification_mode})`,
    `AI formula cross-reviews: ${report.ai_review_coverage.formula.completed}/${report.ai_review_coverage.formula.required}`,
    `Machine simulation variants: ${report.automated_experiment_coverage.completed}/${report.automated_experiment_coverage.required}`,
    `Canonical experiment runs: ${report.automated_experiment_coverage.canonical_experiment_completed}/${report.automated_experiment_coverage.canonical_experiment_required}`,
    `Formal H: ${report.automated_experiment_coverage.formal_h_status}`,
    `Live host E2E: ${report.live_host_coverage.completed}/${report.live_host_coverage.required}`,
    `N_eff: ${report.n_eff.n_eff === null ? "null" : report.n_eff.n_eff} (${report.n_eff.status})`,
    `Human review satisfied: ${report.human_review_satisfied}`,
    `Formal GA effect: ${report.formal_ga_effect}`,
    "",
    "Blockers:",
    ...(report.blockers.length ? report.blockers.map((item) => `- ${item}`) : ["- none"]),
    "",
    `Report hash: \`${report.report_hash}\``,
  ].join("\n");
}
