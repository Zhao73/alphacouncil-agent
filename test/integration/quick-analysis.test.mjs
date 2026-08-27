import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { QUICK_TASKS } from "../../mcp/lib/constants.mjs";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { observerBudget, startServer, structured } from "../helpers/rpc-client.mjs";
import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";
import { validateHeadlessTrace } from "../../scripts/lib/headless-trace-contract.mjs";

function reportBody(failedTask = null) {
  const work = QUICK_TASKS.map((task) => task === failedTask
    ? `- ${task}: failed explicitly; the quick report records this evidence gap and does not cite a fabricated source.`
    : `- ${task}: completed a sourced quick-read packet and recorded confidence plus open questions.`).join("\n");
  const sourceRows = QUICK_TASKS.filter((task) => task !== failedTask)
    .map((task) => `- ${task}:S1 — ${task} source — 2026-07-27 — https://example.com/${task}`)
    .join("\n");
  return `# RKLB Quick Council

## Conclusion
The bounded quick council returns Hold with medium confidence. It is a directional read and is not equivalent to a full council.

## Analyst Work Log
${work}

## Bull/Bear Debate Record
One parallel statement round completed. The bull cited operating evidence; the bear cited valuation, dilution and execution risk.

## Earnings Call Management Signals
Management signals were taken from the earnings packet and kept separate from unsupported interpretation.

## Recent Company and Industry News
The news seat supplied dated company and industry sources and excluded stale or undated items from the recent list.

## Valuation Range
Valuation remains conditional on revenue growth, margin delivery and dilution rather than one unsupported target price.

## Price Levels
Do not chase above the evidence range; wait for confirmation near the middle; reassess below it only while the operating thesis remains intact.

## Major Risks
Launch delays, financing requirements, dilution and missing facts can invalidate the quick directional view.

## Position Recommendation
Keep any position small until the next primary filing resolves the highest-impact unknowns.

## Data Gaps / Unavailable Data
No adversarial verifier or three-round cross-examination ran in quick_v1. Those omissions are product-scope limits, not evidence.${failedTask ? ` The ${failedTask} evidence seat failed and no source ID was manufactured for it.` : ""}

## Confidence
medium and conditional on the cited quick packets.

## Source Table
${sourceRows}
`;
}

function fakeCodex(dataDir, { failedTask = null, failedRole = null, wrongLanguagePmOnce = false } = {}) {
  const driver = join(dataDir, "fake-quick-codex.mjs");
  const log = join(dataDir, "quick-worker-log.jsonl");
  writeFileSync(driver, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const asOf = /as[-_ ]of(?: date)?\\s*:\\s*(\\d{4}-\\d{2}-\\d{2})/iu.exec(prompt)?.[1] || "2026-07-28";
const task = (${JSON.stringify(QUICK_TASKS)}).find((id) => prompt.includes("Task: " + id));
const master = /dedicated, isolated method-seat explanation worker[^\\n]*\\((master_[a-z0-9_]+)\\)/iu.exec(prompt)?.[1] || null;
const parseRepair = prompt.includes("PARSE-ONLY TRANSPORT REPAIR");
const role = /You are the portfolio_manager|Role: portfolio_manager/i.test(prompt) ? "portfolio_manager"
  : /You are the bull_researcher/i.test(prompt) ? "bull_researcher"
  : /You are the bear_researcher/i.test(prompt) ? "bear_researcher"
  : master || task || "unknown";
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ role, parseRepair, search: args.includes("--search"), at: Date.now(), prompt_chars: prompt.length }) + "\\n");
if (task && task === ${JSON.stringify(failedTask)}) process.exit(17);
if (role === ${JSON.stringify(failedRole)}) process.exit(19);
await new Promise((resolve) => setTimeout(resolve, role === "portfolio_manager" ? 40 : 120));
let packet;
if (task) {
  const officialDatedItems = [
    { title: "STALE_SENTINEL", published_at: "2025-01-01", url: "https://example.com/stale", source_id: "S3" },
    { title: task + " dated source", published_at: "2026-07-27", url: "https://example.com/" + task, source_id: "S1" },
    ...(asOf >= "2026-08-01"
      ? [{ title: "FUTURE_SENTINEL", published_at: "2026-08-01", url: "https://example.com/future", source_id: "S4" }]
      : []),
  ];
  const officialLatest = officialDatedItems.at(-1);
  packet = {
    summary: task + " quick analyst summary with explicit facts and limits.",
    claims: [{ claim: task + " material claim", claim_type: "event_or_observation", evidence: "bounded fixture evidence", confidence: "medium", source_ids: ["S1"] }],
    metrics: { fixture: 1 },
    sources: [
      { id: "S1", title: task + " dated source", url: "https://example.com/" + task, published_at: "2026-07-27", retrieved_at: "2026-07-28" },
      ...(task === "news_industry_management" ? [
        { id: "S2", title: "UNDATED_SENTINEL", url: "https://example.com/undated", published_at: "unknown", retrieved_at: "2026-07-28" },
        { id: "S3", title: "STALE_SENTINEL", url: "https://example.com/stale", published_at: "2025-01-01", retrieved_at: "2026-07-28" },
        { id: "S4", title: "FUTURE_SENTINEL", url: "https://example.com/future", published_at: "2026-08-01", retrieved_at: "2026-07-28" },
      ] : []),
    ],
    open_questions: [], confidence: "medium", information_richness: "B",
    ...(task === "news_industry_management" ? {
      official_source_coverage: {
        status: "complete",
        regulator: {
          status: "complete", entry_url: "https://example.com/regulator-feed", checked_through: asOf,
          latest_dated_item: { ...officialLatest, record_id: "fixture-filing" },
          dated_items_checked: officialDatedItems.map((item) => ({ ...item, record_id: "fixture-filing" })),
          gap: null
        },
        issuer: {
          status: "complete", entry_url: "https://example.com/issuer-news", checked_through: asOf,
          latest_dated_item: officialLatest,
          dated_items_checked: officialDatedItems,
          gap: null
        }
      }
    } : {})
  };
} else if (master) {
  const frozenLine = prompt.split("\\n").find((item) => item.startsWith("Frozen method result JSON: "));
  const frozen = JSON.parse(frozenLine.slice("Frozen method result JSON: ".length));
  packet = {
    master,
    acknowledged_stance: frozen.stance,
    voice_mode: "first_person_public_method_simulation_v1",
    disclosure_ack: "alphacouncil.first_person_public_method_simulation.v1",
    position_intent: ({ constructive: "would_buy", cautious: "would_hold", opposed: "would_pass", out_of_scope: "not_in_my_circle" })[frozen.stance],
    voice: {
      would_i_act: "I would follow only the frozen " + frozen.stance + " result for QUICK_MASTER_SENTINEL_" + master + ".",
      what_i_see: "I see the bounded quick evidence and its explicit limits.",
      how_my_method_reads_it: "I apply my declared method sequence without changing the frozen result.",
      where_i_disagree: "I disagree with adding an unsupported fact to this quick record.",
      what_changes_my_mind: "I would change my reading only when new primary evidence satisfies my method."
    },
    key_findings: ["bounded quick finding"], disagreements: ["bounded quick disagreement"],
    what_would_change_my_mind: ["new primary evidence"], source_ids: ["market_data:S1"], confidence: "medium"
  };
} else if (role === "portfolio_manager") {
  packet = ${JSON.stringify(wrongLanguagePmOnce)} && !parseRepair
    ? {
      verdict: "条件性持有", rating: "Hold", winner: "balanced",
      summary: "组合经理错误地使用中文完成了本轮快速综合。", long_thesis: ["经营执行仍有积极证据"], short_thesis: ["估值和稀释风险仍需核验"],
      valuation_range: "估值区间必须依赖已冻结证据。", catalysts: ["下一份正式文件"], risks: ["执行风险"],
      position: "仅限小仓位", invalidation: ["关键里程碑未完成"], source_ids: ["market_data:S1"],
      confidence: "medium", report_markdown: "# 快速委员会\\n\\n本段故意使用错误语言，以验证一次有界无搜索修复。"
    }
    : {
      verdict: "Bounded quick Hold pending the next primary filing.", rating: "Hold", winner: "balanced",
      summary: "One-round quick synthesis.", long_thesis: ["operating execution"], short_thesis: ["valuation and dilution"],
      valuation_range: "Conditional range; no unsupported point target.", catalysts: ["next filing"], risks: ["execution"],
      position: "small only", invalidation: ["missed milestones"],
      source_ids: ${JSON.stringify(QUICK_TASKS.filter((task) => task !== failedTask).map((task) => `${task}:S1`))},
      confidence: "medium", report_markdown: ${JSON.stringify(reportBody(failedTask))}
    };
} else {
  packet = {
    verdict: role + " quick case", rating: "Hold", winner: "unknown", summary: role + " one-round statement",
    long_thesis: ["operating case"], short_thesis: ["risk case"], valuation_range: "conditional", catalysts: [], risks: ["risk"],
    position: "small", invalidation: ["new filing"], source_ids: ["market_data:S1"], confidence: "medium",
    questions: [], questions_answered: [], report_markdown: ""
  };
}
writeFileSync(output, JSON.stringify(packet));
`);
  if (process.platform !== "win32") {
    chmodSync(driver, 0o755);
    return { driver, log };
  }
  const wrapper = join(dataDir, "fake-quick-codex.cmd");
  writeFileSync(wrapper, `@"${process.execPath}" "${driver}" %*\r\n`);
  return { driver: wrapper, log };
}

test("quick council is mode-bound, news-inclusive, parallel and writes a quick_v1 handoff", async () => {
  const TOTAL_TIMEOUT_MS = 30_000;
  assert.equal(observerBudget(TOTAL_TIMEOUT_MS), 45_000);
  const dataDir = makeDataDir();
  const fake = fakeCodex(dataDir);
  const server = startServer({ dataDir, env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.driver } });
  try {
    await server.request("initialize", {});
    const prompt = "Give me the bounded master, analyst and recent industry-news read.";
    const openedResponse = await server.callTool("begin_council_selection", {
      symbol: "RKLB", as_of: "2026-07-28", language: "English", host: "test", prompt, council_mode: "quick",
    });
    const opened = structured(openedResponse);
    assert.equal(opened.council_mode, "quick");
    assert.equal(opened.maximum, 4);
    assert.deepEqual(opened.actions, ["explicit_selection"]);
    assert.match(openedResponse.result.content[0].text, new RegExp(`${CANONICAL_MASTER_COUNT} in catalog; choose up to 4`));
    assert.match(openedResponse.result.content[0].text, /Selecting all is not supported/);

    const tooMany = await server.callTool("confirm_master_selection", {
      selection_id: opened.selection_id,
      catalog_hash: opened.catalog_hash,
      display_ack: true,
      selected_master_ids: opened.masters.slice(0, 5).map((master) => master.id),
    });
    assert.equal(tooMany.error?.data?.reason, "QUICK_MASTER_LIMIT_EXCEEDED");

    const selected = opened.masters.slice(0, 4).map((master) => master.id);
    const confirmed = structured(await server.callTool("confirm_master_selection", {
      selection_id: opened.selection_id,
      catalog_hash: opened.catalog_hash,
      display_ack: true,
      selected_master_ids: selected,
    }));
    assert.equal(confirmed.council_mode, "quick");

    const runId = `QUICK-ANALYSIS-${process.pid}`;
    const response = await server.callTool("analyze_symbol", {
      symbol: "RKLB", as_of: "2026-07-28", run_id: runId, language: "English", prompt,
      council_mode: "quick", total_timeout_ms: TOTAL_TIMEOUT_MS,
      timeout_ms: 10_000, synthesis_timeout_ms: 10_000,
      wait_for_completion: true,
      grounding: { facts_unavailable: true, unavailable: ["fixture"] },
      selection_receipt: confirmed.selection_receipt,
    }, { timeoutMs: observerBudget(TOTAL_TIMEOUT_MS) });
    const result = structured(response);
    assert.equal(result.run.council_mode, "quick");
    assert.deepEqual(result.run.tasks, QUICK_TASKS);
    assert.equal(result.run.status, "complete", JSON.stringify({
      task_status: result.run.task_status,
      master_status: result.run.master_status,
      agent_status: result.run.agent_status,
    }, null, 2));
    assert.equal(result.report_quality.status, "passed", result.report_quality.missing.join("; "));
    assert.equal(result.report_quality.contract_id, "quick_v1");
    assert.equal(result.report_quality.full_council_equivalent, false);
    assert.equal(result.run.master_opinions.length, 4);
    for (const id of selected) assert.match(result.user_response_markdown, new RegExp(id));
    for (const task of QUICK_TASKS) assert.match(result.user_response_markdown, new RegExp(task));
    assert.match(result.user_response_markdown, /Recent Company and Industry News/);
    assert.match(result.user_response_markdown, /not quotes from the named people/);
    assert.doesNotMatch(result.user_response_markdown, /UNDATED_SENTINEL|STALE_SENTINEL|FUTURE_SENTINEL/);
    assert.match(result.user_response_markdown, /Recent-news gate excluded 3: undated=1, after_as_of=1, older_than_120d=1/);

    const events = readFileSync(join(dataDir, "runs", runId, "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(validateHeadlessTrace(events, { mode: "quick" }), []);
    assert.equal(events.filter((event) => event.type === "evidence_complete").length, 1);
    assert.equal(events.some((event) => event.type === "evidence_degraded"), false);
    assert.deepEqual(events.filter((event) => event.type === "debate_round").map((event) => event.round), [1]);
    assert.deepEqual(events.filter((event) => event.type === "agent_round_completed")
      .map((event) => `${event.role}:${event.round}`).sort(), ["bear_researcher:1", "bull_researcher:1"]);
    assert.equal(events.find((event) => event.type === "debate_qna_gate")?.status, "not_run");

    const launches = readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const evidenceStarts = launches.filter((item) => QUICK_TASKS.includes(item.role));
    assert.equal(evidenceStarts.length, 4);
    assert.ok(Math.max(...evidenceStarts.map((item) => item.at)) - Math.min(...evidenceStarts.map((item) => item.at)) < 1_000);
    const bull = launches.find((item) => item.role === "bull_researcher");
    const bear = launches.find((item) => item.role === "bear_researcher");
    const manager = launches.find((item) => item.role === "portfolio_manager");
    assert.ok(bull && bear && manager);
    assert.ok(Math.abs(bull.at - bear.at) < 1_000, "quick bull and bear must launch in parallel");
    assert.ok(manager.at > Math.max(bull.at, bear.at), "PM must start after both quick sides settle");
    assert.ok(manager.prompt_chars < 80_000, `quick PM prompt was ${manager.prompt_chars} chars`);

    const status = JSON.parse(readFileSync(join(dataDir, "runs", runId, "status.json"), "utf8"));
    assert.equal(status.council_mode, "quick");
    assert.equal(status.report_contract, "quick_v1");
    assert.equal(status.full_council_equivalent, false);
    assert.equal(status.debate_format, "single_round_parallel");
    assert.ok(status.deadline_at);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

test("quick PM repairs one wrong-language JSON response with the shared bounded no-search path", async () => {
  const TOTAL_TIMEOUT_MS = 30_000;
  assert.equal(observerBudget(TOTAL_TIMEOUT_MS), 45_000);
  const dataDir = makeDataDir();
  const fake = fakeCodex(dataDir, { wrongLanguagePmOnce: true });
  const server = startServer({ dataDir, env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.driver } });
  try {
    await server.request("initialize", {});
    const prompt = "Run a bounded quick council and keep every reader-facing field in English.";
    const opened = structured(await server.callTool("begin_council_selection", {
      symbol: "RKLB", language: "English", prompt, council_mode: "quick",
    }));
    const confirmed = structured(await server.callTool("confirm_master_selection", {
      selection_id: opened.selection_id, catalog_hash: opened.catalog_hash, display_ack: true,
      selected_master_ids: ["master_buffett"],
    }));
    const runId = `QUICK-PM-LANGUAGE-REPAIR-${process.pid}`;
    const result = structured(await server.callTool("analyze_symbol", {
      symbol: "RKLB", run_id: runId, language: "English", prompt,
      council_mode: "quick", total_timeout_ms: TOTAL_TIMEOUT_MS,
      timeout_ms: 10_000, synthesis_timeout_ms: 10_000,
      wait_for_completion: true,
      grounding: { facts_unavailable: true, unavailable: ["fixture"] },
      selection_receipt: confirmed.selection_receipt,
    }, { timeoutMs: observerBudget(TOTAL_TIMEOUT_MS) }));

    assert.equal(result.run.status, "complete", JSON.stringify(result.run.agent_status, null, 2));
    assert.equal(result.run.agent_status.portfolio_manager.status, "completed");
    assert.equal(result.decision.failure_kind, undefined);
    assert.match(result.decision.summary, /One-round quick synthesis/);

    const dir = join(dataDir, "runs", runId);
    const events = readFileSync(join(dir, "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const repair = events.filter((event) => event.type === "agent_parse_repair" && event.role === "portfolio_manager");
    assert.equal(repair.length, 1);
    assert.equal(repair[0].reason, "reader_language_mismatch");
    const launches = readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const managerLaunches = launches.filter((item) => item.role === "portfolio_manager");
    assert.equal(managerLaunches.length, 2);
    assert.deepEqual(managerLaunches.map((item) => item.parseRepair), [false, true]);
    assert.equal(managerLaunches[1].search, false);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

test("quick may finish its broad path after one evidence failure but terminal stays incomplete", async () => {
  const TOTAL_TIMEOUT_MS = 30_000;
  assert.equal(observerBudget(TOTAL_TIMEOUT_MS), 45_000);
  const dataDir = makeDataDir();
  const fake = fakeCodex(dataDir, { failedTask: "valuation_long_short" });
  const server = startServer({ dataDir, env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.driver } });
  try {
    await server.request("initialize", {});
    const prompt = "bounded degraded quick";
    const opened = structured(await server.callTool("begin_council_selection", {
      symbol: "RKLB", language: "English", prompt, council_mode: "quick",
    }));
    const confirmed = structured(await server.callTool("confirm_master_selection", {
      selection_id: opened.selection_id, catalog_hash: opened.catalog_hash, display_ack: true,
      selected_master_ids: ["master_buffett"],
    }));
    const runId = `QUICK-DEGRADED-${process.pid}`;
    const result = structured(await server.callTool("analyze_symbol", {
      symbol: "RKLB", run_id: runId, language: "English", prompt,
      council_mode: "quick", total_timeout_ms: TOTAL_TIMEOUT_MS,
      timeout_ms: 10_000, synthesis_timeout_ms: 10_000,
      wait_for_completion: true,
      grounding: { facts_unavailable: true, unavailable: ["fixture"] },
      selection_receipt: confirmed.selection_receipt,
    }, { timeoutMs: observerBudget(TOTAL_TIMEOUT_MS) }));

    assert.equal(result.run.status, "incomplete");
    assert.equal(result.run.terminal, "incomplete");
    assert.ok(result.run.missing.some((item) => item.stage === "evidence"
      && item.id === "valuation_long_short" && item.reason === "exit code 17"));
    assert.equal(result.run.task_status.valuation_long_short.status, "degraded");
    assert.equal(result.run.task_status.valuation_long_short.error, "exit code 17");
    assert.equal(result.report_quality.status, "passed", result.report_quality.missing.join("; "));
    assert.equal(result.report_quality.evidence_coverage, "degraded");
    assert.deepEqual(result.report_quality.degraded_evidence, ["valuation_long_short"]);
    assert.match(result.final_report_markdown, /INCOMPLETE QUICK RUN/);
    assert.match(result.final_report_markdown, /valuation_long_short: degraded; exit code 17/);
    assert.match(result.user_response_markdown, /- Status: incomplete/);

    const events = readFileSync(join(dataDir, "runs", runId, "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(validateHeadlessTrace(events, { mode: "quick" }), []);
    const evidence = events.find((event) => event.type === "evidence_degraded");
    assert.equal(evidence?.barrier_satisfied, true);
    assert.equal(evidence?.successful, 3);
    assert.equal(evidence?.degraded, 1);
    assert.equal(events.some((event) => event.type === "evidence_complete"), false);
    assert.equal(events.some((event) => event.type === "incomplete"), true);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

test("quick PM transport failure writes standard artifacts and no synthetic Hold", async () => {
  const TOTAL_TIMEOUT_MS = 30_000;
  assert.equal(observerBudget(TOTAL_TIMEOUT_MS), 45_000);
  const dataDir = makeDataDir();
  const fake = fakeCodex(dataDir, { failedRole: "portfolio_manager" });
  const server = startServer({ dataDir, env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.driver } });
  try {
    await server.request("initialize", {});
    const prompt = "bounded PM failure";
    const opened = structured(await server.callTool("begin_council_selection", {
      symbol: "RKLB", language: "English", prompt, council_mode: "quick",
    }));
    const confirmed = structured(await server.callTool("confirm_master_selection", {
      selection_id: opened.selection_id, catalog_hash: opened.catalog_hash, display_ack: true,
      selected_master_ids: ["master_buffett"],
    }));
    const runId = `QUICK-PM-FAILURE-${process.pid}`;
    const result = structured(await server.callTool("analyze_symbol", {
      symbol: "RKLB", run_id: runId, language: "English", prompt,
      council_mode: "quick", total_timeout_ms: TOTAL_TIMEOUT_MS,
      timeout_ms: 10_000, synthesis_timeout_ms: 10_000,
      wait_for_completion: true,
      grounding: { facts_unavailable: true, unavailable: ["fixture"] },
      selection_receipt: confirmed.selection_receipt,
    }, { timeoutMs: observerBudget(TOTAL_TIMEOUT_MS) }));
    const dir = join(dataDir, "runs", runId);
    assert.equal(result.run.status, "incomplete");
    assert.equal(result.run.agent_status.portfolio_manager.status, "failed");
    assert.equal(result.run.agent_status.portfolio_manager.absence_reason, "failed");
    assert.equal(result.decision.decision_available, false);
    assert.equal(result.decision.rating, null);
    assert.equal(result.decision.pm_absence_reason, "failed");
    assert.match(result.user_response_markdown, /Rating: unavailable/);
    assert.match(result.user_response_markdown, /NEEDS_MANAGER_REVIEW/);
    const events = readFileSync(join(dir, "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(validateHeadlessTrace(events, { mode: "quick" }), []);
    for (const name of ["decision.json", "manager_synthesis.json", "final_report.md", "user_response.md", "report_quality.json", "artifact_index.md"]) {
      assert.equal(readFileSync(join(dir, name), "utf8").length > 0, true, name);
    }
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

test("a quick selection receipt cannot be consumed as full", async () => {
  const dataDir = makeDataDir();
  const server = startServer({ dataDir });
  try {
    await server.request("initialize", {});
    const opened = structured(await server.callTool("begin_council_selection", {
      symbol: "AAPL", language: "English", prompt: "mode binding", council_mode: "quick",
    }));
    const confirmed = structured(await server.callTool("confirm_master_selection", {
      selection_id: opened.selection_id, catalog_hash: opened.catalog_hash, display_ack: true,
      selected_master_ids: ["master_buffett"],
    }));
    const mismatched = await server.callTool("analyze_symbol", {
      symbol: "AAPL", language: "English", prompt: "mode binding", council_mode: "full",
      run_id: `QUICK-MODE-MISMATCH-${process.pid}`, dry_run: true,
      selection_receipt: confirmed.selection_receipt,
    });
    assert.equal(mismatched.error?.data?.reason, "MASTER_SELECTION_MODE_MISMATCH");
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

test("quick rejects task overrides, visible orchestration and budgets above ten minutes before receipt consumption", async () => {
  const dataDir = makeDataDir();
  const server = startServer({ dataDir });
  try {
    await server.request("initialize", {});
    const openAndConfirm = async () => {
      const opened = structured(await server.callTool("begin_council_selection", {
        symbol: "AAPL", language: "English", prompt: "bounded quick", council_mode: "quick",
      }));
      return structured(await server.callTool("confirm_master_selection", {
        selection_id: opened.selection_id, catalog_hash: opened.catalog_hash, display_ack: true,
        selected_master_ids: ["master_buffett"],
      }));
    };

    const override = await openAndConfirm();
    const overrideResponse = await server.callTool("analyze_symbol", {
      symbol: "AAPL", language: "English", prompt: "bounded quick", council_mode: "quick",
      tasks: ["market_data"], dry_run: true, selection_receipt: override.selection_receipt,
    });
    assert.equal(overrideResponse.error?.data?.reason, "QUICK_TASK_OVERRIDE_FORBIDDEN");

    const visible = await openAndConfirm();
    const visibleResponse = await server.callTool("plan_visible_run", {
      symbol: "AAPL", language: "English", prompt: "bounded quick", council_mode: "quick",
      selection_receipt: visible.selection_receipt,
    });
    assert.equal(visibleResponse.error?.data?.reason, "QUICK_REQUIRES_HEADLESS_ORCHESTRATOR");

    const overBudget = await openAndConfirm();
    const budgetResponse = await server.callTool("analyze_symbol", {
      symbol: "AAPL", language: "English", prompt: "bounded quick", council_mode: "quick",
      total_timeout_ms: 600_001, dry_run: true, selection_receipt: overBudget.selection_receipt,
    });
    assert.equal(budgetResponse.error?.data?.reason, "QUICK_TOTAL_TIMEOUT_EXCEEDS_MAX");

    const noSynthesis = await openAndConfirm();
    const synthesisResponse = await server.callTool("analyze_symbol", {
      symbol: "AAPL", language: "English", prompt: "bounded quick", council_mode: "quick",
      synthesis: false, dry_run: true, selection_receipt: noSynthesis.selection_receipt,
    });
    assert.equal(synthesisResponse.error?.data?.reason, "QUICK_SYNTHESIS_REQUIRED");
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});
