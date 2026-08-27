#!/usr/bin/env node
/** Guard the current install surfaces against stale host and Codex invocation guidance. */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export const AUTHORITY_FILES = Object.freeze([
  "README.md",
  "README.zh-CN.md",
  "README.ja.md",
  "docs/INSTALL.md",
  "AGENTS.md",
]);

function readAuthorityFiles(root) {
  return new Map(AUTHORITY_FILES.map((path) => [
    path,
    readFileSync(resolve(root, path), "utf8"),
  ]));
}

function requireMatch(errors, documents, path, pattern, description) {
  if (!pattern.test(documents.get(path))) {
    errors.push(`${path}: missing ${description}`);
  }
}

function forbidMatch(errors, documents, path, pattern, description) {
  if (pattern.test(documents.get(path))) {
    errors.push(`${path}: contains forbidden ${description}`);
  }
}

export function checkInstallDocs(root = repoRoot) {
  const documents = readAuthorityFiles(root);
  const errors = [];
  const install = "docs/INSTALL.md";

  for (const host of ["Codex", "Claude Code", "OpenCode", "Grok Build", "ChatGPT Work"]) {
    requireMatch(errors, documents, install, new RegExp(`\\b${host.replace(" ", "\\s+")}\\b`, "u"), `${host} host coverage`);
  }
  requireMatch(errors, documents, install, /Codex:\s*Skill-first/u, "Codex Skill-first section");
  requireMatch(errors, documents, install, /@alphacouncil-agent AAPL quick/u, "Codex quick invocation");
  requireMatch(errors, documents, install, /codex plugin marketplace add Zhao73\/alphacouncil-agent/u, "GitHub marketplace command");
  requireMatch(errors, documents, install, /codex plugin add alphacouncil-agent@alphacouncil/u, "Codex plugin install command");
  requireMatch(errors, documents, install, /fast[^\n]*15[\s\S]*normal[^\n]*30[\s\S]*slow[^\n]*60/ui, "15/30/60 full-depth tiers");
  requireMatch(errors, documents, install, /npm install -g alphacouncil-agent/u, "npm global install explanation");
  requireMatch(errors, documents, install, /Install in ChatGPT Work developer mode/u, "ChatGPT Work developer-mode section");
  requireMatch(errors, documents, install, /npm run work:test/u, "ChatGPT Work protocol test command");
  requireMatch(errors, documents, install, /https:\/\/\.\.\.\/mcp/u, "ChatGPT Work HTTPS MCP endpoint");
  requireMatch(errors, documents, install, /OAuth 2\.1\/PKCE/u, "ChatGPT Work public-auth boundary");
  requireMatch(errors, documents, "AGENTS.md", /docs\/INSTALL\.md/u, "host setup pointer");

  const localizedRequirements = new Map([
    ["README.md", /Codex, Claude Code, OpenCode, and Grok Build/u],
    ["README.zh-CN.md", /Codex、Claude Code、OpenCode、Grok Build/u],
    ["README.ja.md", /Codex、Claude Code、OpenCode、Grok Build/u],
  ]);
  for (const [path, hostPattern] of localizedRequirements) {
    requireMatch(errors, documents, path, hostPattern, "all four current hosts");
    requireMatch(errors, documents, path, /@alphacouncil-agent AAPL quick/u, "Codex quick invocation");
    requireMatch(errors, documents, path, /15\s*\/\s*30\s*\/\s*60/u, "15/30/60 full-depth tiers");
  }

  for (const path of AUTHORITY_FILES) {
    forbidMatch(errors, documents, path, /~\/\.codex\/prompts/u, "Codex prompt-directory guidance");
    forbidMatch(errors, documents, path, /cp\s+commands\/alpha\.md/u, "Codex prompt-copy command");
    forbidMatch(errors, documents, path, /\b(?:curl|wget)\b[^\n]*(?:raw\.githubusercontent\.com|github\.com\/[^\s]+\/raw\/)/iu, "raw-GitHub download install");
    forbidMatch(errors, documents, path, /(?:<=|≤)\s*30\s*(?:m\b|minutes?\b|分)/iu, "universal 30-minute full-run claim");
    forbidMatch(errors, documents, path, /^\|\s*Codex\s*\|[^\n]*\/alpha/im, "Codex slash-command table row");
  }

  if (errors.length > 0) {
    throw new Error(`install documentation contract failed:\n- ${errors.join("\n- ")}`);
  }

  return Object.freeze({ files: AUTHORITY_FILES.length, hosts: 5, slashHosts: 3 });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const result = checkInstallDocs();
    process.stdout.write(
      `install-docs-check: passed files=${result.files} hosts=${result.hosts} `
      + `codex=skill-first chatgpt_work=developer-mode slash_hosts=${result.slashHosts} tiers=15/30/60 legacy_patterns=0\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
