#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import buildSpecs from "../../../data/persona-v3-build-specs.v1.mjs";
import { selectorCard } from "../../../mcp/lib/master-catalog.mjs";
import { loadPersonas, personaPrompt } from "../../../mcp/lib/personas/registry.mjs";
import { CANONICAL_MASTER_IDS } from "../../../mcp/lib/personas-v3/staging.mjs";
import { FIRST_PERSON_DISCLOSURE_ACK, FIRST_PERSON_VOICE_MODE } from "../../../mcp/lib/voice.mjs";
import { CANONICAL_SOLO_TEST_FACT_CONTRACTS } from "../../../scripts/lib/persona-v3-solo-formula-pipeline.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(SKILL_DIR, "..", "..");
const REFERENCES = join(SKILL_DIR, "references");
const METHODS = join(REFERENCES, "methods");
const PACKS = join(REPO_ROOT, "knowledge", "solo-test", "masters");
const REVIEWS = join(REPO_ROOT, "knowledge", "ai-assisted-solo", "reviews");
const RETIRED = new Set(["master_aschenbrenner"]);

function sha256(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function json(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function jsonl(file) {
  return readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function bullets(values) {
  return values?.length ? values.map((value) => `- ${value}`).join("\n") : "- None recorded.";
}

function sourceReviews(personaId) {
  const index = json(join(REVIEWS, "persona-v3-ai-semantic-adjudications", "index.json"));
  return index.artifacts.filter((item) => item.persona_id === personaId).map((item) => {
    const pre = json(join(REVIEWS, "persona-v3-ai-source-prereviews", item.relative_path));
    const adjudication = json(join(REVIEWS, "persona-v3-ai-semantic-adjudications", item.relative_path));
    return {
      candidate_id: item.candidate_id,
      url: pre.source_binding.final_url,
      content_hash: item.content_hash,
      machine_verdict: adjudication.final_overall_verdict,
      proposition_count: adjudication.proposition_adjudications.length,
      human_reviewed: false,
      method_attribution_approved: false,
    };
  });
}

function binaryConditions(node, path = "decision_policy", out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((child, index) => binaryConditions(child, `${path}[${index}]`, out));
    return out;
  }
  if (["eq", "neq", "gt", "gte", "lt", "lte", "date_gt", "date_gte", "date_lt", "date_lte"].includes(node.op)) {
    out.push({ path, condition: node });
    return out;
  }
  for (const [key, child] of Object.entries(node)) binaryConditions(child, `${path}.${key}`, out);
  return out;
}

function operandContract(operand, tools) {
  if (operand?.fact_id) return CANONICAL_SOLO_TEST_FACT_CONTRACTS[operand.fact_id] || null;
  if (operand?.output_id) {
    const tool = tools.find((candidate) => candidate.output_id === operand.output_id);
    return tool ? { value_kind: tool.value_kind, unit: tool.unit } : null;
  }
  return null;
}

function policyContractFindings(personaId, policy, tools) {
  return binaryConditions(policy).flatMap(({ path, condition }, index) => {
    const left = operandContract(condition.left, tools);
    const right = operandContract(condition.right, tools);
    if (!left || !right || (left.value_kind === right.value_kind && left.unit === right.unit)) return [];
    const kindMismatch = left.value_kind !== right.value_kind;
    return [{
      finding_id: `${personaId}.policy_operand_contract.${index + 1}`,
      status: kindMismatch ? "blocking_value_kind_mismatch" : "requires_human_formula_adjudication",
      condition_path: path,
      operation: condition.op,
      left: { operand: condition.left, value_kind: left.value_kind, unit: left.unit },
      right: { operand: condition.right, value_kind: right.value_kind, unit: right.unit },
    }];
  });
}

function packSnapshotHash(packDir) {
  const files = ["manifest.json", "provisional-index.json", "doctrine.jsonl", "tools.json", "decision_policy.json", "research_policy.json", "sources.jsonl", "voice.en.md", "voice.zh.md"];
  return sha256(files.map((name) => `${name}\0${readFileSync(join(packDir, name), "utf8")}\0`).join(""));
}

function methodDocument({ persona, spec, sourceItems, contractFindings }) {
  const id = persona.id;
  const packDir = join(PACKS, id);
  const manifest = json(join(packDir, "manifest.json"));
  const provisional = json(join(packDir, "provisional-index.json"));
  const doctrine = jsonl(join(packDir, "doctrine.jsonl"));
  const tools = json(join(packDir, "tools.json"));
  const policy = json(join(packDir, "decision_policy.json"));
  const researchPolicy = json(join(packDir, "research_policy.json"));
  const sourceTargets = jsonl(join(packDir, "sources.jsonl"));
  const card = selectorCard(persona, "English");
  const title = persona.title?.en || persona.id;
  const kind = id === "master_forensic_short" ? "composite professional method" : "named public-method reference";
  const packHash = packSnapshotHash(packDir);
  const voiceProfile = {
    method_id: id,
    voice_mode: FIRST_PERSON_VOICE_MODE,
    zh: personaPrompt(persona, "中文"),
    en: personaPrompt(persona, "English"),
  };
  const sourceRows = sourceItems.length
    ? sourceItems.map((item) => `| \`${item.candidate_id}\` | ${item.machine_verdict} | [source](${item.url}) | ${item.proposition_count} | no |`).join("\n")
    : "| none | no candidate | n/a | 0 | no |";
  return [
    `# ${title} — ${id}`,
    "",
    `- Reference kind: ${kind}`,
    "- Reference status: `method_reference_provisional`",
    `- Runtime maturity: \`${manifest.identity?.maturity || "operator_lens"}\``,
    `- Assurance: \`${provisional.assurance_class}\``,
    `- Pack snapshot hash: \`${packHash}\``,
    `- Required voice mode: \`${FIRST_PERSON_VOICE_MODE}\``,
    `- Required disclosure acknowledgement: \`${FIRST_PERSON_DISCLOSURE_ACK}\``,
    "- Required disclosure: first-person public-method simulation; the word `I` refers only to the project method simulation, not the named person's identity, quotation, endorsement, current view, holding, or private information.",
    `- Voice profile hash: \`${sha256(JSON.stringify(voiceProfile))}\``,
    "",
    "## Selector summary",
    "",
    card.identity,
    "",
    card.method,
    "",
    `Best for: ${card.best_for}`,
    "",
    "## Scope",
    "",
    spec.method_scope.planning_hypothesis,
    "",
    "Applicable domains:",
    "",
    bullets(spec.method_scope.applicable_domains),
    "",
    "Excluded claims:",
    "",
    bullets(spec.method_scope.excluded_claims),
    "",
    "Known limits:",
    "",
    bullets(spec.known_limits),
    "",
    "## Factual inputs",
    "",
    "Make the complete evidence pack available, then prioritize these declared fact types:",
    "",
    bullets(spec.required_fact_types.map((fact) => `\`${fact}\``)),
    "",
    "Do not infer a missing fact from the method reference. Enforce unit, period, point-in-time, source-ID, and lineage checks before applying any rule.",
    "",
    "## Native decision contract",
    "",
    "```json",
    pretty(spec.native_decision_contract),
    "```",
    "",
    "## Exact provisional doctrine",
    "",
    "These are project-derived, machine-reviewed hypotheses. They are not approved attribution to the named person.",
    "",
    "```json",
    pretty(doctrine),
    "```",
    "",
    "## Exact provisional tools",
    "",
    "Numeric thresholds or transformations below belong to the current project proxy unless separately bound to an approved primary source.",
    "",
    "```json",
    pretty(tools),
    "```",
    "",
    "## Exact provisional decision policy",
    "",
    "```json",
    pretty(policy),
    "```",
    "",
    "## Provisional contract findings",
    "",
    "A listed finding blocks the affected comparison from being presented as an approved method result. A ratio-unit finding requires human formula adjudication even when both JavaScript values are numeric.",
    "",
    "```json",
    pretty(contractFindings),
    "```",
    "",
    "## Research and source targets",
    "",
    "```json",
    pretty({ research_policy: researchPolicy, source_targets: sourceTargets }),
    "```",
    "",
    "## Physical public-source candidates",
    "",
    "Machine verdicts do not equal human method-attribution approval.",
    "",
    "| Candidate | Machine verdict | URL | Propositions | Human reviewed |",
    "|---|---|---|---:|---|",
    sourceRows,
    "",
    persona.source ? "Persona adaptation metadata:" : "Persona adaptation metadata: none declared.",
    "",
    ...(persona.source ? ["```json", pretty(persona.source), "```", ""] : []),
    "## First-person public-method simulation blueprint",
    "",
    "The final five-part voice MUST speak directly as `I` / `我`. Lead with the action verdict, follow this method's characteristic question order and vocabulary, and end with an observable condition that changes the reading. A neutral summary such as `Buffett would...` is invalid.",
    "",
    "This first person is a rhetorical method voice, not a real-identity claim. Never write `I am <named person>`, invent a quotation, biography, current view, current holding, private motive, private conversation, or endorsement. The renderer's fixed disclosure is mandatory and may not be removed or rewritten.",
    "",
    "Required fields, each written in first person: `would_i_act`, `what_i_see`, `how_my_method_reads_it`, `where_i_disagree`, `what_changes_my_mind`.",
    "",
    "### 中文方法语境",
    "",
    voiceProfile.zh,
    "",
    "### English method context",
    "",
    voiceProfile.en,
    "",
    "## Application order",
    "",
    "1. Confirm instrument and method scope.",
    "2. Read all critical facts and their source lineage; preserve counterevidence.",
    "3. Apply the fact gate, eligibility rules, and hard vetoes before scoring.",
    "4. Recompute tools only from supplied typed facts.",
    "5. Apply rules and bands exactly when acting as the frozen executor explanation layer; otherwise label the result advisory.",
    "6. Report missing facts, decisive rule IDs, counterevidence, and observable invalidation conditions.",
    "7. Speak in strong first person as this public-method simulation. Preserve the fixed identity disclosure and never claim to be the named person.",
    "",
  ].join("\n");
}

function build() {
  const registry = loadPersonas({ dir: join(REPO_ROOT, "personas") });
  const specs = new Map(buildSpecs.seats.map((item) => [item.persona_id, item]));
  const active = registry.ids("master");
  if (JSON.stringify(active) !== JSON.stringify(CANONICAL_MASTER_IDS)) throw new Error("active registry and canonical method order differ");
  if (active.length !== 26 || active.some((id) => RETIRED.has(id))) throw new Error("method reference export requires exactly 26 active methods and no retired AI seat");
  if (specs.size !== active.length || active.some((id) => !specs.has(id))) throw new Error("build specs do not close over the active methods");

  const documents = new Map();
  const methods = active.map((id) => {
    const persona = registry.get(id);
    const sources = sourceReviews(id);
    const packDir = join(PACKS, id);
    const policy = json(join(packDir, "decision_policy.json"));
    const tools = json(join(packDir, "tools.json"));
    const contractFindings = policyContractFindings(id, policy, tools);
    const content = methodDocument({ persona, spec: specs.get(id), sourceItems: sources, contractFindings });
    const path = `methods/${id}.md`;
    documents.set(path, content);
    return {
      method_id: id,
      title: persona.title,
      kind: id === "master_forensic_short" ? "composite_professional_method" : "named_public_method_reference",
      reference_status: "method_reference_provisional",
      runtime_maturity: json(join(PACKS, id, "manifest.json")).identity?.maturity || "operator_lens",
      pack_snapshot_hash: packSnapshotHash(packDir),
      source_candidate_count: sources.length,
      source_machine_verdict_counts: Object.fromEntries(["supported", "partial", "unverifiable", "unsupported"].map((verdict) => [verdict, sources.filter((item) => item.machine_verdict === verdict).length])),
      human_method_attribution_approved: false,
      contract_finding_count: contractFindings.length,
      contract_findings: contractFindings,
      voice_mode: FIRST_PERSON_VOICE_MODE,
      disclosure_ack: FIRST_PERSON_DISCLOSURE_ACK,
      voice_profile_hash: sha256(JSON.stringify({
        method_id: id,
        voice_mode: FIRST_PERSON_VOICE_MODE,
        zh: personaPrompt(persona, "中文"),
        en: personaPrompt(persona, "English"),
      })),
      reference_path: path,
      reference_hash: sha256(content),
    };
  });
  const catalog = {
    schema_version: 1,
    catalog_id: "alphacouncil_method_references_v1",
    active_method_count: methods.length,
    active_method_ids: active,
    retired_method_ids: [...RETIRED],
    execution_rule: "one isolated context per selected method; aggregate only after outputs are frozen",
    decision_authority: "provisional references are advisory unless explaining a hash-bound deterministic executor result",
    methods,
  };
  documents.set("catalog.v1.json", `${pretty(catalog)}\n`);
  return documents;
}

function main() {
  const mode = process.argv[2] || "--check";
  if (!["--check", "--write"].includes(mode) || process.argv.length > 3) throw new Error("usage: node generate-method-references.mjs [--check|--write]");
  const documents = build();
  const expectedMethods = new Set([...documents.keys()].filter((path) => path.startsWith("methods/")));
  if (mode === "--write") mkdirSync(METHODS, { recursive: true });
  const changed = [];
  for (const [path, content] of documents) {
    const file = join(REFERENCES, path);
    const same = existsSync(file) && readFileSync(file, "utf8") === content;
    if (!same && mode === "--write") writeFileSync(file, content, { encoding: "utf8", mode: 0o644 });
    if (!same) changed.push(path);
  }
  const extras = existsSync(METHODS) ? readdirSync(METHODS)
    .filter((name) => name.endsWith(".md") && !expectedMethods.has(`methods/${name}`)) : [];
  if (extras.length) throw new Error(`unexpected method references: ${extras.join(", ")}`);
  if (mode === "--check" && changed.length) throw new Error(`method references are missing or drifted: ${changed.join(", ")}`);
  process.stdout.write(`method references ${mode === "--write" ? "written" : "valid"}: methods=${expectedMethods.size} files=${documents.size}\n`);
}

try { main(); } catch (error) {
  process.stderr.write(`method reference generation failed: ${error.message}\n`);
  process.exitCode = 1;
}
