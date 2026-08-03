import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

import { parseJsonTransport } from "../../mcp/lib/bounded-json.mjs";
import {
  assertRuntimeWorkerPayload,
  RUNTIME_WORKER_SCHEMA_IDS,
} from "../../mcp/lib/runtime-validation.mjs";

const KINDS = Object.freeze([null, "evidence", "debate", "method_voice"]);
const TRANSPORT_REASONS = new Set([
  "WORKER_JSON_UNRECOVERABLE",
  "WORKER_JSON_MULTIPLE_VALUES",
  "WORKER_JSON_TOO_LARGE",
]);
const STRATEGIES = new Set(["exact", "embedded", "comments", "trailing_commas"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);
const RATINGS = new Set(["Buy", "Overweight", "Hold", "Underweight", "Sell"]);
const WINNERS = new Set(["bull", "bear", "balanced", "unknown"]);
const STANCES = new Set(["constructive", "cautious", "opposed", "out_of_scope"]);
const MAX_FUZZ_CHARS = 32_768;

function laneFor(buffer) {
  if (buffer.length === 0) return 0;
  const first = buffer[0];
  return first >= 48 && first <= 51 ? first - 48 : first % KINDS.length;
}

function transportError(error) {
  const reason = error?.data?.reason;
  assert.ok(TRANSPORT_REASONS.has(reason), `unexpected transport error: ${error?.stack || error}`);
  if (reason === "WORKER_JSON_TOO_LARGE") {
    assert.equal(error.data.output_chars > error.data.max_chars, true);
    assert.equal(error.data.max_chars, MAX_FUZZ_CHARS);
  }
}

function validationOutcome(kind, value) {
  try {
    const result = assertRuntimeWorkerPayload(kind, value);
    assert.equal(result, value, "runtime validation must preserve the input object reference");
    return { ok: true };
  } catch (error) {
    assert.equal(error?.data?.reason, "WORKER_OUTPUT_SCHEMA_MISMATCH");
    assert.equal(error.data.schema_id, RUNTIME_WORKER_SCHEMA_IDS[kind]);
    assert.ok(Array.isArray(error.data.errors));
    assert.ok(error.data.errors.length >= 1 && error.data.errors.length <= 12);
    for (const item of error.data.errors) {
      assert.equal(typeof item.path, "string");
      assert.equal(typeof item.keyword, "string");
      assert.equal(typeof item.message, "string");
    }
    return { ok: false, errors: error.data.errors };
  }
}

function assertIndependentSchemaMinimum(kind, value) {
  assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true);
  assert.ok(CONFIDENCE.has(value.confidence));
  if (kind === "evidence") {
    for (const field of ["summary", "claims", "metrics", "sources", "open_questions", "confidence"]) {
      assert.ok(Object.hasOwn(value, field));
    }
    assert.ok(value.claims.length > 0 || value.open_questions.length > 0);
    for (const claim of value.claims) assert.ok(claim.source_ids.length > 0);
  } else if (kind === "debate") {
    assert.ok(RATINGS.has(value.rating));
    assert.ok(WINNERS.has(value.winner));
    assert.ok(value.source_ids.length > 0);
  } else {
    assert.match(value.master, /^master_[a-z0-9_]+$/u);
    assert.ok(STANCES.has(value.acknowledged_stance));
    assert.ok(typeof value.statement === "string" && /\S/u.test(value.statement) || value.voice);
    if (value.voice) {
      for (const field of ["what_i_see", "how_my_method_reads_it", "would_i_act", "what_changes_my_mind", "where_i_disagree"]) {
        assert.equal(typeof value.voice[field], "string");
        assert.match(value.voice[field], /\S/u);
      }
    }
  }
}

export function fuzz(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer[0] === 52) {
    const payload = buffer.subarray(1).toString("utf8").slice(0, 1024);
    const separator = buffer[1] % 2 === 0 ? " correction: " : "\n- ";
    const ambiguous = `{"first":1}${separator}{"second":${JSON.stringify(payload)}}`;
    assert.throws(
      () => parseJsonTransport(ambiguous, { maxChars: MAX_FUZZ_CHARS }),
      (error) => error?.data?.reason === "WORKER_JSON_MULTIPLE_VALUES",
      "a prose- or list-introduced second JSON root must fail closed",
    );
    return;
  }
  const lane = laneFor(buffer);
  const text = buffer.subarray(buffer.length ? 1 : 0).toString("utf8");
  const normalized = text.replace(/^\uFEFF/u, "");
  let native;
  let nativeParsed = false;
  try {
    native = JSON.parse(normalized);
    nativeParsed = true;
  } catch {}

  let parsed;
  try {
    parsed = parseJsonTransport(text, { maxChars: MAX_FUZZ_CHARS });
  } catch (error) {
    transportError(error);
    return;
  }

  assert.ok(STRATEGIES.has(parsed.strategy));
  assert.equal(parsed.repaired, parsed.strategy !== "exact");
  if (nativeParsed) {
    assert.equal(parsed.strategy, "exact");
    assert.equal(parsed.repaired, false);
    assert.ok(isDeepStrictEqual(parsed.value, native));
  }

  const canonical = JSON.stringify(parsed.value);
  const reparsed = parseJsonTransport(canonical, { maxChars: MAX_FUZZ_CHARS });
  assert.equal(reparsed.strategy, "exact");
  assert.equal(reparsed.repaired, false);
  assert.equal(JSON.stringify(reparsed.value), canonical);

  const kind = KINDS[lane];
  if (!kind) return;
  const before = canonical;
  const prototypeKeys = Reflect.ownKeys(Object.prototype);
  const first = validationOutcome(kind, parsed.value);
  const second = validationOutcome(kind, parsed.value);
  assert.ok(isDeepStrictEqual(first, second), "runtime validation must be deterministic");
  assert.equal(JSON.stringify(parsed.value), before, "runtime validation must not mutate payloads");
  assert.deepEqual(Reflect.ownKeys(Object.prototype), prototypeKeys, "validation polluted Object.prototype");
  if (first.ok) assertIndependentSchemaMinimum(kind, parsed.value);
}
