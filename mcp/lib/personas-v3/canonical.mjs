import { createHash } from "node:crypto";

const SUBJECT_COMPONENTS = Object.freeze([
  "sources",
  "doctrine",
  "decision_cases",
  "failures",
  "counterfactuals",
  "research_policy",
  "decision_policy",
  "tools",
  "memory_policy",
  "golden_cases",
  "pairwise_cases",
  "calibration_cases",
]);

function normalize(value, path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path}: non-finite numbers are not canonical JSON`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${path}[${index}]`));
  if (typeof value !== "object") throw new Error(`${path}: ${typeof value} is not canonical JSON`);

  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new Error(`${path}.${key}: undefined is not canonical JSON`);
    out[key] = normalize(value[key], `${path}.${key}`);
  }
  return out;
}

export function canonicalValue(value) {
  return normalize(value);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex")}`;
}

/**
 * Compute the stable hash domains used by PersonaPack v3 admission and compilation.
 *
 * `artifact_subject_hash` deliberately excludes the experiments component and mutable
 * release/admission metadata. Experiment attestations can therefore bind the artifact
 * they tested without making the artifact hash depend on the attestations themselves.
 */
export function computePersonaArtifactHashes({ manifest, components, voice }) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("computePersonaArtifactHashes requires a manifest object");
  }
  if (!components || typeof components !== "object" || Array.isArray(components)) {
    throw new Error("computePersonaArtifactHashes requires a components object");
  }
  if (!voice || typeof voice !== "object" || Array.isArray(voice)) {
    throw new Error("computePersonaArtifactHashes requires a voice object");
  }

  const componentHashes = Object.fromEntries(Object.entries(components)
    .map(([key, value]) => [key, sha256(value)]));
  const voiceHash = sha256(voice);
  componentHashes.voice = voiceHash;

  const corpusHash = sha256({
    sources: components.sources,
    doctrine: components.doctrine,
    decision_cases: components.decision_cases,
    failures: components.failures,
    counterfactuals: components.counterfactuals,
  });
  const toolGraphHash = sha256(components.tools);
  const policyHash = sha256({
    research: manifest.research ?? null,
    research_policy: components.research_policy,
    decision: manifest.decision ?? null,
    decision_policy: components.decision_policy,
    memory: manifest.memory ?? null,
    memory_policy: components.memory_policy,
  });

  const identity = manifest.identity || {};
  const manifestContract = {
    schema_version: manifest.schema_version ?? null,
    pack_version: manifest.pack_version ?? null,
    identity: {
      persona_id: identity.persona_id ?? null,
      source_cutoff: identity.source_cutoff ?? null,
    },
    capability: manifest.capability ?? null,
    research: manifest.research ?? null,
    computation: manifest.computation ?? null,
    decision: manifest.decision ?? null,
    memory: manifest.memory ?? null,
    evaluation: manifest.evaluation ?? null,
    voice: {
      load_after_decision_freeze: manifest.voice?.load_after_decision_freeze ?? null,
    },
  };
  const subjectComponentHashes = Object.fromEntries(SUBJECT_COMPONENTS
    .map((name) => [name, componentHashes[name]]));
  const artifactSubjectHash = sha256({
    hash_domain: "alphacouncil.persona-v3.artifact-subject.v1",
    manifest_contract: manifestContract,
    component_hashes: subjectComponentHashes,
    voice_hash: voiceHash,
  });

  return canonicalValue({
    artifact_subject_hash: artifactSubjectHash,
    component_hashes: componentHashes,
    corpus_hash: corpusHash,
    policy_hash: policyHash,
    prompt_hash: voiceHash,
    tool_graph_hash: toolGraphHash,
    voice_hash: voiceHash,
  });
}
