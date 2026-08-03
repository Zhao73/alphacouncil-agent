import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CANONICAL_MASTER_IDS } from "../../mcp/lib/personas-v3/staging.mjs";
import { FIRST_PERSON_DISCLOSURE_ACK, FIRST_PERSON_VOICE_MODE, VOICE_DISCLOSURES } from "../../mcp/lib/voice.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SKILL = join(ROOT, "skills", "alphacouncil-method-lenses");
const CATALOG = JSON.parse(readFileSync(join(SKILL, "references", "catalog.v1.json"), "utf8"));

function hash(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function npmInvocation(args) {
  const npmExecPath = process.env.npm_execpath;
  if (typeof npmExecPath === "string" && npmExecPath.trim() && existsSync(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", ...args],
    };
  }
  return { command: "npm", args };
}

test("method-lens Skill closes exactly over the 26 active methods and retires the AI seat", () => {
  assert.equal(CATALOG.active_method_count, 26);
  assert.deepEqual(CATALOG.active_method_ids, [...CANONICAL_MASTER_IDS]);
  assert.deepEqual(CATALOG.retired_method_ids, ["master_aschenbrenner"]);
  assert.equal(CATALOG.methods.length, 26);
  assert.equal(CATALOG.methods.filter((item) => item.kind === "named_public_method_reference").length, 25);
  assert.equal(CATALOG.methods.filter((item) => item.kind === "composite_professional_method").length, 1);
  assert.equal(CATALOG.methods.every((item) => item.reference_status === "method_reference_provisional"), true);
  assert.equal(CATALOG.methods.every((item) => item.human_method_attribution_approved === false), true);
  assert.equal(new Set(CATALOG.methods.map((item) => item.voice_profile_hash)).size, 26);
  assert.equal(new Set(CATALOG.methods.map((item) => item.pack_snapshot_hash)).size, 26);
  assert.equal(existsSync(join(SKILL, "references", "methods", "master_aschenbrenner.md")), false);
});

test("every on-demand method reference is hash-bound and carries the strong first-person method contract", () => {
  for (const method of CATALOG.methods) {
    const file = join(SKILL, "references", method.reference_path);
    const text = readFileSync(file, "utf8");
    assert.equal(hash(text), method.reference_hash, method.method_id);
    assert.match(text, /method_reference_provisional/u, method.method_id);
    assert.match(text, /not the named person's identity.*current view/su, method.method_id);
    assert.equal(method.voice_mode, FIRST_PERSON_VOICE_MODE, method.method_id);
    assert.equal(method.disclosure_ack, FIRST_PERSON_DISCLOSURE_ACK, method.method_id);
    assert.match(method.voice_profile_hash, /^sha256:[a-f0-9]{64}$/u, method.method_id);
    assert.match(text, /First-person public-method simulation blueprint/u, method.method_id);
    assert.match(text, /MUST speak directly as `I` \/ `我`/u, method.method_id);
    assert.match(text, /Speak in strong first person as this public-method simulation/u, method.method_id);
    assert.doesNotMatch(text, /Use neutral third-person method language/u, method.method_id);
    assert.match(text, /Never write `I am <named person>`/u, method.method_id);
    assert.match(text, /Exact provisional decision policy/u, method.method_id);
    assert.match(text, /Physical public-source candidates/u, method.method_id);
  }
});

test("public-source summaries preserve the current AI-only verdict boundary", () => {
  const totals = CATALOG.methods.reduce((out, method) => {
    out.candidates += method.source_candidate_count;
    for (const [verdict, count] of Object.entries(method.source_machine_verdict_counts)) out[verdict] += count;
    return out;
  }, { candidates: 0, supported: 0, partial: 0, unverifiable: 0, unsupported: 0 });
  assert.deepEqual(totals, { candidates: 31, supported: 16, partial: 9, unverifiable: 6, unsupported: 0 });
});

test("method references expose every currently known cross-unit policy comparison", () => {
  const findings = CATALOG.methods.flatMap((method) => method.contract_findings.map((finding) => ({
    method_id: method.method_id,
    status: finding.status,
    condition_path: finding.condition_path,
    left_unit: finding.left.unit,
    right_unit: finding.right.unit,
  }))).sort((left, right) => left.method_id.localeCompare(right.method_id));
  assert.deepEqual(findings, [
    {
      method_id: "master_natenberg",
      status: "requires_human_formula_adjudication",
      condition_path: "decision_policy.scoring.rules[0].condition",
      left_unit: "decimal_annualized_volatility",
      right_unit: "decimal_of_mid",
    },
    {
      method_id: "master_sinclair",
      status: "requires_human_formula_adjudication",
      condition_path: "decision_policy.hard_vetoes[0].condition",
      left_unit: "decimal_of_mid",
      right_unit: "decimal_annualized_volatility",
    },
    {
      method_id: "master_thorp",
      status: "requires_human_formula_adjudication",
      condition_path: "decision_policy.hard_vetoes[0].condition",
      left_unit: "decimal",
      right_unit: "decimal_of_mid",
    },
  ]);
  assert.equal(CATALOG.methods.reduce((sum, method) => sum + method.contract_finding_count, 0), 3);
});

test("the reference generator is deterministic and the Skill passes the bundled portable validator", () => {
  execFileSync(process.execPath, [join(SKILL, "scripts", "generate-method-references.mjs"), "--check"], { cwd: ROOT });
  const validator = join(ROOT, "scripts", "quick-validate-skill.mjs");
  const result = spawnSync(process.execPath, [validator, SKILL], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("the bundled Skill validator rejects invalid portable frontmatter", () => {
  const validator = join(ROOT, "scripts", "quick-validate-skill.mjs");
  const directory = mkdtempSync(join(tmpdir(), "alphacouncil-invalid-skill-"));
  writeFileSync(join(directory, "SKILL.md"), "---\nname: Invalid Name\ndescription: invalid\n---\n");
  const result = spawnSync(process.execPath, [validator, directory], { cwd: ROOT, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /hyphen-case/u);
});

test("full-evidence validator accepts bound facts and rejects the retired method", () => {
  const directory = mkdtempSync(join(tmpdir(), "alphacouncil-method-input-"));
  const file = join(directory, "input.json");
  const base = {
    schema_version: 1,
    case: {
      case_id: "case-1", instrument_id: "TEST", instrument_type: "company", currency: "USD",
      question: "Assess TEST", as_of: "2026-08-03T00:00:00.000Z", knowledge_as_of: "2026-08-03T00:00:00.000Z", horizons: ["base"],
    },
    selected_method_ids: ["master_buffett"],
    typed_fact_pack: {
      schema_version: 1,
      as_of: "2026-08-03T00:00:00.000Z",
      knowledge_as_of: "2026-08-03T00:00:00.000Z",
      fact_pack_hash: `sha256:${"1".repeat(64)}`,
      facts: [{
        schema_version: 1, fact_id: "market.price", value_kind: "monetary", value: 10,
        unit: "currency_units", currency: "USD", scale: 1, period_start: null, period_end: null,
        fiscal_year: null, as_of: "2026-08-03T00:00:00.000Z", public_at: "2026-08-03T00:00:00.000Z",
        source_ids: ["S1"], derivation: "reported", confidence: 1, restatement_policy: "frozen fixture",
        lineage: { input_fact_ids: [], tool_id: null, tool_version: null, calculation_hash: null },
      }],
    },
    evidence_packets: [],
    source_manifest: [{
      id: "S1", url: "https://example.test/source", published_at: "2026-08-02T00:00:00.000Z",
      public_at: "2026-08-02T00:00:00.000Z", retrieved_at: "2026-08-03T00:00:00.000Z",
      locator: "page 1", content_hash: `sha256:${"2".repeat(64)}`,
    }],
    claim_ledger: [], coverage_ledger: {}, artifact_refs: [], bindings: {}, frozen_method_result: null,
  };
  writeFileSync(file, `${JSON.stringify(base)}\n`);
  const validator = join(SKILL, "scripts", "validate-evidence-pack.mjs");
  assert.equal(spawnSync(process.execPath, [validator, file]).status, 0);
  const badHash = structuredClone(base);
  badHash.typed_fact_pack.fact_pack_hash = "sha256:bad";
  writeFileSync(file, `${JSON.stringify(badHash)}\n`);
  assert.notEqual(spawnSync(process.execPath, [validator, file]).status, 0);
  const postAsOf = structuredClone(base);
  postAsOf.typed_fact_pack.facts[0].public_at = "2026-08-04T00:00:00.000Z";
  writeFileSync(file, `${JSON.stringify(postAsOf)}\n`);
  assert.notEqual(spawnSync(process.execPath, [validator, file]).status, 0);
  const wrongUnit = structuredClone(base);
  wrongUnit.typed_fact_pack.facts[0].unit = "decimal";
  writeFileSync(file, `${JSON.stringify(wrongUnit)}\n`);
  assert.notEqual(spawnSync(process.execPath, [validator, file]).status, 0);
  base.selected_method_ids = ["master_aschenbrenner"];
  writeFileSync(file, `${JSON.stringify(base)}\n`);
  assert.notEqual(spawnSync(process.execPath, [validator, file]).status, 0);
});

test("method output validator requires the fixed label and first person in every field", () => {
  const directory = mkdtempSync(join(tmpdir(), "alphacouncil-method-output-"));
  const file = join(directory, "output.json");
  const valid = {
    schema_version: 1,
    method_id: "master_buffett",
    reference_status: "method_reference_provisional",
    language: "zh",
    voice_mode: FIRST_PERSON_VOICE_MODE,
    disclosure_ack: FIRST_PERSON_DISCLOSURE_ACK,
    disclosure: VOICE_DISCLOSURES.zh,
    position_intent: "would_watch",
    voice: {
      would_i_act: "我现在会继续观察，不会越过冻结立场。",
      what_i_see: "我看到输入仍有关键缺口。",
      how_my_method_reads_it: "我先看能力圈，再看现金质量，最后才谈价格。",
      where_i_disagree: "我不同意用故事替代可核验数字。",
      what_changes_my_mind: "如果缺失事实补齐，我会重新判断。",
    },
  };
  const validator = join(SKILL, "scripts", "validate-method-output.mjs");
  writeFileSync(file, `${JSON.stringify(valid)}\n`);
  assert.equal(spawnSync(process.execPath, [validator, file]).status, 0);

  const thirdPerson = structuredClone(valid);
  thirdPerson.voice.what_i_see = "Buffett would inspect the input gap.";
  writeFileSync(file, `${JSON.stringify(thirdPerson)}\n`);
  assert.notEqual(spawnSync(process.execPath, [validator, file]).status, 0);

  const rewrittenLabel = structuredClone(valid);
  rewrittenLabel.disclosure = "hidden";
  writeFileSync(file, `${JSON.stringify(rewrittenLabel)}\n`);
  assert.notEqual(spawnSync(process.execPath, [validator, file]).status, 0);
});

test("the npm package contains the router, contracts, catalog and all method references", () => {
  const npm = npmInvocation(["pack", "--dry-run", "--json"]);
  const packed = JSON.parse(execFileSync(npm.command, npm.args, { cwd: ROOT, encoding: "utf8" }))[0].files.map((item) => item.path);
  assert.ok(packed.includes("skills/alphacouncil-method-lenses/SKILL.md"));
  assert.ok(packed.includes("skills/alphacouncil-method-lenses/agents/openai.yaml"));
  assert.ok(packed.includes("skills/alphacouncil-method-lenses/references/catalog.v1.json"));
  assert.ok(packed.includes("skills/alphacouncil-method-lenses/references/first-person-voice-contract-v1.md"));
  assert.ok(packed.includes("skills/alphacouncil-method-lenses/scripts/validate-method-output.mjs"));
  assert.ok(packed.includes("scripts/quick-validate-skill.mjs"));
  assert.equal(packed.filter((path) => path.startsWith("skills/alphacouncil-method-lenses/references/methods/") && path.endsWith(".md")).length, 26);
});
