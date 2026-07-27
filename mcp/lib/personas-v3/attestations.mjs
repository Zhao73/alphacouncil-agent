import {
  KeyObject,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";

import { canonicalJson } from "./canonical.mjs";

export const ATTESTATION_KEY_ID = /^[A-Za-z0-9._:-]{3,128}$/u;
export const ED25519_SIGNATURE_PREFIX = "ed25519:";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keyObject(value, expectedType) {
  if (expectedType === "public" && !(value instanceof KeyObject)) {
    if (typeof value !== "string" || !/-----BEGIN PUBLIC KEY-----/u.test(value)
      || /PRIVATE KEY/u.test(value)) {
      throw new Error("trusted attestation public keys must be public KeyObjects or PEM public keys");
    }
  }
  const key = value instanceof KeyObject
    ? value
    : expectedType === "private" ? createPrivateKey(value) : createPublicKey(value);
  if (key.type !== expectedType) throw new Error(`attestation key must be a ${expectedType} key`);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("attestation key must use Ed25519");
  return key;
}

function publicDescriptor(keyId, value) {
  const descriptor = isObject(value) && !(value instanceof KeyObject)
    && ("public_key" in value || "publicKey" in value)
    ? value : { public_key: value };
  const allowedFields = new Set([
    "key_id", "public_key", "publicKey", "revoked", "not_before", "not_after",
    "purposes", "principal_id", "subject_id",
  ]);
  const unknownFields = Object.keys(descriptor).filter((field) => !allowedFields.has(field));
  if (unknownFields.length) {
    throw new Error(`trusted attestation key ${keyId} has unknown fields: ${unknownFields.join(", ")}`);
  }
  if (descriptor.key_id !== undefined && descriptor.key_id !== keyId) {
    throw new Error(`trusted attestation key ${keyId} has a mismatched key_id`);
  }
  if (descriptor.public_key !== undefined && descriptor.publicKey !== undefined) {
    throw new Error(`trusted attestation key ${keyId} declares public_key twice`);
  }
  const publicKey = keyObject(descriptor.public_key ?? descriptor.publicKey, "public");
  const purposes = descriptor.purposes === undefined
    ? null
    : new Set(Array.isArray(descriptor.purposes) ? descriptor.purposes : [descriptor.purposes]);
  if (purposes && [...purposes].some((purpose) => typeof purpose !== "string" || !purpose.trim())) {
    throw new Error(`trusted attestation key ${keyId} has an invalid purpose`);
  }
  for (const [field, valueToCheck] of [["not_before", descriptor.not_before], ["not_after", descriptor.not_after]]) {
    if (valueToCheck !== undefined && valueToCheck !== null && !Number.isFinite(Date.parse(valueToCheck))) {
      throw new Error(`trusted attestation key ${keyId} has invalid ${field}`);
    }
  }
  if (descriptor.not_before && descriptor.not_after
    && Date.parse(descriptor.not_before) > Date.parse(descriptor.not_after)) {
    throw new Error(`trusted attestation key ${keyId} has an inverted validity window`);
  }
  if (descriptor.principal_id !== undefined && descriptor.subject_id !== undefined
    && String(descriptor.principal_id).normalize("NFKC").trim()
      !== String(descriptor.subject_id).normalize("NFKC").trim()) {
    throw new Error(`trusted attestation key ${keyId} has conflicting principal identities`);
  }
  const rawPrincipal = descriptor.principal_id ?? descriptor.subject_id ?? null;
  const principalId = rawPrincipal === null ? null : String(rawPrincipal).normalize("NFKC").trim();
  if (rawPrincipal !== null && !principalId) {
    throw new Error(`trusted attestation key ${keyId} has an empty principal_id`);
  }
  return Object.freeze({
    key_id: keyId,
    public_key: publicKey,
    principal_id: principalId,
    revoked: descriptor.revoked === true,
    not_before: descriptor.not_before ?? null,
    not_after: descriptor.not_after ?? null,
    purposes: purposes ? Object.freeze([...purposes].sort()) : null,
  });
}

/** Normalize a Map, object map, or [{key_id, public_key}] list into a verified key registry. */
export function normalizeTrustedKeyRegistry(value) {
  if (value === undefined || value === null || value === "") return new Map();
  let entries;
  if (value instanceof Map) entries = [...value.entries()];
  else if (Array.isArray(value)) entries = value.map((entry) => {
    if (!isObject(entry) || !ATTESTATION_KEY_ID.test(entry.key_id || "")) {
      throw new Error("trusted attestation key list entries require a valid key_id");
    }
    return [entry.key_id, entry];
  });
  else if (isObject(value)) entries = Object.entries(value);
  else throw new Error("trusted attestation key registry must be a Map, object, or array");

  const registry = new Map();
  for (const [rawId, descriptor] of entries) {
    const keyId = String(rawId).trim();
    if (!ATTESTATION_KEY_ID.test(keyId)) throw new Error(`invalid trusted attestation key id ${JSON.stringify(keyId)}`);
    if (registry.has(keyId)) throw new Error(`duplicate trusted attestation key id ${JSON.stringify(keyId)}`);
    registry.set(keyId, publicDescriptor(keyId, descriptor));
  }
  return registry;
}

export function signCanonicalAttestation(payload, { privateKey, signerKeyId } = {}) {
  if (!ATTESTATION_KEY_ID.test(signerKeyId || "")) throw new Error("attestation signer key id is invalid");
  if (isObject(payload) && payload.signer_key_id !== undefined && payload.signer_key_id !== signerKeyId) {
    throw new Error("attestation payload signer_key_id does not match the signing key id");
  }
  const key = keyObject(privateKey, "private");
  const signature = cryptoSign(null, Buffer.from(canonicalJson(payload), "utf8"), key);
  return `${ED25519_SIGNATURE_PREFIX}${signature.toString("base64url")}`;
}

/** Verify a canonical payload and return a reasoned result without trusting a bare key id. */
export function verifyCanonicalAttestation(payload, {
  signature,
  signerKeyId,
  trustedKeyRegistry,
  purpose = null,
  at = null,
} = {}) {
  if (!ATTESTATION_KEY_ID.test(signerKeyId || "")) return { valid: false, reason: "invalid_signer_key_id" };
  if (typeof signature !== "string" || !signature.startsWith(ED25519_SIGNATURE_PREFIX)) {
    return { valid: false, reason: "unsupported_signature_algorithm" };
  }
  let registry;
  try {
    registry = normalizeTrustedKeyRegistry(trustedKeyRegistry);
  } catch (error) {
    return { valid: false, reason: "invalid_trusted_key_registry", error: error.message };
  }
  const descriptor = registry.get(signerKeyId);
  if (!descriptor) return { valid: false, reason: "untrusted_signer" };
  if (descriptor.revoked) return { valid: false, reason: "revoked_signer" };
  if (purpose && (!descriptor.purposes || !descriptor.purposes.includes(purpose))) {
    return { valid: false, reason: "unauthorized_purpose" };
  }
  const atTime = at === null ? Date.now() : Date.parse(at);
  if (!Number.isFinite(atTime)) return { valid: false, reason: "invalid_verification_time" };
  if (descriptor.not_before && atTime < Date.parse(descriptor.not_before)) {
    return { valid: false, reason: "signer_not_yet_valid" };
  }
  if (descriptor.not_after && atTime > Date.parse(descriptor.not_after)) {
    return { valid: false, reason: "signer_expired" };
  }
  const encoded = signature.slice(ED25519_SIGNATURE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{86}$/u.test(encoded)) return { valid: false, reason: "malformed_signature" };
  let bytes;
  try {
    bytes = Buffer.from(encoded, "base64url");
  } catch {
    return { valid: false, reason: "malformed_signature" };
  }
  if (bytes.length !== 64) return { valid: false, reason: "malformed_signature" };
  try {
    const valid = cryptoVerify(
      null,
      Buffer.from(canonicalJson(payload), "utf8"),
      descriptor.public_key,
      bytes,
    );
    return valid
      ? { valid: true, reason: null, key_id: signerKeyId, principal_id: descriptor.principal_id }
      : { valid: false, reason: "invalid_signature" };
  } catch {
    return { valid: false, reason: "invalid_signature" };
  }
}
