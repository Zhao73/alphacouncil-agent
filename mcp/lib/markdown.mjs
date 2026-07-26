import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEBATE_ROLES } from "./constants.mjs";
import { writeJson } from "./fsutil.mjs";
import { isChineseLanguage } from "./lang.mjs";
import { bullets, clip, fence } from "./text.mjs";
import { completenessStatus, validateFinalReport, verificationStatus, withCompletenessBanner, withDisclaimer, withVerificationBanner } from "./gates.mjs";
import { agentState, appendEvent, artifactPaths, runPath, taskState } from "./run-store.mjs";
import { personaTitle, registry } from "./personas/registry.mjs";

export function renderPacketMarkdown(packet, index) {
  const claims = packet.claims.length
    ? packet.claims.map((claim, claimIndex) => [
      `${claimIndex + 1}. ${claim.claim || ""}`,
      `   - Evidence: ${claim.evidence || ""}`,
      `   - Confidence: ${claim.confidence || "low"}`,
      `   - Sources: ${(claim.source_ids || []).join(", ") || "None"}`,
    ].join("\n")).join("\n")
    : "No claims.";
  const sources = packet.sources.length
    ? packet.sources.map((source) => `- ${source.id || "S?"}: ${source.title || ""} (${source.published_at || "unknown"}) ${source.url || ""}`).join("\n")
    : "- None";
  return [
    `## Evidence Subagent ${index + 1}: ${packet.task}`,
    "",
    `- Symbol: ${packet.symbol}`,
    `- As-of: ${packet.as_of}`,
    packet.thread_id ? `- Visible thread ID: ${packet.thread_id}` : "",
    packet.thread_title ? `- Visible thread title: ${packet.thread_title}` : "",
    `- Confidence: ${packet.confidence}`,
    `- Information richness: ${packet.information_richness || "unrated"}`,
    "",
    "### Summary",
    packet.summary || "",
    "",
    "### Claims",
    claims,
    "",
    "### Metrics",
    fence(packet.metrics || {}, "json"),
    "",
    "### Sources",
    sources,
    "",
    "### Open Questions",
    bullets(packet.open_questions),
    "",
    "### Raw Output / Prompt",
    fence(packet.raw_text || "", "text"),
  ].join("\n");
}

/**
 * A recorded master opinion, rendered so a reader can see what the lens actually said.
 *
 * Master opinions were stored, gated for completeness and weighted into the synthesis, and
 * then rendered nowhere: a run could select ten lenses, pass every gate, and emit a report
 * in which none of them were readable. `out_of_scope` is included deliberately — a method
 * declining to judge is a finding, and hiding it is how a bench looks unanimous.
 */
export function renderMasterMarkdown(opinion, lang) {
  if (!opinion) return "";
  const title = masterTitle(opinion.master, lang);
  return [
    `## ${title}`,
    "",
    `- ID: ${opinion.master}`,
    `- Stance: ${opinion.stance || "unknown"}`,
    `- Verdict: ${opinion.verdict || ""}`,
    `- Confidence: ${opinion.confidence || "low"}`,
    opinion.thread_id ? `- Visible thread ID: ${opinion.thread_id}` : "",
    "",
    "### Summary",
    opinion.summary || "",
    "",
    "### Key Findings",
    bullets(opinion.key_findings),
    "",
    "### Disagreements With The Analysts",
    bullets(opinion.disagreements),
    "",
    "### Disqualifiers Triggered",
    bullets(opinion.disqualifiers_triggered),
    "",
    "### What Would Change My Mind",
    bullets(opinion.what_would_change_my_mind),
    "",
    "### Sources",
    (opinion.source_ids || []).length ? (opinion.source_ids || []).map((id) => `- ${id}`).join("\n") : "- None",
  ].filter((line) => line !== "").join("\n");
}

/**
 * Printed above every rendered bench, in the report's language.
 *
 * Master seats share a base model, an evidence brief and a context window, so their errors
 * are correlated and their agreement is not independent confirmation. Published measurements
 * put LLM error correlation above 60%, which is why a tally of concurring seats is the
 * weakest thing a council produces and the dissenting seat is the informative one. Stating
 * this next to the opinions is the difference between a bench and a vote count.
 */
export function masterCorrelationNote(run) {
  const opinions = run?.master_opinions || [];
  if (!opinions.length) return "";
  const stances = new Map();
  for (const opinion of opinions) {
    const key = opinion.stance || "unknown";
    stances.set(key, (stances.get(key) || 0) + 1);
  }
  const spread = [...stances.entries()].map(([stance, n]) => `${stance}=${n}`).join(", ");
  const zh = isChineseLanguage(run?.language);
  return zh
    ? [
      "> **这些席位不是独立样本。** 它们共享同一个基础模型、同一份证据简报和同一个上下文，",
      `> 因此错误是相关的。本次立场分布（${spread}）**不能当作票数来计算**：一致本身是预期结果，`,
      "> 不是发现。有信息量的是分歧席位，以及它的分歧来自信息差还是方法差。",
    ].join("\n")
    : [
      "> **These seats are not independent samples.** They share a base model, an evidence",
      `> brief and a context window, so their errors are correlated. The stance spread (${spread})`,
      "> **is not a vote count**: agreement is the expected outcome, not a finding. The",
      "> informative seat is the dissenting one, and why it dissents.",
    ].join("\n");
}

/**
 * The bench, ordered so the dissent is read first.
 *
 * A concurring seat is the weakest thing a council produces and the minority is where the
 * information is -- measurements put the minority right in roughly one divergent case in
 * four, and a majority rule discards exactly that. Printing the concurring block first
 * reproduces the tally in prose even when the numbers have been removed, so the order is
 * part of the fix rather than presentation.
 */
export function renderBenchSummary(run) {
  const opinions = run?.master_opinions || [];
  if (!opinions.length) return "";
  const zh = isChineseLanguage(run?.language);
  const counts = new Map();
  for (const o of opinions) counts.set(o.stance || "unknown", (counts.get(o.stance || "unknown") || 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const majority = ranked[0]?.[0];
  const minority = opinions.filter((o) => (o.stance || "unknown") !== majority);
  const concurring = opinions.filter((o) => (o.stance || "unknown") === majority);

  const row = (o) => `| ${masterTitle(o.master, run?.language)} | ${o.stance || "unknown"} | ${o.confidence || "low"} | ${clip(o.verdict || o.summary || "", 90)} |`;
  const head = zh
    ? ["| 方法 | 立场 | 置信度 | 判断 |", "|---|---|---|---|"]
    : ["| Method | Stance | Confidence | Verdict |", "|---|---|---|---|"];

  const sections = [masterCorrelationNote(run), ""];
  if (minority.length) {
    sections.push(
      zh ? "### 少数派（先读这个）" : "### Minority report (read this first)",
      "",
      zh
        ? `${minority.length} 席与多数不同。分歧席位是本次运行里信息量最高的部分——请先判断分歧来自信息差还是方法差。`
        : `${minority.length} seat(s) diverge. Divergence is the highest-information part of this run: establish whether it comes from the evidence slice or from the method.`,
      "",
      ...head,
      ...minority.map(row),
      "",
    );
  } else {
    sections.push(
      zh
        ? "### 少数派：无\n\n所有席位立场一致。鉴于它们共享模型与证据，一致是预期结果而非确认——本次运行没有产生任何独立的反对意见。"
        : "### Minority report: none\n\nEvery seat agreed. Given a shared model and a shared brief, agreement is the expected outcome rather than confirmation: this run produced no independent dissent.",
      "",
    );
  }
  sections.push(
    zh ? "### 其余席位" : "### Concurring seats",
    "",
    ...head,
    ...concurring.map(row),
  );
  return sections.filter((s) => s !== undefined).join("\n");
}

/**
 * The deterministic half, printed as evidence rather than as a vote.
 *
 * Shows what each method could actually measure. `coverage` is the honest column: a score
 * produced from a fifth of a rule set has sampled the company, not judged it.
 */
export function renderDecisionTable(decisions, lang) {
  if (!Array.isArray(decisions) || !decisions.length) return "";
  const zh = isChineseLanguage(lang);
  const head = zh
    ? ["| 方法 | 可评估 | 得分 | 覆盖率 | 立场 | 依据 |", "|---|---|---|---|---|---|"]
    : ["| Method | Eligible | Score | Coverage | Stance | Basis |", "|---|---|---|---|---|---|"];
  const rows = decisions.map((d) => {
    const eligible = d.reason === "eligibility" ? (zh ? "否" : "no") : (zh ? "是" : "yes");
    const score = d.score && d.score.max_possible ? `${d.score.score}/${d.score.max_possible}` : "—";
    const coverage = d.score && d.score.declared_max ? `${Math.round((d.score.coverage || 0) * 100)}%` : "—";
    return `| ${d.persona_id} | ${eligible} | ${score} | ${coverage} | ${d.stance} | ${d.reason} |`;
  });
  return [
    zh ? "### 确定性评分（模型调用之前）" : "### Deterministic scoring (before any model call)",
    "",
    ...head,
    ...rows,
    "",
    zh
      ? "> 覆盖率是这张表最重要的一列：只跑得动一小部分规则的方法是抽样了这家公司，不是判断了它。`可评估=否` 的席位没有花费任何模型调用。"
      : "> Coverage is the column that matters: a method that could run a fraction of its rules sampled the company rather than judging it. Rows marked not eligible cost no model call.",
  ].join("\n");
}

/** Registry title when the persona resolves, the raw id when it does not. */
function masterTitle(id, lang) {
  if (!id) return "Master";
  try {
    const persona = registry().get(id);
    const title = personaTitle(persona, lang);
    return title && title !== id ? `${title} (${id})` : id;
  } catch {
    return id;
  }
}

export function renderDebateRounds(rounds) {
  if (!Array.isArray(rounds) || rounds.length === 0) return "";
  const blocks = rounds.map((round) => [
    `#### Round ${round.round}`,
    "",
    round.summary || "",
    "",
    "##### Long Thesis",
    bullets(round.long_thesis),
    "",
    "##### Short Thesis",
    bullets(round.short_thesis),
    "",
    "##### Questions",
    bullets(round.questions),
    "",
    "##### Questions Answered",
    bullets(round.questions_answered),
    "",
    "##### Raw Output / Prompt",
    fence(round.raw_text || "", "text"),
  ].join("\n"));
  return ["### Debate Rounds", "", ...blocks].join("\n\n");
}

export function renderDebateMarkdown(agent) {
  if (!agent) return "";
  return [
    `## ${agent.role}`,
    "",
    `- Rating: ${agent.rating}`,
    `- Winner: ${agent.winner}`,
    `- Verdict: ${agent.verdict}`,
    `- Confidence: ${agent.confidence}`,
    agent.thread_id ? `- Visible thread ID: ${agent.thread_id}` : "",
    agent.thread_title ? `- Visible thread title: ${agent.thread_title}` : "",
    "",
    "### Summary",
    agent.summary || "",
    "",
    "### Long Thesis",
    bullets(agent.long_thesis),
    "",
    "### Short Thesis",
    bullets(agent.short_thesis),
    "",
    "### Valuation Range",
    agent.valuation_range || "None",
    "",
    "### Catalysts",
    bullets(agent.catalysts),
    "",
    "### Risks",
    bullets(agent.risks),
    "",
    "### Position",
    agent.position || "None",
    "",
    "### Invalidation",
    bullets(agent.invalidation),
    "",
    "### Source IDs",
    bullets(agent.source_ids),
    "",
    "### Report Markdown",
    agent.report_markdown || "",
    "",
    renderDebateRounds(agent.debate_rounds),
    "### Raw Output / Prompt",
    fence(agent.raw_text || "", "text"),
  ].filter(Boolean).join("\n");
}

export function writeAllAgentsMarkdown(run, debate = {}) {
  const dir = runPath(run.run_id);
  const taskStatus = run.tasks.map((task) => {
    const state = taskState(run, task);
    return `- ${task}: ${state.status}${state.output ? ` (${state.output})` : ""}${state.error ? ` - ${state.error}` : ""}`;
  }).join("\n");
  const agentStatus = DEBATE_ROLES.map((role) => {
    const state = agentState(run, role);
    return `- ${role}: ${state.status}${state.output ? ` (${state.output})` : ""}${state.error ? ` - ${state.error}` : ""}`;
  }).join("\n");
  const sections = [
    `# AlphaCouncil Agent Full Agent Trace: ${run.symbol}`,
    "",
    "## Run Metadata",
    "",
    `- Run ID: ${run.run_id}`,
    `- Symbol: ${run.symbol}`,
    `- As-of: ${run.as_of}`,
    `- Language: ${run.language || "auto"}`,
    `- Execution mode: ${run.execution_mode || "background_codex_exec"}`,
    `- Visibility required: ${run.visibility_required || false}`,
    `- Dry run: ${run.dry_run}`,
    `- Status: ${run.status || "unknown"}`,
    `- Phase: ${run.phase || "unknown"}`,
    `- Started: ${run.started_at}`,
    `- Updated: ${run.updated_at || ""}`,
    `- Completed: ${run.completed_at || ""}`,
    `- Tasks: ${run.tasks.join(", ")}`,
    "",
    "## Task Status",
    "",
    taskStatus || "- None",
    "",
    "## Analyst Status",
    "",
    agentStatus || "- None",
    "",
    "# Evidence Subagents",
    "",
    ...run.packets.map(renderPacketMarkdown),
  ];
  const opinions = run.master_opinions || [];
  if (opinions.length) {
    sections.push(
      "",
      "# Master Bench",
      "",
      renderBenchSummary(run),
      "",
      ...opinions.map((opinion) => renderMasterMarkdown(opinion, run.language)),
    );
  }
  if (debate.bull || debate.bear || debate.manager) {
    sections.push(
      "",
      "# Analyst Debate And Portfolio Manager",
      "",
      renderDebateMarkdown(debate.bull),
      "",
      renderDebateMarkdown(debate.bear),
      "",
      renderDebateMarkdown(debate.manager),
    );
  }
  const path = join(dir, "all_agents.md");
  writeFileSync(path, `${sections.filter(Boolean).join("\n\n")}\n`);
  return path;
}

export function writeAnalystMarkdownFiles(run, debate = {}) {
  const dir = runPath(run.run_id);
  for (const [index, packet] of (run.packets || []).entries()) {
    writeFileSync(join(dir, `${packet.task}.md`), `${renderPacketMarkdown(packet, index)}\n`);
  }
  const debateFiles = [
    ["bull_researcher", debate.bull],
    ["bear_researcher", debate.bear],
    ["portfolio_manager", debate.manager],
  ];
  for (const [role, packet] of debateFiles) {
    if (packet) writeFileSync(join(dir, `${role}.md`), `${renderDebateMarkdown({ ...packet, role })}\n`);
  }
  for (const opinion of run.master_opinions || []) {
    writeFileSync(join(dir, `${opinion.master}.md`), `${renderMasterMarkdown(opinion, run.language)}\n`);
  }
}

export function writeReportQuality(run, markdown) {
  const quality = validateFinalReport(markdown, run);
  run.report_quality = quality;
  writeJson(join(runPath(run.run_id), "report_quality.json"), quality);
  return quality;
}

export function finalReportMarkdown(run, manager) {
  const gate = verificationStatus(run);
  const completeness = completenessStatus(run);
  return withDisclaimer(
    withCompletenessBanner(
      withVerificationBanner(manager.report_markdown || manager.summary, gate, run.language),
      completeness,
      run.language
    ),
    run.language
  );
}

export function writeArtifactIndex(run, debate = {}) {
  const artifacts = artifactPaths(run);
  const lines = [
    `# ${run.symbol} AlphaCouncil Artifacts`,
    "",
    `- Run ID: ${run.run_id}`,
    `- Status: ${run.status}`,
    `- Report quality: ${run.report_quality?.status || "not_checked"}`,
    "",
    "## Main Files",
    "",
    `- Final report: ${artifacts.final_report_md}`,
    `- Chat handoff summary: ${artifacts.user_response_md}`,
    `- Full agent trace: ${artifacts.all_agents_md}`,
    `- Evidence JSON: ${artifacts.evidence_json}`,
    `- Decision JSON: ${artifacts.decision_json}`,
    `- Source manifest: ${artifacts.source_manifest_json}`,
    `- Status: ${artifacts.status_json}`,
    `- Events: ${artifacts.events_jsonl}`,
    `- Report quality: ${artifacts.report_quality_json}`,
    "",
    "## Analyst Markdown Files",
    "",
    ...(run.tasks || []).map((task) => `- ${task}: ${artifacts.analyst_markdown[task]}`),
    debate.bull ? `- bull_researcher: ${artifacts.analyst_markdown.bull_researcher}` : "",
    debate.bear ? `- bear_researcher: ${artifacts.analyst_markdown.bear_researcher}` : "",
    debate.manager ? `- portfolio_manager: ${artifacts.analyst_markdown.portfolio_manager}` : "",
    ...((run.master_opinions || []).length
      ? ["", "## Master Bench Markdown Files", "",
        ...(run.master_opinions || []).map((o) => `- ${o.master} (${o.stance || "unknown"}): ${join(runPath(run.run_id), `${o.master}.md`)}`)]
      : []),
  ].filter(Boolean);
  writeFileSync(artifacts.artifact_index_md, `${lines.join("\n")}\n`);
  return artifacts.artifact_index_md;
}

export function packetSummary(run, task) {
  return (run.packets || []).find((packet) => packet.task === task)?.summary || "";
}

export function userResponseMarkdown(run, manager) {
  const chinese = isChineseLanguage(run.language);
  const artifacts = artifactPaths(run);
  const invalidation = (manager.invalidation || []).slice(0, 3).map((item) => `- ${clip(item, 220)}`).join("\n") || "- None";
  if (chinese) {
    return [
      `# ${run.symbol} AlphaCouncil 摘要`,
      "",
      "## 结论",
      `- 评级: ${manager.rating || "Hold"}`,
      `- 多空胜负: ${manager.winner || "unknown"}`,
      `- 置信度: ${manager.confidence || "low"}`,
      `- 判断: ${clip(manager.verdict || manager.summary, 620)}`,
      "",
      "## 关键内容",
      `- 最新财报: ${clip(packetSummary(run, "earnings_deep_dive"), 420) || "未覆盖。"}`,
      `- 前瞻门槛: ${clip(packetSummary(run, "forward_expectations"), 420) || "未覆盖。"}`,
      `- 新闻/行业信号: ${clip([packetSummary(run, "news_industry_management"), packetSummary(run, "management_industry_voices")].filter(Boolean).join(" "), 520) || "未覆盖。"}`,
      `- 估值/价位: ${clip(manager.valuation_range, 520) || "未覆盖。"}`,
      `- 仓位: ${clip(manager.position, 420) || "未覆盖。"}`,
      "",
      "## 失效条件",
      invalidation,
      "",
      "## 文件位置",
      `- 完整报告: ${artifacts.final_report_md}`,
      `- 分析师全文索引: ${artifacts.artifact_index_md}`,
      `- 全部代理追踪: ${artifacts.all_agents_md}`,
      `- 报告质量检查: ${artifacts.report_quality_json}`,
    ].join("\n");
  }
  return [
    `# ${run.symbol} AlphaCouncil Summary`,
    "",
    "## Conclusion",
    `- Rating: ${manager.rating || "Hold"}`,
    `- Debate winner: ${manager.winner || "unknown"}`,
    `- Confidence: ${manager.confidence || "low"}`,
    `- Judgment: ${clip(manager.verdict || manager.summary, 620)}`,
    "",
    "## Key Content",
    `- Latest earnings: ${clip(packetSummary(run, "earnings_deep_dive"), 420) || "Not covered."}`,
    `- Forward thresholds: ${clip(packetSummary(run, "forward_expectations"), 420) || "Not covered."}`,
    `- News / industry signal: ${clip([packetSummary(run, "news_industry_management"), packetSummary(run, "management_industry_voices")].filter(Boolean).join(" "), 520) || "Not covered."}`,
    `- Valuation / price range: ${clip(manager.valuation_range, 520) || "Not covered."}`,
    `- Position: ${clip(manager.position, 420) || "Not covered."}`,
    "",
    "## Invalidation",
    invalidation,
    "",
    "## File Locations",
    `- Full report: ${artifacts.final_report_md}`,
    `- Analyst file index: ${artifacts.artifact_index_md}`,
    `- Full agent trace: ${artifacts.all_agents_md}`,
    `- Report quality check: ${artifacts.report_quality_json}`,
  ].join("\n");
}

export function writeUserResponse(run, manager) {
  const markdown = userResponseMarkdown(run, manager);
  writeFileSync(artifactPaths(run).user_response_md, `${markdown}\n`);
  return markdown;
}

export function writeFinalArtifacts(run, debate = {}) {
  const manager = debate.manager;
  if (!manager) {
    writeAnalystMarkdownFiles(run, debate);
    writeArtifactIndex(run, debate);
    return { artifacts: artifactPaths(run) };
  }
  const finalMarkdown = finalReportMarkdown(run, manager);
  writeFileSync(artifactPaths(run).final_report_md, `${finalMarkdown}\n`);
  const quality = writeReportQuality(run, finalMarkdown);
  if (quality.status !== "passed" && completenessStatus(run).completeness === "complete" && verificationStatus(run).verification === "passed") {
    run.status = "needs_revision";
    run.phase = "needs_revision";
    appendEvent(run, "needs_revision", { missing: quality.missing });
  }
  writeAnalystMarkdownFiles(run, debate);
  const user_response_markdown = writeUserResponse(run, manager);
  writeArtifactIndex(run, debate);
  return { final_report_markdown: finalMarkdown, user_response_markdown, report_quality: quality, artifacts: artifactPaths(run) };
}
