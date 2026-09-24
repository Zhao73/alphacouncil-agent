#!/usr/bin/env node
// Stand-in for `claude -p` in tests: parses the task prompt, records a valid packet through the
// same state machine a real worker's council_record call reaches, and emits stream-json.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recordPacket } from "../lib/council.mjs";
import { debatePacket, evidencePacket, pmPacket } from "./helpers.mjs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("9.9.9 (Fake Claude)");
  process.exit(0);
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
const runId = prompt.match(/AlphaCouncil run `([^`]+)`/)[1];
const [, role, stage, round] = prompt.match(/\(`([a-z_]+)`\), stage (evidence|debate|pm)(?: round (\d))?/);
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
emit({ type: "system", subtype: "init" });
emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: `${role} research` } }] } });

if ((process.env.FAKE_CLAUDE_FAIL || "").split(",").includes(role)) {
  emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, num_turns: 1, result: `FAILED ${role}: fake failure` });
  process.exit(0);
}
if (process.env.FAKE_CLAUDE_HANG === role) setInterval(() => {}, 1000);
else {
  let packet;
  if (stage === "evidence") packet = evidencePacket(role);
  else if (stage === "pm") packet = pmPacket();
  else {
    const side = role.startsWith("bull") ? "bull" : "bear";
    const opp = side === "bull" ? "bear_researcher" : "bull_researcher";
    const q = Number(round) === 3
      ? JSON.parse(readFileSync(join(process.env.ALPHACOUNCIL_HOME, "runs", runId, "packets", "debate", "r2", `${opp}.json`), "utf8")).packet.questions
      : [];
    packet = debatePacket(Number(round), side, q);
  }
  const r = recordPacket(runId, { role, stage, round: round ? Number(round) : null, packet });
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__alphacouncil__council_record", input: { role } }] } });
  emit({ type: "result", subtype: "success", is_error: !r.ok, total_cost_usd: 0.02, num_turns: 3, result: r.ok ? `RECORDED ${role}` : `FAILED ${role}: ${r.errors.join("; ")}` });
}
