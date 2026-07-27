#!/usr/bin/env node

import {
  HostE2eArtifactError,
  checkExternalHostE2eFile,
  externalHostCollectionPlan,
  importExternalHostE2eResult,
  preflightExternalHost,
  writeExternalHostPreflightArtifact,
} from "./lib/external-host-e2e-artifacts.mjs";

function parse(argv) {
  const options = { mode: "plan", file: null, output: null, write: false, host: null, executable: null, runtime: null, pathOverride: null, packageName: "alphacouncil-agent", packageVersion: null, packageArtifact: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--plan") options.mode = "plan";
    else if (arg === "--preflight") options.mode = "preflight";
    else if (arg === "--check") options.mode = "check";
    else if (arg === "--import-result") options.mode = "import";
    else if (arg === "--file") options.file = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--host") options.host = argv[++index];
    else if (arg === "--executable") options.executable = argv[++index];
    else if (arg === "--runtime") options.runtime = argv[++index];
    else if (arg === "--path") options.pathOverride = argv[++index];
    else if (arg === "--package-name") options.packageName = argv[++index];
    else if (arg === "--package-version") options.packageVersion = argv[++index];
    else if (arg === "--package-artifact") options.packageArtifact = argv[++index];
    else if (arg === "--write") options.write = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (["check", "import"].includes(options.mode) && !options.file) throw new Error(`${options.mode} requires --file`);
  if (options.mode === "import" && !options.output) throw new Error("--import-result requires --output directory");
  if (options.mode === "preflight" && (!options.host || !options.executable)) throw new Error("--preflight requires --host and --executable");
  if (options.write && (options.mode !== "preflight" || !options.output)) throw new Error("--write is supported only with --preflight --output FILE");
  return options;
}

try {
  const options = parse(process.argv.slice(2));
  let result;
  if (options.mode === "plan") result = externalHostCollectionPlan();
  else if (options.mode === "preflight") {
    const artifact = preflightExternalHost({ hostId: options.host, executable: options.executable, runtime: options.runtime, pathOverride: options.pathOverride, packageName: options.packageName, packageVersion: options.packageVersion, packageArtifact: options.packageArtifact });
    result = options.write ? writeExternalHostPreflightArtifact(artifact, options.output) : artifact;
  } else if (options.mode === "check") result = checkExternalHostE2eFile(options.file);
  else result = importExternalHostE2eResult(options.file, options.output);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (options.mode === "check" && !result.valid) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  for (const detail of error instanceof HostE2eArtifactError ? error.errors : []) process.stderr.write(`- ${detail}\n`);
  process.exitCode = 1;
}
