import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { COUNCIL_MODES, LIMITS, SELECTIONS_DIR } from "./constants.mjs";
import { councilOptions } from "./council-options.mjs";
import { invalidParams } from "./errors.mjs";
import { readJson, writeJson } from "./fsutil.mjs";
import { safeSymbol } from "./run-store.mjs";
import { cleanupSelectionStore } from "./selection-cleanup.mjs";
import { ensureSelectionLockStore, withSelectionLock } from "./selection-locks.mjs";

const SELECTION_ID = /^SEL-[0-9a-f-]{36}$/i;
const RECEIPT_ID = /^RCP-[0-9a-f-]{36}$/i;
const QUICK_MASTER_MAX = 4;

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function councilMode(value) {
  const mode = value === undefined ? "full" : String(value);
  if (!COUNCIL_MODES.includes(mode)) {
    throw invalidParams(`council_mode must be one of ${COUNCIL_MODES.join(", ")}.`, {
      reason: "INVALID_COUNCIL_MODE",
    });
  }
  return mode;
}

function ensureStore() {
  ensureSelectionLockStore(SELECTIONS_DIR);
}

function assertSelectionId(id) {
  if (typeof id !== "string" || !SELECTION_ID.test(id)) {
    throw invalidParams("selection_id is invalid.", { reason: "INVALID_SELECTION_ID" });
  }
  return id;
}

function assertReceiptId(id) {
  if (typeof id !== "string" || !RECEIPT_ID.test(id)) {
    throw invalidParams("selection_receipt is invalid.", { reason: "INVALID_SELECTION_RECEIPT" });
  }
  return id;
}

function selectionPath(id) {
  return join(SELECTIONS_DIR, `${assertSelectionId(id)}.json`);
}

function receiptPath(id) {
  return join(SELECTIONS_DIR, "receipts", `${assertReceiptId(id)}.json`);
}

function readSelection(id) {
  const path = selectionPath(id);
  if (!existsSync(path)) throw invalidParams(`selection not found: ${id}`, { reason: "SELECTION_NOT_FOUND" });
  return readJson(path);
}

function readReceipt(id) {
  const path = receiptPath(id);
  if (!existsSync(path)) throw invalidParams("selection receipt is unknown.", { reason: "SELECTION_RECEIPT_UNKNOWN" });
  return readJson(path);
}

function expired(record, now = Date.now()) {
  return Date.parse(record.expires_at) <= now;
}

function markExpired(record) {
  record.status = "expired";
  record.updated_at = new Date().toISOString();
  writeJson(selectionPath(record.selection_id), record);
}

export function catalogSnapshot(language = "English") {
  const options = councilOptions({ language });
  const catalog = {
    schema_version: 1,
    language: options.language,
    count: options.all_masters_count,
    masters: options.masters,
    all_master_ids: options.all_master_ids,
    master_rosters: options.master_rosters,
  };
  return { ...catalog, catalog_hash: digest(catalog) };
}

export function beginCouncilSelection(args = {}, { now = Date.now() } = {}) {
  ensureStore();
  // Bound expiry cleanup to selections/ and selections/receipts/. It is intentionally
  // performed before the new record exists and never follows symlinks or unknown names.
  cleanupSelectionStore({ selectionsDir: SELECTIONS_DIR, now });
  const symbol = safeSymbol(args.symbol);
  const language = String(args.language || "English");
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  const mode = councilMode(args.council_mode);
  const catalog = catalogSnapshot(language);
  const preselected = args.preselected_master_ids === undefined
    ? []
    : normalizeExplicit(args.preselected_master_ids, catalog.all_master_ids);
  const selectionId = `SEL-${randomUUID()}`;
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + LIMITS.SELECTION_TTL_MS).toISOString();
  const record = {
    schema_version: 1,
    selection_id: selectionId,
    status: "awaiting_user_selection",
    symbol,
    language,
    prompt,
    host: typeof args.host === "string" ? args.host : "unknown",
    council_mode: mode,
    request_hash: digest({ symbol, language, prompt, council_mode: mode, host: args.host || "unknown" }),
    intent_hash: digest({ symbol, language, prompt, council_mode: mode }),
    catalog_hash: catalog.catalog_hash,
    catalog,
    selected_master_ids: [],
    preselected_master_ids: preselected,
    selection_mode: null,
    selection_receipt: null,
    created_at: createdAt,
    updated_at: createdAt,
    expires_at: expiresAt,
    confirmed_at: null,
    consumed_at: null,
    consumed_by_run_id: null,
  };
  writeJson(selectionPath(selectionId), record);
  return {
    selection_id: selectionId,
    status: record.status,
    symbol,
    language,
    council_mode: mode,
    catalog_hash: catalog.catalog_hash,
    intent_hash: record.intent_hash,
    expires_at: expiresAt,
    minimum: 1,
    maximum: mode === "quick" ? QUICK_MASTER_MAX : catalog.count,
    masters: catalog.masters,
    master_rosters: catalog.master_rosters,
    preselected_master_ids: preselected,
    actions: mode === "quick" ? ["explicit_selection"] : ["explicit_selection", "select_all"],
  };
}

function normalizeExplicit(ids, available) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw invalidParams("Select at least one master or use select_all=true.", { reason: "EMPTY_MASTER_SELECTION" });
  }
  if (ids.some((id) => typeof id !== "string")) {
    throw invalidParams("selected_master_ids must contain strings only.", { reason: "INVALID_MASTER_SELECTION" });
  }
  if (new Set(ids).size !== ids.length) {
    throw invalidParams("selected_master_ids must be unique.", { reason: "DUPLICATE_MASTER_SELECTION" });
  }
  const wanted = new Set(ids);
  const unknown = ids.filter((id) => !available.includes(id));
  if (unknown.length) {
    throw invalidParams(`Unknown or unavailable master id(s): ${unknown.join(", ")}`, {
      reason: "UNKNOWN_MASTER_SELECTION",
      unknown,
    });
  }
  return available.filter((id) => wanted.has(id));
}

function aliasesFor(master) {
  return [master.id, master.title, master.identity]
    .filter(Boolean)
    .flatMap((value) => {
      const raw = String(value).trim();
      const short = raw
        .replace(/的.*方法.*$/u, "")
        .replace(/方法.*$/u, "")
        .replace(/视角.*$/u, "")
        .replace(/\s+(Lens|Method).*$/i, "")
        .trim();
      return [raw, short];
    })
    .filter(Boolean)
    .map((value) => value.toLocaleLowerCase());
}

export function parseMasterSelection(raw, masters) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw invalidParams("selection must be a non-empty string.", { reason: "EMPTY_MASTER_SELECTION" });
  }
  const text = raw.trim();
  if (/^(all|全部|全选)$/iu.test(text)) return { mode: "all", ids: masters.map((m) => m.id) };

  const tokens = text.split(/[\s,，;；]+/u).filter(Boolean);
  if (tokens.some((token) => /^(all|全部|全选)$/iu.test(token))) {
    throw invalidParams("all cannot be combined with individual selections.", { reason: "CONFLICTING_MASTER_SELECTION" });
  }

  const byAlias = new Map();
  for (const master of masters) {
    for (const alias of aliasesFor(master)) {
      const values = byAlias.get(alias) || new Set();
      values.add(master.id);
      byAlias.set(alias, values);
    }
  }

  // A display title can contain spaces (for example "Buffett Lens"). Resolve the complete
  // submitted value before treating whitespace as a separator for the compact "2 7 11"
  // syntax. Alias sets are per persona id, so a raw/short alias collision inside the same
  // card is not falsely reported as ambiguity.
  const exactMatches = [...(byAlias.get(text.toLocaleLowerCase()) || [])];
  if (exactMatches.length === 1) return { mode: "explicit", ids: [exactMatches[0]] };
  if (exactMatches.length > 1) {
    throw invalidParams(`Ambiguous master selection token: ${text}`, {
      reason: "AMBIGUOUS_MASTER_ALIAS",
      matches: exactMatches,
    });
  }

  const picked = [];
  const addIndex = (index) => {
    if (!Number.isInteger(index) || index < 1 || index > masters.length) {
      throw invalidParams(`Master index ${index} is out of range 1-${masters.length}.`, { reason: "MASTER_INDEX_OUT_OF_RANGE" });
    }
    picked.push(masters[index - 1].id);
  };

  for (const token of tokens) {
    const range = /^(\d+)(?:-|\.\.)(\d+)$/.exec(token);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end) throw invalidParams(`Master range ${token} is reversed.`, { reason: "REVERSED_MASTER_RANGE" });
      for (let index = start; index <= end; index += 1) addIndex(index);
      continue;
    }
    if (/^\d+$/.test(token)) {
      addIndex(Number(token));
      continue;
    }
    const matches = [...(byAlias.get(token.toLocaleLowerCase()) || [])];
    if (matches.length === 0) {
      throw invalidParams(`Unknown master selection token: ${token}`, { reason: "UNKNOWN_MASTER_ALIAS" });
    }
    if (matches.length > 1) {
      throw invalidParams(`Ambiguous master selection token: ${token}`, { reason: "AMBIGUOUS_MASTER_ALIAS", matches });
    }
    picked.push(matches[0]);
  }

  const unique = [...new Set(picked)];
  if (unique.length === 0) throw invalidParams("Select at least one master.", { reason: "EMPTY_MASTER_SELECTION" });
  const wanted = new Set(unique);
  return { mode: "explicit", ids: masters.map((m) => m.id).filter((id) => wanted.has(id)) };
}

function resolveConfirmation(args, record) {
  const modes = [
    Array.isArray(args.selected_master_ids),
    args.select_all === true,
    typeof args.selection === "string" && args.selection.trim().length > 0,
  ].filter(Boolean).length;
  if (modes !== 1) {
    throw invalidParams("Provide exactly one of selected_master_ids, select_all=true, or selection.", {
      reason: "MASTER_SELECTION_ONE_OF_REQUIRED",
    });
  }
  const masters = record.catalog.masters;
  const available = record.catalog.all_master_ids;
  if (args.select_all === true) return { mode: "all", ids: [...available] };
  if (Array.isArray(args.selected_master_ids)) {
    return { mode: "explicit", ids: normalizeExplicit(args.selected_master_ids, available) };
  }
  return parseMasterSelection(args.selection, masters);
}

function confirmCouncilSelectionUnlocked(args = {}, { now = Date.now() } = {}) {
  ensureStore();
  const record = readSelection(args.selection_id);
  if (expired(record, now)) {
    if (record.status !== "expired") markExpired(record);
    throw invalidParams("The master selection expired. Start a new selection.", { reason: "MASTER_SELECTION_EXPIRED" });
  }
  if (args.catalog_hash !== record.catalog_hash) {
    throw invalidParams("The displayed master catalog is stale or does not match this selection.", {
      reason: "STALE_MASTER_CATALOG",
      expected_catalog_hash: record.catalog_hash,
    });
  }
  const currentCatalogHash = catalogSnapshot(record.language).catalog_hash;
  if (currentCatalogHash !== record.catalog_hash) {
    throw invalidParams("The master catalog changed after it was displayed. Start a new selection.", {
      reason: "STALE_MASTER_CATALOG",
      current_catalog_hash: currentCatalogHash,
    });
  }
  if (args.display_ack !== true) {
    throw invalidParams("display_ack=true is required after the catalog has been shown to the user.", {
      reason: "MASTER_CATALOG_NOT_ACKNOWLEDGED",
    });
  }
  const resolved = resolveConfirmation(args, record);
  if (record.council_mode === "quick" && resolved.ids.length > QUICK_MASTER_MAX) {
    throw invalidParams(`Quick council accepts at most ${QUICK_MASTER_MAX} selected masters.`, {
      reason: "QUICK_MASTER_LIMIT_EXCEEDED",
      maximum: QUICK_MASTER_MAX,
      selected_count: resolved.ids.length,
    });
  }
  if (record.status === "confirmed") {
    if (record.selection_mode === resolved.mode
      && JSON.stringify(record.selected_master_ids) === JSON.stringify(resolved.ids)) {
      return confirmationResult(record);
    }
    throw invalidParams("This selection was already confirmed with a different master set.", {
      reason: "MASTER_SELECTION_ALREADY_CONFIRMED",
    });
  }
  if (record.status !== "awaiting_user_selection") {
    throw invalidParams(`Master selection cannot be confirmed from status ${record.status}.`, {
      reason: "INVALID_MASTER_SELECTION_STATE",
    });
  }

  const receipt = `RCP-${randomUUID()}`;
  const confirmedAt = new Date(now).toISOString();
  const selectedPackHashes = Object.fromEntries(
    record.catalog.masters
      .filter((master) => resolved.ids.includes(master.id))
      .map((master) => [master.id, master.pack_hash]),
  );
  Object.assign(record, {
    status: "confirmed",
    selection_mode: resolved.mode,
    selected_master_ids: resolved.ids,
    selection_receipt: receipt,
    confirmed_at: confirmedAt,
    updated_at: confirmedAt,
  });
  const receiptRecord = {
    schema_version: 1,
    selection_receipt: receipt,
    selection_id: record.selection_id,
    status: "confirmed",
    symbol: record.symbol,
    council_mode: record.council_mode || "full",
    catalog_hash: record.catalog_hash,
    request_hash: record.request_hash,
    intent_hash: record.intent_hash,
    selection_hash: digest({
      selection_id: record.selection_id,
      catalog_hash: record.catalog_hash,
      council_mode: record.council_mode || "full",
      selected_master_ids: record.selected_master_ids,
    }),
    selected_master_ids: record.selected_master_ids,
    selected_master_pack_hashes: selectedPackHashes,
    selection_mode: record.selection_mode,
    created_at: confirmedAt,
    expires_at: record.expires_at,
    consumed_at: null,
    consumed_by_run_id: null,
  };
  writeJson(selectionPath(record.selection_id), record);
  writeJson(receiptPath(receipt), receiptRecord);
  return confirmationResult(record);
}

export function confirmCouncilSelection(args = {}, options = {}) {
  ensureStore();
  const id = assertSelectionId(args.selection_id);
  return withSelectionLock({
    kind: "selection",
    id,
    operation: "confirm_selection",
    contentionReason: "MASTER_SELECTION_CONFIRMATION_IN_PROGRESS",
  }, () => confirmCouncilSelectionUnlocked(args, options), {
    selectionsDir: SELECTIONS_DIR,
    ...(options.lock || {}),
  });
}

function confirmationResult(record) {
  return {
    selection_id: record.selection_id,
    selection_receipt: record.selection_receipt,
    status: record.status,
    symbol: record.symbol,
    council_mode: record.council_mode || "full",
    catalog_hash: record.catalog_hash,
    intent_hash: record.intent_hash,
    selection_mode: record.selection_mode,
    selected_master_ids: record.selected_master_ids,
    selected_master_pack_hashes: Object.fromEntries(
      record.catalog.masters
        .filter((master) => record.selected_master_ids.includes(master.id))
        .map((master) => [master.id, master.pack_hash]),
    ),
    selected_count: record.selected_master_ids.length,
    expires_at: record.expires_at,
  };
}

function consumeCouncilSelectionUnlocked(args = {}, { now = Date.now() } = {}) {
  ensureStore();
  const receipt = readReceipt(args.selection_receipt);
  const selection = readSelection(receipt.selection_id);
  const symbol = safeSymbol(args.symbol);
  if (receipt.symbol !== symbol || selection.symbol !== symbol) {
    throw invalidParams(`Selection receipt is for ${receipt.symbol}, not ${symbol}.`, {
      reason: "MASTER_SELECTION_SYMBOL_MISMATCH",
    });
  }
  const currentCatalog = catalogSnapshot(selection.language);
  const currentCatalogHash = currentCatalog.catalog_hash;
  if (receipt.catalog_hash !== currentCatalogHash || selection.catalog_hash !== currentCatalogHash) {
    throw invalidParams("The master catalog changed after selection confirmation. Start a new selection.", {
      reason: "STALE_MASTER_CATALOG",
      current_catalog_hash: currentCatalogHash,
    });
  }
  const currentPackHashes = Object.fromEntries(
    currentCatalog.masters.map((master) => [master.id, master.pack_hash]),
  );
  const mismatchedPackHashes = selection.selected_master_ids.filter((id) => (
    typeof receipt.selected_master_pack_hashes?.[id] !== "string"
      || receipt.selected_master_pack_hashes[id] !== currentPackHashes[id]
  ));
  if (mismatchedPackHashes.length) {
    throw invalidParams("The selected persona pack hash no longer matches the displayed catalog. Start a new selection.", {
      reason: "MASTER_SELECTION_PACK_HASH_MISMATCH",
      mismatched_master_ids: mismatchedPackHashes,
    });
  }
  const language = String(args.language || "English");
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  const mode = councilMode(args.council_mode);
  if ((receipt.council_mode || "full") !== mode || (selection.council_mode || "full") !== mode) {
    throw invalidParams("The selection receipt belongs to a different council mode.", {
      reason: "MASTER_SELECTION_MODE_MISMATCH",
      selected_mode: receipt.council_mode || selection.council_mode || "full",
      requested_mode: mode,
    });
  }
  const intentHash = digest({ symbol, language, prompt, council_mode: mode });
  if (receipt.intent_hash !== intentHash || selection.intent_hash !== intentHash) {
    throw invalidParams("The selection receipt belongs to a different prompt or language intent.", {
      reason: "MASTER_SELECTION_INTENT_MISMATCH",
    });
  }
  if (expired(receipt, now) || expired(selection, now)) {
    if (selection.status !== "expired") markExpired(selection);
    throw invalidParams("The master selection receipt expired. Start a new selection.", {
      reason: "MASTER_SELECTION_EXPIRED",
    });
  }
  const runId = String(args.run_id || "");
  if (!runId) throw invalidParams("run_id is required when consuming a selection receipt.");
  if (receipt.status === "consumed" || selection.status === "consumed") {
    if (receipt.consumed_by_run_id === runId && selection.consumed_by_run_id === runId) {
      return consumedResult(selection, receipt);
    }
    throw invalidParams("This master selection receipt has already been used by another run.", {
      reason: "MASTER_SELECTION_REPLAYED",
      consumed_by_run_id: receipt.consumed_by_run_id || selection.consumed_by_run_id,
    });
  }
  if (receipt.status !== "confirmed" || selection.status !== "confirmed") {
    throw invalidParams("The master selection has not been confirmed.", { reason: "MASTER_SELECTION_REQUIRED" });
  }

  const consumedAt = new Date(now).toISOString();
  Object.assign(receipt, { status: "consumed", consumed_at: consumedAt, consumed_by_run_id: runId });
  Object.assign(selection, {
    status: "consumed",
    consumed_at: consumedAt,
    consumed_by_run_id: runId,
    updated_at: consumedAt,
  });
  writeJson(receiptPath(receipt.selection_receipt), receipt);
  writeJson(selectionPath(selection.selection_id), selection);
  return consumedResult(selection, receipt);
}

export function consumeCouncilSelection(args = {}, options = {}) {
  ensureStore();
  const receipt = assertReceiptId(args.selection_receipt);
  return withSelectionLock({
    kind: "receipt",
    id: receipt,
    operation: "consume_receipt",
    contentionReason: "MASTER_SELECTION_CONSUMPTION_IN_PROGRESS",
  }, () => consumeCouncilSelectionUnlocked(args, options), {
    selectionsDir: SELECTIONS_DIR,
    ...(options.lock || {}),
  });
}

function consumedResult(selection, receipt) {
  return {
    selection_id: selection.selection_id,
    selection_receipt: receipt.selection_receipt,
    selection_hash: receipt.selection_hash,
    catalog_hash: selection.catalog_hash,
    intent_hash: selection.intent_hash,
    selection_mode: selection.selection_mode,
    council_mode: selection.council_mode || "full",
    selected_master_ids: [...selection.selected_master_ids],
    selected_master_pack_hashes: { ...(receipt.selected_master_pack_hashes || {}) },
    selected_count: selection.selected_master_ids.length,
    status: "consumed",
    consumed_by_run_id: selection.consumed_by_run_id,
  };
}

export function selectionRequiredError() {
  return invalidParams(
    "MASTER_SELECTION_REQUIRED: call begin_council_selection, show the catalog, then call confirm_master_selection before starting a council run.",
    { reason: "MASTER_SELECTION_REQUIRED" },
  );
}
