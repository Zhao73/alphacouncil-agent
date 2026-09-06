import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import stringWidth from 'string-width';
import { stripVTControlCharacters } from 'node:util';
import { UI_TEXT } from '../i18n.mjs';
import { cleanText, clip, wrapText, inputDecoder, Screen } from '../screen.mjs';
import { parseArgs } from '../cli.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'alphacouncil-tui-ui-'));
process.env.ALPHACOUNCIL_AGENT_DATA_DIR = dataDir;
const { createTerminalApp } = await import('../ui.mjs');
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

function terminal(columns = 120, rows = 36) {
  const output = new EventEmitter();
  Object.assign(output, { columns, rows, chunks: [], write(value) { this.chunks.push(value); } });
  const input = new EventEmitter();
  Object.assign(input, { setEncoding() {}, setRawMode() {}, resume() {}, pause() {} });
  return { input, output };
}

test('12 complete UI dictionaries and Unicode display cells survive actual frames', () => {
  assert.equal(Object.keys(UI_TEXT).length, 12);
  for (const locale of Object.keys(UI_TEXT)) {
    for (const [columns, rows] of [[80, 24], [120, 36]]) {
      const io = terminal(columns, rows);
      const screen = new Screen(() => {}, io);
      screen.draw({ title: UI_TEXT[locale].language, rows: Object.values(UI_TEXT[locale]).map((text) => ({ text })), footer: UI_TEXT[locale].chooseHint });
      const lines = stripVTControlCharacters(io.output.chunks.at(-1)).split('\r\n');
      assert.equal(lines.length, rows);
      assert.ok(lines.every((line) => stringWidth(line) === columns), locale);
    }
  }
  assert.equal(stringWidth(clip('语言한국어 e\u0301 👨‍👩‍👧‍👦', 12)), 12);
  assert.ok(wrapText('中文 e\u0301 👨‍👩‍👧‍👦 한국어', 5).every((line) => stringWidth(line) <= 5));
  assert.equal(cleanText('\x1b]52;c;Y2xpcA==\x07\x1b[31mhello\x1b[0m\u202e'), 'hello');
});

test('SGR click, wheel and split bracketed paste cannot be interpreted as actions', async () => {
  const events = [];
  const parser = inputDecoder((event) => events.push(event));
  parser.write('\x1b[<0;15;'); parser.write('8M');
  parser.write('\x1b[<64;15;8M');
  parser.write('\x1b[200~q\n\x1b[A'); parser.write('api-key\x1b[201~');
  parser.write('\x1b[B\r');
  assert.deepEqual(events.map((event) => event.key), ['mouse', 'up', 'paste', 'down', 'enter']);
  assert.deepEqual(events[0], { key: 'mouse', button: 0, x: 15, y: 8 });
  assert.equal(events[2].text, 'q api-key');
  parser.close();
});

test('startup enforces language then ticker then model, with no research before submission', () => {
  for (const [index, locale] of Object.keys(UI_TEXT).entries()) {
    const io = terminal();
    let calls = 0;
    const app = createTerminalApp({ listConnections: () => [], launch: () => { calls++; } }, io);
    app.start();
    assert.ok(io.output.chunks.at(-1).includes('⢀⡤⠶⣄⣠'), 'the repository logo appears on the language home');
    const row = app.state.rows.find((row) => row.text.includes(({ en: 'English', 'zh-CN': '中文', ja: '日本語', ko: '한국어', es: 'Español', fr: 'Français', de: 'Deutsch', 'pt-BR': 'Português', it: 'Italiano', ru: 'Русский', vi: 'Tiếng Việt', id: 'Bahasa Indonesia' })[locale]));
    row.action(); app.render();
    assert.equal(app.state.page, 'symbol'); assert.equal(app.state.language, locale);
    assert.ok(!io.output.chunks.at(-1).includes('⢀⡤⠶⣄⣠'), 'the logo stays off research setup screens');
    assert.ok(!app.state.rows.some((row) => row.text.startsWith(UI_TEXT[locale].question)));
    app.state.rows[0].action();
    app.handleInput({ key: 'paste', text: 'ACME' }); app.handleInput({ key: 'enter' });
    app.state.rows.find((row) => row.text === UI_TEXT[locale].next).action(); app.render();
    assert.equal(app.state.page, 'connection'); assert.equal(app.state.symbol, 'ACME'); assert.equal(calls, 0);
    app.close();
  }
});

test('clicking completed evidence, methods, debate and reports opens full recorded content', () => {
  const items = [
    { id: 'evidence:market_data', kind: 'evidence', role: 'market_data', available: true, status: 'completed' },
    { id: 'method:master_buffett', kind: 'method', role: 'master_buffett', available: true, status: 'completed' },
    { id: 'debate:bull_researcher:2', kind: 'debate', round: 2, available: true, status: 'completed' },
    { id: 'report', kind: 'report', available: true, status: 'completed' },
  ];
  const opened = [];
  const io = terminal();
  const api = { readArtifact: (id, item) => { opened.push(item); return { content: `${item}\n${'A long sentence with important evidence. '.repeat(6)}\n` + 'Long recorded exchange.\n'.repeat(100) }; } };
  const app = createTerminalApp(api, io);
  app.start();
  for (const category of ['evidence', 'methods', 'debate', 'report']) {
    Object.assign(app.state, { page: 'artifacts', runId: 'ACME-TEST', run: { items }, category, selected: 0, offset: 0 });
    app.render();
    app.handleInput({ key: 'mouse', button: 0, x: 30, y: 5 });
    assert.equal(app.state.page, 'detail');
    assert.ok(app.state.detail.content.endsWith('Long recorded exchange.\n'));
    assert.ok(app.state.rows.every((row) => stringWidth(row.text) <= io.output.columns - 27), 'wide navigation must not clip the end of a wrapped evidence line');
    app.handleInput({ key: 'pagedown' }); assert.ok(app.state.offset > 0);
    app.handleInput({ key: 'escape' }); assert.equal(app.state.page, 'artifacts');
  }
  assert.deepEqual(opened, items.map((item) => item.id));
  app.close();
});

test('password entry masks paste and q remains text while editing', () => {
  const io = terminal();
  const app = createTerminalApp({}, io); app.start();
  app.state.page = 'account';
  app.state.draft = { provider: 'anthropic', model: 'model-test', name: 'Test', storage: 'session', apiKey: '' };
  app.render();
  app.state.rows.find((row) => row.text.startsWith('API Key:')).action();
  app.handleInput({ key: 'paste', text: 'not-a-real-secret-' }); app.handleInput({ key: 'text', text: 'q' });
  assert.equal(app.state.closed, false);
  assert.ok(!io.output.chunks.at(-1).includes('not-a-real-secret-'));
  app.handleInput({ key: 'enter' }); assert.equal(app.state.draft.apiKey, 'not-a-real-secret-q');
  app.close(); assert.equal(app.state.draft.apiKey, '');
});

test('CLI rejects ambiguous commands and keeps plain reads separate from starting research', () => {
  assert.deepEqual(parseArgs(['AAPL', '--language', 'ja']), { command: 'research', plain: false, symbol: 'AAPL', language: 'ja' });
  assert.equal(parseArgs(['runs', '--json']).plain, true);
  assert.throws(() => parseArgs(['attach']), /RUN_ID/);
  assert.throws(() => parseArgs(['--language']), /requires/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown option/);
});

test('the displayed chooser creates a real one-use receipt only on Start, with the same run language', async () => {
  const service = await import('../service.mjs');
  const io = terminal();
  const profile = { id: 'test', name: 'Test model', provider: 'codex', model: '' };
  let launchArgs = null;
  const app = createTerminalApp({
    listConnections: () => [profile], getConnectionSecret: async () => undefined,
    probeConnection: async () => ({ ok: true, capabilities: { tool_calls: true, web_search: false } }),
    beginSelection: service.beginSelection, confirmSelection: service.confirmSelection,
    launch: async (args) => { launchArgs = args; return { run_id: 'ACME-UI-TEST' }; },
    loadRun: () => ({ status: { status: 'running', language: 'English' }, runner: { alive: true }, items: [] }),
  }, io);
  app.start();
  app.state.rows.find((row) => row.text.includes('English')).action(); app.render();
  app.state.rows[0].action(); app.handleInput({ key: 'paste', text: 'ACME' }); app.handleInput({ key: 'enter' });
  app.state.rows.find((row) => row.text === UI_TEXT.en.next).action(); app.render();
  app.state.rows[0].action(); app.render();
  await app.state.rows.find((row) => row.text === UI_TEXT.en.next).action();
  assert.ok(app.state.rows.some((row) => row.text.includes('Web search is unavailable')));
  assert.ok(!app.state.rows.some((row) => row.text.startsWith(UI_TEXT.en.question)));
  await app.state.rows.find((row) => row.text === UI_TEXT.en.methods).action();
  assert.equal(app.state.page, 'methods');
  assert.ok(stripVTControlCharacters(io.output.chunks.at(-1)).includes('Research setup'));
  assert.equal(launchArgs, null);
  app.state.rows.find((row) => row.text === UI_TEXT.en.review).action(); app.render();
  assert.ok(app.state.rows.some((row) => row.text.includes('Web search is unavailable')));
  assert.equal(launchArgs, null);
  await app.state.rows.find((row) => row.text === UI_TEXT.en.start).action();
  assert.equal(app.state.page, 'run', app.state.message);
  assert.equal(launchArgs.research.language, 'en');
  assert.equal(launchArgs.research.prompt, '');
  assert.ok(launchArgs.confirmation.selection_receipt);
  assert.equal(launchArgs.confirmation.selected_master_ids.length, app.state.methods.size);
  app.close();
});

test('long Unicode input keeps the editable tail and cursor inside an 80-column frame', () => {
  const io = terminal(80, 24);
  const app = createTerminalApp({}, io); app.start();
  app.state.page = 'account';
  app.state.draft = { provider: 'anthropic', model: '', name: '', storage: 'session', apiKey: '' };
  app.render();
  app.state.rows.find((row) => row.text.startsWith(`${UI_TEXT[app.state.language].name}:`)).action();
  const value = '中文'.repeat(45) + 'e\u0301';
  app.handleInput({ key: 'paste', text: value });
  const frame = io.output.chunks.at(-1);
  assert.ok(frame.includes('中文e\u0301'));
  assert.ok(frame.includes('\x1b[7;78H') && frame.endsWith('\x1b[?25h'), 'the real cursor follows the visible tail, away from the bottom edge');
  app.handleInput({ key: 'backspace' });
  assert.equal(app.state.editing.value, '中文'.repeat(45), 'backspace removes one complete grapheme');
  app.handleInput({ key: 'enter' });
  assert.equal(app.state.draft.name, '中文'.repeat(45), 'horizontal display clipping never truncates the submitted value');
  app.close();
});

test('failed official login and logout stay failures in the interface', async () => {
  const io = terminal();
  const profile = { provider: 'codex', name: 'Codex', model: '' };
  const app = createTerminalApp({ loginCodex: async () => ({ ok: false }), logoutCodex: async () => ({ ok: false }) }, { ...io, initial: { language: 'en' } });
  app.start();
  app.state.draft = profile; app.state.page = 'account'; app.render();
  await app.state.rows.find((row) => row.text === UI_TEXT.en.officialLogin).action();
  assert.equal(app.state.page, 'account');
  assert.equal(app.state.message, `${UI_TEXT.en.error}: ${UI_TEXT.en.unavailable}`);
  app.state.connection = profile; app.state.page = 'profile'; app.render();
  await app.state.rows.find((row) => row.text === UI_TEXT.en.disconnect).action();
  assert.equal(app.state.message, `${UI_TEXT.en.error}: ${UI_TEXT.en.unavailable}`);
  app.close();
});
