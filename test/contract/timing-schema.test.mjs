import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import { deriveTimingLedger } from "../../mcp/lib/timing-ledger.mjs";
import {
  fullTimingFixture,
  legacyTimingFixture,
  truncatedTimingFixture,
} from "../helpers/timing-fixtures.mjs";

const SCHEMA_PATH = fileURLToPath(new URL("../../schemas/timing-ledger-v1.schema.json", import.meta.url));

function validator() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  return new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
}

test("the timing schema accepts a real derived ledger and rejects marketing or attempt drift", () => {
  const validate = validator();
  const ledger = deriveTimingLedger(fullTimingFixture());
  assert.equal(validate(ledger), true, JSON.stringify(validate.errors));
  for (const fixture of [
    truncatedTimingFixture(),
    legacyTimingFixture(),
    legacyTimingFixture({ visible: true }),
  ]) {
    const compatibilityLedger = deriveTimingLedger(fixture);
    assert.equal(validate(compatibilityLedger), true, JSON.stringify(validate.errors));
  }

  const marketingClaim = structuredClone(ledger);
  marketingClaim.marketing_eligible = true;
  assert.equal(validate(marketingClaim), false, "a timing ledger can never self-authorize marketing claims");

  const missingAttemptKind = structuredClone(ledger);
  delete missingAttemptKind.attempts[0].attempt_kind;
  assert.equal(validate(missingAttemptKind), false, "attempt causality is required by the published schema");

  const hiddenMultiplier = structuredClone(ledger);
  hiddenMultiplier.speedup_factor = 4;
  assert.equal(validate(hiddenMultiplier), false, "undeclared acceleration fields must not enter a ledger");
});
