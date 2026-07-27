#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_AI_MACHINE_SIMULATION_ROOT,
  verifyAIMachineSimulationTree,
  writeAIMachineSimulations,
} from "./lib/persona-v3-ai-machine-simulations.mjs";

export function parseArgs(argv) {
  const out = { write: false, json: false, root: DEFAULT_AI_MACHINE_SIMULATION_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") out.write = true;
    else if (arg === "--check") out.write = false;
    else if (arg === "--json") out.json = true;
    else if (arg === "--root") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--root requires a path");
      out.root = resolve(value);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return Object.freeze(out);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = args.write ? writeAIMachineSimulations({ root: args.root }) : verifyAIMachineSimulationTree({ root: args.root });
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write([
    "persona-v3-ai-machine-simulation:",
    `mode=${args.write ? "write" : "check"}`,
    `runs=${report.run_count}/8`,
    `executions=${report.executed_count}/${report.deterministic_execution_count}`,
    `fail_closed=${report.blocked_fail_closed_count}`,
    "network_calls=0",
    "human_reference=0",
    "formal_experiment_effect=none",
    `n_eff=${report.n_eff}`,
    `hash=${report.manifest_hash}`,
    "",
  ].join(" "));
  return report.valid ? 0 : 1;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`AI machine simulation failed: ${error.message}\n`); process.exitCode = 1; }
}
