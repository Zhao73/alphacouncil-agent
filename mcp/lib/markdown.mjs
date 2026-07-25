import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEBATE_ROLES } from "./constants.mjs";
import { writeJson } from "./fsutil.mjs";
import { isChineseLanguage } from "./lang.mjs";
import { bullets, clip, fence } from "./text.mjs";
import { completenessStatus, validateFinalReport, verificationStatus, withCompletenessBanner, withDisclaimer, withVerificationBanner } from "./gates.mjs";
import { agentState, appendEvent, artifactPaths, runPath, taskState } from "./run-store.mjs";

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
