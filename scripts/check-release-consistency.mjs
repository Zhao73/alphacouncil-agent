#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CANONICAL_MASTER_COUNT } from "../mcp/lib/personas-v3/staging.mjs";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export const PUBLIC_COUNT_FILES = Object.freeze([
  "README.md",
  "README.zh-CN.md",
  "README.ja.md",
  join("docs", "INSTALL.md"),
  "PRODUCT.md",
  "server.json",
  join(".claude-plugin", "plugin.json"),
  join(".codex-plugin", "plugin.json"),
  join("skills", "alphacouncil-agent", "SKILL.md"),
]);

const VERSION_JSON_SPECS = Object.freeze([
  Object.freeze({
    file: join(".claude-plugin", "plugin.json"),
    fields: Object.freeze([["version"]]),
  }),
  Object.freeze({
    file: join(".codex-plugin", "plugin.json"),
    fields: Object.freeze([["version"]]),
  }),
  Object.freeze({
    file: join(".claude-plugin", "marketplace.json"),
    fields: Object.freeze([["metadata", "version"], ["plugins", 0, "version"]]),
  }),
  Object.freeze({
    file: "package-lock.json",
    fields: Object.freeze([["version"], ["packages", "", "version"]]),
  }),
  Object.freeze({
    file: join("work", "package.json"),
    fields: Object.freeze([["version"]]),
  }),
  Object.freeze({
    file: join("work", "package-lock.json"),
    fields: Object.freeze([["version"], ["packages", "", "version"]]),
  }),
  Object.freeze({
    file: "server.json",
    fields: Object.freeze([["version"], ["packages", 0, "version"]]),
  }),
  Object.freeze({
    file: join("data", "build-profile.v1.json"),
    fields: Object.freeze([["package_version"]]),
  }),
]);

const VERSION_TEXT_SPECS = Object.freeze([
  Object.freeze({
    file: "CLAUDE.md",
    label: "declared package/plugin version",
    pattern: /declared package\/plugin version is `([^`]+)`/u,
  }),
  Object.freeze({
    file: "AGENTS.md",
    label: "current source release candidate",
    pattern: /Package\/plugin version `([^`]+)` is the current source release candidate/u,
  }),
]);

const PUBLIC_COUNT_PATTERNS = Object.freeze([
  Object.freeze({ kind: "packs", regex: /\b(\d+)\s+physical\s+(?:v3\s+)?packs?(?:\s+manifests?)?\b/giu }),
  Object.freeze({ kind: "packs", regex: /\b(\d+)\s+method\s+lenses?\b/giu }),
  Object.freeze({ kind: "packs", regex: /\b(\d+)\s+method\s+seats?\b/giu }),
  Object.freeze({ kind: "packs", regex: /\b(\d+)-seat\s+catalog\b/giu }),
  Object.freeze({ kind: "packs", regex: /(\d+)\s*个物理\s*pack(?:\s*的\s*manifest)?/giu }),
  Object.freeze({ kind: "packs", regex: /(\d+)\s*个?方法席/giu }),
  Object.freeze({ kind: "tools", regex: /\b(\d+)\s+(?:(?:keyless|MCP|executable\s+method)\s+)?tools?\b/giu }),
  Object.freeze({ kind: "tools", regex: /(\d+)\s*个工具/giu }),
]);

const SEMVER = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
const SEMVER_RE = new RegExp(`^${SEMVER}$`, "u");
const TAG_RE = new RegExp(`^v(${SEMVER})$`, "u");

export class ReleaseConsistencyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseConsistencyError";
    this.code = code;
  }
}

function readJson(root, file) {
  return JSON.parse(readFileSync(join(root, file), "utf8"));
}

function nested(value, path) {
  let current = value;
  for (const part of path) current = current?.[part];
  return current;
}

function location(file, path) {
  return `${file}:${path.map(String).join(".")}`;
}

export function collectVersionDeclarations(root = repoRoot) {
  const canonical = readJson(root, "package.json").version;
  const declarations = [];
  for (const spec of VERSION_JSON_SPECS) {
    let document;
    try {
      document = readJson(root, spec.file);
    } catch (error) {
      declarations.push(Object.freeze({
        file: spec.file,
        location: spec.file,
        version: null,
        readError: error.message,
      }));
      continue;
    }
    for (const field of spec.fields) {
      declarations.push(Object.freeze({
        file: spec.file,
        location: location(spec.file, field),
        version: nested(document, field) ?? null,
        readError: null,
      }));
    }
  }
  for (const spec of VERSION_TEXT_SPECS) {
    let text;
    try {
      text = readFileSync(join(root, spec.file), "utf8");
    } catch (error) {
      declarations.push(Object.freeze({
        file: spec.file,
        location: `${spec.file}:${spec.label}`,
        version: null,
        readError: error.message,
      }));
      continue;
    }
    declarations.push(Object.freeze({
      file: spec.file,
      location: `${spec.file}:${spec.label}`,
      version: text.match(spec.pattern)?.[1] ?? null,
      readError: null,
    }));
  }
  return Object.freeze({ canonical, declarations: Object.freeze(declarations) });
}

function issue(code, message, fields = {}) {
  return Object.freeze({ code, message, ...fields });
}

function versionIssues(root) {
  try {
    const { canonical, declarations } = collectVersionDeclarations(root);
    const errors = [];
    if (typeof canonical !== "string" || !SEMVER_RE.test(canonical)) {
      errors.push(issue(
        "VERSION_MISMATCH",
        `package.json:version must be a semantic version; received ${canonical ?? "<missing>"}`,
        { file: "package.json", expected: "semver", actual: canonical ?? null },
      ));
    }
    for (const declaration of declarations) {
      if (declaration.version === canonical && !declaration.readError) continue;
      const actual = declaration.readError ? "<unreadable>" : (declaration.version ?? "<missing>");
      errors.push(issue(
        "VERSION_MISMATCH",
        `${declaration.location} must equal package.json version ${canonical}; received ${actual}`,
        {
          file: declaration.file,
          location: declaration.location,
          expected: canonical,
          actual: declaration.version,
        },
      ));
    }
    return { canonical, errors };
  } catch (error) {
    return {
      canonical: null,
      errors: [issue(
        "VERSION_MISMATCH",
        `package.json:version could not be read (${error.message})`,
        { file: "package.json", expected: "semver", actual: null },
      )],
    };
  }
}

function changelogState(root, canonical) {
  let text;
  try {
    text = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  } catch (error) {
    return {
      top: null,
      unreleased: "missing",
      errors: [
        issue("CHANGELOG_TOP_VERSION_MISMATCH", `CHANGELOG.md could not be read (${error.message})`, { file: "CHANGELOG.md" }),
        issue("CHANGELOG_RELEASE_DATE_MISSING", "CHANGELOG.md has no dated release section", { file: "CHANGELOG.md" }),
      ],
    };
  }

  const releaseHeadings = [...text.matchAll(/^## \[([^\]]+)\](?:\s+—\s+(\d{4}-\d{2}-\d{2}))?\s*$/gmu)]
    .filter((match) => match[1] !== "Unreleased");
  const top = releaseHeadings[0]?.[1] ?? null;
  const date = releaseHeadings[0]?.[2] ?? null;
  const errors = [];
  if (top !== canonical) {
    errors.push(issue(
      "CHANGELOG_TOP_VERSION_MISMATCH",
      `CHANGELOG.md first numeric release must be ${canonical}; received ${top ?? "<missing>"}`,
      { file: "CHANGELOG.md", expected: canonical, actual: top },
    ));
  }
  if (!date) {
    errors.push(issue(
      "CHANGELOG_RELEASE_DATE_MISSING",
      `CHANGELOG.md release ${top ?? canonical ?? "<missing>"} must include — YYYY-MM-DD`,
      { file: "CHANGELOG.md", version: top ?? canonical ?? null },
    ));
  }

  const unreleasedHeading = /^## \[Unreleased\][ \t]*$/mu.exec(text);
  let unreleased = "missing";
  if (unreleasedHeading) {
    const remainder = text.slice(unreleasedHeading.index + unreleasedHeading[0].length);
    const nextHeading = remainder.search(/^## /mu);
    const body = nextHeading === -1 ? remainder : remainder.slice(0, nextHeading);
    unreleased = body.trim() ? "non_empty" : "empty";
  }
  return { top, unreleased, errors };
}

function rangeTail(line, index) {
  return index > 0 && /[-–—]/u.test(line[index - 1]);
}

function publicCountIssues(root, measured) {
  const errors = [];
  if (measured.packCount !== CANONICAL_MASTER_COUNT) {
    errors.push(issue(
      "PUBLIC_COUNT_MISMATCH",
      `physical pack directories must equal CANONICAL_MASTER_COUNT ${CANONICAL_MASTER_COUNT}; measured ${measured.packCount}`,
      {
        file: join("knowledge", "solo-test", "masters"),
        line: null,
        claimed: CANONICAL_MASTER_COUNT,
        measured: measured.packCount,
        kind: "packs",
      },
    ));
  }

  for (const file of PUBLIC_COUNT_FILES) {
    let text;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch (error) {
      errors.push(issue(
        "PUBLIC_COUNT_MISMATCH",
        `${file} could not be read (${error.message})`,
        { file, line: null, claimed: null, measured: null, kind: "file" },
      ));
      continue;
    }
    for (const [lineIndex, line] of text.replace(/\r\n?/gu, "\n").split("\n").entries()) {
      for (const pattern of PUBLIC_COUNT_PATTERNS) {
        pattern.regex.lastIndex = 0;
        for (const match of line.matchAll(pattern.regex)) {
          if (rangeTail(line, match.index ?? 0)) continue;
          const claimed = Number(match[1]);
          const actual = pattern.kind === "packs" ? measured.packCount : measured.toolCount;
          if (claimed === actual) continue;
          errors.push(issue(
            "PUBLIC_COUNT_MISMATCH",
            `${file}:${lineIndex + 1} claims ${claimed} ${pattern.kind}; measured ${actual}`,
            {
              file,
              line: lineIndex + 1,
              claimed,
              measured: actual,
              kind: pattern.kind,
            },
          ));
        }
      }
    }
  }
  return errors;
}

function releaseTagState(tag, canonical) {
  const errors = [];
  const match = typeof tag === "string" ? tag.match(TAG_RE) : null;
  if (!match) {
    errors.push(issue(
      "TAG_FORMAT_INVALID",
      `release tag must match v<semver>; received ${tag || "<empty>"}`,
      { tag: tag || null },
    ));
    return { distTag: null, errors };
  }
  const taggedVersion = match[1];
  if (taggedVersion !== canonical) {
    errors.push(issue(
      "TAG_VERSION_MISMATCH",
      `release tag ${tag} must equal v${canonical}`,
      { tag, expected: canonical, actual: taggedVersion },
    ));
  }
  const prerelease = taggedVersion.match(/-([^+]+)(?:\+|$)/u)?.[1] ?? null;
  if (prerelease && !/^rc\.(?:0|[1-9]\d*)$/u.test(prerelease)) {
    errors.push(issue(
      "TAG_PRERELEASE_ID_UNSUPPORTED",
      `only rc.N prereleases are supported; received ${prerelease}`,
      { tag, prerelease },
    ));
  }
  return { distTag: prerelease ? "rc" : "latest", errors };
}

export function resolveDistTag(tag, packageVersion) {
  const state = releaseTagState(tag, packageVersion);
  if (state.errors.length > 0) {
    const [first] = state.errors;
    throw new ReleaseConsistencyError(first.code, first.message);
  }
  return state.distTag;
}

function sortIssues(errors) {
  return [...errors].sort((left, right) => (
    left.code.localeCompare(right.code)
    || String(left.file ?? "").localeCompare(String(right.file ?? ""))
    || Number(left.line ?? 0) - Number(right.line ?? 0)
    || left.message.localeCompare(right.message)
  ));
}

export function checkReleaseConsistency({ root = repoRoot, mode, tag = null, measured }) {
  if (!measured || !Number.isSafeInteger(measured.packCount) || !Number.isSafeInteger(measured.toolCount)) {
    throw new TypeError("measured.packCount and measured.toolCount must be safe integers");
  }
  if (mode !== "source" && mode !== "tag") throw new TypeError("mode must be source or tag");

  const versions = versionIssues(root);
  const changelog = changelogState(root, versions.canonical);
  const errors = [...versions.errors, ...changelog.errors, ...publicCountIssues(root, measured)];
  let distTag = null;
  const notes = [];
  if (mode === "tag") {
    if (changelog.unreleased !== "empty") {
      errors.push(issue(
        "CHANGELOG_UNRELEASED_NOT_EMPTY",
        `CHANGELOG.md Unreleased section must be empty for a tag; received ${changelog.unreleased}`,
        { file: "CHANGELOG.md", actual: changelog.unreleased },
      ));
    }
    const tagState = releaseTagState(tag, versions.canonical);
    errors.push(...tagState.errors);
    distTag = tagState.distTag;
    if (distTag) notes.push(Object.freeze({ code: "PRERELEASE_DIST_TAG", dist_tag: distTag }));
  } else if (changelog.unreleased === "non_empty") {
    notes.push(Object.freeze({ code: "CHANGELOG_UNRELEASED_NOT_EMPTY", disposition: "source_note" }));
  }

  const sortedErrors = Object.freeze(sortIssues(errors));
  return Object.freeze({
    ok: sortedErrors.length === 0,
    mode,
    version: versions.canonical,
    tag: mode === "tag" ? tag : null,
    distTag,
    packCount: measured.packCount,
    toolCount: measured.toolCount,
    changelogTop: changelog.top,
    unreleased: changelog.unreleased,
    remoteChecks: "out_of_scope_wp6",
    errors: sortedErrors,
    notes: Object.freeze(notes),
  });
}

function printable(value) {
  return value === null || value === undefined || value === "" ? "none" : String(value);
}

export function formatReleaseConsistency(result) {
  const summary = [
    `release-consistency: ${result.ok ? "passed" : "failed"}`,
    `mode=${result.mode}`,
    `version=${printable(result.version)}`,
    `tag=${printable(result.tag)}`,
    `dist_tag=${printable(result.distTag)}`,
    `packs=${result.packCount}`,
    `tools=${result.toolCount}`,
    `changelog_top=${printable(result.changelogTop)}`,
    `unreleased=${result.unreleased}`,
  ].join(" ");
  if (result.ok) return summary;
  return [
    `${summary} errors=${result.errors.length}`,
    ...result.errors.map((error) => `[${error.code}] ${error.message}`),
  ].join("\n");
}

export function measurePackCount(root = repoRoot) {
  const masters = join(root, "knowledge", "solo-test", "masters");
  return readdirSync(masters, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("master_"))
    .length;
}

export async function measureToolCount(root = repoRoot) {
  const dataDir = mkdtempSync(join(tmpdir(), "alphacouncil-release-consistency-"));
  const child = spawn(process.execPath, [join(root, "mcp", "server.mjs")], {
    cwd: root,
    env: { ...process.env, ALPHACOUNCIL_AGENT_DATA_DIR: dataDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const stderr = [];
  let buffer = "";
  let nextId = 1;
  let exited = false;
  let exitCode = null;
  const closed = new Promise((resolveClosed) => {
    child.once("close", (code, signal) => {
      exited = true;
      exitCode = code;
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`MCP server exited code=${code} signal=${signal}; stderr=${stderr.join("")}`));
      }
      pending.clear();
      resolveClosed();
    });
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          for (const waiter of pending.values()) waiter.reject(new Error(`non-JSON MCP output: ${error.message}`));
          pending.clear();
          child.kill();
          break;
        }
        const waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
      newline = buffer.indexOf("\n");
    }
  });

  const request = (method, params = {}) => {
    if (exited) return Promise.reject(new Error(`MCP server already exited with ${exitCode}`));
    const id = nextId++;
    const promise = new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`timeout waiting for ${method}`));
      }, 20_000);
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  };

  try {
    const initialized = await request("initialize", {});
    if (initialized.error || !initialized.result) throw new Error(initialized.error?.message || "MCP initialize failed");
    const listed = await request("tools/list", {});
    if (listed.error || !Array.isArray(listed.result?.tools)) {
      throw new Error(listed.error?.message || "MCP tools/list returned no tools array");
    }
    return listed.result.tools.length;
  } finally {
    if (!exited) child.stdin.end();
    await closed;
    rmSync(dataDir, { recursive: true, force: true });
  }
}

export async function measureReleaseCounts(root = repoRoot) {
  const [toolCount, packCount] = await Promise.all([
    measureToolCount(root),
    Promise.resolve(measurePackCount(root)),
  ]);
  return Object.freeze({ toolCount, packCount });
}

function parseArgs(args) {
  const json = args.includes("--json");
  const positional = args.filter((arg) => arg !== "--json");
  if (positional.length === 1 && positional[0] === "--source") return { mode: "source", tag: null, json };
  if (positional.length === 2 && positional[0] === "--tag") return { mode: "tag", tag: positional[1], json };
  if (!json && positional.length === 2 && positional[0] === "--dist-tag") {
    return { mode: "dist-tag", tag: positional[1], json: false };
  }
  throw new ReleaseConsistencyError(
    "CLI_USAGE_INVALID",
    "usage: check-release-consistency.mjs --source [--json] | --tag TAG [--json] | --dist-tag TAG",
  );
}

async function main(args = process.argv.slice(2)) {
  const parsed = parseArgs(args);
  if (parsed.mode === "dist-tag") {
    const version = readJson(repoRoot, "package.json").version;
    process.stdout.write(`${resolveDistTag(parsed.tag, version)}\n`);
    return;
  }
  const counts = await measureReleaseCounts(repoRoot);
  const result = checkReleaseConsistency({
    root: repoRoot,
    mode: parsed.mode,
    tag: parsed.tag,
    measured: counts,
  });
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`${formatReleaseConsistency(result)}\n`);
    process.stdout.write("remote_checks: out_of_scope (WP-6)\n");
  }
  if (!result.ok) process.exitCode = 1;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    const code = error.code || "RELEASE_CONSISTENCY_ERROR";
    process.stderr.write(`release consistency check failed [${code}]: ${error.message}\n`);
    process.exitCode = 1;
  });
}
