import { test } from "node:test";
import assert from "node:assert/strict";

import { catalogSnapshot, parseMasterSelection } from "../../mcp/lib/council-selection.mjs";
import { registry } from "../../mcp/lib/personas/registry.mjs";

const TARGET_MASTER_IDS = [
  "master_ackman",
  "master_aschenbrenner",
  "master_asness",
  "master_buffett",
  "master_burry",
  "master_cathie_wood",
  "master_dalio",
  "master_damodaran",
  "master_druckenmiller",
  "master_duan_yongping",
  "master_fisher",
  "master_forensic_short",
  "master_graham",
  "master_jhunjhunwala",
  "master_klarman",
  "master_li_lu",
  "master_lynch",
  "master_marks",
  "master_munger",
  "master_natenberg",
  "master_pabrai",
  "master_simons",
  "master_sinclair",
  "master_soros",
  "master_taleb",
  "master_thorp",
].sort();

function englishCatalog() {
  return catalogSnapshot("English");
}

function expectedIds(...oneBasedIndexes) {
  const masters = englishCatalog().masters;
  return oneBasedIndexes.map((index) => masters[index - 1].id);
}

function assertSelectionError(raw, reason) {
  const masters = englishCatalog().masters;
  assert.throws(
    () => parseMasterSelection(raw, masters),
    (error) => {
      assert.equal(error?.data?.reason, reason);
      return true;
    },
  );
}

test("catalog order and hash are stable across repeated snapshots", () => {
  const first = englishCatalog();
  // Loading another locale in between must not mutate the registry or English snapshot.
  catalogSnapshot("中文");
  const second = englishCatalog();

  assert.equal(first.catalog_hash, second.catalog_hash);
  assert.match(first.catalog_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(first, second);
  assert.deepEqual(first.all_master_ids, registry().ids("master"));
  assert.deepEqual(first.masters.map((master) => master.id), first.all_master_ids);
  assert.deepEqual(
    first.masters.map((master) => master.index),
    Array.from({ length: first.count }, (_, offset) => offset + 1),
  );
});

test("the 0.9 development catalog contains exactly the planned 26 stable master ids", () => {
  const catalog = englishCatalog();
  assert.equal(catalog.count, 26);
  assert.deepEqual([...catalog.all_master_ids].sort(), TARGET_MASTER_IDS);
});

test("every selector card field is non-empty", () => {
  const { masters } = englishCatalog();
  assert.ok(masters.length >= 5, "range-selection tests require at least five masters");

  for (const master of masters) {
    for (const [field, value] of Object.entries(master)) {
      const label = `${master.id}.${field}`;
      assert.notEqual(value, null, `${label} must not be null`);
      assert.notEqual(value, undefined, `${label} must be defined`);
      if (typeof value === "string") assert.ok(value.trim(), `${label} must be non-empty`);
      else if (typeof value === "number") assert.ok(Number.isFinite(value), `${label} must be finite`);
      else if (Array.isArray(value)) {
        assert.ok(value.length > 0, `${label} must be a non-empty array`);
        assert.ok(value.every((item) => typeof item !== "string" || item.trim()), `${label} has an empty item`);
      } else if (typeof value === "object") {
        assert.ok(Object.keys(value).length > 0, `${label} must be a non-empty object`);
      }
    }
  }
});

test("numeric text accepts a single selection", () => {
  const result = parseMasterSelection("1", englishCatalog().masters);
  assert.deepEqual(result, { mode: "explicit", ids: expectedIds(1) });
});

test("numeric text accepts comma, whitespace, and Chinese-comma multi-selection", () => {
  for (const raw of ["1,3", "1 3", "  1 , 3  ", "1，3"]) {
    const result = parseMasterSelection(raw, englishCatalog().masters);
    assert.deepEqual(result, { mode: "explicit", ids: expectedIds(1, 3) }, raw);
  }
});

test("numeric text accepts inclusive dash and double-dot ranges", () => {
  const ids = expectedIds(1, 2, 3, 4, 5);
  assert.deepEqual(parseMasterSelection("1-5", englishCatalog().masters), { mode: "explicit", ids });
  assert.deepEqual(parseMasterSelection("1..5", englishCatalog().masters), { mode: "explicit", ids });
});

test("all selects the complete catalog in catalog order", () => {
  const catalog = englishCatalog();
  assert.deepEqual(parseMasterSelection("all", catalog.masters), {
    mode: "all",
    ids: catalog.all_master_ids,
  });
});

test("a stable master id is accepted", () => {
  const catalog = englishCatalog();
  const master = catalog.masters[1];
  assert.deepEqual(parseMasterSelection(master.id, catalog.masters), {
    mode: "explicit",
    ids: [master.id],
  });
});

test("a localized Chinese title is accepted", () => {
  const catalog = catalogSnapshot("中文");
  const master = catalog.masters.find((candidate) => candidate.id === "master_buffett");
  assert.ok(master);
  assert.deepEqual(parseMasterSelection(master.title, catalog.masters), {
    mode: "explicit",
    ids: [master.id],
  });
});

test("a localized English title is accepted as one alias", () => {
  const catalog = englishCatalog();
  const master = catalog.masters.find((candidate) => candidate.id === "master_buffett");
  assert.ok(master);
  assert.deepEqual(parseMasterSelection(master.title, catalog.masters), {
    mode: "explicit",
    ids: [master.id],
  });
});

test("all cannot be combined with individual selections", () => {
  assertSelectionError("all,1", "CONFLICTING_MASTER_SELECTION");
});

test("reversed ranges are rejected", () => {
  assertSelectionError("5-1", "REVERSED_MASTER_RANGE");
  assertSelectionError("5..1", "REVERSED_MASTER_RANGE");
});

test("zero and indexes beyond the catalog are rejected", () => {
  const beyond = englishCatalog().masters.length + 1;
  assertSelectionError("0", "MASTER_INDEX_OUT_OF_RANGE");
  assertSelectionError(String(beyond), "MASTER_INDEX_OUT_OF_RANGE");
});

test("unknown aliases are rejected", () => {
  assertSelectionError("definitely_not_a_master", "UNKNOWN_MASTER_ALIAS");
});

test("empty and whitespace-only selections are rejected", () => {
  assertSelectionError("", "EMPTY_MASTER_SELECTION");
  assertSelectionError("   ", "EMPTY_MASTER_SELECTION");
});
