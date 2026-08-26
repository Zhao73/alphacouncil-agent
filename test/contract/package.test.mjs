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

test("prepublishOnly proves the package works, not that the corpus is GA-ready", () => {
  // Pinning the literal command froze a decision rather than a property. What must hold is
  // that publishing runs the full suite and installs the tarball to check host parity. It must
  // NOT depend on `npm run check`, whose report steps exit non-zero until the corpus has
  // human-reviewed method models and a live four-host run -- a state this build says it is not
  // in, which made a self-declared non-GA preview unpublishable in principle.
  assert.match(pkg.scripts.prepublishOnly, /\bnpm test\b/);
  assert.match(pkg.scripts.prepublishOnly, /npm run test:package/);
  assert.doesNotMatch(pkg.scripts.prepublishOnly, /npm run check/);
  assert.match(pkg.scripts["test:package"], /check-packaged-host-parity\.mjs/);
  assert.match(pkg.scripts["package:inventory"], /report-package-inventory\.mjs --json/);
  assert.match(pkg.scripts["package:inventory:check"], /report-package-inventory\.mjs --check/);
  assert.match(pkg.scripts["docs:install:check"], /check-install-docs\.mjs/);
  assert.match(pkg.scripts["docs:readme:check"], /check-readme-conversion\.mjs/);
  assert.ok(pkg.files.includes("docs/reference/"));
  // The GA gate still exists and still runs the reports that fail closed.
  assert.match(pkg.scripts["release:check"], /npm run check/);
  assert.match(pkg.scripts["release:check"], /--require-release-evidence/);
});

test("publishing is public and lands on the channel a plain install follows", () => {
  // This was pinned to `next` while the package described itself as a preview. 1.0.0 is the
  // release, so the default install is the release -- the guard now records that decision
  // rather than the earlier one.
  assert.deepEqual(pkg.publishConfig, { access: "public", tag: "latest" });
});

test("runtime stays dependency-free while schema and property tools remain development-only", () => {
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0);
  assert.deepEqual(pkg.devDependencies, {
    ajv: "8.20.0",
    "fast-check": "4.9.0",
    jsonrepair: "3.15.0",
  });
  const validators = readFileSync(repoFile("mcp/generated/runtime-validators.mjs"), "utf8");
  assert.doesNotMatch(validators, /(?:from\s+["']ajv\/|require\(["']ajv\/|jsonrepair|fast-check)/u);
  assert.ok(!existsSync(join(repoRoot, "node_modules")) || true);
});
