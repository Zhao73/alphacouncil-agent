import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deleteConnection, getConnection, getConnectionSecret, listConnections, loginCodex, normalizeConnection, saveConnection } from "../connections.mjs";

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
