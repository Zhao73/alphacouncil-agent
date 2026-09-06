import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import stringWidth from 'string-width';
import { DATA_DIR } from '../mcp/lib/constants.mjs';
import { RESEARCH_LANGUAGES, researchLanguage } from '../mcp/lib/lang.mjs';
import { safeSymbol } from '../mcp/lib/run-store.mjs';
import { Screen, cleanText, wrapText } from './screen.mjs';
import { translator } from './i18n.mjs';
import { CONNECTION_PRESETS } from './provider-catalog.mjs';

const SETTINGS = join(DATA_DIR, 'terminal', 'settings.json');
const TERMINAL_STATES = new Set(['complete', 'completed', 'degraded', 'incomplete', 'failed', 'needs_revision', 'needs_verification']);
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
    query: '', modelQuery: '', models: [], moreModels: false, modelError: '', catalogSource: '', advanced: false,
    authOutput: '', authURLs: [], authAbort: null, operationAbort: null, closed: false,
    historyBack: 'symbol', locations: {}, detailQuery: '', detailMatches: [], matchIndex: -1, entryPending: true,
  };
  let done, refreshTimer, lastClick;
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
    state.locations[state.page] = { selected: state.selected, offset: state.offset };
    if (page === 'history' && !['history', 'run', 'artifacts', 'detail'].includes(state.page)) state.historyBack = state.page;
    state.page = page;
    state.selected = page === 'language' ? RESEARCH_LANGUAGES.findIndex((entry) => entry.locale === state.language) : state.locations[page]?.selected || 0;
    state.offset = state.locations[page]?.offset || 0; state.message = ''; state.editing = null;
  }
  function showDetail(title, content, back = state.page) {
    state.detail = { title, content }; state.previous = back; state.detailQuery = ''; state.detailMatches = []; state.matchIndex = -1;
    delete state.locations.detail; go('detail');
  }
  function edit(label, value, apply, { secret = false, required = false } = {}) {
    const index = state.rows.findIndex((row) => row.text.startsWith(`${label}:`));
    state.editing = { label, value: String(value || ''), apply, secret, required, offset: state.offset, index: Math.max(0, index < 0 ? (state.page === 'detail' ? state.offset : state.selected) : index), caret: [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(String(value || ''))].length };
    state.message = '';
  }
  function field(label, value, apply, options) {
    return action(`${label}: ${options?.secret ? (value ? '********' : '') : value || ''}`, () => edit(label, value, apply, options));
  }
  function errorMessage(error) {
    const key = { OPERATION_CANCELLED: 'operationCancelled', OPERATION_TIMEOUT: 'operationTimeout', COMMAND_UNAVAILABLE: 'commandUnavailable', MODEL_PROTOCOL_UNKNOWN: 'protocolUnknown' }[error?.code || error?.error_code];
    if (key) return t(key);
    let message = cleanText(error?.message || error?.error || error);
    if (state.draft?.apiKey) message = message.split(state.draft.apiKey).join('[redacted]');
    return `${t('error')}: ${message}`;
  }
  async function execute(fn, { cancellable = false } = {}) {
    if (state.busy || state.closed) return;
    state.busy = true; state.operationAbort = cancellable ? new AbortController() : null;
    const cancel = () => state.operationAbort?.abort();
    abort.signal.addEventListener('abort', cancel, { once: true });
    state.message = t('loading'); render();
    try { await fn(state.operationAbort?.signal || abort.signal); if (state.message === t('loading')) state.message = ''; }
    catch (error) { state.message = errorMessage(error); }
    finally { abort.signal.removeEventListener('abort', cancel); state.busy = false; state.operationAbort = null; if (!state.closed) render(); }
  }
  function research() {
    return { symbol: safeSymbol(state.symbol.trim()), prompt: '', language: state.language,
      council_mode: state.mode, ...(state.mode === 'full' ? { council_pace: state.pace, analyst_scope: state.analystScope } : {}) };
  }
  async function chooseConnection(profile, signal = abort.signal) {
    const apiKey = await api.getConnectionSecret(profile);
    state.message = t('checking'); render();
    const result = await api.probeConnection(profile, { apiKey, signal });
    if (signal.aborted) throw Object.assign(new Error(), { code: 'OPERATION_CANCELLED' });
    if (!result.ok) throw Object.assign(new Error(result.error || t('unavailable')), { code: result.error_code });
    state.connection = { ...profile, capabilities: result.capabilities };
    go(state.symbol ? 'configuration' : 'symbol');
  }
  function preset() {
    return CONNECTION_PRESETS.find((item) => !item.info_only && (state.draft?.provider === 'compatible'
      ? item.base_url === state.draft.base_url : item.provider === state.draft?.provider));
  }
  async function loadModels(signal) {
    const apiKey = state.draft.apiKey || (state.draft.id ? await api.getConnectionSecret(state.draft) : undefined);
    let result;
    try { result = await api.listModels(state.draft, { apiKey, signal }); }
    catch (error) { result = { error: error.message, error_code: error.code, models: [] }; }
    if (signal.aborted) throw Object.assign(new Error(), { code: 'OPERATION_CANCELLED' });
    state.models = result.models || []; state.moreModels = result.has_more === true;
    state.catalogSource = result.catalog_source; state.modelError = result.error ? errorMessage(result) : '';
    state.modelQuery = ''; delete state.locations.models; go('models');
  }
  function saveEdit() {
    const editing = state.editing;
    if (editing.required && !editing.value.trim()) throw new Error(t('required'));
    state.message = ''; editing.apply(editing.value); editing.value = ''; state.editing = null;
  }
  function nextMatch() {
    if (!state.detailMatches.length) { state.message = t('noMatches'); return; }
    state.matchIndex = (state.matchIndex + 1) % state.detailMatches.length;
    state.offset = state.detailMatches[state.matchIndex];
    state.message = `${t('search')}: ${state.detailQuery}  ${state.matchIndex + 1}/${state.detailMatches.length}`;
  }
  function search() {
    if (state.page === 'detail') edit(t('search'), state.detailQuery, (value) => {
      state.detailQuery = value; state.matchIndex = -1;
      state.detailMatches = value ? state.detail.rows.flatMap((row, index) => row.text.toLocaleLowerCase().includes(value.toLocaleLowerCase()) ? [index] : []) : [];
      nextMatch();
    });
    else if (state.page === 'models') edit(t('search'), state.modelQuery, (value) => { state.modelQuery = value.trim(); state.offset = 0; });
    else if (state.page === 'history') edit(t('search'), state.query, (value) => { state.query = value.trim(); state.offset = 0; });
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
      if (!result.ok) throw Object.assign(new Error(result.error || t('unavailable')), { code: result.error_code });
      go('account'); state.message = t('connected');
      await loadModels(state.authAbort.signal);
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
    delete state.locations.methods; delete state.locations.review;
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
    if (state.editing) { state.offset = state.editing.offset; state.editing.value = ''; state.editing = null; state.message = ''; return; }
    if (state.page === 'detail') return go(state.previous || 'run');
    const parent = { symbol: 'language', connection: 'symbol', profile: 'connection', provider: 'connection', account: state.draft?.id ? 'profile' : 'provider', models: 'account', configuration: 'connection', methods: 'configuration', review: 'methods', stop: 'run', run: 'history', artifacts: 'run', history: state.historyBack };
    go(parent[state.page] || 'language');
  }
  function pageRows() {
    switch (state.page) {
      case 'language': return RESEARCH_LANGUAGES.map((entry) => action(`${entry.locale === state.language ? '(*)' : '( )'} ${entry.name}`, () => {
        state.language = entry.locale; saveSettings();
        const first = state.entryPending; state.entryPending = false;
        if (first && initial.command === 'runs') go('history');
        else if (first && initial.command === 'connect') go('connection');
        else if (first && initial.runId) { state.run = api.loadRun(state.runId); go('run'); }
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
        action(t('next'), () => execute((signal) => chooseConnection(state.connection, signal), { cancellable: true })),
        action(`${t('model')} / ${t('apiKey')}`, () => {
          state.draft = { ...state.connection, budget: { ...(state.connection.budget || api.DEFAULT_CONNECTION_BUDGET) }, apiKey: undefined };
          go('account');
        }),
        action(t('test'), () => execute(async (signal) => {
          const apiKey = await api.getConnectionSecret(state.connection);
          const result = await api.probeConnection(state.connection, { apiKey, signal });
          showDetail(t('capabilities'), JSON.stringify(result, null, 2), 'profile');
        }, { cancellable: true })),
        action(t('remove'), () => execute(async () => { await api.deleteConnection(state.connection.id); state.connection = null; go('connection'); })),
        ...(state.connection.provider === 'codex' ? [action(t('disconnect'), () => execute(async () => {
          const result = await api.logoutCodex({ signal: abort.signal });
          if (!result.ok) throw new Error(result.error || t('unavailable'));
          state.message = t('disconnect');
        }))] : []),
        text(''), text(t('billing')),
      ];
      case 'provider': return CONNECTION_PRESETS.map((entry) => action(entry.name + (entry.info_only ? ` / ${t('details')}` : ''), () => {
        if (entry.info_only) return showDetail(entry.name, `${t(entry.notice_key)}\n\n${entry.docs_url}`, 'provider');
        state.draft = { provider: entry.provider, model: '', name: entry.name, storage: process.platform === 'linux' ? 'session' : 'system', apiKey: '', base_url: entry.base_url || '', api_format: entry.api_format, budget: { ...api.DEFAULT_CONNECTION_BUDGET } };
        state.advanced = false; delete state.locations.account;
        go('account');
      }));
      case 'account': return [
        text(state.draft.name),
        ...(preset()?.notice_key ? wrapText(t(preset().notice_key), Math.max(1, (output.columns || 80) - 8)).map(text) : []),
        ...(state.draft.provider === 'codex' ? [
          action(t('officialLogin'), () => execute(signInCodex)),
        ] : [
          field(t('apiKey'), state.draft.apiKey, (value) => { state.draft.apiKey = value.trim(); }, { secret: true, required: true }),
          ...(!preset()?.base_url && state.draft.provider === 'compatible' ? [field(t('baseURL'), state.draft.base_url, (value) => { state.draft.base_url = value.trim(); }, { required: true })] : []),
        ]),
        action(`${t('model')}: ${state.draft.model || (state.draft.provider === 'codex' ? t('defaultModel') : t('chooseModel'))}`, () => execute(loadModels, { cancellable: true })),
        action(t('save'), () => execute(async () => {
          const profile = await api.saveConnection(state.draft);
          state.draft = { ...profile, apiKey: '' }; state.connection = profile;
          if (!state.symbol) { go('connection'); state.message = t('saved'); }
          else {
            go('profile'); state.message = t('saved');
            state.operationAbort = new AbortController();
            try { await chooseConnection(profile, state.operationAbort.signal); }
            catch (error) { state.message = `${t('savedCheckFailed')} ${errorMessage(error)}`; }
          }
        })),
        action(`${state.advanced ? '[-]' : '[+]'} ${t('advanced')}`, () => { state.advanced = !state.advanced; }),
        ...(state.advanced ? [
          field(t('name'), state.draft.name, (value) => { state.draft.name = value; }, { required: true }),
          ...(state.draft.provider !== 'codex' ? [
          ...(state.draft.provider === 'compatible' ? [
            field(t('baseURL'), state.draft.base_url, (value) => { state.draft.base_url = value.trim(); }, { required: true }),
            action(`${t('protocol')}: ${state.draft.api_format || t('unknown')}`, () => {
              state.draft.api_format = ['chat', 'responses', 'messages'][(['chat', 'responses', 'messages'].indexOf(state.draft.api_format) + 1) % 3];
            }),
          ] : []),
          action(`${t('storage')}: ${t(state.draft.storage)}`, () => { state.draft.storage = state.draft.storage === 'system' ? 'session' : 'system'; }),
          field(t('maxRequests'), state.draft.budget?.max_requests, (value) => { state.draft.budget = { ...state.draft.budget, max_requests: Number(value) }; }, { required: true }),
          field(t('maxOutputTokens'), state.draft.budget?.max_output_tokens, (value) => { state.draft.budget = { ...state.draft.budget, max_output_tokens: Number(value) }; }, { required: true }),
          ] : []),
        ] : []),
        text(''), text(t('billing')),
      ];
      case 'models': return [
        field(t('search'), state.modelQuery, (value) => { state.modelQuery = value.trim(); state.offset = 0; }),
        ...(state.draft.provider === 'codex' ? [action(t('defaultModel'), () => { state.draft.model = ''; go('account'); })] : []),
        action(t('refresh'), () => execute(loadModels, { cancellable: true })),
        action(t('manualModel'), () => edit(t('manualModel'), state.draft.model, (value) => { state.draft.model = value.trim(); go('account'); }, { required: true })),
        ...wrapText(state.catalogSource === 'documentation' ? t('documentationModels') : t('modelAccessHint'), Math.max(1, (output.columns || 80) - 8)).map(text),
        ...(state.modelError ? wrapText(`${t('modelListFailed')} ${state.modelError}`, Math.max(1, (output.columns || 80) - 8)).map(text) : []),
        ...(state.moreModels ? wrapText(t('moreModels'), Math.max(1, (output.columns || 80) - 8)).map(text) : []),
        ...state.models.filter((model) => `${model.name || ''} ${model.id}`.toLowerCase().includes(state.modelQuery.toLowerCase())).map((model) => {
          const label = `${model.id === state.draft.model ? '(*)' : '( )'} ${model.name || model.id}${model.name && model.name !== model.id ? ` / ${model.id}` : ''}${model.default ? ` / ${t('defaultModel')}` : ''}`;
          return model.selectable === false ? text(`${label} / ${t('protocolUnknown')}`) : action(label, () => {
            state.draft.model = model.id; if (model.api_format) state.draft.api_format = model.api_format; go('account');
          });
        }),
        ...(!state.models.some((model) => `${model.name || ''} ${model.id}`.toLowerCase().includes(state.modelQuery.toLowerCase())) ? [text(t('noMatches'))] : []),
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
      case 'history': {
        const runs = api.listRuns({ query: state.query, limit: 200 });
        return [
        field(t('search'), state.query, (value) => { state.query = value.trim(); state.offset = 0; }),
        text(t('searchHint')),
        ...runs.map((run) => action(`${run.symbol || run.run_id} / ${run.status?.status || run.status || ''} / ${run.started_at?.slice(0, 16).replace('T', ' ') || ''} / ${run.run_id}`, () => {
          state.runId = run.run_id; state.run = api.loadRun(run.run_id); go('run');
        })),
        ...(runs.length ? [] : [text(t(state.query ? 'noMatches' : 'noRuns'))]),
        action(t('newResearch'), () => { state.symbol = ''; go('language'); }),
      ];
      }
      case 'run': {
        const run = state.run, status = run.status;
        const statusValue = typeof status === 'object' ? status.status || status.terminal_contract?.terminal : status;
        const elapsed = Math.floor(((TERMINAL_STATES.has(statusValue) ? Date.parse(status.completed_at || status.finished_at || status.updated_at) : Date.now()) - Date.parse(status.started_at)) / 1000);
        return [
          text(`${state.runId} / ${statusValue || t('unknown')}`),
          text(`${t('runLanguage')}: ${researchLanguage(status.language)?.name || status.language || t('unknown')}`),
          text(`${t('elapsed')}: ${Number.isFinite(elapsed) ? `${Math.max(0, elapsed)}s` : t('unknown')}`),
          text(`${t('progress')}: ${status.phase || statusValue || t('unknown')}`),
          text(''),
          ...['evidence', 'methods', 'debate', 'report', 'sources'].map((kind) => {
            const items = (run.items || []).filter((item) => item.kind === (kind === 'methods' ? 'method' : kind) || kind === 'report' && item.kind === 'decision');
            const count = items.filter((item) => item.available).length;
            const failed = items.filter((item) => ['failed', 'incomplete', 'not_produced'].includes(item.status)).length;
            return action(`${t(kind)}  [${'#'.repeat(Math.round(count / Math.max(1, items.length) * 10)).padEnd(10, '-')}] ${count}/${items.length}${failed ? `  ${t('failed')}: ${failed}` : ''}`, () => { state.category = kind; delete state.locations.artifacts; go('artifacts'); });
          }),
          text(''),
          ...(run.events || []).slice(-3).map((event) => text(`${(event.at || '').slice(11, 19)}  ${event.stage || event.type || ''}  ${event.task || event.master || event.role || ''}  ${event.status || event.reason || ''}`)),
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
        const columns = Math.max(1, width - 8);
        if (state.detail.columns !== columns) {
          state.detail.columns = columns;
          state.detail.rows = wrapText(state.detail.content, columns).map(text);
          if (state.detailQuery) {
            state.detailMatches = state.detail.rows.flatMap((row, index) => row.text.toLocaleLowerCase().includes(state.detailQuery.toLocaleLowerCase()) ? [index] : []);
            state.matchIndex = Math.min(state.matchIndex, state.detailMatches.length - 1);
            if (state.matchIndex >= 0) state.offset = state.detailMatches[state.matchIndex];
          }
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
      const rows = state.rows.map((row) => editing || state.busy && state.page !== 'auth' ? text(row.text) : row);
      const visibleRows = Math.max(1, (output.rows || 24) - (state.page === 'language' && !state.busy ? 9 : 10));
      if (!editing && state.page !== 'detail') {
        state.offset = Math.min(state.offset, state.selected);
        if (state.selected >= state.offset + visibleRows) state.offset = state.selected - visibleRows + 1;
      }
      let cursor;
      if (editing) {
        const index = state.rows.findIndex((row) => row.text.startsWith(`${editing.label}:`));
        if (index >= 0) editing.index = index;
        const label = wrapText(editing.label, 20)[0] + ': ';
        const characters = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(editing.value)].map(({ segment }) => editing.secret ? '*' : segment);
        let width = 0, start = editing.caret;
        const room = Math.max(1, (output.columns || 80) - stringWidth(label) - 7);
        while (start > 0 && width + stringWidth(characters[start - 1]) <= room) width += stringWidth(characters[--start]);
        rows[editing.index] = text(label + characters.slice(start).join(''));
        const visible = Math.max(1, (output.rows || 24) - 10);
        state.offset = Math.min(state.offset, editing.index);
        if (editing.index >= state.offset + visible) state.offset = editing.index - visible + 1;
        state.offset = Math.max(0, Math.min(state.offset, Math.max(0, rows.length - visible)));
        cursor = { row: editing.index - state.offset, column: 2 + stringWidth(label) + width };
      }
      const body = state.page === 'detail' || editing;
      const navigation = editing ? [action(t('save'), saveEdit), action(t('cancel'), back)]
        : state.busy ? (state.authAbort || state.operationAbort ? [action(t('cancel'), () => (state.authAbort || state.operationAbort).abort())] : [text(t('loading'))])
        : state.page === 'language' ? [] : [
          action(t('back'), back),
          ...(['run', 'artifacts', 'detail'].includes(state.page) && state.run ? [action(t('run'), () => go('run'))] : []),
          action(t('history'), () => go('history')),
          action(t('newResearch'), () => { state.symbol = ''; go('language'); }),
          ...(['models', 'history', 'detail'].includes(state.page) ? [action(t('search'), search)] : []),
        ];
      const steps = { language: 1, symbol: 2, connection: 3, provider: 3, profile: 3, account: 3, models: 3, auth: 3, configuration: 4, methods: 4, review: 5 };
      const result = screen.draw({
        title: `AlphaCouncil | ${title()}${steps[state.page] ? `  ${steps[state.page]}/5` : ''}`,
        showLogo: state.page === 'language',
        cursor,
        subtitle: [state.symbol, researchLanguage(state.language)?.name, state.connection?.name].filter(Boolean).join(' / '),
        rows, selected: body ? -1 : state.selected, offset: state.offset,
        footer: editing ? t('editHint') : body ? t('readHint') : t('chooseHint'),
        message: state.message,
        navigation, smallTerminal: t('smallTerminal'),
      });
      state.visible = result.visible; state.offset = result.offset;
    } catch (error) {
      state.message = errorMessage(error);
      state.rows = [];
      screen.draw({ title: 'AlphaCouncil', rows: wrapText(state.message, Math.max(1, (output.columns || 80) - 8)).map(text), navigation: [action(t('back'), back)], footer: t('chooseHint'), smallTerminal: t('smallTerminal') });
    }
  }
  function handleInput(event) {
    if (event.key === 'interrupt' || (!state.editing && event.key === 'text' && event.text === 'q')) return close();
    if (((output.columns || 80) < 80 || (output.rows || 24) < 24) && event.key !== 'escape') return;
    try {
      if (event.key === 'mouse' && event.button === 0) {
        const hit = screen.hits.find((item) => item.y === event.y && event.x >= item.x1 && event.x <= item.x2);
        if (hit?.action) {
          const context = `${state.page}:${Boolean(state.editing)}`;
          if (lastClick && context !== lastClick.context && Date.now() - lastClick.at < 300) return;
          lastClick = { context, at: Date.now() };
          if (hit.index !== undefined) state.selected = hit.index;
          hit.action();
        }
      } else if (state.busy && (state.page !== 'auth' || event.key === 'escape')) {
        if (event.key === 'escape') (state.authAbort || state.operationAbort)?.abort();
      } else if (state.editing) {
        const editState = state.editing;
        const chars = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(editState.value)].map(({ segment }) => segment);
        if (event.key === 'escape') back();
        else if (event.key === 'enter') saveEdit();
        else if (event.key === 'left') editState.caret = Math.max(0, editState.caret - 1);
        else if (event.key === 'right') editState.caret = Math.min(chars.length, editState.caret + 1);
        else if (event.key === 'home') editState.caret = 0;
        else if (event.key === 'end') editState.caret = chars.length;
        else if (event.key === 'clearInput') { editState.value = ''; editState.caret = 0; }
        else if (event.key === 'backspace' || event.key === 'delete') {
          if (event.key === 'backspace' && editState.caret > 0) chars.splice(--editState.caret, 1);
          else if (event.key === 'delete') chars.splice(editState.caret, 1);
          editState.value = chars.join('');
        } else if (['text', 'paste'].includes(event.key)) {
          const limit = editState.secret ? 16384 : 8192;
          const inserted = cleanText(event.text).replace(/[\r\n]/g, ' ');
          const before = chars.slice(0, editState.caret).join('') + inserted;
          const next = before + chars.slice(editState.caret).join('');
          if (next.length <= limit) {
            editState.value = next;
            editState.caret = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(before)].length;
          }
        }
      } else if (event.key === 'escape' || event.key === 'left') back();
      else if (event.key === 'text' && event.text === '/' && ['history', 'models', 'detail'].includes(state.page)) search();
      else if (state.page === 'detail') {
        if (event.key === 'text' && event.text === 'n') nextMatch();
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
    if (!state.busy && !state.editing && state.runId && ['run', 'artifacts'].includes(state.page)) {
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
