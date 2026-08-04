import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ANALYST_SCOPES,
  COUNCIL_MODES,
  COUNCIL_PACE_NAMES,
  COUNCIL_PACE_STAGE_TOTAL,
  DEFAULT_COUNCIL_PACE,
  LIMITS,
  QUICK_TASKS,
  SELECTIONS_DIR,
  councilPaceProfile,
} from "./constants.mjs";
import { councilOptions } from "./council-options.mjs";
import { invalidParams } from "./errors.mjs";
import { readJson, writeJson } from "./fsutil.mjs";
import { resolveLanguage } from "./lang.mjs";
import { safeSymbol } from "./run-store.mjs";
import { cleanupSelectionStore } from "./selection-cleanup.mjs";
import { ensureSelectionLockStore, withSelectionLock } from "./selection-locks.mjs";

const SELECTION_ID = /^SEL-[0-9a-f-]{36}$/i;
const RECEIPT_ID = /^RCP-[0-9a-f-]{36}$/i;
const QUICK_MASTER_MAX = 4;
const LEGACY_SELECTION_HASH_VERSION = 1;
const PACE_SELECTION_HASH_VERSION = 2;
const CURRENT_SELECTION_HASH_VERSION = 3;
const SUPPORTED_SELECTION_LANGUAGES = Object.freeze(["中文", "English", "日本語", "한국어"]);

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function selectionHashVersion(record) {
  const version = Object.hasOwn(record, "selection_hash_version")
    ? record.selection_hash_version
    : LEGACY_SELECTION_HASH_VERSION;
  if (![LEGACY_SELECTION_HASH_VERSION, PACE_SELECTION_HASH_VERSION, CURRENT_SELECTION_HASH_VERSION].includes(version)) {
    throw invalidParams(`Unsupported selection hash version: ${version}`, {
      reason: "MASTER_SELECTION_HASH_VERSION_UNSUPPORTED",
      selection_hash_version: version,
      supported_selection_hash_versions: [
        LEGACY_SELECTION_HASH_VERSION,
        PACE_SELECTION_HASH_VERSION,
        CURRENT_SELECTION_HASH_VERSION,
      ],
    });
  }
  return version;
}

function receiptSelectionHash(receipt) {
  const version = selectionHashVersion(receipt);
  const legacyPayload = {
    schema_version: receipt.schema_version,
    selection_receipt: receipt.selection_receipt,
    selection_id: receipt.selection_id,
    symbol: receipt.symbol,
    council_mode: receipt.council_mode,
    catalog_hash: receipt.catalog_hash,
    request_hash: receipt.request_hash,
    intent_hash: receipt.intent_hash,
    selected_master_ids: receipt.selected_master_ids,
    selected_master_pack_hashes: receipt.selected_master_pack_hashes,
    selection_mode: receipt.selection_mode,
    created_at: receipt.created_at,
    expires_at: receipt.expires_at,
  };
  if (version === LEGACY_SELECTION_HASH_VERSION) return digest(legacyPayload);
  const pacePayload = {
    ...legacyPayload,
    selection_hash_version: version,
    council_pace: receipt.council_pace,
  };
  if (version === PACE_SELECTION_HASH_VERSION) return digest(pacePayload);
  return digest({
    ...pacePayload,
    analyst_scope: receipt.analyst_scope,
    selected_analyst_ids: receipt.selected_analyst_ids,
  });
}

function selectedMasterPackHashes(record, ids = record.selected_master_ids) {
  return Object.fromEntries(
    record.catalog.masters
      .filter((master) => ids.includes(master.id))
      .map((master) => [master.id, master.pack_hash]),
  );
}

/**
 * The selection id already carries 128 bits of randomness. Deriving the receipt id from the
 * immutable confirmation inputs means a crash before the first durable confirmation write cannot
 * make an identical retry mint a second one-use capability.
 */
function stableReceiptId(record, resolved, councilPace, analystSelection) {
  const raw = digest({
    schema_version: 1,
    selection_hash_version: CURRENT_SELECTION_HASH_VERSION,
    selection_id: record.selection_id,
    catalog_hash: record.catalog_hash,
    intent_hash: record.intent_hash,
    selection_mode: resolved.mode,
    selected_master_ids: resolved.ids,
    council_pace: councilPace,
    analyst_scope: analystSelection.scope,
    selected_analyst_ids: analystSelection.ids,
  }).slice(0, 32);
  // Preserve the UUID grammar required by the lock layer: deterministic v5 nibble and RFC 4122
  // variant, while the remaining 122 bits still come from the confirmation digest.
  const hex = `${raw.slice(0, 12)}5${raw.slice(13, 16)}${((Number.parseInt(raw[16], 16) & 0x3) | 0x8).toString(16)}${raw.slice(17)}`;
  return `RCP-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function confirmedReceiptRecord(record) {
  const hashVersion = selectionHashVersion(record);
  const receiptRecord = {
    schema_version: record.schema_version,
    selection_hash_version: hashVersion,
    selection_receipt: assertReceiptId(record.selection_receipt),
    selection_id: record.selection_id,
    status: "confirmed",
    symbol: record.symbol,
    council_mode: record.council_mode || "full",
    council_pace: record.council_pace,
    catalog_hash: record.catalog_hash,
    request_hash: record.request_hash,
    intent_hash: record.intent_hash,
    selected_master_ids: record.selected_master_ids,
    selected_master_pack_hashes: selectedMasterPackHashes(record),
    selection_mode: record.selection_mode,
    ...(hashVersion >= CURRENT_SELECTION_HASH_VERSION ? {
      analyst_scope: record.analyst_scope,
      selected_analyst_ids: record.selected_analyst_ids,
    } : {}),
    created_at: record.confirmed_at,
    expires_at: record.expires_at,
    consumed_at: null,
    consumed_by_run_id: null,
  };
  receiptRecord.selection_hash = receiptSelectionHash(receiptRecord);
  return receiptRecord;
}

function receiptRecoveryRecord(receipt) {
  return {
    schema_version: 1,
    authority: "selection_record",
    selection_receipt: receipt.selection_receipt,
    selection_hash: receipt.selection_hash,
    prepared_at: receipt.created_at,
  };
}

function receiptRecoveryMismatches(selection, receipt) {
  if (!Object.hasOwn(selection, "receipt_recovery")) return [];
  // The recovery authority was introduced with v2. Legacy v1 receipts have no such binding;
  // retaining or ignoring an unknown additive selection field must not change their old hash and
  // pace-validation contract.
  if (selectionHashVersion(selection) === LEGACY_SELECTION_HASH_VERSION
    || selectionHashVersion(receipt) === LEGACY_SELECTION_HASH_VERSION) return [];
  const recovery = selection.receipt_recovery;
  const expected = receiptRecoveryRecord(receipt);
  return Object.keys(expected)
    .filter((field) => !sameJson(recovery?.[field], expected[field]))
    .map((field) => `receipt_recovery.${field}`);
}

function transactionWriter(options = {}) {
  const injected = options.io?.writeJson;
  if (injected === undefined) return writeJson;
  if (typeof injected !== "function") throw new TypeError("selection transaction io.writeJson must be a function");
  return injected;
}

function receiptRecordMismatches(actual, expected) {
  return Object.keys(expected)
    .filter((field) => !sameJson(actual?.[field], expected[field]));
}

/**
 * A confirmed selection is the single durable authority for its receipt. It contains the stable
 * receipt id, every binding input and the expected receipt hash, so a restart can finish only the
 * missing second write. An existing but different receipt is never overwritten as "recovery".
 */
function ensureConfirmedReceipt(record, options = {}) {
  const expected = confirmedReceiptRecord(record);
  const recoveryMismatches = receiptRecoveryMismatches(record, expected);
  if (recoveryMismatches.length) {
    throw invalidParams("The confirmed selection recovery record is inconsistent.", {
      reason: "MASTER_SELECTION_RECORD_MISMATCH",
      mismatched_fields: recoveryMismatches,
    });
  }
  const path = receiptPath(expected.selection_receipt);
  if (!existsSync(path)) {
    transactionWriter(options)(path, expected);
    return expected;
  }
  const actual = readJson(path);
  const mismatched = receiptRecordMismatches(actual, expected);
  if (mismatched.length) {
    throw invalidParams("The existing selection receipt does not match its confirmed selection.", {
      reason: "MASTER_SELECTION_RECORD_MISMATCH",
      mismatched_fields: mismatched,
    });
  }
  return actual;
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

function assertSelectionTimeout(args, selection, mode) {
  if (args.total_timeout_ms === undefined) return;
  if (mode === "quick") {
    if (args.total_timeout_ms > LIMITS.QUICK_HARD_MAX_MS) {
      throw invalidParams(`Quick council total_timeout_ms cannot exceed ${LIMITS.QUICK_HARD_MAX_MS}.`, {
        reason: "QUICK_TOTAL_TIMEOUT_EXCEEDS_MAX",
        maximum_ms: LIMITS.QUICK_HARD_MAX_MS,
      });
    }
    return;
  }

  const profile = councilPaceProfile(selection.council_pace);
  if (args.total_timeout_ms > profile.total_ms) {
    throw invalidParams(
      `Full council total_timeout_ms cannot exceed ${profile.total_ms} at the ${profile.pace} pace. Raise council_pace to buy more time.`,
      {
        reason: "FULL_TOTAL_TIMEOUT_EXCEEDS_MAX",
        council_pace: profile.pace,
        maximum_ms: profile.total_ms,
        paces: Object.fromEntries(COUNCIL_PACE_NAMES.map((name) => [name, councilPaceProfile(name).total_ms])),
      },
    );
  }
}

function selectionLanguage(args = {}) {
  const language = resolveLanguage({ language: args.language, prompt: args.prompt });
  if (!SUPPORTED_SELECTION_LANGUAGES.includes(language)) {
    throw invalidParams(
      `Selection language ${JSON.stringify(language)} is unsupported. Use zh-CN, en-US, ja-JP or ko-KR.`,
      {
        reason: "UNSUPPORTED_SELECTION_LANGUAGE",
        requested_language: args.language ?? null,
        supported_languages: ["zh-CN", "en-US", "ja-JP", "ko-KR"],
      },
    );
  }
  return language;
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
  const effectiveLanguage = selectionLanguage({ language });
  const options = councilOptions({ language: effectiveLanguage });
  const catalog = {
    schema_version: 1,
    language: options.language,
    count: options.all_masters_count,
    masters: options.masters,
    all_master_ids: options.all_master_ids,
    master_rosters: options.master_rosters,
    analysts: options.analysts,
    core_analyst_ids: options.default_analysts,
    all_analyst_ids: options.analysts.map((analyst) => analyst.id),
  };
  return { ...catalog, catalog_hash: digest(catalog) };
}

export function analystScopeMenu(catalog, mode = "full") {
  if (councilMode(mode) === "quick") {
    return [{ scope: "quick", analyst_ids: [...QUICK_TASKS], count: QUICK_TASKS.length, is_default: true }];
  }
  return [
    {
      scope: "core",
      analyst_ids: [...catalog.core_analyst_ids],
      count: catalog.core_analyst_ids.length,
      is_default: true,
      label: { en: "Core analyst set", zh: "8 个核心分析席" },
    },
    {
      scope: "all",
      analyst_ids: [...catalog.all_analyst_ids],
      count: catalog.all_analyst_ids.length,
      is_default: false,
      label: { en: "All analyst seats", zh: "全部 11 个分析席" },
    },
  ];
}

/**
 * The pace menu shown at the selection gate, with what each tier costs and what it buys.
 *
 * `total_ms` is a hard ceiling, not a forecast, so both are published: `expected_ms` is the
 * serial worst case if every stage uses its whole cap, which is the honest answer to "how long
 * will this take". A reader given only the ceiling reads it as the estimate and thinks every
 * fast run takes fifteen minutes.
 */
export function councilPaceMenu(mode = "full") {
  if (councilMode(mode) === "quick") return [];
  return COUNCIL_PACE_NAMES.map((name) => {
    const profile = councilPaceProfile(name);
    return {
      pace: name,
      is_default: name === DEFAULT_COUNCIL_PACE,
      hard_ceiling_ms: profile.total_ms,
      hard_ceiling_minutes: Math.round(profile.total_ms / 60000),
      expected_ms: COUNCIL_PACE_STAGE_TOTAL(profile),
      expected_minutes: Math.round(COUNCIL_PACE_STAGE_TOTAL(profile) / 60000),
      evidence_seconds_per_seat: Math.round(profile.evidence_ms / 1000),
      debate_seconds_per_round: Math.round(profile.debate_ms / 1000),
      // Same contract at every tier: this is what changes and what does not.
      buys: {
        en: `${Math.round(profile.evidence_ms / 60000 * 10) / 10} min per evidence seat, ${Math.round(profile.debate_ms / 1000)}s per debate round per side`,
        zh: `每个证据席 ${Math.round(profile.evidence_ms / 60000 * 10) / 10} 分钟，每轮辩论每侧 ${Math.round(profile.debate_ms / 1000)} 秒`,
      },
    };
  });
}

export function beginCouncilSelection(args = {}, { now = Date.now() } = {}) {
  ensureStore();
  // Bound expiry cleanup to selections/ and selections/receipts/. It is intentionally
  // performed before the new record exists and never follows symlinks or unknown names.
  cleanupSelectionStore({ selectionsDir: SELECTIONS_DIR, now });
  const symbol = safeSymbol(args.symbol);
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  const language = selectionLanguage({ language: args.language, prompt });
  const mode = councilMode(args.council_mode);
  const catalog = catalogSnapshot(language);
  const preselected = args.preselected_master_ids === undefined
    ? []
    : normalizeExplicit(args.preselected_master_ids, catalog.all_master_ids);
  const preselectedAnalystScope = ANALYST_SCOPES.includes(String(args.analyst_scope || ""))
    ? String(args.analyst_scope)
    : null;
  const selectionId = `SEL-${randomUUID()}`;
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + LIMITS.SELECTION_TTL_MS).toISOString();
  const record = {
    schema_version: 1,
    selection_hash_version: CURRENT_SELECTION_HASH_VERSION,
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
    preselected_analyst_scope: mode === "quick" ? null : preselectedAnalystScope,
    analyst_scope: mode === "quick" ? "quick" : null,
    selected_analyst_ids: mode === "quick" ? [...QUICK_TASKS] : [],
    // A pace named in the request is a prefill, exactly like a named master: it highlights the
    // row and never confirms it. The confirmed value lands here at confirm time.
    preselected_council_pace: COUNCIL_PACE_NAMES.includes(String(args.council_pace || "")) ? String(args.council_pace) : null,
    council_pace: null,
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
    analyst_options: analystScopeMenu(catalog, mode),
    preselected_analyst_scope: record.preselected_analyst_scope,
    // Ask the pace in the same interaction as the catalog: two decisions, one question. Quick
    // gets an empty menu because it is a smaller contract rather than a slower one.
    pace_options: councilPaceMenu(mode),
    default_council_pace: mode === "quick" ? null : DEFAULT_COUNCIL_PACE,
    preselected_council_pace: record.preselected_council_pace,
    actions: mode === "quick"
      ? ["explicit_selection"]
      : ["explicit_method_selection", "select_all_methods", "choose_analyst_scope"],
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

function resolveAnalystSelection(args, record) {
  const quick = (record.council_mode || "full") === "quick";
  if (quick) {
    if (args.analyst_scope !== undefined && args.analyst_scope !== null) {
      throw invalidParams("analyst_scope applies to the full council only; quick has a fixed four-seat analyst set.", {
        reason: "QUICK_ANALYST_SCOPE_FORBIDDEN",
        selected_analyst_ids: QUICK_TASKS,
      });
    }
    return { scope: "quick", ids: [...QUICK_TASKS] };
  }
  if (!ANALYST_SCOPES.includes(String(args.analyst_scope || ""))) {
    throw invalidParams("Choose analyst_scope=core or analyst_scope=all separately from the method-seat selection.", {
      reason: "ANALYST_SCOPE_REQUIRED",
      allowed: ANALYST_SCOPES,
      analyst_options: analystScopeMenu(record.catalog, record.council_mode),
    });
  }
  const scope = String(args.analyst_scope);
  return {
    scope,
    ids: scope === "all"
      ? [...record.catalog.all_analyst_ids]
      : [...record.catalog.core_analyst_ids],
  };
}

function confirmCouncilSelectionUnlocked(args = {}, options = {}) {
  const now = options.now ?? Date.now();
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
  // The pace is the second decision taken at this gate. Quick has no pace to take, and an
  // unrecognised name is rejected rather than quietly run at some other depth -- a user who
  // asked for fifteen minutes must not silently get an hour, or the reverse.
  const quickSelection = (record.council_mode || "full") === "quick";
  if (args.council_pace !== undefined && args.council_pace !== null) {
    if (quickSelection) {
      throw invalidParams("council_pace applies to the full council only. Quick is a smaller contract, not a slower one.", {
        reason: "QUICK_PACE_FORBIDDEN",
      });
    }
    if (!COUNCIL_PACE_NAMES.includes(String(args.council_pace))) {
      throw invalidParams(`council_pace must be one of ${COUNCIL_PACE_NAMES.join(", ")}.`, {
        reason: "INVALID_COUNCIL_PACE",
        allowed: COUNCIL_PACE_NAMES,
        pace_options: councilPaceMenu(record.council_mode),
      });
    }
  }
  const chosenPace = quickSelection
    ? null
    : String(args.council_pace || record.preselected_council_pace || DEFAULT_COUNCIL_PACE);
  const resolved = resolveConfirmation(args, record);
  const analystSelection = resolveAnalystSelection(args, record);
  if (record.council_mode === "quick" && resolved.ids.length > QUICK_MASTER_MAX) {
    throw invalidParams(`Quick council accepts at most ${QUICK_MASTER_MAX} selected masters.`, {
      reason: "QUICK_MASTER_LIMIT_EXCEEDED",
      maximum: QUICK_MASTER_MAX,
      selected_count: resolved.ids.length,
    });
  }
  if (record.status === "confirmed") {
    if (record.selection_mode === resolved.mode
      && JSON.stringify(record.selected_master_ids) === JSON.stringify(resolved.ids)
      && (record.council_pace || null) === chosenPace
      && record.analyst_scope === analystSelection.scope
      && JSON.stringify(record.selected_analyst_ids) === JSON.stringify(analystSelection.ids)) {
      ensureConfirmedReceipt(record, options);
      return confirmationResult(record);
    }
    throw invalidParams("This selection was already confirmed with different method choices, analyst scope, or pace.", {
      reason: "MASTER_SELECTION_ALREADY_CONFIRMED",
      confirmed_council_pace: record.council_pace || null,
      submitted_council_pace: chosenPace,
      confirmed_analyst_scope: record.analyst_scope || null,
      submitted_analyst_scope: analystSelection.scope,
    });
  }
  if (record.status !== "awaiting_user_selection") {
    throw invalidParams(`Master selection cannot be confirmed from status ${record.status}.`, {
      reason: "INVALID_MASTER_SELECTION_STATE",
    });
  }

  const receipt = stableReceiptId(record, resolved, chosenPace, analystSelection);
  const confirmedAt = new Date(now).toISOString();
  Object.assign(record, {
    status: "confirmed",
    selection_hash_version: CURRENT_SELECTION_HASH_VERSION,
    selection_mode: resolved.mode,
    selected_master_ids: resolved.ids,
    analyst_scope: analystSelection.scope,
    selected_analyst_ids: analystSelection.ids,
    selection_receipt: receipt,
    confirmed_at: confirmedAt,
    updated_at: confirmedAt,
    council_pace: chosenPace,
  });
  const receiptRecord = confirmedReceiptRecord(record);
  // This recovery metadata and the complete selection binding reach disk in the first write.
  // Receipt existence plus its verified hash is the commit point; no catch-time rollback is
  // required, so a process death between the two writes is restart-recoverable.
  record.receipt_recovery = receiptRecoveryRecord(receiptRecord);
  const writeTransactionJson = transactionWriter(options);
  writeTransactionJson(selectionPath(record.selection_id), record);
  writeTransactionJson(receiptPath(receipt), receiptRecord);
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
    language: record.language,
    council_mode: record.council_mode || "full",
    selection_hash_version: selectionHashVersion(record),
    catalog_hash: record.catalog_hash,
    intent_hash: record.intent_hash,
    selection_mode: record.selection_mode,
    selected_master_ids: record.selected_master_ids,
    selected_master_pack_hashes: selectedMasterPackHashes(record),
    selected_count: record.selected_master_ids.length,
    analyst_scope: record.analyst_scope,
    selected_analyst_ids: [...record.selected_analyst_ids],
    selected_analyst_count: record.selected_analyst_ids.length,
    all_master_count: record.catalog.count,
    council_pace: record.council_pace || null,
    expires_at: record.expires_at,
  };
}

function consumptionState(record, recordName) {
  if (record.status !== "consumed") return null;
  const mismatched = [];
  if (typeof record.consumed_by_run_id !== "string" || !record.consumed_by_run_id) {
    mismatched.push(`${recordName}.consumed_by_run_id`);
  }
  const consumedAt = Date.parse(record.consumed_at);
  const expiresAt = Date.parse(record.expires_at);
  if (!Number.isFinite(consumedAt)) mismatched.push(`${recordName}.consumed_at`);
  if (!Number.isFinite(expiresAt) || (Number.isFinite(consumedAt) && consumedAt > expiresAt)) {
    mismatched.push(`${recordName}.consumed_at_after_expires_at`);
  }
  if (mismatched.length) {
    throw invalidParams("The consumed selection audit metadata is invalid.", {
      reason: "MASTER_SELECTION_RECORD_MISMATCH",
      mismatched_fields: mismatched,
    });
  }
  return { run_id: record.consumed_by_run_id, consumed_at: record.consumed_at };
}

function replayedSelection(receiptState, selectionState) {
  throw invalidParams("This master selection receipt has already been used by another run.", {
    reason: "MASTER_SELECTION_REPLAYED",
    consumed_by_run_id: receiptState?.run_id || selectionState?.run_id || null,
  });
}

/**
 * Receipt is written first during consumption. If the process dies before the selection write,
 * the consumed receipt is the durable authority and only the same run id may finish that write.
 * The reverse split is also repaired for forward compatibility; conflicting owners fail closed.
 */
function reconcileConsumption(receipt, selection, runId, options = {}) {
  const receiptState = consumptionState(receipt, "receipt");
  const selectionState = consumptionState(selection, "selection");
  if (!receiptState && !selectionState) return null;

  const owners = [receiptState?.run_id, selectionState?.run_id].filter(Boolean);
  if (owners.some((owner) => owner !== runId) || new Set(owners).size > 1) {
    replayedSelection(receiptState, selectionState);
  }
  if (receiptState && selectionState) {
    if (receiptState.consumed_at !== selectionState.consumed_at) {
      throw invalidParams("The consumed selection records disagree on their audit timestamp.", {
        reason: "MASTER_SELECTION_RECORD_MISMATCH",
        mismatched_fields: ["consumed_at"],
      });
    }
    return consumedResult(selection, receipt);
  }

  const writeTransactionJson = transactionWriter(options);
  if (receiptState) {
    // Older code could incorrectly mark the confirmed half expired while leaving a valid,
    // pre-expiry consumed receipt. That state is recoverable by the same owner as well.
    if (selection.status !== "confirmed" && selection.status !== "expired") {
      throw invalidParams("The selection receipt and selection record have incompatible states.", {
        reason: "MASTER_SELECTION_RECORD_MISMATCH",
        mismatched_fields: ["status"],
      });
    }
    Object.assign(selection, {
      status: "consumed",
      consumed_at: receiptState.consumed_at,
      consumed_by_run_id: receiptState.run_id,
      updated_at: receiptState.consumed_at,
    });
    writeTransactionJson(selectionPath(selection.selection_id), selection);
  } else {
    if (receipt.status !== "confirmed") {
      throw invalidParams("The selection receipt and selection record have incompatible states.", {
        reason: "MASTER_SELECTION_RECORD_MISMATCH",
        mismatched_fields: ["status"],
      });
    }
    Object.assign(receipt, {
      status: "consumed",
      consumed_at: selectionState.consumed_at,
      consumed_by_run_id: selectionState.run_id,
    });
    writeTransactionJson(receiptPath(receipt.selection_receipt), receipt);
  }
  return consumedResult(selection, receipt);
}

function consumeCouncilSelectionUnlocked(args = {}, options = {}) {
  const now = options.now ?? Date.now();
  ensureStore();
  const receipt = readReceipt(args.selection_receipt);
  if (receipt.selection_receipt !== args.selection_receipt) {
    throw invalidParams("The selection receipt file does not match its requested receipt id.", {
      reason: "MASTER_SELECTION_RECORD_MISMATCH",
      mismatched_fields: ["selection_receipt"],
    });
  }
  const receiptHashVersion = selectionHashVersion(receipt);
  const expectedSelectionHash = receiptSelectionHash(receipt);
  if (receipt.selection_hash !== expectedSelectionHash) {
    throw invalidParams("The selection receipt hash is invalid.", {
      reason: "MASTER_SELECTION_HASH_MISMATCH",
      expected_selection_hash: expectedSelectionHash,
    });
  }
  const selection = readSelection(receipt.selection_id);
  const recoveryMismatches = receiptRecoveryMismatches(selection, receipt);
  if (recoveryMismatches.length) {
    throw invalidParams("The selection receipt does not match its recovery authority.", {
      reason: "MASTER_SELECTION_RECORD_MISMATCH",
      mismatched_fields: recoveryMismatches,
    });
  }
  const selectionRecordHashVersion = selectionHashVersion(selection);
  const expectedPackHashes = selectedMasterPackHashes(selection);
  const recordBindings = [
    ["schema_version", receipt.schema_version, selection.schema_version],
    ["selection_hash_version", receiptHashVersion, selectionRecordHashVersion],
    ["selection_id", receipt.selection_id, selection.selection_id],
    ["selection_receipt", receipt.selection_receipt, selection.selection_receipt],
    ["symbol", receipt.symbol, selection.symbol],
    ["council_mode", receipt.council_mode || "full", selection.council_mode || "full"],
    [
      "council_pace",
      receipt.council_pace,
      selection.council_pace,
      Object.hasOwn(receipt, "council_pace") && Object.hasOwn(selection, "council_pace"),
    ],
    ["catalog_hash", receipt.catalog_hash, selection.catalog_hash],
    ["request_hash", receipt.request_hash, selection.request_hash],
    ["intent_hash", receipt.intent_hash, selection.intent_hash],
    ["selected_master_ids", receipt.selected_master_ids, selection.selected_master_ids],
    ["selection_mode", receipt.selection_mode, selection.selection_mode],
    ["created_at", receipt.created_at, selection.confirmed_at],
    ["expires_at", receipt.expires_at, selection.expires_at],
  ];
  if (receiptHashVersion >= CURRENT_SELECTION_HASH_VERSION
    && selectionRecordHashVersion >= CURRENT_SELECTION_HASH_VERSION) {
    recordBindings.push(
      ["analyst_scope", receipt.analyst_scope, selection.analyst_scope],
      ["selected_analyst_ids", receipt.selected_analyst_ids, selection.selected_analyst_ids],
    );
  }
  const mismatchedBindings = recordBindings
    .filter(([, receiptValue, selectionValue, present = true]) => !present || !sameJson(receiptValue, selectionValue))
    .map(([field]) => field);
  if (mismatchedBindings.length) {
    throw invalidParams("The selection receipt does not match its confirmed selection record.", {
      reason: "MASTER_SELECTION_RECORD_MISMATCH",
      mismatched_fields: mismatchedBindings,
    });
  }
  const boundMode = receipt.council_mode || "full";
  const paceMatchesMode = boundMode === "quick"
    ? receipt.council_pace === null
    : COUNCIL_PACE_NAMES.includes(receipt.council_pace);
  if (!paceMatchesMode) {
    throw invalidParams("The selection receipt has no valid pace for its confirmed council mode.", {
      reason: "MASTER_SELECTION_RECORD_MISMATCH",
      mismatched_fields: ["council_pace"],
      council_mode: boundMode,
      council_pace: receipt.council_pace,
    });
  }
  if (!sameJson(receipt.selected_master_pack_hashes, expectedPackHashes)) {
    throw invalidParams("The selected persona pack hashes do not match the confirmed selection record.", {
      reason: "MASTER_SELECTION_PACK_HASH_MISMATCH",
      mismatched_master_ids: [...new Set([
        ...selection.selected_master_ids,
        ...Object.keys(receipt.selected_master_pack_hashes || {}),
      ])].filter((id) => receipt.selected_master_pack_hashes?.[id] !== expectedPackHashes[id]),
    });
  }
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
  const effectiveAnalystScope = receiptHashVersion >= CURRENT_SELECTION_HASH_VERSION
    ? receipt.analyst_scope
    : ((receipt.council_mode || "full") === "quick" ? "quick" : "core");
  const effectiveAnalystIds = receiptHashVersion >= CURRENT_SELECTION_HASH_VERSION
    ? receipt.selected_analyst_ids
    : (effectiveAnalystScope === "quick" ? QUICK_TASKS : currentCatalog.core_analyst_ids);
  const expectedAnalystIds = effectiveAnalystScope === "all"
    ? currentCatalog.all_analyst_ids
    : effectiveAnalystScope === "quick"
      ? QUICK_TASKS
      : currentCatalog.core_analyst_ids;
  if (!["core", "all", "quick"].includes(effectiveAnalystScope)
    || !sameJson(effectiveAnalystIds, expectedAnalystIds)) {
    throw invalidParams("The analyst scope does not match the frozen analyst catalog.", {
      reason: "ANALYST_SELECTION_RECORD_MISMATCH",
      analyst_scope: effectiveAnalystScope,
      selected_analyst_ids: effectiveAnalystIds,
      expected_analyst_ids: expectedAnalystIds,
    });
  }
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  const language = selectionLanguage({ language: args.language, prompt });
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
    // Say which field moved. The receipt binds symbol, language, prompt and mode verbatim, so a
    // single reworded character invalidates it -- and without this the caller cannot tell a
    // retyped prompt from a wrong symbol, and retries the same broken call.
    throw invalidParams("The selection receipt belongs to a different prompt or language intent.", {
      reason: "MASTER_SELECTION_INTENT_MISMATCH",
      expected_intent_hash: receipt.intent_hash || selection.intent_hash || null,
      submitted_intent_hash: intentHash,
      bound_fields: ["symbol", "language", "prompt", "council_mode"],
      submitted: { symbol, language, council_mode: mode, prompt_length: prompt.length },
      remedy: "Re-send the exact symbol, prompt, language and council_mode used in begin_council_selection, or start a new selection.",
    });
  }
  const runId = String(args.run_id || "");
  if (!runId) throw invalidParams("run_id is required when consuming a selection receipt.");
  if (args.council_pace !== undefined
    && String(args.council_pace) !== String(selection.council_pace)) {
    throw invalidParams(
      `council_pace ${args.council_pace} does not match the pace confirmed at the selection gate (${selection.council_pace}).`,
      {
        reason: "COUNCIL_PACE_RECEIPT_MISMATCH",
        confirmed_council_pace: selection.council_pace,
        submitted_council_pace: String(args.council_pace),
        remedy: "Send the confirmed pace or start a new selection to change it.",
      },
    );
  }
  if (args.analyst_scope !== undefined
    && String(args.analyst_scope) !== effectiveAnalystScope) {
    throw invalidParams(
      `analyst_scope ${args.analyst_scope} does not match the scope confirmed at the selection gate (${effectiveAnalystScope}).`,
      {
        reason: "ANALYST_SCOPE_RECEIPT_MISMATCH",
        confirmed_analyst_scope: effectiveAnalystScope,
        submitted_analyst_scope: String(args.analyst_scope),
      },
    );
  }
  assertSelectionTimeout(args, selection, mode);
  // A valid consumed audit record proves consumption began before expiry. Reconcile or replay it
  // before applying the TTL for a brand-new use; otherwise a restart can strand the one-use
  // receipt after its first write. Every content/binding check above still runs first.
  const reconciled = reconcileConsumption(receipt, selection, runId, options);
  if (reconciled) return reconciled;
  if (expired(receipt, now) || expired(selection, now)) {
    if (selection.status !== "expired") markExpired(selection);
    throw invalidParams("The master selection receipt expired. Start a new selection.", {
      reason: "MASTER_SELECTION_EXPIRED",
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
  const writeTransactionJson = transactionWriter(options);
  writeTransactionJson(receiptPath(receipt.selection_receipt), receipt);
  writeTransactionJson(selectionPath(selection.selection_id), selection);
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
  const hashVersion = selectionHashVersion(receipt);
  const mode = selection.council_mode || "full";
  const analystScope = hashVersion >= CURRENT_SELECTION_HASH_VERSION
    ? selection.analyst_scope
    : (mode === "quick" ? "quick" : "core");
  const selectedAnalystIds = hashVersion >= CURRENT_SELECTION_HASH_VERSION
    ? selection.selected_analyst_ids
    : (analystScope === "quick" ? QUICK_TASKS : selection.catalog.core_analyst_ids);
  return {
    selection_id: selection.selection_id,
    selection_receipt: receipt.selection_receipt,
    selection_hash: receipt.selection_hash,
    selection_hash_version: selectionHashVersion(receipt),
    catalog_hash: selection.catalog_hash,
    intent_hash: selection.intent_hash,
    selection_mode: selection.selection_mode,
    council_mode: selection.council_mode || "full",
    // The pace approved at the gate must survive consumption, or the run silently falls back to
    // the default and the approved tier is lost with nothing in the record showing the switch.
    council_pace: selection.council_pace || null,
    analyst_scope: analystScope,
    selected_analyst_ids: [...selectedAnalystIds],
    selected_analyst_count: selectedAnalystIds.length,
    all_master_count: selection.catalog.count,
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
