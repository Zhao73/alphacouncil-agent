import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TASKS } from "../../mcp/lib/constants.mjs";
import {
  COMPANY_DOSSIER_CONTRACT_ID,
  expectedCoverageItems,
} from "../../mcp/lib/company-dossier.mjs";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { confirmMasterSelection, startServer, structured } from "../helpers/rpc-client.mjs";
import { completeReport } from "../helpers/fixtures.mjs";

let dataDir;
let server;
const AS_OF = "2026-07-28";
const selectedMaster = "master_simons";
const completeRunId = `SELFTEST-VISIBLE-${process.pid}`;
const noPmRunId = `SELFTEST-NOPM-${process.pid}`;
const shortcutRunId = `SELFTEST-SHORTCUT-${process.pid}`;
const languageRunId = `SELFTEST-LANGUAGE-${process.pid}`;
const barrierRunId = `SELFTEST-BARRIER-${process.pid}`;
const citationRunId = `SELFTEST-CITATION-${process.pid}`;
const reviseRunId = `SELFTEST-REVISE-${process.pid}`;
const finalizedRunId = `SELFTEST-FINALIZED-${process.pid}`;
const reorderedFinalizationRunId = `SELFTEST-FINALIZED-REORDERED-${process.pid}`;
const invalidFinalizationTargetRunId = `SELFTEST-FINALIZED-INVALID-TARGET-${process.pid}`;
const recorded = {};

const bullQuestions = [
  "Which operating metric would disprove the long thesis first?",
  "What valuation level compensates for the identified execution risk?",
  "Which dated catalyst can change the market view during this horizon?",
];
const bearQuestions = [
  "Which primary source directly supports the downside scenario described here?",
  "What evidence would show that current valuation already discounts this risk?",
  "Which measurable condition would invalidate the short thesis completely?",
];

const analystLog = DEFAULT_TASKS.map((task) => [
  `### ${task}`,
  `The ${task} analyst produced a visible packet. This section names the planned analyst explicitly and records the evidence handoff.`,
].join("\n")).join("\n\n");

const fullCouncilReport = completeReport.replace(
  /### market_data\nThe market_data analyst produced a visible packet\. This section names the planned analyst explicitly and records the evidence handoff\./,
  analystLog,
);

function source(id, title, url) {
  return {
    id,
    title,
    url,
    published_at: AS_OF,
    retrieved_at: AS_OF,
  };
}

function officialItem(sourceId, title, url) {
  return {
    title,
    published_at: AS_OF,
    url,
    source_id: sourceId,
  };
}

function evidencePacket(task = "market_data", {
  summary = `The ${task} visible analyst records sufficient English evidence for this integration protocol fixture.`,
  extra = {},
  includeOfficialCoverage = true,
  coverageNote = "The dated fixture source covers this contract item for barrier testing.",
} = {}) {
  const packet = {
    summary,
    claims: [{
      claim: `The ${task} fixture records one bounded material fact for downstream provenance checks.`,
      claim_type: "event_or_observation",
      evidence: "The fixture source directly supports this bounded material fact.",
      confidence: "medium",
      source_ids: ["S1"],
    }],
    metrics: {},
    sources: [source("S1", `${task} visible integration fixture source`, `https://example.com/${task}`)],
    open_questions: [],
    coverage_items: expectedCoverageItems(task).map((id) => ({
      id,
      status: "covered",
      source_ids: ["S1"],
      note: coverageNote,
    })),
    confidence: "medium",
    information_richness: "B",
    ...extra,
  };

  if (task === "news_industry_management" && includeOfficialCoverage
    && !Object.hasOwn(packet, "official_source_coverage")) {
    const regulatorUrl = "https://regulator.example/filing";
    const issuerUrl = "https://issuer.example/news";
    const regulatorItem = officialItem("S1", "Regulator fixture filing", regulatorUrl);
    const issuerItem = officialItem("S2", "Issuer fixture release", issuerUrl);
    packet.sources = [
      source("S1", regulatorItem.title, regulatorUrl),
      source("S2", issuerItem.title, issuerUrl),
    ];
    packet.official_source_coverage = {
      status: "complete",
      regulator: {
        status: "complete",
        entry_url: "https://regulator.example/filings",
        checked_through: AS_OF,
        latest_dated_item: regulatorItem,
        dated_items_checked: [regulatorItem],
        gap: null,
      },
      issuer: {
        status: "complete",
        entry_url: "https://issuer.example/newsroom",
        checked_through: AS_OF,
        latest_dated_item: issuerItem,
        dated_items_checked: [issuerItem],
        gap: null,
      },
    };
  }

  return packet;
}

function debatePacket(role, round, extra = {}) {
  const ownQuestions = role === "bull_researcher" ? bullQuestions : bearQuestions;
  const opponentQuestions = role === "bull_researcher" ? bearQuestions : bullQuestions;
  return {
    verdict: `${role} provides a fully auditable round ${round} conclusion for the committee.`,
    rating: role === "bull_researcher" ? "Buy" : "Sell",
    winner: role === "bull_researcher" ? "bull" : "bear",
    summary: `The ${role} completes round ${round} with sourced reasoning, explicit uncertainty, and a clear testable conclusion.`,
    long_thesis: role === "bull_researcher" ? ["Operating evidence supports the constructive scenario under the stated conditions."] : [],
    short_thesis: role === "bear_researcher" ? ["Valuation and execution evidence support the cautious scenario under the stated conditions."] : [],
    valuation_range: "The bounded fixture supports only a conditional valuation range.",
    catalysts: ["A dated primary-source update would test the recorded thesis."],
    risks: ["New primary evidence could invalidate the bounded fixture conclusion."],
    position: "Keep exposure bounded while the stated evidence conditions remain in force.",
    invalidation: ["A contradictory primary filing invalidates the fixture conclusion."],
    source_ids: ["market_data:S1"],
    questions: round >= 2 ? ownQuestions : [],
    questions_answered: round === 3
      ? opponentQuestions.map((question) => ({ question, answer: `The recorded evidence answers this exact question while preserving uncertainty: ${question}` }))
      : [],
    confidence: "medium",
    ...extra,
  };
}

async function selectionReceipt(symbol) {
  const selection = await confirmMasterSelection(server, {
    symbol,
    language: "English",
    selected_master_ids: [selectedMaster],
  });
  return selection.selection_receipt;
}

async function plan(runId, tasks = DEFAULT_TASKS) {
  return server.callTool("plan_visible_run", {
    symbol: "NOK",
    as_of: AS_OF,
    language: "English",
    run_id: runId,
    tasks,
    grounding: {
      gathered_at: `${AS_OF}T12:00:00Z`,
      facts_unavailable: true,
      instrument: {
        symbol: "NOK",
        name: "Nokia visible integration fixture",
        instrument_type: "equity",
        research_model: "operating_company",
        exchange: "NYSE",
        currency: "USD",
      },
    },
    selection_receipt: await selectionReceipt("NOK"),
  });
}

async function recordEvidence(runId, task = "market_data", packet = evidencePacket(task)) {
  return server.callTool("record_visible_packet", {
    run_id: runId,
    task,
    thread_id: `thread-${runId}-${task}`,
    thread_title: `AlphaCouncil Agent NOK ${task} evidence thread`,
    packet,
  });
}

async function recordAllEvidence(runId, { skip = [] } = {}) {
  for (const task of DEFAULT_TASKS) {
    if (!skip.includes(task)) structured(await recordEvidence(runId, task));
  }
  return JSON.parse(readFileSync(join(dataDir, "runs", runId, "company_dossier.json"), "utf8"));
}

function persistedRun(runId) {
  return JSON.parse(readFileSync(join(dataDir, "runs", runId, "evidence.json"), "utf8"));
}

function dossier(runId) {
  return JSON.parse(readFileSync(join(dataDir, "runs", runId, "company_dossier.json"), "utf8"));
}

function companyDossierHash(runId) {
  const path = join(dataDir, "runs", runId, "company_dossier.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).content_hash : `sha256:${"0".repeat(64)}`;
}

function frozenStance(runId) {
  const opinion = persistedRun(runId).master_opinions.find((item) => item.master === selectedMaster);
  assert.ok(opinion, `${selectedMaster} must have a frozen deterministic opinion`);
  return opinion.stance;
}

function methodVoicePacket(runId, extra = {}) {
  const stance = frozenStance(runId);
  const positionIntent = {
    constructive: "would_buy",
    cautious: "would_hold",
    opposed: "would_pass",
    out_of_scope: "not_in_my_circle",
  }[stance];
  assert.ok(positionIntent, `unexpected frozen stance: ${stance}`);
  return {
    master: selectedMaster,
    acknowledged_stance: stance,
    voice_mode: "first_person_public_method_simulation_v1",
    disclosure_ack: "alphacouncil.first_person_public_method_simulation.v1",
    position_intent: positionIntent,
    voice: {
      would_i_act: "I would not issue a directional view from this incomplete evidence.",
      what_i_see: "I see that the fixture lacks my required point-in-time method facts.",
      how_my_method_reads_it: "I stop at my fact gate instead of manufacturing an unsupported investment claim.",
      where_i_disagree: "I disagree with treating an abstention as a bearish vote.",
      what_changes_my_mind: "I would reassess when dated primary sources provide my missing method-critical facts.",
    },
    key_findings: ["The fixture does not contain the required method-specific point-in-time facts."],
    disagreements: [],
    what_would_change_my_mind: ["Provide the missing method-critical facts from dated primary sources."],
    // Even an out-of-scope operating-company voice must show that it read the shared dossier;
    // the empty-source exception applies only when no company dossier is required.
    source_ids: ["market_data:S1"],
    confidence: "low",
    company_dossier_hash_ack: companyDossierHash(runId),
    ...extra,
  };
}

async function recordMaster(runId, packet = methodVoicePacket(runId)) {
  return server.callTool("record_master_opinion", {
    run_id: runId,
    master: selectedMaster,
    thread_id: `thread-${runId}-master`,
    packet,
  });
}

async function recordRound(runId, role, round, packet = debatePacket(role, round)) {
  return server.callTool("record_visible_decision", {
    run_id: runId,
    role,
    round,
    thread_id: `thread-${runId}-${role}-${round}`,
    thread_title: `AlphaCouncil Agent NOK ${role} round ${round}`,
    packet: {
      ...packet,
      company_dossier_hash_ack: packet.company_dossier_hash_ack || companyDossierHash(runId),
    },
  });
}

async function recordFullDebate(runId) {
  for (const round of [1, 2, 3]) {
    for (const role of ["bull_researcher", "bear_researcher"]) {
      await recordRound(runId, role, round);
    }
  }
}

async function recordPm(runId) {
  return server.callTool("record_visible_decision", {
    run_id: runId,
    role: "portfolio_manager",
    thread_id: `thread-${runId}-pm`,
    thread_title: "AlphaCouncil Agent NOK portfolio manager decision",
    packet: {
      verdict: "The portfolio manager reaches a balanced conclusion after the complete audited debate.",
      rating: "Hold",
      winner: "balanced",
      summary: "The final decision weighs both completed sides, all exact questions, and the recorded evidence.",
      long_thesis: ["The sourced operating fixture supports the conditional long case."],
      short_thesis: ["The sourced risk fixture limits confidence in the long case."],
      valuation_range: "The bounded fixture supports only a conditional valuation range.",
      catalysts: ["A dated primary-source update would test the decision."],
      risks: ["Contradictory primary evidence remains the principal risk."],
      position: "Keep exposure bounded until the next primary-source update.",
      invalidation: ["A contradictory primary filing invalidates the decision."],
      source_ids: ["market_data:S1"],
      confidence: "medium",
      report_markdown: fullCouncilReport,
      company_dossier_hash_ack: dossier(runId).content_hash,
    },
  });
}

// Every contract section is present, so the submission clears the entry check, but the analyst
// work log never names the planned analyst -- a defect only the assembled report can see, since
// the check is scoped to that section's body against the run's task list. That keeps the
// revision path exercised now that a missing report body is rejected at submission time.
const unloggedReport = fullCouncilReport.replace(
  /### market_data\nThe market_data analyst/,
  "### Evidence seats\nThe evidence seat",
);

async function recordThinPm(runId) {
  return server.callTool("record_visible_decision", {
    run_id: runId,
    role: "portfolio_manager",
    thread_id: `thread-${runId}-pm`,
    packet: {
      verdict: "The portfolio manager reaches a balanced conclusion after the complete audited debate.",
      rating: "Hold",
      winner: "balanced",
      summary: "A submission whose analyst work log never names the planned analyst, which the structure gate must reject.",
      long_thesis: ["The sourced operating fixture supports the conditional long case."],
      short_thesis: ["The sourced risk fixture limits confidence in the long case."],
      valuation_range: "The bounded fixture supports only a conditional valuation range.",
      catalysts: ["A dated primary-source update would test the decision."],
      risks: ["Contradictory primary evidence remains the principal risk."],
      position: "Keep exposure bounded until the next primary-source update.",
      invalidation: ["A contradictory primary filing invalidates the decision."],
      source_ids: ["market_data:S1"],
      confidence: "medium",
      report_markdown: unloggedReport,
      company_dossier_hash_ack: dossier(runId).content_hash,
    },
  });
}

before(async () => {
  dataDir = makeDataDir();
  server = startServer({ dataDir });
  await server.request("initialize", {});

  recorded.plan = structured(await plan(completeRunId));
  const downstreamAgents = [...recorded.plan.master_agents, ...recorded.plan.debate_agents];
  recorded.preBarrierPrompts = Object.fromEntries(downstreamAgents.map((agent) => [
    agent.role,
    readFileSync(agent.prompt_file, "utf8"),
  ]));
  recorded.completeDossier = await recordAllEvidence(completeRunId);
  recorded.postBarrierPrompts = Object.fromEntries(downstreamAgents.map((agent) => [
    agent.role,
    readFileSync(agent.prompt_file, "utf8"),
  ]));
  recorded.master = structured(await recordMaster(completeRunId));
  // Round 2 cannot start until both Round-1 sides exist.
  recorded.outOfOrder = await recordRound(completeRunId, "bull_researcher", 2);
  await recordRound(completeRunId, "bull_researcher", 1);
  recorded.idempotent = structured(await recordRound(completeRunId, "bull_researcher", 1));
  recorded.conflict = await recordRound(
    completeRunId,
    "bull_researcher",
    1,
    debatePacket("bull_researcher", 1, { summary: "A conflicting replay attempts to replace the immutable first round with different content." }),
  );
  await recordRound(completeRunId, "bear_researcher", 1);
  recorded.badRoundTwo = await recordRound(
    completeRunId,
    "bull_researcher",
    2,
    debatePacket("bull_researcher", 2, { questions: bullQuestions.slice(0, 2) }),
  );
  for (const role of ["bull_researcher", "bear_researcher"]) await recordRound(completeRunId, role, 2);
  for (const role of ["bull_researcher", "bear_researcher"]) await recordRound(completeRunId, role, 3);
  recorded.pm = structured(await recordPm(completeRunId));
  recorded.pmReplay = structured(await recordPm(completeRunId));

  await plan(noPmRunId);
  await recordAllEvidence(noPmRunId);
  structured(await recordMaster(noPmRunId));
  await recordFullDebate(noPmRunId);

  await plan(finalizedRunId);
  await recordAllEvidence(finalizedRunId);
  structured(await recordMaster(finalizedRunId));
  recorded.finalized = structured(await server.callTool("finalize_visible_run", {
    run_id: finalizedRunId,
    reason: "debate_worker_failed",
    failed_roles: ["bull_researcher"],
  }));
  recorded.finalizedReplay = structured(await server.callTool("finalize_visible_run", {
    run_id: finalizedRunId,
    reason: "debate_worker_failed",
    failed_roles: ["bull_researcher"],
  }));
  recorded.lateFinalizedDecision = await recordRound(finalizedRunId, "bear_researcher", 1);

  await plan(reorderedFinalizationRunId);
  await recordAllEvidence(reorderedFinalizationRunId);
  structured(await recordMaster(reorderedFinalizationRunId));
  recorded.reorderedFinalization = structured(await server.callTool("finalize_visible_run", {
    run_id: reorderedFinalizationRunId,
    reason: "debate_worker_failed",
    failed_roles: ["bear_researcher", "bull_researcher"],
  }));
  recorded.reorderedFinalizationReplay = structured(await server.callTool("finalize_visible_run", {
    run_id: reorderedFinalizationRunId,
    reason: "debate_worker_failed",
    failed_roles: ["bull_researcher", "bear_researcher"],
  }));

  await plan(invalidFinalizationTargetRunId);
  await recordAllEvidence(invalidFinalizationTargetRunId);
  recorded.invalidFinalizationTarget = await server.callTool("finalize_visible_run", {
    run_id: invalidFinalizationTargetRunId,
    reason: "evidence_worker_failed",
    failed_tasks: ["market_data"],
  });

  await plan(shortcutRunId);
  await recordAllEvidence(shortcutRunId);
  structured(await recordMaster(shortcutRunId));
  await recordRound(shortcutRunId, "bull_researcher", 1);
  await recordRound(shortcutRunId, "bear_researcher", 1);
  recorded.shortcut = await recordPm(shortcutRunId);

  // A Chinese run whose only non-Chinese text is the English source titles it cites.
  await server.callTool("plan_visible_run", {
    symbol: "NOK",
    as_of: AS_OF,
    language: "zh-CN",
    run_id: citationRunId,
    tasks: ["market_data"],
    grounding: {
      gathered_at: `${AS_OF}T12:00:00Z`,
      facts_unavailable: true,
      instrument: {
        symbol: "NOK",
        name: "诺基亚可见集成固定样本",
        instrument_type: "equity",
        research_model: "operating_company",
        exchange: "NYSE",
        currency: "USD",
      },
    },
    selection_receipt: (await confirmMasterSelection(server, { symbol: "NOK", language: "zh-CN", selected_master_ids: [selectedMaster] })).selection_receipt,
  });
  recorded.citation = await server.callTool("record_visible_packet", {
    run_id: citationRunId,
    task: "market_data",
    packet: evidencePacket("market_data", {
      summary: "本席位记录了足够的中文证据，并按来源发布时的原文标题引用，不翻译标题。",
      coverageNote: "本固定样本的日期来源覆盖了这项资料包契约检查。",
      extra: {
        claims: [{
          claim: "本地固定测试记录了一条完整的中文重大事实。",
          claim_type: "event_or_observation",
          evidence: "该事实由下方保持原文标题的公开来源直接支持。",
          confidence: "medium",
          source_ids: ["S1"],
        }],
        sources: [source("S1", "Nokia beats quarterly estimates", "https://example.com/a")],
      },
    }),
  });

  // A PM whose first submission fails the structure gate must stay revisable.
  await plan(reviseRunId);
  await recordAllEvidence(reviseRunId);
  structured(await recordMaster(reviseRunId));
  await recordFullDebate(reviseRunId);
  recorded.thinPm = structured(await recordThinPm(reviseRunId));
  recorded.revisedPm = await recordPm(reviseRunId);

  await plan(languageRunId);
  const languageEvidencePath = join(dataDir, "runs", languageRunId, "evidence.json");
  recorded.beforeWrongEvidence = readFileSync(languageEvidencePath, "utf8");
  recorded.wrongEvidence = await recordEvidence(
    languageRunId,
    "market_data",
    evidencePacket("market_data", {
      summary: "这是一份完全使用中文撰写的错误语言证据包，不能写入英文运行。",
      coverageNote: "这条中文覆盖说明也故意违反英文运行的语言合同。",
      extra: {
        claims: [{
          claim: "这条中文重大事实故意违反英文运行的语言合同。",
          claim_type: "event_or_observation",
          evidence: "这段中文证据也故意违反英文运行的语言合同。",
          confidence: "medium",
          source_ids: ["S1"],
        }],
      },
    }),
  );
  recorded.afterWrongEvidence = readFileSync(languageEvidencePath, "utf8");
  structured(await recordEvidence(languageRunId));
  await recordAllEvidence(languageRunId, { skip: ["market_data"] });
  recorded.beforeWrongMaster = readFileSync(languageEvidencePath, "utf8");
  recorded.wrongMaster = await recordMaster(languageRunId, methodVoicePacket(languageRunId, {
    voice: {
      would_i_act: "我不会在证据不足时给出方向判断。",
      what_i_see: "我看到这段中文内容不应进入要求英文输出的运行记录。",
      how_my_method_reads_it: "我按自己的方法先拒绝补造事实。",
      where_i_disagree: "我不同意忽略本轮英文语言合同。",
      what_changes_my_mind: "我只会在语言和事实合同都满足后改变判断。",
    },
    key_findings: ["本方法席无法依据当前证据给出方向性判断。"],
    disagreements: [],
    what_would_change_my_mind: [],
    source_ids: ["market_data:S1"],
    confidence: "low",
  }));
  recorded.afterWrongMaster = readFileSync(languageEvidencePath, "utf8");
  structured(await recordMaster(languageRunId));
  recorded.beforeWrongDebate = readFileSync(languageEvidencePath, "utf8");
  recorded.wrongDebate = await recordRound(
    languageRunId,
    "bull_researcher",
    1,
    debatePacket("bull_researcher", 1, {
      verdict: "这是一段错误语言的多头发言。",
      summary: "这段中文内容不得写入英文运行。",
      long_thesis: ["这条多头论据故意违反英文语言合同。"],
      short_thesis: ["这条空头论据也故意违反英文语言合同。"],
      valuation_range: "这段估值说明故意使用中文。",
      catalysts: ["这条催化剂故意使用中文。"],
      risks: ["这条风险故意使用中文。"],
      position: "这条仓位说明故意使用中文。",
      invalidation: ["这条反证条件故意使用中文。"],
    }),
  );
  recorded.afterWrongDebate = readFileSync(languageEvidencePath, "utf8");

  await plan(barrierRunId);
  recorded.earlyMaster = await recordMaster(barrierRunId);
  structured(await recordEvidence(barrierRunId));
  recorded.earlyDebate = await recordRound(barrierRunId, "bull_researcher", 1);
  await recordAllEvidence(barrierRunId, { skip: ["market_data"] });
  recorded.wrongFrozenStance = await recordMaster(barrierRunId, methodVoicePacket(barrierRunId, {
    acknowledged_stance: "constructive",
    position_intent: "would_buy",
    voice: {
      would_i_act: "I would attempt to replace the frozen stance.",
      what_i_see: "I see a fixture that must reject this changed stance.",
      how_my_method_reads_it: "I am deliberately violating the frozen contract in this negative control.",
      where_i_disagree: "I disagree with the frozen record only for this negative control.",
      what_changes_my_mind: "I would preserve the original stance in a valid packet.",
    },
    key_findings: [], disagreements: [], what_would_change_my_mind: [], source_ids: ["market_data:S1"], confidence: "low",
  }));
  structured(await recordMaster(barrierRunId));
});

after(async () => {
  await server.close();
  removeDataDir(dataDir);
});

test("full visible completion requires the persisted three-round exact-Q&A chain", () => {
  assert.equal(recorded.pm.status, "complete");
  const dir = join(dataDir, "runs", completeRunId);
  const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
  assert.equal(status.completeness, "complete");
  assert.equal(status.company_dossier_contract, COMPANY_DOSSIER_CONTRACT_ID);
  assert.equal(status.company_dossier_coverage, "complete");
  assert.equal(status.company_dossier_decision_barrier_ready, true);
  assert.equal(status.company_dossier_expected_count, 52);
  assert.equal(status.company_dossier_covered_count, 52);
  assert.deepEqual(recorded.completeDossier.packets.map((packet) => packet.task), DEFAULT_TASKS);
  assert.equal(recorded.completeDossier.coverage.expected_count, 52);
  assert.equal(recorded.completeDossier.coverage.covered_count, 52);
  assert.equal(status.visible_debate_contract, "role_round_audit_v1");
  assert.equal(status.visible_debate_rounds_expected, 3);
  assert.deepEqual(status.visible_debate_rounds_recorded, {
    bull_researcher: [1, 2, 3],
    bear_researcher: [1, 2, 3],
  });
  assert.equal(status.visible_debate_qna_gate, "passed");
  for (const role of ["bull_researcher", "bear_researcher"]) {
    for (const round of [1, 2, 3]) {
      const packet = JSON.parse(readFileSync(join(dir, `${role}.round-${round}.json`), "utf8"));
      assert.equal(packet.company_dossier_hash_ack, recorded.completeDossier.content_hash, `${role}:${round}`);
    }
  }
  const manager = JSON.parse(readFileSync(join(dir, "manager_synthesis.json"), "utf8"));
  assert.equal(manager.company_dossier_hash_ack, recorded.completeDossier.content_hash);
});

test("a declined out-of-scope v3 seat still returns an independent first-person hash-bound voice", () => {
  assert.equal(recorded.plan.prompts_inline, false);
  assert.equal(recorded.plan.master_agents.length, 1);
  const worker = recorded.plan.master_agents[0];
  assert.equal(worker.role, selectedMaster);
  assert.equal(worker.worker_kind, "visible_method_voice");
  assert.equal(worker.frozen_stance, "out_of_scope");
  assert.equal(worker.prompt_template, null);
  assert.ok(worker.prompt_file);
  const declined = recorded.plan.masters_declined.find((seat) => seat.master === selectedMaster);
  assert.ok(declined, "the seat must still appear in the plan as an explicit decline");
  assert.equal(declined.stance, "out_of_scope");
  assert.equal(declined.engine, "v3_method_runtime");

  const opinion = recorded.master.opinion;
  assert.equal(opinion.stance, "out_of_scope");
  assert.equal(opinion.voice_status, "completed");
  assert.equal(opinion.statement_origin, "visible_method_voice_worker");
  assert.equal(opinion.dedicated_worker.execution_mode, "visible_host_thread");
  assert.equal(opinion.company_dossier_hash_ack, recorded.completeDossier.content_hash);
  assert.equal(opinion.company_dossier_hash, recorded.completeDossier.content_hash);
  for (const [field, value] of Object.entries(opinion.voice)) {
    assert.match(value, /\bI\b/, `${field} must retain independent first-person method voice`);
  }

  assert.doesNotMatch(recorded.preBarrierPrompts[selectedMaster], new RegExp(recorded.completeDossier.content_hash));
  for (const role of [selectedMaster, "bull_researcher", "bear_researcher", "portfolio_manager"]) {
    assert.notEqual(recorded.postBarrierPrompts[role], recorded.preBarrierPrompts[role], `${role} prompt must refresh at the barrier`);
    assert.match(recorded.postBarrierPrompts[role], new RegExp(recorded.completeDossier.content_hash), `${role} prompt hash`);
    assert.match(recorded.postBarrierPrompts[role], /company_dossier_hash_ack/, `${role} prompt ack field`);
  }
});

test("round ordering, exact questions, and conflicting replay fail closed", () => {
  assert.equal(recorded.outOfOrder.error?.data?.reason, "VISIBLE_DEBATE_ROUND_OUT_OF_ORDER");
  assert.equal(recorded.badRoundTwo.error?.data?.reason, "VISIBLE_DEBATE_QNA_INVALID");
  assert.equal(recorded.idempotent.idempotent_replay, true);
  assert.equal(recorded.conflict.error?.data?.reason, "VISIBLE_DEBATE_ROUND_CONFLICT");
});

test("visible evidence and frozen-stance barriers are enforced server-side", () => {
  assert.equal(recorded.earlyMaster.error?.data?.reason, "VISIBLE_MASTER_EVIDENCE_INCOMPLETE");
  assert.deepEqual(recorded.earlyMaster.error?.data?.missing_evidence, DEFAULT_TASKS);
  assert.equal(recorded.earlyDebate.error?.data?.reason, "VISIBLE_DEBATE_PREREQUISITES_INCOMPLETE");
  assert.deepEqual(recorded.earlyDebate.error?.data?.missing_evidence, DEFAULT_TASKS.slice(1));
  assert.deepEqual(recorded.earlyDebate.error?.data?.missing_masters, [selectedMaster]);
  assert.equal(recorded.wrongFrozenStance.error?.data?.reason, "VISIBLE_MASTER_FROZEN_STANCE_MISMATCH");
});

test("a full three-round debate without portfolio_manager remains incomplete", () => {
  const status = JSON.parse(readFileSync(join(dataDir, "runs", noPmRunId, "status.json"), "utf8"));
  assert.equal(status.completeness, "incomplete");
  assert.deepEqual(status.agents.find((agent) => agent.role === "bull_researcher").rounds_completed, [1, 2, 3]);
  assert.equal(status.missing_debate_count, 1);
  assert.equal(existsSync(join(dataDir, "runs", noPmRunId, "manager_synthesis.json")), false);
});

test("a blocked visible run finalizes once and returns the mandatory method-seat handoff", () => {
  assert.equal(recorded.finalized.status, "incomplete");
  assert.equal(recorded.finalized.decision?.decision_available, false);
  assert.equal(recorded.finalized.decision?.rating, null);
  assert.equal(recorded.finalized.handoff_contract, "inline_user_response_v1");
  assert.match(recorded.finalized.user_response_markdown, /Final Per-Seat Method Statements/);
  assert.match(recorded.finalized.user_response_markdown, new RegExp(selectedMaster));
  assert.ok(recorded.finalized.user_response_markdown.trimEnd().endsWith("<!-- alphacouncil:handoff-method-seat-tail:v1:end -->"));

  const dir = join(dataDir, "runs", finalizedRunId);
  for (const file of ["decision.json", "manager_synthesis.json", "final_report.md", "user_response.md", "report_quality.json", "artifact_index.md"]) {
    assert.equal(existsSync(join(dir, file)), true, file);
  }
  const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
  assert.equal(status.status, "incomplete");
  assert.equal(status.agents.find((agent) => agent.role === "bull_researcher").status, "failed");
  assert.equal(status.agents.find((agent) => agent.role === "bear_researcher").status, "skipped");
  assert.equal(status.agents.find((agent) => agent.role === "portfolio_manager").status, "skipped");
  const quality = JSON.parse(readFileSync(join(dir, "report_quality.json"), "utf8"));
  assert.equal(quality.handoff_method_statement_coverage.status, "passed", quality.handoff_method_statement_coverage.missing.join("; "));
});

test("visible finalization is idempotent and rejects late worker writes", () => {
  assert.equal(recorded.finalizedReplay.idempotent_replay, true);
  assert.equal(recorded.finalizedReplay.user_response_markdown.trimEnd(), recorded.finalized.user_response_markdown.trimEnd());
  assert.equal(recorded.lateFinalizedDecision.error?.data?.reason, "VISIBLE_RUN_FINALIZED");
});

test("visible finalization treats failed target arrays as order-independent sets", () => {
  assert.equal(recorded.reorderedFinalizationReplay.idempotent_replay, true);
  assert.equal(
    recorded.reorderedFinalizationReplay.user_response_markdown.trimEnd(),
    recorded.reorderedFinalization.user_response_markdown.trimEnd(),
  );
  const run = JSON.parse(readFileSync(join(dataDir, "runs", reorderedFinalizationRunId, "evidence.json"), "utf8"));
  assert.deepEqual(run.visible_finalization.failed.roles, [
    "bear_researcher",
    "bull_researcher",
  ]);
});

test("visible finalization cannot mislabel a completed seat as failed", () => {
  assert.equal(recorded.invalidFinalizationTarget.error?.data?.reason, "VISIBLE_FINALIZE_TARGET_NOT_OPEN");
  const run = JSON.parse(readFileSync(join(dataDir, "runs", invalidFinalizationTargetRunId, "evidence.json"), "utf8"));
  assert.equal(run.task_status.market_data.status, "completed");
  assert.equal(run.visible_finalization, undefined);
  assert.equal(run.status, "running");
});

test("single-round plus PM is rejected without writing a decision", () => {
  assert.equal(recorded.shortcut.error?.data?.reason, "VISIBLE_PM_PREREQUISITES_INCOMPLETE");
  const dir = join(dataDir, "runs", shortcutRunId);
  assert.equal(existsSync(join(dir, "manager_synthesis.json")), false);
  assert.equal(existsSync(join(dir, "decision.json")), false);
  const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
  assert.notEqual(status.agents.find((agent) => agent.role === "portfolio_manager").status, "completed");
});

test("wrong-language visible packets are structured rejections with no completion write", () => {
  for (const response of [recorded.wrongEvidence, recorded.wrongMaster, recorded.wrongDebate]) {
    assert.equal(response.error?.data?.reason, "READER_LANGUAGE_MISMATCH", JSON.stringify(response).slice(0, 800));
    assert.equal(response.error?.code, -32602);
  }
  assert.equal(recorded.afterWrongEvidence, recorded.beforeWrongEvidence);
  assert.equal(recorded.afterWrongMaster, recorded.beforeWrongMaster);
  assert.equal(recorded.afterWrongDebate, recorded.beforeWrongDebate);
  const dir = join(dataDir, "runs", languageRunId);
  assert.equal(existsSync(join(dir, "bull_researcher.round-1.json")), false);
  const evidence = JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8"));
  assert.match(evidence.packets[0].summary, /visible analyst records sufficient English evidence/);
  assert.doesNotMatch(evidence.master_opinions[0].summary, /这段中文/);
  assert.equal(evidence.master_status[selectedMaster].status, "completed");
  assert.equal(evidence.master_opinions[0].statement_origin, "visible_method_voice_worker");
  assert.equal(evidence.master_opinions[0].dedicated_worker.execution_mode, "visible_host_thread");
  assert.equal(evidence.agent_status.bull_researcher.status, "pending");
});

test("the completed run retains visible provenance and all promised artifacts", () => {
  const dir = join(dataDir, "runs", completeRunId);
  assert.equal(recorded.pm.decision?.thread_id, `thread-${completeRunId}-pm`);
  const trace = readFileSync(join(dir, "all_agents.md"), "utf8");
  assert.match(trace, new RegExp(`thread-${completeRunId}-market_data`));
  assert.match(trace, new RegExp(`thread-${completeRunId}-pm`));
  for (const file of [
    "user_response.md", "artifact_index.md", "report_quality.json", "company_dossier.json",
    ...DEFAULT_TASKS.map((task) => `${task}.md`),
    "portfolio_manager.md", "bull_researcher.md", "bear_researcher.md",
  ]) assert.ok(existsSync(join(dir, file)), `visible run did not write ${file}`);
});

test("portfolio-manager completion returns the saved handoff inline, including the final method statement", () => {
  for (const response of [recorded.pm, recorded.pmReplay]) {
    assert.equal(response.handoff_contract, "inline_user_response_v1");
    assert.match(response.user_response_markdown, /Final Per-Seat Method Statements/);
    assert.match(response.user_response_markdown, new RegExp(selectedMaster));
    assert.ok(response.user_response_markdown.trimEnd().endsWith("<!-- alphacouncil:handoff-method-seat-tail:v1:end -->"));
    assert.equal(response.report_quality, "passed");
  }
  assert.equal(recorded.pmReplay.idempotent_replay, true);
});

test("visible-host status never claims a plugin-enforced deadline or dedicated headless workers", () => {
  const status = JSON.parse(readFileSync(join(dataDir, "runs", completeRunId, "status.json"), "utf8"));
  assert.equal(status.execution_mode, "visible_host_threads");
  assert.equal(status.deadline_enforced, false);
  assert.equal(status.time_budget_ms, null);
  assert.equal(status.deadline_at, null);
  assert.equal(status.remaining_budget_ms, null);
  assert.equal(status.deadline_met, null);
  assert.equal(status.master_worker_contract, "host_managed_not_plugin_enforced");
});

test("an English source title does not fail a Chinese packet's language gate", () => {
  // Regression: `sources[].title` counted against the reader-language ratio, so a packet whose
  // every authored sentence was Chinese was rejected at ratio 0.49. The only way to pass was to
  // translate the citation, which falsifies the source.
  assert.equal(recorded.citation.isError, undefined, JSON.stringify(recorded.citation).slice(0, 400));
  const packet = structured(recorded.citation);
  assert.ok(packet.recorded_tasks.includes("market_data"));
});

test("a portfolio manager report that fails the structure gate can be revised", () => {
  // Regression: the idempotency lock was taken before the structure gate ran, so a thin report
  // left the run stuck at needs_revision with no way back in.
  assert.equal(recorded.thinPm.report_quality, "needs_revision");
  assert.ok(recorded.thinPm.missing_report_items.length > 0);
  assert.equal(recorded.revisedPm.isError, undefined, JSON.stringify(recorded.revisedPm).slice(0, 400));
  const revised = structured(recorded.revisedPm);
  assert.notEqual(revised.report_quality, "needs_revision");
  assert.notEqual(revised.idempotent_replay, true, "a revision is a fresh record, not a replay");
  assert.equal(revised.status, "complete");
});

test("a portfolio manager report that passed stays frozen", () => {
  assert.equal(recorded.pmReplay.idempotent_replay, true);
});

test("a portfolio manager packet with no report body is rejected at submission, not after assembly", async () => {
  // On a real run the first PM submission carried no `report_markdown` at all. It was accepted,
  // the report was assembled from the summary fallback, and the author learned about 21 missing
  // sections only after the whole PM turn had been spent. Reject it up front and say what is
  // owed, without taking the idempotency lock.
  const runId = `SELFTEST-PM-ENTRY-${process.pid}`;
  await plan(runId);
  await recordAllEvidence(runId);
  structured(await recordMaster(runId));
  await recordFullDebate(runId);

  const missingRatingPacket = debatePacket("portfolio_manager", 1, {
    winner: "balanced",
    report_markdown: fullCouncilReport,
    company_dossier_hash_ack: dossier(runId).content_hash,
  });
  delete missingRatingPacket.rating;
  const missingRating = await server.callTool("record_visible_decision", {
    run_id: runId,
    role: "portfolio_manager",
    thread_id: `thread-${runId}-pm-no-rating`,
    packet: missingRatingPacket,
  });
  assert.equal(missingRating.error?.data?.reason, "VISIBLE_INPUT_SCHEMA_MISMATCH");
  assert.equal(missingRating.error?.data?.schema_id, "runtime-debate-packet-v1");
  assert.ok(missingRating.error.data.errors.some((item) => item.missing_property === "rating"));
  assert.ok(!existsSync(join(dataDir, "runs", runId, "decision.json")));

  const rejected = await server.callTool("record_visible_decision", {
    run_id: runId,
    role: "portfolio_manager",
    thread_id: `thread-${runId}-pm`,
    packet: {
      verdict: "The portfolio manager reaches a balanced conclusion after the complete audited debate.",
      rating: "Hold",
      winner: "balanced",
      summary: "A submission that never carried a report body at all.",
      long_thesis: ["The sourced operating fixture supports the conditional long case."],
      short_thesis: ["The sourced risk fixture limits confidence in the long case."],
      valuation_range: "The bounded fixture supports only a conditional valuation range.",
      catalysts: ["A dated primary-source update would test the decision."],
      risks: ["Contradictory primary evidence remains the principal risk."],
      position: "Keep exposure bounded until the next primary-source update.",
      invalidation: ["A contradictory primary filing invalidates the decision."],
      source_ids: ["market_data:S1"],
      confidence: "medium",
      company_dossier_hash_ack: dossier(runId).content_hash,
    },
  });
  assert.ok(rejected.error, `expected a structured rejection, saw ${JSON.stringify(rejected).slice(0, 300)}`);
  assert.equal(rejected.error.data.reason, "VISIBLE_PM_REPORT_SECTIONS_MISSING");
  assert.match(rejected.error.message, /report_markdown/);
  assert.equal(rejected.error.data.report_markdown_characters, 0);
  // The rejection must name the headings that are owed, not just that something is wrong.
  const owed = rejected.error.data.required_sections.map((section) => section.id);
  assert.ok(owed.includes("conclusion"), JSON.stringify(owed));
  assert.ok(owed.includes("source_table"));
  assert.ok(owed.includes("analyst_work_log"));
  // The system appends these, so an author is never asked for them.
  assert.ok(!owed.includes("master_bench"), "the bench is system-owned");
  for (const section of rejected.error.data.required_sections) {
    assert.ok(section.suggested_heading, `${section.id} must come with a heading to use`);
  }

  // Nothing was written, so the run is still revisable and the same author can submit properly.
  assert.ok(!existsSync(join(dataDir, "runs", runId, "decision.json")));
  const accepted = structured(await recordPm(runId));
  assert.equal(accepted.report_quality, "passed");
  assert.equal(accepted.status, "complete");
  assert.notEqual(accepted.idempotent_replay, true);
});

test("visible runtime schemas reject hollow evidence and forged downstream provenance before persistence", async () => {
  const runId = `SELFTEST-STRICT-RUNTIME-${process.pid}`;
  await plan(runId);
  const evidencePath = join(dataDir, "runs", runId, "evidence.json");
  const before = readFileSync(evidencePath, "utf8");
  const hollow = await server.callTool("record_visible_packet", {
    run_id: runId,
    task: "market_data",
    packet: {},
  });
  assert.equal(hollow.error?.data?.reason, "VISIBLE_INPUT_SCHEMA_MISMATCH");
  assert.equal(hollow.error?.data?.schema_id, "runtime-evidence-packet-v1");
  assert.equal(readFileSync(evidencePath, "utf8"), before);

  await recordAllEvidence(runId);
  structured(await recordMaster(runId));
  const forged = await recordRound(
    runId,
    "bull_researcher",
    1,
    debatePacket("bull_researcher", 1, { source_ids: ["market_data:FORGED"] }),
  );
  assert.equal(forged.error?.data?.reason, "SOURCE_PROVENANCE_MISMATCH");
  assert.deepEqual(forged.error?.data?.unknown_source_ids, ["market_data:FORGED"]);
  assert.equal(existsSync(join(dataDir, "runs", runId, "bull_researcher.round-1.json")), false);
});

test("visible news evidence fails closed before persistence when official coverage is only prose", async () => {
  const runId = `SELFTEST-NEWS-OFFICIAL-COVERAGE-${process.pid}`;
  await plan(runId, ["news_industry_management"]);
  const evidencePath = join(dataDir, "runs", runId, "evidence.json");
  const before = readFileSync(evidencePath, "utf8");
  const rejected = await recordEvidence(runId, "news_industry_management", evidencePacket(
    "news_industry_management",
    {
      summary: "This prose says the official surfaces were checked, but supplies no structured coverage record.",
      includeOfficialCoverage: false,
    },
  ));
  assert.equal(rejected.error?.data?.reason, "OFFICIAL_SOURCE_COVERAGE_INVALID");
  assert.equal(rejected.error?.data?.schema_id, "news-official-source-coverage-v1");
  assert.ok(rejected.error?.data?.errors.some((issue) => issue.missing_property === "official_source_coverage"));
  assert.equal(readFileSync(evidencePath, "utf8"), before);
  assert.equal(existsSync(join(dataDir, "runs", runId, "news_industry_management.json")), false);
});
