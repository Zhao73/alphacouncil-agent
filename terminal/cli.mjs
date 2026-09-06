#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanText } from './screen.mjs';

export function parseArgs(args) {
  const result = { command: 'research', plain: false };
  const words = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--version') result.version = true;
    else if (arg === '--plain' || arg === '--json') result.plain = true;
    else if (arg === '--language') {
      if (!args[index + 1] || args[index + 1].startsWith('-')) throw new Error('--language requires a locale');
      result.language = args[++index];
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else words.push(arg);
  }
  if (['research', 'runs', 'attach', 'stop', 'connect', 'doctor'].includes(words[0])) result.command = words.shift();
  if (['attach', 'stop'].includes(result.command)) {
    if (words.length !== 1) throw new Error(`${result.command} requires RUN_ID`);
    result.runId = words[0];
  } else if (result.command === 'research') {
    if (words.length > 1) throw new Error('Use one ticker; enter the research question inside the terminal.');
    result.symbol = words[0] || '';
  } else if (words.length) throw new Error(`Unexpected argument: ${words[0]}`);
  return result;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    process.stdout.write('AlphaCouncil Terminal\n\n  alphacouncil [research] [TICKER]\n  alphacouncil runs [--plain]\n  alphacouncil attach RUN_ID [--plain]\n  alphacouncil stop RUN_ID\n  alphacouncil connect\n  alphacouncil doctor\n\nChoose language, enter ticker, choose model, then confirm methods.\nMouse click or keyboard: arrows, Enter, Tab, Esc. q closes the UI; stopping research is a separate action.\n--language LOCALE prefills the language chooser. --plain prints saved data without a TUI.\n');
    return;
  }
  if (options.version) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(`AlphaCouncil Terminal ${pkg.version}\n`); return;
  }
  const service = await import('./service.mjs');
  const print = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  if (options.command === 'stop') { print(service.stop(options.runId)); return; }
  if (options.command === 'doctor') {
    const connections = await import('./connections.mjs');
    print({ node: process.version, platform: process.platform, arch: process.arch,
      codex: await connections.getCodexLoginStatus(),
      connections: connections.listConnections().map(({ id, name, provider, model }) => ({ id, name, provider, model })),
      languages: (await import('../mcp/lib/lang.mjs')).RESEARCH_LANGUAGES.map((entry) => entry.locale),
    }); return;
  }
  if (options.plain) {
    if (options.command === 'runs') print(service.listRuns());
    else if (options.command === 'attach') print(service.loadRun(options.runId));
    else throw new Error('--plain supports runs or attach; starting research requires the displayed selection confirmation.');
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === 'dumb') throw new Error('Interactive terminal required. Use runs --plain or attach RUN_ID --plain for saved data.');
  const { runTerminal } = await import('./ui.mjs');
  await runTerminal(options);
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => { process.stderr.write(`AlphaCouncil: ${cleanText(error.message)}\n`); process.exitCode = 1; });
}
