import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESEARCH_LANGUAGES } from "../../mcp/lib/lang.mjs";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { methodVoiceFacts } from "../helpers/method-voice-facts.mjs";
import { startServer, structured } from "../helpers/rpc-client.mjs";

const titles = {
  es: "Configuración del análisis", fr: "Configuration de la recherche", de: "Recherchekonfiguration",
  "pt-BR": "Configuração da pesquisa", it: "Configurazione della ricerca", ru: "Настройка исследования",
  vi: "Cấu hình nghiên cứu", id: "Pengaturan riset",
};
const languages = RESEARCH_LANGUAGES.filter(({ locale }) => titles[locale]);
let dataDir;
let server;
before(async () => {
  dataDir = makeDataDir();
  server = startServer({ dataDir });
  await server.request("initialize", {});
});
after(async () => { await server.close(); removeDataDir(dataDir); });

function readerText(response) {
  structured(response);
  return response.result.content[0].text;
}

function assertTranslated(text) {
  assert.doesNotMatch(text, /Research setup|Full method catalog|Advisory method-simulation panel|No method passed the advisory|No advisory panel was generated|Calibrated decision context|Analyst selection|Choose 1 to|Quick mode: choose|Starter panel:|Research starts only after|\bundefined\b|\{\d+\}/u);
}

test("each new language has a localized real selection summary, complete catalog and one-use confirmation", async () => {
  for (const { locale, name } of languages) {
    const response = await server.callTool("begin_council_selection", { symbol: "QQQ", language: locale, host: "terminal-language-fixture" });
    const opened = structured(response);
    const text = readerText(response);
    assert.equal(opened.language, name);
    assert.match(opened.display_markdown, new RegExp(titles[locale], "u"));
    assertTranslated(text);
    assert.equal(opened.masters.length, 26);
    for (const master of opened.masters) {
      for (const key of ["title", "identity", "method", "best_for", "maturity_label"]) assert.ok(text.includes(master[key]), `${locale}/${master.id}/${key}`);
    }
    const context = JSON.parse(text.match(/^ALPHACOUNCIL_SELECTION_CONTEXT (\{.*\})$/mu)[1]);
    assert.equal(context.catalog_hash, opened.catalog_hash);
    assert.equal(context.selection_id, opened.selection_id);
    const args = { selection_id: opened.selection_id, catalog_hash: opened.catalog_hash,
      selected_master_ids: ["master_buffett"], analyst_scope: "core" };
    assert.ok((await server.callTool("confirm_master_selection", args)).error, "translation does not bypass acknowledgement");
    const confirmedResponse = await server.callTool("confirm_master_selection", { ...args, display_ack: true });
    const confirmed = structured(confirmedResponse);
    assert.equal(confirmed.language, name);
    assert.equal(confirmed.selected_count, 1);
    assert.equal(confirmed.selected_analyst_count, 8);
    assert.ok(confirmed.selection_receipt);
    assert.doesNotMatch(readerText(confirmedResponse), /Confirmed 1 method seat/u);
  }
  assert.equal(existsSync(join(dataDir, "runs")), false, "opening and confirming never start research");
});

test("quick, calibrated recommended and uncovered panels render without English menu fallbacks", async () => {
  const facts = methodVoiceFacts("2026-07-28").typed_fact_pack.facts.map((fact) => fact.fact_id);
  for (const { locale } of languages) {
    for (const scenario of ["quick", "covered", "uncovered"]) {
      const response = await server.callTool("begin_council_selection", {
        symbol: "AAPL", language: locale, host: `terminal-language-${scenario}`,
        council_mode: scenario === "quick" ? "quick" : "full",
        prompt: "Is AAPL worth buying for a one-year holding period?",
        instrument_classification: { asset_type: "equity", research_model: "operating_company", classification_source: "selection_language_fixture" },
        typed_fact_coverage: scenario === "uncovered" ? [] : facts,
      });
      const opened = structured(response);
      assertTranslated(readerText(response));
      assert.equal(opened.decision_context.rating_basis_required, true);
      assert.equal(opened.maximum, scenario === "quick" ? 4 : 26);
      assert.ok(opened.decision_context_hash);
    }
  }
});

test("read_run progress and missing handoff remain localized without inventing a report", async () => {
  for (const { locale, name } of languages) {
    const id = `READER-${locale.toUpperCase()}`;
    const dir = join(dataDir, "runs", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "evidence.json"), "{}");
    for (const status of ["running", "incomplete"]) {
      writeFileSync(join(dir, "status.json"), JSON.stringify({ run_id: id, language: name, status, phase: "evidence", tasks: [] }));
      const response = await server.callTool("read_run", { run_id: id });
      const text = readerText(response);
      assert.doesNotMatch(text, /AlphaCouncil run |Next: call|but its user handoff is missing|\bundefined\b|\{\d+\}/u);
      assert.ok(text.includes(id));
      assert.equal(structured(response).status.status, status);
      assert.equal(structured(response).user_response_markdown, "");
    }
  }
});
