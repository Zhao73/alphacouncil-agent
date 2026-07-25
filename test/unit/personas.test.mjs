import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePersonaFile, toYamlFrontmatter } from "../../mcp/lib/personas/frontmatter.mjs";
import { loadPersonas, registry, selectRoster, personaPrompt, personaTitle } from "../../mcp/lib/personas/registry.mjs";
import { DEFAULT_TASKS, DEBATE_ROLES } from "../../mcp/lib/constants.mjs";

const VALID_META = {
  schema_version: 1,
  id: "example_role",
  kind: "analyst",
  order: 10,
  enabled: true,
  rosters: ["default"],
  title: { zh: "示例", en: "Example" },
  model_tier: "fast",
  tags: [],
  langs: ["zh", "en"],
  default_lang: "en",
  output_contract: "evidence_packet",
  tools_hint: [],
  source: null,
};

const personaText = (meta = {}, bodies = { zh: "中文正文", en: "English body" }) =>
  `---json\n${JSON.stringify({ ...VALID_META, ...meta }, null, 2)}\n---\n\n`
  + Object.entries(bodies).map(([lang, body]) => `<!-- lang:${lang} -->\n${body}`).join("\n\n")
  + "\n";

function withDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "personas-test-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      const path = join(dir, name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- frontmatter ----------------------------------------------------------

test("parsePersonaFile splits frontmatter from language sections", () => {
  const { meta, bodies } = parsePersonaFile(personaText());
  assert.equal(meta.id, "example_role");
  assert.equal(bodies.zh, "中文正文");
  assert.equal(bodies.en, "English body");
});

test("parsePersonaFile fails loudly on malformed JSON instead of guessing", () => {
  assert.throws(
    () => parsePersonaFile("---json\n{ not: json }\n---\n\n<!-- lang:en -->\nx\n", "bad.md"),
    /bad\.md: frontmatter is not valid JSON/,
  );
});

test("parsePersonaFile rejects a file with no frontmatter or no language section", () => {
  assert.throws(() => parsePersonaFile("# just markdown\n", "a.md"), /missing ---json frontmatter/);
  assert.throws(() => parsePersonaFile(`---json\n{}\n---\n\nbody\n`, "b.md"), /no <!-- lang:xx --> section/);
});

test("parsePersonaFile refuses to silently drop text before the first marker", () => {
  const text = `---json\n${JSON.stringify(VALID_META)}\n---\n\nstray prose\n\n<!-- lang:en -->\nbody\n`;
  assert.throws(() => parsePersonaFile(text, "c.md"), /would be silently dropped/);
});

test("a heading inside a persona body does not confuse the language split", () => {
  const { bodies } = parsePersonaFile(personaText({}, { en: "## A heading\ntext\n### Another" }));
  assert.match(bodies.en, /## A heading/);
  assert.match(bodies.en, /### Another/);
});

test("toYamlFrontmatter quotes values a YAML reader could misread", () => {
  const yaml = toYamlFrontmatter({ name: "plain-name", description: "Buy: or Sell", tools: ["a", "b"], skip: "" });
  assert.match(yaml, /^---\n/);
  assert.match(yaml, /name: plain-name/);
  assert.match(yaml, /description: "Buy: or Sell"/);
  assert.match(yaml, /tools: a, b/);
  assert.ok(!yaml.includes("skip"), "empty values are omitted");
});

// ---- registry validation --------------------------------------------------

const shippedPersonas = () => registry();

test("the shipped persona set loads and covers every task and debate role", () => {
  const reg = shippedPersonas();
  for (const task of DEFAULT_TASKS) {
    const persona = reg.get(task);
    assert.ok(persona, `no persona for default task ${task}`);
    assert.equal(persona.kind, "analyst");
  }
  for (const role of DEBATE_ROLES) {
    const persona = reg.get(role);
    assert.ok(persona, `no persona for debate role ${role}`);
    assert.equal(persona.kind, "debate");
  }
  assert.deepEqual(reg.ids("analyst"), DEFAULT_TASKS);
});

test("every shipped persona carries both languages with non-empty bodies", () => {
  for (const persona of shippedPersonas().all()) {
    assert.deepEqual(persona.langs, ["zh", "en"], `${persona.id} must declare zh and en`);
    for (const lang of persona.langs) {
      assert.ok(persona.bodies[lang]?.trim(), `${persona.id} has an empty ${lang} body`);
    }
  }
});

test("loading reports every problem at once rather than one per run", () => {
  withDir({
    "a.md": personaText({ id: "BAD ID", order: "not a number" }),
    "b.md": personaText({ id: "b_role", langs: ["zh", "en", "ja"] }),
  }, (dir) => {
    try {
      loadPersonas({ dir });
      assert.fail("expected a throw");
    } catch (error) {
      assert.match(error.message, /id must match/);
      assert.match(error.message, /order must be a finite number/);
      assert.match(error.message, /no non-empty <!-- lang:ja --> section/);
      assert.match(error.message, /DEFAULT_TASKS includes "market_data"/);
    }
  });
});

test("a duplicate persona id is rejected", () => {
  withDir({ "a.md": personaText({ id: "dup_id" }), "b.md": personaText({ id: "dup_id" }) }, (dir) => {
    assert.throws(() => loadPersonas({ dir }), /duplicate persona id "dup_id"/);
  });
});

test("adapted content must carry attribution", () => {
  withDir({ "a.md": personaText({ source: { name: "somewhere" } }) }, (dir) => {
    assert.throws(() => loadPersonas({ dir }), /source must be null or an object with at least \{ name, license \}/);
  });
});

// A missing persona directory must be loud. Once the inline literals are gone there is
// no fallback text, so degrading gracefully would mean shipping empty prompts.
test("a missing persona directory fails fast with an actionable message", () => {
  assert.throws(
    () => loadPersonas({ dir: join(tmpdir(), "definitely-not-a-persona-dir-xyz") }),
    /persona directory is unreadable.*ALPHACOUNCIL_PERSONAS_DIR/s,
  );
});

test("an empty persona directory is an error, not an empty roster", () => {
  withDir({}, (dir) => assert.throws(() => loadPersonas({ dir }), /no persona files found/));
});

// ---- selection ------------------------------------------------------------

test("selectRoster returns enabled personas of a kind, ordered", () => {
  const roster = selectRoster(shippedPersonas(), { kind: "analyst", roster: "default" });
  assert.deepEqual(roster.map((p) => p.id), DEFAULT_TASKS);
  assert.ok(roster.every((p) => p.enabled));
});

test("selectRoster by explicit ids ignores roster membership and rejects unknown ids", () => {
  const reg = shippedPersonas();
  assert.deepEqual(selectRoster(reg, { ids: ["quant_factor", "market_data"] }).map((p) => p.id),
    ["market_data", "quant_factor"], "results stay in declared order");
  assert.throws(() => selectRoster(reg, { ids: ["market_data", "no_such_role"] }), /unknown persona id\(s\): no_such_role/);
});

test("shared preamble personas are disabled so they never appear in a roster", () => {
  const reg = shippedPersonas();
  for (const id of ["_evidence_base", "_debate_base"]) {
    assert.ok(reg.get(id), `${id} must exist`);
    assert.equal(reg.get(id).enabled, false);
  }
  assert.ok(!reg.ids("analyst").includes("_evidence_base"));
  assert.ok(!reg.ids("debate").includes("_debate_base"));
});

test("personaPrompt and personaTitle follow the requested language", () => {
  const persona = shippedPersonas().get("market_data");
  assert.notEqual(personaPrompt(persona, "中文"), personaPrompt(persona, "English"));
  assert.equal(personaTitle(persona, "English"), "Market Data Analyst");
  assert.equal(personaTitle(persona, "中文"), "行情数据分析师");
});

test("an unknown language falls back to the persona default rather than an empty prompt", () => {
  const persona = shippedPersonas().get("market_data");
  assert.equal(personaPrompt(persona, "Klingon"), personaPrompt(persona, "English"));
});

// ---- masters --------------------------------------------------------------

test("master personas are selectable by roster and stay out of the analyst enum", () => {
  const reg = shippedPersonas();
  const masters = selectRoster(reg, { kind: "master", roster: "masters-value" });
  assert.ok(masters.length >= 2, "the masters-value roster must have seed personas");
  assert.ok(masters.every((p) => p.kind === "master"));
  assert.deepEqual(reg.ids("analyst"), DEFAULT_TASKS, "masters must not leak into the evidence roster");
});

test("every master declares what would make it walk away", () => {
  for (const master of shippedPersonas().all().filter((p) => p.kind === "master")) {
    assert.ok(master.philosophy_tags?.length, `${master.id} needs philosophy_tags`);
    assert.ok(master.disqualifiers?.length, `${master.id} needs disqualifiers`);
    assert.ok(master.era, `${master.id} needs era`);
    assert.ok(master.holding_period, `${master.id} needs holding_period`);
  }
});

test("a master persona without disqualifiers is rejected", () => {
  withDir({
    "m.md": personaText({ id: "m_x", kind: "master", philosophy_tags: ["x"], era: "now", holding_period: "long" }),
    ...Object.fromEntries(DEFAULT_TASKS.map((t) => [`${t}.md`, personaText({ id: t })])),
    ...Object.fromEntries(DEBATE_ROLES.map((r) => [`${r}.md`, personaText({ id: r, kind: "debate" })])),
  }, (dir) => {
    assert.throws(() => loadPersonas({ dir }), /must declare disqualifiers/);
  });
});

test("adapted master content carries its upstream attribution", () => {
  const buffett = shippedPersonas().get("master_buffett");
  assert.equal(buffett.source.license, "MIT");
  assert.match(buffett.source.attribution, /xbtlin/);
});

// ---- verifiers ------------------------------------------------------------

test("the three Stage 2b verifiers exist with disjoint verdict spaces", () => {
  const reg = shippedPersonas();
  const verifiers = selectRoster(reg, { kind: "verifier", roster: "verify" });
  assert.deepEqual(verifiers.map((p) => p.id), ["source_fidelity", "rederivation", "refuter"]);
  for (const verifier of verifiers) {
    assert.ok(verifier.verdict_values.length >= 2, `${verifier.id} needs a verdict space`);
    assert.equal(verifier.output_contract, "verifier_verdict");
  }
  // Each verifier answers a different question, so their verdict vocabularies differ.
  const spaces = verifiers.map((v) => v.verdict_values.join("|"));
  assert.equal(new Set(spaces).size, verifiers.length, "verifiers must not share a verdict space");
});

test("each verifier declares the tools its method actually needs", () => {
  const reg = shippedPersonas();
  // source_fidelity opens one cited URL; the other two must search independently.
  assert.deepEqual(reg.get("source_fidelity").tools_hint, ["webfetch"]);
  for (const id of ["rederivation", "refuter"]) {
    assert.ok(reg.get(id).tools_hint.includes("websearch"), `${id} must be able to search`);
  }
});

test("a verifier without a verdict space is rejected", () => {
  withDir({
    "v.md": personaText({ id: "v_x", kind: "verifier", output_contract: "verifier_verdict" }),
    ...Object.fromEntries(DEFAULT_TASKS.map((t) => [`${t}.md`, personaText({ id: t })])),
    ...Object.fromEntries(DEBATE_ROLES.map((r) => [`${r}.md`, personaText({ id: r, kind: "debate" })])),
  }, (dir) => assert.throws(() => loadPersonas({ dir }), /must declare verdict_values/));
});

test("verifiers stay out of the evidence and debate rosters", () => {
  const reg = shippedPersonas();
  assert.deepEqual(reg.ids("analyst"), DEFAULT_TASKS);
  assert.deepEqual(reg.ids("debate"), DEBATE_ROLES);
});
