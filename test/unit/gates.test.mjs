import { test } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../../mcp/server.mjs";
import { completeReport, completeRun, scopedPacket } from "../helpers/fixtures.mjs";
import { DEBATE_ROLES } from "../../mcp/lib/constants.mjs";
import { masterSeatIncomplete } from "../../mcp/lib/gates.mjs";

const {
  verificationStatus,
  withVerificationBanner,
  completenessStatus,
  withCompletenessBanner,
  normalizePacket,
  validateFinalReport,
} = __test__;

test("verificationStatus passes a run with no missing claim sources", () => {
  const gate = verificationStatus({ packets: [scopedPacket()] });
  assert.equal(gate.verification, "passed");
  assert.deepEqual(gate.missing_claim_source_ids, []);
});

test("verificationStatus flags a claim citing an unknown source id", () => {
  const orphan = normalizePacket({
    claims: [{ claim: "c", evidence: "e", confidence: "high", source_ids: ["ghost:S9"] }],
    sources: [],
    confidence: "high",
  }, "market_data", "AAPL", "2026-06-22", "{}");
  const gate = verificationStatus({ packets: [orphan] });
  assert.equal(gate.verification, "needs_verification");
  assert.equal(gate.missing_claim_source_ids.length, 1);
  assert.deepEqual(
    { task: gate.missing_claim_source_ids[0].task, source_id: gate.missing_claim_source_ids[0].source_id },
    { task: "market_data", source_id: "ghost:S9" },
  );
});

test("withVerificationBanner is identity on pass and surfaces the gate on failure", () => {
  const clean = verificationStatus({ packets: [scopedPacket()] });
  assert.equal(withVerificationBanner("BODY", clean, "English"), "BODY");

  const orphan = normalizePacket({
    claims: [{ claim: "c", evidence: "e", confidence: "high", source_ids: ["ghost:S9"] }],
    sources: [],
    confidence: "high",
  }, "market_data", "AAPL", "2026-06-22", "{}");
  const gapped = verificationStatus({ packets: [orphan] });
  assert.match(withVerificationBanner("BODY", gapped, "English"), /Source Verification Gate/);
});

test("complete verifier coverage renders adverse findings without claiming missing verification", () => {
  const gate = {
    verification: "passed",
    adversarial_verification: "completed_with_findings",
    missing_claim_source_ids: [],
    verifier_audit: {
      status: "completed_with_findings",
      non_clean: [{ verifier: "source_fidelity", claim_id: "market_data:C1", verdict: "partial" }],
    },
  };
  const rendered = withVerificationBanner("BODY", gate, "English");
  assert.match(rendered, /Triple-Verification Findings/);
  assert.match(rendered, /source_fidelity: market_data:C1 -> partial/);
  assert.doesNotMatch(rendered, /needs_verification/);
});

test("completenessStatus requires the portfolio manager, not just the researchers", () => {
  // completeRun() leaves portfolio_manager pending on purpose.
  const gate = completenessStatus(completeRun());
  assert.equal(gate.completeness, "incomplete");
  assert.equal(gate.missing_evidence_count, 0);
  assert.deepEqual(gate.missing_debate, ["portfolio_manager"]);
});

test("completenessStatus marks a run complete once the PM is recorded too", () => {
  const run = completeRun();
  run.agent_status.portfolio_manager = { role: "portfolio_manager", status: "completed" };
  const gate = completenessStatus(run);
  assert.equal(gate.completeness, "complete");
  assert.equal(gate.missing_evidence_count, 0);
  assert.equal(gate.missing_debate_count, 0);
});

test("completenessStatus flags a pending evidence task", () => {
  const gate = completenessStatus({
    ...completeRun(),
    task_status: { market_data: { task: "market_data", status: "pending" } },
  });
  assert.equal(gate.completeness, "incomplete");
  assert.equal(gate.evidence_coverage, "incomplete");
  assert.equal(gate.missing_evidence_count, 1);
});

test("completenessStatus never labels failed mandatory evidence as complete coverage", () => {
  const gate = completenessStatus({
    ...completeRun(),
    task_status: { market_data: { task: "market_data", status: "failed", error: "parse_failed" } },
  });
  assert.equal(gate.completeness, "incomplete");
  assert.equal(gate.evidence_coverage, "incomplete");
  assert.deepEqual(gate.missing_evidence, ["market_data"]);
});

test("completenessStatus flags a missing debate researcher", () => {
  const gate = completenessStatus({
    ...completeRun(),
    agent_status: {
      bull_researcher: { role: "bull_researcher", status: "completed" },
      bear_researcher: { role: "bear_researcher", status: "pending" },
      portfolio_manager: { role: "portfolio_manager", status: "pending" },
    },
  });
  assert.equal(gate.completeness, "incomplete");
  assert.ok(gate.missing_debate.includes("bear_researcher"));
});

test("withCompletenessBanner is identity when complete and prepends a banner when not", () => {
  const done = completeRun();
  done.agent_status.portfolio_manager = { role: "portfolio_manager", status: "completed" };
  assert.equal(withCompletenessBanner("BODY", completenessStatus(done), "English"), "BODY");

  const incomplete = completenessStatus({
    ...completeRun(),
    agent_status: {
      bull_researcher: { role: "bull_researcher", status: "completed" },
      bear_researcher: { role: "bear_researcher", status: "pending" },
      portfolio_manager: { role: "portfolio_manager", status: "pending" },
    },
  });
  const banner = withCompletenessBanner("BODY", incomplete, "English");
  assert.match(banner, /Incomplete Council Run/);
  assert.match(banner, /BODY/, "the banner must not replace the body");
});

const qualityRun = {
  ...completeRun(),
  run_id: "QUALITY",
  symbol: "NOK",
  as_of: "2026-06-22",
  dry_run: false,
  language: "English",
  tasks: ["market_data"],
  packets: [scopedPacket()],
};

test("a complete fixture report passes the quality gate", () => {
  assert.equal(validateFinalReport(completeReport, qualityRun).status, "passed");
});

test("a thin report fails the quality gate", () => {
  assert.equal(validateFinalReport("# Thin\n\n## Conclusion\nToo short.", qualityRun).status, "needs_revision");
});

// A run that selected a bench and recorded no opinions used to report itself complete, so
// the most expensive stage could be skipped in silence while the report still read as a
// finished committee. A bench nobody consulted is worse than no bench: the reader believes
// the verdict survived twenty-one lenses when it survived none.
test("a run that skips its selected masters is incomplete, and says which ones", () => {
  const base = {
    tasks: [],
    agent_status: Object.fromEntries(DEBATE_ROLES.map((r) => [r, { role: r, status: "completed" }])),
    masters: ["master_buffett", "master_munger"],
  };
  const none = completenessStatus({ ...base, master_opinions: [] });
  assert.equal(none.completeness, "incomplete");
  assert.deepEqual(none.missing_masters, ["master_buffett", "master_munger"]);
  assert.equal(none.missing_masters_count, 2);

  const partial = completenessStatus({ ...base, master_opinions: [{ master: "master_buffett" }] });
  assert.equal(partial.completeness, "incomplete");
  assert.deepEqual(partial.missing_masters, ["master_munger"]);

  const all = completenessStatus({
    ...base,
    master_opinions: [{ master: "master_buffett" }, { master: "master_munger" }],
  });
  assert.equal(all.completeness, "complete");
  assert.deepEqual(all.missing_masters, []);
});

test("a run that selected no masters is unaffected by the bench gate", () => {
  const status = completenessStatus({
    tasks: [],
    agent_status: Object.fromEntries(DEBATE_ROLES.map((r) => [r, { role: r, status: "completed" }])),
  });
  assert.equal(status.completeness, "complete");
  assert.deepEqual(status.missing_masters, []);
});

test("the incomplete banner names the skipped method seats", () => {
  const status = completenessStatus({
    tasks: [],
    agent_status: Object.fromEntries(DEBATE_ROLES.map((r) => [r, { role: r, status: "completed" }])),
    masters: ["master_marks"],
    master_opinions: [],
  });
  const zh = withCompletenessBanner("body", status, "中文");
  assert.match(zh, /未给出意见的方法席/);
  assert.match(zh, /master_marks/);
  const en = withCompletenessBanner("body", status, "English");
  assert.match(en, /Method seats that gave no opinion/);
});

// A seat that actually decided still owes the run its explanation worker, and the shared
// reading must hold it back until that worker reports. Integration coverage for this moved
// here when declined seats stopped scheduling workers: an all-declined fixture settles before
// the debate opens, so it can no longer exercise the barrier.
test("a seat waiting on its explanation worker blocks the run", () => {
  const run = {
    tasks: [],
    agent_status: Object.fromEntries(DEBATE_ROLES.map((r) => [r, { role: r, status: "completed" }])),
    masters: ["master_natenberg"],
    master_opinions: [{ master: "master_natenberg", stance: "cautious" }],
    master_status: { master_natenberg: { master: "master_natenberg", status: "waiting", voice_required: true } },
  };
  assert.equal(masterSeatIncomplete(run, "master_natenberg"), true);
  assert.equal(completenessStatus(run).completeness, "incomplete");
  assert.deepEqual(completenessStatus(run).missing_masters, ["master_natenberg"]);

  const voiced = {
    ...run,
    master_status: { master_natenberg: { master: "master_natenberg", status: "completed", voice_required: true } },
  };
  assert.equal(masterSeatIncomplete(voiced, "master_natenberg"), false);
  assert.equal(completenessStatus(voiced).completeness, "complete");

  // A deterministically declined seat owes nothing and must not hold the run open.
  const declined = {
    ...run,
    master_opinions: [{ master: "master_natenberg", stance: "out_of_scope" }],
    master_status: {
      master_natenberg: { master: "master_natenberg", status: "completed", voice_required: false, deterministic_decline: true },
    },
  };
  assert.equal(completenessStatus(declined).completeness, "complete");
});
