import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoFile } from "../helpers/paths.mjs";

const read = (rel) => readFileSync(repoFile(rel), "utf8");

test("the governance skill is bundled with explicit gates and anti-rationalizations", () => {
  const governance = read("skills/agent-skills-governance/SKILL.md");
  for (const marker of ["addyosmani/agent-skills", "Stop Gates", "Anti-Rationalizations"]) {
    assert.match(governance, new RegExp(marker.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")));
  }
});

test("the runtime skill and both memory files reference the governance skill", () => {
  const targets = {
    "skills/alphacouncil-agent/SKILL.md": read("skills/alphacouncil-agent/SKILL.md"),
    "CLAUDE.md": read("CLAUDE.md"),
    "AGENTS.md": read("AGENTS.md"),
  };
  for (const [name, text] of Object.entries(targets)) {
    assert.match(text, /agent-skills-governance/, `${name} must reference the bundled governance skill`);
  }
});
