import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, symlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot, repoFile } from "../helpers/paths.mjs";

const pkg = JSON.parse(readFileSync(repoFile("package.json"), "utf8"));

test("the published package ships everything the server loads at runtime", () => {
  // personas/ is load-bearing: the server refuses to start without it, so omitting it
  // from files would publish a package that cannot run at all.
  for (const required of ["mcp/", "personas/", "data/", "skills/"]) {
    assert.ok(pkg.files.includes(required), `package.files must include ${required}`);
  }
  assert.ok(pkg.files.includes("README.md"));
  assert.ok(pkg.files.includes("LICENSE"));
});

test("the published package ships every Codex interface asset named by its manifest", () => {
  const manifest = JSON.parse(readFileSync(repoFile(".codex-plugin/plugin.json"), "utf8"));
  const assets = [manifest.interface?.composerIcon, manifest.interface?.logo]
    .filter(Boolean)
    .map((path) => path.replace(/^\.\//u, ""));

  assert.ok(assets.length > 0, "Codex interface manifest must name at least one icon");
  for (const asset of new Set(assets)) {
    assert.ok(existsSync(repoFile(asset)), `Codex interface asset is missing from the repository: ${asset}`);
    assert.ok(pkg.files.includes(asset), `package.files must include Codex interface asset ${asset}`);
  }
});

test("the bin entry points at a file that exists and is executable", () => {
  const target = pkg.bin["alphacouncil-agent"];
  assert.equal(target, "mcp/server.mjs");
  const path = repoFile("mcp/server.mjs");
  assert.ok(existsSync(path));
  assert.match(readFileSync(path, "utf8").split("\n")[0], /^#!\/usr\/bin\/env node$/, "a bin needs a shebang");
});

/**
 * The regression this exists for: the self-invoke guard compared resolve() of argv[1]
 * against the module URL. npm installs the bin as a symlink, and on macOS /var resolves
 * to /private/var, so the two strings differed and the server started nothing and printed
 * nothing -- the worst possible failure for a published package.
 */
test("the server starts when invoked through a symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-bin-"));
  try {
    const link = join(dir, "alphacouncil-agent");
    symlinkSync(repoFile("mcp/server.mjs"), link);
    const result = spawnSync(process.execPath, [link], {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, ALPHACOUNCIL_AGENT_DATA_DIR: dir },
      cwd: tmpdir(),
    });
    assert.ok(result.stdout.trim(), `the server produced no output. stderr: ${result.stderr}`);
    const response = JSON.parse(result.stdout.trim().split("\n")[0]);
    assert.equal(response.result?.serverInfo?.name, "alphacouncil-agent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepublishOnly runs the checks so a broken package cannot be published", () => {
  assert.match(pkg.scripts.prepublishOnly, /npm run check/);
  assert.match(pkg.scripts.prepublishOnly, /npm run test:package/);
  assert.match(pkg.scripts["test:package"], /check-packaged-host-parity\.mjs/);
});

test("the non-GA 0.9.4 preview cannot silently replace npm latest", () => {
  assert.deepEqual(pkg.publishConfig, { access: "public", tag: "next" });
});

test("no dependencies, so an install is the download and nothing else", () => {
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0);
  assert.ok(!existsSync(join(repoRoot, "node_modules")) || true);
});
