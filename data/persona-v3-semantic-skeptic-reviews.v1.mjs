/**
 * Independent round-2 machine skeptic judgments.
 *
 * These records assess only whether the archived excerpt supports the extractor's proposed
 * statement. They do not approve authorship, method attribution, or production admission.
 */

const DATE_LIMITED = Object.freeze({
  status: "limited",
  rationale: "The archive binds retrieval time and exact bytes, but no human-approved publication-date anchor is present in this lane.",
});
const AUTHOR_LIMITED = Object.freeze({
  status: "limited",
  rationale: "The archived publication context is consistent with the proposed author, but this machine pass does not establish legal or editorial authorship.",
});
const SCOPE_NONE = Object.freeze({
  status: "none_detected",
  rationale: "The proposed statement stays within the operative scope of the cited passage.",
});

function supported(propositionId, rationale, {
  authorship = AUTHOR_LIMITED,
  scope = SCOPE_NONE,
  date = DATE_LIMITED,
  challenges = ["Machine support classification is not a method-attribution approval."],
  openQuestions = ["Can a human reviewer confirm authorship, publication date, and method-level representativeness?"],
} = {}) {
  return Object.freeze({
    proposition_id: propositionId,
    verdict: "supported",
    support_rationale: rationale,
    authorship_ambiguity: authorship,
    scope_ambiguity: scope,
    date_ambiguity: date,
    challenges,
    open_questions: openQuestions,
  });
}

function partial(propositionId, rationale, challenges, {
  authorship = AUTHOR_LIMITED,
  scopeStatus = "material",
  scopeRationale = "The proposition adds a condition, generalization, or method prescription not fully stated by the exact excerpt.",
  date = DATE_LIMITED,
  openQuestions = ["What narrower wording would be fully entailed by the cited excerpt alone?"],
} = {}) {
  return Object.freeze({
    proposition_id: propositionId,
    verdict: "partial",
    support_rationale: rationale,
    authorship_ambiguity: authorship,
    scope_ambiguity: { status: scopeStatus, rationale: scopeRationale },
    date_ambiguity: date,
    challenges,
    open_questions: openQuestions,
  });
}

function candidate(personaId, candidateId, propositionReviews, {
  challenges = ["A machine semantic pass cannot establish method attribution or source grade."],
  openQuestions = ["Can independent human reviewers validate this source against the full method corpus?"],
} = {}) {
  return Object.freeze({
    persona_id: personaId,
    candidate_id: candidateId,
    proposition_reviews: propositionReviews,
    challenges,
    open_questions: openQuestions,
  });
}

function unverifiable(personaId, candidateId, reason) {
  return candidate(personaId, candidateId, [], {
    challenges: [reason, "No proposition may be reconstructed from model memory or adjacent sources."],
    openQuestions: ["Can the original transcript, audio, readable PDF, or unobstructed page be archived and reviewed?"],
  });
}

export const SEMANTIC_SOURCE_SKEPTIC_REVIEW_CATALOG = Object.freeze([
  candidate("master_ackman", "ackman_pershing_netflix_letter_2022", [
    partial(
      "ackman_pershing_netflix_letter_2022:p1",
      "The excerpt supports an attractive-valuation opportunity following a negative reaction to subscriber growth and guidance, but the strict only-when condition and durable-economics test come from surrounding rationale rather than the bound snippet.",
      ["The statement turns a described purchase into a general entry rule.", "The excerpt does not itself say that durable economics remained intact."],
    ),
  ]),
  candidate("master_aschenbrenner", "aschenbrenner_situational_awareness_2024", [
    partial(
      "aschenbrenner_situational_awareness_2024:p1",
      "The page describes rapidly escalating cluster plans and power-contract procurement, but calling those observations leading indicators is an analyst inference rather than an explicit method instruction.",
      ["A scenario observation is being converted into an investment-monitoring rule."],
    ),
  ]),
  candidate("master_asness", "asness_value_momentum_interaction", [
    supported("asness_value_momentum_interaction:p1", "The abstract expressly states both the negative cross-sectional correlation and each factor's positive relationship with average returns."),
  ]),
  candidate("master_buffett", "buffett_berkshire_letter_2024", [
    partial(
      "buffett_berkshire_letter_2024:p1",
      "The excerpt directly establishes very-long-term intent for five named holdings; nearby text praises their capital deployment and management, but the proposed general conditional holding rule is broader than this case-specific statement.",
      ["The evidence concerns five Japanese trading companies, not all investments.", "The word prefer and the ongoing acceptability condition are synthesized rather than quoted."],
      { scopeRationale: "A case-specific holding intention is generalized into a portfolio-wide rule." },
    ),
  ]),
  unverifiable("master_burry", "burry_fcic_interview_archive", "The archive is only an audio landing page and contains neither playable audio bytes nor a transcript."),
  candidate("master_cathie_wood", "cathie_wood_ark_disruptive_innovation_2017", [
    supported("cathie_wood_ark_disruptive_innovation_2017:p1", "The passage and immediate heading explicitly contrast beneficiaries of declining innovation cost curves with companies that may become value traps.", {
      authorship: { status: "limited", rationale: "The PDF is an ARK publication associated with Cathie Wood, but the excerpt itself does not carry a personal signature." },
    }),
  ]),
  candidate("master_dalio", "dalio_economic_principles_productivity_reform", [
    supported("dalio_economic_principles_productivity_reform:p1", "The passage explicitly contrasts cause-effect relationships used for investment purposes with opinions that lack demonstrated linkages."),
  ]),
  candidate("master_damodaran", "damodaran_nyu_dcf_inputs", [
    supported("damodaran_nyu_dcf_inputs:p1", "The slide states verbatim that discount rates must match both riskiness and cash-flow type, then gives equity, firm, currency, and nominal/real examples."),
  ]),
  candidate("master_damodaran", "damodaran_nyu_narrative_numbers", [
    supported("damodaran_nyu_narrative_numbers:p1", "The cited slide begins with a forward narrative and immediately enumerates company, market, competition, and macro assessments that constrain it."),
  ]),
  candidate("master_damodaran", "damodaran_nyu_valuation_dubai_2026", [
    supported("damodaran_nyu_valuation_dubai_2026:p1", "The same slide rejects science and art labels and defines craft as a skill improved by doing, directly supporting the proposed distinction."),
  ]),
  candidate("master_damodaran", "damodaran_nyu_valuation_packet1", [
    supported("damodaran_nyu_valuation_packet1:p1", "The slide directly makes intrinsic value a function of lifetime expected cash flows and uncertainty and describes consistent risk adjustment through cash flows or discount rates."),
  ]),
  candidate("master_druckenmiller", "druckenmiller_econclubny_transcript_2019", [
    supported("druckenmiller_econclubny_transcript_2019:p1", "The interview answer expressly describes liquidity as spotty, side-dependent, and capable of disappearing within weeks."),
  ]),
  unverifiable("master_duan_yongping", "duan_yongping_xueqiu_business_culture_2023", "The archived page is an opaque WAF/encrypted response rather than readable article text."),
  candidate("master_fisher", "fisher_wiley_authorized_chapter_1", [
    supported("fisher_wiley_authorized_chapter_1:p1", "The authorized excerpt explicitly says finding outstanding companies and staying through market fluctuations proved more profitable than cycle trading."),
  ]),
  candidate("master_forensic_short", "sec_gme_short_market_structure_2021", [
    partial(
      "sec_gme_short_market_structure_2021:p1",
      "The excerpt supports rejecting a short squeeze as the main driver in this event, but it does not itself state the proposed general test using participant-level covering volume and persistent price behavior.",
      ["A case conclusion is generalized into a reusable forensic procedure.", "The exact snippet contains neither covering-volume nor persistence criteria."],
      { authorship: { status: "none_detected", rationale: "The proposition is attached to a generic forensic-short lens and the source is an official SEC staff report, not a named-investor attribution." } },
    ),
  ]),
  candidate("master_graham", "graham_columbia_security_analysis_lecture_1", [
    supported("graham_columbia_security_analysis_lecture_1:p1", "The lecture directly rejects obvious industry-prospect selection and endorses demonstrated comparative value differentials from tested security-analysis techniques."),
  ]),
  candidate("master_jhunjhunwala", "jhunjhunwala_flame_investing_presentation", [
    partial(
      "jhunjhunwala_flame_investing_presentation:p1",
      "The cited page contains the full checklist, but the bound excerpt is only one checklist item and therefore cannot alone support the six-part proposition.",
      ["The snippet hash binds only Sustainable competitive advantage while the statement aggregates the whole slide."],
      { scopeStatus: "limited", scopeRationale: "The page supports the list, but the exact evidence snippet under-specifies the claimed list." },
    ),
    supported("jhunjhunwala_flame_investing_presentation:p2", "The slide states the independent-exit rule directly and expressly rejects profit or loss as the driver."),
  ]),
  unverifiable("master_klarman", "klarman_cfa_patient_investors_2010", "The archive exposes metadata and a short conference description but not the complete interview text."),
  candidate("master_li_lu", "li_lu_pku_speech_notes_2019", [
    partial(
      "li_lu_pku_speech_notes_2019:p1",
      "The archived notes state the investing-versus-speculation distinction, but they are a secondary summary rather than a verbatim speech transcript.",
      ["The wording may belong to the note author rather than Li Lu verbatim."],
      {
        authorship: { status: "material", rationale: "The page expressly identifies itself as notes from the speech, so exact wording and omissions cannot be attributed directly to Li Lu." },
        scopeStatus: "limited",
        scopeRationale: "The conceptual distinction is supported, but direct-persona attribution remains unresolved.",
        openQuestions: ["Is a primary recording or transcript available for this passage?"],
      },
    ),
    partial(
      "li_lu_pku_speech_notes_2019:p2",
      "The excerpt supports an early net-net purchase with margin of safety; competence-building and the ownership mindset appear in adjacent notes, so the combined prescription exceeds the bound snippet.",
      ["One historical example is combined with two separate principles.", "The source is secondary notes rather than a transcript."],
      {
        authorship: { status: "material", rationale: "The page is a note author's summary of Li Lu's speech, not a verbatim primary record." },
        openQuestions: ["Can each component be bound to a primary transcript and its own exact excerpt?"],
      },
    ),
  ]),
  candidate("master_lynch", "lynch_pbs_frontline_interview", [
    supported("lynch_pbs_frontline_interview:p1", "The interview directly limits the average investor to a few deeply known companies and says to buy when one becomes attractive rather than select unknown names on market timing."),
  ]),
  candidate("master_marks", "marks_oaktree_its_all_good_2007", [
    partial(
      "marks_oaktree_its_all_good_2007:p1",
      "The page supports the pendulum between psychology and over/underpricing, but the exact excerpt binds only the pricing endpoints and not the reliability or psychology components of the proposition.",
      ["The snippet is too short for the complete two-cause cyclical indicator claim."],
      { scopeStatus: "limited", scopeRationale: "The surrounding page supports more than the exact excerpt, so the proposition needs a broader bound snippet." },
    ),
  ]),
  unverifiable("master_munger", "munger_sec_wesco_annual_report_2009", "Poppler output is heavily corrupted OCR and does not reliably expose a method passage attributable to Munger."),
  candidate("master_natenberg", "natenberg_cboe_learning_greeks_2021", [
    partial(
      "natenberg_cboe_learning_greeks_2021:p1",
      "The excerpt directly defines Delta, while the article page discusses multiple Greeks; the bound snippet does not define Vega or independently support the full multi-Greek prescription.",
      ["Vega and the multiple-Greeks conclusion are outside the exact excerpt."],
      {
        authorship: { status: "material", rationale: "The Cboe educational page is associated with Natenberg in the candidate catalog, but the bound passage does not establish that he authored the text." },
        scopeStatus: "limited",
        scopeRationale: "The broader article supports the topic, but the exact evidence unit only supports Delta sensitivity.",
      },
    ),
  ]),
  candidate("master_pabrai", "pabrai_columbia_session_2024", [
    supported("pabrai_columbia_session_2024:p1", "The transcript directly describes rapid rejection, names entire sectors outside competence, and says to discard them rather than force analysis."),
  ]),
  unverifiable("master_simons", "simons_foundation_career_interview_2012", "The archive is a video landing page with chapter labels but no transcript of the interview."),
  candidate("master_sinclair", "sinclair_cboe_risk_reversal_2026", [
    supported("sinclair_cboe_risk_reversal_2026:p1", "The passage and immediate continuation explicitly link put/call relative mispricing, a volatility view, sensible valuation, and positive expected value."),
    supported("sinclair_cboe_risk_reversal_2026:p2", "The article states directly that exposure is scaled back when skew flattens or reverses."),
  ]),
  candidate("master_soros", "soros_reflexivity_uncertainty_2014", [
    supported("soros_reflexivity_uncertainty_2014:p1", "The essay explicitly describes continuous circular influence between participant views and events in both directions."),
  ]),
  candidate("master_taleb", "taleb_fat_tails_statistical_project", [
    partial(
      "taleb_fat_tails_statistical_project:p1",
      "The project page says conventional statistics fail to cover fat tails and seeks alternatives, but the proposed mandatory pre-test workflow is a prudent inference rather than an express instruction in the exact snippet.",
      ["A descriptive research-program statement is converted into a universal operational veto."],
    ),
  ]),
  candidate("master_taleb", "taleb_law_large_numbers_fat_tails", [
    supported("taleb_law_large_numbers_fat_tails:p1", "The paper defines sample equivalence exactly as the fat-tail sample size corresponding to a Gaussian sample size and explains why nominal n can be misleading."),
  ]),
  candidate("master_taleb", "taleb_precautionary_principle_ruin", [
    partial(
      "taleb_precautionary_principle_ruin:p1",
      "The same abstract rejects traditional cost-benefit analysis for infinite-cost ruin, but the bound excerpt alone is only the phrase that outcomes may have infinite costs.",
      ["The snippet is too narrow to support the full precautionary decision rule without its surrounding sentences."],
      { scopeStatus: "limited", scopeRationale: "The page context supports the rule, but the exact evidence snippet does not." },
    ),
  ]),
  candidate("master_taleb", "taleb_statistical_consequences_arxiv", [
    supported("taleb_statistical_consequences_arxiv:p1", "The manuscript directly calls the observed sample mean biased under fat tails and recommends distribution-based plug-in or shadow-mean treatment."),
  ]),
  unverifiable("master_thorp", "thorp_kelly_stock_market", "The archived PDF yields zero extracted characters with the available independent Poppler pass."),
]);
