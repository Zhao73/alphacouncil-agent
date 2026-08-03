import { internalError } from "./errors.mjs";

// A council worker should never need anything close to this much JSON. The bound prevents a
// malformed output from turning deterministic repair into an unbounded scan while still leaving
// ample room for a complete PM report embedded in report_markdown.
export const MAX_WORKER_JSON_CHARS = 512_000;
const MAX_TRANSPORT_CANDIDATES = 32;

function parse(value) {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Remove JavaScript-style comments only when they are outside a JSON string. */
export function stripJsonComments(value) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      output += "  ";
      index += 2;
      while (index < value.length && value[index] !== "\n" && value[index] !== "\r") {
        output += " ";
        index += 1;
      }
      if (index < value.length) output += value[index];
      continue;
    }
    if (char === "/" && next === "*") {
      output += "  ";
      index += 2;
      let closed = false;
      while (index < value.length) {
        if (value[index] === "*" && value[index + 1] === "/") {
          output += "  ";
          index += 1;
          closed = true;
          break;
        }
        output += value[index] === "\n" || value[index] === "\r" ? value[index] : " ";
        index += 1;
      }
      if (!closed) return value;
      continue;
    }
    output += char;
  }
  return output;
}

/** Locate the first complete JSON object/array, ignoring braces inside strings. */
function balancedJsonSpan(value) {
  let start = -1;
  let inString = false;
  let escaped = false;
  const expected = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (start === -1) {
      if (char !== "{" && char !== "[") continue;
      start = index;
      expected.push(char === "{" ? "}" : "]");
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      expected.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      if (expected.pop() !== char) return null;
      if (expected.length === 0) {
        return { start, end: index, candidate: value.slice(start, index + 1) };
      }
    }
  }
  return null;
}

export function balancedJsonCandidate(value) {
  return balancedJsonSpan(value)?.candidate || null;
}

/** Remove only commas whose next non-space character closes the current object/array. */
export function stripTrailingCommas(value) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/u.test(value[lookahead] || "")) lookahead += 1;
      if (value[lookahead] === "}" || value[lookahead] === "]") continue;
    }
    output += char;
  }
  return output;
}

function credibleJsonArrayRoot(line) {
  let index = 1;
  while (/\s/u.test(line[index] || "")) index += 1;
  if (index >= line.length) return true;
  const char = line[index];
  if (/[\[\]{"]/u.test(char)) return true;
  if (char === "-" && index + 1 === line.length) return true;

  const literal = /^(?:true|false|null)/u.exec(line.slice(index))?.[0];
  const word = /^[A-Za-z]+/u.exec(line.slice(index))?.[0] || "";
  if (word) {
    if (["true", "false", "null"].some((candidate) => candidate.startsWith(word)) && index + word.length === line.length) {
      return true;
    }
    if (!literal || word !== literal) return false;
    index += literal.length;
    while (/\s/u.test(line[index] || "")) index += 1;
    return index >= line.length || line[index] === "," || line[index] === "]";
  }

  const number = /^-?(?:0|[1-9]\d*)(?:\.\d*)?(?:[eE][+-]?\d*)?/u.exec(line.slice(index))?.[0];
  if (!number) return false;
  index += number.length;
  while (/\s/u.test(line[index] || "")) index += 1;
  return index >= line.length || line[index] === "," || line[index] === "]";
}

function credibleJsonObjectRoot(line) {
  let index = 1;
  while (/\s/u.test(line[index] || "")) index += 1;
  return index >= line.length || line[index] === '"' || line[index] === "}";
}

/**
 * Detect another object/array root after the first complete payload.
 *
 * A later root may be bare, introduced by prose ("correction: {...}"), or placed in a list.
 * An object must begin like JSON (`{"key"`, `{}` or a bare truncated `{`); an array must begin
 * with a valid JSON value token. Scanning every opener keeps those ambiguous payloads fail-closed
 * without mistaking markers such as `{done}`, `[done]`, `[1 of 2]` or Markdown links for JSON.
 */
function hasAdditionalJsonRoot(value) {
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    for (let index = 0; index < line.length; index += 1) {
      const candidate = line.slice(index);
      if (candidate.startsWith("{") && credibleJsonObjectRoot(candidate)) return true;
      if (candidate.startsWith("[") && credibleJsonArrayRoot(candidate)) return true;
    }
  }
  return false;
}

/**
 * Enumerate complete, independently parseable JSON roots without choosing between them.
 * This is used only by schema-aware parse-repair handling: the ordinary transport parser
 * remains fail-closed whenever it sees more than one credible root.
 */
export function parseJsonTransportCandidates(text, { maxChars = MAX_WORKER_JSON_CHARS } = {}) {
  if (typeof text !== "string") {
    throw internalError("subagent did not return JSON text", { reason: "WORKER_JSON_NOT_TEXT" });
  }
  const source = text.replace(/^\uFEFF/u, "");
  if (source.length > maxChars) {
    throw internalError("subagent JSON exceeded the bounded transport-repair limit", {
      reason: "WORKER_JSON_TOO_LARGE",
      output_chars: source.length,
      max_chars: maxChars,
    });
  }

  const normalized = stripJsonComments(source);
  const candidates = [];
  let cursor = 0;
  let spans = 0;
  let malformedCredibleRoot = false;
  while (cursor < normalized.length) {
    const span = balancedJsonSpan(normalized.slice(cursor));
    if (!span) break;
    spans += 1;
    if (spans > MAX_TRANSPORT_CANDIDATES) {
      throw internalError("subagent returned too many JSON transport candidates", {
        reason: "WORKER_JSON_CANDIDATE_LIMIT",
        max_candidates: MAX_TRANSPORT_CANDIDATES,
      });
    }
    const exact = parse(span.candidate);
    if (exact.ok) {
      candidates.push(exact.value);
    } else {
      const withoutTrailingCommas = stripTrailingCommas(span.candidate);
      if (withoutTrailingCommas !== span.candidate) {
        const repaired = parse(withoutTrailingCommas);
        if (repaired.ok) candidates.push(repaired.value);
        else malformedCredibleRoot = malformedCredibleRoot || (span.candidate.startsWith("{")
          ? credibleJsonObjectRoot(span.candidate)
          : credibleJsonArrayRoot(span.candidate));
      } else {
        malformedCredibleRoot = malformedCredibleRoot || (span.candidate.startsWith("{")
          ? credibleJsonObjectRoot(span.candidate)
          : credibleJsonArrayRoot(span.candidate));
      }
    }
    cursor += span.end + 1;
  }

  // A complete first packet followed by a truncated second packet is still ambiguous. Never
  // let schema-aware arbitration turn that case into an accepted first packet.
  if (hasAdditionalJsonRoot(normalized.slice(cursor))) {
    throw internalError("subagent returned an incomplete additional JSON payload", {
      reason: "WORKER_JSON_INCOMPLETE_ADDITIONAL_VALUE",
    });
  }
  if (malformedCredibleRoot) {
    throw internalError("subagent returned a malformed additional JSON payload", {
      reason: "WORKER_JSON_MALFORMED_ADDITIONAL_VALUE",
    });
  }
  return candidates;
}

/**
 * Parse one worker response with a deliberately narrow, deterministic repair envelope.
 *
 * Safe repairs: surrounding prose/fences, comments outside strings, and trailing commas.
 * Unsafe guesses such as single-quote conversion, missing delimiters, unquoted keys or
 * invented values are refused so the existing one-shot no-search model repair remains the
 * only path that may reconstruct a lossy response.
 */
export function parseJsonTransport(text, { maxChars = MAX_WORKER_JSON_CHARS } = {}) {
  if (typeof text !== "string") {
    throw internalError("subagent did not return JSON text", { reason: "WORKER_JSON_NOT_TEXT" });
  }
  const source = text.replace(/^\uFEFF/u, "");
  if (source.length > maxChars) {
    throw internalError("subagent JSON exceeded the bounded transport-repair limit", {
      reason: "WORKER_JSON_TOO_LARGE",
      output_chars: source.length,
      max_chars: maxChars,
    });
  }

  const exact = parse(source);
  if (exact.ok) return { value: exact.value, strategy: "exact", repaired: false };

  const commentsStripped = stripJsonComments(source);
  const span = balancedJsonSpan(commentsStripped);
  if (!span) {
    throw internalError("subagent did not return JSON that bounded transport repair can safely recover", {
      reason: "WORKER_JSON_UNRECOVERABLE",
      attempted_repairs: ["embedded_object_or_array", "comments", "trailing_commas"],
    });
  }
  const { candidate } = span;

  // Accept prose around one JSON value, but never silently choose the first of two payloads.
  // Any later object/array opener is ambiguous even when that second payload is truncated or
  // malformed, so fail closed instead of discarding it and treating the first packet as complete.
  const suffix = commentsStripped.slice(span.end + 1);
  if (hasAdditionalJsonRoot(suffix)) {
    throw internalError("subagent returned multiple JSON payloads; bounded repair refuses to choose one", {
      reason: "WORKER_JSON_MULTIPLE_VALUES",
    });
  }

  const embedded = parse(candidate);
  if (embedded.ok) {
    const commentsChanged = commentsStripped !== source;
    const embeddedChanged = candidate.trim() !== source.trim();
    return {
      value: embedded.value,
      strategy: commentsChanged ? "comments" : embeddedChanged ? "embedded" : "exact",
      repaired: commentsChanged || embeddedChanged,
    };
  }

  const withoutTrailingCommas = stripTrailingCommas(candidate);
  if (withoutTrailingCommas !== candidate) {
    const repaired = parse(withoutTrailingCommas);
    if (repaired.ok) return { value: repaired.value, strategy: "trailing_commas", repaired: true };
  }

  throw internalError("subagent did not return JSON that bounded transport repair can safely recover", {
    reason: "WORKER_JSON_UNRECOVERABLE",
    attempted_repairs: ["embedded_object_or_array", "comments", "trailing_commas"],
    parse_error: embedded.error?.message || exact.error?.message || "invalid JSON",
  });
}
