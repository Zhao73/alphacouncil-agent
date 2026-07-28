/**
 * Raw source-candidate acquisition for PersonaPack v3 staging.
 *
 * This layer retrieves exact response bytes from one explicit HTTP(S) URL and records an
 * unadjudicated candidate. It has no grade, approval or promotion operation and never reads
 * or writes source-adjudication queues or production manifests.
 */

import { createHash, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  constants as fsConstants,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { hostname as systemHostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalValue, sha256 } from "./canonical.mjs";
import { fsyncDirectoryStrictly } from "./platform-durability.mjs";
import {
  CANONICAL_MASTER_IDS,
  canonicalMasterBlueprints,
  defaultStagingRoot,
  inspectPersonaV3Staging,
} from "./staging.mjs";
import { defaultKnowledgeDir } from "./admission.mjs";
import { defaultPersonaDir } from "../personas/registry.mjs";

export const SOURCE_ACQUISITION_DEFAULTS = Object.freeze({
  timeout_ms: 15_000,
  max_bytes: 10 * 1024 * 1024,
  max_redirects: 3,
});

export const SOURCE_ACQUISITION_LIMITS = Object.freeze({
  timeout_ms: Object.freeze({ min: 100, max: 60_000 }),
  max_bytes: Object.freeze({ min: 1, max: 50 * 1024 * 1024 }),
  max_redirects: Object.freeze({ min: 0, max: 5 }),
});

const CANDIDATE_ID = /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const ACQUISITIONS = "acquisitions";
const CANDIDATES = "candidates";
const WRITE_LOCK = ".acquisition-write.lock";
const TRANSACTION_PREFIX = ".candidate-transaction-";
const WRITE_LEASE_MS = 30_000;
const WRITE_DEAD_OWNER_GRACE_MS = 5_000;
const BLOCKED_IPV4 = new BlockList();
const BLOCKED_IPV6 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) BLOCKED_IPV4.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) BLOCKED_IPV6.addSubnet(address, prefix, "ipv6");
const RECORD_FIELDS = Object.freeze([
  "schema_version",
  "artifact_kind",
  "status",
  "persona_id",
  "candidate_id",
  "requested_url",
  "final_url",
  "redirect_chain",
  "network_trace",
  "retrieved_at",
  "retrieval_protocol",
  "http_status",
  "content_type",
  "content_encoding",
  "byte_length",
  "content_hash",
  "archive_path",
  "limits",
  "human_review",
]);

export class PersonaSourceAcquisitionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PersonaSourceAcquisitionError";
    this.details = details;
  }
}

function fail(message, details = {}) {
  throw new PersonaSourceAcquisitionError(message, details);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function inside(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function exactKeys(value, expected, label, errors) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
  for (const key of expected) if (!(key in value)) errors.push(`${label}.${key} is required`);
}

function integerWithin(value, range, label, errors) {
  if (!Number.isSafeInteger(value) || value < range.min || value > range.max) {
    errors.push(`${label} must be an integer from ${range.min} through ${range.max}`);
    return false;
  }
  return true;
}

export function normalizeAcquisitionLimits(value = {}) {
  if (!isObject(value)) fail("acquisition limits must be an object");
  const unknown = Object.keys(value).filter((key) => !Object.hasOwn(SOURCE_ACQUISITION_DEFAULTS, key));
  if (unknown.length) fail(`unknown acquisition limit(s): ${unknown.join(", ")}`);
  const limits = { ...SOURCE_ACQUISITION_DEFAULTS, ...value };
  const errors = [];
  for (const [key, range] of Object.entries(SOURCE_ACQUISITION_LIMITS)) {
    integerWithin(limits[key], range, `limits.${key}`, errors);
  }
  if (errors.length) fail(`invalid acquisition limits:\n- ${errors.join("\n- ")}`);
  return Object.freeze(canonicalValue(limits));
}

export function normalizeExplicitHttpUrl(value, label = "url") {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} must be an explicit absolute http(s) URL`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) fail(`${label} must use http or https`);
  if (!url.hostname) fail(`${label} must include a hostname`);
  if (url.username || url.password) fail(`${label} must not contain credentials`);
  if (url.hash) fail(`${label} must not contain a fragment`);
  return url.href;
}

function bareHostname(value) {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

export function isPublicNetworkAddress(address, family = isIP(address)) {
  const numericFamily = family === "ipv4" ? 4 : family === "ipv6" ? 6 : Number(family);
  if (isIP(address) !== numericFamily) return false;
  if (numericFamily === 4) return !BLOCKED_IPV4.check(address, "ipv4");
  if (numericFamily !== 6) return false;
  const first = Number.parseInt(address.split(":", 1)[0] || "0", 16);
  if (first < 0x2000 || first > 0x3fff) return false;
  return !BLOCKED_IPV6.check(address, "ipv6");
}

export async function resolvePublicDestination(url, { lookupImpl = dnsLookup } = {}) {
  const normalized = normalizeExplicitHttpUrl(url);
  const parsed = new URL(normalized);
  const hostname = bareHostname(parsed.hostname).toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    fail(`source destination hostname is local or reserved: ${hostname}`);
  }
  const literalFamily = isIP(hostname);
  let answers;
  if (literalFamily) answers = [{ address: hostname, family: literalFamily }];
  else {
    try {
      answers = await lookupImpl(hostname, { all: true, verbatim: true });
    } catch (error) {
      fail(`source destination DNS lookup failed for ${hostname}: ${error.code || error.message}`);
    }
  }
  if (!Array.isArray(answers) || !answers.length) fail(`source destination DNS returned no addresses for ${hostname}`);
  const normalizedAnswers = answers.map((answer) => ({
    address: String(answer?.address || ""),
    family: Number(answer?.family || isIP(answer?.address || "")),
  }));
  for (const answer of normalizedAnswers) {
    if (!isPublicNetworkAddress(answer.address, answer.family)) {
      fail(`source destination resolves to a non-public or reserved address: ${hostname} -> ${answer.address}`);
    }
  }
  normalizedAnswers.sort((a, b) => a.family - b.family || a.address.localeCompare(b.address));
  const chosen = normalizedAnswers[0];
  return Object.freeze({
    url: normalized,
    hostname,
    address: chosen.address,
    family: chosen.family,
  });
}

export function sha256Bytes(bytes) {
  if (!Buffer.isBuffer(bytes)) fail("retrieved bytes must be a Buffer");
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function archivePathForCandidate(candidateId) {
  if (!CANDIDATE_ID.test(candidateId || "")) fail("candidate id is invalid for an archive path");
  return `${ACQUISITIONS}/${CANDIDATES}/${candidateId}/source.bin`;
}

function exactIsoTimestamp(value) {
  if (!nonEmpty(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function validateSourceAcquisitionRecord(record, { label = "source acquisition" } = {}) {
  const errors = [];
  exactKeys(record, RECORD_FIELDS, label, errors);
  if (!isObject(record)) return errors;
  if (record.schema_version !== 1) errors.push(`${label}.schema_version must be 1`);
  if (record.artifact_kind !== "persona_v3_source_acquisition") errors.push(`${label}.artifact_kind is invalid`);
  if (record.status !== "retrieved_unadjudicated") errors.push(`${label}.status must remain retrieved_unadjudicated`);
  if (!CANONICAL_MASTER_IDS.includes(record.persona_id)) errors.push(`${label}.persona_id is not a canonical master`);
  if (!CANDIDATE_ID.test(record.candidate_id || "")) errors.push(`${label}.candidate_id is invalid`);

  let requested = null;
  let final = null;
  try { requested = normalizeExplicitHttpUrl(record.requested_url, `${label}.requested_url`); } catch (error) { errors.push(error.message); }
  try { final = normalizeExplicitHttpUrl(record.final_url, `${label}.final_url`); } catch (error) { errors.push(error.message); }
  if (requested && requested !== record.requested_url) errors.push(`${label}.requested_url must be canonical URL serialization`);
  if (final && final !== record.final_url) errors.push(`${label}.final_url must be canonical URL serialization`);

  if (!Array.isArray(record.redirect_chain) || !record.redirect_chain.length) {
    errors.push(`${label}.redirect_chain must be a non-empty array`);
  } else {
    const normalized = [];
    for (const [index, value] of record.redirect_chain.entries()) {
      try {
        const url = normalizeExplicitHttpUrl(value, `${label}.redirect_chain[${index}]`);
        normalized.push(url);
        if (url !== value) errors.push(`${label}.redirect_chain[${index}] must use canonical URL serialization`);
      } catch (error) {
        errors.push(error.message);
      }
    }
    if (new Set(normalized).size !== normalized.length) errors.push(`${label}.redirect_chain contains a loop or duplicate URL`);
    if (requested && normalized[0] !== requested) errors.push(`${label}.redirect_chain must begin with requested_url`);
    if (final && normalized.at(-1) !== final) errors.push(`${label}.redirect_chain must end with final_url`);
  }

  if (!Array.isArray(record.network_trace) || record.network_trace.length !== record.redirect_chain?.length) {
    errors.push(`${label}.network_trace must have one pinned destination for every redirect-chain URL`);
  } else {
    for (const [index, hop] of record.network_trace.entries()) {
      const hopLabel = `${label}.network_trace[${index}]`;
      exactKeys(hop, ["url", "hostname", "address", "family"], hopLabel, errors);
      if (!isObject(hop)) continue;
      if (hop.url !== record.redirect_chain[index]) errors.push(`${hopLabel}.url must match redirect_chain[${index}]`);
      let parsed = null;
      try { parsed = new URL(normalizeExplicitHttpUrl(hop.url, `${hopLabel}.url`)); } catch (error) { errors.push(error.message); }
      if (parsed && bareHostname(parsed.hostname).toLowerCase() !== hop.hostname) errors.push(`${hopLabel}.hostname does not match url`);
      if (![4, 6].includes(hop.family) || !isPublicNetworkAddress(hop.address, hop.family)) {
        errors.push(`${hopLabel}.address must be a public pinned IP address`);
      }
    }
  }

  if (!exactIsoTimestamp(record.retrieved_at)) errors.push(`${label}.retrieved_at must be an exact ISO-8601 UTC timestamp`);
  if (record.retrieval_protocol !== "http_raw_response_bytes_v1") errors.push(`${label}.retrieval_protocol is invalid`);
  if (!Number.isSafeInteger(record.http_status) || record.http_status < 200 || record.http_status > 299) {
    errors.push(`${label}.http_status must be an integer from 200 through 299`);
  }
  for (const field of ["content_type", "content_encoding"]) {
    if (!(record[field] === null || nonEmpty(record[field]))) errors.push(`${label}.${field} must be null or a non-empty string`);
  }
  if (!Number.isSafeInteger(record.byte_length) || record.byte_length < 1) errors.push(`${label}.byte_length must be a positive integer`);
  if (!HASH.test(record.content_hash || "")) errors.push(`${label}.content_hash must be a sha256 hash`);
  if (CANDIDATE_ID.test(record.candidate_id || "")
    && record.archive_path !== archivePathForCandidate(record.candidate_id)) {
    errors.push(`${label}.archive_path does not match candidate_id`);
  }

  exactKeys(record.limits, ["timeout_ms", "max_bytes", "max_redirects"], `${label}.limits`, errors);
  if (isObject(record.limits)) {
    for (const [key, range] of Object.entries(SOURCE_ACQUISITION_LIMITS)) {
      integerWithin(record.limits[key], range, `${label}.limits.${key}`, errors);
    }
    if (Number.isSafeInteger(record.byte_length) && Number.isSafeInteger(record.limits.max_bytes)
      && record.byte_length > record.limits.max_bytes) {
      errors.push(`${label}.byte_length exceeds the recorded max_bytes`);
    }
    if (Array.isArray(record.redirect_chain) && Number.isSafeInteger(record.limits.max_redirects)
      && record.redirect_chain.length - 1 > record.limits.max_redirects) {
      errors.push(`${label}.redirect_chain exceeds the recorded max_redirects`);
    }
  }

  exactKeys(record.human_review, ["status", "reviewer_ids"], `${label}.human_review`, errors);
  if (isObject(record.human_review)) {
    if (record.human_review.status !== "not_requested") errors.push(`${label}.human_review.status must remain not_requested`);
    if (!Array.isArray(record.human_review.reviewer_ids) || record.human_review.reviewer_ids.length) {
      errors.push(`${label}.human_review.reviewer_ids must remain empty`);
    }
  }
  return errors;
}

function headerValue(value) {
  if (Array.isArray(value)) return value.length ? String(value[0]) : null;
  return value === undefined ? null : String(value);
}

function requestOnce(url, {
  timeoutMs,
  configuredTimeoutMs = timeoutMs,
  maxBytes,
  requestImpl,
  destination,
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timer = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const reject = (error) => settle(rejectPromise, error instanceof Error ? error : new Error(String(error)));
    const transport = requestImpl || (new URL(url).protocol === "https:" ? httpsRequest : httpRequest);
    let request;
    timer = setTimeout(() => {
      request?.destroy(new Error(`source acquisition timed out after ${configuredTimeoutMs}ms`));
      reject(new PersonaSourceAcquisitionError(`source acquisition timed out after ${configuredTimeoutMs}ms`));
    }, timeoutMs);
    try {
      request = transport(url, {
        method: "GET",
        agent: false,
        lookup: (requestedHostname, options, callback) => {
          if (bareHostname(String(requestedHostname)).toLowerCase() !== destination.hostname) {
            callback(new PersonaSourceAcquisitionError("HTTP client requested a hostname outside the DNS-pinned destination"));
            return;
          }
          if (options?.all) callback(null, [{ address: destination.address, family: destination.family }]);
          else callback(null, destination.address, destination.family);
        },
        headers: {
          "accept": "*/*",
          "accept-encoding": "identity",
          "user-agent": "alphacouncil-agent/persona-source-acquirer-v1",
        },
      }, (response) => {
        const status = Number(response.statusCode || 0);
        const location = headerValue(response.headers?.location);
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          if (!location) {
            reject(new PersonaSourceAcquisitionError(`HTTP ${status} redirect did not include Location`));
            return;
          }
          settle(resolvePromise, { redirect: location, status });
          return;
        }
        if (status < 200 || status > 299) {
          response.resume();
          reject(new PersonaSourceAcquisitionError(`source acquisition returned HTTP ${status || "unknown"}`));
          return;
        }
        const declared = Number(headerValue(response.headers?.["content-length"]));
        if (Number.isFinite(declared) && declared > maxBytes) {
          response.destroy();
          reject(new PersonaSourceAcquisitionError(`response Content-Length ${declared} exceeds max_bytes ${maxBytes}`));
          return;
        }
        const chunks = [];
        let total = 0;
        response.on("data", (chunk) => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.length;
          if (total > maxBytes) {
            response.destroy();
            reject(new PersonaSourceAcquisitionError(`response bytes exceed max_bytes ${maxBytes}`));
            return;
          }
          chunks.push(bytes);
        });
        response.on("error", reject);
        response.on("end", () => {
          if (settled) return;
          if (total < 1) {
            reject(new PersonaSourceAcquisitionError("source acquisition returned an empty body"));
            return;
          }
          settle(resolvePromise, {
            status,
            bytes: Buffer.concat(chunks, total),
            content_type: headerValue(response.headers?.["content-type"]),
            content_encoding: headerValue(response.headers?.["content-encoding"]),
          });
        });
      });
      request.on("error", reject);
      request.end();
    } catch (error) {
      reject(error);
    }
  });
}

export async function retrieveExplicitHttpBytes(url, {
  limits = SOURCE_ACQUISITION_DEFAULTS,
  requestImpl,
  lookupImpl = dnsLookup,
  clock = () => Date.now(),
} = {}) {
  const normalizedUrl = normalizeExplicitHttpUrl(url);
  const normalizedLimits = normalizeAcquisitionLimits(limits);
  const deadline = clock() + normalizedLimits.timeout_ms;
  const chain = [normalizedUrl];
  const networkTrace = [];
  let current = normalizedUrl;
  for (;;) {
    const remaining = deadline - clock();
    if (remaining < 1) fail(`source acquisition timed out after ${normalizedLimits.timeout_ms}ms`);
    const destination = await resolvePublicDestination(current, { lookupImpl });
    networkTrace.push(destination);
    const result = await requestOnce(current, {
      timeoutMs: remaining,
      configuredTimeoutMs: normalizedLimits.timeout_ms,
      maxBytes: normalizedLimits.max_bytes,
      requestImpl,
      destination,
    });
    if (!result.redirect) {
      return Object.freeze({
        requested_url: normalizedUrl,
        final_url: current,
        redirect_chain: Object.freeze([...chain]),
        network_trace: Object.freeze(networkTrace.map((hop) => Object.freeze({ ...hop }))),
        http_status: result.status,
        content_type: result.content_type,
        content_encoding: result.content_encoding,
        bytes: Buffer.from(result.bytes),
      });
    }
    if (chain.length - 1 >= normalizedLimits.max_redirects) {
      fail(`source acquisition exceeds max_redirects ${normalizedLimits.max_redirects}`);
    }
    const next = normalizeExplicitHttpUrl(new URL(result.redirect, current).href, "redirect URL");
    if (chain.includes(next)) fail("source acquisition redirect loop detected");
    chain.push(next);
    current = next;
  }
}

function ensureDirectory(parent, dir) {
  if (!inside(parent, dir)) fail("acquisition directory escapes the staging seat", { dir });
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  if (lstatSync(dir).isSymbolicLink()) fail(`acquisition directory must not be a symlink: ${dir}`);
  if (!statSync(dir).isDirectory()) fail(`acquisition path must be a directory: ${dir}`);
  const physical = realpathSync(dir);
  if (!inside(parent, physical)) fail(`acquisition directory resolves outside the staging seat: ${dir}`);
  return physical;
}

function acquisitionPaths(root, personaId, { create = false } = {}) {
  const rootPhysical = realpathSync(root);
  const seat = join(rootPhysical, personaId);
  if (!existsSync(seat) || !statSync(seat).isDirectory()) fail(`staging seat is missing: ${personaId}`);
  if (lstatSync(seat).isSymbolicLink()) fail(`staging seat must not be a symlink: ${personaId}`);
  const seatPhysical = realpathSync(seat);
  if (!inside(rootPhysical, seatPhysical)) fail(`staging seat escapes the staging root: ${personaId}`);
  const acquisitions = join(seatPhysical, ACQUISITIONS);
  const candidates = join(acquisitions, CANDIDATES);
  if (create) {
    ensureDirectory(seatPhysical, acquisitions);
    ensureDirectory(seatPhysical, candidates);
  }
  return { seat: seatPhysical, acquisitions, candidates };
}

function parseRecord(file, errors) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`${file}: invalid JSON (${error.message})`);
    return null;
  }
}

function safeDirectoryEntries(dir, label, errors) {
  if (!existsSync(dir)) return [];
  if (lstatSync(dir).isSymbolicLink()) {
    errors.push(`${label} must not be a symlink`);
    return [];
  }
  if (!statSync(dir).isDirectory()) {
    errors.push(`${label} must be a directory`);
    return [];
  }
  return readdirSync(dir, { withFileTypes: true });
}

function inspectSeatAcquisitions(root, personaId, {
  allowWriteLock = false,
  allowTransactions = false,
} = {}) {
  const errors = [];
  const paths = acquisitionPaths(root, personaId);
  if (!existsSync(paths.acquisitions)) {
    return { persona_id: personaId, retrieved_unadjudicated_count: 0, records: [], errors };
  }
  if (lstatSync(paths.acquisitions).isSymbolicLink()) {
    errors.push(`${personaId}/acquisitions: symlink is forbidden`);
    return { persona_id: personaId, retrieved_unadjudicated_count: 0, records: [], errors };
  }
  if (!statSync(paths.acquisitions).isDirectory()) {
    errors.push(`${personaId}/acquisitions: expected a directory`);
    return { persona_id: personaId, retrieved_unadjudicated_count: 0, records: [], errors };
  }
  const acquisitionEntries = safeDirectoryEntries(paths.acquisitions, `${personaId}/acquisitions`, errors);
  for (const entry of acquisitionEntries) {
    if (entry.name === WRITE_LOCK && allowWriteLock && entry.isFile()) continue;
    if (entry.name.startsWith(TRANSACTION_PREFIX) && allowTransactions && entry.isDirectory()) continue;
    if (entry.name !== CANDIDATES) errors.push(`${personaId}/acquisitions/${entry.name}: unexpected artifact`);
    if (entry.isSymbolicLink()) errors.push(`${personaId}/acquisitions/${entry.name}: symlink is forbidden`);
  }

  const records = [];
  const byCandidate = new Map();
  const byUrl = new Map();
  const byHash = new Map();
  for (const entry of safeDirectoryEntries(paths.candidates, `${personaId}/acquisitions/candidates`, errors)) {
    const candidateErrorCount = errors.length;
    const label = `${personaId}/acquisitions/candidates/${entry.name}`;
    if (entry.isSymbolicLink()) { errors.push(`${label}: symlink is forbidden`); continue; }
    if (!entry.isDirectory() || !CANDIDATE_ID.test(entry.name)) { errors.push(`${label}: expected a candidate directory`); continue; }
    const candidateDir = join(paths.candidates, entry.name);
    const children = safeDirectoryEntries(candidateDir, label, errors);
    for (const child of children) {
      if (!["record.json", "source.bin"].includes(child.name)) errors.push(`${label}/${child.name}: unexpected artifact`);
      if (child.isSymbolicLink()) errors.push(`${label}/${child.name}: symlink is forbidden`);
      if (!child.isFile()) errors.push(`${label}/${child.name}: expected a file`);
    }
    const file = join(candidateDir, "record.json");
    const blob = join(candidateDir, "source.bin");
    if (!existsSync(file)) { errors.push(`${label}: record.json is missing`); continue; }
    if (!existsSync(blob)) { errors.push(`${label}: source.bin is missing`); continue; }
    if (lstatSync(file).isSymbolicLink() || lstatSync(blob).isSymbolicLink()) { errors.push(`${label}: candidate files must not be symlinks`); continue; }
    const record = parseRecord(file, errors);
    if (!record) continue;
    const validation = validateSourceAcquisitionRecord(record, { label });
    errors.push(...validation);
    if (record.persona_id !== personaId) errors.push(`${label}: persona_id does not match its staging seat`);
    if (record.candidate_id !== entry.name) errors.push(`${label}: directory name must match candidate_id`);
    if (byCandidate.has(record.candidate_id)) errors.push(`${label}: duplicate candidate_id`);
    else byCandidate.set(record.candidate_id, label);
    if (byUrl.has(record.requested_url)) errors.push(`${label}: requested_url duplicates ${byUrl.get(record.requested_url)}`);
    else byUrl.set(record.requested_url, label);
    if (byHash.has(record.content_hash)) errors.push(`${label}: content_hash duplicates ${byHash.get(record.content_hash)}`);
    else byHash.set(record.content_hash, label);
    if (validation.length) continue;
    if (resolve(paths.seat, record.archive_path) !== blob) { errors.push(`${label}: archive_path does not resolve to source.bin`); continue; }
    const bytes = readFileSync(blob);
    if (bytes.length !== record.byte_length) errors.push(`${label}: archived byte length does not match metadata`);
    if (sha256Bytes(bytes) !== record.content_hash) errors.push(`${label}: archived byte hash does not match metadata`);
    if (errors.length === candidateErrorCount) records.push(record);
  }

  records.sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
  return canonicalValue({
    persona_id: personaId,
    retrieved_unadjudicated_count: records.length,
    records,
    errors,
  });
}

export function inspectSourceAcquisitions({
  root = defaultStagingRoot(),
  productionRoot = defaultKnowledgeDir(),
  personaDir = defaultPersonaDir(),
  now = new Date(),
  allowTransientArtifacts = false,
} = {}) {
  const staging = inspectPersonaV3Staging({ root, productionRoot, personaDir, now });
  if (staging.global_errors.length || staging.invalid_count || staging.unsafe_artifact_count) {
    fail("PersonaPack v3 staging must pass integrity checks before source acquisition", { staging });
  }
  canonicalMasterBlueprints({ personaDir });
  const personas = CANONICAL_MASTER_IDS.map((personaId) => inspectSeatAcquisitions(staging.staging_root, personaId, {
    allowWriteLock: allowTransientArtifacts,
    allowTransactions: allowTransientArtifacts,
  }));
  const invalidCount = personas.filter((persona) => persona.errors.length).length;
  const stable = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_source_acquisition_inventory",
    canonical_master_count: CANONICAL_MASTER_IDS.length,
    retrieved_unadjudicated_count: personas.reduce((sum, persona) => sum + persona.retrieved_unadjudicated_count, 0),
    approved_count: 0,
    graded_count: 0,
    production_eligible_count: 0,
    invalid_count: invalidCount,
    personas,
  });
  return Object.freeze({
    staging_root: staging.staging_root,
    ...stable,
    generated_at: now.toISOString(),
    acquisition_inventory_hash: sha256(stable),
  });
}

function validateRequest({ personaId, candidateId, url, limits }) {
  if (!CANONICAL_MASTER_IDS.includes(personaId)) fail(`persona must be one of the canonical 26 master IDs: ${personaId}`);
  if (!CANDIDATE_ID.test(candidateId || "")) fail("candidate-id must be 3-64 lowercase letters, digits, underscores or hyphens and start/end alphanumeric");
  return Object.freeze({
    persona_id: personaId,
    candidate_id: candidateId,
    requested_url: normalizeExplicitHttpUrl(url),
    limits: normalizeAcquisitionLimits(limits),
  });
}

function existingSeat(inventory, personaId) {
  return inventory.personas.find((persona) => persona.persona_id === personaId);
}

const LEASE_FIELDS = Object.freeze([
  "schema_version", "artifact_kind", "owner_token", "hostname", "pid", "acquired_at", "expires_at",
]);

function leaseDocument(nowMs) {
  return canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_source_acquisition_write_lease",
    owner_token: randomUUID(),
    hostname: systemHostname(),
    pid: process.pid,
    acquired_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + WRITE_LEASE_MS).toISOString(),
  });
}

function validateLeaseDocument(value) {
  const errors = [];
  exactKeys(value, LEASE_FIELDS, "write lease", errors);
  if (!isObject(value)) return errors;
  if (value.schema_version !== 1) errors.push("write lease.schema_version must be 1");
  if (value.artifact_kind !== "persona_source_acquisition_write_lease") errors.push("write lease.artifact_kind is invalid");
  if (!/^[a-f0-9-]{36}$/u.test(value.owner_token || "")) errors.push("write lease.owner_token is invalid");
  if (!nonEmpty(value.hostname)) errors.push("write lease.hostname is required");
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) errors.push("write lease.pid must be a positive integer");
  if (!exactIsoTimestamp(value.acquired_at) || !exactIsoTimestamp(value.expires_at)) errors.push("write lease timestamps must be exact ISO UTC timestamps");
  if (exactIsoTimestamp(value.acquired_at) && exactIsoTimestamp(value.expires_at)) {
    const duration = Date.parse(value.expires_at) - Date.parse(value.acquired_at);
    if (duration < 1 || duration > WRITE_LEASE_MS) errors.push(`write lease duration must be at most ${WRITE_LEASE_MS}ms`);
  }
  return errors;
}

function localProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readExistingLease(lockFile) {
  if (lstatSync(lockFile).isSymbolicLink()) fail("acquisition write lease must not be a symlink");
  const descriptor = openSync(lockFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) fail("acquisition write lease must be a regular file");
    let document;
    try { document = JSON.parse(readFileSync(descriptor, "utf8")); } catch (error) { fail(`acquisition write lease is invalid JSON: ${error.message}`); }
    const errors = validateLeaseDocument(document);
    if (errors.length) fail(`acquisition write lease is invalid:\n- ${errors.join("\n- ")}`);
    return { document, opened };
  } finally {
    closeSync(descriptor);
  }
}

function recoverStaleLease(lockFile, lease, nowMs) {
  if (lease.document.hostname !== systemHostname()) {
    fail("source acquisition write lease owner is foreign and cannot be verified safely");
  }
  if (localProcessAlive(lease.document.pid)) {
    fail("another source acquisition holds a confirmed live write lease");
  }
  if (nowMs < Date.parse(lease.document.acquired_at) + WRITE_DEAD_OWNER_GRACE_MS) {
    fail(`dead source acquisition owner remains inside the ${WRITE_DEAD_OWNER_GRACE_MS}ms recovery grace`);
  }
  const staleFile = `${lockFile}.stale-${randomUUID()}`;
  renameSync(lockFile, staleFile);
  const moved = lstatSync(staleFile);
  if (moved.isSymbolicLink() || moved.dev !== lease.opened.dev || moved.ino !== lease.opened.ino) {
    fail("acquisition write lease changed during stale recovery");
  }
  unlinkSync(staleFile);
}

function acquireSeatWriteLease(paths, clock) {
  const lockFile = join(paths.acquisitions, WRITE_LOCK);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nowMs = clock();
    const document = leaseDocument(nowMs);
    let descriptor;
    try {
      descriptor = openSync(lockFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      writeFileSync(descriptor, `${JSON.stringify(document)}\n`, "utf8");
      fsyncSync(descriptor);
      return { lockFile, descriptor, opened: fstatSync(descriptor), document };
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        if (existsSync(lockFile) && !lstatSync(lockFile).isSymbolicLink()) unlinkSync(lockFile);
      }
      if (error.code !== "EEXIST") throw error;
      recoverStaleLease(lockFile, readExistingLease(lockFile), nowMs);
    }
  }
  fail("could not acquire source acquisition write lease after stale recovery");
}

function releaseSeatWriteLease(lease) {
  closeSync(lease.descriptor);
  if (!existsSync(lease.lockFile)) fail("acquisition write lease disappeared during commit");
  const current = lstatSync(lease.lockFile);
  if (current.isSymbolicLink() || current.dev !== lease.opened.dev || current.ino !== lease.opened.ino) {
    fail("acquisition write lease changed during commit; refusing unsafe cleanup");
  }
  const document = JSON.parse(readFileSync(lease.lockFile, "utf8"));
  if (document.owner_token !== lease.document.owner_token) fail("acquisition write lease owner changed during commit");
  unlinkSync(lease.lockFile);
}

async function withSeatWriteLease(paths, operation, { clock = () => Date.now() } = {}) {
  const lease = acquireSeatWriteLease(paths, clock);
  try {
    return await operation();
  } finally {
    releaseSeatWriteLease(lease);
  }
}

export function fsyncDirectory(dir, options = {}) {
  return fsyncDirectoryStrictly(dir, {
    openImpl: (target) => openSync(target, fsConstants.O_RDONLY),
    fsyncImpl: fsyncSync,
    closeImpl: closeSync,
    ...options,
  });
}

function cleanupTransactionDirectory(transactionDir) {
  if (!existsSync(transactionDir)) return;
  if (lstatSync(transactionDir).isSymbolicLink() || !statSync(transactionDir).isDirectory()) {
    fail(`unsafe transaction artifact cannot be cleaned: ${transactionDir}`);
  }
  for (const entry of readdirSync(transactionDir, { withFileTypes: true })) {
    const file = join(transactionDir, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || !["record.json", "source.bin"].includes(entry.name)) {
      fail(`unsafe transaction child cannot be cleaned: ${file}`);
    }
    unlinkSync(file);
  }
  rmdirSync(transactionDir);
}

function recoverAbandonedTransactions(paths) {
  for (const entry of readdirSync(paths.acquisitions, { withFileTypes: true })) {
    if (!entry.name.startsWith(TRANSACTION_PREFIX)) continue;
    const transactionDir = join(paths.acquisitions, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) fail(`unsafe acquisition transaction artifact: ${transactionDir}`);
    cleanupTransactionDirectory(transactionDir);
  }
}

function writeAndSync(file, value, options = undefined) {
  const descriptor = openSync(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(descriptor, value, options);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function commitCandidatePair(paths, record, bytes, { beforeRecordWrite = null } = {}) {
  const finalDir = join(paths.candidates, record.candidate_id);
  if (existsSync(finalDir)) fail(`candidate directory already exists: ${record.candidate_id}`);
  const transactionDir = join(paths.acquisitions, `${TRANSACTION_PREFIX}${randomUUID()}`);
  mkdirSync(transactionDir, { mode: 0o700 });
  try {
    writeAndSync(join(transactionDir, "source.bin"), bytes);
    if (beforeRecordWrite) beforeRecordWrite();
    writeAndSync(join(transactionDir, "record.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fsyncDirectory(transactionDir);
    renameSync(transactionDir, finalDir);
    fsyncDirectory(paths.candidates);
  } catch (error) {
    if (existsSync(transactionDir)) cleanupTransactionDirectory(transactionDir);
    throw error;
  }
  return "committed_atomically";
}

export async function runSourceAcquisition({
  write = false,
  personaId,
  candidateId,
  url,
  limits = SOURCE_ACQUISITION_DEFAULTS,
  root = defaultStagingRoot(),
  productionRoot = defaultKnowledgeDir(),
  personaDir = defaultPersonaDir(),
  now = new Date(),
  retrieve = retrieveExplicitHttpBytes,
  leaseClock = () => Date.now(),
  commitHooks = {},
} = {}) {
  const request = validateRequest({ personaId, candidateId, url, limits });
  const inventory = inspectSourceAcquisitions({
    root,
    productionRoot,
    personaDir,
    now,
    allowTransientArtifacts: write,
  });
  const seat = existingSeat(inventory, request.persona_id);
  const sameCandidate = seat.records.find((record) => record.candidate_id === request.candidate_id);
  if (sameCandidate) {
    if (sameCandidate.requested_url !== request.requested_url) {
      fail(`candidate_id ${request.candidate_id} already names a different URL`);
    }
    return Object.freeze({
      mode: write ? "write" : "plan",
      status: "already_retrieved_unadjudicated",
      network_called: false,
      record: sameCandidate,
    });
  }
  const sameUrl = seat.records.find((record) => record.requested_url === request.requested_url);
  if (sameUrl) fail(`requested URL already belongs to candidate_id ${sameUrl.candidate_id}`);
  const paths = acquisitionPaths(inventory.staging_root, request.persona_id, { create: write });
  const target = `${ACQUISITIONS}/${CANDIDATES}/${request.candidate_id}/record.json`;
  if (!write) {
    return Object.freeze({
      mode: "plan",
      status: "network_not_called",
      network_called: false,
      request,
      record_target: target,
    });
  }

  const retrieved = await retrieve(request.requested_url, { limits: request.limits });
  const bytes = Buffer.isBuffer(retrieved?.bytes) ? Buffer.from(retrieved.bytes) : null;
  if (!bytes || !bytes.length) fail("retriever returned no bytes");
  if (bytes.length > request.limits.max_bytes) fail(`retrieved bytes exceed max_bytes ${request.limits.max_bytes}`);
  const requestedUrl = normalizeExplicitHttpUrl(retrieved.requested_url || request.requested_url, "retrieved.requested_url");
  if (requestedUrl !== request.requested_url) fail("retriever changed the requested URL");
  const finalUrl = normalizeExplicitHttpUrl(retrieved.final_url, "retrieved.final_url");
  const chain = Array.isArray(retrieved.redirect_chain) ? retrieved.redirect_chain.map((value, index) => (
    normalizeExplicitHttpUrl(value, `retrieved.redirect_chain[${index}]`)
  )) : [];
  const networkTrace = Array.isArray(retrieved.network_trace) ? retrieved.network_trace.map((hop) => ({
    url: hop?.url,
    hostname: hop?.hostname,
    address: hop?.address,
    family: hop?.family,
  })) : [];
  const contentHash = sha256Bytes(bytes);
  const record = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_source_acquisition",
    status: "retrieved_unadjudicated",
    persona_id: request.persona_id,
    candidate_id: request.candidate_id,
    requested_url: request.requested_url,
    final_url: finalUrl,
    redirect_chain: chain,
    network_trace: networkTrace,
    retrieved_at: now.toISOString(),
    retrieval_protocol: "http_raw_response_bytes_v1",
    http_status: retrieved.http_status,
    content_type: retrieved.content_type ?? null,
    content_encoding: retrieved.content_encoding ?? null,
    byte_length: bytes.length,
    content_hash: contentHash,
    archive_path: archivePathForCandidate(request.candidate_id),
    limits: request.limits,
    human_review: { status: "not_requested", reviewer_ids: [] },
  });
  const validation = validateSourceAcquisitionRecord(record);
  if (validation.length) fail(`retrieved source metadata is invalid:\n- ${validation.join("\n- ")}`);

  return withSeatWriteLease(paths, async () => {
    recoverAbandonedTransactions(paths);
    const current = inspectSeatAcquisitions(inventory.staging_root, request.persona_id, { allowWriteLock: true });
    if (current.errors.length) fail("existing acquisition artifacts failed commit-time integrity verification", { current });
    const currentCandidate = current.records.find((item) => item.candidate_id === request.candidate_id);
    if (currentCandidate) {
      if (currentCandidate.requested_url !== request.requested_url) {
        fail(`candidate_id ${request.candidate_id} already names a different URL`);
      }
      return Object.freeze({
        mode: "write",
        status: "already_retrieved_unadjudicated",
        network_called: true,
        record: currentCandidate,
      });
    }
    const currentUrl = current.records.find((item) => item.requested_url === request.requested_url);
    if (currentUrl) fail(`requested URL already belongs to candidate_id ${currentUrl.candidate_id}`);
    const duplicateContent = current.records.find((item) => item.content_hash === contentHash);
    if (duplicateContent) fail(`retrieved content duplicates candidate_id ${duplicateContent.candidate_id}`);

    const commitStatus = commitCandidatePair(paths, record, bytes, commitHooks);
    const verified = inspectSeatAcquisitions(inventory.staging_root, request.persona_id, { allowWriteLock: true });
    if (verified.errors.length) fail("source acquisition failed post-write integrity verification", { verified });
    return Object.freeze({
      mode: "write",
      status: "retrieved_unadjudicated",
      network_called: true,
      commit_status: commitStatus,
      record,
    });
  }, { clock: leaseClock });
}
