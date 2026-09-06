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
    app.handleInput({ key: 'mouse', button: 0, x: 10, y: 7 });
    assert.equal(app.state.page, 'detail');
    assert.ok(app.state.detail.content.endsWith('Long recorded exchange.\n'));
    assert.ok(app.state.rows.every((row) => stringWidth(row.text) <= io.output.columns - 8), 'fixed navigation must not clip the end of a wrapped evidence line');
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
  app.state.advanced = true;
  app.render();
  app.state.rows.find((row) => row.text.startsWith(`${UI_TEXT[app.state.language].name}:`)).action();
  const value = '中文'.repeat(45) + 'e\u0301';
  app.handleInput({ key: 'paste', text: value });
  const frame = io.output.chunks.at(-1);
  assert.ok(frame.includes('中文e\u0301'));
  const caret = [...frame.matchAll(/\x1b\[(\d+);(\d+)H/g)].at(-1);
  assert.ok(Number(caret[1]) >= 7 && Number(caret[1]) < 21 && Number(caret[2]) === 78 && frame.endsWith('\x1b[?25h'), 'the real cursor follows the inline editable tail, away from the bottom edge');
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

test('slow split mouse and application-cursor sequences never become Back or text', async () => {
  const events = [];
  const parser = inputDecoder((event) => events.push(event));
  parser.write('\x1b[<0;10;');
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.deepEqual(events, []);
  parser.write('8M\x1b[<32;10;8M\x1b[<0;10;8m\x1bO');
  await new Promise((resolve) => setTimeout(resolve, 90));
  parser.write('A');
  assert.deepEqual(events, [{ key: 'mouse', button: 0, x: 10, y: 8 }, { key: 'up' }]);
  parser.write('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(events.at(-1).key, 'escape', 'a real Esc key still returns promptly');
  parser.close();
});

test('history search stays inline, has clickable Cancel, and returns to the originating setup', () => {
  const io = terminal(80, 24);
  const app = createTerminalApp({ listConnections: () => [], listRuns: ({ query }) => query ? [] : [{ run_id: 'ACME-TEST', symbol: 'ACME', status: 'complete' }] }, { ...io, initial: { language: 'en' } });
  app.start();
  app.state.page = 'connection'; app.render();
  app.handleInput({ key: 'mouse', button: 0, x: 16, y: 5 });
  assert.equal(app.state.page, 'history');
  app.handleInput({ key: 'mouse', button: 0, x: 10, y: 7 });
  assert.equal(app.state.editing, null, 'a second click from the previous page cannot activate the new first row');
  app.handleInput({ key: 'text', text: '/' });
  app.handleInput({ key: 'text', text: 'x' });
  assert.ok(io.output.chunks.at(-1).includes('ACME-TEST'), 'editing keeps the history list visible');
  assert.ok(io.output.chunks.at(-1).includes('[ Save ] [ Cancel ]'));
  // Keyboard navigation ends the old click gesture before another deliberate click.
  app.handleInput({ key: 'escape' });
  app.state.rows[0].action(); app.render();
  app.handleInput({ key: 'enter' });
  app.handleInput({ key: 'escape' });
  assert.equal(app.state.page, 'connection');
  app.close();
});

test('inline editing supports cursor movement, delete, clear, and graphemes', () => {
  const io = terminal(80, 24);
  const app = createTerminalApp({}, { ...io, initial: { language: 'en' } }); app.start();
  app.state.page = 'symbol'; app.render(); app.state.rows[0].action();
  app.handleInput({ key: 'paste', text: 'ABCD' });
  app.handleInput({ key: 'left' }); app.handleInput({ key: 'backspace' });
  app.handleInput({ key: 'paste', text: '中e\u0301' });
  assert.equal(app.state.editing.value, 'AB中e\u0301D');
  app.handleInput({ key: 'backspace' });
  assert.equal(app.state.editing.value, 'AB中D');
  app.handleInput({ key: 'home' }); app.handleInput({ key: 'delete' });
  assert.equal(app.state.editing.value, 'B中D');
  app.handleInput({ key: 'clearInput' }); app.handleInput({ key: 'paste', text: 'AAPL' });
  app.handleInput({ key: 'mouse', button: 0, x: 5, y: 5 });
  assert.equal(app.state.symbol, 'AAPL'); assert.equal(app.state.editing, null);
  app.close();
});

test('Codex model action opens a real list with search and default, without editing or paid probing', async () => {
  const io = terminal(); let probes = 0, listings = 0;
  const app = createTerminalApp({ listModels: async () => { listings++; return { models: [{ id: 'fixture-one', name: 'One', default: true }, { id: 'fixture-two', name: 'Two' }] }; }, probeConnection: () => { probes++; } }, { ...io, initial: { language: 'en' } });
  app.start(); app.state.page = 'provider'; app.render();
  assert.ok(app.state.rows.some((row) => row.text === 'DeepSeek'));
  assert.ok(app.state.rows.some((row) => row.text === 'OpenCode Go'));
  app.state.rows.find((row) => row.text === 'Codex / ChatGPT').action(); app.render();
  await app.state.rows.find((row) => row.text.startsWith('Model:')).action();
  assert.equal(app.state.page, 'models'); assert.equal(app.state.editing, null);
  assert.equal(listings, 1); assert.equal(probes, 0);
  app.handleInput({ key: 'text', text: '/' }); app.handleInput({ key: 'paste', text: 'two' }); app.handleInput({ key: 'enter' });
  assert.ok(!app.state.rows.some((row) => row.text.includes('fixture-one')));
  app.state.rows.find((row) => row.text.includes('fixture-two')).action(); app.render();
  assert.equal(app.state.page, 'account'); assert.equal(app.state.draft.model, 'fixture-two');
  app.close();
});

test('a failed model listing retains retry and manual entry, and rejects unknown catalog protocols', async () => {
  const io = terminal(); let result = { models: [], error: 'authentication_or_model_access: HTTP 401' };
  const app = createTerminalApp({ listModels: async () => result }, { ...io, initial: { language: 'en' } });
  app.start(); app.state.page = 'account'; app.state.draft = { provider: 'compatible', name: 'Gateway', apiKey: 'fixture', base_url: 'https://example.com/v1' }; app.render();
  await app.state.rows.find((row) => row.text.startsWith('Model:')).action();
  assert.equal(app.state.page, 'models'); assert.ok(app.state.modelError.includes('401'));
  assert.ok(app.state.rows.find((row) => row.text === UI_TEXT.en.manualModel).action);
  result = { models: [{ id: 'new-unknown', selectable: false, api_format: null }, { id: 'known', api_format: 'messages', selectable: true }] };
  await app.state.rows.find((row) => row.text === UI_TEXT.en.refresh).action();
  assert.equal(app.state.rows.find((row) => row.text.includes('new-unknown')).action, undefined);
  app.state.rows.find((row) => row.text.includes('known') && !row.text.includes('unknown')).action();
  assert.equal(app.state.draft.api_format, 'messages');
  app.close();
});

test('Esc cancels a pending model list and a saved-profile probe without losing the saved profile', async () => {
  for (const save of [false, true]) {
    const io = terminal(); let signalSeen;
    const pending = async (_, { signal }) => { signalSeen = signal; return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, models: [], error: 'Operation cancelled', error_code: 'OPERATION_CANCELLED' }), { once: true })); };
    const profile = { id: 'saved', provider: 'codex', name: 'Codex', model: '' };
    const app = createTerminalApp({ listModels: pending, saveConnection: async () => profile, getConnectionSecret: async () => undefined, probeConnection: pending }, { ...io, initial: { language: 'en', symbol: 'ACME' } });
    app.start(); app.state.page = 'account'; app.state.draft = { ...profile }; app.render();
    const operation = app.state.rows.find((row) => save ? row.text === UI_TEXT.en.save : row.text.startsWith('Model:')).action();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(app.state.busy); assert.ok(io.output.chunks.at(-1).includes('[ Cancel ]'));
    app.handleInput({ key: 'escape' }); await operation;
    assert.equal(signalSeen.aborted, true); assert.equal(app.state.busy, false);
    assert.ok(app.state.message.includes(UI_TEXT.en.operationCancelled));
    if (save) { assert.equal(app.state.connection.id, 'saved'); assert.equal(app.state.page, 'profile'); assert.ok(app.state.message.includes(UI_TEXT.en.savedCheckFailed)); }
    app.close();
  }
});

test('artifact search, paging and return retain the originating list position', () => {
  const io = terminal();
  const items = Array.from({ length: 40 }, (_, index) => ({ id: `item-${index}`, kind: 'evidence', available: true, status: 'completed' }));
  const app = createTerminalApp({ readArtifact: () => ({ content: Array.from({ length: 90 }, (_, index) => `Evidence line ${index}${index === 60 || index === 80 ? ' target' : ''}`).join('\n') }) }, { ...io, initial: { language: 'en' } });
  app.start(); Object.assign(app.state, { page: 'artifacts', run: { items }, runId: 'ACME-TEST', category: 'evidence', selected: 35, offset: 20 }); app.render();
  app.handleInput({ key: 'enter' }); assert.equal(app.state.page, 'detail');
  app.handleInput({ key: 'text', text: '/' }); app.handleInput({ key: 'paste', text: 'target' }); app.handleInput({ key: 'enter' });
  assert.equal(app.state.offset, 60);
  app.handleInput({ key: 'text', text: 'n' }); assert.equal(app.state.matchIndex, 1);
  app.handleInput({ key: 'escape' }); assert.equal(app.state.page, 'artifacts'); assert.equal(app.state.selected, 35); assert.equal(app.state.offset, 14);
  app.close();
});

test('New research consumes runs and attach startup commands only once', () => {
  for (const initial of [{ command: 'runs' }, { command: 'attach', runId: 'OLD-RUN' }]) {
    const io = terminal();
    const app = createTerminalApp({ listRuns: () => [], loadRun: () => ({ status: { status: 'complete' }, items: [] }) }, { ...io, initial: { ...initial, language: 'en' } });
    app.start(); app.state.rows.find((row) => row.text.includes('English')).action(); app.render();
    assert.equal(app.state.page, initial.runId ? 'run' : 'history');
    const frame = stripVTControlCharacters(io.output.chunks.at(-1)).split('\r\n');
    const x = frame[4].indexOf('[ New research ]') + 4;
    app.handleInput({ key: 'mouse', button: 0, x, y: 5 });
    assert.equal(app.state.page, 'language');
    app.handleInput({ key: 'enter' }); assert.equal(app.state.page, 'symbol');
    app.close();
  }
});

test('resizing keeps menu selection visible and prevents hidden Start activation in small terminals', () => {
  const io = terminal(); let launches = 0;
  const profiles = Array.from({ length: 35 }, (_, i) => ({ id: `fixture-${i}`, provider: 'codex', name: `Profile ${i}` }));
  const app = createTerminalApp({ listConnections: () => profiles, confirmSelection: () => { launches++; } }, { ...io, initial: { language: 'en' } }); app.start();
  app.state.page = 'connection'; app.render();
  for (let i = 0; i < 20; i++) app.handleInput({ key: 'down' });
  io.output.rows = 24; io.output.emit('resize');
  assert.ok(app.state.selected >= app.state.offset && app.state.selected < app.state.offset + app.state.visible);
  assert.ok(io.output.chunks.at(-1).includes('Profile 20'));
  Object.assign(app.state, { page: 'review', connection: profiles[0], selection: { masters: [] } }); app.render();
  app.state.selected = app.state.rows.findIndex((row) => row.text === UI_TEXT.en.start);
  io.output.columns = 60; io.output.rows = 20; io.output.emit('resize');
  app.handleInput({ key: 'enter' }); app.handleInput({ key: 'text', text: ' ' });
  assert.equal(launches, 0); assert.equal(app.state.busy, false);
  app.handleInput({ key: 'interrupt' }); assert.equal(app.state.closed, true);
});

test('resizing an inline field follows its label and search matches follow new wrapping', () => {
  const io = terminal(); const app = createTerminalApp({}, { ...io, initial: { language: 'de' } }); app.start();
  Object.assign(app.state, { page: 'account', draft: { provider: 'compatible', name: 'OpenCode Go', base_url: 'https://opencode.ai/zen/go/v1', apiKey: '' } }); app.render();
  app.state.rows.find((row) => row.text.startsWith('API Key:')).action(); app.handleInput({ key: 'paste', text: 'fixture-secret' });
  io.output.columns = 80; io.output.emit('resize');
  assert.equal(app.state.editing.index, app.state.rows.findIndex((row) => row.text.startsWith('API Key:')));
  assert.ok(!io.output.chunks.at(-1).includes('fixture-secret'));
  app.handleInput({ key: 'escape' });
  Object.assign(app.state, { page: 'detail', detail: { title: 'Evidence', content: 'A'.repeat(370) + 'needle\n' + 'B'.repeat(600) }, previous: 'account', offset: 0 }); app.render();
  app.handleInput({ key: 'text', text: '/' }); app.handleInput({ key: 'paste', text: 'needle' }); app.handleInput({ key: 'enter' });
  const oldLine = app.state.detailMatches[0];
  io.output.columns = 120; io.output.emit('resize');
  assert.notEqual(app.state.detailMatches[0], oldLine);
  assert.ok(app.state.detail.rows[app.state.detailMatches[0]].text.includes('needle'));
  app.close();
});

test('login URLs remain keyboard and mouse actions during an official sign-in', async () => {
  const io = terminal();
  const app = createTerminalApp({ loginCodex: async ({ signal, onOutput }) => {
    onOutput('Open https://example.com/authorize to sign in');
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, error_code: 'OPERATION_CANCELLED', error: 'Cancelled' }), { once: true }));
  } }, { ...io, initial: { language: 'en' } });
  app.start(); app.state.page = 'account'; app.state.draft = { provider: 'codex', name: 'Codex' }; app.render();
  const login = app.state.rows.find((row) => row.text === UI_TEXT.en.officialLogin).action();
  assert.equal(app.state.page, 'auth');
  assert.equal(typeof app.state.rows.find((row) => row.text.includes('https://')).action, 'function');
  assert.ok(io.output.chunks.at(-1).includes('> https://example.com/authorize'));
  app.handleInput({ key: 'down' }); assert.equal(app.state.selected, 1);
  app.handleInput({ key: 'enter' }); await login;
  assert.equal(app.state.busy, false); assert.equal(app.state.page, 'account');
  app.close();
});

test('opening history identifies the saved instrument and never counts report placeholders as failed workers', () => {
  const io = terminal();
  const app = createTerminalApp({}, { ...io, initial: { language: 'en', symbol: 'AAPL' } }); app.start();
  Object.assign(app.state, { page: 'run', runId: 'ACME-TEST', connection: { name: 'Draft connection' }, run: {
    status: { symbol: 'ACME', status: 'incomplete', language: 'en' }, items: [
      { id: 'report', kind: 'report', available: true, status: 'incomplete' },
      { id: 'handoff', kind: 'report', available: false, status: 'incomplete' },
      { id: 'worker', kind: 'evidence', available: false, status: 'failed' },
    ],
  } }); app.render();
  const frame = stripVTControlCharacters(io.output.chunks.at(-1));
  assert.ok(frame.includes('ACME / English')); assert.ok(!frame.includes('AAPL') && !frame.includes('Draft connection'));
  assert.ok(!app.state.rows.find((row) => row.text.startsWith('Report  [')).text.includes('Failed'));
  assert.ok(app.state.rows.find((row) => row.text.startsWith('Evidence  [')).text.includes('Failed: 1'));
  assert.equal(app.state.symbol, 'AAPL', 'reading history preserves the unfinished new-research ticker');
  app.close();
});

test('incomplete research renders successful counts, diagnostics and the full inline conclusion', () => {
  const io = terminal(131, 38);
  const content = '<details>\n<summary>Saved analysis</summary>\n' + 'Recorded Q&amp;A evidence.\n'.repeat(80) + '<!-- alphacouncil:handoff-method-seat:v1:master_buffett -->\nFull method statement.\n</details>\n';
  const app = createTerminalApp({ readArtifact: () => ({ content: '{"reason":"timeout"}', format: 'json' }) }, { ...io, initial: { language: 'zh-CN' } });
  app.start();
  Object.assign(app.state, { page: 'run', runId: 'TEST-OUTCOME', run: {
    status: { symbol: 'TEST', status: 'incomplete', terminal: 'incomplete', language: 'zh-CN' },
    runner: { state: 'completed' }, conclusion: content,
    items: [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `e${i}`, kind: 'evidence', role: `analyst${i}`, available: true, successful: i < 7, status: i < 7 ? 'completed' : 'timed_out' })),
      { id: 'report', kind: 'report', available: true, successful: false, status: 'incomplete' },
      { id: 'failure:analyst7', kind: 'diagnostics', role: 'analyst7', available: true, status: 'timed_out' },
    ],
  } }); app.render();
  const rows = app.state.rows.map((row) => row.text).join('\n');
  assert.match(rows, /7\/8.*失败: 1/);
  assert.match(rows, /报告.*0\/1/);
  assert.doesNotMatch(rows, /状态: completed|alphacouncil:handoff|<details>|<summary>|&amp;/);
  assert.match(rows, /Full method statement/);
  app.state.rows.find((row) => row.text === '研究结论' && row.action).action(); app.render();
  const start = app.state.offset;
  app.handleInput({ key: 'pagedown' });
  assert.equal(app.state.offset, start + app.state.visible, 'Page Down advances one full page without jumping to the end');
  app.handleInput({ key: 'end' });
  assert.ok(stripVTControlCharacters(io.output.chunks.at(-1)).includes('Full method statement'));
  app.state.rows.find((row) => row.text.startsWith('失败诊断:')).action(); app.render();
  assert.equal(app.state.page, 'detail');
  assert.match(app.state.detail.content, /timeout/);
  app.handleInput({ key: 'escape' }); assert.equal(app.state.page, 'run');
  app.close();
});

test('a live terminal transition automatically reveals the conclusion once', async () => {
  const io = terminal(80, 24);
  const finished = { status: { terminal: 'incomplete', status: 'incomplete' }, items: [], conclusion: '# End of research\nThe evidence barrier failed.\n' + 'Retained evidence.\n'.repeat(40) };
  const app = createTerminalApp({ loadRun: () => finished }, io); app.start();
  Object.assign(app.state, { page: 'run', runId: 'TRANSITION-1', run: { status: { status: 'running' }, items: [] } }); app.render();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.ok(app.state.rows[app.state.selected].conclusionStart);
  assert.match(stripVTControlCharacters(io.output.chunks.at(-1)), /End of research/);
  app.handleInput({ key: 'home' });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(app.state.selected, 0, 'later refreshes preserve the reader position');
  app.close();
});
