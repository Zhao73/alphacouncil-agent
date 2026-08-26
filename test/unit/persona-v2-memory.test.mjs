import { test } from "node:test";
import assert from "node:assert/strict";

import { LeakError, assertWritable, canWritePostmortem, currentBeliefs, episode, isVisible, postmortem, recallFor, visibleMemory } from "../helpers/persona-v2-memory.mjs";
import { loadPacks } from "../../mcp/lib/personas-v2/loader.mjs";

const buffett = loadPacks().get("master_buffett");
const rec = (over = {}) => ({ layer: "episodic", public_at: "2024-01-01", memory_created_at: "2024-01-01", ...over });

test("a filing published after as_of is invisible", () => {
  assert.equal(isVisible(rec({ public_at: "2025-06-01" }), "2024-01-01"), false);
  assert.equal(isVisible(rec({ public_at: "2023-06-01" }), "2024-01-01"), true);
});

test("a note written after as_of is invisible even when the fact was public", () => {
  // The second clause. Without it a model reads the future through its own diary: the
  // underlying filing is old, but the conclusion drawn from it belongs to 2026.
  const hindsight = rec({ public_at: "2023-06-01", memory_created_at: "2026-07-27" });
  assert.equal(isVisible(hindsight, "2024-01-01"), false);
});

test("an undated memory is excluded rather than assumed harmless", () => {
  assert.equal(isVisible(rec({ memory_created_at: undefined }), "2024-01-01"), false);
  assert.equal(isVisible(rec({ public_at: undefined }), "2024-01-01"), false);
  assert.equal(isVisible({}, "2024-01-01"), false);
});

test("an unparsable as_of stops the run instead of admitting everything", () => {
  assert.throws(() => isVisible(rec(), "not-a-date"), LeakError);
});

test("visibleMemory filters by layer and by both clauses at once", () => {
  const records = [
    rec({ layer: "episodic", memory_created_at: "2023-01-01", public_at: "2023-01-01" }),
    rec({ layer: "episodic", memory_created_at: "2026-01-01", public_at: "2023-01-01" }),
    rec({ layer: "belief", memory_created_at: "2023-01-01", public_at: "2023-01-01" }),
  ];
  assert.equal(visibleMemory(records, "2024-01-01", { layer: "episodic" }).length, 1);
  assert.equal(visibleMemory(records, "2024-01-01").length, 2);
});

test("a memory dated after its own run is refused, not archived quietly", () => {
  assert.throws(() => assertWritable(rec({ memory_created_at: "2026-01-01" }), "2024-01-01"), LeakError);
  assert.throws(() => assertWritable(rec({ layer: "invented" }), "2024-01-01"), LeakError);
  assert.equal(assertWritable(rec(), "2024-01-01"), true);
});

test("an episode records the decision and computes its own expiry", () => {
  const ep = episode({
    persona_id: "master_buffett",
    symbol: "NOK",
    as_of: "2024-01-01",
    decision: { stance: "out_of_scope", reason: "eligibility", score: null },
    horizon_days: 365,
  });
  assert.equal(ep.layer, "episodic");
  assert.equal(ep.stance, "out_of_scope");
  assert.equal(ep.expires_at, "2024-12-31");
  assert.equal(isVisible(ep, "2024-01-01"), true);
  assert.equal(isVisible(ep, "2023-12-31"), false);
});

test("a postmortem cannot be written before the horizon it is judging", () => {
  const ep = episode({ persona_id: "p", symbol: "X", as_of: "2024-01-01", decision: { stance: "constructive" }, horizon_days: 365 });
  assert.equal(canWritePostmortem(ep, "2024-06-01").allowed, false);
  assert.throws(() => postmortem({ episode: ep, now: "2024-06-01", outcome: "right" }), LeakError);
  assert.equal(canWritePostmortem(ep, "2025-01-01").allowed, true);
  const pm = postmortem({ episode: ep, now: "2025-01-01", outcome: "wrong", failure_mode: "method" });
  assert.equal(pm.layer, "postmortem");
  assert.equal(pm.failure_mode, "method");
});

test("an episode with no horizon can never be graded", () => {
  const ep = episode({ persona_id: "p", symbol: "X", as_of: "2024-01-01", decision: {} });
  assert.deepEqual(canWritePostmortem(ep, "2030-01-01"), { allowed: false, reason: "no_horizon" });
});

test("beliefs keep only the latest per claim and mark the stale ones", () => {
  const records = [
    { layer: "belief", claim_id: "moat", public_at: "2023-01-01", memory_created_at: "2023-01-01", value: "old" },
    { layer: "belief", claim_id: "moat", public_at: "2023-06-01", memory_created_at: "2023-06-01", value: "new" },
    { layer: "belief", claim_id: "capital_allocation", public_at: "2020-01-01", memory_created_at: "2020-01-01", value: "ancient" },
  ];
  const beliefs = currentBeliefs(records, "2024-01-01", { decay_days: 540 });
  assert.equal(beliefs.length, 2);
  assert.equal(beliefs.find((b) => b.claim_id === "moat").value, "new");
  // Stale rather than deleted: running on an old read is different from having no view.
  assert.equal(beliefs.find((b) => b.claim_id === "capital_allocation").stale, true);
  assert.equal(beliefs.find((b) => b.claim_id === "moat").stale, false);
});

test("recall never returns working memory and counts what the leak rule removed", () => {
  const records = [
    rec({ layer: "episodic", memory_created_at: "2023-01-01", public_at: "2023-01-01" }),
    rec({ layer: "episodic", memory_created_at: "2026-01-01", public_at: "2023-01-01" }),
    { layer: "working", public_at: "2023-01-01", memory_created_at: "2023-01-01" },
    { layer: "belief", claim_id: "c", public_at: "2023-01-01", memory_created_at: "2023-01-01" },
  ];
  const recalled = recallFor(buffett, records, "2024-01-01");
  assert.equal(recalled.episodic.length, 1);
  assert.equal(recalled.beliefs.length, 1);
  assert.equal(recalled.excluded_by_leak_rule, 1);
  assert.ok(!("working" in recalled));
});
