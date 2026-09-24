// Minimal keyless HTTP layer: timeouts, bounded retries, a short in-memory cache and an
// injectable fetch so tests never touch the network.

const DEFAULT_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 60_000;
const cache = new Map();

let fetchImpl = (...args) => globalThis.fetch(...args);

/** Replace the fetch implementation (tests). Returns a function that restores the previous one. */
export function setFetch(fn) {
  const previous = fetchImpl;
  fetchImpl = fn;
  cache.clear();
  return () => {
    fetchImpl = previous;
    cache.clear();
  };
}

export function userAgent() {
  const contact = process.env.ALPHACOUNCIL_SEC_CONTACT || "research@alphacouncil.invalid";
  return `AlphaCouncil/2.0 (equity research; ${contact})`;
}

export class HttpError extends Error {
  constructor(message, { status = 0, url = "" } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": userAgent(), ...headers },
        signal: controller.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new HttpError(`HTTP ${res.status} from ${new URL(url).host}`, { status: res.status, url });
        if (attempt < retries) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw lastError;
      }
      if (!res.ok) throw new HttpError(`HTTP ${res.status} from ${new URL(url).host}`, { status: res.status, url });
      return await res.text();
    } catch (error) {
      lastError = error.name === "AbortError"
        ? new HttpError(`timeout after ${timeoutMs}ms from ${new URL(url).host}`, { url })
        : error;
      if (error instanceof HttpError && error.status && error.status < 500 && error.status !== 429) throw error;
      if (attempt >= retries) throw lastError;
      await sleep(500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function fetchText(url, options = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.body;
  const body = await request(url, options);
  cache.set(url, { at: Date.now(), body });
  return body;
}

export async function fetchJson(url, options = {}) {
  const text = await fetchText(url, { ...options, headers: { Accept: "application/json", ...options.headers } });
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`invalid JSON from ${new URL(url).host}`, { url });
  }
}
