import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_TASKS } from "../../mcp/lib/constants.mjs";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { confirmMasterSelection, startServer, structured } from "../helpers/rpc-client.mjs";
import { validateHeadlessTrace } from "../../scripts/lib/headless-trace-contract.mjs";
import { compactEvidence } from "../../mcp/lib/packets.mjs";

const SELECTED_MASTERS = [
  "master_buffett",
  "master_druckenmiller",
  "master_damodaran",
  "master_taleb",
];

const QQQ_INDEX_INSTRUMENT = Object.freeze({
  asset_type: "etf",
  research_model: "fund_lookthrough",
  classification_source: "full_analysis_fixture",
});

function fullReportBody() {
  const work = DEFAULT_TASKS
    .map((task) => `- ${task}: ANALYST_SENTINEL_${task}; completed the sourced fixture packet and preserved its explicit confidence and gaps.`)
    .join("\n");
  return `# QQQ Full Council Fixture

## Conclusion
Hold with medium confidence while the evidence-supported range and the next primary filing remain the controlling decision points.

## Analyst Work Log
${work}

## Bull/Bear Debate Record
Three rounds completed with two parallel sides per round, an inter-round dependency barrier, exactly three questions per side in round two, and exact question-bound answers in round three.

## Master Bench
The portfolio manager received the frozen method-seat results. This generic text must be replaced by the system-owned recorded bench.

## Market Expectations and Implied Thresholds
The market-expectations seat recorded the operating thresholds that must be met and kept reported facts separate from implied expectations.

## Analyst Rating and Target-Price Revisions
The forward and valuation packets distinguish sourced analyst changes from unsupported target-price inference.

## Earnings Call Management Signals
The earnings seat records management commitments, dated evidence, and unresolved questions without fabricating a transcript.

## Quant Factor / Technical Risk View
The quant seat records trend, factor exposure, liquidity and unavailable fields with explicit confidence.

## Recent Company and Industry News
The news seat records dated company and industry developments up to the as-of boundary and excludes future information.

## Short Interest / Borrow / Options Information
The quant packet records the available short-interest and market-risk evidence; unavailable fields remain explicit gaps.

## Strategic Transaction or Banking Event
The event-analysis seat records transaction, capital-structure and financing evidence and states when no material event is verified.

## Valuation Range
The valuation range is conditional on growth, margins, financing and dilution, not an unsupported point target.

## Price Levels
Above the evidence range, do not chase; inside the range, wait for confirmation; below the range, reassess only while the operating thesis and source evidence remain intact.

## Key Catalysts
The next primary filing, confirmed operating milestones and any verified financing update are the decision-relevant catalysts.

## Major Risks
Execution delays, financing needs, dilution, regime shifts and missing primary facts can invalidate the conclusion.

## Position Recommendation
Keep sizing bounded until the next primary filing resolves the highest-impact unknowns and confirms the operating thresholds.

## Short-Term 1-4 Week View
Treat price action as tactical and do not override the evidence boundary with momentum alone.

## Medium-Term 3-6 Month View
Require measurable operating progress and updated primary-source evidence before increasing exposure.

## Long-Term 12 Month View
The long-term view remains conditional on durable economics, financing discipline and the stated invalidation conditions.

## Data Gaps / Unavailable Data
The fixture has no additional evidence gap; a production run must list every missing or failed seat rather than invent a substitute.

## Invalidation Conditions
Invalidate the thesis if verified operating milestones fail, financing materially worsens, or cited primary evidence is contradicted.

## Confidence
medium and conditional on the cited full-council evidence.

## Source Table
- market_data:S1 — fixture quote and market evidence — 2026-07-28 — https://example.com/market
- earnings_deep_dive:S1 — fixture earnings evidence — 2026-07-28 — https://example.com/earnings
`;
}

function fakeFullCodex(dataDir, {
  evidenceDelayMs = 45,
  malformedTask = "forward_expectations",
  malformedMasterModes = {},
  pmFailureMode = null,
  pmContractFailureMode = null,
  debateQnaFailureMode = null,
} = {}) {
  const driver = join(dataDir, "fake-full-codex.mjs");
  const log = join(dataDir, "full-worker-log.jsonl");
  const malformedState = join(dataDir, "malformed-once.state");
  writeFileSync(driver, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const asOf = /as[-_ ]of(?: date)?\\s*:\\s*(\\d{4}-\\d{2}-\\d{2})/iu.exec(prompt)?.[1] || "2026-07-28";
const regularTask = (${JSON.stringify(DEFAULT_TASKS)}).find((id) => prompt.includes("Task:" + id) || prompt.includes("Task: " + id));
const repairTask = /Target task:\\s*([a-z_]+)/u.exec(prompt)?.[1] || null;
const task = regularTask || repairTask;
const master = /dedicated, isolated method-seat explanation worker[^\\n]*\\((master_[a-z0-9_]+)\\)/iu.exec(prompt)?.[1]
  || /Master ID:\\s*(master_[a-z0-9_]+)/u.exec(prompt)?.[1]
  || null;
const role = /You are the portfolio_manager|Role:[ ]*portfolio_manager/i.test(prompt) ? "portfolio_manager"
  : /You are the bull_researcher|Role:[ ]*bull_researcher/i.test(prompt) ? "bull_researcher"
  : /You are the bear_researcher|Role:[ ]*bear_researcher/i.test(prompt) ? "bear_researcher"
  : master || task || "unknown";
const roundMatch = /Debate round:\\s*(\\d+)|round:\\s*(\\d+)/iu.exec(prompt);
const round = Number(roundMatch?.[1] || roundMatch?.[2] || 0);
const parseRepair = prompt.includes("PARSE-ONLY TRANSPORT REPAIR");
appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  role, task, master, round, parseRepair, search: args.includes("--search"), at: Date.now(), pid: process.pid,
  prompt_chars: prompt.length,
  exactMethodVoiceContract: prompt.includes("Allowed investment-evidence source_ids JSON:")
    && prompt.includes("what_i_see") && prompt.includes("how_my_method_reads_it")
    && prompt.includes("would_i_act") && prompt.includes("what_changes_my_mind")
    && prompt.includes("where_i_disagree")
    && prompt.includes("MUST be exactly one of: high | medium | low"),
  structuredPmDecision: prompt.includes("HEADLESS_STRUCTURED_PM_DECISION_V1"),
  omitsPmReport: prompt.includes("Omit report_markdown completely")
    || (prompt.includes("Do not return") && prompt.includes("report_markdown")),
}) + "\\n");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lineJson = (prefix) => {
  const line = prompt.split("\\n").find((item) => item.startsWith(prefix));
  return line ? JSON.parse(line.slice(prefix.length)) : [];
};

let packet;
if (task) {
  if (!parseRepair && task === ${JSON.stringify(malformedTask)} && !existsSync(${JSON.stringify(malformedState)})) {
    writeFileSync(${JSON.stringify(malformedState)}, "attempted\\n");
    await sleep(${Number(evidenceDelayMs)});
    writeFileSync(output, "MALFORMED_EVIDENCE_SENTINEL");
    process.exit(0);
  }
  await sleep(${Number(evidenceDelayMs)});
  packet = {
    summary: "ANALYST_SENTINEL_" + task + " with dated evidence and explicit limits.",
    claims: [{ claim: task + " material fixture claim", claim_type: "event_or_observation", evidence: "bounded fixture evidence", confidence: "medium", source_ids: ["S1"] }],
    metrics: task === "market_data" ? { price: 512.34, currency: "USD" } : { fixture: 1 },
    sources: [{ id: "S1", title: task + " fixture source", url: "https://example.com/" + task, published_at: "2026-07-28", retrieved_at: "2026-07-28" }],
    open_questions: [], confidence: "medium", information_richness: "B",
    ...(task === "news_industry_management" ? {
      official_source_coverage: {
        status: "complete",
        regulator: {
          status: "complete", entry_url: "https://example.com/regulator-feed", checked_through: asOf,
          latest_dated_item: { title: task + " fixture source", published_at: "2026-07-28", url: "https://example.com/" + task, source_id: "S1", record_id: "fixture-filing" },
          dated_items_checked: [{ title: task + " fixture source", published_at: "2026-07-28", url: "https://example.com/" + task, source_id: "S1", record_id: "fixture-filing" }],
          gap: null
        },
        issuer: {
          status: "complete", entry_url: "https://example.com/issuer-news", checked_through: asOf,
          latest_dated_item: { title: task + " fixture source", published_at: "2026-07-28", url: "https://example.com/" + task, source_id: "S1" },
          dated_items_checked: [{ title: task + " fixture source", published_at: "2026-07-28", url: "https://example.com/" + task, source_id: "S1" }],
          gap: null
        }
      }
    } : {})
  };
} else if (master) {
  await sleep(45);
  const frozenLine = prompt.split("\\n").find((item) => item.startsWith("Frozen method result JSON: "));
  const frozen = frozenLine
    ? JSON.parse(frozenLine.slice("Frozen method result JSON: ".length))
    : { stance: /required acknowledged stance:\\s*(constructive|cautious|opposed|out_of_scope)/u.exec(prompt)?.[1] || "out_of_scope" };
  packet = {
    master,
    acknowledged_stance: frozen.stance,
    voice_mode: "first_person_public_method_simulation_v1",
    disclosure_ack: "alphacouncil.first_person_public_method_simulation.v1",
    position_intent: ({ constructive: "would_buy", cautious: "would_hold", opposed: "would_pass", out_of_scope: "not_in_my_circle" })[frozen.stance],
    voice: {
      would_i_act: "I would follow only the frozen " + frozen.stance + " result for MASTER_SENTINEL_" + master + ".",
      what_i_see: "I see only the bounded fixture evidence supplied to this method.",
      how_my_method_reads_it: "I apply my declared method sequence without changing the frozen stance.",
      where_i_disagree: "I disagree with any reading that adds facts outside this frozen record.",
      what_changes_my_mind: "I would change my reading only when the declared method-critical evidence changes."
    },
    key_findings: ["MASTER_FINDING_" + master],
    disagreements: ["MASTER_DISAGREEMENT_" + master],
    what_would_change_my_mind: ["MASTER_CHANGE_" + master],
    source_ids: ["market_data:S1"],
    confidence: "medium"
  };
  const malformedMode = ${JSON.stringify(malformedMasterModes)}[master];
  if (!parseRepair && malformedMode === "missing_voice") delete packet.voice;
  if (!parseRepair && malformedMode === "invalid_confidence") packet.confidence = "very_high";
  if (!parseRepair && malformedMode === "structured_prose") {
    packet.key_findings = [{ text: "MASTER_STRUCTURED_FINDING_" + master, source_ids: ["market_data:S1"] }];
    packet.disagreements = [{ rank: 1, text: "MASTER_STRUCTURED_DISAGREEMENT_" + master }];
    packet.what_would_change_my_mind = [{ signal: "MASTER_STRUCTURED_CHANGE_" + master, threshold: 1 }];
  }
} else if (role === "portfolio_manager") {
  await sleep(45);
  if (${JSON.stringify(pmFailureMode)} === "both" || (${JSON.stringify(pmFailureMode)} === "first" && !parseRepair)) {
    writeFileSync(output, 'PM_PRIVATE_RAW_SENTINEL_{"rating":"Buy","report_markdown":"truncated');
    process.exit(0);
  }
  packet = {
    verdict: "QQQ fixture Hold after the complete bounded council.", rating: "Hold", winner: "balanced",
    summary: "All required fixture stages completed.", long_thesis: ["operating evidence"], short_thesis: ["valuation risk"],
    valuation_range: "Conditional valuation range tied to evidence and dilution.", catalysts: ["next filing"], risks: ["execution"],
    position: "bounded position only", invalidation: ["verified milestones fail"],
    source_ids: ["market_data:S1", "earnings_deep_dive:S1"], confidence: "medium",
    price_levels: [
      { label: "Do not touch", range: "above the supported range", lower_bound: 200, upper_bound: null, currency: "USD", meaning: "poor risk reward", action: "do not initiate", basis: "conditional valuation", source_ids: ["market_data:S1"] },
      { label: "Worth starting", range: "inside the supported range", lower_bound: 100, upper_bound: 200, currency: "USD", meaning: "bounded upside and downside", action: "start small", basis: "conditional valuation", source_ids: ["market_data:S1"] },
      { label: "Materially undervalued", range: "below the supported range", lower_bound: null, upper_bound: 100, currency: "USD", meaning: "margin of safety", action: "add only if thesis holds", basis: "conditional valuation", source_ids: ["earnings_deep_dive:S1"] }
    ],
    horizon_views: { short_term: "Wait for the next filing.", medium_term: "Require operating progress.", long_term: "Require durable economics." },
    data_gaps: ["No critical data gaps were found in the completed fixture packets."],
    verification_findings_ack: []
  };
  if (${JSON.stringify(pmContractFailureMode)} === "missing_price_levels") delete packet.price_levels;
  if (${JSON.stringify(pmContractFailureMode)} === "invalid_horizon_views") packet.horizon_views.short_term = "  ";
  if (${JSON.stringify(pmContractFailureMode)} === "empty_data_gaps") packet.data_gaps = [];
} else {
  await sleep(55);
  const ownQuestions = [role + "_Q1", role + "_Q2", role + "_Q3"];
  const preserved = round === 3 ? lineJson("Your round 2 questions to preserve JSON: ") : (round === 2 ? ownQuestions : []);
  const opponent = round === 3 ? lineJson("Questions you must answer JSON: ") : [];
  packet = {
    verdict: role + " round " + round + " fixture case", rating: "Hold", winner: "unknown",
    summary: role + " completed round " + round, long_thesis: ["operating case"], short_thesis: ["risk case"],
    valuation_range: "conditional", catalysts: ["next filing"], risks: ["execution"], position: "bounded",
    invalidation: ["new primary evidence"], source_ids: ["market_data:S1"], confidence: "medium",
    questions: preserved,
    questions_answered: opponent.map((question, index) => ({ question, answer: role + "_A" + (index + 1) + " exact fixture answer" })),
    report_markdown: ""
  };
  const qnaFailureMode = ${JSON.stringify(debateQnaFailureMode)};
  if ((qnaFailureMode === "round2_and_round3_once" && !parseRepair)
    || (qnaFailureMode === "round3_always" && round === 3)) {
    if (round === 2) packet.questions = ownQuestions.slice(0, 2);
    if (round === 3) {
      packet.questions = [...preserved].reverse();
      packet.questions_answered = [...opponent].reverse().map((question, index) => ({
        question,
        answer: role + "_DRIFTED_A" + (index + 1),
      }));
    }
  }
}
writeFileSync(output, JSON.stringify(packet));
`);
  if (process.platform !== "win32") {
    chmodSync(driver, 0o755);
    return { driver, log };
  }
  const wrapper = join(dataDir, "fake-full-codex.cmd");
  writeFileSync(wrapper, `@"${process.execPath}" "${driver}" %*\r\n`);
  return { driver: wrapper, log };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonl(path) {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("full council proves dedicated master workers, parallel barriers, exact Q&A, display coverage and no-search parse repair", async () => {
  const dataDir = makeDataDir();
  const fake = fakeFullCodex(dataDir, {
    malformedMasterModes: {
      master_buffett: "missing_voice",
      master_druckenmiller: "invalid_confidence",
      master_taleb: "structured_prose",
    },
  });
  // Every seat this fixture selects abstains on an ETF, and an abstaining seat no longer spends
  // a voice worker. Opt that back in here so the worker-path assertions below keep exercising a
  // real dedicated worker; the default skip has its own test.
  const server = startServer({
    dataDir,
    env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.driver },
  });
  try {
    await server.request("initialize", {});
    const prompt = "Run the complete QQQ full council fixture with every required stage.";
    const confirmed = await confirmMasterSelection(server, {
      symbol: "QQQ", language: "English", prompt, selected_master_ids: SELECTED_MASTERS,
    });
    const runId = `FULL-ANALYSIS-${process.pid}`;
    const result = structured(await server.callTool("analyze_symbol", {
      symbol: "QQQ", run_id: runId, as_of: "2026-07-28", language: "English", prompt,
      // Keep the fixture-level worker cap comfortably above loaded Windows process-startup
      // latency. The separate lowered-budget test below proves fail-closed settlement; this
      // success-path test is responsible for the 30 s global contract and full topology.
      council_mode: "full", total_timeout_ms: 30_000, timeout_ms: 10_000, synthesis_timeout_ms: 10_000,
      max_concurrency: 1,
      wait_for_completion: true, selection_receipt: confirmed.selection_receipt,
      grounding: {
        instrument: QQQ_INDEX_INSTRUMENT,
        quote: {
          price: 512.34, currency: "USD", quote_time: "2026-07-28T20:00:00Z", exchange: "NASDAQ",
          note: "fixture close", source_url: "https://example.com/qqq-quote",
        },
        facts_unavailable: true, unavailable: ["typed facts intentionally omitted by fixture"],
      },
    }, { timeoutMs: 45_000 }));

    const dir = join(dataDir, "runs", runId);
    assert.equal(result.run.status, "complete", JSON.stringify({
      task_status: result.run.task_status,
      master_status: result.run.master_status,
      agent_status: result.run.agent_status,
      quality: result.report_quality,
    }, null, 2));
    assert.equal(result.report_quality.status, "passed", result.report_quality.missing.join("; "));
    assert.equal(result.report_quality.contract_id, "full_v2");
    assert.deepEqual(result.run.tasks, DEFAULT_TASKS);
    assert.equal(result.run.master_opinions.length, SELECTED_MASTERS.length);

    const finalReport = readFileSync(join(dir, "final_report.md"), "utf8");
    const userResponse = readFileSync(join(dir, "user_response.md"), "utf8");
    const allAgents = readFileSync(join(dir, "all_agents.md"), "utf8");
    const artifactIndex = readFileSync(join(dir, "artifact_index.md"), "utf8");
    assert.match(finalReport, /512\.34 USD/);
    assert.match(userResponse, /512\.34 USD/);
    assert.equal((finalReport.match(/alphacouncil:recorded-price-snapshot:v1:begin/g) || []).length, 1);
    assert.match(userResponse, /Recent Company and Industry News/);
    assert.match(userResponse, /2026-07-28 — news_industry_management fixture source/);
    for (const task of DEFAULT_TASKS) {
      assert.match(userResponse, new RegExp("`" + task + "`[\\s\\S]*ANALYST_SENTINEL_" + task));
      assert.match(allAgents, new RegExp(`ANALYST_SENTINEL_${task}`));
      assert.match(artifactIndex, new RegExp(`${task}: .*${task}\\.md`));
      assert.equal(existsSync(join(dir, `${task}.md`)), true, task);
    }
    for (const id of SELECTED_MASTERS) {
      const sentinel = `MASTER_SENTINEL_${id}`;
      assert.match(readFileSync(join(dir, `${id}.md`), "utf8"), new RegExp(sentinel));
      assert.match(finalReport, new RegExp(sentinel));
      assert.match(userResponse, new RegExp(sentinel));
      assert.match(allAgents, new RegExp(sentinel));
      assert.match(artifactIndex, new RegExp(`${id} .*${id}\\.md`));
      assert.equal(result.run.master_status[id].status, "completed");
      assert.equal(result.run.master_status[id].worker_kind, "dedicated_method_worker");
      assert.equal(result.run.master_opinions.find((item) => item.master === id)?.dedicated_worker?.status, "completed");
      assert.equal(result.run.master_opinions.find((item) => item.master === id)?.statement_origin, "dedicated_method_voice_worker");
    }

    const firstPacket = result.run.packets[0];
    const expandedPacket = {
      ...firstPacket,
      claims: [
        ...firstPacket.claims,
        ...Array.from({ length: 9 }, (_, index) => ({
          claim: `omitted claim ${index}`,
          evidence: "available only through the original packet artifact",
          confidence: "low",
          source_ids: [firstPacket.sources[0].id],
        })),
      ],
      sources: [
        ...firstPacket.sources,
        ...Array.from({ length: 14 }, (_, index) => ({
          id: `${firstPacket.task}:EXTRA-${index}`,
          title: `extra source ${index}`,
          url: `https://example.com/extra-${index}`,
          published_at: "2026-07-28",
          retrieved_at: "2026-07-28",
        })),
      ],
    };
    const boundedPacket = compactEvidence({
      ...result.run,
      packets: [expandedPacket, ...result.run.packets.slice(1)],
    }).packets[0];
    assert.equal(boundedPacket.omitted_claim_count, 2);
    assert.equal(boundedPacket.omitted_source_count, 3);
    for (const [kind, extension] of [["json", "json"], ["markdown", "md"]]) {
      const ref = boundedPacket.artifact_ref[kind];
      assert.equal(ref.path, join(dir, `${firstPacket.task}.${extension}`));
      assert.equal(ref.bytes, readFileSync(ref.path).byteLength);
      assert.match(ref.hash, /^sha256:[0-9a-f]{64}$/u);
    }
    assert.doesNotMatch(JSON.stringify(boundedPacket), /omitted claim 8/u, "omitted bodies must stay out of the prompt context");

    const launches = readJsonl(fake.log);
    const evidence = launches.filter((item) => DEFAULT_TASKS.includes(item.role) && !item.parseRepair);
    assert.equal(evidence.length, DEFAULT_TASKS.length);
    assert.ok(Math.max(...evidence.map((item) => item.at)) - Math.min(...evidence.map((item) => item.at)) < 1_000,
      "all eight evidence seats must start in one parallel wave");
    assert.ok(evidence.every((item) => item.search === true), "initial evidence collection keeps native search");
    const repairs = launches.filter((item) => item.parseRepair && item.task === "forward_expectations");
    assert.equal(repairs.length, 1, "malformed evidence gets one bounded parse-only retry");
    assert.equal(repairs[0].search, false, "parse-only repair must not browse or search");

    const masterLaunches = launches.filter((item) => SELECTED_MASTERS.includes(item.master) && !item.parseRepair);
    assert.equal(masterLaunches.length, SELECTED_MASTERS.length, "one voice worker per selected v3 master");
    assert.equal(new Set(masterLaunches.map((item) => item.master)).size, SELECTED_MASTERS.length);
    assert.equal(new Set(masterLaunches.map((item) => item.pid)).size, SELECTED_MASTERS.length,
      "each selected method seat must run in its own process");
    assert.ok(Math.max(...masterLaunches.map((item) => item.at)) - Math.min(...masterLaunches.map((item) => item.at)) < 1_000,
      "max_concurrency=1 must not serialize the contract-required method wave");
    assert.ok(masterLaunches.every((item) => item.search === false), "method explanation workers cannot add web facts");
    const masterRepairs = launches.filter((item) => SELECTED_MASTERS.includes(item.master) && item.parseRepair);
    assert.deepEqual(
      masterRepairs.map((item) => item.master).sort(),
      ["master_buffett", "master_druckenmiller"],
      "missing voice and invalid confidence each receive one bounded schema repair",
    );
    assert.ok(masterRepairs.every((item) => item.search === false), "method schema repair cannot browse");
    assert.ok(masterRepairs.every((item) => item.exactMethodVoiceContract),
      "repair repeats the exact five-field voice, confidence enum, and allowed-source contract");
    assert.deepEqual(
      result.run.master_opinions.find((item) => item.master === "master_taleb")?.key_findings,
      ['{"source_ids":["market_data:S1"],"text":"MASTER_STRUCTURED_FINDING_master_taleb"}'],
      "structured prose survives as deterministic canonical JSON without launching a repair worker",
    );

    const roundLaunches = (round) => launches.filter((item) =>
      ["bull_researcher", "bear_researcher"].includes(item.role) && item.round === round && !item.parseRepair);
    for (const round of [1, 2, 3]) {
      const pair = roundLaunches(round);
      assert.equal(pair.length, 2, `round ${round} must contain exactly two sides`);
      assert.ok(Math.abs(pair[0].at - pair[1].at) < 1_000, `round ${round} sides must launch in parallel`);
      assert.ok(pair.every((item) => item.search === false), `round ${round} must use frozen evidence only`);
    }
    assert.ok(Math.min(...roundLaunches(2).map((item) => item.at)) > Math.max(...roundLaunches(1).map((item) => item.at)),
      "round 2 must wait for both round-1 sides");
    assert.ok(Math.min(...roundLaunches(3).map((item) => item.at)) > Math.max(...roundLaunches(2).map((item) => item.at)),
      "round 3 must wait for both round-2 sides");
    const pm = launches.find((item) => item.role === "portfolio_manager" && !item.parseRepair);
    assert.ok(pm.at > Math.max(...roundLaunches(3).map((item) => item.at)), "PM must wait for both round-3 sides");
    assert.equal(pm.search, false);
    assert.equal(pm.structuredPmDecision, true, "full headless PM must use the compact decision contract");
    assert.equal(pm.omitsPmReport, true, "full headless PM must not JSON-escape the long report");

    const manager = readJson(join(dir, "manager_synthesis.json"));
    assert.equal(manager.rating, "Hold");
    assert.equal(manager.decision_available, true);
    assert.equal(manager.debate_rounds.length, 3);
    assert.deepEqual(manager.debate_rounds.map((round) => round.round), [1, 2, 3]);
    assert.ok(manager.debate_rounds.every((round) => round.bull && round.bear));
    assert.match(manager.report_markdown, /## Analyst Work Log/);
    assert.match(manager.report_markdown, /#### Round 3/);
    assert.match(manager.report_markdown, /## Resolved Seat-Weight Audit/);
    assert.match(manager.report_markdown, /\| Seat \| Stance \| Declared \| Verification \| Effective \| Share \| Why adjusted \|/);
    assert.match(manager.report_markdown, /\| master_buffett \|/);
    const upperPriceRow = manager.report_markdown.split("\n").find((line) => line.includes("| Do not touch |"));
    assert.ok(upperPriceRow?.includes("conditional valuation"));
    assert.ok(upperPriceRow?.includes("(sources: `market_data:S1`)"),
      "a supplied price-row basis must not hide its validated source IDs");
    assert.doesNotMatch(manager.raw_text, /report_markdown/u,
      "the worker decision stays small while the trusted renderer owns report_markdown");

    const bull = readJson(join(dir, "bull_researcher.json"));
    const bear = readJson(join(dir, "bear_researcher.json"));
    assert.equal(bull.debate_rounds[1].questions.length, 3);
    assert.equal(bear.debate_rounds[1].questions.length, 3);
    assert.deepEqual(bull.debate_rounds[2].questions, bull.debate_rounds[1].questions);
    assert.deepEqual(bear.debate_rounds[2].questions, bear.debate_rounds[1].questions);
    assert.deepEqual(bull.debate_rounds[2].questions_answered.map((item) => item.question), bear.debate_rounds[1].questions);
    assert.deepEqual(bear.debate_rounds[2].questions_answered.map((item) => item.question), bull.debate_rounds[1].questions);
    assert.deepEqual(manager.debate_rounds[1].bull.questions, bull.debate_rounds[1].questions);
    assert.deepEqual(manager.debate_rounds[2].bear.questions_answered, bear.debate_rounds[2].questions_answered);
    const events = readJsonl(join(dir, "events.jsonl"));
    assert.deepEqual(validateHeadlessTrace(events, { mode: "full" }), []);
    assert.equal(events.find((event) => event.type === "debate_qna_gate")?.status, "passed");
    assert.deepEqual(events.filter((event) => event.type === "debate_round").map((event) => event.round), [1, 2, 3]);

    const status = readJson(join(dir, "status.json"));
    assert.equal(status.debate_format, "three_round_cross_exam_parallel_per_round");
    assert.equal(status.master_worker_contract, "one_isolated_worker_per_selected_method_v1");
    assert.equal(status.deadline_enforced, true);
    assert.equal(status.time_budget_ms, 30_000);
    assert.equal(status.deadline_met, true);
    assert.ok(status.elapsed_ms < 30_000, `fixture elapsed ${status.elapsed_ms}ms`);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

async function runDebateQnaFixture(debateQnaFailureMode) {
  const dataDir = makeDataDir();
  const fake = fakeFullCodex(dataDir, { malformedTask: null, debateQnaFailureMode });
  const server = startServer({ dataDir, env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.driver } });
  await server.request("initialize", {});
  const prompt = `Exercise bounded exact-Q&A repair: ${debateQnaFailureMode}.`;
  const confirmed = await confirmMasterSelection(server, {
    symbol: "QQQ", language: "English", prompt, selected_master_ids: ["master_buffett"],
  });
  const runId = `FULL-QNA-${debateQnaFailureMode.toUpperCase()}-${process.pid}`;
  const result = structured(await server.callTool("analyze_symbol", {
    symbol: "QQQ", run_id: runId, as_of: "2026-07-28", language: "English", prompt,
    council_mode: "full", total_timeout_ms: 45_000, timeout_ms: 10_000, synthesis_timeout_ms: 10_000,
    wait_for_completion: true, selection_receipt: confirmed.selection_receipt,
    grounding: { instrument: QQQ_INDEX_INSTRUMENT, facts_unavailable: true, unavailable: ["fixture"] },
  }, { timeoutMs: 60_000 }));
  return { dataDir, fake, server, runId, result };
}

test("headless round-2 and round-3 Q&A drift receives one bounded no-search repair", async () => {
  const fixture = await runDebateQnaFixture("round2_and_round3_once");
  try {
    const { dataDir, fake, runId, result } = fixture;
    assert.equal(result.run.status, "complete", JSON.stringify(result.run.agent_status, null, 2));
    const dir = join(dataDir, "runs", runId);
    const events = readJsonl(join(dir, "events.jsonl"));
    const repairs = events.filter((event) => event.type === "agent_parse_repair"
      && ["bull_researcher", "bear_researcher"].includes(event.role));
    assert.equal(repairs.length, 4);
    assert.deepEqual(repairs.map((event) => event.round).sort(), [2, 2, 3, 3]);
    assert.ok(repairs.every((event) => event.reason === "parse_failed"));
    const repairLaunches = readJsonl(fake.log).filter((item) => item.parseRepair
      && ["bull_researcher", "bear_researcher"].includes(item.role));
    assert.equal(repairLaunches.length, 4);
    assert.deepEqual(repairLaunches.map((item) => item.round).sort(), [2, 2, 3, 3]);
    assert.ok(repairLaunches.every((item) => item.search === false));
    const bull = readJson(join(dir, "bull_researcher.json"));
    const bear = readJson(join(dir, "bear_researcher.json"));
    assert.deepEqual(bull.debate_rounds[2].questions, bull.debate_rounds[1].questions);
    assert.deepEqual(bear.debate_rounds[2].questions, bear.debate_rounds[1].questions);
    assert.deepEqual(bull.debate_rounds[2].questions_answered.map((row) => row.question), bear.debate_rounds[1].questions);
    assert.deepEqual(bear.debate_rounds[2].questions_answered.map((row) => row.question), bull.debate_rounds[1].questions);
  } finally {
    await fixture.server.close();
    removeDataDir(fixture.dataDir);
  }
});

test("headless Q&A remains fail-closed when the bounded repair still changes exact bindings", async () => {
  const fixture = await runDebateQnaFixture("round3_always");
  try {
    const { dataDir, runId, result } = fixture;
    assert.equal(result.run.status, "incomplete");
    assert.equal(result.run.agent_status.bull_researcher.status, "failed");
    assert.equal(result.run.agent_status.bear_researcher.status, "failed");
    assert.equal(result.run.agent_status.portfolio_manager.status, "skipped");
    const events = readJsonl(join(dataDir, "runs", runId, "events.jsonl"));
    const repairs = events.filter((event) => event.type === "agent_parse_repair"
      && ["bull_researcher", "bear_researcher"].includes(event.role));
    assert.equal(repairs.length, 2);
    assert.ok(events.some((event) => event.type === "incomplete"
      && String(event.reason).includes("debate_round_3_failed:parse_failed")));
  } finally {
    await fixture.server.close();
    removeDataDir(fixture.dataDir);
  }
});

for (const [label, pmContractFailureMode, expectedPath] of [
  ["missing price_levels", "missing_price_levels", "/"],
  ["invalid horizon_views", "invalid_horizon_views", "/horizon_views/short_term"],
  ["empty data_gaps", "empty_data_gaps", "/data_gaps"],
]) {
  test(`full headless PM fails closed on ${label} and never publishes a rating`, async () => {
    const dataDir = makeDataDir();
    const fake = fakeFullCodex(dataDir, { malformedTask: null, pmContractFailureMode });
    const server = startServer({ dataDir, env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.driver } });
    try {
      await server.request("initialize", {});
      const prompt = `Reject a structured PM decision with ${label}.`;
      const confirmed = await confirmMasterSelection(server, {
        symbol: "QQQ", language: "English", prompt, selected_master_ids: ["master_buffett"],
      });
      const runId = `FULL-PM-CONTRACT-${pmContractFailureMode.toUpperCase()}-${process.pid}`;
      const result = structured(await server.callTool("analyze_symbol", {
        symbol: "QQQ", run_id: runId, as_of: "2026-07-28", language: "English", prompt,
        // This fixture is checking the PM schema barrier, not the deadline barrier. On a busy
        // Windows runner, process startup for the earlier evidence/debate fixtures can consume
        // the old 30s council budget before PM starts, leaving PM correctly `skipped` but never
        // exercising the contract this test names. Keep the separate deadline tests at 30s and
        // give this contract fixture enough platform-independent headroom to reach both PM tries.
        council_mode: "full", total_timeout_ms: 60_000, timeout_ms: 12_000, synthesis_timeout_ms: 12_000,
        wait_for_completion: true, selection_receipt: confirmed.selection_receipt,
        grounding: { instrument: QQQ_INDEX_INSTRUMENT, facts_unavailable: true, unavailable: ["fixture"] },
      }, { timeoutMs: 75_000 }));

      const dir = join(dataDir, "runs", runId);
      const decision = readJson(join(dir, "decision.json"));
      const status = readJson(join(dir, "status.json"));
      assert.equal(result.run.status, "incomplete");
      assert.equal(status.status, "incomplete");
      assert.equal(status.agents.find((agent) => agent.role === "portfolio_manager").status, "failed");
      assert.equal(decision.decision_available, false);
      assert.equal(decision.rating, null);
      assert.equal(result.decision.rating, null);
      assert.equal(result.run.agent_status.portfolio_manager.attempts, 2);

      const diagnostics = [1, 2].map((attempt) => readJson(join(dir, `portfolio_manager.attempt-${attempt}.failure.json`)));
      for (const diagnostic of diagnostics) {
        assert.equal(diagnostic.schema_id, "runtime-headless-portfolio-manager-decision-v1");
        assert.equal(diagnostic.schema_kind, "headless_portfolio_manager_decision");
        assert.ok(diagnostic.schema_errors.some((error) => error.path === expectedPath),
          `${label} must remain attributable to ${expectedPath}`);
      }
    } finally {
      await server.close();
      removeDataDir(dataDir);
    }
  });
}

test("full headless PM repairs one malformed decision without regenerating the long report in JSON", async () => {
  const dataDir = makeDataDir();
  const fake = fakeFullCodex(dataDir, { malformedTask: null, pmFailureMode: "first" });
  const server = startServer({ dataDir, env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.driver } });
  try {
    await server.request("initialize", {});
    const prompt = "Repair one malformed compact PM decision and render the complete report deterministically.";
    const confirmed = await confirmMasterSelection(server, {
      symbol: "QQQ", language: "English", prompt, selected_master_ids: ["master_buffett"],
    });
    const runId = `FULL-PM-REPAIR-${process.pid}`;
    const result = structured(await server.callTool("analyze_symbol", {
      symbol: "QQQ", run_id: runId, as_of: "2026-07-28", language: "English", prompt,
      council_mode: "full", total_timeout_ms: 30_000, timeout_ms: 6_000, synthesis_timeout_ms: 6_000,
      wait_for_completion: true, selection_receipt: confirmed.selection_receipt,
      grounding: { instrument: QQQ_INDEX_INSTRUMENT, facts_unavailable: true, unavailable: ["fixture"] },
    }, { timeoutMs: 45_000 }));

    const dir = join(dataDir, "runs", runId);
    assert.equal(result.run.status, "complete", JSON.stringify(result.run.agent_status.portfolio_manager, null, 2));
    assert.equal(result.decision.rating, "Hold");
    assert.equal(result.decision.decision_available, true);
    assert.equal(result.report_quality.status, "passed", result.report_quality.missing.join("; "));
    assert.equal(result.run.agent_status.portfolio_manager.attempts, 2);
    assert.equal(result.run.agent_status.portfolio_manager.attempt_diagnostics.length, 1);

    const diagnosticPath = join(dir, "portfolio_manager.attempt-1.failure.json");
    assert.equal(existsSync(diagnosticPath), true);
    const diagnostic = readJson(diagnosticPath);
    assert.equal(diagnostic.attempt, 1);
    assert.equal(diagnostic.failure_kind, "parse_failed");
    assert.match(diagnostic.output_sha256, /^sha256:[0-9a-f]{64}$/u);
    assert.doesNotMatch(readFileSync(diagnosticPath, "utf8"), /PM_PRIVATE_RAW_SENTINEL|report_markdown|rating.*Buy/u);
    if (process.platform !== "win32") assert.equal(statSync(diagnosticPath).mode & 0o777, 0o600);

    const manager = readJson(join(dir, "manager_synthesis.json"));
    assert.doesNotMatch(manager.raw_text, /report_markdown/u);
    assert.match(manager.report_markdown, /## Analyst Work Log/);
    assert.match(manager.report_markdown, /## Source Table/);
    const launches = readJsonl(fake.log).filter((item) => item.role === "portfolio_manager");
    assert.equal(launches.length, 2);
    assert.ok(launches.every((item) => item.structuredPmDecision && item.omitsPmReport));
    assert.equal(launches[1].parseRepair, true);
    assert.equal(launches[1].search, false);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

test("two malformed full PM attempts persist sanitized diagnostics and never manufacture a rating", async () => {
  const dataDir = makeDataDir();
  const fake = fakeFullCodex(dataDir, { malformedTask: null, pmFailureMode: "both" });
  const server = startServer({ dataDir, env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.driver } });
  try {
    await server.request("initialize", {});
    const prompt = "Fail closed after two malformed compact PM decisions without a synthetic investment rating.";
    const confirmed = await confirmMasterSelection(server, {
      symbol: "QQQ", language: "English", prompt, selected_master_ids: ["master_buffett"],
    });
    const runId = `FULL-PM-DOUBLE-FAIL-${process.pid}`;
    const result = structured(await server.callTool("analyze_symbol", {
      symbol: "QQQ", run_id: runId, as_of: "2026-07-28", language: "English", prompt,
      council_mode: "full", total_timeout_ms: 30_000, timeout_ms: 6_000, synthesis_timeout_ms: 6_000,
      wait_for_completion: true, selection_receipt: confirmed.selection_receipt,
      grounding: { instrument: QQQ_INDEX_INSTRUMENT, facts_unavailable: true, unavailable: ["fixture"] },
    }, { timeoutMs: 45_000 }));

    const dir = join(dataDir, "runs", runId);
    const decision = readJson(join(dir, "decision.json"));
    const status = readJson(join(dir, "status.json"));
    assert.equal(result.run.status, "incomplete");
    assert.equal(status.status, "incomplete");
    assert.equal(status.agents.find((agent) => agent.role === "portfolio_manager").status, "failed");
    assert.equal(decision.decision_available, false);
    assert.equal(decision.rating, null);
    assert.equal(decision.confidence, "low");
    assert.match(decision.summary, /ran twice.*no usable decision/i);

    const diagnosticPaths = [1, 2].map((attempt) => join(dir, `portfolio_manager.attempt-${attempt}.failure.json`));
    for (const [index, diagnosticPath] of diagnosticPaths.entries()) {
      assert.equal(existsSync(diagnosticPath), true);
      const text = readFileSync(diagnosticPath, "utf8");
      const diagnostic = JSON.parse(text);
      assert.equal(diagnostic.attempt, index + 1);
      assert.equal(diagnostic.failure_kind, "parse_failed");
      assert.match(diagnostic.output_sha256, /^sha256:[0-9a-f]{64}$/u);
      assert.ok(text.length < 4_096, `diagnostic ${index + 1} must stay bounded`);
      assert.doesNotMatch(text, /PM_PRIVATE_RAW_SENTINEL|report_markdown|rating.*Buy/u);
      if (process.platform !== "win32") assert.equal(statSync(diagnosticPath).mode & 0o777, 0o600);
    }
    assert.equal(result.run.agent_status.portfolio_manager.attempt_diagnostics.length, 2);
    assert.match(readFileSync(join(dir, "final_report.md"), "utf8"), /## Analyst Work Log/);
    assert.doesNotMatch(readFileSync(join(dir, "user_response.md"), "utf8"), /Rating:\s*(Buy|Hold)/u);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

test("a caller-lowered full-council budget fails closed and persists a terminal standard package before its deadline", async () => {
  const dataDir = makeDataDir();
  const fake = fakeFullCodex(dataDir, { evidenceDelayMs: 5_000, malformedTask: null });
  const server = startServer({ dataDir, env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.driver } });
  try {
    await server.request("initialize", {});
    const prompt = "Prove a caller-lowered full deadline reaches durable terminal state.";
    const confirmed = await confirmMasterSelection(server, {
      symbol: "QQQ", language: "English", prompt, selected_master_ids: ["master_buffett"],
    });
    const runId = `FULL-DEADLINE-${process.pid}`;
    const started = Date.now();
    const result = structured(await server.callTool("analyze_symbol", {
      symbol: "QQQ", run_id: runId, as_of: "2026-07-28", language: "English", prompt,
      council_mode: "full", total_timeout_ms: 20_000, timeout_ms: 300, synthesis_timeout_ms: 300,
      wait_for_completion: true, selection_receipt: confirmed.selection_receipt,
      grounding: { instrument: QQQ_INDEX_INSTRUMENT, facts_unavailable: true, unavailable: ["fixture"] },
    }, { timeoutMs: 15_000 }));
    const elapsed = Date.now() - started;
    const dir = join(dataDir, "runs", runId);
    assert.equal(result.run.status, "incomplete");
    assert.ok(elapsed < 20_000, `lowered 20000ms deadline returned after ${elapsed}ms`);
    for (const name of [
      "status.json", "evidence.json", "events.jsonl", "decision.json", "manager_synthesis.json",
      "final_report.md", "user_response.md", "report_quality.json", "artifact_index.md", "all_agents.md",
    ]) assert.equal(existsSync(join(dir, name)), true, name);
    const status = readJson(join(dir, "status.json"));
    assert.ok(["incomplete", "failed"].includes(status.status));
    assert.equal(status.time_budget_ms, 20_000);
    assert.equal(status.deadline_met, true);
    assert.ok(status.elapsed_ms <= 20_000, JSON.stringify(status, null, 2));
    assert.ok(Object.values(result.run.task_status).every((state) =>
      ["failed", "timed_out", "skipped", "completed"].includes(state.status)),
    JSON.stringify(result.run.task_status, null, 2));
    assert.match(readFileSync(join(dir, "user_response.md"), "utf8"), /NEEDS_MANAGER_REVIEW/);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

test("every abstaining seat receives and publishes its strong first-person method voice", async () => {
  // Four seats on this ETF fixture freeze out_of_scope. The global voice contract still runs
  // each isolated method worker so an abstention sounds like that method rather than a generic
  // neutral template.
  const dataDir = makeDataDir();
  const fake = fakeFullCodex(dataDir);
  // A legacy opt-out cannot weaken the global first-person contract.
  const server = startServer({ dataDir, env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.driver, ALPHACOUNCIL_VOICE_ABSTAINING_SEATS: "0" } });
  try {
    await server.request("initialize", {});
    const prompt = "Prove an abstaining method seat is settled without a voice worker.";
    const confirmed = await confirmMasterSelection(server, {
      symbol: "QQQ", language: "English", prompt, selected_master_ids: SELECTED_MASTERS,
    });
    const runId = `FULL-ABSTAIN-${process.pid}`;
    const result = structured(await server.callTool("analyze_symbol", {
      symbol: "QQQ", run_id: runId, as_of: "2026-07-28", language: "English", prompt,
      council_mode: "full", wait_for_completion: true,
      selection_receipt: confirmed.selection_receipt,
      grounding: { instrument: QQQ_INDEX_INSTRUMENT, facts_unavailable: true, unavailable: ["fixture"] },
    }, { timeoutMs: 90_000 }));

    const dir = join(dataDir, "runs", runId);
    const finalReport = readFileSync(join(dir, "final_report.md"), "utf8");
    const userResponse = readFileSync(join(dir, "user_response.md"), "utf8");
    const launches = readJsonl(fake.log);

    for (const id of SELECTED_MASTERS) {
      assert.equal(launches.filter((item) => item.role === id).length, 1, `${id} must launch one voice worker`);
      assert.match(finalReport, new RegExp(`MASTER_SENTINEL_${id}`), id);

      // The seat is still fully published: every artifact carries it, with a readable statement.
      const opinion = result.run.master_opinions.find((item) => item.master === id);
      assert.ok(opinion, `${id} must still be recorded`);
      assert.equal(opinion.stance, "out_of_scope");
      assert.equal(result.run.master_status[id].status, "completed");
      assert.equal(result.run.master_status[id].voice_status, "completed");
      assert.equal(opinion.dedicated_worker.status, "completed");
      assert.equal(opinion.voice_mode, "first_person_public_method_simulation_v1");
      assert.equal(opinion.disclosure_ack, "alphacouncil.first_person_public_method_simulation.v1");
      assert.ok(Object.values(opinion.voice).every((text) => /\bI\b/u.test(text)), id);
      assert.ok(opinion.voice_statement.replace(/\s/g, "").length >= 20, `${id} statement too thin`);
      assert.match(opinion.voice_statement, /I would/u);
      assert.equal(existsSync(join(dir, `${id}.md`)), true, id);
      assert.match(finalReport, new RegExp(id));
      assert.match(userResponse, new RegExp(id));
    }

    // Voicing all abstentions must not weaken the bench gate or the report contract.
    assert.equal(result.run.missing_master_count ?? 0, 0);
    assert.equal(readJson(join(dir, "report_quality.json")).method_statement_coverage.status, "passed");
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});
