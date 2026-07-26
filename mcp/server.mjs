#!/usr/bin/env node
// AlphaCouncil Agent — MCP stdio entry point.
//
// This file must stay at mcp/server.mjs: .claude-plugin/plugin.json hardcodes
// ${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs and .mcp.json hardcodes ./mcp/server.mjs.
// Everything else lives under mcp/lib/.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { VERSION } from "./lib/constants.mjs";
import { cleanLog } from "./lib/text.mjs";
import { resolveLanguage } from "./lib/lang.mjs";
import {
  completenessStatus,
  sourceManifest,
  validateFinalReport,
  verificationStatus,
  withCompletenessBanner,
  withVerificationBanner,
} from "./lib/gates.mjs";
import { artifactPaths, safeSymbol } from "./lib/run-store.mjs";
import { userResponseMarkdown, writeAllAgentsMarkdown } from "./lib/markdown.mjs";
import {
  extractJson,
  mergeDebateRounds,
  normalizeDebate,
  normalizePacket,
  summarizeRun,
} from "./lib/packets.mjs";
import { codexInvocation } from "./lib/codex.mjs";
import { outputModeInstruction, summaryModes } from "./lib/output-modes.mjs";
import { taskPrompt } from "./lib/prompts.mjs";
import { parseStooqCsv, parseYahooChart, resolveMarketSymbol } from "./lib/quotes.mjs";
import { isDryRun } from "./lib/orchestrator.mjs";
import { startStdioServer } from "./lib/rpc.mjs";

export { startStdioServer };

/**
 * Start only when this file is the entry point.
 *
 * Both sides must be real paths. resolve() does not follow symlinks, so an npm install --
 * where node_modules/.bin/alphacouncil-agent is a symlink, and where macOS resolves /var
 * to /private/var -- produced two different strings for the same file and the server
 * silently never started. A published package that starts nothing and prints nothing is
 * the worst failure mode available, so this is compared on realpath.
 */
const realPath = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url))) {
  startStdioServer();
}

/**
 * @deprecated Import from mcp/lib/* directly. Kept so the 0.4.x selfcheck shim and any
 * external consumer keep working; remove in 0.6.0.
 */
export const __test__ = {
  VERSION,
  taskPrompt,
  extractJson,
  normalizePacket,
  normalizeDebate,
  sourceManifest,
  verificationStatus,
  completenessStatus,
  withCompletenessBanner,
  mergeDebateRounds,
  withVerificationBanner,
  summarizeRun,
  safeSymbol,
  summaryModes,
  outputModeInstruction,
  writeAllAgentsMarkdown,
  cleanLog,
  isDryRun,
  resolveLanguage,
  codexInvocation,
  validateFinalReport,
  artifactPaths,
  userResponseMarkdown,
  resolveMarketSymbol,
  parseYahooChart,
  parseStooqCsv,
};
