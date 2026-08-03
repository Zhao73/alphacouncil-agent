import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fuzz } from "../targets/transport-runtime.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, "..", "corpus", "transport-runtime");
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/u, "").split("=", 2);
  return [key, value];
}));
const runs = Number.parseInt(args.runs || "50000", 10);
const initialSeed = Number.parseInt(args.seed || "1337", 10) >>> 0;
if (!Number.isSafeInteger(runs) || runs < 0 || !Number.isSafeInteger(initialSeed)) {
  throw new TypeError("usage: node-fuzz.mjs [--runs=<non-negative integer>] [--seed=<integer>]");
}

let state = initialSeed || 0x9e3779b9;
function random() {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}
function pick(limit) {
  return limit <= 0 ? 0 : random() % limit;
}

const tokens = [
  Buffer.from("{}"), Buffer.from("[]"), Buffer.from("null"), Buffer.from("true"),
  Buffer.from("false"), Buffer.from("\"__proto__\""), Buffer.from("//x\n"),
  Buffer.from("/*x*/"), Buffer.from(",}"), Buffer.from(",]"), Buffer.from("```json\n"),
  Buffer.from("\n{\"second\":"), Buffer.from("\n[-"), Buffer.from("\\\""),
];
const seeds = readdirSync(corpusDir, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => readFileSync(join(corpusDir, entry.name)));

function clamp(buffer) {
  return buffer.length <= 65_536 ? buffer : buffer.subarray(0, 65_536);
}

function mutate(seed) {
  const source = Buffer.from(seed);
  const operation = pick(6);
  if (operation === 0) {
    if (!source.length) return Buffer.from([random() & 0xff]);
    source[pick(source.length)] ^= 1 << pick(8);
    return source;
  }
  if (operation === 1) {
    const token = tokens[pick(tokens.length)];
    const at = pick(source.length + 1);
    return clamp(Buffer.concat([source.subarray(0, at), token, source.subarray(at)]));
  }
  if (operation === 2) {
    if (!source.length) return source;
    const from = pick(source.length);
    const size = 1 + pick(source.length - from);
    return Buffer.concat([source.subarray(0, from), source.subarray(from + size)]);
  }
  if (operation === 3) {
    if (!source.length) return source;
    const from = pick(source.length);
    const size = 1 + pick(source.length - from);
    const at = pick(source.length + 1);
    return clamp(Buffer.concat([source.subarray(0, at), source.subarray(from, from + size), source.subarray(at)]));
  }
  if (operation === 4) {
    const donor = seeds[pick(seeds.length)];
    const at = pick(source.length + 1);
    const donorAt = pick(donor.length + 1);
    return clamp(Buffer.concat([source.subarray(0, at), donor.subarray(donorAt)]));
  }
  const token = tokens[pick(tokens.length)];
  const at = pick(source.length + 1);
  const end = Math.min(source.length, at + pick(Math.max(1, source.length - at + 1)));
  return clamp(Buffer.concat([source.subarray(0, at), token, source.subarray(end)]));
}

for (const seed of seeds) fuzz(seed);
for (let index = 0; index < runs; index += 1) {
  const input = mutate(seeds[pick(seeds.length)]);
  try {
    fuzz(input);
  } catch (error) {
    process.stderr.write(`node fuzz failure seed=${initialSeed} run=${index} input_base64=${input.toString("base64")}\n`);
    throw error;
  }
}
process.stdout.write(`node fuzz passed: corpus=${seeds.length} mutations=${runs} seed=${initialSeed}\n`);
