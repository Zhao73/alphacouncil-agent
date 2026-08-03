import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { internalError, invalidParams } from "./errors.mjs";

function existingMode(path, requestedMode) {
  if (Number.isInteger(requestedMode)) return requestedMode & 0o777;
  try {
    return statSync(path).mode & 0o777;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function fsyncParentDirectory(path) {
  if (process.platform === "win32") return;
  const fd = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function publishedArtifactRecord(path) {
  if (basename(path) === "publication_manifest.json") return null;
  const markerPath = join(dirname(path), "publication_manifest.json");
  if (!existsSync(markerPath)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch (error) {
    throw internalError(`cannot verify publication marker ${markerPath}: ${error.message}`);
  }
  const absoluteTarget = resolve(path);
  return Object.values(manifest?.artifacts || {}).find(
    (record) => record && typeof record.path === "string" && resolve(record.path) === absoluteTarget,
  ) || null;
}

/**
 * Durably replace a text file without ever exposing partially written bytes.
 *
 * The temporary file is unique and lives beside the destination, so concurrent writers
 * cannot share a staging path and rename remains an atomic same-filesystem operation.
 */
export function writeTextAtomic(path, text, { mode } = {}) {
  const body = String(text);
  const published = publishedArtifactRecord(path);
  if (published) {
    const bytes = Buffer.from(body, "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length === published.byte_length && digest === published.sha256) return;
    throw internalError(`refusing to modify immutable published artifact ${path}`);
  }
  const effectiveMode = existingMode(path, mode);
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let fd;
  let renamed = false;
  try {
    fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      effectiveMode ?? 0o666,
    );
    writeFileSync(fd, body, "utf8");
    if (effectiveMode !== undefined && process.platform !== "win32") fchmodSync(fd, effectiveMode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    renamed = true;
    fsyncParentDirectory(path);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original write failure.
      }
    }
    if (!renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        // The temp file may never have been created; nothing to clean up.
      }
    }
    throw internalError(`failed to atomically write ${path}: ${error.message}`);
  }
}

/** Write JSON through the same durable atomic publication path as text artifacts. */
export function writeJson(path, value, { mode } = {}) {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

export function readJson(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw invalidParams(`not found: ${path}`);
    throw internalError(`failed to read ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw internalError(`corrupt JSON at ${path}: ${error.message}`);
  }
}

/** Hash every event field except the hash itself, preserving its serialized key order. */
export function jsonlEntryHash(entry) {
  const subject = { ...entry };
  delete subject.event_hash;
  return `sha256:${createHash("sha256").update(JSON.stringify(subject)).digest("hex")}`;
}

function jsonlResult(entries, parseErrors, metadata = {}) {
  const result = { entries, parse_errors: parseErrors };
  // Recovery metadata is intentionally non-enumerable so the established public return
  // shape remains backward compatible for callers that compare or serialize it.
  for (const [key, value] of Object.entries(metadata)) {
    Object.defineProperty(result, key, { value, enumerable: false });
  }
  return result;
}

function corruptJsonl(path, line, reason) {
  return internalError(`corrupt JSONL at ${path}:${line}: ${reason}`, { path, line, reason });
}

/**
 * Read newline-delimited JSON and verify an upgraded event hash chain when present.
 *
 * Legacy unhashed logs remain readable. Only one malformed, unterminated final line is
 * recoverable; malformed complete/middle lines and any sequence/hash break are explicit
 * corruption errors rather than silently discarded audit evidence.
 */
export function readJsonl(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return jsonlResult([], 0, { valid_bytes: 0, ends_with_newline: true, trailing_partial: false });
    throw internalError(`failed to read ${path}: ${error.message}`);
  }

  const entries = [];
  const lines = text.split("\n");
  let parseErrors = 0;
  let byteOffset = 0;
  let chainStarted = false;
  let previousSequence = 0;
  let previousHash = null;
  let validBytes = Buffer.byteLength(text, "utf8");
  let trailingPartial = false;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const isFinalSegment = index === lines.length - 1;
    const terminated = !isFinalSegment;
    const lineBytes = Buffer.byteLength(line, "utf8");
    const nextOffset = byteOffset + lineBytes + (terminated ? 1 : 0);
    const trimmed = line.trim();
    if (!trimmed) {
      byteOffset = nextOffset;
      continue;
    }

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (error) {
      if (isFinalSegment && !terminated) {
        parseErrors = 1;
        trailingPartial = true;
        validBytes = byteOffset;
        break;
      }
      throw corruptJsonl(path, lineNumber, `invalid JSON: ${error.message}`);
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw corruptJsonl(path, lineNumber, "entry must be a JSON object");
    }

    const hasEventHash = Object.hasOwn(entry, "event_hash");
    const hasPreviousHash = Object.hasOwn(entry, "prev_hash");
    if (!hasEventHash && !hasPreviousHash) {
      if (chainStarted) throw corruptJsonl(path, lineNumber, "legacy entry appears after hash chain started");
      entries.push(entry);
      previousSequence = entries.length;
      byteOffset = nextOffset;
      continue;
    }
    if (!hasEventHash || !hasPreviousHash) {
      throw corruptJsonl(path, lineNumber, "incomplete hash-chain metadata");
    }
    if (!Number.isInteger(entry.seq) || entry.seq !== previousSequence + 1) {
      throw corruptJsonl(path, lineNumber, `non-monotonic seq ${String(entry.seq)}; expected ${previousSequence + 1}`);
    }
    const expectedPreviousHash = chainStarted ? previousHash : null;
    if (entry.prev_hash !== expectedPreviousHash) {
      throw corruptJsonl(path, lineNumber, "prev_hash does not match the previous event");
    }
    const expectedHash = jsonlEntryHash(entry);
    if (entry.event_hash !== expectedHash) {
      throw corruptJsonl(path, lineNumber, "event_hash does not match event content");
    }
    chainStarted = true;
    previousSequence = entry.seq;
    previousHash = entry.event_hash;
    entries.push(entry);
    byteOffset = nextOffset;
  }

  return jsonlResult(entries, parseErrors, {
    valid_bytes: validBytes,
    ends_with_newline: validBytes === 0 || text.slice(0, validBytes).endsWith("\n"),
    trailing_partial: trailingPartial,
  });
}
