import { inspectPersonaAdmission } from "./admission.mjs";
import { canonicalValue, computePersonaArtifactHashes, sha256 } from "./canonical.mjs";

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function admittedMaturity(level) {
  if (level === "method_model") return "method_model";
  if (level === "candidate") return "candidate";
  return "operator_lens";
}

function candidateLabel(label) {
  return {
    en: /candidate/i.test(label.en) ? label.en : `${label.en} candidate`,
    zh: /候选/.test(label.zh) ? label.zh : `${label.zh}候选`,
    ...(label.ja ? { ja: /候補/.test(label.ja) ? label.ja : `${label.ja}候補` } : {}),
    ...(label.ko ? { ko: /후보/.test(label.ko) ? label.ko : `${label.ko} 후보` } : {}),
  };
}

function componentPayload(pack) {
  return {
    sources: pack.components.sources,
    doctrine: pack.components.doctrine,
    decision_cases: pack.components.decision_cases,
    failures: pack.components.failures,
    counterfactuals: pack.components.counterfactuals,
    research_policy: pack.components.research_policy,
    decision_policy: pack.components.decision_policy,
    tools: pack.components.tools,
    memory_policy: pack.components.memory_policy,
    golden_cases: pack.components.golden_cases,
    pairwise_cases: pack.components.pairwise_cases,
    calibration_cases: pack.components.calibration_cases,
    experiments: pack.components.experiments,
  };
}

export function compilePersonaPack(pack, {
  promptFile = null,
  trustedSignerKeys = undefined,
  trustedSignerKeyIds = undefined,
  allowMethodModelPromotion = false,
} = {}) {
  const personaId = pack?.manifest?.identity?.persona_id;
  if (!personaId) throw new Error("compilePersonaPack requires a loaded PersonaPack v3");
  const payload = componentPayload(pack);
  const artifactHashes = computePersonaArtifactHashes({
    manifest: pack.manifest,
    components: payload,
    voice: pack.voice,
  });
  const admission = inspectPersonaAdmission({
    persona_id: personaId,
    prompt_file: promptFile,
    pack_dir: pack.pack_dir,
    trustedSignerKeys,
    trustedSignerKeyIds,
    expectedArtifactHashes: artifactHashes,
    allowMethodModelPromotion,
  });
  const maturity = admittedMaturity(admission.admission_level);
  const label = maturity === "method_model" ? pack.manifest.identity.public_label
    : maturity === "candidate" ? candidateLabel(pack.manifest.identity.public_label)
      : pack.manifest.identity.operator_label;
  const deterministic = {
    schema_version: 3,
    build_profile: pack.manifest.build_profile || "production",
    dsl_version: pack.manifest.computation.dsl_version,
    pack_version: pack.manifest.pack_version,
    persona_id: personaId,
    source_cutoff: pack.manifest.identity.source_cutoff,
    maturity,
    admitted_label: label,
    manifest: pack.manifest,
    artifact_subject_hash: artifactHashes.artifact_subject_hash,
    component_hashes: artifactHashes.component_hashes,
    corpus_hash: artifactHashes.corpus_hash,
    tool_graph_hash: artifactHashes.tool_graph_hash,
    policy_hash: artifactHashes.policy_hash,
    prompt_hash: artifactHashes.prompt_hash,
    admission: {
      level: admission.admission_level,
      counts: admission.physical_corpus_counts,
      delta_to_operational: admission.delta_to_operational,
      delta_to_candidate: admission.delta_to_candidate,
      method_model_experiment_status: admission.method_model_experiment_status,
    },
  };
  const deterministicSnapshot = canonicalValue(deterministic);
  const compiledSnapshot = canonicalValue({
    ...deterministicSnapshot,
    pack_hash: sha256(deterministicSnapshot),
    voice: pack.voice,
    components: payload,
  });
  return deepFreeze(compiledSnapshot);
}
