import { readFileSync } from "node:fs";
import { ALL_ANALYST_TASKS } from "./constants.mjs";
import { invalidParams } from "./errors.mjs";
import { localized } from "./lang.mjs";
import { personaPrompt, registry } from "./personas/registry.mjs";
import { sha256 } from "./personas-v3/canonical.mjs";
import { assertRuntimeClientPayload, assertRuntimeWorkerPayload } from "./runtime-validation.mjs";

export const REQUIRED_VERIFIER_IDS = Object.freeze([
  "source_fidelity",
  "rederivation",
  "refuter",
]);

export const CLEAN_VERIFIER_VERDICTS = Object.freeze({
  source_fidelity: Object.freeze(["supported"]),
  rederivation: Object.freeze(["agree"]),
  refuter: Object.freeze(["stands"]),
});

function uniqueStrings(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    : [];
}

function sourceRows(run) {
  return (run?.packets || []).flatMap((packet) => (packet?.sources || []).map((source) => ({
    task: packet.task,
    ...source,
  })));
}

export function allEvidenceClaims(run) {
  return (run?.packets || []).flatMap((packet) => (packet?.claims || []).map((claim, index) => ({
    claim_id: `${packet.task}:C${index + 1}`,
    task: packet.task,
    claim_index: index,
    claim: typeof claim?.claim === "string" ? claim.claim : "",
    evidence: typeof claim?.evidence === "string" ? claim.evidence : "",
    confidence: ["high", "medium", "low"].includes(claim?.confidence)
      ? claim.confidence
      : (["high", "medium", "low"].includes(packet?.confidence) ? packet.confidence : "low"),
    source_ids: uniqueStrings(claim?.source_ids),
  })));
}

/** Every non-low claim is material; if workers returned only low confidence, verify them all. */
export function materialEvidenceClaims(run) {
  const all = allEvidenceClaims(run).filter((claim) => claim.claim && claim.source_ids.length);
  const nonLow = all.filter((claim) => claim.confidence !== "low");
  return nonLow.length ? nonLow : all;
}

function selectedMaterialClaims(run, expectedClaimIds) {
  const claims = materialEvidenceClaims(run);
  if (expectedClaimIds === undefined || expectedClaimIds === null) return claims;
  if (!Array.isArray(expectedClaimIds) || expectedClaimIds.length === 0
    || new Set(expectedClaimIds).size !== expectedClaimIds.length) {
    throw new Error("expected verifier claim IDs must be one non-empty unique array");
  }
  const byId = new Map(claims.map((claim) => [claim.claim_id, claim]));
  const selected = expectedClaimIds.map((id) => byId.get(id));
  const unknown = expectedClaimIds.filter((id, index) => !selected[index]);
  if (unknown.length) throw new Error(`unknown verifier claim IDs: ${unknown.join(", ")}`);
  return selected;
}

export function tripleVerificationRequired(run = {}) {
  if ((run.council_mode || "full") !== "full" || run.council_pace !== "slow") return false;
  const selection = run.master_selection || {};
  const analystScope = run.analyst_scope || selection.analyst_scope;
  const allMethods = selection.selection_mode === "all"
    || (Number.isInteger(selection.all_master_count)
      && selection.all_master_count > 0
      && Array.isArray(run.masters)
      && run.masters.length === selection.all_master_count);
  return analystScope === "all" && allMethods;
}

export function initializeVerificationPolicy(run) {
  const required = tripleVerificationRequired(run);
  const claims = materialEvidenceClaims(run);
  const policy = {
    policy_id: required ? "triple_material_claim_v1" : "source_id_presence_v1",
    required,
    trigger: required ? "slow+all_methods+all_analysts" : "not_triggered",
    verifier_ids: required ? [...REQUIRED_VERIFIER_IDS] : [],
    material_claim_ids: required ? claims.map((claim) => claim.claim_id) : [],
    material_claim_count: required ? claims.length : 0,
    expected_verdict_count: required ? claims.length * REQUIRED_VERIFIER_IDS.length : 0,
    input_hash: required ? sha256(claims) : null,
    analyst_roster_complete: required
      ? JSON.stringify(run.tasks || []) === JSON.stringify(ALL_ANALYST_TASKS)
      : null,
    status: required ? "pending" : "not_required",
    initialized_at: new Date().toISOString(),
  };
  run.verification_policy = policy;
  run.verifier_status = required
    ? Object.fromEntries(REQUIRED_VERIFIER_IDS.map((id) => [id, { verifier: id, status: "pending" }]))
    : {};
  return policy;
}

function effectivePolicy(run) {
  const required = tripleVerificationRequired(run);
  const claims = materialEvidenceClaims(run);
  if (run?.verification_policy?.required === required
    && (!required || run.verification_policy.input_hash === sha256(claims))) {
    return run.verification_policy;
  }
  return {
    policy_id: required ? "triple_material_claim_v1" : "source_id_presence_v1",
    required,
    trigger: required ? "slow+all_methods+all_analysts" : "not_triggered",
    verifier_ids: required ? [...REQUIRED_VERIFIER_IDS] : [],
    material_claim_ids: required ? claims.map((claim) => claim.claim_id) : [],
    material_claim_count: required ? claims.length : 0,
    expected_verdict_count: required ? claims.length * REQUIRED_VERIFIER_IDS.length : 0,
    input_hash: required ? sha256(claims) : null,
    analyst_roster_complete: required
      ? JSON.stringify(run.tasks || []) === JSON.stringify(ALL_ANALYST_TASKS)
      : null,
    status: required ? "pending" : "not_required",
  };
}

export function verificationAuditStatus(run = {}) {
  const policy = effectivePolicy(run);
  const verdicts = Array.isArray(run.verifier_verdicts) ? run.verifier_verdicts : [];
  if (!policy.required) {
    return {
      ...policy,
      status: "not_required",
      recorded_verdict_count: verdicts.length,
      missing: [],
      duplicates: [],
      unexpected: [],
      non_clean: [],
      verifier_zero: verdicts.length === 0,
    };
  }

  const expectedKeys = new Set(policy.material_claim_ids.flatMap((claimId) => (
    REQUIRED_VERIFIER_IDS.map((verifier) => `${verifier}\u0000${claimId}`)
  )));
  const seen = new Map();
  const unexpected = [];
  for (const verdict of verdicts) {
    const key = `${verdict?.verifier || ""}\u0000${verdict?.claim_id || ""}`;
    if (!expectedKeys.has(key)) unexpected.push({
      verifier: verdict?.verifier || null,
      claim_id: verdict?.claim_id || null,
    });
    const rows = seen.get(key) || [];
    rows.push(verdict);
    seen.set(key, rows);
  }
  const missing = [...expectedKeys].filter((key) => !seen.has(key)).map((key) => {
    const [verifier, claim_id] = key.split("\u0000");
    return { verifier, claim_id };
  });
  const duplicates = [...seen.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => {
      const [verifier, claim_id] = key.split("\u0000");
      return { verifier, claim_id, count: rows.length };
    });
  const nonClean = verdicts.filter((verdict) => (
    REQUIRED_VERIFIER_IDS.includes(verdict?.verifier)
    && policy.material_claim_ids.includes(verdict?.claim_id)
    && (!CLEAN_VERIFIER_VERDICTS[verdict.verifier]?.includes(verdict.verdict)
      || (verdict.verifier === "rederivation" && verdict.source_independence === "same_source_only"))
  )).map((verdict) => ({
    verifier: verdict.verifier,
    claim_id: verdict.claim_id,
    verdict: verdict.verifier === "rederivation"
      && verdict.verdict === "agree"
      && verdict.source_independence === "same_source_only"
      ? "agree_same_source_only"
      : verdict.verdict,
    note: verdict.note || "",
  }));
  const coverageComplete = policy.material_claim_count > 0
    && policy.analyst_roster_complete === true
    && verdicts.length > 0
    && missing.length === 0
    && duplicates.length === 0
    && unexpected.length === 0;
  return {
    ...policy,
    // A verifier is supposed to find weak, contradicted, or unconfirmable claims. Treating
    // those findings as a transport failure prevented the very analysts and PM that consume
    // the penalties from ever running. The hard gate is exact claim-by-verifier coverage;
    // findings remain first-class, lower weights, and are rendered visibly.
    status: coverageComplete
      ? (nonClean.length ? "completed_with_findings" : "passed")
      : "needs_verification",
    coverage_complete: coverageComplete,
    findings_present: nonClean.length > 0,
    recorded_verdict_count: verdicts.length,
    missing,
    duplicates,
    unexpected,
    non_clean: nonClean,
    verifier_zero: verdicts.length === 0,
  };
}

function citedSourcesForClaim(claim, sourcesById) {
  return claim.source_ids.map((id) => sourcesById.get(id)).filter(Boolean).map((source) => ({
    id: source.id,
    title: source.title || "",
    url: source.url || "",
    published_at: source.published_at || "unknown",
    retrieved_at: source.retrieved_at || "unknown",
    source_kind: source.source_kind || null,
  }));
}

export function buildVerifierBatchInput(run, verifierId, { expectedClaimIds } = {}) {
  if (!REQUIRED_VERIFIER_IDS.includes(verifierId)) throw new Error(`unknown required verifier: ${verifierId}`);
  const claims = selectedMaterialClaims(run, expectedClaimIds);
  const sourcesById = new Map(sourceRows(run).map((source) => [source.id, source]));
  const includeOriginalSources = verifierId !== "rederivation";
  const input = {
    schema_version: 1,
    policy_id: "triple_material_claim_v1",
    verifier: verifierId,
    run_id: run.run_id,
    symbol: run.symbol,
    as_of: run.as_of,
    language: run.language,
    claim_count: claims.length,
    claims: claims.map((claim) => ({
      claim_id: claim.claim_id,
      task: claim.task,
      claim: claim.claim,
      evidence: claim.evidence,
      confidence: claim.confidence,
      ...(includeOriginalSources ? { cited_sources: citedSourcesForClaim(claim, sourcesById) } : {}),
    })),
  };
  return { ...input, input_hash: sha256(input) };
}

export function buildVerifierHeadlessOutputSchema(run, verifierId, expectedClaimIds) {
  if (!REQUIRED_VERIFIER_IDS.includes(verifierId)) throw new Error(`unknown required verifier: ${verifierId}`);
  const claims = selectedMaterialClaims(run, expectedClaimIds);
  const persona = registry().get(verifierId);
  const resultSchema = {
    type: "object",
    properties: {
      verdict: { type: "string", enum: [...persona.verdict_values] },
      note: { type: "string", minLength: 1, maxLength: 240 },
      checked_urls: {
        type: "array",
        maxItems: 12,
        items: { type: "string" },
      },
      queries: {
        type: "array",
        maxItems: 2,
        items: { type: "string" },
      },
      excerpt: { type: "string", maxLength: 600 },
      rederivation: { type: "string", maxLength: 360 },
    },
    required: ["verdict", "note", "checked_urls", "queries", "excerpt", "rederivation"],
    additionalProperties: false,
  };
  const claimIds = claims.map((claim) => claim.claim_id);
  return {
    type: "object",
    properties: {
      verifier: { type: "string", enum: [verifierId] },
      run_id: { type: "string", enum: [run.run_id] },
      // A keyed object makes omission/duplication structurally impossible under Codex
      // Structured Outputs. The canonical persisted contract is converted back to rows.
      results: {
        type: "object",
        properties: Object.fromEntries(claimIds.map((claimId) => [claimId, resultSchema])),
        required: claimIds,
        additionalProperties: false,
      },
    },
    required: ["verifier", "run_id", "results"],
    additionalProperties: false,
  };
}

export function normalizeVerifierHeadlessTransport(packet, run, verifierId, expectedClaimIds) {
  if (Array.isArray(packet?.results)) return packet; // packaged fake/legacy transport compatibility
  const claims = selectedMaterialClaims(run, expectedClaimIds);
  const expected = claims.map((claim) => claim.claim_id);
  const supplied = packet?.results && typeof packet.results === "object" && !Array.isArray(packet.results)
    ? Object.keys(packet.results)
    : [];
  const missing = expected.filter((claimId) => !supplied.includes(claimId));
  const unexpected = supplied.filter((claimId) => !expected.includes(claimId));
  if (missing.length || unexpected.length) {
    throw invalidParams("Headless verifier transport did not contain the exact keyed claim set.", {
      reason: "VERIFIER_HEADLESS_TRANSPORT_MISMATCH",
      verifier: verifierId,
      problems: [
        ...missing.map((claim_id) => ({ claim_id, reason: "missing_claim_id" })),
        ...unexpected.map((claim_id) => ({ claim_id, reason: "unexpected_claim_id" })),
      ],
    });
  }
  return {
    verifier: packet.verifier,
    run_id: packet.run_id,
    results: expected.map((claimId) => ({ claim_id: claimId, ...packet.results[claimId] })),
  };
}

export function verifierBatchPrompt(run, verifierId, inputPath, { keyedResults = false } = {}) {
  const persona = registry().get(verifierId);
  if (!persona || persona.kind !== "verifier") throw new Error(`unknown verifier persona: ${verifierId}`);
  const result = {
    verdict: `<one of: ${persona.verdict_values.join(" | ")}>`,
    note: `<reader-facing explanation in ${run.language}>`,
    checked_urls: [],
    queries: [],
    excerpt: "",
    rederivation: "",
  };
  const contract = keyedResults ? {
    verifier: verifierId,
    run_id: run.run_id,
    results: { "<copy one supplied claim_id as the exact object key>": result },
  } : {
    verifier: verifierId,
    run_id: run.run_id,
    results: [{
      claim_id: "<copy one supplied claim_id>",
      ...result,
    }],
  };
  return [
    `You are the isolated ${verifierId} worker for AlphaCouncil run ${run.run_id}.`,
    `Read the complete frozen verification input at ${inputPath}. Its claim_count is binding.`,
    keyedResults
      ? "You MUST return exactly one result for EVERY supplied claim_id, using each exact claim_id once as a key inside the results object. Do not repeat claim_id inside the result value. Missing or unexpected keys fail the entire verification stage."
      : "You MUST return exactly one result for EVERY supplied claim_id, in the same order. Do not select a subset, merge claims, add claims, or stop after one. Missing, duplicate, or unexpected claim IDs fail the entire verification stage.",
    "Keep transport compact: note is one sentence (<=240 characters), at most 12 checked_urls and 2 queries, excerpt <=600 characters, and rederivation <=360 characters. Do not add methodology preambles or repeat the claim.",
    verifierId === "source_fidelity"
      ? "Actually open EVERY distinct cited URL for every claim. A supported verdict requires a short exact excerpt and joint support for the whole bounded claim; source_unreachable still lists every URL attempted."
      : verifierId === "rederivation"
        ? "The input deliberately omits the original URLs. Search independently for every claim. agree/disagree require at least one independently located URL and a non-empty rederivation; cannot_confirm requires the queries attempted. Independently landing on the same primary filing is allowed and will be transparently marked as source overlap by the server."
        : "Run at least one concrete disconfirming query for every claim. Record those queries. refuted/weakened/superseded_by_newer require the URLs checked; stands is valid only after the negative search.",
    `Write reader-facing note/excerpt/rederivation in ${run.language}; preserve stable IDs and URLs exactly.`,
    `Verifier method instructions:\n${personaPrompt(persona, run.language)}`,
    `Return only JSON matching this shape: ${JSON.stringify(contract)}`,
  ].join("\n\n");
}

function normalizedUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.href.replace(/\/$/u, "");
  } catch {
    return "";
  }
}

export function normalizeVerifierBatch(packet, run, verifierId, {
  client = false,
  expectedClaimIds,
} = {}) {
  const validated = client
    ? assertRuntimeClientPayload("verifier_batch", packet, { run_id: run.run_id, verifier: verifierId })
    : assertRuntimeWorkerPayload("verifier_batch", packet);
  if (validated.verifier !== verifierId || validated.run_id !== run.run_id) {
    throw invalidParams("Verifier batch identity does not match the run.", {
      reason: "VERIFIER_BATCH_IDENTITY_MISMATCH",
      expected: { verifier: verifierId, run_id: run.run_id },
      supplied: { verifier: validated.verifier, run_id: validated.run_id },
    });
  }
  const persona = registry().get(verifierId);
  const claims = selectedMaterialClaims(run, expectedClaimIds);
  const claimById = new Map(claims.map((claim) => [claim.claim_id, claim]));
  const sourceById = new Map(sourceRows(run).map((source) => [source.id, source]));
  const seen = new Set();
  const problems = [];
  const results = [];
  for (const row of validated.results) {
    const claim = claimById.get(row.claim_id);
    if (!claim) problems.push({ claim_id: row.claim_id, reason: "unexpected_claim_id" });
    if (seen.has(row.claim_id)) problems.push({ claim_id: row.claim_id, reason: "duplicate_claim_id" });
    seen.add(row.claim_id);
    if (!persona.verdict_values.includes(row.verdict)) {
      problems.push({ claim_id: row.claim_id, reason: "verdict_outside_verifier_space", verdict: row.verdict });
    }
    const checkedUrls = uniqueStrings(row.checked_urls);
    const queries = uniqueStrings(row.queries);
    let sourceIndependence = "no_source";
    const citedUrls = new Set((claim?.source_ids || [])
      .map((id) => normalizedUrl(sourceById.get(id)?.url))
      .filter(Boolean));
    if (verifierId === "source_fidelity") {
      if (!checkedUrls.length) problems.push({ claim_id: row.claim_id, reason: "source_fidelity_without_checked_url" });
      const missingCitedUrls = [...citedUrls].filter((url) => (
        !checkedUrls.some((checked) => normalizedUrl(checked) === url)
      ));
      if (missingCitedUrls.length) {
        problems.push({
          claim_id: row.claim_id,
          reason: "source_fidelity_did_not_check_every_cited_url",
          missing_urls: missingCitedUrls,
        });
      }
      if (row.verdict === "supported" && !String(row.excerpt || "").trim()) {
        problems.push({ claim_id: row.claim_id, reason: "supported_without_excerpt" });
      }
    }
    if (verifierId === "rederivation") {
      if (!queries.length) problems.push({ claim_id: row.claim_id, reason: "rederivation_without_query" });
      if (["agree", "disagree"].includes(row.verdict)) {
        if (!checkedUrls.length) problems.push({ claim_id: row.claim_id, reason: "rederivation_without_independent_url" });
        if (!String(row.rederivation || "").trim()) problems.push({ claim_id: row.claim_id, reason: "rederivation_without_work" });
        const reused = checkedUrls.filter((url) => citedUrls.has(normalizedUrl(url)));
        // Independent retrieval and independent calculation are the rederivation gate. For
        // issuer/SEC facts, a correct independent search often lands on the same authoritative
        // filing. Preserve that overlap as an auditable finding; do not mislabel it as missing
        // verifier coverage.
        sourceIndependence = reused.length === checkedUrls.length
          ? "same_source_only"
          : "independent_source_present";
      }
    }
    if (verifierId === "refuter") {
      if (!queries.length) problems.push({ claim_id: row.claim_id, reason: "refuter_without_negative_query" });
      if (["refuted", "weakened", "superseded_by_newer"].includes(row.verdict) && !checkedUrls.length) {
        problems.push({ claim_id: row.claim_id, reason: "adverse_verdict_without_checked_url" });
      }
    }
    results.push({
      verifier: verifierId,
      claim_id: row.claim_id,
      seat: claim?.task || null,
      task: claim?.task || null,
      claim: claim?.claim || "",
      verdict: row.verdict,
      note: row.note,
      checked_urls: checkedUrls,
      queries,
      excerpt: row.excerpt || "",
      rederivation: row.rederivation || "",
      ...(verifierId === "rederivation" ? {
        source_independence: sourceIndependence,
      } : {}),
    });
  }
  for (const claim of claims) {
    if (!seen.has(claim.claim_id)) problems.push({ claim_id: claim.claim_id, reason: "missing_claim_id" });
  }
  if (validated.results.length !== claims.length) {
    problems.push({ reason: "result_count_mismatch", expected: claims.length, supplied: validated.results.length });
  }
  if (problems.length) {
    throw invalidParams("Verifier batch did not cover the frozen material-claim set.", {
      reason: "VERIFIER_BATCH_COVERAGE_MISMATCH",
      verifier: verifierId,
      expected_claim_count: claims.length,
      problems,
    });
  }
  return {
    schema_version: 1,
    verifier: verifierId,
    run_id: run.run_id,
    input_hash: buildVerifierBatchInput(run, verifierId, { expectedClaimIds }).input_hash,
    results,
  };
}

export function readVerifierBatchInput(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function verificationFailureMessage(run) {
  const status = verificationAuditStatus(run);
  return localized(run.language, {
    en: `Triple verification coverage did not complete: ${status.recorded_verdict_count}/${status.expected_verdict_count} verdicts recorded; ${status.missing.length} missing.`,
    zh: `三重核验覆盖未完成：已记录 ${status.recorded_verdict_count}/${status.expected_verdict_count} 条判定；缺失 ${status.missing.length} 条。`,
    ja: `三重検証の網羅が完了していません。${status.recorded_verdict_count}/${status.expected_verdict_count}件を記録し、未記録${status.missing.length}件です。`,
    ko: `삼중 검증 범위가 완료되지 않았습니다. ${status.recorded_verdict_count}/${status.expected_verdict_count}건 기록, 누락 ${status.missing.length}건입니다.`,
  });
}
