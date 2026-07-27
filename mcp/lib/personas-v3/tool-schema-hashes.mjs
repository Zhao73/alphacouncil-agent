/** Hash-bound evidence and executable contracts shared by the v3 loader and anonymizer. */

import { sha256 } from "./canonical.mjs";

export const PROVISIONAL_DERIVED_PROXY_ASSURANCE = "provisional_derived_proxy";

/** The reviewed and provisional evidence shapes are intentionally disjoint. */
export function deterministicToolEvidenceBinding(tool) {
  if (tool?.assurance_class === PROVISIONAL_DERIVED_PROXY_ASSURANCE) {
    return {
      assurance_class: tool?.assurance_class,
      review_status: tool?.review_status,
      intended_use: tool?.intended_use,
      production_eligible: tool?.production_eligible,
      derivation_spec_id: tool?.derivation_spec_id,
      derivation_spec_hash: tool?.derivation_spec_hash,
      derivation_evidence_hash: tool?.derivation_evidence_hash,
      source_ids: tool?.source_ids,
    };
  }
  return {
    formula_spec_id: tool?.formula_spec_id,
    formula_spec_hash: tool?.formula_spec_hash,
    formula_review_subject_hash: tool?.formula_review_subject_hash,
    approval_bundle_hash: tool?.approval_bundle_hash,
    source_ids: tool?.source_ids,
  };
}
/** Hash executable contracts; pack authors should never hand-invent these values. */
export function deterministicToolSchemaHashes(tool) {
  const evidenceBinding = deterministicToolEvidenceBinding(tool);
  const bindingEnvelope = tool?.assurance_class === PROVISIONAL_DERIVED_PROXY_ASSURANCE
    ? { provisional_derivation_binding: evidenceBinding }
    : { formula_approval_binding: evidenceBinding };
  return {
    input_schema_hash: sha256({
      schema_version: 1,
      dsl_version: tool?.dsl_version,
      tool_id: tool?.id,
      tool_version: tool?.version,
      operation: tool?.operation,
      on_missing: tool?.on_missing,
      inputs: tool?.inputs,
      input_contracts: tool?.input_contracts,
      ...bindingEnvelope,
    }),
    output_schema_hash: sha256({
      schema_version: 1,
      dsl_version: tool?.dsl_version,
      tool_id: tool?.id,
      tool_version: tool?.version,
      output_id: tool?.output_id,
      value_kind: tool?.value_kind,
      unit: tool?.unit,
      output_period: tool?.output_period,
      ...bindingEnvelope,
    }),
  };
}
