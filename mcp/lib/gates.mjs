import { DEBATE_ROLES, LIMITS, PLACEHOLDER_BODIES, QUICK_REPORT_SECTIONS, REPORT_SECTIONS } from "./constants.mjs";
import { isFundOrIndex } from "./instruments.mjs";
import { denseLength, headingIncludesAlias, normalizeHeading, parseHeadings } from "./headings.mjs";
import { isChineseLanguage, languageKey, readerLanguageStatus } from "./lang.mjs";

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
  if (!gate || gate.verification !== "needs_verification") return text;
  const pairs = gate.missing_claim_source_ids || [];
  const lines = pairs.length
    ? pairs.map((item) => `- ${item.task}: ${item.source_id}`).join("\n")
    : "- (unspecified)";
  const banner = {
    zh: `\n\n---\n\n## 来源核验\n\n**状态：needs_verification。** 以下重大论断引用了证据包中不存在的来源 ID；本轮尚未通过来源核验：\n\n${lines}\n`,
    en: `\n\n---\n\n## Source Verification Gate\n\n**Status: needs_verification.** The following material claims cite source IDs that are not present in any evidence packet; this run has NOT passed source verification:\n\n${lines}\n`,
    ja: `\n\n---\n\n## 出典検証ゲート\n\n**状態：needs_verification。** 次の重要な主張は証拠パケットに存在しない出典 ID を参照しています。この実行は出典検証を通過していません：\n\n${lines}\n`,
    ko: `\n\n---\n\n## 출처 검증 게이트\n\n**상태: needs_verification.** 다음 중요 주장은 증거 패킷에 없는 출처 ID를 참조합니다. 이 실행은 출처 검증을 통과하지 못했습니다:\n\n${lines}\n`,
  }[languageKey(language)];
  return `${text}${banner}`;
}

export function scopedSourceId(task, id, index = 0) {
  const raw = String(id || `S${index + 1}`).trim() || `S${index + 1}`;
  return raw.includes(":") ? raw : `${task}:${raw}`;
}

export function sourceManifest(run) {
  const sources = [];
  const known = new Set();
  const appendSource = (task, source) => {
    const id = source?.id || source?.source_id;
    if (!id || known.has(id)) return;
    known.add(id);
    sources.push({ task, id, ...source });
  };
  for (const source of run.grounding?.typed_fact_sources || []) {
    appendSource("grounding", source);
  }
  for (const packet of run.packets || []) {
    for (const source of packet.sources || []) {
      appendSource(packet.task, source);
    }
  }
  const missing_claim_source_ids = [];
  for (const packet of run.packets || []) {
    for (const claim of packet.claims || []) {
      for (const id of claim.source_ids || []) {
        if (!known.has(id)) missing_claim_source_ids.push({ task: packet.task, source_id: id });
      }
    }
  }
  return {
    run_id: run.run_id,
    symbol: run.symbol,
    as_of: run.as_of,
    source_count: sources.length,
    sources,
    missing_claim_source_ids,
  };
}

export function verificationStatus(run) {
  const missing = sourceManifest(run).missing_claim_source_ids;
  return {
    verification: missing.length ? "needs_verification" : "passed",
    missing_claim_source_ids: missing,
  };
}

export function taskState(run, task) {
  return run.task_status?.[task] || { task, status: "pending" };
}

export function agentState(run, role) {
  return run.agent_status?.[role] || { role, status: "pending" };
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
  const recorded = new Set((run.master_opinions || []).map((o) => o.master));
  const missing_masters = selected.filter((id) => (
    !recorded.has(id)
      || (run.master_status?.[id] && run.master_status[id].status !== "completed")
  ));
  const complete = missing_evidence.length === 0 && missing_debate.length === 0 && missing_masters.length === 0;
  return {
    completeness: complete ? "complete" : "incomplete",
    missing_evidence,
    missing_debate,
    missing_masters,
    degraded_evidence,
    degraded_debate,
    evidence_coverage: degraded_evidence.length ? "degraded" : "complete",
    quick_minimum_successful_tasks: quick ? LIMITS.QUICK_MIN_SUCCESSFUL_TASKS : null,
    successful_evidence_count: successfulEvidence.length,
    missing_evidence_count: missing_evidence.length,
    missing_debate_count: missing_debate.length,
    missing_masters_count: missing_masters.length,
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
  const benchBody = assigned.get("master_bench")?.body || "";
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
