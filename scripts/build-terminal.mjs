#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NODE_VERSION = "24.14.0";
const CODEX_VERSION = "0.146.1";
const LICENSES = [
  { file: "Node-LICENSE.txt", url: `https://raw.githubusercontent.com/nodejs/node/v${NODE_VERSION}/LICENSE`, sha256: "4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18" },
  { file: "Codex-LICENSE.txt", url: `https://raw.githubusercontent.com/openai/codex/rust-v${CODEX_VERSION}/LICENSE`, sha256: "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc" },
  { file: "Codex-NOTICE.txt", url: `https://raw.githubusercontent.com/openai/codex/rust-v${CODEX_VERSION}/NOTICE`, sha256: "9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915" },
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

function npmCli() {
  const bin = dirname(realpathSync(process.execPath));
  const candidates = [process.env.npm_execpath, join(bin, "node_modules/npm/bin/npm-cli.js"), join(bin, "../lib/node_modules/npm/bin/npm-cli.js")].filter(Boolean);
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error("Run this build with npm run terminal:build so the npm CLI path is available.");
  return path;
}

function command(executable, args, options = {}) {
  return execFileSync(executable, args, { cwd: ROOT, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...options });
}

async function copyLicenses(destination) {
  mkdirSync(destination, { recursive: true });
  for (const license of LICENSES) {
    const response = await fetch(license.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`License download failed: ${license.file}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== license.sha256) throw new Error(`License integrity mismatch: ${license.file}`);
    writeFileSync(join(destination, license.file), bytes);
  }
}

function launchers(bundle) {
  for (const [name, entry] of [["alphacouncil", "terminal/cli.mjs"], ["alphacouncil-agent", "mcp/server.mjs"]]) {
    if (process.platform === "win32") {
      writeFileSync(join(bundle, `${name}.cmd`), `@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0app\\${entry.replaceAll("/", "\\")}" %*\r\nexit /b %errorlevel%\r\n`);
    } else {
      const path = join(bundle, name);
      writeFileSync(path, `#!/bin/sh\nBUNDLE_DIR=$(CDPATH= cd -- "\${0%/*}" && pwd)\nexec "$BUNDLE_DIR/runtime/node" "$BUNDLE_DIR/app/${entry}" "$@"\n`);
      chmodSync(path, 0o755);
    }
  }
}

function smoke(bundle, isolatedHome) {
  const node = join(bundle, "runtime", process.platform === "win32" ? "node.exe" : "node");
  const environment = {
    PATH: "", HOME: isolatedHome, USERPROFILE: isolatedHome,
    CODEX_HOME: join(isolatedHome, "codex"), ALPHACOUNCIL_AGENT_DATA_DIR: join(isolatedHome, "research"),
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, TEMP: isolatedHome, TMP: isolatedHome } : { TMPDIR: isolatedHome }),
  };
  mkdirSync(isolatedHome, { recursive: true });
  mkdirSync(environment.CODEX_HOME, { recursive: true });
  const options = { cwd: bundle, env: environment };
  const launcher = join(bundle, process.platform === "win32" ? "alphacouncil.cmd" : "alphacouncil");
  const run = (args) => process.platform === "win32"
    ? command(process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", `""${launcher}" ${args.join(" ")}"`], { ...options, windowsVerbatimArguments: true })
    : command(launcher, args, options);
  const help = run(["--help"]);
  if (!/alphacouncil/iu.test(help)) throw new Error("Bundled terminal help smoke failed");
  const runs = run(["runs", "--json"]);
  if (!Array.isArray(JSON.parse(runs))) throw new Error("Bundled empty history smoke failed");
  const codex = command(node, [join(bundle, "app/terminal/node_modules/@openai/codex/bin/codex.js"), "--version"], options);
  if (!codex.includes(CODEX_VERSION)) throw new Error("Bundled official runtime smoke failed");
  const runtime = command(node, ["-p", "JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})"], options);
  if (JSON.parse(runtime).version !== NODE_VERSION) throw new Error("Bundled Node runtime version mismatch");
  return { terminal_help: "passed", empty_history: "passed", bundled_codex_version: "passed", bundled_node_version: "passed", external_path: "empty", model_calls: 0, credentials_read: false };
}

export async function buildTerminal({ outDir = join(ROOT, "dist") } = {}) {
  if (process.versions.node !== NODE_VERSION) throw new Error(`This native build requires Node ${NODE_VERSION}; it copies the current process executable, not a cross-platform runtime.`);
  if (!["darwin", "linux", "win32"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) throw new Error("Unsupported native terminal build target");
  const pkg = json(join(ROOT, "package.json"));
  const terminalPkg = json(join(ROOT, "terminal/package.json"));
  const codexPkg = join(ROOT, "terminal/node_modules/@openai/codex/package.json");
  if (!existsSync(codexPkg) || json(codexPkg).version !== CODEX_VERSION
    || terminalPkg.dependencies["@openai/codex"] !== CODEX_VERSION) throw new Error("Run npm ci --prefix terminal with the committed lockfile before building.");
  const scratch = mkdtempSync(join(tmpdir(), "alphacouncil-terminal-build-"));
  try {
    const name = `alphacouncil-terminal-${pkg.version}-${process.platform}-${process.arch}`;
    const packResult = JSON.parse(command(process.execPath, [npmCli(), "pack", "--json", "--ignore-scripts", "--pack-destination", scratch]));
    const pack = packResult[0];
    if (pack.files.some((entry) => entry.path.startsWith("terminal/node_modules/"))) throw new Error("The core npm package must exclude platform-specific terminal dependencies.");
    for (const required of ["terminal/cli.mjs", "terminal/service.mjs", "terminal/runner.mjs", "mcp/server.mjs"]) {
      if (!pack.files.some((entry) => entry.path === required)) throw new Error(`npm package is missing ${required}`);
    }
    const bundle = join(scratch, name);
    const app = join(bundle, "app");
    mkdirSync(app, { recursive: true });
    command("tar", ["-xzf", join(scratch, pack.filename), "--strip-components=1", "-C", app]);
    cpSync(join(ROOT, "terminal/node_modules"), join(app, "terminal/node_modules"), { recursive: true, verbatimSymlinks: true });
    mkdirSync(join(bundle, "runtime"));
    const nodeFile = join(bundle, "runtime", process.platform === "win32" ? "node.exe" : "node");
    copyFileSync(realpathSync(process.execPath), nodeFile);
    if (process.platform !== "win32") chmodSync(nodeFile, 0o755);
    launchers(bundle);
    await copyLicenses(join(bundle, "licenses"));
    copyFileSync(join(ROOT, "LICENSE"), join(bundle, "licenses/AlphaCouncil-LICENSE.txt"));
    writeFileSync(join(bundle, "README.txt"), [
      `AlphaCouncil Terminal ${pkg.version} (${process.platform}/${process.arch})`,
      "Extract the complete folder before running alphacouncil (alphacouncil.cmd on Windows).",
      "The folder includes Node and the official Codex runtime. No separate Node/npm/Codex installation is needed to start it.",
      "Choose a language, enter a stock ticker, select a model connection, and submit the research configuration.",
      "A model account/API key and any required source permissions remain necessary for live research.",
      "alphacouncil-agent preserves the MCP stdio entry point; its output is JSON-RPC, not the terminal UI.",
      "This build is an unsigned development archive, not a notarized installer or a live-research acceptance certificate.",
      "Runtime licenses and notices are in licenses/. Dependency licenses are preserved under app/terminal/node_modules/.",
      "The included Node executable is copied from this native build process. Build identity and hashes are in build-info.json.",
      "",
    ].join("\n"));
    const metadata = {
      schema_version: 1, version: pkg.version, platform: process.platform, arch: process.arch,
      node_version: NODE_VERSION, node_source: "native_build_process_executable", node_sha256: sha256(readFileSync(nodeFile)),
      codex_version: CODEX_VERSION, terminal_lock_sha256: sha256(readFileSync(join(ROOT, "terminal/package-lock.json"))),
      core_package_sha256: sha256(readFileSync(join(scratch, pack.filename))),
      license_sources: LICENSES, signing: "not_signed", live_research: "not_tested",
      smoke: smoke(bundle, join(scratch, "isolated-smoke-home")),
    };
    writeFileSync(join(bundle, "build-info.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    const archive = join(scratch, `${name}.tar.gz`);
    command("tar", ["-czf", archive, "-C", scratch, name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const relocated = join(scratch, "relocated archive");
    mkdirSync(relocated);
    command("tar", ["-xzf", archive, "-C", relocated]);
    smoke(join(relocated, name), join(scratch, "relocated-smoke-home"));
    const output = resolve(outDir);
    mkdirSync(output, { recursive: true });
    const outputArchive = join(output, `${name}.tar.gz`);
    copyFileSync(archive, outputArchive);
    const digest = sha256(readFileSync(outputArchive));
    writeFileSync(`${outputArchive}.sha256`, `${digest}  ${name}.tar.gz\n`);
    writeFileSync(join(output, `${name}.build-info.json`), `${JSON.stringify({ ...metadata, archive_sha256: digest, relocated_archive_smoke: "passed" }, null, 2)}\n`);
    return { archive: outputArchive, sha256: digest, target: `${process.platform}-${process.arch}`, smoke: "passed", relocated_archive_smoke: "passed", signing: "not_signed", live_research: "not_tested" };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(`Build a native AlphaCouncil terminal archive with the current Node ${NODE_VERSION} executable.\nUsage: npm run terminal:build [-- --out directory]\nRequires npm ci --prefix terminal. No cross-compilation, signing, publication, login or model calls.`);
  } else {
    const outIndex = args.indexOf("--out");
    if (args.length && !(args.length === 2 && outIndex === 0 && args[1])) throw new Error("Expected --out directory or no arguments");
    console.log(JSON.stringify(await buildTerminal(outIndex >= 0 ? { outDir: args[outIndex + 1] } : {}), null, 2));
  }
}
