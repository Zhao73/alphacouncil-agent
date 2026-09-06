import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deleteConnection, getConnection, getConnectionSecret, getCodexLoginStatus, listCodexModels, listConnections, loginCodex, normalizeConnection, saveConnection } from "../connections.mjs";

function codexFixture(t, source) {
  const dir = mkdtempSync(join(tmpdir(), "alpha-codex-command-"));
  const original = process.env.ALPHACOUNCIL_CODEX_BIN;
  const script = join(dir, "codex.mjs");
  writeFileSync(script, source);
  process.env.ALPHACOUNCIL_CODEX_BIN = script;
  t.after(() => {
    if (original === undefined) delete process.env.ALPHACOUNCIL_CODEX_BIN; else process.env.ALPHACOUNCIL_CODEX_BIN = original;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, script };
}

test("session credentials never enter connection metadata and deletion removes access", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "alpha-connections-"));
  try {
    const profile = await saveConnection({ provider: "openai", model: "test-model", apiKey: "synthetic-secret-77", storage: "session" }, { dataDir });
    assert.equal(await getConnectionSecret(getConnection(profile.id, { dataDir })), "synthetic-secret-77");
    assert.doesNotMatch(readFileSync(join(dataDir, "terminal", "connections.json"), "utf8"), /synthetic-secret|apiKey/u);
    await deleteConnection(profile.id, { dataDir });
    await assert.rejects(getConnectionSecret(profile), /unavailable/u);
    assert.deepEqual(listConnections({ dataDir }), []);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("macOS secure storage writes over stdin and requires a matching readback", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "alpha-keychain-"));
  const secret = "synthetic-mac-secret-77";
  const encoded = Buffer.from(secret).toString("base64");
  const calls = [];
  let stored = "";
  const command = async (executable, args, options = {}) => {
    calls.push({ executable, args });
    if (args[0] === "-i") stored = / -w ([A-Za-z0-9+/=]+)\n/u.exec(options.input)[1];
    if (args[0] === "delete-generic-password") stored = "";
    return { code: 0, output: args[0] === "find-generic-password" ? stored : "" };
  };
  try {
    const options = { dataDir, platform: "darwin", command };
    const profile = await saveConnection({ provider: "anthropic", model: "test-model", apiKey: secret, storage: "system" }, options);
    assert.equal(await getConnectionSecret(profile, options), secret);
    assert.equal(calls[0].executable, "/usr/bin/security");
    assert.deepEqual(calls[0].args, ["-i"]);
    assert.equal(JSON.stringify(calls).includes(secret), false);
    assert.equal(JSON.stringify(calls).includes(encoded), false);
    assert.equal(readFileSync(join(dataDir, "terminal", "connections.json"), "utf8").includes(encoded), false);
    await deleteConnection(profile.id, options);
    assert.equal(stored, "");
    await assert.rejects(saveConnection({ provider: "openai", model: "test-model", apiKey: secret, storage: "system" }, { dataDir, platform: "darwin", command: async () => ({ code: 0, output: "" }) }), /did not confirm/u);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("Windows DPAPI persists only ciphertext and sends key material over stdin", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "alpha-dpapi-"));
  const secret = "synthetic-windows-secret";
  const encoded = Buffer.from(secret).toString("base64");
  const cipher = Buffer.from("SYNTHETIC_DPAPI_CIPHERTEXT").toString("base64");
  const command = async (executable, args, { input }) => {
    assert.equal(executable, "powershell.exe");
    assert.equal(JSON.stringify(args).includes(encoded), false);
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    assert.match(script, /DataProtectionScope\]::CurrentUser/u);
    const protecting = script.includes("::Protect(");
    assert.equal(input, protecting ? encoded : cipher);
    return { code: 0, output: protecting ? cipher : encoded };
  };
  try {
    const options = { dataDir, platform: "win32", command };
    const profile = await saveConnection({ provider: "openai", model: "test-model", apiKey: secret, storage: "system" }, options);
    assert.equal(readFileSync(join(dataDir, "terminal", `${profile.id}.dpapi`), "utf8"), cipher);
    assert.equal(await getConnectionSecret(profile, options), secret);
    await deleteConnection(profile.id, options);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("connection URLs reject embedded credentials and vendor endpoint substitution", () => {
  assert.throws(() => normalizeConnection({ provider: "compatible", model: "test", base_url: "https://user:secret@api.example/v1" }), /without credentials/u);
  assert.throws(() => normalizeConnection({ provider: "openai", model: "test", base_url: "https://api.example/v1" }), /compatible provider/u);
  assert.throws(() => normalizeConnection({ provider: "compatible", model: "test", base_url: "http://api.example/v1" }), /HTTPS/u);
});

test("compatible connections preserve their explicit transport format and old profiles default to chat", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alpha-compatible-format-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = { provider: "compatible", model: "test", base_url: "https://api.example/v1" };
  assert.equal(normalizeConnection(input).api_format, "chat");
  for (const api_format of ["chat", "responses", "messages"]) {
    const saved = await saveConnection({ ...input, api_format, storage: "session", apiKey: "synthetic-format-key" }, { dataDir: dir });
    assert.equal(getConnection(saved.id, { dataDir: dir }).api_format, api_format);
    await deleteConnection(saved.id, { dataDir: dir });
  }
  assert.throws(() => normalizeConnection({ ...input, api_format: "unknown" }), /API format/u);
  assert.throws(() => normalizeConnection({ ...input, api_format: {} }), /API format/u);
});

test("Zen and Go saves require a documented model protocol or an explicit format", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alpha-gateway-format-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = { dataDir: dir };
  for (const [base_url, expected] of [["https://opencode.ai/zen/v1/", "chat"], ["https://opencode.ai/zen/go/v1", "messages"]]) {
    const input = { provider: "compatible", model: "minimax-m3", base_url, storage: "session", apiKey: "synthetic-format-key" };
    assert.equal(normalizeConnection(input).api_format, expected);
    const known = await saveConnection(input, options);
    assert.equal(getConnection(known.id, options).api_format, expected);
    await deleteConnection(known.id, options);
    const unknown = { ...input, model: "unknown-gateway-model" };
    assert.throws(() => normalizeConnection(unknown), { code: "MODEL_PROTOCOL_UNKNOWN" });
    await assert.rejects(saveConnection(unknown, options), { code: "MODEL_PROTOCOL_UNKNOWN" });
    assert.equal(listConnections(options).length, 0);
    for (const api_format of ["chat", "responses", "messages"]) {
      assert.equal(normalizeConnection({ ...input, api_format }).api_format, api_format);
      const explicit = await saveConnection({ ...unknown, api_format }, options);
      assert.equal(getConnection(explicit.id, options).api_format, api_format);
      await deleteConnection(explicit.id, options);
    }
  }
});

test("official login is a piped CLI lifecycle that can be cancelled without touching auth tokens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alpha-login-fixture-"));
  const original = process.env.ALPHACOUNCIL_CODEX_BIN;
  const controller = new AbortController();
  const output = [];
  try {
    const script = join(dir, "codex-fixture.mjs");
    writeFileSync(script, "if (process.argv[2] !== 'login' || process.argv[3] !== '--device-auth') process.exit(2); process.stderr.write('https://auth.example/device\\nCODE-TEST\\n'); setInterval(() => {}, 1000);");
    process.env.ALPHACOUNCIL_CODEX_BIN = script;
    await assert.rejects(loginCodex({ device: true, signal: controller.signal, onOutput(text) { output.push(text); controller.abort(); } }), /cancelled/u);
    assert.match(output.join(""), /https:\/\/auth.example\/device/u);
  } finally {
    if (original === undefined) delete process.env.ALPHACOUNCIL_CODEX_BIN; else process.env.ALPHACOUNCIL_CODEX_BIN = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saving a Codex connection does not run authentication or secure-storage commands", async (t) => {
  const { dir } = codexFixture(t, "process.exit(99);");
  const options = { dataDir: dir, command() { throw new Error("Codex save must not read or write credentials"); } };
  const created = await saveConnection({ provider: "codex", model: "model-a", storage: "system" }, options);
  const updated = await saveConnection({ ...created, model: "model-b" }, options);
  assert.equal(updated.model, "model-b");
  assert.equal(updated.storage, undefined);
  assert.equal(updated.secret_ref, undefined);
  assert.equal(await getConnectionSecret(updated), undefined);
});

test("official model listing performs only the supported handshake and pagination, then stops its process", async (t) => {
  const { dir } = codexFixture(t, `
    import {createInterface} from 'node:readline';
    import {writeFileSync,appendFileSync} from 'node:fs';
    import {fileURLToPath} from 'node:url';
    const log=fileURLToPath(new URL('./requests.jsonl',import.meta.url));
    writeFileSync(new URL('./pid',import.meta.url),String(process.pid));
    if(process.argv[2]!=='app-server'||process.argv[3]!=='--stdio') process.exit(2);
    let initialized=false;
    createInterface({input:process.stdin}).on('line',line=>{
      const request=JSON.parse(line); appendFileSync(log,line+'\\n');
      if(request.method==='initialized'){initialized=true;return;}
      if(request.method==='initialize'){process.stdout.write(JSON.stringify({id:request.id,result:{userAgent:'fixture'}})+'\\n');return;}
      if(!initialized||request.method!=='model/list') process.exit(3);
      const second=!!request.params.cursor;
      const response=JSON.stringify({id:request.id,result:{data:[{id:'catalog-entry',model:second?'model-b':'model-a',displayName:second?'Second model':'First model',description:'Catalog only',isDefault:!second,hidden:false},{id:'hidden-entry',model:'hidden-model',displayName:'Hidden',isDefault:false,hidden:true}],nextCursor:second?null:'page-two'}})+'\\n';
      process.stdout.write(response.slice(0,12)); setTimeout(()=>process.stdout.write(response.slice(12)),5);
    });
    setInterval(()=>{},1000);
  `);
  const result = await listCodexModels();
  assert.equal(result.error, null);
  assert.equal(result.has_more, false);
  assert.deepEqual(result.models.map(({ id, name, default: isDefault }) => ({ id, name, isDefault })), [
    { id: "model-a", name: "First model", isDefault: true }, { id: "model-b", name: "Second model", isDefault: false },
  ]);
  const requests = readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(requests.map(({ method }) => method), ["initialize", "initialized", "model/list", "model/list"]);
  assert.deepEqual(requests[3].params, { limit: 100, includeHidden: false, cursor: "page-two" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.throws(() => process.kill(Number(readFileSync(join(dir, "pid"), "utf8")), 0), /ESRCH/u);
});

test("model-list timeout, cancellation, process failure and protocol errors stay distinguishable", async (t) => {
  const { script } = codexFixture(t, "setInterval(()=>{},1000);");
  assert.equal((await listCodexModels({ timeoutMs: 100 })).error_code, "OPERATION_TIMEOUT");
  const controller = new AbortController(); controller.abort();
  assert.equal((await listCodexModels({ signal: controller.signal })).error_code, "OPERATION_CANCELLED");
  writeFileSync(script, "process.exit(2);");
  assert.equal((await listCodexModels()).error_code, "OPERATION_TERMINATED");
  writeFileSync(script, "process.stdout.write('invalid protocol\\n');setInterval(()=>{},1000);");
  assert.equal((await listCodexModels()).error_code, "CODEX_MODEL_LIST_INVALID");
  writeFileSync(script, "process.stdout.write('null\\n');setInterval(()=>{},1000);");
  assert.equal((await listCodexModels()).error_code, "CODEX_MODEL_LIST_INVALID");
  writeFileSync(script, `
    import {createInterface} from 'node:readline';
    createInterface({input:process.stdin}).on('line',line=>{
      const request=JSON.parse(line);
      if(request.id)process.stdout.write(JSON.stringify({id:request.id,result:request.method==='initialize'?{}:{data:[null],nextCursor:null}})+'\\n');
    });
  `);
  assert.equal((await listCodexModels()).error_code, "CODEX_MODEL_LIST_INVALID");
});

test("login status recognizes fragmented official success but never treats an exit failure or timeout as logged in", async (t) => {
  const { script } = codexFixture(t, "process.stderr.write('Logged in using ');setTimeout(()=>process.stderr.write('ChatGPT\\n'),5);");
  const loggedIn = await getCodexLoginStatus();
  assert.equal(loggedIn.authenticated, true);
  assert.equal(loggedIn.auth_mode, "chatgpt");
  writeFileSync(script, "process.stderr.write('Logged in using ChatGPT\\n');process.exitCode=2;");
  assert.equal((await getCodexLoginStatus()).authenticated, false);
  writeFileSync(script, "process.stderr.write('Not logged in\\n');process.exitCode=1;");
  assert.equal((await getCodexLoginStatus()).error_code, "CODEX_LOGIN_REQUIRED");
  writeFileSync(script, "process.stdout.write('Unexpected success text\\n');");
  assert.equal((await getCodexLoginStatus()).error_code, "CODEX_STATUS_FAILED");
  writeFileSync(script, "setInterval(()=>{},1000);");
  const timeout = await getCodexLoginStatus({ timeoutMs: 100 });
  assert.equal(timeout.authenticated, false);
  assert.equal(timeout.error_code, "OPERATION_TIMEOUT");
  assert.doesNotMatch(timeout.detail, /cancelled/u);
  const controller = new AbortController(); controller.abort();
  assert.equal((await getCodexLoginStatus({ signal: controller.signal })).error_code, "OPERATION_CANCELLED");
});
