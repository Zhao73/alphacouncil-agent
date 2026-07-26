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
  // DEFAULT_TASKS is the default roster, not the whole analyst set: optional analysts
  // such as macro_regime ship in other rosters and must not widen the default fan-out.
  assert.deepEqual(selectRoster(reg, { kind: "analyst", roster: "default" }).map((p) => p.id), DEFAULT_TASKS);
  for (const task of DEFAULT_TASKS) assert.ok(reg.ids("analyst").includes(task));
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
  for (const id of reg.ids("analyst")) {
    assert.equal(reg.get(id).kind, "analyst", "masters must not leak into the evidence roster");
  }
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
  assert.deepEqual(selectRoster(reg, { kind: "analyst", roster: "default" }).map((p) => p.id), DEFAULT_TASKS);
  assert.deepEqual(reg.ids("debate"), DEBATE_ROLES);
  for (const id of reg.ids("verifier")) {
    assert.ok(!reg.ids("analyst").includes(id));
    assert.ok(!reg.ids("debate").includes(id));
  }
});

test("an optional analyst is selectable but stays out of the default roster", () => {
  const reg = shippedPersonas();
  assert.ok(reg.get("macro_regime"), "macro_regime must exist");
  assert.ok(reg.ids("analyst").includes("macro_regime"), "it must be selectable through the tool schema");
  assert.ok(!DEFAULT_TASKS.includes("macro_regime"), "it must not widen the default fan-out");
  assert.deepEqual(reg.get("macro_regime").rosters, ["full"]);
});

// ---- the full master bench ------------------------------------------------

const MASTER_ROSTERS = [
  "masters-value", "masters-value-classic", "masters-adversarial", "masters-quant", "masters-modern",
  "masters-options",
];

test("every master roster is populated and disjoint", () => {
  const reg = shippedPersonas();
  const seen = new Set();
  for (const roster of MASTER_ROSTERS) {
    const members = selectRoster(reg, { kind: "master", roster });
    assert.ok(members.length > 0, `${roster} is empty`);
    for (const member of members) {
      assert.ok(!seen.has(member.id), `${member.id} appears in more than one roster`);
      seen.add(member.id);
    }
  }
  assert.equal(seen.size, reg.ids("master").length, "every master belongs to a roster");
});

test("the bench actually disagrees with itself", () => {
  // A committee of lenses that all share a philosophy is one lens wearing hats. These
  // three must be present and must not share tags, or the debate has no opposition.
  const reg = shippedPersonas();
  const value = new Set(reg.get("master_buffett").philosophy_tags);
  const adversarial = new Set(reg.get("master_soros").philosophy_tags);
  const quant = new Set(reg.get("master_simons").philosophy_tags);
  for (const [a, b, label] of [[value, adversarial, "value vs adversarial"], [value, quant, "value vs quant"]]) {
    const shared = [...a].filter((tag) => b.has(tag));
    assert.deepEqual(shared, [], `${label} must not share a philosophy tag`);
  }
});

test("every master states what would make it walk away, in falsifiable terms", () => {
  for (const master of shippedPersonas().all().filter((p) => p.kind === "master")) {
    assert.ok(master.disqualifiers?.length >= 2, `${master.id} needs at least two disqualifiers`);
    for (const item of master.disqualifiers) {
      assert.ok(item.length > 20, `${master.id} has a disqualifier too vague to check: "${item}"`);
    }
  }
});

test("no master body contains an unfalsifiable star rating", () => {
  // ai-berkshire scores things like "★★★☆☆: the model is understandable but ten-year
  // certainty is low". The table shape is useful; the score is not checkable.
  for (const master of shippedPersonas().all().filter((p) => p.kind === "master")) {
    for (const [lang, body] of Object.entries(master.bodies)) {
      assert.ok(!/[★☆]/.test(body), `${master.id} [${lang}] uses star ratings`);
    }
  }
});

test("adapted masters carry attribution and original ones declare none", () => {
  for (const master of shippedPersonas().all().filter((p) => p.kind === "master")) {
    if (master.source === null) continue;
    assert.ok(master.source.license, `${master.id} adapts upstream work and must name the licence`);
    assert.ok(master.source.attribution, `${master.id} must carry the upstream copyright line`);
  }
});

// ---- roster shape after the consolidation ----------------------------------

test("the default fan-out is eight analysts, not eleven", () => {
  assert.equal(DEFAULT_TASKS.length, 8);
  // The three removed roles were merged, not dropped: their subject matter has to
  // survive inside the role that absorbed it.
  const reg = shippedPersonas();
  // Each absorbing seat must both declare the absorption and actually carry the topic.
  // The declaration alone could be a comment; the topic alone could be a coincidence.
  for (const [topic, into] of [
    [/earnings call|the call\b/, "earnings_deep_dive"],
    [/sell-side|target-price/, "forward_expectations"],
    [/practitioner|industry voices/, "news_industry_management"],
  ]) {
    const body = reg.get(into).bodies.en.toLowerCase();
    assert.match(body, /absorbed the former standalone/,
      `${into} must state which role it absorbed, so a reader knows where the topic went`);
    assert.match(body, topic, `${into} must still carry the absorbed topic, not just claim to`);
  }
  for (const gone of ["earnings_call_transcript", "sell_side_revisions", "management_industry_voices"]) {
    assert.equal(reg.get(gone), undefined, `${gone} should no longer exist as a separate persona`);
  }
});

test("masters-core seats at least ten and spans opposing schools", () => {
  const reg = shippedPersonas();
  const core = selectRoster(reg, { kind: "master", roster: "masters-core" });
  assert.ok(core.length >= 10, `masters-core has ${core.length}, expected at least 10`);

  // A bench of twelve value investors is one lens wearing twelve hats. Require the
  // adversarial and quant schools to be present.
  const ids = core.map((p) => p.id);
  assert.ok(ids.includes("master_soros") || ids.includes("master_dalio"), "needs a macro/reflexivity lens");
  assert.ok(ids.includes("master_short_seller"), "needs a short seller");
  assert.ok(ids.includes("master_simons") || ids.includes("master_asness"), "needs a quant lens");
  assert.ok(ids.includes("master_buffett"), "needs the value core");

  // Enough distinct philosophy tags that the seats cannot all be asking the same thing.
  const tags = new Set(core.flatMap((p) => p.philosophy_tags));
  assert.ok(tags.size >= 25, `only ${tags.size} distinct philosophy tags across the bench`);
});

test("every master still belongs to a school roster as well as core", () => {
  const reg = shippedPersonas();
  for (const id of selectRoster(reg, { kind: "master", roster: "masters-core" }).map((p) => p.id)) {
    const rosters = reg.get(id).rosters.filter((r) => r !== "masters-core");
    assert.ok(rosters.length >= 1, `${id} must keep its school roster so the schools remain selectable`);
  }
});

// get_options_chain gives IV, skew and open interest but no history, so IV percentile is
// uncomputable. Left unstated, a model asked "is IV high?" answers from training data and
// the stale number reads exactly like a live one.
test("options masters name the chain feed and refuse to invent IV history", () => {
  const reg = shippedPersonas();
  const members = selectRoster(reg, { kind: "master", roster: "masters-options" });
  assert.ok(members.length >= 3, "the options bench needs at least three lenses");
  for (const m of members) {
    assert.match(m.bodies.zh, /get_options_chain/, `${m.id} zh must name the tool`);
    assert.match(m.bodies.en, /get_options_chain/, `${m.id} en must name the tool`);
    assert.match(m.bodies.zh, /无法从本系统计算/, `${m.id} zh must refuse IV percentile`);
    assert.match(m.bodies.en, /cannot be computed here/, `${m.id} en must refuse IV percentile`);
  }
});

// A lens without a stated way of thinking degenerates into a checklist, and a bench of
// checklists agrees with itself -- which is the failure this whole roster exists to avoid.
test("every master states how it thinks, not just what it checks", () => {
  const reg = shippedPersonas();
  const masters = reg.ids("master").map((id) => reg.get(id));
  assert.ok(masters.length >= 20, "the bench should not silently shrink");
  for (const m of masters) {
    assert.match(m.bodies.zh, /##\s*你是谁/, `${m.id} zh needs a personality section`);
    assert.match(m.bodies.en, /##\s*Who you are/, `${m.id} en needs a personality section`);
  }
});
