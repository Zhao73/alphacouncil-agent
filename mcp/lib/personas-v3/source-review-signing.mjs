/** Offline Ed25519 signing for a human-completed source-review request. */

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import {
  closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, statSync, writeFileSync, constants as fsConstants,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalValue, sha256 } from "./canonical.mjs";
import {
  signSourceReviewAttestation,
  sourceReviewSignedPayload,
  validateUnsignedSourceReviewAttestation,
} from "./source-review-attestations.mjs";

function readPrivateKey(file) {
  const target = resolve(file || "");
  if (!file || !existsSync(target)) throw new Error("an existing private-key file is required");
  if (lstatSync(target).isSymbolicLink()) throw new Error("private-key file must not be a symlink");
  const descriptor = openSync(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes;
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) throw new Error("private-key path must be a regular file");
    if ((opened.mode & 0o077) !== 0) throw new Error("private-key file permissions must deny group and other access");
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    const key = createPrivateKey(bytes);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("private key must use Ed25519");
    return { key, target };
  } finally {
    bytes?.fill(0);
  }
}

function publicKeyFingerprint(privateKey) {
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

function validateRequest(request, now) {
  if (request?.signature !== undefined) throw new Error("signing request must not already contain a signature");
  const errors = validateUnsignedSourceReviewAttestation(request, { now });
  if (errors.length) throw new Error(`unsigned source review request is invalid:\n- ${errors.join("\n- ")}`);
}

function inside(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function writeExclusive(file, document, forbiddenFiles, forbiddenRoots) {
  const target = resolve(file || "");
  if (!file) throw new Error("an explicit output file is required for --write");
  if (forbiddenFiles.includes(target)) throw new Error("signed output must differ from the request and private-key files");
  if (existsSync(target)) throw new Error(`signed output already exists; refusing overwrite: ${target}`);
  const parent = dirname(target);
  if (!existsSync(parent) || lstatSync(parent).isSymbolicLink() || !statSync(parent).isDirectory()) {
    throw new Error("signed output parent must be an existing physical directory");
  }
  const physicalParent = realpathSync(parent);
  for (const [label, root] of forbiddenRoots) {
    if (root && inside(realpathSync(root), physicalParent)) {
      throw new Error(`signed review output must not be written inside ${label}`);
    }
  }
  const descriptor = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("signed output must be a regular file");
    writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return target;
}

export function runOfflineSourceReviewSigning({
  write = false,
  request,
  requestFile,
  privateKeyFile,
  outputFile,
  stagingRoot,
  productionRoot,
  now = new Date(),
} = {}) {
  validateRequest(request, now);
  const { key, target: privateKeyPath } = readPrivateKey(privateKeyFile);
  const requestPath = requestFile ? resolve(requestFile) : null;
  const plan = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_source_review_signing_plan",
    mode: write ? "write" : "check",
    wrote: false,
    signer_key_id: request.signer_key_id,
    reviewer_id: request.reviewer_id,
    decision: request.decision,
    content_hash: request.content_hash,
    anchor_hash: request.anchor_hash,
    reviewed_at: request.reviewed_at,
    signed_payload_hash: sha256(sourceReviewSignedPayload(request)),
    public_key_fingerprint: publicKeyFingerprint(key),
    output: outputFile ? resolve(outputFile) : null,
    private_key_output: false,
    identity_generated: false,
    approval_generated: false,
    production_write_count: 0,
  });
  if (!write) return Object.freeze(plan);
  const attestation = signSourceReviewAttestation(canonicalValue(request), {
    privateKey: key,
    signerKeyId: request.signer_key_id,
  });
  const output = writeExclusive(
    outputFile,
    attestation,
    [privateKeyPath, requestPath].filter(Boolean),
    [["the staging tree", stagingRoot], ["production knowledge", productionRoot]],
  );
  return Object.freeze(canonicalValue({
    ...plan,
    wrote: true,
    output,
    attestation_hash: sha256(attestation),
  }));
}
