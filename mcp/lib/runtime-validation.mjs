import {
  validateDebatePacket,
  validateEvidencePacket,
  validateHeadlessPortfolioManagerDecision,
  validateMethodVoice,
  validateNewsEvidencePacket,
  validatePortfolioManagerPacket,
} from "../generated/runtime-validators.mjs";
import { internalError, invalidParams } from "./errors.mjs";

const VALIDATORS = Object.freeze({
  evidence: Object.freeze({
    id: "runtime-evidence-packet-v1",
    validate: validateEvidencePacket,
  }),
  news_evidence: Object.freeze({
    id: "runtime-news-evidence-packet-v1",
    validate: validateNewsEvidencePacket,
  }),
  debate: Object.freeze({
    id: "runtime-debate-packet-v1",
    validate: validateDebatePacket,
  }),
  headless_portfolio_manager_decision: Object.freeze({
    id: "runtime-headless-portfolio-manager-decision-v1",
    validate: validateHeadlessPortfolioManagerDecision,
  }),
  portfolio_manager: Object.freeze({
    id: "runtime-portfolio-manager-packet-v1",
    validate: validatePortfolioManagerPacket,
  }),
  method_voice: Object.freeze({
    id: "runtime-method-voice-v1",
    validate: validateMethodVoice,
  }),
});

function readableErrors(errors = []) {
  return errors.slice(0, 12).map((error) => ({
    path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message,
    ...(error.params?.missingProperty ? { missing_property: error.params.missingProperty } : {}),
  }));
}

function assertRuntimePayload(kind, value, { client = false, context = {} } = {}) {
  const entry = VALIDATORS[kind];
  if (!entry) throw new TypeError(`unknown runtime worker schema: ${kind}`);
  if (entry.validate(value)) return value;
  const errors = readableErrors(entry.validate.errors);
  const factory = client ? invalidParams : internalError;
  throw factory(`${client ? "submitted packet" : "subagent output"} violated ${entry.id}`, {
    reason: client ? "VISIBLE_INPUT_SCHEMA_MISMATCH" : "WORKER_OUTPUT_SCHEMA_MISMATCH",
    schema_id: entry.id,
    kind,
    errors,
    ...context,
  });
}

export function assertRuntimeWorkerPayload(kind, value) {
  return assertRuntimePayload(kind, value);
}

/** Visible-host packets are client input and therefore surface as JSON-RPC invalid params. */
export function assertRuntimeClientPayload(kind, value, context = {}) {
  return assertRuntimePayload(kind, value, { client: true, context });
}

export const RUNTIME_WORKER_SCHEMA_IDS = Object.freeze(
  Object.fromEntries(Object.entries(VALIDATORS).map(([kind, entry]) => [kind, entry.id])),
);
