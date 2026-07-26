import { DEBATE_ROLES, LIMITS, PLACEHOLDER_BODIES, REPORT_SECTIONS } from "./constants.mjs";
import { denseLength, normalizeHeading, parseHeadings } from "./headings.mjs";
import { isChineseLanguage } from "./lang.mjs";

export function withDisclaimer(markdown, language) {
  const text = typeof markdown === "string" ? markdown : "";
  if (/##\s*(Disclaimer|免责声明)/i.test(text)) return text;
  const note = isChineseLanguage(language)
    ? "\n\n---\n\n## 免责声明\n\n本报告由 AI 自动生成,**仅供教育与研究**,**不构成投资建议**,不构成任何证券买卖推荐或要约。AI 分析可能不完整、过时或错误。投资决策前请自行核实并咨询持牌专业人士。作者不对任何损失承担责任。"
    : "\n\n---\n\n## Disclaimer\n\nThis report is AI-generated for **educational and research purposes only**. It is **not investment advice**, not a recommendation to buy or sell any security, and not a solicitation. AI analysis can be incomplete, outdated, or wrong. Do your own research and consult a licensed professional before any investment decision. The authors accept no liability for any loss.";
  return `${text}${note}`;
}

export function withVerificationBanner(markdown, gate, language) {
  const text = typeof markdown === "string" ? markdown : "";
  if (!gate || gate.verification !== "needs_verification") return text;
  const pairs = gate.missing_claim_source_ids || [];
  const lines = pairs.length
    ? pairs.map((item) => `- ${item.task}: ${item.source_id}`).join("\n")
    : "- (unspecified)";
  const banner = isChineseLanguage(language)
    ? `\n\n---\n\n## 来源核验 / Source Verification Gate\n\n**状态:needs_verification。** 以下重大论断引用了不存在的来源 ID,本次运行尚未通过来源核验:\n\n${lines}\n`
    : `\n\n---\n\n## Source Verification Gate / 来源核验\n\n**Status: needs_verification.** The following material claims cite source IDs that are not present in any evidence packet; this run has NOT passed source verification:\n\n${lines}\n`;
  return `${text}${banner}`;
}

export function scopedSourceId(task, id, index = 0) {
  const raw = String(id || `S${index + 1}`).trim() || `S${index + 1}`;
  return raw.includes(":") ? raw : `${task}:${raw}`;
}

export function sourceManifest(run) {
  const sources = [];
  const known = new Set();
  for (const packet of run.packets || []) {
    for (const source of packet.sources || []) {
      if (!source?.id) continue;
      known.add(source.id);
      sources.push({ task: packet.task, ...source });
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
  const missing_evidence = tasks.filter((task) => taskState(run, task).status !== "completed");
  // All three debate roles, including portfolio_manager. SKILL.md and the
  // record_visible_decision tool description have always promised the PM is enforced;
  // the gate only ever checked the two researchers, so a run that skipped the PM
  // entirely could still report itself complete.
  const missing_debate = DEBATE_ROLES.filter((role) => agentState(run, role).status !== "completed");
  // A run that selected a master bench and recorded no opinions used to report itself
  // complete. That let the most expensive stage be skipped silently while the report still
  // read as a finished committee -- and a bench nobody consulted is worse than no bench,
  // because the reader believes the verdict survived twenty-one lenses.
  const selected = Array.isArray(run.masters) ? run.masters : [];
  const recorded = new Set((run.master_opinions || []).map((o) => o.master));
  const missing_masters = selected.filter((id) => !recorded.has(id));
  const complete = missing_evidence.length === 0 && missing_debate.length === 0 && missing_masters.length === 0;
  return {
    completeness: complete ? "complete" : "incomplete",
    missing_evidence,
    missing_debate,
    missing_masters,
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
  const banner = isChineseLanguage(language)
    ? `> [!WARNING]\n## 流程未完成 / Incomplete Council Run\n\n**状态:incomplete。** 本次运行未跑完完整委员会流程,结论不可信。\n\n未完成的证据角色:\n${evLine}\n\n未完成的辩论角色:\n${dbLine}\n${msLine ? `\n未给出意见的大师席位:\n${msLine}\n` : ""}`
    : `> [!WARNING]\n## Incomplete Council Run / 流程未完成\n\n**Status: incomplete.** This run did NOT execute the full council workflow; the conclusion is unreliable.\n\nMissing evidence roles:\n${evLine}\n\nMissing debate roles:\n${dbLine}\n${msLine ? `\nMaster seats that gave no opinion:\n${msLine}\n` : ""}`;
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
        if (!needle || !normalized.includes(needle)) continue;
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

export function validateFinalReport(markdown, run) {
  const text = String(markdown || "");
  const headings = parseHeadings(text);
  const assigned = assignHeadings(headings);
  const missing = [];
  const sections = [];

  const benchRan = ((run?.masters || []).length > 0) || ((run?.master_opinions || []).length > 0);
  for (const section of REPORT_SECTIONS) {
    if (section.when_masters && !benchRan) continue;
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

  const sourceCount = (run.packets || []).reduce((sum, packet) => sum + (packet.sources?.length || 0), 0);
  if (sourceCount > 0 && !/[a-z_]+:s\d+/i.test(text)) missing.push("missing scoped source IDs such as market_data:S1");
  const minLength = run.dry_run ? LIMITS.REPORT_MIN_CHARS_DRY : LIMITS.REPORT_MIN_CHARS;
  if (denseLength(text) < minLength) missing.push(`report too short: minimum ${minLength} non-space characters`);

  return {
    schema_version: 2,
    status: missing.length ? "needs_revision" : "passed",
    missing,
    sections,
    checked_at: new Date().toISOString(),
    required_sections: REPORT_SECTIONS.filter((s) => !s.when_masters || benchRan).map((section) => section.id),
  };
}
