import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { __test__ } from "../mcp/server.mjs";

const governanceSkill = readFileSync(join(process.cwd(), "skills", "agent-skills-governance", "SKILL.md"), "utf8");
const alphaSkill = readFileSync(join(process.cwd(), "skills", "alphacouncil-agent", "SKILL.md"), "utf8");
const claudeRules = readFileSync(join(process.cwd(), "CLAUDE.md"), "utf8");
const agentsRules = readFileSync(join(process.cwd(), "AGENTS.md"), "utf8");
if (!governanceSkill.includes("addyosmani/agent-skills") || !governanceSkill.includes("Stop Gates") || !governanceSkill.includes("Anti-Rationalizations")) {
  throw new Error("agent-skills governance skill must be bundled with explicit gates and anti-rationalizations.");
}
for (const [name, text] of [["alphacouncil-agent skill", alphaSkill], ["CLAUDE.md", claudeRules], ["AGENTS.md", agentsRules]]) {
  if (!text.includes("agent-skills-governance")) throw new Error(`${name} must reference the bundled governance skill.`);
}

const workerPrompt = __test__.taskPrompt("market_data", "NOK", "2026-06-22", "帮我看看 NOK", "auto");
if (!workerPrompt.includes("不要调用 alphacouncil-agent 插件/MCP 工具") || !workerPrompt.includes("字段内容用中文")) {
  throw new Error("worker prompt must be Chinese and block recursive alphacouncil-agent calls.");
}
const englishPrompt = __test__.taskPrompt("market_data", "NOK", "2026-06-22", "Can I enter NOK?", "auto");
if (!englishPrompt.includes("reader-facing fields") || !englishPrompt.includes("English") || englishPrompt.includes("字段内容用中文")) {
  throw new Error("worker prompt must follow non-Chinese language requests.");
}
const quantPrompt = __test__.taskPrompt("quant_factor", "NOK", "2026-06-22", "帮我看看 NOK", "auto");
if (!quantPrompt.includes("量化组合经理") || !quantPrompt.includes("动能") || !quantPrompt.includes("open_questions")) {
  throw new Error("quant_factor prompt must request factor evidence and missing-data reporting.");
}
if (__test__.resolveLanguage({ prompt: "帮我看看 NOK" }) !== "中文" || __test__.resolveLanguage({ prompt: "Can I enter NOK?" }) !== "English") {
  throw new Error("language inference failed.");
}
const cleaned = __test__.cleanLog(`\u001b[31m${"x".repeat(5000)}`, 20);
if (cleaned.includes("\u001b") || cleaned.length !== 20) {
  throw new Error("cleanLog did not strip ANSI and truncate.");
}
if (__test__.isDryRun({}) || !__test__.isDryRun({ dry_run: true }) || __test__.isDryRun({ dry_run: false })) {
  throw new Error("dry_run default must launch real Codex subagents.");
}
const posixCodex = __test__.codexInvocation(["exec", "-C", "/tmp/alpha council"], "linux", { ALPHACOUNCIL_AGENT_CODEX_CMD: "codex" });
if (posixCodex.command !== "codex" || posixCodex.args.at(-1) !== "-" || posixCodex.options.detached !== true) {
  throw new Error("posix codex invocation must call codex directly and read prompt from stdin.");
}
const winCodex = __test__.codexInvocation(["exec", "-C", "C:\\Users\\Example User\\.alphacouncil-agent"], "win32", {
  ComSpec: "C:\\Windows\\System32\\cmd.exe",
  ALPHACOUNCIL_AGENT_CODEX_CMD: "codex",
});
if (winCodex.command !== "C:\\Windows\\System32\\cmd.exe" || winCodex.args.slice(0, 3).join(" ") !== "/d /s /c") {
  throw new Error("windows codex invocation must use cmd.exe so codex.cmd resolves.");
}
if (!winCodex.args[3].includes("\"C:\\Users\\Example User\\.alphacouncil-agent\"") || !winCodex.args[3].endsWith(" -")) {
  throw new Error("windows codex invocation must quote spaced paths and read prompt from stdin.");
}
const scoped = __test__.normalizePacket({
  claims: [{ claim: "price", evidence: "source", confidence: "high", source_ids: ["S1"] }],
  sources: [{ id: "S1", title: "Quote", url: "https://example.com" }],
  confidence: "high",
}, "market_data", "NVDA", "2026-06-22", "{}");
if (scoped.sources[0].id !== "market_data:S1" || scoped.claims[0].source_ids[0] !== "market_data:S1") {
  throw new Error("source IDs must be task-scoped.");
}
const manifest = __test__.sourceManifest({ run_id: "TEST", symbol: "NVDA", as_of: "2026-06-22", packets: [scoped] });
if (manifest.source_count !== 1 || manifest.missing_claim_source_ids.length !== 0) {
  throw new Error("source manifest did not preserve scoped sources.");
}

// Verification gate: clean run passes.
const cleanGate = __test__.verificationStatus({ packets: [scoped] });
if (cleanGate.verification !== "passed" || cleanGate.missing_claim_source_ids.length !== 0) {
  throw new Error("verificationStatus must pass a run with no missing claim sources.");
}
// Verification gate: a claim citing an unknown source id flips to needs_verification.
const missingPacket = __test__.normalizePacket({
  claims: [{ claim: "c", evidence: "e", confidence: "high", source_ids: ["ghost:S9"] }],
  sources: [],
  confidence: "high",
}, "market_data", "NVDA", "2026-06-22", "{}");
const gappedGate = __test__.verificationStatus({ packets: [missingPacket] });
if (gappedGate.verification !== "needs_verification" || gappedGate.missing_claim_source_ids.length !== 1) {
  throw new Error("verificationStatus must flag a claim citing a missing source id.");
}
const missEntry = gappedGate.missing_claim_source_ids[0];
if (missEntry.task !== "market_data" || missEntry.source_id !== "ghost:S9") {
  throw new Error("verificationStatus must preserve {task, source_id} shape.");
}
// withVerificationBanner: identity on pass, banner on needs_verification.
if (__test__.withVerificationBanner("BODY", cleanGate, "English") !== "BODY") {
  throw new Error("withVerificationBanner must be identity when the gate passes.");
}
if (!__test__.withVerificationBanner("BODY", gappedGate, "English").includes("Source Verification Gate")) {
  throw new Error("withVerificationBanner must surface the gate when needs_verification.");
}

// Completeness gate: a run with all tasks + bull/bear completed is complete.
const completeRun = {
  tasks: ["market_data"],
  task_status: { market_data: { task: "market_data", status: "completed" } },
  agent_status: {
    bull_researcher: { role: "bull_researcher", status: "completed" },
    bear_researcher: { role: "bear_researcher", status: "completed" },
    portfolio_manager: { role: "portfolio_manager", status: "pending" },
  },
  packets: [],
};
const completeComp = __test__.completenessStatus(completeRun);
if (completeComp.completeness !== "complete" || completeComp.missing_evidence_count !== 0 || completeComp.missing_debate_count !== 0) {
  throw new Error("completenessStatus must mark a fully-recorded run complete.");
}
// Completeness gate: a pending evidence task flips to incomplete.
const pendingEvidenceComp = __test__.completenessStatus({
  ...completeRun,
  task_status: { market_data: { task: "market_data", status: "pending" } },
});
if (pendingEvidenceComp.completeness !== "incomplete" || pendingEvidenceComp.missing_evidence_count !== 1) {
  throw new Error("completenessStatus must flag a pending evidence task.");
}
// Completeness gate: a missing debate researcher flips to incomplete.
const missingBearComp = __test__.completenessStatus({
  ...completeRun,
  agent_status: {
    bull_researcher: { role: "bull_researcher", status: "completed" },
    bear_researcher: { role: "bear_researcher", status: "pending" },
    portfolio_manager: { role: "portfolio_manager", status: "pending" },
  },
});
if (missingBearComp.completeness !== "incomplete" || !missingBearComp.missing_debate.includes("bear_researcher")) {
  throw new Error("completenessStatus must flag a missing debate researcher.");
}
// withCompletenessBanner: identity on complete, banner on incomplete.
if (__test__.withCompletenessBanner("BODY", completeComp, "English") !== "BODY") {
  throw new Error("withCompletenessBanner must be identity when complete.");
}
const incompleteBanner = __test__.withCompletenessBanner("BODY", missingBearComp, "English");
if (!incompleteBanner.includes("Incomplete Council Run") || !incompleteBanner.includes("BODY")) {
  throw new Error("withCompletenessBanner must prepend an INCOMPLETE banner and preserve the body.");
}

// normalizeDebate optional contract fields default to empty arrays.
const debateDefaults = __test__.normalizeDebate({}, "bull_researcher", { symbol: "NVDA", as_of: "2026-06-22" }, "");
if (!Array.isArray(debateDefaults.debate_rounds) || debateDefaults.debate_rounds.length !== 0
  || !Array.isArray(debateDefaults.questions) || debateDefaults.questions.length !== 0
  || !Array.isArray(debateDefaults.questions_answered) || debateDefaults.questions_answered.length !== 0) {
  throw new Error("normalizeDebate must default debate_rounds/questions/questions_answered to empty arrays.");
}

// mergeDebateRounds: top-level from last round, debate_rounds preserves all three.
const mkRound = (rating, summary) => __test__.normalizeDebate({ rating, summary }, "bull_researcher", { symbol: "NVDA", as_of: "2026-06-22" }, summary);
const merged = __test__.mergeDebateRounds([mkRound("Hold", "r1"), mkRound("Overweight", "r2"), mkRound("Buy", "r3")]);
if (merged.rating !== "Buy" || merged.summary !== "r3") {
  throw new Error("mergeDebateRounds must take top-level fields from the last round.");
}
if (merged.debate_rounds.length !== 3 || merged.debate_rounds.map((r) => r.round).join(",") !== "1,2,3") {
  throw new Error("mergeDebateRounds must capture all three rounds in order.");
}
const completeVisibleReport = `# NOK Visible Selfcheck Report

## Conclusion
Hold. This is a complete selfcheck report body used to prove the quality gate accepts a report with every required section and rejects thin recaps.

## Analyst Work Log
### market_data
The market_data analyst produced a visible packet. This section names the planned analyst explicitly and records the evidence handoff.

## Bull/Bear Debate Record
The bull researcher argued for upside, the bear researcher argued for downside, and the portfolio manager balanced both sides.

## Long Thesis
The long thesis is present for report-contract coverage.

## Short Thesis
The short thesis is present for report-contract coverage.

## Market Expectations and Implied Thresholds
The report states what the market would need to see, even when this selfcheck has no live market expectations.

## Analyst Rating and Target-Price Revisions
Analyst rating and target-price revision coverage is present.

## Earnings Call Management Signals
Earnings call management signal coverage is present.

## Quant Factor / Technical Risk View
Quant factor and technical risk coverage is present.

## News and Company / Industry Voice Signals
News and company or industry voice coverage is present.

## Short Interest / Borrow / Options Information
Short Interest, borrow, and options coverage is present, with unavailable data called out rather than omitted.

## Strategic Transaction or NVIDIA Terms
Strategic Transaction coverage is present even when no transaction exists.

## Valuation Range
Valuation coverage is present.

## Key Catalysts
Catalyst coverage is present.

## Major Risks
Risk coverage is present.

## Position Recommendation
Position coverage is present.

## Short-Term 1-4 Week View
Short-Term coverage is present.

## Medium-Term 3-6 Month View
Medium-Term coverage is present.

## Long-Term 12 Month View
Long-Term coverage is present.

## Data Gaps / Unavailable Data
No critical data gaps were found in this selfcheck fixture.

## Invalidation Conditions
Invalidation coverage is present.

## Confidence
medium

## Source Table
market_data:S1 - Selfcheck quote source. This paragraph intentionally keeps the body long enough that the quality gate catches genuinely short reports instead of accepting a heading-only stub.`;
const qualityRun = { ...completeRun, run_id: "QUALITY", symbol: "NOK", as_of: "2026-06-22", dry_run: false, language: "English", tasks: ["market_data"], packets: [scoped] };
if (__test__.validateFinalReport(completeVisibleReport, qualityRun).status !== "passed") {
  throw new Error("complete fixture report must pass report quality.");
}
if (__test__.validateFinalReport("# Thin\n\n## Conclusion\nToo short.", qualityRun).status !== "needs_revision") {
  throw new Error("thin report must fail report quality.");
}

const child = spawn("node", ["./mcp/server.mjs"], {
  cwd: new URL("..", import.meta.url),
  stdio: ["pipe", "pipe", "inherit"],
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

const lines = [];
child.stdout.on("data", (chunk) => {
  lines.push(...chunk.toString().trim().split("\n").filter(Boolean));
});

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
send({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "analyze_symbol",
    arguments: { symbol: "NVDA", dry_run: true, tasks: ["market_data", "valuation_long_short"] },
  },
});

await new Promise((resolve) => setTimeout(resolve, 800));
child.kill("SIGTERM");
await once(child, "close");

const responses = lines.map((line) => JSON.parse(line));
if (!responses.some((item) => item.id === 2 && item.result?.tools?.length === 7)) {
  throw new Error("tools/list did not return the expected tools.");
}
const toolsList = responses.find((item) => item.id === 2)?.result?.tools || [];
const analyzeTool = toolsList.find((tool) => tool.name === "analyze_symbol");
if (analyzeTool?.inputSchema?.properties?.dry_run?.default !== false) {
  throw new Error("analyze_symbol dry_run schema default must be false.");
}
if (!analyzeTool?.inputSchema?.properties?.language) {
  throw new Error("analyze_symbol must expose language selection.");
}
if (!analyzeTool?.inputSchema?.properties?.tasks?.items?.enum?.includes("quant_factor")) {
  throw new Error("analyze_symbol must expose quant_factor as a task.");
}
if (!responses.some((item) => item.id === 3 && item.result?.structuredContent?.decision?.verdict === "DRY_RUN")) {
  throw new Error("dry-run analyze_symbol did not return a DRY_RUN decision.");
}
const analysis = responses.find((item) => item.id === 3);
if (!analysis?.result?.structuredContent?.final_report_markdown || !analysis?.result?.structuredContent?.user_response_markdown) {
  throw new Error("analyze_symbol must return final_report_markdown and user_response_markdown.");
}
if (analysis.result.structuredContent.report_quality?.status !== "passed") {
  throw new Error("dry-run final report quality must pass.");
}
const runId = analysis?.result?.structuredContent?.run?.run_id;
const tracePath = join(os.homedir(), ".alphacouncil-agent", "runs", runId, "all_agents.md");
const statusPath = join(os.homedir(), ".alphacouncil-agent", "runs", runId, "status.json");
const eventsPath = join(os.homedir(), ".alphacouncil-agent", "runs", runId, "events.jsonl");
const sourceManifestPath = join(os.homedir(), ".alphacouncil-agent", "runs", runId, "source_manifest.json");
const finalReportPath = join(os.homedir(), ".alphacouncil-agent", "runs", runId, "final_report.md");
const userResponsePath = join(os.homedir(), ".alphacouncil-agent", "runs", runId, "user_response.md");
const artifactIndexPath = join(os.homedir(), ".alphacouncil-agent", "runs", runId, "artifact_index.md");
const reportQualityPath = join(os.homedir(), ".alphacouncil-agent", "runs", runId, "report_quality.json");
const dryAnalystPath = join(os.homedir(), ".alphacouncil-agent", "runs", runId, "market_data.md");
const dryPmPath = join(os.homedir(), ".alphacouncil-agent", "runs", runId, "portfolio_manager.md");
if (!existsSync(tracePath)) {
  throw new Error("all_agents.md was not written.");
}
if (!existsSync(statusPath)) {
  throw new Error("status.json was not written.");
}
if (!existsSync(eventsPath)) {
  throw new Error("events.jsonl was not written.");
}
if (!existsSync(sourceManifestPath)) {
  throw new Error("source_manifest.json was not written.");
}
if (!existsSync(finalReportPath)) {
  throw new Error("final_report.md was not written.");
}
for (const path of [userResponsePath, artifactIndexPath, reportQualityPath, dryAnalystPath, dryPmPath]) {
  if (!existsSync(path)) throw new Error(`${path} was not written.`);
}
const trace = readFileSync(tracePath, "utf8");
if (!trace.includes("Evidence Subagent") || !trace.includes("portfolio_manager")) {
  throw new Error("all_agents.md does not include the expected agent sections.");
}
const finalReport = readFileSync(finalReportPath, "utf8");
if (!finalReport.includes("数据缺口/未覆盖项") && !finalReport.includes("Data Gaps / Unavailable Data")) {
  throw new Error("final_report.md must report data gaps explicitly.");
}
if (!finalReport.includes("分析师工作记录") && !finalReport.includes("Analyst Work Log")) {
  throw new Error("final_report.md must include analyst work log.");
}
if (!finalReport.includes("多空辩论记录") && !finalReport.includes("Bull/Bear Debate Record")) {
  throw new Error("final_report.md must include bull/bear debate record.");
}
if (!finalReport.includes("Market Expectations") || !finalReport.includes("News and Company")) {
  throw new Error("final_report.md must include forward-looking and news sections.");
}
const userResponse = readFileSync(userResponsePath, "utf8");
if (!userResponse.includes("Full report:") || !userResponse.includes("Latest earnings:")) {
  throw new Error("user_response.md must include concise handoff and file locations.");
}
const artifactIndex = readFileSync(artifactIndexPath, "utf8");
if (!artifactIndex.includes("market_data.md") || !artifactIndex.includes("portfolio_manager.md")) {
  throw new Error("artifact_index.md must list analyst markdown files.");
}
const reportQuality = JSON.parse(readFileSync(reportQualityPath, "utf8"));
if (reportQuality.status !== "passed") {
  throw new Error("report_quality.json must pass for a complete dry run.");
}
const status = JSON.parse(readFileSync(statusPath, "utf8"));
if (status.status !== "complete" || !status.tasks.every((task) => task.status === "completed")) {
  throw new Error("status.json did not record a complete dry run.");
}
if (status.report_quality !== "passed") {
  throw new Error("status.json must surface report quality.");
}
if (status.verification !== "passed" || status.missing_source_count !== 0) {
  throw new Error("clean dry run must surface verification=passed with zero missing sources.");
}
const events = readFileSync(eventsPath, "utf8");
if (!events.includes("run_started") || !events.includes("run_complete")) {
  throw new Error("events.jsonl did not record run lifecycle events.");
}

const visible = spawn("node", ["./mcp/server.mjs"], {
  cwd: new URL("..", import.meta.url),
  stdio: ["pipe", "pipe", "inherit"],
});
const visibleLines = [];
visible.stdout.on("data", (chunk) => {
  visibleLines.push(...chunk.toString().trim().split("\n").filter(Boolean));
});
function sendVisible(message) {
  visible.stdin.write(`${JSON.stringify(message)}\n`);
}
sendVisible({
  jsonrpc: "2.0",
  id: 10,
  method: "tools/call",
  params: { name: "plan_visible_run", arguments: { symbol: "NOK", run_id: "SELFTEST-VISIBLE", tasks: ["market_data"] } },
});
sendVisible({
  jsonrpc: "2.0",
  id: 11,
  method: "tools/call",
  params: {
    name: "record_visible_packet",
    arguments: {
      run_id: "SELFTEST-VISIBLE",
      task: "market_data",
      thread_id: "thread-visible-market",
      thread_title: "AlphaCouncil Agent NOK market_data",
      packet: { summary: "visible packet", claims: [], metrics: {}, sources: [], open_questions: [], confidence: "medium" },
    },
  },
});
sendVisible({
  jsonrpc: "2.0",
  id: "11a",
  method: "tools/call",
  params: {
    name: "record_visible_decision",
    arguments: {
      run_id: "SELFTEST-VISIBLE",
      role: "bull_researcher",
      thread_id: "thread-visible-bull",
      thread_title: "AlphaCouncil Agent NOK bull_researcher",
      packet: { verdict: "BULL_OK", rating: "Buy", winner: "bull", summary: "visible bull", confidence: "medium" },
    },
  },
});
sendVisible({
  jsonrpc: "2.0",
  id: "11b",
  method: "tools/call",
  params: {
    name: "record_visible_decision",
    arguments: {
      run_id: "SELFTEST-VISIBLE",
      role: "bear_researcher",
      thread_id: "thread-visible-bear",
      thread_title: "AlphaCouncil Agent NOK bear_researcher",
      packet: { verdict: "BEAR_OK", rating: "Sell", winner: "bear", summary: "visible bear", confidence: "medium" },
    },
  },
});
sendVisible({
  jsonrpc: "2.0",
  id: 12,
  method: "tools/call",
  params: {
    name: "record_visible_decision",
    arguments: {
      run_id: "SELFTEST-VISIBLE",
      role: "portfolio_manager",
      thread_id: "thread-visible-pm",
      thread_title: "AlphaCouncil Agent NOK portfolio_manager",
      packet: { verdict: "VISIBLE_OK", rating: "Hold", winner: "balanced", summary: "visible decision", confidence: "medium", report_markdown: completeVisibleReport },
    },
  },
});
sendVisible({
  jsonrpc: "2.0",
  id: 13,
  method: "tools/call",
  params: {
    name: "record_visible_packet",
    arguments: {
      run_id: "SELFTEST-VISIBLE",
      task: "market_data",
      thread_id: "thread-visible-market",
      thread_title: "AlphaCouncil Agent NOK market_data",
      packet: { summary: "late visible packet update", claims: [], metrics: {}, sources: [], open_questions: [], confidence: "medium" },
    },
  },
});
sendVisible({
  jsonrpc: "2.0",
  id: 14,
  method: "tools/call",
  params: {
    name: "record_visible_packet",
    arguments: {
      run_id: "SELFTEST-VISIBLE",
      task: "market_data",
      thread_id: "thread-visible-market",
      thread_title: "AlphaCouncil Agent NOK market_data",
      packet: { summary: "replayed visible packet", claims: [], metrics: {}, sources: [], open_questions: [], confidence: "medium", raw_text: "original visible agent output" },
    },
  },
});
// Intentionally-incomplete visible run: plan 2 evidence tasks, record only 1, skip bull/bear, then PM.
sendVisible({
  jsonrpc: "2.0",
  id: 20,
  method: "tools/call",
  params: { name: "plan_visible_run", arguments: { symbol: "NOK", run_id: "SELFTEST-INCOMPLETE", tasks: ["market_data", "valuation_long_short"] } },
});
sendVisible({
  jsonrpc: "2.0",
  id: 21,
  method: "tools/call",
  params: {
    name: "record_visible_packet",
    arguments: {
      run_id: "SELFTEST-INCOMPLETE",
      task: "market_data",
      thread_id: "thread-incomplete-market",
      thread_title: "AlphaCouncil Agent NOK market_data",
      packet: { summary: "only evidence packet", claims: [], metrics: {}, sources: [], open_questions: [], confidence: "medium" },
    },
  },
});
sendVisible({
  jsonrpc: "2.0",
  id: 22,
  method: "tools/call",
  params: {
    name: "record_visible_decision",
    arguments: {
      run_id: "SELFTEST-INCOMPLETE",
      role: "portfolio_manager",
      thread_id: "thread-incomplete-pm",
      thread_title: "AlphaCouncil Agent NOK portfolio_manager",
      packet: { verdict: "SHORTCUT", rating: "Hold", winner: "balanced", summary: "shortcut decision", confidence: "low", report_markdown: "# PM body" },
    },
  },
});
await new Promise((resolve) => setTimeout(resolve, 800));
visible.kill("SIGTERM");
await once(visible, "close");
const visibleResponses = visibleLines.map((line) => JSON.parse(line));
if (!visibleResponses.some((item) => item.id === 12 && item.result?.structuredContent?.decision?.thread_id === "thread-visible-pm")) {
  throw new Error("visible decision was not recorded with thread id.");
}
if (!visibleResponses.some((item) => item.id === 13 && item.result?.structuredContent?.status === "complete")) {
  throw new Error("late visible packet update downgraded a complete run.");
}
if (!visibleResponses.some((item) => item.id === 14 && item.result?.structuredContent?.status === "complete")) {
  throw new Error("replayed visible packet update downgraded a complete run.");
}
const visibleTrace = readFileSync(join(os.homedir(), ".alphacouncil-agent", "runs", "SELFTEST-VISIBLE", "all_agents.md"), "utf8");
if (!visibleTrace.includes("Visible thread ID: thread-visible-market") || !visibleTrace.includes("Visible thread ID: thread-visible-pm")) {
  throw new Error("visible thread ids were not written to all_agents.md.");
}
const visibleStatus = JSON.parse(readFileSync(join(os.homedir(), ".alphacouncil-agent", "runs", "SELFTEST-VISIBLE", "status.json"), "utf8"));
if (visibleStatus.status !== "complete" || visibleStatus.phase !== "complete") {
  throw new Error("late visible packet update did not preserve complete status.");
}
if (visibleStatus.report_quality !== "passed") {
  throw new Error("visible run must surface passed report quality.");
}
if (visibleStatus.verification !== "passed") {
  throw new Error("clean visible run must surface verification=passed.");
}
const visiblePacket = JSON.parse(readFileSync(join(os.homedir(), ".alphacouncil-agent", "runs", "SELFTEST-VISIBLE", "market_data.json"), "utf8"));
if (visiblePacket.raw_text !== "original visible agent output") {
  throw new Error("replayed visible packet nested or rewrote raw_text.");
}
for (const file of ["user_response.md", "artifact_index.md", "report_quality.json", "market_data.md", "portfolio_manager.md"]) {
  if (!existsSync(join(os.homedir(), ".alphacouncil-agent", "runs", "SELFTEST-VISIBLE", file))) {
    throw new Error(`visible run did not write ${file}.`);
  }
}

// Incomplete visible run: PM recorded with missing evidence + missing bull/bear must be flagged.
const incompletePm = visibleResponses.find((item) => item.id === 22);
if (incompletePm?.result?.structuredContent?.run?.status !== "incomplete" || incompletePm?.result?.structuredContent?.run?.phase !== "incomplete") {
  throw new Error("incomplete visible run must report status/phase incomplete.");
}
const incompleteStatus = JSON.parse(readFileSync(join(os.homedir(), ".alphacouncil-agent", "runs", "SELFTEST-INCOMPLETE", "status.json"), "utf8"));
if (incompleteStatus.status !== "incomplete" || incompleteStatus.phase !== "incomplete" || incompleteStatus.completeness !== "incomplete") {
  throw new Error("incomplete run status.json did not record incomplete status/phase/completeness.");
}
if (incompleteStatus.missing_evidence_count !== 1 || incompleteStatus.missing_debate_count !== 2) {
  throw new Error("incomplete run must report 1 missing evidence task and 2 missing debate roles.");
}
const incompleteReport = readFileSync(join(os.homedir(), ".alphacouncil-agent", "runs", "SELFTEST-INCOMPLETE", "final_report.md"), "utf8");
if (!incompleteReport.includes("Incomplete Council Run")) {
  throw new Error("incomplete run final_report.md must carry the INCOMPLETE banner.");
}
if (!incompleteReport.includes("PM body")) {
  throw new Error("incomplete run final_report.md must preserve the recorded report body (no data deletion).");
}
const incompleteEvents = readFileSync(join(os.homedir(), ".alphacouncil-agent", "runs", "SELFTEST-INCOMPLETE", "events.jsonl"), "utf8");
if (!incompleteEvents.includes("\"incomplete\"")) {
  throw new Error("incomplete run events.jsonl must record an incomplete event.");
}

console.log("selfcheck passed");
