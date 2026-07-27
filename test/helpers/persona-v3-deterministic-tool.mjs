import { sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import { deterministicToolSchemaHashes } from "../../mcp/lib/personas-v3/deterministic-executor.mjs";

const TEST_ONLY_BINDING_KIND = "test_only_formula_approval_hash_binding";

function formulaSpecId(toolId) {
  const normalized = String(toolId || "fixture_tool")
    .toLowerCase()
    .replace(/[^a-z0-9_.:]/gu, "_");
  return `test_formula.${normalized}.spec_v1`;
}

/**
 * Add structurally valid, deterministic formula-approval hash bindings to a
 * synthetic tool fixture. These hashes are test-only stand-ins: they do not
 * represent production review attestations or release evidence.
 */
export function withTestFormulaApprovalBinding(tool, { fixtureId = tool?.id } = {}) {
  const formula_spec_id = formulaSpecId(fixtureId);
  const formula_spec_hash = sha256({
    schema_version: 1,
    artifact_kind: TEST_ONLY_BINDING_KIND,
    binding: "formula_spec",
    formula_spec_id,
    tool_id: tool?.id,
    source_ids: tool?.source_ids,
  });
  const formula_review_subject_hash = sha256({
    schema_version: 1,
    artifact_kind: TEST_ONLY_BINDING_KIND,
    binding: "formula_review_subject",
    formula_spec_id,
    formula_spec_hash,
  });
  const approval_bundle_hash = sha256({
    schema_version: 1,
    artifact_kind: TEST_ONLY_BINDING_KIND,
    binding: "approval_bundle",
    formula_spec_id,
    formula_spec_hash,
    formula_review_subject_hash,
    source_ids: tool?.source_ids,
  });
  const bound = {
    ...tool,
    formula_spec_id,
    formula_spec_hash,
    formula_review_subject_hash,
    approval_bundle_hash,
  };
  return { ...bound, ...deterministicToolSchemaHashes(bound) };
}
