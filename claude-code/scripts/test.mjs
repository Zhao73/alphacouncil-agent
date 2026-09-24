#!/usr/bin/env node
// Run every test/*.test.mjs (node --test does not expand globs on Windows or Node 18/20).
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../test/", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).map((f) => `${dir}${f}`);
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
