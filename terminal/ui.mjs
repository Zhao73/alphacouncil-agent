import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import stringWidth from 'string-width';
import { DATA_DIR } from '../mcp/lib/constants.mjs';
import { RESEARCH_LANGUAGES, researchLanguage } from '../mcp/lib/lang.mjs';
import { safeSymbol } from '../mcp/lib/run-store.mjs';
import { Screen, cleanText, wrapText } from './screen.mjs';
import { translator } from './i18n.mjs';

const SETTINGS = join(DATA_DIR, 'terminal', 'settings.json');
const TERMINAL_STATES = new Set(['complete', 'completed', 'degraded', 'incomplete', 'failed', 'needs_revision', 'needs_verification']);
const PROVIDERS = ['codex', 'anthropic', 'openai', 'compatible'];
const PROVIDER_NAMES = { codex: 'Codex / ChatGPT', anthropic: 'Claude API', openai: 'OpenAI API', compatible: 'OpenAI-compatible API' };

export function createTerminalApp(api, { initial = {}, output = process.stdout, input = process.stdin } = {}) {
  let settings = {};
  if (existsSync(SETTINGS)) {
    try { settings = JSON.parse(readFileSync(SETTINGS, 'utf8')); } catch { /* Keep the language chooser usable with a damaged preferences file. */ }
  }
  const state = {
    page: 'language', language: researchLanguage(initial.language || settings.language)?.locale || 'en',
    symbol: initial.symbol || '', connection: null, draft: null,
    mode: 'full', pace: 'normal', analystScope: 'core', selection: null, methods: new Set(),
    selected: 0, offset: 0, visible: 16, rows: [], message: '', busy: false, editing: null,
    runId: initial.runId || null, run: null, category: 'evidence', detail: null, previous: null,
    query: '', models: [], moreModels: false, authOutput: '', authURLs: [], authAbort: null, closed: false,
  };
  let done, refreshTimer;
  const completed = new Promise((resolve) => { done = resolve; });
  const abort = new AbortController();
  const screen = new Screen(handleInput, { output, input });
  const t = (key) => translator(state.language)(key);
  const action = (text, fn) => ({ text, action: fn });
  const text = (value) => ({ text: value });
  function saveSettings() {
    mkdirSync(join(DATA_DIR, 'terminal'), { recursive: true, mode: 0o700 });
    const temp = `${SETTINGS}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ language: state.language }) + '\n', { mode: 0o600 });
    renameSync(temp, SETTINGS);
  }
  function go(page) {
    state.page = page; state.selected = page === 'language' ? RESEARCH_LANGUAGES.findIndex((entry) => entry.locale === state.language) : 0;
    state.offset = 0; state.message = ''; state.editing = null;
  }
  function showDetail(title, content, back = state.page) {
    state.detail = { title, content }; state.previous = back; go('detail');
  }
  function edit(label, value, apply, { secret = false, required = false } = {}) {
    state.editing = { label, value: String(value || ''), apply, secret, required };
  }
  function field(label, value, apply, options) {
    return action(`${label}: ${options?.secret ? (value ? '********' : '') : value || ''}`, () => edit(label, value, apply, options));
  }
  function errorMessage(error) {
    let message = cleanText(error?.message || error);
    if (state.draft?.apiKey) message = message.split(state.draft.apiKey).join('[redacted]');
    return `${t('error')}: ${message}`;
  }
  async function execute(fn) {
    if (state.busy || state.closed) return;
    state.busy = true; state.message = t('loading'); render();
    try { await fn(); if (state.message === t('loading')) state.message = ''; }
    catch (error) { state.message = errorMessage(error); }
    finally { state.busy = false; if (!state.closed) render(); }
  }
  function research() {
    return { symbol: safeSymbol(state.symbol.trim()), prompt: '', language: state.language,
      council_mode: state.mode, ...(state.mode === 'full' ? { council_pace: state.pace, analyst_scope: state.analystScope } : {}) };
  }
  async function chooseConnection(profile) {
    const apiKey = await api.getConnectionSecret(profile);
    state.message = t('checking'); render();
    const result = await api.probeConnection(profile, { apiKey, signal: abort.signal });
    if (!result.ok) throw new Error(result.error || t('unavailable'));
    state.connection = { ...profile, capabilities: result.capabilities };
    go(state.symbol ? 'configuration' : 'symbol');
  }
  function openURL(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('HTTPS authorization URL required');
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href];
    const child = spawn(command, args, { stdio: 'ignore', shell: false, windowsHide: true });
    child.on('error', (error) => { state.message = errorMessage(error); render(); });
    child.unref();
  }
  async function signInCodex() {
    state.authOutput = ''; state.authURLs = [];
    state.authAbort = new AbortController();
    const cancel = () => state.authAbort?.abort();
    abort.signal.addEventListener('abort', cancel, { once: true });
    go('auth');
    try {
      const result = await api.loginCodex({ signal: state.authAbort.signal, onOutput: (value) => {
        state.authOutput = (state.authOutput + cleanText(value)).slice(-16000);
        state.authURLs = [...new Set(state.authOutput.match(/https:\/\/[^\s<>"']+/g) || [])];
        render();
      } });
      if (!result.ok) throw new Error(result.error || t('unavailable'));
      go('account'); state.message = t('connected');
    } finally {
      abort.signal.removeEventListener('abort', cancel);
      state.authAbort = null;
      if (state.page === 'auth') go('account');
      state.authOutput = ''; state.authURLs = [];
    }
  }
  async function prepareMethods() {
    state.selection = await api.beginSelection(research());
    state.methods = new Set(state.selection.suggested_master_ids || state.selection.preselected_master_ids || []);
    go('methods');
  }
  async function startResearch() {
    const confirmation = await api.confirmSelection(state.selection, {
      display_ack: true,
      selected_master_ids: [...state.methods],
      ...(state.mode === 'full' ? { council_pace: state.pace, analyst_scope: state.analystScope } : {}),
    });
    const result = await api.launch({ research: research(), confirmation, connection: state.connection });
    state.runId = result.run_id;
    state.run = api.loadRun(state.runId); go('run');
  }
  function back() {
    if (state.editing) { state.editing.value = ''; state.editing = null; return; }
    if (state.page === 'detail') return go(state.previous || 'run');
    const parent = { symbol: 'language', connection: 'symbol', profile: 'connection', provider: 'connection', account: 'provider', models: 'account', configuration: 'connection', methods: 'configuration', review: 'methods', stop: 'run', run: 'history', artifacts: 'run', history: 'symbol' };
    go(parent[state.page] || 'language');
  }
  function pageRows() {
    switch (state.page) {
      case 'language': return RESEARCH_LANGUAGES.map((entry) => action(`${entry.locale === state.language ? '(*)' : '( )'} ${entry.name}`, () => {
        state.language = entry.locale; saveSettings();
        if (initial.command === 'runs') go('history');
        else if (initial.command === 'connect') go('connection');
        else if (initial.runId) { state.run = api.loadRun(state.runId); go('run'); }
        else go('symbol');
      }));
      case 'symbol': return [
        field(t('symbol'), state.symbol, (value) => { state.symbol = safeSymbol(value.trim()); }, { required: true }),
        action(t('next'), () => { research(); go('connection'); }),
        text(''), action(t('history'), () => go('history')),
      ];
      case 'connection': return [
        ...api.listConnections().map((profile) => action(`${profile.id === state.connection?.id ? '(*)' : '( )'} ${profile.name} / ${profile.model || PROVIDER_NAMES[profile.provider]}`, () => { state.connection = profile; go('profile'); })),
        action(`+ ${t('addConnection')}`, () => go('provider')),
        ...(state.connection ? [action(t('details'), () => showDetail(t('capabilities'), JSON.stringify(state.connection, null, 2), 'connection'))] : []),
        text(''), text(t('billing')),
      ];
      case 'profile': return [
        text(`${state.connection.name} / ${state.connection.model || PROVIDER_NAMES[state.connection.provider]}`),
        ...(state.connection.routing_policy?.mode === 'platform_managed' ? wrapText(t('routing'), Math.max(1, (output.columns || 80) - 8)).map(text) : []),
        action(t('next'), () => execute(() => chooseConnection(state.connection))),
        action(`${t('model')} / ${t('apiKey')}`, () => {
          state.draft = { ...state.connection, budget: { ...(state.connection.budget || api.DEFAULT_CONNECTION_BUDGET) }, apiKey: undefined };
          go('account');
        }),
        action(t('test'), () => execute(async () => {
          const apiKey = await api.getConnectionSecret(state.connection);
          const result = await api.probeConnection(state.connection, { apiKey, signal: abort.signal });
          showDetail(t('capabilities'), JSON.stringify(result, null, 2), 'profile');
        })),
        action(t('remove'), () => execute(async () => { await api.deleteConnection(state.connection.id); state.connection = null; go('connection'); })),
        ...(state.connection.provider === 'codex' ? [action(t('disconnect'), () => execute(async () => {
          const result = await api.logoutCodex({ signal: abort.signal });
          if (!result.ok) throw new Error(result.error || t('unavailable'));
          state.message = t('disconnect');
        }))] : []),
        text(''), text(t('billing')),
      ];
      case 'provider': return PROVIDERS.map((provider) => action(PROVIDER_NAMES[provider], () => {
        state.draft = { provider, model: '', name: PROVIDER_NAMES[provider], storage: process.platform === 'linux' ? 'session' : 'system', apiKey: '', base_url: '', budget: { ...api.DEFAULT_CONNECTION_BUDGET } };
        go('account');
      }));
      case 'account': return [
        text(PROVIDER_NAMES[state.draft.provider]),
        field(t('name'), state.draft.name, (value) => { state.draft.name = value; }, { required: true }),
        field(t('model'), state.draft.model, (value) => { state.draft.model = value; }, { required: state.draft.provider !== 'codex' }),
        ...(state.draft.provider === 'codex' ? [
          action(t('officialLogin'), () => execute(signInCodex)),
        ] : [
          field(t('apiKey'), state.draft.apiKey, (value) => { state.draft.apiKey = value.trim(); }, { secret: true, required: true }),
          ...(state.draft.provider === 'compatible' ? [field(t('baseURL'), state.draft.base_url, (value) => { state.draft.base_url = value.trim(); }, { required: true })] : []),
          action(t('availableModels'), () => execute(async () => {
            const apiKey = state.draft.apiKey || await api.getConnectionSecret(state.draft);
            const result = await api.listModels(state.draft, { apiKey, signal: abort.signal });
            if (result.error) throw new Error(result.error);
            state.models = result.models; state.moreModels = result.has_more === true; go('models');
          })),
          action(`${t('storage')}: ${t(state.draft.storage)}`, () => { state.draft.storage = state.draft.storage === 'system' ? 'session' : 'system'; }),
          field(t('maxRequests'), state.draft.budget?.max_requests, (value) => { state.draft.budget = { ...state.draft.budget, max_requests: Number(value) }; }, { required: true }),
          field(t('maxOutputTokens'), state.draft.budget?.max_output_tokens, (value) => { state.draft.budget = { ...state.draft.budget, max_output_tokens: Number(value) }; }, { required: true }),
        ]),
        action(t('save'), () => execute(async () => {
          const profile = await api.saveConnection(state.draft);
          state.draft.apiKey = '';
          if (!state.symbol) { go('connection'); state.message = t('saved'); }
          else await chooseConnection(profile);
        })),
        text(''), text(t('billing')),
      ];
      case 'models': return [
        ...(state.moreModels ? wrapText(t('moreModels'), Math.max(1, (output.columns || 80) - 8)).map(text) : []),
        ...(state.models.length ? state.models.map((model) => action(`${model.name || model.id} / ${model.id}`, () => { state.draft.model = model.id; go('account'); })) : [text(t('unavailable'))]),
        action(t('back'), () => go('account')),
      ];
      case 'auth': return [
        ...state.authURLs.map((url) => action(url, () => openURL(url))),
        action(t('cancel'), () => state.authAbort?.abort()),
        ...wrapText(state.authOutput, Math.max(1, (output.columns || 80) - 8)).map(text),
      ];
      case 'configuration': return [
        text(`${state.symbol} / ${state.connection?.name || ''} / ${state.connection?.model || 'Codex'}`),
        ...(state.connection?.capabilities?.web_search === false ? wrapText(t('noSearch'), Math.max(1, (output.columns || 80) - 8)).map(text) : []),
        action(`${t('mode')}: ${t(state.mode)}`, () => { state.mode = state.mode === 'full' ? 'quick' : 'full'; }),
        ...(state.mode === 'full' ? [
          action(`${t('pace')}: ${t(state.pace)}`, () => { state.pace = ['fast', 'normal', 'slow'][(['fast', 'normal', 'slow'].indexOf(state.pace) + 1) % 3]; }),
          action(`${t('analysts')}: ${t(state.analystScope)}`, () => { state.analystScope = state.analystScope === 'core' ? 'all' : 'core'; }),
        ] : [text(`${t('pace')}: 10 min`)]),
        action(t('methods'), () => execute(prepareMethods)),
        text(''), text(t('billing')),
      ];
      case 'methods': return [
        ...wrapText(state.selection.display_markdown, Math.max(1, (output.columns || 80) - 8)).map(text),
        text(''),
        text(`${t('selected')}: ${state.methods.size} / ${state.selection.maximum}`),
        action(t('review'), () => {
          if (!state.methods.size || state.methods.size > state.selection.maximum) throw new Error(`${t('methods')}: 1–${state.selection.maximum}`);
          go('review');
        }),
        ...(state.mode === 'full' ? [action(t('selectAll'), () => { state.methods = new Set(state.selection.masters.map((master) => master.id)); })] : []),
        action(t('clear'), () => state.methods.clear()),
        action(t('details'), () => showDetail(t('methods'), [state.selection.display_markdown, ...state.selection.masters.map((master, index) => `${master.index || index + 1}. ${master.title || master.id}\n${master.identity}\n${master.method}\n${master.best_for}`)].join('\n\n'), 'methods')),
        ...state.selection.masters.map((master, index) => action(`${state.methods.has(master.id) ? '[x]' : '[ ]'} ${master.index || index + 1}. ${master.title || master.name || master.id} — ${master.method || ''}`, () => {
          if (state.methods.has(master.id)) state.methods.delete(master.id);
          else if (state.methods.size < state.selection.maximum) state.methods.add(master.id);
          else throw new Error(`${t('methods')}: 1–${state.selection.maximum}`);
        })),
      ];
      case 'review': return [
        text(`${t('symbol')}: ${state.symbol}`),
        text(`${t('language')}: ${researchLanguage(state.language).name}`),
        text(`${t('model')}: ${state.connection.name} / ${state.connection.model || 'Codex'}`),
        ...(state.connection.capabilities?.web_search === false ? wrapText(t('noSearch'), Math.max(1, (output.columns || 80) - 8)).map(text) : []),
        ...(state.connection.budget ? [text(`${t('maxRequests')}: ${state.connection.budget.max_requests}`), text(`${t('maxOutputTokens')}: ${state.connection.budget.max_output_tokens}`)] : []),
        ...(state.connection.routing_policy?.mode === 'platform_managed' ? wrapText(t('routing'), Math.max(1, (output.columns || 80) - 8)).map(text) : []),
        text(`${t('mode')}: ${t(state.mode)} / ${state.mode === 'full' ? t(state.pace) : '10 min'}`),
        text(`${t('methods')}: ${state.methods.size}`),
        ...state.selection.masters.filter((master) => state.methods.has(master.id)).map((master) => text(`  ${master.title || master.name || master.id}`)),
        text(''), text(t('billing')),
        action(t('start'), () => execute(startResearch)), action(t('back'), () => go('methods')),
      ];
      case 'history': return [
        field('/', state.query, (value) => { state.query = value; }),
        ...api.listRuns({ query: state.query, limit: 200 }).map((run) => action(`${run.symbol || run.run_id} / ${run.status?.status || run.status || ''} / ${run.run_id}`, () => {
          state.runId = run.run_id; state.run = api.loadRun(run.run_id); go('run');
        })),
        ...(api.listRuns({ query: state.query, limit: 1 }).length ? [] : [text(t('noRuns'))]),
        action(t('newResearch'), () => { state.symbol = ''; go('language'); }),
      ];
      case 'run': {
        const run = state.run, status = run.status;
        const statusValue = typeof status === 'object' ? status.status || status.terminal_contract?.terminal : status;
        return [
          text(`${state.runId} / ${statusValue || t('unknown')}`),
          text(`${t('runLanguage')}: ${researchLanguage(status.language)?.name || status.language || t('unknown')}`),
          ...['evidence', 'methods', 'debate', 'report', 'sources'].map((kind) => {
            const items = (run.items || []).filter((item) => item.kind === (kind === 'methods' ? 'method' : kind) || kind === 'report' && item.kind === 'decision');
            return action(`${t(kind)}  ${items.filter((item) => item.available).length}/${items.length}`, () => { state.category = kind; go('artifacts'); });
          }),
          action(t('events'), () => showDetail(t('events'), JSON.stringify(run.events || [], null, 2), 'run')),
          ...(status.worker_usage ? [action(t('model'), () => showDetail(t('model'), JSON.stringify({ execution: status.worker_execution_config, usage: status.worker_usage }, null, 2), 'run'))] : []),
          ...(!TERMINAL_STATES.has(statusValue) && run.runner?.alive ? [action(t('stop'), () => go('stop'))] : []),
          text(''), text(t('noPrivateThinking')),
          text(`${t('status')}: ${run.runner?.state || statusValue || t('unknown')}`),
        ];
      }
      case 'artifacts': {
        const items = (state.run.items || []).filter((item) => item.kind === (state.category === 'methods' ? 'method' : state.category) || state.category === 'report' && item.kind === 'decision');
        return items.length ? items.map((item) => {
          const label = `${item.role || item.id}${item.round ? ` / ${item.round}` : ''}  [${item.status}]`;
          return item.available ? action(label, () => {
            const artifact = api.readArtifact(state.runId, item.id);
            showDetail(label, artifact.content, 'artifacts');
          }) : text(label);
        }) : [text(t('noArtifacts'))];
      }
      case 'stop': return [text(t('confirmStop')), text(t('billing')),
        action(t('stop'), () => { api.stop(state.runId); state.run = api.loadRun(state.runId); go('run'); }),
        action(t('cancel'), () => go('run')),
      ];
      case 'detail': {
        const width = output.columns || 80;
        const columns = Math.max(1, width - 8 - (width >= 120 ? 21 : 0));
        if (state.detail.columns !== columns) {
          state.detail.columns = columns;
          state.detail.rows = wrapText(state.detail.content, columns).map(text);
        }
        return state.detail.rows;
      }
      default: return [];
    }
  }
  function title() {
    if (state.page === 'language') return 'Language / 语言 / 言語 / 언어';
    if (state.page === 'detail') return state.detail.title;
    const label = { symbol: 'symbol', connection: 'connections', profile: 'connections', provider: 'provider', account: 'connections', models: 'availableModels', auth: 'login', configuration: 'mode', review: 'review', artifacts: state.category, stop: 'stop' }[state.page] || state.page;
    return t(label);
  }
  function render() {
    if (state.closed) return;
    try {
      state.rows = pageRows();
      state.selected = Math.max(0, Math.min(state.selected, state.rows.length - 1));
      const editing = state.editing;
      let visibleValue = editing ? (editing.secret ? '*'.repeat([...editing.value].length) : editing.value) : '';
      if (editing) {
        const characters = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(visibleValue)];
        let width = 0, start = characters.length;
        while (start > 0 && width + stringWidth(characters[start - 1].segment) <= Math.max(1, (output.columns || 80) - 7)) width += stringWidth(characters[--start].segment);
        visibleValue = characters.slice(start).map((part) => part.segment).join('');
      }
      const rows = editing ? [text(editing.label), text(''), text(visibleValue)] : state.rows;
      const body = state.page === 'detail' || editing;
      const result = screen.draw({
        title: `AlphaCouncil | ${title()}`,
        showLogo: state.page === 'language',
        cursor: editing ? { row: 2, column: 2 + stringWidth(visibleValue) } : undefined,
        subtitle: [state.symbol, researchLanguage(state.language)?.name, state.connection?.name].filter(Boolean).join(' / '),
        rows, selected: body ? -1 : state.selected, offset: editing ? 0 : state.offset,
        footer: editing ? t('editHint') : body ? t('readHint') : t('chooseHint'),
        message: state.busy ? `${t('loading')} ${state.message}` : state.message,
        navigation: ['history', 'run', 'artifacts', 'detail'].includes(state.page) && !editing ? [
          action(t('newResearch'), () => { state.symbol = ''; go('language'); }), action(t('history'), () => go('history')),
        ] : [], smallTerminal: t('smallTerminal'),
      });
      state.visible = result.visible; state.offset = result.offset;
    } catch (error) {
      state.message = errorMessage(error);
      state.rows = [];
      screen.draw({ title: 'AlphaCouncil', rows: wrapText(state.message, Math.max(1, (output.columns || 80) - 8)).map(text), footer: t('chooseHint'), smallTerminal: t('smallTerminal') });
    }
  }
  function handleInput(event) {
    if (event.key === 'interrupt' || (!state.editing && event.key === 'text' && event.text === 'q')) return close();
    if (state.busy && state.page !== 'auth') return;
    if (state.page === 'auth' && event.key === 'escape') { state.authAbort?.abort(); return; }
    try {
      if (state.editing) {
        const editState = state.editing;
        if (event.key === 'escape') { editState.value = ''; state.editing = null; }
        else if (event.key === 'enter') {
          if (editState.required && !editState.value.trim()) throw new Error(t('required'));
          editState.apply(editState.value); editState.value = ''; state.editing = null;
        } else if (event.key === 'backspace') {
          const chars = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(editState.value)];
          editState.value = chars.slice(0, -1).map((part) => part.segment).join('');
        } else if (['text', 'paste'].includes(event.key)) {
          const limit = editState.secret ? 16384 : 8192;
          editState.value = (editState.value + cleanText(event.text)).slice(0, limit);
        }
      } else if (event.key === 'escape' || event.key === 'left') back();
      else if (event.key === 'mouse' && event.button === 0) {
        const hit = screen.hits.find((item) => item.y === event.y && event.x >= item.x1 && event.x <= item.x2);
        if (hit) { if (hit.index !== undefined) state.selected = hit.index; hit.action(); }
      } else if (state.page === 'detail') {
        const step = ['pageup', 'pagedown'].includes(event.key) ? state.visible : 1;
        if (['down', 'pagedown'].includes(event.key)) state.offset += step;
        if (['up', 'pageup'].includes(event.key)) state.offset = Math.max(0, state.offset - step);
        if (event.key === 'home') state.offset = 0;
        if (event.key === 'end') state.offset = state.rows.length;
      } else {
        if (['enter', 'right'].includes(event.key) || event.key === 'text' && event.text === ' ') state.rows[state.selected]?.action?.();
        const direction = ['down', 'tab', 'pagedown'].includes(event.key) ? 1 : ['up', 'shiftTab', 'pageup'].includes(event.key) ? -1 : 0;
        if (direction) {
          const step = ['pageup', 'pagedown'].includes(event.key) ? state.visible : 1;
          state.selected = Math.max(0, Math.min(state.rows.length - 1, state.selected + direction * step));
          while (state.selected > 0 && state.selected < state.rows.length - 1 && !state.rows[state.selected]?.action) state.selected += direction;
        }
        if (event.key === 'home') state.selected = 0;
        if (event.key === 'end') state.selected = state.rows.length - 1;
        if (state.selected < state.offset) state.offset = state.selected;
        if (state.selected >= state.offset + state.visible) state.offset = state.selected - state.visible + 1;
      }
    } catch (error) { state.message = errorMessage(error); }
    render();
  }
  function refresh() {
    if (!state.busy && state.runId && ['run', 'artifacts'].includes(state.page)) {
      try { state.run = api.loadRun(state.runId); render(); } catch (error) { state.message = errorMessage(error); }
    }
  }
  const resize = () => render();
  function close() {
    if (state.closed) return;
    state.closed = true; abort.abort(); clearInterval(refreshTimer);
    if (state.editing) state.editing.value = '';
    if (state.draft) state.draft.apiKey = '';
    output.removeListener('resize', resize);
    process.removeListener('SIGTERM', close);
    screen.stop(); done();
  }
  return {
    state, handleInput, render, close, completed,
    start() {
      state.selected = RESEARCH_LANGUAGES.findIndex((entry) => entry.locale === state.language);
      screen.start(); output.on('resize', resize); process.on('SIGTERM', close);
      refreshTimer = setInterval(refresh, 1000); refreshTimer.unref(); render();
    },
  };
}

export async function runTerminal(initial = {}) {
  const [service, connections, providers] = await Promise.all([
    import('./service.mjs'), import('./connections.mjs'), import('./providers.mjs'),
  ]);
  const app = createTerminalApp({ ...service, ...connections, ...providers }, { initial });
  app.start();
  await app.completed;
}
