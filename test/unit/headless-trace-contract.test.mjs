import { test } from "node:test";
import assert from "node:assert/strict";

import { validateHeadlessTrace } from "../../scripts/lib/headless-trace-contract.mjs";

const event = (type, fields = {}) => ({ type, ...fields });

function completeTrace(mode = "full") {
  const full = mode === "full";
  return [
    event("master_selection_consumed"),
    event("run_started"),
    event("evidence_complete"),
    event("masters_started"),
    event("masters_complete"),
    event("debate_started"),
    event("debate_round", { round: 1 }),
    ...(full ? [event("debate_round", { round: 2 }), event("debate_round", { round: 3 })] : []),
    event("debate_qna_gate", { status: full ? "passed" : "not_run" }),
    event("agent_role_completed", { role: "portfolio_manager" }),
    event("run_complete"),
  ];
}

test("complete full and quick traces satisfy the executable stage contract", () => {
  assert.deepEqual(validateHeadlessTrace(completeTrace("full"), { mode: "full" }), []);
  assert.deepEqual(validateHeadlessTrace(completeTrace("quick"), { mode: "quick" }), []);
});

test("negative controls reject evidence, method, debate and PM barrier bypasses", () => {
  const cases = [
    {
      name: "masters before evidence",
      trace: [event("master_selection_consumed"), event("run_started"), event("masters_started"), event("evidence_complete")],
      expected: /masters_started occurred before the evidence barrier/u,
    },
    {
      name: "PM before round three",
      trace: completeTrace("full").filter((item) => !(item.type === "debate_round" && item.round === 3)),
      expected: /portfolio_manager completed before the required debate round/u,
    },
    {
      name: "quick silently grows three rounds",
      trace: completeTrace("full").map((item) => (
        item.type === "debate_qna_gate" ? event("debate_qna_gate", { status: "not_run" }) : item
      )),
      mode: "quick",
      expected: /quick debate rounds must be the ordered prefix 1/u,
    },
    {
      name: "work after terminal",
      trace: [...completeTrace("full"), event("debate_round", { round: 1 })],
      expected: /debate_round occurred after terminal event run_complete/u,
    },
    {
      name: "degraded without the successful quick lifecycle",
      trace: [event("master_selection_consumed"), event("run_started"), event("run_degraded")],
      mode: "quick",
      expected: /run_degraded is missing evidence barrier/u,
    },
    {
      name: "round before debate starts",
      trace: [
        event("master_selection_consumed"), event("run_started"), event("evidence_complete"),
        event("masters_started"), event("masters_complete"), event("debate_round", { round: 1 }),
        event("debate_started"),
      ],
      mode: "quick",
      expected: /debate_round occurred before debate_started/u,
    },
    {
      name: "duplicate terminal milestones",
      trace: [...completeTrace("full"), event("background_run_failed")],
      expected: /multiple terminal events/u,
    },
  ];
  for (const fixture of cases) {
    const errors = validateHeadlessTrace(fixture.trace, { mode: fixture.mode || "full" });
    assert.match(errors.join("\n"), fixture.expected, fixture.name);
  }
});

test("malformed trace records fail closed before lifecycle reasoning", () => {
  assert.deepEqual(validateHeadlessTrace(null), ["events must be an array"]);
  assert.match(validateHeadlessTrace([{}]).join("\n"), /string type/u);
  assert.match(validateHeadlessTrace([], { mode: "visible" }).join("\n"), /unsupported/u);
});
