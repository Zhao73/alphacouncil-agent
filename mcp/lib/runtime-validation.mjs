import {
  validateDebatePacket,
  validateEvidencePacket,
  validateHeadlessPortfolioManagerDecision,
  validateMethodVoice,
  validateNewsEvidencePacket,
  validatePortfolioManagerPacket,
  validateVerifierBatch,
} from "../generated/runtime-validators.mjs";
import { canonicalJson } from "./personas-v3/canonical.mjs";
import { internalError, invalidParams } from "./errors.mjs";

const METHOD_VOICE_PROSE_ARRAYS = Object.freeze([
  "key_findings",
  "disagreements",
  "what_would_change_my_mind",
]);

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
  verifier_batch: Object.freeze({
    id: "runtime-verifier-batch-v1",
    validate: validateVerifierBatch,
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

/**
 * Dedicated method workers occasionally over-structure prose-array entries as JSON objects.
 * Preserve that worker-authored content byte-for-byte at the semantic level by serializing the
 * object canonically before the strict runtime schema sees it. This is deliberately limited to
 * the three prose arrays on headless worker output: visible client packets and provenance fields
 * such as source_ids retain their exact strict schema.
 */
export function normalizeMethodVoiceWorkerTransport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  let normalized = value;
  if (value.transport === "segmented_method_voice_v1") {
    const { transport: _transport, ...packet } = value;
    normalized = packet;
    if (packet.company_dossier_hash_ack === null) {
      const { company_dossier_hash_ack: _hash, ...withoutNullHash } = normalized;
      normalized = withoutNullHash;
    }
    if (normalized.evidence_packet_acks && !Array.isArray(normalized.evidence_packet_acks)
      && typeof normalized.evidence_packet_acks === "object") {
      normalized = {
        ...normalized,
        evidence_packet_acks: Object.entries(normalized.evidence_packet_acks)
          .map(([task, ack]) => ({ task, ...(ack || {}) })),
      };
    }
    if (Array.isArray(normalized.evidence_packet_acks)) {
      const acknowledgedSourceIds = normalized.evidence_packet_acks
        .filter((ack) => ack?.status === "used")
        .flatMap((ack) => Array.isArray(ack?.source_ids) ? ack.source_ids : []);
      normalized = {
        ...normalized,
        // The task-keyed acknowledgements are worker-authored. Binding their cited IDs into the
        // redundant top-level citation list removes transcription drift without inventing a
        // source, fact, disposition or packet use.
        source_ids: [...new Set([
          ...(Array.isArray(normalized.source_ids) ? normalized.source_ids : []),
          ...acknowledgedSourceIds,
        ])],
      };
    }
    if (Array.isArray(normalized.evidence_packet_acks) && normalized.evidence_packet_acks.length === 0) {
      const { evidence_packet_acks: _acks, ...withoutEmptyAcks } = normalized;
      normalized = withoutEmptyAcks;
    }
  }
  for (const field of METHOD_VOICE_PROSE_ARRAYS) {
    const items = normalized[field];
    if (!Array.isArray(items)) continue;
    let changed = false;
    const next = items.map((item, index) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      try {
        changed = true;
        return canonicalJson(item);
      } catch (error) {
        throw internalError(`subagent method voice contained non-canonical JSON prose at /${field}/${index}`, {
          reason: "WORKER_OUTPUT_TRANSPORT_MISMATCH",
          schema_id: "runtime-method-voice-v1",
          kind: "method_voice",
          path: `/${field}/${index}`,
          diagnostic: error instanceof Error ? error.message : String(error),
        });
      }
    });
    if (changed) normalized = { ...normalized, [field]: next };
  }
  return normalized;
}

export function assertRuntimeWorkerPayload(kind, value) {
  return assertRuntimePayload(
    kind,
    kind === "method_voice" ? normalizeMethodVoiceWorkerTransport(value) : value,
  );
}

/** Visible-host packets are client input and therefore surface as JSON-RPC invalid params. */
export function assertRuntimeClientPayload(kind, value, context = {}) {
  return assertRuntimePayload(kind, value, { client: true, context });
}

export const RUNTIME_WORKER_SCHEMA_IDS = Object.freeze(
  Object.fromEntries(Object.entries(VALIDATORS).map(([kind, entry]) => [kind, entry.id])),
);
