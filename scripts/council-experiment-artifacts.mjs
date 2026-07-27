#!/usr/bin/env node

import {
  ExperimentArtifactError,
  buildCaseFreezeFromManifest,
  checkExperimentArtifactFile,
  experimentArtifactPlan,
  importExperimentResult,
  readPhysicalJson,
  signingPayload,
  writeExperimentArtifact,
} from "./lib/council-experiment-artifacts.mjs";

function parse(argv) {
  const out = { mode: "plan", file: null, manifest: null, output: null, artifactDirectory: null, write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--plan") out.mode = "plan";
    else if (arg === "--build-case-freeze") out.mode = "build_case_freeze";
    else if (arg === "--check") { if (out.mode !== "build_case_freeze") out.mode = "check"; }
    else if (arg === "--signing-payload") out.mode = "signing";
    else if (arg === "--import-result") out.mode = "import";
    else if (arg === "--file") out.file = argv[++index];
    else if (arg === "--output") out.output = argv[++index];
    else if (arg === "--artifact-directory") out.artifactDirectory = argv[++index];
    else if (arg === "--manifest") out.manifest = argv[++index];
    else if (arg === "--write") out.write = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (["check", "signing", "import"].includes(out.mode) && !out.file) throw new Error(`${out.mode} requires --file`);
  if (out.mode === "import" && !out.output) throw new Error("--import-result requires --output directory");
  if (out.mode === "build_case_freeze" && !out.manifest) throw new Error("--build-case-freeze requires --manifest FILE");
  if (out.write && (out.mode !== "build_case_freeze" || !out.output)) throw new Error("--write is supported only with --build-case-freeze --output FILE");
  return out;
}

try {
  const options = parse(process.argv.slice(2));
  let result;
  if (options.mode === "plan") result = experimentArtifactPlan();
  else if (options.mode === "build_case_freeze") {
    const artifact = buildCaseFreezeFromManifest(options.manifest);
    result = options.write ? writeExperimentArtifact(artifact, options.output) : artifact;
  }
  else if (options.mode === "check") result = checkExperimentArtifactFile(options.file, { artifactDirectory: options.artifactDirectory });
  else if (options.mode === "signing") result = { signing_payload: signingPayload(readPhysicalJson(options.file).value) };
  else result = importExperimentResult(options.file, options.output);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (options.mode === "check" && !result.valid) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  for (const detail of error instanceof ExperimentArtifactError ? error.errors : []) process.stderr.write(`- ${detail}\n`);
  process.exitCode = 1;
}
