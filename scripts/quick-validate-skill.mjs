#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_SKILL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const ALLOWED_PROPERTIES = new Set(["name", "description", "license", "allowed-tools", "metadata"]);

function scalar(value, continuation) {
  const text = String(value ?? "").trim();
  if (text === "|" || text === ">") {
    return continuation.map((line) => line.replace(/^\s+/, "")).join(text === ">" ? " " : "\n").trim();
  }
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Invalid double-quoted YAML scalar");
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

export function validateSkill(skillPath) {
  const skillFile = resolve(skillPath, "SKILL.md");
  if (!existsSync(skillFile)) return { valid: false, message: "SKILL.md not found" };

  const content = readFileSync(skillFile, "utf8").replace(/\r\n/g, "\n");
  if (!content.startsWith("---\n")) return { valid: false, message: "No YAML frontmatter found" };
  const end = content.indexOf("\n---", 4);
  if (end < 0) return { valid: false, message: "Invalid frontmatter format" };

  const lines = content.slice(4, end).split("\n");
  const entries = new Map();
  let current = null;
  for (const line of lines) {
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    if (/^\s/u.test(line)) {
      if (!current) return { valid: false, message: "Invalid YAML in frontmatter: orphan indentation" };
      entries.get(current).continuation.push(line);
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/u.exec(line);
    if (!match) return { valid: false, message: `Invalid YAML in frontmatter: ${line}` };
    const [, key, value = ""] = match;
    if (entries.has(key)) return { valid: false, message: `Invalid YAML in frontmatter: duplicate key ${key}` };
    entries.set(key, { value, continuation: [] });
    current = key;
  }

  const unexpected = [...entries.keys()].filter((key) => !ALLOWED_PROPERTIES.has(key)).sort();
  if (unexpected.length) {
    return {
      valid: false,
      message: `Unexpected key(s) in SKILL.md frontmatter: ${unexpected.join(", ")}. Allowed properties are: ${[...ALLOWED_PROPERTIES].sort().join(", ")}`,
    };
  }
  if (!entries.has("name")) return { valid: false, message: "Missing 'name' in frontmatter" };
  if (!entries.has("description")) return { valid: false, message: "Missing 'description' in frontmatter" };

  let name;
  let description;
  try {
    name = scalar(entries.get("name").value, entries.get("name").continuation);
    description = scalar(entries.get("description").value, entries.get("description").continuation);
  } catch (error) {
    return { valid: false, message: `Invalid YAML in frontmatter: ${error.message}` };
  }
  if (!name) return { valid: false, message: "Name must be a non-empty string" };
  if (!/^[a-z0-9-]+$/u.test(name)) {
    return { valid: false, message: `Name '${name}' should be hyphen-case (lowercase letters, digits, and hyphens only)` };
  }
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
    return { valid: false, message: `Name '${name}' cannot start/end with hyphen or contain consecutive hyphens` };
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    return { valid: false, message: `Name is too long (${name.length} characters). Maximum is ${MAX_SKILL_NAME_LENGTH} characters.` };
  }
  if (!description) return { valid: false, message: "Description must be a non-empty string" };
  if (description.includes("<") || description.includes(">")) {
    return { valid: false, message: "Description cannot contain angle brackets (< or >)" };
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { valid: false, message: `Description is too long (${description.length} characters). Maximum is ${MAX_DESCRIPTION_LENGTH} characters.` };
  }
  return { valid: true, message: "Skill is valid!" };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.length !== 3) {
    console.error("Usage: node scripts/quick-validate-skill.mjs <skill_directory>");
    process.exitCode = 1;
  } else {
    const result = validateSkill(process.argv[2]);
    console.log(result.message);
    process.exitCode = result.valid ? 0 : 1;
  }
}
