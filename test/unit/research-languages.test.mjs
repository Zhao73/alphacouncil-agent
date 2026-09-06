import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { RESEARCH_LANGUAGES, languageKey, normalizeLanguage, readerLanguageStatus, researchLanguage, researchLanguageInstruction } from "../../mcp/lib/lang.mjs";
import { EXTRA_RESEARCH_LOCALES, readerText, localizedReader, researchSectionHeading } from "../../mcp/lib/research-locales.mjs";
import { catalogSnapshot } from "../../mcp/lib/council-selection.mjs";
import { voiceFromDecline, voiceFromDecision } from "../../mcp/lib/voice-from-decision.mjs";
import { hasFirstPersonMarker, VOICE_FIELDS } from "../../mcp/lib/voice.mjs";
import { renderStructuredManagerReport } from "../../mcp/lib/manager-report.mjs";
import { bindMachineCheckedRatingBasisMarkdown, normalizeMasterOpinion, debateFailurePacket, managerFallback } from "../../mcp/lib/packets.mjs";
import { protectedRatingAuthorityOccurrences, containsProtectedRatingAuthority } from "../../mcp/lib/reader-prose.mjs";
import { renderPacketMarkdown, renderMasterMarkdown, renderDebateMarkdown, renderBenchSummary, finalReportMarkdown, userResponseMarkdown } from "../../mcp/lib/markdown.mjs";
import { requiredReportSectionAliases, validateFinalReport, withCompletenessBanner, withVerificationBanner, withDisclaimer } from "../../mcp/lib/gates.mjs";

const PROSE = {
  es: "Yo considero que la empresa necesita más pruebas. Según mis fuentes, los ingresos y los riesgos requieren un análisis independiente antes de invertir.",
  fr: "Je considère que cette entreprise nécessite davantage de preuves. Selon mes sources, les revenus et les risques demandent une analyse indépendante avant toute décision.",
  de: "Ich sehe für das Unternehmen weitere offene Fragen. Meine Quellen zeigen, dass die Risiken und der Umsatz eine unabhängige Analyse erfordern.",
  "pt-BR": "Eu considero que a empresa precisa de mais evidências. Minhas fontes mostram que os riscos e a receita exigem uma análise independente antes de investir.",
  it: "Io considero che questa azienda richieda altre prove. Le mie fonti mostrano che i rischi e i ricavi necessitano di un’analisi indipendente prima di investire.",
  ru: "Я считаю, что компании нужны дополнительные доказательства. Мои источники показывают, что выручка и риски требуют независимого анализа перед решением.",
  vi: "Tôi cho rằng doanh nghiệp cần thêm bằng chứng. Nguồn dữ liệu của tôi cho thấy cổ phiếu và rủi ro cần được phân tích độc lập trước khi quyết định.",
  id: "Saya menilai perusahaan ini membutuhkan bukti tambahan. Menurut sumber saya, pendapatan dan risiko saham harus dianalisis secara independen sebelum mengambil keputusan.",
};
const ENGLISH = "I consider the company's evidence incomplete. The income and the risks should be independently analyzed before making this investment decision.";

function fixture(locale, mode = "full") {
  const prose = PROSE[locale];
  const packet = { task: "market_data", symbol: "ABC", as_of: "2026-09-06", summary: prose, confidence: "medium", claims: [{ claim: prose, evidence: prose, source_ids: ["market_data:S1"] }], sources: [{ id: "market_data:S1", title: "Original English source title", url: "https://example.com/original", published_at: "2026-09-05" }], open_questions: [] };
  const decision = { rating: "Hold", winner: "balanced", verdict: prose, summary: prose, confidence: "medium", long_thesis: [prose], short_thesis: [prose], valuation_range: prose, position: prose, catalysts: [prose], risks: [prose], invalidation: [prose], data_gaps: [prose], source_ids: ["market_data:S1"], horizon_views: { short_term: prose, medium_term: prose, long_term: prose } };
  const run = { run_id: "LANGUAGE-FIXTURE", symbol: "ABC", as_of: "2026-09-06", language: locale, council_mode: mode, tasks: ["market_data"], task_status: { market_data: { status: "completed" } }, packets: [packet], masters: [], master_opinions: [], agent_status: {}, status: "completed" };
  return { run, packet, decision };
}

test("the shared catalog accepts every declared locale, native name and alias without changing the original four normalized names", () => {
  assert.equal(RESEARCH_LANGUAGES.length, 12);
  assert.deepEqual(RESEARCH_LANGUAGES.slice(0, 4).map(({ name }) => name), ["中文", "English", "日本語", "한국어"]);
  for (const entry of RESEARCH_LANGUAGES) for (const alias of [entry.locale, entry.key, entry.name, ...entry.aliases]) {
    assert.equal(normalizeLanguage(alias), entry.name, alias);
    assert.equal(languageKey(alias), entry.key, alias);
    assert.equal(researchLanguage(alias), entry);
  }
  assert.equal(researchLanguage("ar"), null);
});

test("new Latin-language checks require positive target evidence and reject English and another supported language", () => {
  for (const locale of EXTRA_RESEARCH_LOCALES) {
    assert.equal(readerLanguageStatus(PROSE[locale], locale).status, "passed", locale);
    assert.equal(readerLanguageStatus(ENGLISH, locale).status, "failed", locale);
    assert.equal(readerLanguageStatus(PROSE[locale === "fr" ? "es" : "fr"], locale).status, "failed", locale);
    assert.ok(researchLanguageInstruction(locale).length > 100);
  }
  assert.equal(researchLanguageInstruction("en"), "");
  assert.throws(() => localizedReader("es", { en: "A newly introduced untranslated reader label" }), { code: "RESEARCH_TRANSLATION_MISSING" });
});

for (const locale of EXTRA_RESEARCH_LOCALES) {
  test(`${locale}: selection, five method fields, report headings and failures follow the selected language`, () => {
    const catalog = catalogSnapshot(locale);
    assert.equal(catalog.masters.length, 26);
    assert.ok(catalog.masters.every((master) => master.title && master.identity && master.method && master.best_for));
    assert.notEqual(catalog.masters[0].method, catalogSnapshot("en").masters[0].method);
    assert.equal(catalog.masters[0].pack_hash, catalogSnapshot("en").masters[0].pack_hash);
    const decline = voiceFromDecline({ language: locale, eligibility: { missing_required_fact_types: ["future_revenue"], reason: "missing_required_facts" } });
    const computed = voiceFromDecision({ language: locale, result: { common_projection: { stance: "constructive", score_ratio: 1 }, score: { hits: [{ rule_id: "growth" }], misses: [] } }, policy: { scoring: { rules: [{ rule_id: "growth" }] } } });
    for (const voice of [decline, computed]) for (const field of VOICE_FIELDS) {
      assert.equal(hasFirstPersonMarker(voice[field], locale), true, `${locale}.${field}: ${voice[field]}`);
      assert.ok(!voice[field].startsWith("I "), field);
    }
    const { run, packet, decision } = fixture(locale);
    const report = renderStructuredManagerReport(run, decision);
    assert.ok(report.includes(`## ${researchSectionHeading(locale, "conclusion")}`));
    assert.ok(report.includes("Original English source title"));
    assert.ok(report.includes("https://example.com/original"));
    const audit = validateFinalReport(report, run);
    assert.equal(audit.language_status, "passed", JSON.stringify(audit.reader_language || audit.missing));
    for (const section of requiredReportSectionAliases(run)) assert.equal(section.suggested_heading, researchSectionHeading(locale, section.id));
    assert.ok(renderPacketMarkdown(packet, 0, locale).includes(readerText(locale, "Evidence Analyst Subagent")));
    assert.ok(renderDebateMarkdown({ role: "bull", ...decision }, locale).includes(readerText(locale, "Verdict")));
    const opinion = { master: "master_buffett", stance: "out_of_scope", summary: PROSE[locale], verdict: PROSE[locale], voice: decline, voice_statement: Object.values(decline).join(" "), key_findings: [], disagreements: [], disqualifiers_triggered: [], what_would_change_my_mind: [], source_ids: [] };
    assert.ok(renderMasterMarkdown(opinion, locale).includes(catalog.masters[0].title));
    assert.ok(renderBenchSummary({ ...run, master_opinions: [opinion] }).includes(readerText(locale, "Concurring seats")));
    const failed = managerFallback({ ...run, tasks: [], packets: [] });
    assert.equal(failed.decision_available, false);
    assert.equal(failed.rating, null);
    assert.equal(readerLanguageStatus(failed.summary, locale).status, "passed");
    assert.ok(debateFailurePacket("bull", run, "timeout").summary.includes(readerText(locale, "No usable debate packet was recorded.")));
    assert.ok(finalReportMarkdown(run, { ...decision, report_markdown: report }).includes(researchSectionHeading(locale, "source_table")));
    assert.ok(userResponseMarkdown(run, decision).includes(readerText(locale, "AlphaCouncil Run Summary")));
    assert.ok(withCompletenessBanner("", { completeness: "incomplete", missing_evidence: ["market_data"] }, locale).includes(readerText(locale, "Incomplete Council Run")));
    assert.ok(withVerificationBanner("", { verification: "needs_verification" }, locale).includes(readerText(locale, "Source Verification Gate and Triple Verification")));
    const disclaimer = withDisclaimer("", locale);
    assert.equal(withDisclaimer(disclaimer, locale), disclaimer);
  });
}

test("localized server authority remains unique and cannot be authored by a worker", () => {
  const basis = { horizon_months: 12, reference_price: 100, base_case_price_target: 100, price_currency: "USD", income_return_pct: 0, base_case_total_return_pct: 0, raw_rating: "Hold", risk_adjustment: "none", source_ids: [], return_formula_id: "price_target_plus_income_v1" };
  for (const locale of EXTRA_RESEARCH_LOCALES) {
    const heading = readerText(locale, "Server-Validated Rating Basis");
    assert.equal(containsProtectedRatingAuthority(`## ${heading}`), true, locale);
    assert.throws(() => bindMachineCheckedRatingBasisMarkdown(`## ${heading}`, basis, "Hold", locale));
    const result = bindMachineCheckedRatingBasisMarkdown(PROSE[locale], basis, "Hold", locale);
    assert.deepEqual(protectedRatingAuthorityOccurrences(result), { heading_count: 1, authority_count: 1 });
  }
});

test("new-language first-person trading claims cannot widen an abstention", () => {
  for (const value of ["Yo compraría estas acciones.", "J’achèterais ces actions.", "Ich würde kaufen.", "Eu compraria ações.", "Io comprerei azioni.", "Я куплю акции.", "Tôi sẽ mua cổ phiếu.", "Saya akan membeli saham."]) {
    assert.throws(() => normalizeMasterOpinion({ stance: "out_of_scope", summary: value }, "master_buffett", { symbol: "ABC", packets: [] }), (error) => error?.data?.reason === "METHOD_VOICE_DIRECTIONAL_ABSTENTION", value);
  }
  assert.equal(hasFirstPersonMarker("J’achèterais ces actions.", "fr"), true);
});


test("persisted audit readers render every new language and report the actual API provider", () => {
  const directory = mkdtempSync(join(tmpdir(), "alphacouncil-language-artifacts-"));
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
      cwd: new URL("../../", import.meta.url), encoding: "utf8",
      env: { ...process.env, ALPHACOUNCIL_AGENT_DATA_DIR: directory },
      input: `
        import { mkdirSync, readFileSync } from "node:fs";
        import { join } from "node:path";
        import { writeAllAgentsMarkdown, writeArtifactIndex, finalReportMarkdown, userResponseMarkdown } from "./mcp/lib/markdown.mjs";
        import { EXTRA_RESEARCH_LOCALES, readerText } from "./mcp/lib/research-locales.mjs";
        for (const language of ["en", ...EXTRA_RESEARCH_LOCALES]) {
          const run = { run_id: "LANG-20260906T010000Z-" + language.toUpperCase(), symbol: "ABC", language, as_of: "2026-09-06", tasks: [], packets: [], masters: [], master_opinions: [], agent_status: {}, task_status: {}, status: "failed", council_mode: "quick", worker_execution_config: { provider: "openai", model: "example-model", routing_policy: { mode: "platform_managed" } } };
          mkdirSync(join(process.env.ALPHACOUNCIL_AGENT_DATA_DIR, "runs", run.run_id), { recursive: true });
          const trace = readFileSync(writeAllAgentsMarkdown(run), "utf8");
          if (!trace.includes("openai") || !trace.includes("example-model") || trace.includes("codex_default")) throw new Error(language + ": incorrect provider metadata");
          writeArtifactIndex(run);
          const manager = { decision_available: false, summary: readerText(language, "No usable debate packet was recorded.") };
          finalReportMarkdown({ ...run, grounding: { instrument: { asset_type: "etf", research_model: "fund_structure", fund_like: true } } }, manager);
          finalReportMarkdown({ ...run, tasks: ["news_industry_management"], terminal: "degraded", task_status: { news_industry_management: { status: "degraded" } } }, manager);
          userResponseMarkdown({ ...run, packets: [{ task: "news_industry_management", sources: [{ id: "S1", title: "Original title", published_at: "2020-01-01" }] }] }, manager);
        }
      `,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
