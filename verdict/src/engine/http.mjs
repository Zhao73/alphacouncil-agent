// Keyless HTTP with timeouts, one retry, and a small disk cache so repeat look-ups are instant.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "./store.mjs";

const memory = new Map();
let fetchImpl = (...args) => globalThis.fetch(...args);
let diskCache = !process.env.VERDICT_NO_CACHE;

/** Replace fetch (tests). Returns a restore function. Disables the disk cache meanwhile. */
export function setFetch(fn) {
  const previous = fetchImpl;
  const previousDisk = diskCache;
  fetchImpl = fn;
  diskCache = false;
  memory.clear();
  return () => {
    fetchImpl = previous;
    diskCache = previousDisk;
    memory.clear();
  };
}

export class HttpError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function userAgent() {
  const contact = process.env.VERDICT_SEC_CONTACT || "research@verdict.invalid";
  return `Verdict/1 (equity research; ${contact})`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const host = (url) => new URL(url).host;

function cachePath(url) {
  return join(homeDir(), "cache", `${createHash("sha1").update(url).digest("hex")}.json`);
}

function readCache(url, ttlMs) {
  const hit = memory.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.body;
  if (!diskCache) return null;
  try {
    const disk = JSON.parse(readFileSync(cachePath(url), "utf8"));
    if (Date.now() - disk.at < ttlMs) {
      memory.set(url, disk);
      return disk.body;
    }
  } catch {
    // miss
  }
  return null;
}

function writeCache(url, body) {
  const entry = { at: Date.now(), body };
  memory.set(url, entry);
  if (!diskCache) return;
  try {
    const path = cachePath(url);
    mkdirSync(join(homeDir(), "cache"), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(entry));
    renameSync(`${path}.tmp`, path);
  } catch {
    // cache is best effort
  }
}

async function request(url, { headers = {}, timeoutMs = 12000 } = {}) {
  if (process.env.VERDICT_OFFLINE) throw new HttpError(`offline (VERDICT_OFFLINE): ${host(url)}`);
  let last;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers: { "User-Agent": userAgent(), ...headers }, signal: controller.signal });
      if (res.ok) return await res.text();
      last = new HttpError(`HTTP ${res.status} from ${host(url)}`, res.status);
      if (res.status !== 429 && res.status < 500) throw last;
    } catch (error) {
      if (error instanceof HttpError && error.status && error.status !== 429 && error.status < 500) throw error;
      last = error.name === "AbortError" ? new HttpError(`timeout from ${host(url)}`) : error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt === 0) await sleep(400);
  }
  throw last;
}

export async function fetchText(url, { ttlMs = 5 * 60e3, ...options } = {}) {
  const cached = readCache(url, ttlMs);
  if (cached !== null) return cached;
  const body = await request(url, options);
  writeCache(url, body);
  return body;
}

export async function fetchJson(url, options = {}) {
  const text = await fetchText(url, { ...options, headers: { Accept: "application/json", ...options.headers } });
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`invalid JSON from ${host(url)}`);
  }
}
