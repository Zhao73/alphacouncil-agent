import {
  DEBATE_ROLES,
  HANDOFF_METHOD_SEAT_MARKER_PREFIX,
  HANDOFF_METHOD_TAIL_END_MARKER,
  HANDOFF_METHOD_TAIL_MARKER,
  LIMITS,
  PLACEHOLDER_BODIES,
  QUICK_REPORT_SECTIONS,
  RECORDED_BENCH_MARKER_PREFIX,
  REPORT_SECTIONS,
} from "./constants.mjs";
import { isFundOrIndex } from "./instruments.mjs";
import { denseLength, headingIncludesAlias, normalizeHeading, parseHeadings } from "./headings.mjs";
import { isChineseLanguage, languageKey, localized, readerLanguageStatus } from "./lang.mjs";
import { companyDossierCoverageStatus } from "./company-dossier.mjs";
import { verificationAuditStatus } from "./verification.mjs";

export function withDisclaimer(markdown, language) {
  const text = typeof markdown === "string" ? markdown : "";
  if (/##\s*(Disclaimer|免责声明|免責事項|면책)/iu.test(text)) return text;
  const note = {
    zh: "\n\n---\n\n## 免责声明\n\n本报告由 AI 自动生成，**仅供教育与研究**，**不构成投资建议**，也不构成任何证券买卖推荐或要约。AI 分析可能不完整、过时或错误。投资决策前请自行核实并咨询持牌专业人士。作者不对任何损失承担责任。",
    en: "\n\n---\n\n## Disclaimer\n\nThis report is AI-generated for **educational and research purposes only**. It is **not investment advice**, not a recommendation to buy or sell any security, and not a solicitation. AI analysis can be incomplete, outdated, or wrong. Do your own research and consult a licensed professional before any investment decision. The authors accept no liability for any loss.",
    ja: "\n\n---\n\n## 免責事項\n\n本レポートは AI が生成した**教育・調査目的のみ**の資料で、**投資助言ではありません**。証券の売買推奨や勧誘でもありません。AI の分析は不完全、古い、または誤っている可能性があります。投資判断の前にご自身で確認し、資格を有する専門家へ相談してください。作成者は損失について責任を負いません。",
    ko: "\n\n---\n\n## 면책 조항\n\n이 보고서는 AI가 생성한 **교육 및 연구 목적의 자료**이며 **투자 조언이 아닙니다**. 증권 매매 권유나 청약도 아닙니다. AI 분석은 불완전하거나 오래되었거나 틀릴 수 있습니다. 투자 결정 전에 직접 확인하고 자격을 갖춘 전문가와 상의하십시오. 작성자는 손실에 대해 책임을 지지 않습니다.",
  }[languageKey(language)];
  return `${text}${note}`;
}

export function withVerificationBanner(markdown, gate, language) {
  const text = typeof markdown === "string" ? markdown : "";
  if (!gate) return text;
  const pairs = gate.missing_claim_source_ids || [];
  const verifier = gate.verifier_audit || {};
  if (gate.verification !== "needs_verification" && verifier.status === "completed_with_findings") {
    const findings = (verifier.non_clean || []).slice(0, 24)
      .map((item) => `- ${item.verifier}: ${item.claim_id} -> ${item.verdict}`)
      .join("\n");
    const more = Math.max(0, (verifier.non_clean || []).length - 24);
    const banner = localized(language, {
      zh: `\n\n---\n\n## 三重核验发现\n\n**状态：completed_with_findings。** 三类 verifier 已逐条覆盖全部重大论断；以下结果会降低对应证据席权重，但不会被误写成验证器缺失：\n\n${findings}${more ? `\n- 另有 ${more} 条，见验证工件。` : ""}\n`,
      en: `\n\n---\n\n## Triple-Verification Findings\n\n**Status: completed_with_findings.** All three verifiers covered every material claim. These findings reduce the originating evidence seat's weight; they are not mislabeled as missing verification:\n\n${findings}${more ? `\n- ${more} more; see the verification artifacts.` : ""}\n`,
      ja: `\n\n---\n\n## 三重検証の所見\n\n**状態：completed_with_findings。** 3つの verifier は全重要主張を網羅しました。以下の所見は該当する証拠席の重みを下げますが、検証未実施とは扱いません：\n\n${findings}${more ? `\n- ほか ${more} 件は検証成果物を参照。` : ""}\n`,
      ko: `\n\n---\n\n## 삼중 검증 결과\n\n**상태: completed_with_findings.** 세 verifier가 모든 중요 주장을 다뤘습니다. 다음 결과는 해당 증거 좌석의 가중치를 낮추지만 검증 누락으로 표시하지 않습니다:\n\n${findings}${more ? `\n- 추가 ${more}건은 검증 산출물을 참조하십시오.` : ""}\n`,
    });
    return `${text}${banner}`;
  }
  if (gate.verification !== "needs_verification") return text;
  const issues = [
    ...pairs.map((item) => `${item.task}: missing source ID ${item.source_id}`),
    ...(verifier.required && verifier.verifier_zero ? ["required verifier verdict count is 0"] : []),
    ...(verifier.material_claim_count === 0 && verifier.required ? ["no material claim set was available to verify"] : []),
    ...(verifier.required && verifier.analyst_roster_complete === false ? ["all-analyst scope did not materialize the complete 11-seat roster"] : []),
    ...(verifier.missing || []).slice(0, 24).map((item) => `${item.verifier}: missing ${item.claim_id}`),
    ...(verifier.duplicates || []).slice(0, 12).map((item) => `${item.verifier}: duplicate ${item.claim_id}`),
    ...(verifier.unexpected || []).slice(0, 12).map((item) => `${item.verifier}: unexpected ${item.claim_id}`),
  ];
  const lines = issues.length ? issues.map((item) => `- ${item}`).join("\n") : "- (unspecified)";
  const banner = {
    zh: `\n\n---\n\n## 来源与三重核验\n\n**状态：needs_verification。** 来源追溯或 slow + 全部方法席 + 全部分析席所要求的 source_fidelity / rederivation / refuter 三重核验尚未全部通过；不得写成 complete：\n\n${lines}\n`,
    en: `\n\n---\n\n## Source Verification Gate and Triple Verification\n\n**Status: needs_verification.** Source lineage or the source_fidelity / rederivation / refuter gate required by slow + all methods + all analysts has not fully passed; this run may not be marked complete:\n\n${lines}\n`,
    ja: `\n\n---\n\n## 出典・三重検証ゲート\n\n**状態：needs_verification。** 出典追跡、または slow + 全メソッド席 + 全分析席に必須の三重検証が完了していないため complete にはできません：\n\n${lines}\n`,
    ko: `\n\n---\n\n## 출처 및 삼중 검증 게이트\n\n**상태: needs_verification.** 출처 계보 또는 slow + 전체 방법론 + 전체 분석가에 필수인 삼중 검증을 모두 통과하지 못해 complete로 표시할 수 없습니다:\n\n${lines}\n`,
  }[languageKey(language)];
  return `${text}${banner}`;
}

export function scopedSourceId(task, id, index = 0) {
  const raw = String(id || `S${index + 1}`).trim() || `S${index + 1}`;
  return raw.includes(":") ? raw : `${task}:${raw}`;
}

const METHOD_ONLY_SOURCE_KINDS = new Set([
  "derived_proxy",
  "editorial_choice",
  "method_definition",
  "method_provenance",
  "method_rule",
  "method_source",
  "methodology_definition",
  "persona_method",
  "persona_method_definition",
]);

function hasMethodOnlySourceMarker(source) {
  const id = String(source?.id || source?.source_id || "").trim();
  if (/^proxy:/iu.test(id)) return true;
  const sourceKind = String(source?.source_kind || "").trim().toLowerCase();
  return METHOD_ONLY_SOURCE_KINDS.has(sourceKind)
    || /^(?:method|methodology|persona_method)(?:_|$)/u.test(sourceKind);
}

export function sourceManifest(run) {
  const sources = [];
  const known = new Set();
  const evidenceEntries = [
    ...(run.grounding?.typed_fact_sources || []).map((source) => ({ task: "grounding", source })),
    ...(run.packets || []).flatMap((packet) => (
      (packet.sources || []).map((source) => ({ task: packet.task, source }))
    )),
  ];
  const methodEntries = Object.entries(run.master_runtime_provenance || {}).flatMap(([master, provenance]) => (
    (provenance?.method_sources || []).map((source) => ({ master, source }))
  ));
  // Reserve the whole ID, not only one occurrence. Otherwise a packet could place a
  // benign-looking duplicate before the same ID's method-labelled record and win by order.
  const methodOnlyIds = new Set(methodEntries
    .map(({ source }) => String(source?.id || source?.source_id || "").trim())
    .filter(Boolean));
  for (const { source } of evidenceEntries) {
    if (!hasMethodOnlySourceMarker(source)) continue;
    const id = String(source?.id || source?.source_id || "").trim();
    if (id) methodOnlyIds.add(id);
  }
  const appendSource = (task, source, provenanceDomain = "evidence") => {
    const id = source?.id || source?.source_id;
    if (!id || known.has(id)) return;
    // Ingress does not define provenance. A packet or typed-fact envelope must not turn a
    // reserved method proxy into investment evidence merely by placing it in an evidence list.
    // The same source remains auditable when it arrives through the explicit method domain.
    if (provenanceDomain === "evidence" && methodOnlyIds.has(String(id).trim())) return;
    known.add(id);
    sources.push({ task, id, ...source, provenance_domain: provenanceDomain });
  };
  for (const { task, source } of evidenceEntries) {
    appendSource(task, source);
  }
  // PersonaPack sources explain where a provisional method rule or derived proxy came from.
  // They belong in the audit manifest, but in a separate domain: a method-definition source
  // is not evidence about the company and may never satisfy an investment-claim source gate.
  for (const { master, source } of methodEntries) {
    appendSource(`method_provenance:${master}`, {
      ...source,
      method_id: master,
    }, "method_provenance");
  }
  const knownEvidence = new Set(sources
    .filter((source) => source.provenance_domain === "evidence")
    .map((source) => source.id));
  const missing_claim_source_ids = [];
  for (const packet of run.packets || []) {
    for (const claim of packet.claims || []) {
      for (const id of claim.source_ids || []) {
        if (!knownEvidence.has(id)) missing_claim_source_ids.push({ task: packet.task, source_id: id });
      }
    }
  }
  const evidenceSourceCount = sources.filter((source) => source.provenance_domain === "evidence").length;
  return {
    run_id: run.run_id,
    symbol: run.symbol,
    as_of: run.as_of,
    source_count: sources.length,
    evidence_source_count: evidenceSourceCount,
    method_provenance_source_count: sources.length - evidenceSourceCount,
    sources,
    missing_claim_source_ids,
  };
}

export function verificationStatus(run) {
  const missing = sourceManifest(run).missing_claim_source_ids;
  const verifierAudit = verificationAuditStatus(run);
  const verifierFailed = verifierAudit.required && verifierAudit.status === "needs_verification";
  return {
    verification: missing.length || verifierFailed ? "needs_verification" : "passed",
    verification_scope: verifierAudit.required
      ? "source_id_presence_plus_triple_material_claim_v1"
      : "source_id_presence_only",
    adversarial_verification: verifierAudit.required
      ? verifierAudit.status
      : ((run.verifier_verdicts || []).length ? "recorded_not_required" : "not_required"),
    missing_claim_source_ids: missing,
    verifier_audit: verifierAudit,
  };
}

export function taskState(run, task) {
  return run.task_status?.[task] || { task, status: "pending" };
}

export function agentState(run, role) {
  return run.agent_status?.[role] || { role, status: "pending" };
}

/**
 * One definition of "this seat still owes the run something", used by every caller.
 *
 * The status snapshot and the completeness gate used to read a missing `master_status` entry
 * as "fine" while the debate and PM gates read the same absence as "missing". A run recovered
 * through the idempotent plan path could therefore report `complete` with no pending seats
 * and still be hard-rejected at `record_visible_decision` naming exactly those seats -- an
 * unrecoverable state behind a status display that said nothing was wrong.
 *
 * The shared reading resolves it toward unblocking: a seat that is genuinely waiting always
 * has a `waiting` entry, because every write path that records an opinion also writes the
 * status. A missing entry therefore only occurs on a run persisted before that invariant
 * existed, and treating that as a hard block would strand the run with no way forward.
 */
export function masterSeatIncomplete(run, id) {
  const recorded = (run?.master_opinions || []).some((opinion) => opinion?.master === id);
  if (!recorded) return true;
  const state = run?.master_status?.[id];
  return Boolean(state) && state.status !== "completed";
}

export function completenessStatus(run) {
  const tasks = Array.isArray(run.tasks) ? run.tasks : [];
  const quick = run.council_mode === "quick";
  const successfulEvidence = tasks.filter((task) => taskState(run, task).status === "completed");
  const degraded_evidence = tasks.filter((task) => taskState(run, task).status === "degraded");
  const quickMinimumMet = quick && successfulEvidence.length >= LIMITS.QUICK_MIN_SUCCESSFUL_TASKS;
  const missing_evidence = tasks.filter((task) => {
    const status = taskState(run, task).status;
    return status !== "completed" && !(quickMinimumMet && status === "degraded");
  });
  // All three debate roles, including portfolio_manager. SKILL.md and the
  // record_visible_decision tool description have always promised the PM is enforced;
  // the gate only ever checked the two researchers, so a run that skipped the PM
  // entirely could still report itself complete.
  const degraded_debate = DEBATE_ROLES.filter((role) => agentState(run, role).status === "degraded");
  const successfulDebateSides = ["bull_researcher", "bear_researcher"]
    .filter((role) => agentState(run, role).status === "completed").length;
  const missing_debate = DEBATE_ROLES.filter((role) => {
    const status = agentState(run, role).status;
    if (status === "completed") return false;
    // A quick read may survive one failed side if the other side and the PM completed and
    // the failed packet is explicitly represented. Both sides failing is not a debate.
    return !(quick && role !== "portfolio_manager" && status === "degraded" && successfulDebateSides >= 1);
  });
  // A run that selected a master bench and recorded no opinions used to report itself
  // complete. That let the most expensive stage be skipped silently while the report still
  // read as a finished committee -- and a bench nobody consulted is worse than no bench,
  // because the reader believes the verdict survived twenty-one lenses.
  const selected = Array.isArray(run.masters) ? run.masters : [];
  const missing_masters = selected.filter((id) => masterSeatIncomplete(run, id));
  const company_dossier = companyDossierCoverageStatus(run);
  const dossierIncomplete = company_dossier.required && !company_dossier.decision_barrier_ready;
  const complete = missing_evidence.length === 0 && missing_debate.length === 0
    && missing_masters.length === 0 && !dossierIncomplete;
  return {
    completeness: complete ? "complete" : "incomplete",
    missing_evidence,
    missing_debate,
    missing_masters,
    degraded_evidence,
    degraded_debate,
    // Missing/failed mandatory evidence is not complete coverage. Quick keeps its explicit
    // degraded axis only when the minimum-coverage rule converted every affected seat into
    // an allowed degraded record; otherwise the missing gate wins and coverage is incomplete.
    evidence_coverage: missing_evidence.length ? "incomplete" : degraded_evidence.length ? "degraded" : "complete",
    quick_minimum_successful_tasks: quick ? LIMITS.QUICK_MIN_SUCCESSFUL_TASKS : null,
    successful_evidence_count: successfulEvidence.length,
    missing_evidence_count: missing_evidence.length,
    missing_debate_count: missing_debate.length,
    missing_masters_count: missing_masters.length,
    company_dossier,
    company_dossier_incomplete: dossierIncomplete,
  };
}

export function withCompletenessBanner(markdown, completeness, language) {
  const text = typeof markdown === "string" ? markdown : "";
  if (!completeness || completeness.completeness !== "incomplete") return text;
  const ev = completeness.missing_evidence || [];
  const db = completeness.missing_debate || [];
  const ms = completeness.missing_masters || [];
  const evLine = ev.length ? ev.map((task) => `- ${task}`).join("\n") : "- (none)";
  const dbLine = db.length ? db.map((role) => `- ${role}`).join("\n") : "- (none)";
  // Naming the skipped seats matters more than the flag: "incomplete" without a list
  // invites the reader to assume it was something minor.
  const msLine = ms.length ? ms.map((id) => `- ${id}`).join("\n") : "";
  const banner = {
    zh: `> [!WARNING]\n## 委员会流程未完成\n\n**状态：incomplete。** 本轮没有完成全部委员会流程，结论不可靠。\n\n未完成的证据席：\n${evLine}\n\n未完成的辩论席：\n${dbLine}\n${msLine ? `\n未给出意见的方法席：\n${msLine}\n` : ""}`,
    en: `> [!WARNING]\n## Incomplete Council Run\n\n**Status: incomplete.** This run did NOT execute the full council workflow; the conclusion is unreliable.\n\nMissing evidence roles:\n${evLine}\n\nMissing debate roles:\n${dbLine}\n${msLine ? `\nMethod seats that gave no opinion:\n${msLine}\n` : ""}`,
    ja: `> [!WARNING]\n## 委員会プロセス未完了\n\n**状態：incomplete。** 委員会の全工程を完了していないため、結論は信頼できません。\n\n未完了の証拠席：\n${evLine}\n\n未完了の討論席：\n${dbLine}\n${msLine ? `\n意見を記録できなかったメソッド席：\n${msLine}\n` : ""}`,
    ko: `> [!WARNING]\n## 위원회 실행 미완료\n\n**상태: incomplete.** 전체 위원회 절차가 완료되지 않아 결론을 신뢰할 수 없습니다.\n\n미완료 증거 좌석:\n${evLine}\n\n미완료 토론 좌석:\n${dbLine}\n${msLine ? `\n의견을 기록하지 못한 방법론 좌석:\n${msLine}\n` : ""}`,
  }[languageKey(language)];
  return `${banner}\n\n---\n\n${text}`;
}

/**
 * Assign each heading to at most one required section, longest matching alias first.
 *
 * Without the longest-alias rule, "Quant Factor / Technical Risk View" would satisfy the
 * risks section as well as the quant section, and a report could pass while genuinely
 * having no risks section at all.
 */
function assignHeadings(headings) {
  const assigned = new Map();
  for (const heading of headings) {
    const normalized = normalizeHeading(heading.title);
    if (!normalized) continue;
    let best = null;
    for (const section of REPORT_SECTIONS) {
      for (const alias of section.aliases) {
        const needle = normalizeHeading(alias);
        if (!needle || !headingIncludesAlias(heading.title, alias)) continue;
        if (!best || needle.length > best.needleLength) {
          best = { section, needleLength: needle.length };
        }
      }
    }
    if (!best) continue;
    const existing = assigned.get(best.section.id);
    // Keep the richest body when a report repeats a section.
    if (!existing || denseLength(heading.body) > denseLength(existing.body)) {
      assigned.set(best.section.id, heading);
    }
  }
  return assigned;
}

const isPlaceholder = (body) => {
  const compact = String(body || "").replace(/^[-*+]\s*/, "").trim().toLowerCase();
  return PLACEHOLDER_BODIES.includes(compact);
};

const LANGUAGE_CORE_SECTIONS = new Set([
  "conclusion", "analyst_work_log", "debate_record", "master_bench", "market_expectations",
  "earnings_call", "news", "valuation", "price_levels", "risks", "position", "data_gaps",
  "invalidation",
]);

function readerLanguageAudit(assigned, language) {
  const requested = languageKey(language);
  const mismatched = [];
  let targetCharacters = 0;
  let observedCharacters = 0;
  const bodies = [];
  for (const id of LANGUAGE_CORE_SECTIONS) {
    const heading = assigned.get(id);
    const body = heading?.body || "";
    if (!body.trim()) continue;
    bodies.push(body);
    const section = readerLanguageStatus(body, language, { minimumTargetCharacters: 2, minimumRatio: 0.05 });
    targetCharacters += section.target_characters;
    observedCharacters += section.reader_characters;
    // Pure Han fragments are inconclusive across Chinese/Japanese. Let the whole
    // report establish the locale, but reject sections with positive other-language
    // evidence so one translated heading cannot hide a foreign-language body.
    if (![requested, "shared_han", "undetermined"].includes(section.observed_locale)) mismatched.push(id);

    const titleProbe = readerLanguageStatus(heading?.title || "", language, { minimumTargetCharacters: 1, minimumRatio: 0 });
    const { scripts = {} } = titleProbe;
    let titleLocale = "undetermined";
    if ((scripts.hangul || 0) > 0) titleLocale = "ko";
    else if ((scripts.kana || 0) > 0 || (titleProbe.japanese_markers || 0) > 0) titleLocale = "ja";
    else if ((titleProbe.chinese_markers || 0) > 0) titleLocale = "zh";
    else if ((scripts.latin || 0) > 0 && (scripts.han || 0) === 0) titleLocale = "en";
    else if ((scripts.han || 0) > 0) titleLocale = "shared_han";
    const sharedHanAllowed = titleLocale === "shared_han" && ["zh", "ja"].includes(requested);
    if (![requested, "undetermined"].includes(titleLocale) && !sharedHanAllowed) mismatched.push(`heading:${id}`);
  }
  const whole = readerLanguageStatus(bodies.join("\n"), language, { minimumTargetCharacters: 12, minimumRatio: 0.08 });
  const languageStatus = mismatched.length || whole.status !== "passed" ? "failed" : "passed";
  return {
    requested_locale: requested,
    observed_locale: whole.observed_locale,
    language_status: languageStatus,
    target_script_characters: whole.target_characters || targetCharacters,
    reader_characters_checked: observedCharacters,
    mismatched_sections: mismatched,
  };
}

/**
 * Which contract sections an author still owes, checked against a submitted report body.
 *
 * `validateFinalReport` runs against the assembled report, after the system has appended the
 * price snapshot, the master bench and any instrument-structure block, so it can only answer
 * once the report already exists. A PM that submits no report body at all cannot be told so
 * until then: on a real run the first submission carried no `report_markdown`, the report was
 * assembled from the summary fallback, and the gate came back with 21 missing sections after
 * the whole PM turn had been spent. This answers the same question at submission time, and
 * deliberately ignores the sections the system owns.
 */
const SYSTEM_OWNED_REPORT_SECTIONS = new Set(["master_bench", "instrument_structure"]);

export function authoredReportSectionGaps(markdown, run) {
  const gaps = validateFinalReport(markdown, run).missing
    .filter((entry) => /^(missing|placeholder) section: |^section too thin: /.test(entry));
  return gaps.filter((entry) => ![...SYSTEM_OWNED_REPORT_SECTIONS]
    .some((id) => entry.includes(`section: ${id}`) || entry.includes(`section: ${id} (`)));
}

/** The heading a report must carry for each contract section, in the run's language. */
export function requiredReportSectionAliases(run) {
  const quick = run?.council_mode === "quick";
  const sections = quick ? QUICK_REPORT_SECTIONS : REPORT_SECTIONS;
  const benchRan = ((run?.masters || []).length > 0) || ((run?.master_opinions || []).length > 0);
  const fundOrIndex = isFundOrIndex(run?.grounding?.instrument);
  const key = languageKey(run?.language);
  const index = { zh: 0, en: 1, ja: 2, ko: 3 }[key] ?? 1;
  return sections
    .filter((section) => !SYSTEM_OWNED_REPORT_SECTIONS.has(section.id))
    .filter((section) => !section.when_masters || benchRan)
    .filter((section) => !section.when_fund_or_index || fundOrIndex)
    .map((section) => ({
      id: section.id,
      minimum_body_characters: section.min_body,
      // The catalog lists zh, en, ja and ko variants; offer the one the run reads in, and fall
      // back to the English alias so the message is never empty.
      suggested_heading: section.aliases[index] || section.aliases[1] || section.aliases[0],
      accepted_headings: section.aliases,
    }));
}

export function validateFinalReport(markdown, run) {
  const text = String(markdown || "");
  const headings = parseHeadings(text);
  const assigned = assignHeadings(headings);
  const missing = [];
  const sections = [];
  const quick = run?.council_mode === "quick";
  const contractSections = quick ? QUICK_REPORT_SECTIONS : REPORT_SECTIONS;

  const benchRan = ((run?.masters || []).length > 0) || ((run?.master_opinions || []).length > 0);
  const fundOrIndex = isFundOrIndex(run?.grounding?.instrument);
  for (const section of contractSections) {
    if (section.when_masters && !benchRan) continue;
    if (section.when_fund_or_index && !fundOrIndex) continue;
    const heading = assigned.get(section.id);
    if (!heading) {
      missing.push(`missing section: ${section.id}`);
      sections.push({ id: section.id, status: "missing" });
      continue;
    }
    const bodyChars = denseLength(heading.body);
    if (isPlaceholder(heading.body)) {
      missing.push(`placeholder section: ${section.id} ("${heading.title}")`);
      sections.push({ id: section.id, status: "placeholder", heading: heading.title, line: heading.line, body_chars: bodyChars });
      continue;
    }
    if (bodyChars < section.min_body) {
      missing.push(`section too thin: ${section.id} ("${heading.title}") has ${bodyChars} of ${section.min_body} required characters`);
      sections.push({ id: section.id, status: "too_thin", heading: heading.title, line: heading.line, body_chars: bodyChars });
      continue;
    }
    sections.push({ id: section.id, status: "ok", heading: heading.title, line: heading.line, body_chars: bodyChars });
  }

  // Scoped to the analyst work log body. The old check searched the whole document, so
  // a task id appearing once in the source table satisfied "this analyst was reported".
  const workLog = assigned.get("analyst_work_log");
  const workLogBody = (workLog?.body || "").toLowerCase();
  for (const task of run.tasks || []) {
    if (!workLogBody.includes(String(task).toLowerCase())) {
      missing.push(`missing analyst work log entry: ${task}`);
    }
  }

  // A bench heading is not evidence that every selected method is readable. The previous
  // gate passed a report containing only a generic bench paragraph even when twenty-five
  // selected seats had no statement at all. Require both the frozen record and its exact
  // stable ID in the system-owned publication section.
  const selectedMethodSeats = [...new Set(
    (run?.masters?.length ? run.masters : (run?.master_opinions || []).map((opinion) => opinion.master))
      .filter((id) => typeof id === "string" && id.length),
  )];
  const opinionsByMaster = new Map((run?.master_opinions || []).map((opinion) => [opinion.master, opinion]));
  // Anchor, not heading assignment. A relabelled PM commentary section can legally contain a
  // localized bench alias, and it would then win the "richest body" assignment and fail every
  // seat here against PM prose. The marker only ever appears in the system-generated bench,
  // which assembly appends last, so everything from it onwards is system-owned output.
  const benchMarkerAt = text.indexOf(`<!-- ${RECORDED_BENCH_MARKER_PREFIX}`);
  const methodTailAt = benchMarkerAt >= 0
    ? text.indexOf(`<!-- ${HANDOFF_METHOD_TAIL_MARKER} -->`, benchMarkerAt)
    : -1;
  const benchBody = benchMarkerAt >= 0
    ? text.slice(benchMarkerAt, methodTailAt > benchMarkerAt ? methodTailAt : undefined)
    : (assigned.get("master_bench")?.body || "");
  const readableMethodStatements = [];
  const renderedMethodStatements = [];
  for (const id of selectedMethodSeats) {
    const opinion = opinionsByMaster.get(id);
    if (!opinion) {
      missing.push(`missing recorded method-seat opinion: ${id}`);
    } else if (denseLength(opinion.voice_statement) < 20) {
      missing.push(`missing readable method-seat statement: ${id}`);
    } else {
      readableMethodStatements.push(id);
    }
    if (!benchBody.includes(id)) missing.push(`method-seat statement not rendered in Master Bench: ${id}`);
    else renderedMethodStatements.push(id);
  }

  const sourceCount = (run.packets || []).reduce((sum, packet) => sum + (packet.sources?.length || 0), 0);
  if (sourceCount > 0 && !/[a-z_]+:s\d+/i.test(text)) missing.push("missing scoped source IDs such as market_data:S1");
  const minLength = run.dry_run
    ? LIMITS.REPORT_MIN_CHARS_DRY
    : quick ? LIMITS.REPORT_MIN_CHARS_QUICK : LIMITS.REPORT_MIN_CHARS;
  if (denseLength(text) < minLength) missing.push(`report too short: minimum ${minLength} non-space characters`);
  const execution = completenessStatus(run || {});
  const languageAudit = readerLanguageAudit(assigned, run?.language);
  if (languageAudit.language_status !== "passed") {
    missing.push(`report reader language mismatch: requested=${languageAudit.requested_locale}; sections=${languageAudit.mismatched_sections.join(",") || "insufficient target-language text"}`);
  }
  if (quick) {
    const markerCount = (text.match(/alphacouncil:quick-scope:v1:begin/gu) || []).length;
    if (markerCount !== 1) missing.push("missing system-owned quick_v1 scope marker");
    const markerStart = text.indexOf("<!-- alphacouncil:quick-scope:v1:begin -->");
    const markerEnd = text.indexOf("<!-- alphacouncil:quick-scope:v1:end -->", markerStart + 1);
    const scope = markerStart >= 0 && markerEnd > markerStart ? text.slice(markerStart, markerEnd) : "";
    if (!/full_council_equivalent=false/u.test(scope)) {
      missing.push("quick_v1 scope marker missing full_council_equivalent=false");
    }
  }
  if (quick && (execution.degraded_evidence.length || execution.degraded_debate.length)) {
    const markerCount = (text.match(/alphacouncil:degraded-ledger:v1:begin/gu) || []).length;
    if (markerCount !== 1) missing.push("missing system-owned degraded execution ledger");
    const markerStart = text.indexOf("<!-- alphacouncil:degraded-ledger:v1:begin -->");
    const markerEnd = text.indexOf("<!-- alphacouncil:degraded-ledger:v1:end -->", markerStart + 1);
    const ledger = markerStart >= 0 && markerEnd > markerStart ? text.slice(markerStart, markerEnd) : "";
    for (const id of [...execution.degraded_evidence, ...execution.degraded_debate]) {
      if (!ledger.includes(id)) missing.push(`degraded ledger missing seat: ${id}`);
    }
  }

  return {
    schema_version: 2,
    contract_id: quick ? "quick_v1" : "full_v2",
    scope: quick ? "quick" : "full",
    full_council_equivalent: !quick,
    debate_rounds_expected: quick ? 1 : 3,
    adversarial_verification: quick ? "not_run" : "separate_runtime_status",
    required_tasks: [...(run?.tasks || [])],
    evidence_coverage: execution.evidence_coverage,
    degraded_evidence: execution.degraded_evidence,
    degraded_debate: execution.degraded_debate,
    requested_locale: languageAudit.requested_locale,
    observed_locale: languageAudit.observed_locale,
    language_status: languageAudit.language_status,
    language_mismatched_sections: languageAudit.mismatched_sections,
    target_script_characters: languageAudit.target_script_characters,
    reader_characters_checked: languageAudit.reader_characters_checked,
    method_statement_coverage: {
      selected_count: selectedMethodSeats.length,
      readable_count: readableMethodStatements.length,
      rendered_count: renderedMethodStatements.length,
      readable_master_ids: readableMethodStatements,
      rendered_master_ids: renderedMethodStatements,
      status: readableMethodStatements.length === selectedMethodSeats.length
        && renderedMethodStatements.length === selectedMethodSeats.length
        ? "passed"
        : "failed",
    },
    status: missing.length ? "needs_revision" : "passed",
    missing,
    sections,
    checked_at: new Date().toISOString(),
    required_sections: contractSections
      .filter((section) => (!section.when_masters || benchRan)
        && (!section.when_fund_or_index || fundOrIndex))
      .map((section) => section.id),
  };
}

/**
 * Validate the system-owned final method-seat ledger in the chat handoff.
 *
 * Report quality and handoff quality are different publication surfaces. A complete Master
 * Bench in final_report.md does not prove that the host-facing summary retained it, and that
 * was the exact gap that let a shorter recap hide every method statement. The handoff tail is
 * therefore anchored, ordered by the frozen selection, and required to account for every seat.
 * A failed seat may be represented only by an explicit `not_produced` diagnostic; that makes
 * the failure visible without manufacturing a stance or allowing the completeness gate to pass.
 */
export function validateUserResponse(markdown, run) {
  const text = String(markdown || "");
  const begin = `<!-- ${HANDOFF_METHOD_TAIL_MARKER} -->`;
  const end = `<!-- ${HANDOFF_METHOD_TAIL_END_MARKER} -->`;
  const selected = [...new Set((run?.masters || []).filter((id) => typeof id === "string" && id.length))];
  const opinions = new Map((run?.master_opinions || []).map((opinion) => [opinion?.master, opinion]));
  const missing = [];
  const beginCount = text.split(begin).length - 1;
  const endCount = text.split(end).length - 1;
  if (beginCount !== 1) missing.push(`handoff method-seat tail begin marker count is ${beginCount}, expected 1`);
  if (endCount !== 1) missing.push(`handoff method-seat tail end marker count is ${endCount}, expected 1`);
  if (!text.trimEnd().endsWith(end)) missing.push("handoff method-seat ledger is not the final section");

  const beginAt = text.indexOf(begin);
  const endAt = text.lastIndexOf(end);
  const tail = beginAt >= 0 && endAt > beginAt ? text.slice(beginAt, endAt + end.length) : "";
  let priorSeatAt = -1;
  const rendered = [];
  const fullStatements = [];
  const explicitFailures = [];
  for (const id of selected) {
    const marker = `<!-- ${HANDOFF_METHOD_SEAT_MARKER_PREFIX}${id} -->`;
    const count = tail.split(marker).length - 1;
    if (count !== 1) {
      missing.push(`handoff method-seat marker count for ${id} is ${count}, expected 1`);
      continue;
    }
    const seatAt = tail.indexOf(marker);
    if (seatAt <= priorSeatAt) missing.push(`handoff method-seat order mismatch: ${id}`);
    priorSeatAt = seatAt;
    rendered.push(id);
    const nextSeatAt = selected
      .map((candidate) => tail.indexOf(`<!-- ${HANDOFF_METHOD_SEAT_MARKER_PREFIX}${candidate} -->`, seatAt + marker.length))
      .filter((index) => index > seatAt)
      .sort((left, right) => left - right)[0];
    const seatBlock = tail.slice(seatAt, nextSeatAt ?? tail.indexOf(end, seatAt));
    const statement = String(opinions.get(id)?.voice_statement || "").trim();
    const explicitState = run?.master_status?.[id];
    const mayPublishStatement = Boolean(statement) && (!explicitState || explicitState.status === "completed");
    if (mayPublishStatement) {
      if (!seatBlock.includes(statement)) missing.push(`handoff truncated or replaced method-seat statement: ${id}`);
      else fullStatements.push(id);
    } else if (!seatBlock.includes("statement_status=not_produced")) {
      missing.push(`handoff does not explicitly diagnose the missing method-seat statement: ${id}`);
    } else {
      explicitFailures.push(id);
    }
  }

  return {
    schema_version: 1,
    contract_id: "inline_user_response_v1",
    selected_count: selected.length,
    rendered_count: rendered.length,
    full_statement_count: fullStatements.length,
    explicit_failure_count: explicitFailures.length,
    rendered_master_ids: rendered,
    full_statement_master_ids: fullStatements,
    explicit_failure_master_ids: explicitFailures,
    final_section: text.trimEnd().endsWith(end),
    status: missing.length ? "needs_revision" : "passed",
    missing,
  };
}
