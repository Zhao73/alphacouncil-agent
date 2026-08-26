import assert from "node:assert/strict";
import test from "node:test";

import { deriveTimingLedger } from "../../mcp/lib/timing-ledger.mjs";
import { timingLedgerStructureErrors } from "../../scripts/lib/run-bundle.mjs";
import {
  fullTimingFixture,
  rehashTimingEvents,
  truncatedTimingFixture,
} from "../helpers/timing-fixtures.mjs";

test("bundle structure cannot bless a byte-consistent but structurally invalid timing ledger", () => {
  const fixture = fullTimingFixture();
  fixture.events = rehashTimingEvents(fixture.events.filter((event) => event.type !== "run_complete"));
  const invalid = deriveTimingLedger(fixture);
  const errors = timingLedgerStructureErrors(invalid);
  assert.deepEqual(errors.map((entry) => entry.code), ["timing_ledger_structural_invalid"]);
  assert.ok(errors[0].details.issue_codes.includes("terminal_event_missing"));

  assert.deepEqual(timingLedgerStructureErrors(deriveTimingLedger(fullTimingFixture())), []);
  assert.deepEqual(timingLedgerStructureErrors(deriveTimingLedger(truncatedTimingFixture())), []);
});
