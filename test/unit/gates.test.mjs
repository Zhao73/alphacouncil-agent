import { test } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../../mcp/server.mjs";
import { completeReport, completeRun, scopedPacket } from "../helpers/fixtures.mjs";

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
  assert.equal(gate.missing_evidence_count, 1);
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
