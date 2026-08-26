/**
 * Bounded HTTP(S) retrieval for server-owned public-source discovery.
 *
 * DNS answers are vetted before the request and the chosen address is returned through
 * the request's lookup callback. Redirects repeat the same process for every hop.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
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

export class PublicHttpError extends Error {
  constructor(message, code = "PUBLIC_HTTP_ERROR") {
    super(message);
    this.name = "PublicHttpError";
    this.code = code;
  }
}
function fail(message, code) {
  throw new PublicHttpError(message, code);
}

function bareHostname(value) {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function headerValue(headers, name) {
  const value = headers?.[String(name).toLowerCase()];
  if (Array.isArray(value)) return value.length ? String(value[0]) : null;
  return value === undefined ? null : String(value);
}

export function normalizePublicHttpUrl(value, { label = "url", stripHash = true } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be an explicit absolute http(s) URL`, "INVALID_URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    fail(`${label} must use http or https`, "INVALID_PROTOCOL");
  }
  if (!parsed.hostname) fail(`${label} must include a hostname`, "INVALID_HOSTNAME");
  if (parsed.username || parsed.password) fail(`${label} must not contain credentials`, "URL_CREDENTIALS");
  if (stripHash) parsed.hash = "";
  else if (parsed.hash) fail(`${label} must not contain a fragment`, "URL_FRAGMENT");
  return parsed.href;
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

export function isReservedHttpHostname(value) {
  const hostname = bareHostname(String(value || "")).toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  const family = isIP(hostname);
  return family ? !isPublicNetworkAddress(hostname, family) : false;
}

export async function resolvePublicHttpDestination(url, { lookupImpl = dnsLookup } = {}) {
  const normalized = normalizePublicHttpUrl(url);
  const parsed = new URL(normalized);
  const hostname = bareHostname(parsed.hostname).toLowerCase();
  if (isReservedHttpHostname(hostname)) {
    fail(`HTTP destination hostname is local, private, or reserved: ${hostname}`, "UNSAFE_DESTINATION");
  }

  const literalFamily = isIP(hostname);
  let answers;
  if (literalFamily) {
    answers = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      answers = await lookupImpl(hostname, { all: true, verbatim: true });
    } catch (error) {
      fail(`HTTP destination DNS lookup failed for ${hostname}: ${error.code || error.message}`, "DNS_LOOKUP_FAILED");
    }
  }
  if (!Array.isArray(answers) || !answers.length) {
    fail(`HTTP destination DNS returned no addresses for ${hostname}`, "DNS_NO_RESULTS");
  }

  const normalizedAnswers = answers.map((answer) => ({
    address: String(answer?.address || ""),
    family: Number(answer?.family || isIP(answer?.address || "")),
  }));
  for (const answer of normalizedAnswers) {
    if (!isPublicNetworkAddress(answer.address, answer.family)) {
      fail(
        `HTTP destination resolves to a non-public or reserved address: ${hostname} -> ${answer.address}`,
        "UNSAFE_DESTINATION",
      );
    }
  }
  normalizedAnswers.sort((left, right) => (
    left.family - right.family || left.address.localeCompare(right.address)
  ));
  const chosen = normalizedAnswers[0];
  return Object.freeze({
    url: normalized,
    hostname,
    address: chosen.address,
    family: chosen.family,
  });
}

function retrievalAbortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new PublicHttpError("HTTP retrieval was aborted", "ABORTED");
}

function resolveDestinationWithinDeadline(url, {
  lookupImpl,
  signal,
  timeoutMs,
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", relayAbort);
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const relayAbort = () => settle(rejectPromise, retrievalAbortError(signal));

    if (signal?.aborted) {
      relayAbort();
      return;
    }
    signal?.addEventListener?.("abort", relayAbort, { once: true });
    timer = setTimeout(() => {
      settle(
        rejectPromise,
        new PublicHttpError("HTTP retrieval timed out during DNS lookup", "TIMED_OUT"),
      );
    }, timeoutMs);

    // dns.promises.lookup cannot be cancelled. Racing it still bounds the caller; a
    // late resolver settlement is consumed by this handler and cannot start transport.
    resolvePublicHttpDestination(url, { lookupImpl }).then(
      (destination) => settle(resolvePromise, destination),
      (error) => settle(rejectPromise, error),
    );
  });
}

function requestOnce(url, {
  destination,
  headers,
  maxBytes,
  requestImpl,
  signal,
  timeoutMs,
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let request;
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", relayAbort);
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const reject = (error) => settle(
      rejectPromise,
      error instanceof Error ? error : new PublicHttpError(String(error)),
    );
    const relayAbort = () => {
      const error = retrievalAbortError(signal);
      request?.destroy?.(error);
      reject(error);
    };

    if (signal?.aborted) {
      relayAbort();
      return;
    }
    signal?.addEventListener?.("abort", relayAbort, { once: true });
    timer = setTimeout(() => {
      const error = new PublicHttpError("HTTP retrieval timed out", "TIMED_OUT");
      request?.destroy?.(error);
      reject(error);
    }, timeoutMs);

    try {
      const transport = requestImpl || (new URL(url).protocol === "https:" ? httpsRequest : httpRequest);
      request = transport(url, {
        method: "GET",
        agent: false,
        headers: {
          "accept-encoding": "identity",
          ...headers,
        },
        lookup: (requestedHostname, options, callback) => {
          if (bareHostname(String(requestedHostname)).toLowerCase() !== destination.hostname) {
            callback(new PublicHttpError(
              "HTTP client requested a hostname outside the DNS-pinned destination",
              "PINNED_HOST_MISMATCH",
            ));
            return;
          }
          if (options?.all) callback(null, [{ address: destination.address, family: destination.family }]);
          else callback(null, destination.address, destination.family);
        },
      }, (response) => {
        const status = Number(response.statusCode || 0);
        const location = headerValue(response.headers, "location");
        if (REDIRECT_STATUSES.has(status)) {
          // Redirect bodies are irrelevant and may be unbounded. Close this hop before
          // resolving so a hostile server cannot keep streaming after the deadline was
          // cleared and the next validated hop has started.
          response.destroy();
          if (!location) {
            reject(new PublicHttpError(`HTTP ${status} redirect omitted Location`, "INVALID_REDIRECT"));
            return;
          }
          settle(resolvePromise, { redirect: location, status });
          return;
        }

        const declared = Number(headerValue(response.headers, "content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) {
          response.destroy();
          reject(new PublicHttpError(
            `HTTP Content-Length ${declared} exceeds byte limit ${maxBytes}`,
            "BODY_TOO_LARGE",
          ));
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
            reject(new PublicHttpError(
              `HTTP response exceeds byte limit ${maxBytes}`,
              "BODY_TOO_LARGE",
            ));
            return;
          }
          chunks.push(bytes);
        });
        response.on("error", reject);
        response.on("end", () => {
          settle(resolvePromise, {
            status,
            headers: response.headers || {},
            bytes: Buffer.concat(chunks, total),
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

export async function retrievePublicHttpText(url, {
  headers = {},
  lookupImpl = dnsLookup,
  maxBytes = 1_500_000,
  maxRedirects = 5,
  redirectPolicy,
  requestImpl,
  signal,
  timeoutMs = 12_000,
  clock = () => Date.now(),
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    fail("HTTP byte limit must be a positive safe integer", "INVALID_LIMIT");
  }
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5) {
    fail("HTTP redirect limit must be an integer from 0 through 5", "INVALID_LIMIT");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    fail("HTTP timeout must be a positive safe integer", "INVALID_LIMIT");
  }

  const requestedUrl = normalizePublicHttpUrl(url);
  const deadline = clock() + timeoutMs;
  const chain = [requestedUrl];
  const networkTrace = [];
  let current = requestedUrl;

  for (;;) {
    const lookupBudget = deadline - clock();
    if (lookupBudget < 1) fail("HTTP retrieval timed out", "TIMED_OUT");
    const destination = await resolveDestinationWithinDeadline(current, {
      lookupImpl,
      signal,
      timeoutMs: lookupBudget,
    });
    const remaining = deadline - clock();
    if (remaining < 1) fail("HTTP retrieval timed out", "TIMED_OUT");
    networkTrace.push(destination);
    const response = await requestOnce(current, {
      destination,
      headers,
      maxBytes,
      requestImpl,
      signal,
      timeoutMs: remaining,
    });
    if (!response.redirect) {
      return Object.freeze({
        requested_url: requestedUrl,
        final_url: current,
        redirect_chain: Object.freeze([...chain]),
        network_trace: Object.freeze(networkTrace.map((hop) => Object.freeze({ ...hop }))),
        status: response.status,
        headers: Object.freeze({ ...response.headers }),
        text: response.bytes.toString("utf8"),
      });
    }

    if (chain.length - 1 >= maxRedirects) {
      fail(`HTTP retrieval exceeds redirect limit ${maxRedirects}`, "TOO_MANY_REDIRECTS");
    }
    const next = normalizePublicHttpUrl(new URL(response.redirect, current).href, {
      label: "redirect URL",
    });
    if (chain.includes(next)) fail("HTTP redirect loop detected", "REDIRECT_LOOP");
    if (redirectPolicy && !redirectPolicy({
      from: current,
      to: next,
      status: response.status,
      chain: Object.freeze([...chain]),
    })) {
      fail("HTTP redirect rejected by caller policy", "REDIRECT_BLOCKED");
    }
    chain.push(next);
    current = next;
  }
}
