#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIRST_PERSON_DISCLOSURE_ACK as ACK,
  FIRST_PERSON_VOICE_MODE as MODE,
  VOICE_DISCLOSURES as DISCLOSURES,
} from "../../../mcp/lib/voice.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, "..");
const FIELDS = ["would_i_act", "what_i_see", "how_my_method_reads_it", "where_i_disagree", "what_changes_my_mind"];

function firstPerson(text, language) {
  if (language === "zh") return /我/u.test(text);
  if (language === "ja") return /私/u.test(text);
  if (language === "ko") return /(?:나|내|저|제)/u.test(text);
  return /\b(?:I|I'm|I've|I'd|I'll|me|my|mine|myself)\b/iu.test(text);
}

function validate(output) {
  const errors = [];
  const catalog = JSON.parse(readFileSync(join(SKILL_DIR, "references", "catalog.v1.json"), "utf8"));
  if (!catalog.active_method_ids.includes(output?.method_id)) errors.push("method_id is not active");
  if (output?.voice_mode !== MODE) errors.push("voice_mode does not match the required contract");
  if (output?.disclosure_ack !== ACK) errors.push("disclosure_ack does not match the required contract");
  if (!Object.hasOwn(DISCLOSURES, output?.language)) errors.push("language must be en, zh, ja, or ko");
  else if (output?.disclosure !== DISCLOSURES[output.language]) errors.push("disclosure is missing or was rewritten");
  if (!output?.voice || typeof output.voice !== "object" || Array.isArray(output.voice)) errors.push("voice must be an object");
  else for (const field of FIELDS) {
    const text = String(output.voice[field] || "").trim();
    if (!text) errors.push(`voice.${field} is required`);
    else if (!firstPerson(text, output.language)) errors.push(`voice.${field} is not first person`);
  }
  return errors;
}

const file = process.argv[2];
if (!file || process.argv.length !== 3) {
  process.stderr.write("usage: node validate-method-output.mjs PATH_TO_OUTPUT.json\n");
  process.exit(2);
}
try {
  const errors = validate(JSON.parse(readFileSync(resolve(file), "utf8")));
  if (errors.length) throw new Error(errors.join("; "));
  process.stdout.write("method output valid\n");
} catch (error) {
  process.stderr.write(`method output invalid: ${error.message}\n`);
  process.exitCode = 1;
}
