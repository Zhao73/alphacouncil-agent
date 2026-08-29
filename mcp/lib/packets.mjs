import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { LIMITS, MASTER_STANCES, RATINGS, SUPPLEMENTAL_ANALYST_TASKS as SUPPLEMENTAL_ANALYST_TASK_IDS } from "./constants.mjs";
import { workerExecutionFailureKind } from "./codex.mjs";
// A worker returning a malformed packet is a client contract violation, not a server bug:
// these three checks used to raise -32603 while the equivalent checks in the orchestrator
// correctly raised -32602.
import { invalidParams } from "./errors.mjs";
import { isChineseLanguage, languageKey, localized } from "./lang.mjs";
import {
  composeVoiceStatement,
  FIRST_PERSON_DISCLOSURE_ACK,
  FIRST_PERSON_VOICE_MODE,
  hasAnyFirstPersonMarker,
  intentsForStance,
  isIntentAllowed,
  VOICE_FIELDS,
  voiceDisclaimer,
} from "./voice.mjs";
import { cleanLog, clip } from "./text.mjs";
import { scopedSourceId, sourceManifest } from "./gates.mjs";
import { runPath } from "./run-store.mjs";
import { packetSummary } from "./markdown.mjs";
import { parseJsonTransport, parseJsonTransportCandidates } from "./bounded-json.mjs";
import { assertRuntimeWorkerPayload } from "./runtime-validation.mjs";
import { canonicalJson } from "./personas-v3/canonical.mjs";
import {
  assertCompanyDossierAck,
  assertCompanyDossierPacketAcks,
  companyDossierDecisionProjectionSourceScope,
  normalizeCompanyCoverageItems,
  requiresOperatingCompanyDossier,
} from "./company-dossier.mjs";
import { normalizeCompanySourceAcquisitionLedger } from "./company-source-acquisition.mjs";
import {
  allEvidenceClaims,
  assertVerificationFindingsAck,
  hardVerificationFindings,
} from "./verification.mjs";
import {
  assertPmRatingBasis,
  pmRatingReferenceCurrency,
  pmRatingReferencePrice,
} from "./pm-rating-rubric.mjs";
import { managerDecisionNestedSourceIds } from "./manager-report.mjs";
import {
  containsProtectedRatingAuthority,
  protectedRatingAuthorityOccurrences,
  readerVisibleTextCandidates,
  sanitizeReaderInline,
  sanitizeUntrustedMarkdown,
} from "./reader-prose.mjs";

export function bindMachineCheckedRatingBasisMarkdown(markdown, ratingBasis, rating, language, {
  serverRendered = false,
} = {}) {
  if (!ratingBasis || typeof markdown !== "string") return markdown;
  const copy = localized(language, {
    zh: {
      heading: "服务端校验的评级依据",
      authority: "以下字段已经过服务端契约校验；若后续模型撰写正文与之冲突，以本节为准，冲突正文不具权威性。",
      rating: "最终评级", horizon: "期限（月）", formula: "回报公式", reference: "冻结参考价", target: "基准情景目标价", income: "收益回报", base: "基准情景总回报", raw: "收益档位原始评级",
      adjustment: "风险调整", sources: "评级依据来源", adjustmentSources: "调整来源", adjustmentContexts: "调整上下文",
    },
    en: {
      heading: "Server-Validated Rating Basis",
      authority: "These fields passed the server contract. If later model-authored prose conflicts with them, this section governs and the conflicting prose is non-authoritative.",
      rating: "Final rating", horizon: "Horizon (months)", formula: "Return formula", reference: "Frozen reference price", target: "Base-case price target", income: "Income return", base: "Base-case total return", raw: "Raw return-band rating",
      adjustment: "Risk adjustment", sources: "Rating-basis sources", adjustmentSources: "Adjustment sources", adjustmentContexts: "Adjustment contexts",
    },
    ja: {
      heading: "サーバー検証済み評価根拠", authority: "以下の項目はサーバー契約で検証済みです。後続のモデル作成本文と矛盾する場合は本節を正とします。",
      rating: "最終評価", horizon: "期間（月）", formula: "収益率の式", reference: "凍結基準価格", target: "ベースケース目標価格", income: "インカム収益率", base: "ベースケース総収益率", raw: "収益帯の基礎評価",
      adjustment: "リスク調整", sources: "評価根拠の出典", adjustmentSources: "調整根拠", adjustmentContexts: "調整コンテキスト",
    },
    ko: {
      heading: "서버 검증 등급 근거", authority: "다음 필드는 서버 계약 검증을 통과했습니다. 뒤의 모델 작성 본문과 충돌하면 이 절이 우선합니다.",
      rating: "최종 등급", horizon: "기간(개월)", formula: "수익률 공식", reference: "동결 기준가격", target: "기본 시나리오 목표가격", income: "인컴 수익률", base: "기본 시나리오 총수익률", raw: "수익률 구간 원등급",
      adjustment: "위험 조정", sources: "등급 근거 출처", adjustmentSources: "조정 출처", adjustmentContexts: "조정 컨텍스트",
    },
  });
  const forgedAuthority = protectedRatingAuthorityOccurrences(markdown);
  if (containsProtectedRatingAuthority(markdown)) {
    throw invalidParams("portfolio_manager attempted to author a server-owned rating authority claim", {
      reason: "PM_SERVER_RATING_AUTHORITY_SPOOF",
      ...forgedAuthority,
      authority_claim_detected: true,
    });
  }
  // Raw HTML and pre-encoded entities are model-controlled. Escape them before retaining the
  // authored Markdown structure, so a hidden span, quoted `>` or unterminated comment cannot
  // change which words/headings the reader sees after the server-owned block is prepended.
  const safeMarkdown = serverRendered ? markdown : sanitizeUntrustedMarkdown(markdown);
  const ids = (values) => (values || [])
    .map((id) => `\`${sanitizeReaderInline(id).replaceAll("`", "")}\``).join(", ") || "none";
  // adjustment_reason is model-authored. Flatten it before placing it inside the trusted
  // authority block so a newline, heading or fenced block cannot forge a second server section.
  const adjustmentReasonRaw = clip(ratingBasis.adjustment_reason, 500);
  if (containsProtectedRatingAuthority(adjustmentReasonRaw)) {
    throw invalidParams("portfolio_manager attempted to place a server-owned authority claim inside rating adjustment prose", {
      reason: "PM_RATING_ADJUSTMENT_AUTHORITY_SPOOF",
    });
  }
  const adjustmentReason = sanitizeReaderInline(adjustmentReasonRaw);
  const adjustment = ratingBasis.risk_adjustment === "downgrade_one_notch"
    ? `${ratingBasis.risk_adjustment} — ${adjustmentReason} (${copy.adjustmentSources}: ${ids(ratingBasis.adjustment_source_ids)}; ${copy.adjustmentContexts}: ${ids(ratingBasis.adjustment_context_ids)})`
    : ratingBasis.risk_adjustment;
  const block = [
    `## ${copy.heading}`,
    copy.authority,
    `- ${copy.rating}: ${rating}`,
    `- ${copy.horizon}: ${ratingBasis.horizon_months}`,
    `- ${copy.formula}: ${ratingBasis.return_formula_id}`,
    `- ${copy.reference}: ${ratingBasis.reference_price} ${ratingBasis.price_currency}`,
    `- ${copy.target}: ${ratingBasis.base_case_price_target} ${ratingBasis.price_currency}`,
    `- ${copy.income}: ${ratingBasis.income_return_pct}%`,
    `- ${copy.base}: ${ratingBasis.base_case_total_return_pct}%`,
    `- ${copy.raw}: ${ratingBasis.raw_rating}`,
    `- ${copy.adjustment}: ${adjustment}`,
    `- ${copy.sources}: ${ids(ratingBasis.source_ids)}`,
  ].join("\n");
  return `${block}\n\n${safeMarkdown}`;
}

export function rawRecordText(packet) {
  if (typeof packet?.raw_text === "string" && packet.raw_text.trim()) return packet.raw_text;
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) return JSON.stringify(packet || {}, null, 2);
  const { raw_text, ...withoutRawText } = packet;
  return JSON.stringify(withoutRawText, null, 2);
}

export function extractJson(text) {
  return parseJsonTransport(text).value;
}

const SUPPLEMENTAL_ANALYST_TASKS = new Set(SUPPLEMENTAL_ANALYST_TASK_IDS);

function normalizeNullableCoverageTransport(kind, payload, { task = null } = {}) {
  if (!["evidence", "news_evidence"].includes(kind)
    || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  // These three all-scope seats add context but own none of the operating-company dossier's
  // 52 acquisition routes. Drop model-invented coverage summaries before schema validation;
  // their sourced claims remain intact, while mandatory core coverage cannot use this path.
  let result = SUPPLEMENTAL_ANALYST_TASKS.has(task)
    ? Object.fromEntries(Object.entries(payload).filter(([key]) => !["coverage_items", "acquisition_ledger"].includes(key)))
    : payload;
  if (Array.isArray(result.coverage_items)) {
    result = {
      ...result,
      coverage_items: result.coverage_items.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const normalized = { ...item };
      // The acquisition ledger and the coverage summary describe the same frozen route with
      // deliberately different field names. Segmented workers can copy the ledger spelling
      // (`coverage_id`/`outcome`) into coverage_items. Normalize only that exact, lossless alias;
      // later dossier and acquisition gates still verify the ID, disposition and source set.
      if ((normalized.id === undefined || normalized.id === null || normalized.id === "")
        && typeof normalized.coverage_id === "string" && normalized.coverage_id.trim()) {
        normalized.id = normalized.coverage_id.trim();
      }
      if ((normalized.status === undefined || normalized.status === null || normalized.status === "")
        && typeof normalized.outcome === "string") {
        normalized.status = ({
          reported_actual: "covered",
          recomputed_proxy: "covered",
          modeled_estimate: "covered",
          unavailable: "unavailable",
          not_applicable: "not_applicable",
        })[normalized.outcome] || normalized.status;
      }
      const copiedAttempts = Array.isArray(normalized.attempted)
        ? normalized.attempted
        : Array.isArray(normalized.attempts) ? normalized.attempts : [];
      if (typeof normalized.attempted !== "string") {
        normalized.attempted = copiedAttempts.flatMap((attempt) => {
          if (typeof attempt === "string" && attempt.trim()) return [attempt.trim()];
          if (attempt && typeof attempt === "object" && typeof attempt.note === "string" && attempt.note.trim()) {
            return [attempt.note.trim()];
          }
          return [];
        }).join("; ");
      }
      if (!Array.isArray(normalized.attempted_urls) || normalized.attempted_urls.length === 0) {
        normalized.attempted_urls = copiedAttempts.flatMap((attempt) => (
          attempt && typeof attempt === "object" && attempt.locator_type === "url"
            && typeof attempt.locator === "string" ? [attempt.locator] : []
        ));
      }
      if ((normalized.gap === undefined || normalized.gap === null || normalized.gap === "")
        && typeof normalized.reason === "string" && normalized.reason.trim()) {
        normalized.gap = normalized.reason.trim();
      }
      // These fields are optional for `covered`, and models commonly serialize an unused
      // value as null. Turning only null/undefined into the schema's empty value is a lossless
      // transport normalization; it never fills a required unavailable-data gap or source.
      for (const field of ["note", "attempted", "gap"]) {
        if (normalized[field] == null) normalized[field] = "";
      }
      for (const field of ["source_ids", "attempted_urls"]) {
        if (normalized[field] == null) normalized[field] = [];
      }
      if (Array.isArray(normalized.attempted_urls)) {
        // `local:` and `derive:` are acquisition-ledger locators, never web retrieval URLs.
        // Workers sometimes copy them into coverage_items.attempted_urls alongside real URLs.
        // Drop only non-HTTP transport noise before the strict runtime schema. If an unavailable
        // row is left without a real attempted URL, the later company-coverage gate still fails
        // closed; this normalization cannot manufacture evidence or satisfy that requirement.
        normalized.attempted_urls = [...new Set(normalized.attempted_urls.flatMap((candidate) => {
          if (typeof candidate !== "string") return [];
          const value = candidate.trim();
          try {
            const parsed = new URL(value);
            return ["http:", "https:"].includes(parsed.protocol) ? [value] : [];
          } catch {
            return [];
          }
        }))];
      }
      return normalized;
      }),
    };
    const questions = Array.isArray(result.open_questions) ? [...result.open_questions] : [];
    for (const item of result.coverage_items) {
      const gap = item?.status === "unavailable" && typeof item?.gap === "string"
        ? item.gap.trim()
        : "";
      if (gap && !questions.includes(gap)) questions.push(gap);
    }
    if (questions.length !== (result.open_questions || []).length) {
      // The company-dossier contract requires byte-identical mirroring. The gap already came
      // from the worker's unavailable coverage row; copying it into open_questions adds no fact
      // and prevents a purely representational omission from consuming another model call.
      result = { ...result, open_questions: questions };
    }
    const coveredSourceIds = new Set(result.coverage_items
      .filter((item) => item?.status === "covered")
      .flatMap((item) => Array.isArray(item?.source_ids) ? item.source_ids : [])
      .filter((id) => typeof id === "string" && id.trim()));
    if (Array.isArray(result.sources) && coveredSourceIds.size) {
      result = {
        ...result,
        sources: result.sources.map((source) => {
          if (!source || typeof source !== "object" || Array.isArray(source)
            || !coveredSourceIds.has(source.id)) return source;
          const publishedAt = Date.parse(String(source.published_at || ""));
          const observedAt = source.observed_at || source.retrieved_at;
          if (Number.isFinite(publishedAt) || !Number.isFinite(Date.parse(String(observedAt || "")))) return source;
          let dynamicSurface = false;
          try {
            const url = new URL(String(source.url || ""));
            const path = url.pathname.replace(/\/+$/u, "") || "/";
            dynamicSurface = path === "/"
              || /\/(?:overview|quote|chart|statistics|market-data|stock-information|investor-relations|financials|filings|submissions)(?:\/|\.|$)/iu.test(path);
          } catch {
            return source;
          }
          if (!dynamicSurface) return source;
          // A homepage, quote, market table or filing index is a live surface rather than an
          // undated article. Bind its already-supplied retrieval timestamp as the observation
          // timestamp; deep undated article URLs are deliberately left untouched and fail closed.
          return {
            ...source,
            source_kind: "dynamic_snapshot",
            observed_at: observedAt,
          };
        }),
      };
    }
  }

  const explicitGap = /\b(?:unavailable|unknown|not\s+(?:available|found|disclosed|obtainable)|could\s+not\s+(?:find|obtain|verify))\b|(?:不可得|不可用|无法(?:取得|获得|核验|确认|计算)|未(?:找到|取得|获得|披露|检得)|暂无|未知|缺少)/iu;
  const claims = Array.isArray(result.claims) ? result.claims : null;
  if (claims) {
    const unsupportedGaps = claims.filter((claim) => (
      claim && typeof claim === "object" && !Array.isArray(claim)
      && Array.isArray(claim.source_ids) && claim.source_ids.length === 0
      && explicitGap.test(`${claim.claim || ""}\n${claim.evidence || ""}`)
    ));
    if (unsupportedGaps.length) {
      const questions = Array.isArray(result.open_questions) ? [...result.open_questions] : [];
      for (const claim of unsupportedGaps) {
        const gap = [claim.claim, claim.evidence].filter((value) => typeof value === "string" && value.trim()).join(" ");
        if (gap && !questions.includes(gap)) questions.push(gap);
      }
      const unsupported = new Set(unsupportedGaps);
      result = {
        ...result,
        // An explicitly unavailable statement with no citation is a gap, not evidence. Preserve
        // its prose in open_questions and remove only the unsupported claim. Positive or
        // ambiguous unsourced claims remain untouched and still fail the strict provenance gate.
        claims: claims.filter((claim) => !unsupported.has(claim)),
        open_questions: questions,
      };
    }
  }
  return result;
}

function validateStageWorkerCandidate(value, kind, context = {}) {
  return assertRuntimeWorkerPayload(
    kind,
    normalizeNullableCoverageTransport(kind, value, context),
  );
}

function decodeSegmentedEvidenceEnvelope(value) {
  const segment = (name) => parseJsonTransport(value[name]).value;
  const coverageItems = segment("coverage_items_json");
  const acquisitionLedger = segment("acquisition_ledger_json");
  const officialSourceCoverage = segment("official_source_coverage_json");
  return {
    summary: value.summary,
    claims: segment("claims_json"),
    metrics: segment("metrics_json"),
    sources: segment("sources_json"),
    open_questions: segment("open_questions_json"),
    ...(coverageItems !== null ? { coverage_items: coverageItems } : {}),
    ...(acquisitionLedger !== null ? { acquisition_ledger: acquisitionLedger } : {}),
    ...(officialSourceCoverage !== null ? { official_source_coverage: officialSourceCoverage } : {}),
    confidence: value.confidence,
    information_richness: value.information_richness,
  };
}

function validatedWorkerCandidate(value, kind, context = {}) {
  if (["evidence", "news_evidence"].includes(kind)
    && objectRecord(value)
    && value.transport === "segmented_evidence_v1") {
    return validateStageWorkerCandidate(decodeSegmentedEvidenceEnvelope(value), kind, context);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 1
    || typeof value.packet_json !== "string") {
    return validateStageWorkerCandidate(value, kind, context);
  }
  // The API-enforced outer envelope guarantees one transport root while allowing the inner
  // stage packet to retain dynamic metric and acquisition objects that strict Structured
  // Outputs cannot describe with additionalProperties=false.
  try {
    return validateStageWorkerCandidate(parseJsonTransport(value.packet_json).value, kind, context);
  } catch (error) {
    if (error?.data?.reason !== "WORKER_JSON_MULTIPLE_VALUES") throw error;
    const valid = [];
    for (const candidate of parseJsonTransportCandidates(value.packet_json)) {
      try {
        valid.push(validateStageWorkerCandidate(candidate, kind, context));
      } catch (candidateError) {
        if (candidateError?.data?.reason !== "WORKER_OUTPUT_SCHEMA_MISMATCH") throw candidateError;
      }
    }
    const distinct = new Map(valid.map((candidate) => [canonicalJson(candidate), candidate]));
    if (distinct.size === 1) return distinct.values().next().value;
    // Two materially different valid packets remain ambiguous and fail closed. One valid packet
    // beside a diagnostic root, or byte-equivalent duplicate packets, is only envelope noise.
    throw error;
  }
}

export function extractWorkerJson(text, kind, context = {}) {
  return validatedWorkerCandidate(extractJson(text), kind, context);
}

/**
 * Decode only the outer worker transport without accepting it as valid evidence.
 *
 * This is intentionally narrow: callers may inspect an invalid primary response for an
 * immutable provenance baseline, but must still use extractWorkerJson before publishing it.
 */
export function extractUnvalidatedWorkerJson(text) {
  const value = extractJson(text);
  if (objectRecord(value) && value.transport === "segmented_evidence_v1") {
    return decodeSegmentedEvidenceEnvelope(value);
  }
  if (objectRecord(value)
    && Object.keys(value).length === 1
    && typeof value.packet_json === "string") {
    return parseJsonTransport(value.packet_json).value;
  }
  return value;
}

/**
 * A parse-only repair worker may accidentally append a diagnostic JSON object to the repaired
 * packet. Accept a result only when runtime-schema validation leaves exactly one distinct
 * contract-valid value; two different valid packets and any truncated extra root stay
 * ambiguous and fail closed. Initial workers never use this arbiter.
 */
export function extractRepairedWorkerJson(text, kind, context = {}) {
  try {
    return extractWorkerJson(text, kind, context);
  } catch (error) {
    if (error?.data?.reason !== "WORKER_JSON_MULTIPLE_VALUES") throw error;
    let candidates;
    try {
      candidates = parseJsonTransportCandidates(text);
    } catch {
      throw error;
    }
    const valid = [];
    for (const candidate of candidates) {
      try {
        // Candidate arbitration must use the same lossless transport normalization as the
        // ordinary single-root path. Otherwise one valid evidence packet with optional
        // coverage fields serialized as null is incorrectly discarded beside a diagnostic
        // root, and the repair fails even though exactly one contract-valid value exists.
        valid.push(validatedWorkerCandidate(candidate, kind, context));
      } catch (candidateError) {
        if (candidateError?.data?.reason !== "WORKER_OUTPUT_SCHEMA_MISMATCH") {
          throw candidateError;
        }
        // A non-contract JSON diagnostic is transport noise, not a competing packet.
      }
    }
    const distinct = new Map(valid.map((candidate) => [canonicalJson(candidate), candidate]));
    if (distinct.size === 1) return distinct.values().next().value;
    throw error;
  }
}

function sourceIdList(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    : [];
}

const NEWS_TASK = "news_industry_management";
const OFFICIAL_SOURCE_COVERAGE_SCHEMA_ID = "news-official-source-coverage-v1";
const COVERAGE_STATUSES = new Set(["complete", "incomplete"]);
const NEWS_CLAIM_TYPES = new Set(["event_or_observation", "absence_no_event"]);
const NO_EVENT_CONCLUSION_PATTERNS = [
  /\b(?:there\s+(?:is|are|was|were)|we\s+(?:found|identified))\s+no\b.{0,48}\b(?:news|event|filing|announcement|executive|management|change|update)s?\b/iu,
  /\bno\s+(?:recent|new|material|official)?\s*(?:news|event|filing|announcement|executive|management|change|update)s?\b/iu,
  /(?:没有|未发现|并无|不存在|无)(?:任何|近期|新的|重大|官方)?(?:新闻|事件|公告|申报|高管变动|管理层变化|更新)/u,
  /(?:最近|新たな|重大な)?(?:ニュース|発表|提出|経営陣の変更|更新).{0,16}(?:ない|なし|見当たらない)/u,
  /(?:최근|새로운|중대한|공식)?(?:뉴스|발표|공시|경영진 변경|업데이트).{0,16}(?:없|않)/u,
];

function looksLikeNoEventConclusion(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return Boolean(text) && NO_EVENT_CONCLUSION_PATTERNS.some((pattern) => pattern.test(text));
}

function normalizedNewsClaimType(claim) {
  // Obvious absence language wins over a worker-supplied label. The model cannot bypass an
  // incomplete official-source gate by calling "no recent official news" an observation.
  if (looksLikeNoEventConclusion(claim?.claim)) return "absence_no_event";
  return NEWS_CLAIM_TYPES.has(claim?.claim_type) ? claim.claim_type : claim?.claim_type;
}

function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mappedCoverageSourceId(value, task, sourceIdMap) {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw ? (sourceIdMap.get(raw) || scopedSourceId(task, raw)) : "";
}

function normalizeCoverageItem(value, task, sourceIdMap) {
  if (!objectRecord(value)) return value;
  return {
    title: typeof value.title === "string" ? value.title.trim() : value.title,
    published_at: typeof value.published_at === "string" ? value.published_at.trim() : value.published_at,
    url: typeof value.url === "string" ? value.url.trim() : value.url,
    source_id: mappedCoverageSourceId(value.source_id, task, sourceIdMap),
    ...(value.record_id !== undefined
      ? { record_id: typeof value.record_id === "string" ? value.record_id.trim() : value.record_id }
      : {}),
  };
}

function normalizeCoverageSurface(value, task, sourceIdMap) {
  if (!objectRecord(value)) return value;
  return {
    status: typeof value.status === "string" ? value.status.trim() : value.status,
    entry_url: typeof value.entry_url === "string" ? value.entry_url.trim() : value.entry_url ?? null,
    checked_through: typeof value.checked_through === "string" ? value.checked_through.trim() : value.checked_through ?? null,
    latest_dated_item: value.latest_dated_item == null
      ? null
      : normalizeCoverageItem(value.latest_dated_item, task, sourceIdMap),
    dated_items_checked: Array.isArray(value.dated_items_checked)
      ? value.dated_items_checked.map((item) => normalizeCoverageItem(item, task, sourceIdMap))
      : value.dated_items_checked,
    gap: typeof value.gap === "string" ? value.gap.trim() : value.gap ?? null,
  };
}

function packetIssuerCoverageSurface(surface, sources, asOfDate) {
  if (!objectRecord(surface)
    || surface.status !== "complete"
    || !normalizedHttpUrl(surface.entry_url)
    || !exactIsoDay(asOfDate)) return surface;
  const items = [];
  const seen = new Set();
  for (const source of sources || []) {
    const sourceUrl = normalizedHttpUrl(source?.url);
    const day = isoDay(source?.published_at);
    if (!sourceUrl || !day || day > asOfDate || !commonSiteHost(surface.entry_url, sourceUrl)) continue;
    const key = `${source.id}\u0000${sourceUrl}\u0000${day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      title: source.title,
      published_at: source.published_at,
      url: source.url,
      source_id: source.id,
    });
  }
  if (items.length === 0) return surface;
  const latest = [...items].sort((left, right) => (
    parsedInstant(right.published_at) - parsedInstant(left.published_at)
  ))[0];
  return {
    ...surface,
    // Bind the worker's coverage declaration to the packet-local issuer inventory. This drops
    // regulator/media URLs accidentally copied into the issuer list and selects the true latest
    // dated issuer item without inventing a source, URL or publication date.
    latest_dated_item: { ...latest },
    dated_items_checked: items,
  };
}

function normalizeOfficialSourceCoverage(value, task, sourceIdMap, sources, asOfDate) {
  if (!objectRecord(value)) return value;
  const issuer = normalizeCoverageSurface(value.issuer, task, sourceIdMap);
  return {
    status: typeof value.status === "string" ? value.status.trim() : value.status,
    regulator: normalizeCoverageSurface(value.regulator, task, sourceIdMap),
    issuer: packetIssuerCoverageSurface(issuer, sources, asOfDate),
  };
}

function coverageGapQuestions(coverage) {
  if (!objectRecord(coverage)) return [];
  return [coverage.regulator, coverage.issuer]
    .filter((surface) => objectRecord(surface) && surface.status === "incomplete")
    .map((surface) => typeof surface.gap === "string" ? surface.gap.trim() : "")
    .filter(Boolean);
}

function packetRequiredGapQuestions(packet) {
  const coverageItemGaps = (Array.isArray(packet?.coverage_items) ? packet.coverage_items : [])
    .filter((item) => item?.status === "unavailable")
    .map((item) => typeof item?.gap === "string" ? item.gap.trim() : "")
    .filter(Boolean);
  return new Set([
    ...coverageGapQuestions(packet?.official_source_coverage),
    ...coverageItemGaps,
  ]);
}

function coverageSourceIds(coverage) {
  if (!objectRecord(coverage)) return [];
  return sourceIdList([coverage.regulator, coverage.issuer].flatMap((surface) => {
    if (!objectRecord(surface)) return [];
    return [
      surface.latest_dated_item?.source_id,
      ...(Array.isArray(surface.dated_items_checked)
        ? surface.dated_items_checked.map((item) => item?.source_id)
        : []),
    ];
  }));
}

/**
 * Bind the US regulator surface to the SEC feed already fetched deterministically during
 * grounding. A model should not have to rediscover or copy this URL inventory perfectly, and a
 * parse-only repair cannot invent a missing primary-document source. The issuer surface remains
 * wholly worker-supplied and fail-closed; this adapter only materializes facts the server already
 * fetched before the worker started.
 */
export function applyGroundedRegulatorCoverage(packet, {
  task = packet?.task,
  asOfDate = packet?.as_of,
  grounding = null,
} = {}) {
  if (task !== NEWS_TASK || !objectRecord(packet?.official_source_coverage)) return packet;
  const coverage = packet.official_source_coverage;
  if (!objectRecord(coverage.regulator) || !objectRecord(coverage.issuer)) return packet;
  const filer = grounding?.filer;
  const expected = filer?.latest_filing;
  const entryUrl = normalizedHttpUrl(filer?.submissions_url);
  const itemUrl = normalizedHttpUrl(expected?.primary_document_url);
  const publishedAt = typeof expected?.filing_date === "string" ? expected.filing_date : null;
  if (!entryUrl || !itemUrl || !exactIsoDay(publishedAt) || !exactIsoDay(asOfDate)) return packet;
  // Real grounding always records gathered_at. Synthetic/dry-run fixtures predating that
  // field are bounded by their declared as_of; they cannot bypass the separate councilAsOf
  // future-date rejection at the execution boundary.
  const retrievedThrough = grounding?.gathered_at ? isoDay(grounding.gathered_at) : asOfDate;

  packet.sources = Array.isArray(packet.sources) ? packet.sources : [];
  let source = packet.sources.find((candidate) => (
    normalizedHttpUrl(candidate?.url) === itemUrl && isoDay(candidate?.published_at) === publishedAt
  ));
  if (!source) {
    const baseId = scopedSourceId(task, "GROUNDED_REGULATOR_LATEST");
    let sourceId = baseId;
    let suffix = 2;
    const used = new Set(packet.sources.map((candidate) => candidate?.id));
    while (used.has(sourceId)) {
      sourceId = `${baseId}_${suffix}`;
      suffix += 1;
    }
    source = {
      id: sourceId,
      title: `SEC ${expected.form || "filing"} ${expected.accession || publishedAt}`,
      url: expected.primary_document_url,
      published_at: publishedAt,
      retrieved_at: grounding?.gathered_at || asOfDate,
    };
    packet.sources.push(source);
  }
  const item = {
    title: source.title,
    published_at: publishedAt,
    url: expected.primary_document_url,
    source_id: source.id,
    ...(expected.accession ? { record_id: expected.accession } : {}),
  };
  const priorGap = typeof coverage.regulator.gap === "string" ? coverage.regulator.gap.trim() : "";
  if (!retrievedThrough || asOfDate > retrievedThrough) {
    const gap = retrievedThrough
      ? `SEC official surface was retrieved through ${retrievedThrough} and cannot certify the future cutoff ${asOfDate}`
      : `SEC official surface has no valid retrieval timestamp and cannot certify cutoff ${asOfDate}`;
    coverage.regulator = {
      status: "incomplete",
      entry_url: filer.submissions_url,
      checked_through: retrievedThrough,
      latest_dated_item: item,
      dated_items_checked: [item],
      gap,
    };
    coverage.status = "incomplete";
    packet.open_questions = Array.isArray(packet.open_questions) ? packet.open_questions : [];
    if (!packet.open_questions.includes(gap)) packet.open_questions.push(gap);
    return packet;
  }
  coverage.regulator = {
    status: "complete",
    entry_url: filer.submissions_url,
    checked_through: asOfDate,
    latest_dated_item: item,
    dated_items_checked: [item],
    gap: null,
  };
  coverage.status = coverage.issuer.status === "complete" ? "complete" : "incomplete";
  if (priorGap && Array.isArray(packet.open_questions)) {
    // Completing the server-owned SEC surface retires only that surface's question. The same
    // byte-identical gap may still be owned by an unavailable company-coverage row (for
    // example, the filing timeline is known but the primary Form 4 body could not be read), or
    // by the issuer surface. Removing it in that case makes an otherwise valid packet fail the
    // dossier contract and wastes the remaining lifecycle on a model repair that cannot add
    // any evidence. Preserve every gap that another current contract surface still requires.
    if (!packetRequiredGapQuestions(packet).has(priorGap)) {
      packet.open_questions = packet.open_questions.filter((question) => question !== priorGap);
    }
  }
  return packet;
}

function parsedInstant(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().toLowerCase() === "unknown") return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

function isoDay(value) {
  const instant = parsedInstant(value);
  return instant === null ? null : new Date(instant).toISOString().slice(0, 10);
}

function exactIsoDay(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && isoDay(value) === value;
}

function normalizedHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) return null;
    parsed.hash = "";
    return parsed.href.replace(/\/$/u, "");
  } catch {
    return null;
  }
}

function hostname(value) {
  const normalized = normalizedHttpUrl(value);
  return normalized ? new URL(normalized).hostname.toLowerCase() : null;
}

function commonSiteHost(first, second) {
  const left = hostname(first);
  const right = hostname(second);
  if (!left || !right) return false;
  if (left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`)) return true;
  const siteKey = (host) => {
    const parts = host.split(".");
    const commonSecondLevel = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);
    const length = parts.at(-1)?.length === 2 && commonSecondLevel.has(parts.at(-2)) ? 3 : 2;
    return parts.length >= length ? parts.slice(-length).join(".") : host;
  };
  return siteKey(left) === siteKey(right);
}

function coverageIssue(errors, path, keyword, message, missingProperty) {
  errors.push({
    path,
    keyword,
    message,
    ...(missingProperty ? { missing_property: missingProperty } : {}),
  });
}

function validateCoverageItem(item, path, context, errors) {
  if (!objectRecord(item)) {
    coverageIssue(errors, path, "type", "must be an object");
    return null;
  }
  for (const field of ["title", "published_at", "url", "source_id"]) {
    if (typeof item[field] !== "string" || !item[field].trim()) {
      coverageIssue(errors, path, "required", `${field} must be a non-empty string`, field);
    }
  }
  const published = parsedInstant(item.published_at);
  if (published === null) coverageIssue(errors, `${path}/published_at`, "format", "must be a dated value, never unknown");
  else if (published > context.asOfEnd) coverageIssue(errors, `${path}/published_at`, "point_in_time", "must not be after as_of");
  const itemUrl = normalizedHttpUrl(item.url);
  if (!itemUrl) coverageIssue(errors, `${path}/url`, "format", "must be an absolute http(s) URL");
  else if (context.entryUrl && !commonSiteHost(context.entryUrl, item.url)) {
    coverageIssue(errors, `${path}/url`, "official_host", "must be on the same official site as entry_url");
  }
  const source = context.sourceById.get(item.source_id);
  if (!source) {
    coverageIssue(errors, `${path}/source_id`, "source_resolution", "must resolve to packet.sources");
  } else {
    const sourceUrl = normalizedHttpUrl(source.url);
    if (itemUrl && sourceUrl !== itemUrl) {
      coverageIssue(errors, `${path}/url`, "source_alignment", "must equal the resolved source URL");
    }
    if (isoDay(source.published_at) !== isoDay(item.published_at)) {
      coverageIssue(errors, `${path}/published_at`, "source_alignment", "must match the resolved source publication date");
    }
  }
  return published;
}

function validateCoverageSurface(name, surface, context, errors) {
  const path = `/official_source_coverage/${name}`;
  if (!objectRecord(surface)) {
    coverageIssue(errors, path, "required", "must be an object", name);
    return;
  }
  if (!COVERAGE_STATUSES.has(surface.status)) {
    coverageIssue(errors, `${path}/status`, "enum", "must be complete or incomplete");
  }
  const entryUrl = normalizedHttpUrl(surface.entry_url);
  if (surface.status === "complete" && !entryUrl) {
    coverageIssue(errors, `${path}/entry_url`, "format", "complete coverage requires an absolute http(s) entry URL");
  } else if (surface.entry_url != null && !entryUrl) {
    coverageIssue(errors, `${path}/entry_url`, "format", "must be null or an absolute http(s) URL");
  }
  if (surface.status === "complete" && surface.checked_through !== context.asOfDate) {
    coverageIssue(errors, `${path}/checked_through`, "coverage_cutoff", "complete coverage must be checked through as_of exactly");
  } else if (surface.checked_through != null) {
    if (!exactIsoDay(surface.checked_through)) {
      coverageIssue(errors, `${path}/checked_through`, "format", "must be a valid YYYY-MM-DD date or null");
    } else if (surface.checked_through > context.asOfDate) {
      coverageIssue(errors, `${path}/checked_through`, "point_in_time", "must not be after as_of");
    }
  }
  if (surface.status === "complete" && (!context.retrievedThroughDay || surface.checked_through > context.retrievedThroughDay)) {
    coverageIssue(
      errors,
      `${path}/checked_through`,
      "retrieval_cutoff",
      context.retrievedThroughDay
        ? `complete coverage cannot extend beyond actual retrieval day ${context.retrievedThroughDay}`
        : "complete coverage requires a valid grounding retrieval timestamp",
    );
  }
  if (surface.status === "incomplete" && (typeof surface.gap !== "string" || !surface.gap.trim())) {
    coverageIssue(errors, `${path}/gap`, "required", "incomplete coverage requires a non-empty gap", "gap");
  }
  if (surface.status === "complete" && typeof surface.gap === "string" && surface.gap.trim()) {
    coverageIssue(errors, `${path}/gap`, "consistency", "complete coverage cannot also declare a gap");
  }
  if (!Array.isArray(surface.dated_items_checked)) {
    coverageIssue(errors, `${path}/dated_items_checked`, "type", "must be an array");
    return;
  }
  if (surface.status === "complete" && surface.dated_items_checked.length === 0) {
    coverageIssue(errors, `${path}/dated_items_checked`, "minItems", "complete coverage requires at least one dated official item");
  }
  const itemContext = { ...context, entryUrl };
  const dated = surface.dated_items_checked.map((item, index) => ({
    item,
    instant: validateCoverageItem(item, `${path}/dated_items_checked/${index}`, itemContext, errors),
  }));
  if (surface.latest_dated_item == null) {
    if (surface.status === "complete") {
      coverageIssue(errors, `${path}/latest_dated_item`, "required", "complete coverage requires the latest dated item", "latest_dated_item");
    }
    return;
  }
  const latestInstant = validateCoverageItem(surface.latest_dated_item, `${path}/latest_dated_item`, itemContext, errors);
  const latestDay = isoDay(surface.latest_dated_item.published_at);
  const observedDays = dated.map(({ item }) => isoDay(item?.published_at)).filter(Boolean).sort();
  const maxObservedDay = observedDays.at(-1) || null;
  if (latestDay && maxObservedDay && latestDay !== maxObservedDay) {
    coverageIssue(errors, `${path}/latest_dated_item/published_at`, "latest_item", "must equal the latest publication date in dated_items_checked");
  }
  const officialSourceDays = [...context.sourceById.values()]
    .filter((source) => entryUrl && commonSiteHost(entryUrl, source?.url))
    .map((source) => isoDay(source?.published_at))
    .filter((day) => day && day <= context.asOfDate)
    .sort();
  const maxOfficialSourceDay = officialSourceDays.at(-1) || null;
  if (latestDay && maxOfficialSourceDay && latestDay !== maxOfficialSourceDay) {
    coverageIssue(errors, `${path}/latest_dated_item/published_at`, "source_inventory_latest", "must equal the latest dated packet source on the official site");
  }
  const latestAppearsInChecked = dated.some(({ item }) => objectRecord(item)
    && item.source_id === surface.latest_dated_item.source_id
    && normalizedHttpUrl(item.url) === normalizedHttpUrl(surface.latest_dated_item.url)
    && isoDay(item.published_at) === latestDay);
  if (!latestAppearsInChecked) {
    coverageIssue(errors, `${path}/latest_dated_item`, "containment", "must also appear in dated_items_checked");
  }
  if (latestInstant !== null && latestInstant > context.asOfEnd) {
    coverageIssue(errors, `${path}/latest_dated_item/published_at`, "point_in_time", "must not be after as_of");
  }
}

/**
 * Fail closed when the news seat has not materialized both official surfaces.
 *
 * The model may describe an official-source search in prose, but only this source-linked,
 * cutoff-checked record is allowed to establish that the regulator and issuer newsroom were
 * actually covered. An inaccessible surface is still recorded as an explicit gap, but the
 * packet is rejected before it can influence a rating. This deliberately fails closed: no
 * finite prose classifier can prove that a worker did not disguise an absence conclusion as
 * a positive observation.
 */
export function assertOfficialSourceCoverage(packet, {
  task = packet?.task,
  asOfDate = packet?.as_of,
  grounding = null,
} = {}) {
  if (task !== NEWS_TASK) return packet;
  const errors = [];
  const coverage = packet?.official_source_coverage;
  if (!objectRecord(coverage)) {
    coverageIssue(errors, "/official_source_coverage", "required", "news evidence requires structured official-source coverage", "official_source_coverage");
  }
  if (!exactIsoDay(asOfDate)) {
    coverageIssue(errors, "/as_of", "format", "must be a valid YYYY-MM-DD date");
  }
  const asOfEnd = exactIsoDay(asOfDate) ? Date.parse(`${asOfDate}T23:59:59.999Z`) : Number.NEGATIVE_INFINITY;
  const context = {
    asOfDate,
    asOfEnd,
    retrievedThroughDay: grounding?.gathered_at ? isoDay(grounding.gathered_at) : asOfDate,
    sourceById: new Map((packet?.sources || []).map((source) => [source?.id, source])),
  };
  if (objectRecord(coverage)) {
    if (!COVERAGE_STATUSES.has(coverage.status)) {
      coverageIssue(errors, "/official_source_coverage/status", "enum", "must be complete or incomplete");
    }
    validateCoverageSurface("regulator", coverage.regulator, context, errors);
    validateCoverageSurface("issuer", coverage.issuer, context, errors);
    const derivedStatus = coverage.regulator?.status === "complete" && coverage.issuer?.status === "complete"
      ? "complete"
      : "incomplete";
    if (coverage.status !== derivedStatus) {
      coverageIssue(errors, "/official_source_coverage/status", "consistency", `must be ${derivedStatus} for the two surface statuses`);
    }
    for (const surface of [coverage.regulator, coverage.issuer]) {
      if (surface?.status === "incomplete" && !packet.open_questions?.includes(surface.gap)) {
        coverageIssue(errors, "/open_questions", "explicit_gap", "must include every incomplete official-source coverage gap");
      }
    }
    if (derivedStatus === "incomplete") {
      coverageIssue(
        errors,
        "/official_source_coverage/status",
        "official_coverage_incomplete",
        "both regulator and issuer-official surfaces must be complete before news evidence can enter the council",
      );
    }
    for (const [index, claim] of (packet?.claims || []).entries()) {
      if (!NEWS_CLAIM_TYPES.has(claim?.claim_type)) {
        coverageIssue(errors, `/claims/${index}/claim_type`, "enum", "must be event_or_observation or absence_no_event");
      }
      const absenceConclusion = claim?.claim_type === "absence_no_event"
        || looksLikeNoEventConclusion(claim?.claim);
      if (derivedStatus === "incomplete" && absenceConclusion) {
        coverageIssue(
          errors,
          `/claims/${index}/claim`,
          "absence_claim_requires_complete_coverage",
          "an absence/no-event conclusion requires complete regulator and issuer-official coverage through as_of",
        );
      }
    }
    if (derivedStatus === "incomplete" && looksLikeNoEventConclusion(packet?.summary)) {
      coverageIssue(
        errors,
        "/summary",
        "absence_claim_requires_complete_coverage",
        "a summary absence/no-event conclusion requires complete regulator and issuer-official coverage through as_of",
      );
    }
    const expected = grounding?.filer?.latest_filing;
    if (coverage.regulator?.status === "complete" && objectRecord(expected)) {
      const actual = coverage.regulator.latest_dated_item;
      if (expected.filing_date && isoDay(actual?.published_at) !== isoDay(expected.filing_date)) {
        coverageIssue(errors, "/official_source_coverage/regulator/latest_dated_item/published_at", "grounding_alignment", "must match grounding.filer.latest_filing.filing_date");
      }
      if (expected.accession && actual?.record_id !== expected.accession) {
        coverageIssue(errors, "/official_source_coverage/regulator/latest_dated_item/record_id", "grounding_alignment", "must match grounding.filer.latest_filing.accession");
      }
      if (expected.primary_document_url
        && normalizedHttpUrl(actual?.url) !== normalizedHttpUrl(expected.primary_document_url)) {
        coverageIssue(errors, "/official_source_coverage/regulator/latest_dated_item/url", "grounding_alignment", "must match grounding.filer.latest_filing.primary_document_url");
      }
      if (grounding?.filer?.submissions_url
        && normalizedHttpUrl(coverage.regulator.entry_url) !== normalizedHttpUrl(grounding.filer.submissions_url)) {
        coverageIssue(errors, "/official_source_coverage/regulator/entry_url", "grounding_alignment", "must match grounding.filer.submissions_url");
      }
    }
  }
  if (errors.length) {
    throw invalidParams("news evidence failed the official-source coverage gate", {
      reason: "OFFICIAL_SOURCE_COVERAGE_INVALID",
      schema_id: OFFICIAL_SOURCE_COVERAGE_SCHEMA_ID,
      errors: errors.slice(0, 12),
    });
  }
  return packet;
}

/** Every downstream citation must resolve inside its explicit manifest source domain. */
export function assertSourceIdsResolve(run, sourceIds, owner, {
  allowEmpty = false,
  domain = "evidence",
} = {}) {
  const ids = sourceIdList(sourceIds);
  // Use the same materialized view that is written to source_manifest.json. Reconstructing a
  // second partial manifest here caused valid PersonaPack provenance to fail at runtime even
  // while the saved artifact told a different story.
  const known = new Set(sourceManifest(run).sources
    .filter((source) => source.provenance_domain === domain)
    .map((source) => source.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) {
    throw invalidParams(`${owner} cited source IDs absent from the ${domain} domain of source_manifest.json: ${unknown.join(", ")}`, {
      reason: "SOURCE_PROVENANCE_MISMATCH",
      owner,
      source_domain: domain,
      unknown_source_ids: unknown,
    });
  }
  if (!allowEmpty && ids.length === 0) {
    throw invalidParams(`${owner} must cite at least one ${domain} source_manifest.json ID; missing evidence must be an explicit gap or out_of_scope result.`, {
      reason: "SOURCE_PROVENANCE_REQUIRED",
      owner,
      source_domain: domain,
    });
  }
  return ids;
}

function boundedPacketSourceIds(packet, claimLimit, sourceLimit) {
  const claims = (packet?.claims || []).slice(0, claimLimit);
  const sourceById = new Map((packet?.sources || []).map((source) => [source?.id, source]));
  const selected = [...new Set(claims.flatMap((claim) => claim?.source_ids || []))]
    .filter((id) => sourceById.has(id))
    .slice(0, sourceLimit);
  for (const source of packet?.sources || []) {
    if (selected.length >= sourceLimit) break;
    if (source?.id && !selected.includes(source.id)) selected.push(source.id);
  }
  return selected;
}

/** Evidence IDs actually exposed to a dedicated method voice. */
export function methodVoiceAllowedSourceIds(run, frozenOpinion, { projection = null } = {}) {
  // An operating-company worker receives the bounded, verified dossier projection. The full
  // dossier can contain transport-only sources, while the deterministic fact producer can carry
  // typed provenance IDs that were never rendered into the voice prompt. Neither is citable by
  // that worker. Use only the exact projection source set in this mode.
  if (requiresOperatingCompanyDossier(run)) {
    const allowed = sourceIdList(
      companyDossierDecisionProjectionSourceScope(run, projection).source_ids,
    );
    assertSourceIdsResolve(run, allowed, `${frozenOpinion?.master || "method voice"} allowed projected evidence`, {
      allowEmpty: frozenOpinion?.stance === "out_of_scope",
      domain: "evidence",
    });
    return allowed;
  }
  const quick = run?.council_mode === "quick";
  const packetIds = (run?.packets || []).flatMap((packet) => (
    quick
      ? boundedPacketSourceIds(packet, 4, 6)
      : (packet?.sources || []).map((source) => source?.id).filter(Boolean)
  ));
  const frozenEvidenceIds = frozenOpinion?.evidence_source_ids || frozenOpinion?.source_ids || [];
  const allowed = sourceIdList([...packetIds, ...frozenEvidenceIds]);
  assertSourceIdsResolve(run, allowed, `${frozenOpinion?.master || "method voice"} allowed evidence`, {
    allowEmpty: frozenOpinion?.stance === "out_of_scope",
    domain: "evidence",
  });
  return allowed;
}

function bindSameDayDynamicObservation(source, asOfDate, observationTime) {
  if (!source || typeof source !== "object" || Array.isArray(source)
    || String(source.source_kind || "").trim().toLowerCase() !== "dynamic_snapshot"
    || Number.isFinite(Date.parse(String(source.published_at || "")))) return source;
  const dayStart = Date.parse(`${asOfDate}T00:00:00.000Z`);
  const dayEnd = Date.parse(`${asOfDate}T23:59:59.999Z`);
  const trusted = Date.parse(String(observationTime || ""));
  const supplied = Date.parse(String(source.observed_at || source.retrieved_at || ""));
  if (!Number.isFinite(dayStart) || !Number.isFinite(dayEnd) || !Number.isFinite(trusted)
    || trusted < dayStart || trusted > dayEnd
    || !Number.isFinite(supplied) || supplied <= dayEnd || supplied > dayEnd + 86_400_000) return source;
  // A worker can format the host's next local calendar day even while the server observation is
  // still inside the UTC as_of day (for example, Tokyo after 09:00 UTC). For a dynamic source
  // with no publication date, the server-owned grounding timestamp is the stronger observation
  // fact. Correct only this bounded one-day spill; historical/future leakage remains fail-closed.
  return {
    ...source,
    observed_at: observationTime,
    ...(Number.isFinite(Date.parse(String(source.retrieved_at || "")))
      && Date.parse(String(source.retrieved_at)) > dayEnd
      ? { retrieved_at: observationTime }
      : {}),
  };
}

export function normalizePacket(packet, task, symbol, asOfDate, raw = "", {
  observationTime = null,
} = {}) {
  const sourceIdMap = new Map();
  const suppliedSourceIds = new Set();
  const sources = Array.isArray(packet?.sources) ? packet.sources.map((source, index) => {
    const original = String(source?.id || `S${index + 1}`).trim() || `S${index + 1}`;
    if (original.includes(":") && !original.startsWith(`${task}:`)) {
      throw invalidParams(`${task} supplied a packet source ID owned by another provenance scope: ${original}`, {
        reason: "PACKET_SOURCE_SCOPE_MISMATCH",
        task,
        source_id: original,
      });
    }
    const id = scopedSourceId(task, original, index);
    if (suppliedSourceIds.has(id)) {
      throw invalidParams(`${task} supplied duplicate packet source ID ${id}`, {
        reason: "PACKET_SOURCE_ID_DUPLICATE",
        task,
        source_id: id,
      });
    }
    suppliedSourceIds.add(id);
    sourceIdMap.set(original, id);
    return bindSameDayDynamicObservation({
      ...(source && typeof source === "object" ? source : {}),
      id,
      ...(typeof source?.title === "string" ? { title: sanitizeStatementMarkdown(source.title) } : {}),
    }, asOfDate, observationTime);
  }) : [];
  const claims = Array.isArray(packet?.claims) ? packet.claims.map((claim) => {
    const normalized = {
      ...(claim && typeof claim === "object" ? claim : {}),
      ...(typeof claim?.claim === "string" ? { claim: sanitizeStatementMarkdown(claim.claim) } : {}),
      ...(typeof claim?.evidence === "string" ? { evidence: sanitizeStatementMarkdown(claim.evidence) } : {}),
      source_ids: Array.isArray(claim?.source_ids)
        ? claim.source_ids.map((id) => sourceIdMap.get(String(id)) || scopedSourceId(task, id)).filter(Boolean)
        : [],
    };
    return task === NEWS_TASK
      ? { ...normalized, claim_type: normalizedNewsClaimType(claim) }
      : normalized;
  }) : [];
  const officialSourceCoverage = task === NEWS_TASK && Object.hasOwn(packet || {}, "official_source_coverage")
    ? normalizeOfficialSourceCoverage(packet.official_source_coverage, task, sourceIdMap, sources, asOfDate)
    : undefined;
  const coverageItems = normalizeCompanyCoverageItems(packet?.coverage_items, task, sourceIdMap);
  const acquisitionLedger = normalizeCompanySourceAcquisitionLedger(packet?.acquisition_ledger, task, sourceIdMap);
  const openQuestions = Array.isArray(packet?.open_questions) ? [...packet.open_questions] : [];
  for (const gap of coverageGapQuestions(officialSourceCoverage)) {
    if (!openQuestions.includes(gap)) openQuestions.push(gap);
  }
  return {
    task,
    symbol,
    as_of: asOfDate,
    summary: sanitizeStatementMarkdown(typeof packet?.summary === "string" ? packet.summary : raw.slice(0, LIMITS.CLEAN_LOG_BYTES)),
    claims,
    metrics: packet?.metrics && typeof packet.metrics === "object" ? packet.metrics : {},
    sources,
    open_questions: openQuestions.map(sanitizeStatementMarkdown).filter(Boolean),
    ...(coverageItems.length ? { coverage_items: coverageItems } : {}),
    ...(acquisitionLedger !== undefined ? { acquisition_ledger: acquisitionLedger } : {}),
    ...(officialSourceCoverage !== undefined ? { official_source_coverage: officialSourceCoverage } : {}),
    confidence: ["high", "medium", "low"].includes(packet?.confidence) ? packet.confidence : "low",
    // How much material this task actually had. Deliberately separate from confidence:
    // a rich-but-contradictory task can be A/low, a sparse-but-decisive one C/high.
    information_richness: ["A", "B", "C"].includes(packet?.information_richness) ? packet.information_richness : "unrated",
    thread_id: typeof packet?.thread_id === "string" ? packet.thread_id : undefined,
    thread_title: typeof packet?.thread_title === "string" ? sanitizeStatementMarkdown(packet.thread_title) : undefined,
    execution_mode: typeof packet?.execution_mode === "string" ? packet.execution_mode : undefined,
    raw_text: raw,
  };
}

export function assertPriceLevelContinuity(rows, { required = false, expectedCurrency = null } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    if (required) throw invalidParams("portfolio_manager omitted structured price levels", {
      reason: "PRICE_LEVELS_REQUIRED",
    });
    return [];
  }
  const problems = [];
  const normalized = rows.map((row, index) => ({
    ...row,
    lower_bound: row?.lower_bound === null ? null : Number(row?.lower_bound),
    upper_bound: row?.upper_bound === null ? null : Number(row?.upper_bound),
    currency: typeof row?.currency === "string" ? row.currency : "",
    _index: index,
  }));
  const currencies = new Set(normalized.map((row) => row.currency).filter(Boolean));
  if (currencies.size !== 1) problems.push({ reason: "price_level_currency_mismatch", currencies: [...currencies] });
  const expectedPriceCurrency = typeof expectedCurrency === "string" && /\S/u.test(expectedCurrency)
    ? expectedCurrency
    : null;
  const crossCurrencyRows = expectedPriceCurrency
    ? normalized.filter((row) => row.currency !== expectedPriceCurrency)
      .map((row) => ({ index: row._index, currency: row.currency || null }))
    : [];
  if (crossCurrencyRows.length) {
    problems.push({
      reason: "price_level_rating_currency_mismatch",
      expected_currency: expectedPriceCurrency,
      mismatched_price_levels: crossCurrencyRows,
    });
  }
  for (const row of normalized) {
    if (row.lower_bound !== null && (!Number.isFinite(row.lower_bound) || row.lower_bound < 0)) {
      problems.push({ index: row._index, reason: "invalid_lower_bound" });
    }
    if (row.upper_bound !== null && (!Number.isFinite(row.upper_bound) || row.upper_bound <= 0)) {
      problems.push({ index: row._index, reason: "invalid_upper_bound" });
    }
    if (row.lower_bound !== null && row.upper_bound !== null && row.lower_bound >= row.upper_bound) {
      problems.push({ index: row._index, reason: "non_positive_price_interval" });
    }
  }
  const ordered = [...normalized].sort((left, right) => (
    (left.lower_bound === null ? Number.NEGATIVE_INFINITY : left.lower_bound)
    - (right.lower_bound === null ? Number.NEGATIVE_INFINITY : right.lower_bound)
  ));
  if (ordered[0]?.lower_bound !== null) problems.push({ reason: "missing_open_lower_band" });
  if (ordered.at(-1)?.upper_bound !== null) problems.push({ reason: "missing_open_upper_band" });
  if (ordered.filter((row) => row.lower_bound === null).length !== 1) {
    problems.push({ reason: "open_lower_band_count_mismatch" });
  }
  if (ordered.filter((row) => row.upper_bound === null).length !== 1) {
    problems.push({ reason: "open_upper_band_count_mismatch" });
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous.upper_bound === null || current.lower_bound === null) continue;
    const difference = current.lower_bound - previous.upper_bound;
    if (Math.abs(difference) > 1e-8) {
      problems.push({
        reason: difference > 0 ? "price_level_gap" : "price_level_overlap",
        previous_index: previous._index,
        current_index: current._index,
        previous_upper_bound: previous.upper_bound,
        current_lower_bound: current.lower_bound,
        magnitude: Math.abs(difference),
      });
    }
  }
  if (problems.length) {
    throw invalidParams("Structured price levels must continuously cover every price with one explicit action.", {
      reason: crossCurrencyRows.length
        ? "PM_PRICE_LEVEL_CURRENCY_MISMATCH"
        : "PRICE_LEVEL_CONTINUITY_MISMATCH",
      ...(crossCurrencyRows.length ? { expected_currency: expectedPriceCurrency } : {}),
      problems,
    });
  }
  return normalized.map(({ _index, ...row }) => row);
}

export function normalizeDebate(packet, role, run, raw = "") {
  const decisionAvailable = packet?.decision_available !== false;
  const prose = (value, fallback = "") => sanitizeStatementMarkdown(
    typeof value === "string" ? value : fallback,
  );
  const proseList = (value) => (Array.isArray(value)
    ? value.filter((item) => typeof item === "string").map(sanitizeStatementMarkdown).filter(Boolean)
    : []);
  const questionAnswers = (value) => (Array.isArray(value) ? value : [])
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      ...item,
      ...(typeof item.question === "string" ? { question: sanitizeStatementMarkdown(item.question) } : {}),
      ...(typeof item.answer === "string" ? { answer: sanitizeStatementMarkdown(item.answer) } : {}),
    }));
  const debateRounds = (Array.isArray(packet?.debate_rounds) ? packet.debate_rounds : [])
    .filter((round) => round && typeof round === "object" && !Array.isArray(round))
    .map((round) => ({
      ...round,
      summary: prose(round.summary),
      long_thesis: proseList(round.long_thesis),
      short_thesis: proseList(round.short_thesis),
      questions: proseList(round.questions),
      questions_answered: questionAnswers(round.questions_answered),
    }));
  const reportRaw = typeof packet?.report_markdown === "string" ? packet.report_markdown : "";
  const reportAuthority = protectedRatingAuthorityOccurrences(reportRaw);
  const trustedBoundReport = role === "portfolio_manager"
    && packet?.rating_basis && typeof packet.rating_basis === "object"
    && reportAuthority.heading_count === 1
    && reportAuthority.authority_count === 1;
  return {
    role,
    symbol: run.symbol,
    as_of: run.as_of,
    verdict: prose(packet?.verdict),
    decision_available: decisionAvailable,
    rating: decisionAvailable ? (RATINGS.includes(packet?.rating) ? packet.rating : "Hold") : null,
    winner: ["bull", "bear", "balanced", "unknown"].includes(packet?.winner) ? packet.winner : "unknown",
    summary: prose(packet?.summary, raw.slice(0, LIMITS.CLEAN_LOG_BYTES)),
    long_thesis: proseList(packet?.long_thesis),
    short_thesis: proseList(packet?.short_thesis),
    valuation_range: prose(packet?.valuation_range),
    catalysts: proseList(packet?.catalysts),
    risks: proseList(packet?.risks),
    position: prose(packet?.position),
    invalidation: proseList(packet?.invalidation),
    source_ids: Array.isArray(packet?.source_ids) ? packet.source_ids : [],
    // An unavailable decision has no decision confidence. Persist `low` as the conservative
    // machine-readable value; renderers may display it as unavailable, but must never expose
    // high confidence beside NEEDS_MANAGER_REVIEW.
    confidence: decisionAvailable && ["high", "medium", "low"].includes(packet?.confidence)
      ? packet.confidence
      : "low",
    questions: proseList(packet?.questions),
    questions_answered: questionAnswers(packet?.questions_answered),
    debate_rounds: debateRounds,
    // Optional compact full-PM fields. Headless full renders these deterministically after the
    // small decision packet validates; quick and visible contracts may simply leave them empty.
    price_levels: assertPriceLevelContinuity(packet?.price_levels, {
      required: role === "portfolio_manager" && Array.isArray(packet?.price_levels),
      expectedCurrency: role === "portfolio_manager" ? packet?.rating_basis?.price_currency : null,
    }),
    horizon_views: packet?.horizon_views && typeof packet.horizon_views === "object" && !Array.isArray(packet.horizon_views)
      ? packet.horizon_views
      : {},
    data_gaps: proseList(packet?.data_gaps),
    verification_findings_ack: Array.isArray(packet?.verification_findings_ack)
      ? packet.verification_findings_ack
      : undefined,
    rating_basis: packet?.rating_basis && typeof packet.rating_basis === "object"
      && !Array.isArray(packet.rating_basis)
      ? packet.rating_basis
      : undefined,
    company_dossier_hash_ack: typeof packet?.company_dossier_hash_ack === "string"
      ? packet.company_dossier_hash_ack
      : undefined,
    report_markdown: trustedBoundReport ? reportRaw : sanitizeUntrustedMarkdown(reportRaw),
    failure_kind: typeof packet?.failure_kind === "string" ? packet.failure_kind : undefined,
    thread_id: typeof packet?.thread_id === "string" ? packet.thread_id : undefined,
    thread_title: typeof packet?.thread_title === "string" ? sanitizeStatementMarkdown(packet.thread_title) : undefined,
    execution_mode: typeof packet?.execution_mode === "string" ? packet.execution_mode : undefined,
    raw_text: raw,
  };
}

export function debateFailurePacket(role, run, failureKind) {
  const kind = ["global_deadline", "timeout", "exit", "usage_limit_exhausted", "parse_failed", "reader_language_mismatch", "unexpected_error"]
    .includes(failureKind)
    ? failureKind
    : "unexpected_error";
  const copy = localized(run.language, {
    en: {
      global_deadline: `${role} did not complete before the council's global deadline.`,
      timeout: `${role} timed out and produced no usable debate statement.`,
      exit: `${role} exited unsuccessfully and produced no usable debate statement.`,
      usage_limit_exhausted: `${role} could not start because the Codex usage limit was exhausted; no usable debate statement was produced.`,
      parse_failed: `${role} returned output that violated the debate JSON contract.`,
      reader_language_mismatch: `${role} returned reader-facing content in the wrong language.`,
      unexpected_error: `${role} failed unexpectedly and produced no usable debate statement.`,
    },
    zh: {
      global_deadline: `${role} 未能在委员会全局截止时间前完成。`,
      timeout: `${role} 执行超时，未生成可用的辩论发言。`,
      exit: `${role} 异常退出，未生成可用的辩论发言。`,
      usage_limit_exhausted: `${role} 因 Codex 使用额度已耗尽而无法启动，未生成可用的辩论发言。`,
      parse_failed: `${role} 的输出违反辩论 JSON 契约。`,
      reader_language_mismatch: `${role} 返回了错误语言的读者内容。`,
      unexpected_error: `${role} 意外失败，未生成可用的辩论发言。`,
    },
    ja: {
      global_deadline: `${role} は委員会全体の期限までに完了しませんでした。`,
      timeout: `${role} はタイムアウトし、利用可能な討論発言を生成しませんでした。`,
      exit: `${role} は異常終了し、利用可能な討論発言を生成しませんでした。`,
      usage_limit_exhausted: `${role} は Codex の使用上限に達したため開始できず、利用可能な討論発言を生成しませんでした。`,
      parse_failed: `${role} の出力は討論 JSON 契約に違反しています。`,
      reader_language_mismatch: `${role} は指定と異なる言語の読者向け内容を返しました。`,
      unexpected_error: `${role} は予期せず失敗し、利用可能な討論発言を生成しませんでした。`,
    },
    ko: {
      global_deadline: `${role}이 위원회 전체 마감 시간 전에 완료되지 않았습니다.`,
      timeout: `${role}이 시간 초과되어 사용할 수 있는 토론 발언을 생성하지 못했습니다.`,
      exit: `${role}이 비정상 종료되어 사용할 수 있는 토론 발언을 생성하지 못했습니다.`,
      usage_limit_exhausted: `${role}은 Codex 사용 한도가 소진되어 시작하지 못했고, 사용할 수 있는 토론 발언을 생성하지 못했습니다.`,
      parse_failed: `${role}의 출력이 토론 JSON 계약을 위반했습니다.`,
      reader_language_mismatch: `${role}이 지정과 다른 언어의 독자용 내용을 반환했습니다.`,
      unexpected_error: `${role}이 예기치 않게 실패해 사용할 수 있는 토론 발언을 생성하지 못했습니다.`,
    },
  });
  return normalizeDebate({
    verdict: "FAILED",
    decision_available: false,
    rating: null,
    winner: "unknown",
    summary: copy[kind],
    confidence: "low",
    report_markdown: "",
    failure_kind: kind,
  }, role, run, "");
}

export function dryPacket(task, symbol, asOfDate, prompt, language = "English") {
  const chinese = isChineseLanguage(language);
  return normalizePacket({
    summary: chinese ? `已计划 ${symbol} 的 ${task} 子代理。` : `Planned ${task} subagent for ${symbol}.`,
    claims: [{
      claim: chinese ? "仅 dry run；没有执行外部研究。" : "Dry run only; no external research executed.",
      evidence: chinese ? "生成的 prompt 已保存在 raw_text。" : "The generated prompt is stored in raw_text.",
      confidence: "low",
      source_ids: [],
    }],
    open_questions: [chinese ? "不要传 dry_run，或传 dry_run=false，即可执行 Codex 子代理。" : "Run again without dry_run, or with dry_run=false, to execute Codex subagents."],
    confidence: "low",
  }, task, symbol, asOfDate, prompt);
}

export function dryDebate(role, run, prompt) {
  const chinese = isChineseLanguage(run.language);
  return normalizeDebate({
    verdict: "DRY_RUN",
    rating: "Hold",
    winner: "unknown",
    summary: chinese ? `已计划 ${run.symbol} 的 ${role} 综合。` : `Planned ${role} synthesis for ${run.symbol}.`,
    confidence: "low",
    report_markdown: chinese ? `# ${run.symbol} ${role}\n\n仅 dry run。\n` : `# ${run.symbol} ${role}\n\nDry run only.\n`,
  }, role, run, prompt);
}

export function compactEvidence(run) {
  return {
    run_id: run.run_id,
    symbol: run.symbol,
    as_of: run.as_of,
    context_contract: run?.company_dossier?.content_hash
      ? "company_dossier_index_v1"
      : "bounded_full_v1",
    ...(run?.company_dossier?.content_hash
      ? { company_dossier: run.company_dossier }
      : {}),
    packets: (run.packets || []).map((packet) => {
      const claims = (packet.claims || []).slice(0, 8);
      const sourceById = new Map((packet.sources || []).map((source) => [source?.id, source]));
      const referenced = [...new Set([
        ...claims.flatMap((claim) => claim?.source_ids || []),
        ...coverageSourceIds(packet.official_source_coverage),
      ])];
      const selectedIds = referenced.filter((id) => sourceById.has(id)).slice(0, 12);
      for (const source of packet.sources || []) {
        if (selectedIds.length >= 12) break;
        if (source?.id && !selectedIds.includes(source.id)) selectedIds.push(source.id);
      }
      const included = new Set(selectedIds);
      return {
        task: packet.task,
        artifact_ref: packetArtifactRef(run, packet),
        summary: clip(packet.summary || "", 1_800),
        claims: claims.map((claim) => ({
          claim: clip(claim?.claim || "", 700),
          evidence: clip(claim?.evidence || "", 700),
          confidence: claim?.confidence || "low",
          source_ids: (claim?.source_ids || []).filter((id) => included.has(id)),
        })),
        metrics: compactValue(packet.metrics || {}),
        ...(packet.official_source_coverage
          ? { official_source_coverage: compactValue(packet.official_source_coverage) }
          : {}),
        ...(packet.coverage_items
          ? { coverage_items: compactValue(packet.coverage_items) }
          : {}),
        ...(packet.acquisition_ledger
          ? { acquisition_ledger: compactValue(packet.acquisition_ledger) }
          : {}),
        sources: selectedIds.map((id) => sourceById.get(id)).filter(Boolean).map((source) => ({
          id: source?.id,
          title: clip(source?.title || "", 260),
          url: source?.url || "",
          published_at: source?.published_at || "unknown",
          retrieved_at: source?.retrieved_at || run.as_of,
        })),
        omitted_claim_count: Math.max(0, (packet.claims || []).length - claims.length),
        omitted_source_count: Math.max(0, (packet.sources || []).length - selectedIds.length),
        open_questions: (packet.open_questions || []).slice(0, 8).map((item) => clip(item, 650)),
        confidence: packet.confidence,
        information_richness: packet.information_richness,
      };
    }),
  };
}

const ARTIFACT_REF_CACHE = new Map();

function fileArtifactRef(path) {
  if (!existsSync(path)) return { path, hash: null, bytes: null };
  const stat = statSync(path);
  const signature = `${stat.size}:${stat.mtimeMs}`;
  const cached = ARTIFACT_REF_CACHE.get(path);
  if (cached?.signature === signature) return cached.ref;
  const body = readFileSync(path);
  const ref = {
    path,
    hash: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    bytes: body.byteLength,
  };
  ARTIFACT_REF_CACHE.set(path, { signature, ref });
  return ref;
}

function packetArtifactRef(run, packet) {
  const task = String(packet?.task || "unknown");
  const recordedJson = run?.task_status?.[task]?.output;
  const jsonPath = typeof recordedJson === "string" && recordedJson
    ? recordedJson
    : join(runPath(run.run_id), `${task}.json`);
  const dir = dirname(jsonPath);
  return {
    json: fileArtifactRef(jsonPath),
    markdown: fileArtifactRef(join(dir, `${task}.md`)),
  };
}

function compactValue(value, depth = 0) {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return clip(value, depth === 0 ? 600 : 320);
  if (depth >= 3) return Array.isArray(value) ? `[${value.length} items]` : "[nested object]";
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => compactValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 20)
      .map(([key, item]) => [key, compactValue(item, depth + 1)]));
  }
  return String(value);
}

/**
 * Bounded evidence context for the quick council.
 *
 * The full RKLB evidence file was 340 KB and the old PM prompt reached roughly 384 KB.
 * Raw transcripts never belonged in cross-seat context; this keeps the facts a short memo
 * needs while retaining source IDs, URLs, dates, confidence and explicit gaps.
 */
export function compactQuickEvidence(run) {
  return {
    run_id: run.run_id,
    symbol: run.symbol,
    as_of: run.as_of,
    council_mode: "quick",
    packets: (run.packets || []).map((packet) => {
      const allClaims = packet.claims || [];
      const selectedClaims = allClaims.slice(0, 4);
      const sourceById = new Map((packet.sources || []).map((source) => [source?.id, source]));
      const referencedIds = [...new Set([
        ...selectedClaims.flatMap((claim) => claim?.source_ids || []),
        ...coverageSourceIds(packet.official_source_coverage),
      ])];
      const selectedIds = referencedIds.filter((id) => sourceById.has(id)).slice(0, 6);
      for (const source of packet.sources || []) {
        if (selectedIds.length >= 6) break;
        if (source?.id && !selectedIds.includes(source.id)) selectedIds.push(source.id);
      }
      const includedIds = new Set(selectedIds);
      const omittedReferencedIds = referencedIds.filter((id) => !includedIds.has(id));
      return {
        task: packet.task,
        summary: clip(packet.summary || "", 1_200),
        claims: selectedClaims.map((claim) => ({
          claim: clip(claim?.claim || "", 500),
          evidence: clip(claim?.evidence || "", 500),
          confidence: claim?.confidence || "low",
          source_ids: (claim?.source_ids || []).filter((id) => includedIds.has(id)),
        })),
        metrics: compactValue(packet.metrics || {}),
        ...(packet.official_source_coverage
          ? { official_source_coverage: compactValue(packet.official_source_coverage) }
          : {}),
        ...(packet.acquisition_ledger
          ? { acquisition_ledger: compactValue(packet.acquisition_ledger) }
          : {}),
        sources: selectedIds.map((id) => sourceById.get(id)).filter(Boolean).map((source) => ({
          id: source?.id,
          title: clip(source?.title || "", 240),
          url: source?.url || "",
          published_at: source?.published_at || "unknown",
          retrieved_at: source?.retrieved_at || run.as_of,
        })),
        omitted_claim_count: Math.max(0, allClaims.length - selectedClaims.length),
        omitted_source_count: Math.max(0, (packet.sources || []).length - selectedIds.length),
        omitted_claim_source_ids: omittedReferencedIds,
        open_questions: (packet.open_questions || []).slice(0, 5).map((item) => clip(item, 500)),
        confidence: packet.confidence,
        information_richness: packet.information_richness,
      };
    }),
  };
}

/** Remove artifact-only payloads before a debate packet is sent to another model call. */
export function compactDebateContext(packet, { includeRating = true } = {}) {
  if (!packet) return null;
  return {
    role: packet.role,
    verdict: clip(packet.verdict || "", 1_200),
    ...(includeRating ? { rating: packet.rating } : {}),
    winner: packet.winner,
    summary: clip(packet.summary || "", 1_200),
    long_thesis: (packet.long_thesis || []).slice(0, 8).map((item) => clip(item, 600)),
    short_thesis: (packet.short_thesis || []).slice(0, 8).map((item) => clip(item, 600)),
    valuation_range: clip(packet.valuation_range || "", 1_000),
    catalysts: (packet.catalysts || []).slice(0, 6).map((item) => clip(item, 500)),
    risks: (packet.risks || []).slice(0, 6).map((item) => clip(item, 500)),
    position: clip(packet.position || "", 800),
    invalidation: (packet.invalidation || []).slice(0, 6).map((item) => clip(item, 500)),
    source_ids: (packet.source_ids || []).slice(0, 20),
    confidence: packet.confidence,
    company_dossier_hash_ack: packet.company_dossier_hash_ack,
    questions: (packet.questions || []).slice(0, 3).map((item) => clip(item, 600)),
    questions_answered: (packet.questions_answered || []).slice(0, 3).map((item) => ({
      question: clip(item?.question || "", 600),
      answer: clip(item?.answer || "", 900),
    })),
    debate_rounds: (packet.debate_rounds || []).slice(0, 3).map((round) => ({
      round: round?.round,
      summary: clip(round?.summary || "", 900),
      long_thesis: (round?.long_thesis || []).slice(0, 5).map((item) => clip(item, 500)),
      short_thesis: (round?.short_thesis || []).slice(0, 5).map((item) => clip(item, 500)),
      questions: (round?.questions || []).slice(0, 3).map((item) => clip(item, 600)),
      questions_answered: (round?.questions_answered || []).slice(0, 3).map((item) => ({
        question: clip(item?.question || "", 600),
        answer: clip(item?.answer || "", 900),
      })),
    })),
  };
}

export function debateFromCodex(result, role, run, fallbackPrompt, {
  managerDecisionOnly = false,
  repairedTransport = false,
} = {}) {
  if (!result.ok) {
    const classified = workerExecutionFailureKind(result);
    const failureKind = classified === "global_deadline" || classified === "timeout"
      ? classified
      : classified === "usage_limit_exhausted"
        ? classified
        : Number.isInteger(result.code)
          ? "exit"
          : "unexpected_error";
    return debateFailurePacket(role, run, failureKind);
  }
  try {
    // Visible PM submissions and quick PM workers still carry authored report_markdown. Full
    // headless PM workers have a dedicated compact contract; the trusted orchestrator attaches
    // a deterministic complete report only after every structured field and source ID validates.
    const kind = role === "portfolio_manager"
      ? (managerDecisionOnly ? "headless_portfolio_manager_decision" : "portfolio_manager")
      : "debate";
    const parsed = repairedTransport
      ? extractRepairedWorkerJson(result.text, kind)
      : extractWorkerJson(result.text, kind);
    assertCompanyDossierAck(parsed, run, role);
    const source_ids = assertSourceIdsResolve(run, parsed.source_ids, role);
    const ratingBasisRequired = role === "portfolio_manager"
      && run?.decision_context?.rating_basis_required === true;
    const rating_basis = role === "portfolio_manager"
      && (ratingBasisRequired || parsed?.rating_basis !== undefined)
      ? assertPmRatingBasis(parsed, {
        adjustmentContexts: pmRatingAdjustmentContexts(run),
        referencePrice: pmRatingReferencePrice(run),
        referenceCurrency: pmRatingReferenceCurrency(run),
      })
      : undefined;
    if (rating_basis) {
      assertSourceIdsResolve(run, rating_basis.source_ids, `${role} rating basis`);
    }
    if (role === "portfolio_manager") {
      assertSourceIdsResolve(run, managerDecisionNestedSourceIds({
        ...parsed,
        source_ids,
        ...(rating_basis ? { rating_basis } : {}),
      }), `${role} nested decision sources`);
    }
    const verification_findings_ack = role === "portfolio_manager" && managerDecisionOnly
      ? assertVerificationFindingsAck(parsed, run, role)
      : undefined;
    return normalizeDebate({
      ...parsed,
      source_ids,
      ...(rating_basis ? { rating_basis } : {}),
      ...(verification_findings_ack ? { verification_findings_ack } : {}),
      ...(!managerDecisionOnly && rating_basis ? {
        report_markdown: bindMachineCheckedRatingBasisMarkdown(
          parsed.report_markdown,
          rating_basis,
          parsed.rating,
          run.language,
        ),
      } : {}),
    }, role, run, result.text);
  } catch (error) {
    const failure = debateFailurePacket(role, run, "parse_failed");
    const validatorErrors = Array.isArray(error?.data?.errors) ? error.data.errors : [];
    const contractProblems = Array.isArray(error?.data?.problems)
      ? error.data.problems.map((problem) => ({
        path: typeof problem?.path === "string" ? problem.path : "/rating_basis",
        keyword: typeof problem?.code === "string" ? problem.code : "contract",
        message: [
          problem?.code || "contract mismatch",
          Object.hasOwn(problem || {}, "expected") ? `expected=${JSON.stringify(problem.expected)}` : "",
          Object.hasOwn(problem || {}, "actual") ? `actual=${JSON.stringify(problem.actual)}` : "",
        ].filter(Boolean).join("; "),
      }))
      : [];
    const allSchemaErrors = validatorErrors.length ? validatorErrors : contractProblems;
    const schemaErrors = allSchemaErrors.slice(0, 12);
    const reason = String(error?.data?.reason || "WORKER_OUTPUT_REJECTED");
    const safeReason = /^[A-Z0-9_]{1,96}$/u.test(reason) ? reason : "WORKER_OUTPUT_REJECTED";
    const outputContractDiagnostic = {
      reason: safeReason,
      ...(typeof error?.data?.schema_id === "string"
        ? { schema_id: cleanLog(error.data.schema_id, 160) }
        : {}),
      ...(typeof error?.data?.kind === "string"
        ? { schema_kind: cleanLog(error.data.kind, 80) }
        : {}),
      ...(schemaErrors.length ? {
        schema_error_count: allSchemaErrors.length,
        schema_errors: schemaErrors,
      } : {}),
    };
    return {
      ...failure,
      ...(schemaErrors.length ? { schema_errors: schemaErrors } : {}),
      output_contract_diagnostic: outputContractDiagnostic,
    };
  }
}

function managerFallbackStatus(run, failurePacket = null) {
  const agentStatus = Array.isArray(run?.agent_status)
    ? run.agent_status.find((item) => item?.role === "portfolio_manager")
    : run?.agent_status?.portfolio_manager;
  const failureKind = failurePacket?.failure_kind || agentStatus?.failure_kind || agentStatus?.error || "";
  const attempts = Math.max(1, Number(failurePacket?.attempts || agentStatus?.attempts) || 1);
  if (failureKind === "parse_failed") {
    if (attempts >= 2) {
      return localized(run.language, {
        zh: "portfolio_manager 已执行 2 次，但两次输出均违反 JSON/报告契约；未产出可用决策。",
        en: "portfolio_manager ran twice, but both outputs violated the JSON/report contract; no usable decision was produced.",
        ja: "portfolio_manager は2回実行されましたが、2回とも JSON／レポート契約に違反し、利用可能な判断を生成できませんでした。正式な投資判断はありません。",
        ko: "portfolio_manager를 두 번 실행했지만 두 출력 모두 JSON/보고서 계약을 위반해 사용 가능한 결정을 생성하지 못했습니다. 공식 투자 판단을 제공할 수 없습니다.",
      });
    }
    return localized(run.language, {
      zh: "portfolio_manager 输出违反 JSON/报告契约；未产出可用决策。",
      en: "portfolio_manager output violated the JSON/report contract; no usable decision was produced.",
      ja: "portfolio_manager の出力が JSON／レポート契約に違反し、利用可能な判断を生成できませんでした。正式な投資判断はありません。",
      ko: "portfolio_manager 출력이 JSON/보고서 계약을 위반해 사용 가능한 결정을 생성하지 못했습니다. 공식 투자 판단을 제공할 수 없습니다.",
    });
  }
  if (failureKind) {
    return localized(run.language, {
      zh: "portfolio_manager 执行失败，未产出可用决策。",
      en: "portfolio_manager failed and produced no usable decision.",
      ja: "portfolio_manager が失敗し、利用可能な判断を生成できませんでした。正式な投資判断はありません。",
      ko: "portfolio_manager 실행이 실패해 사용 가능한 결정을 생성하지 못했습니다. 공식 투자 판단을 제공할 수 없습니다.",
    });
  }
  return localized(run.language, {
    zh: "portfolio_manager 未完成，未产出可用决策。",
    en: "portfolio_manager did not complete; no usable decision was produced.",
    ja: "portfolio_manager が完了しておらず、利用可能な判断は生成されていません。正式な投資判断はありません。",
    ko: "portfolio_manager가 완료되지 않아 사용 가능한 결정이 생성되지 않았습니다. 공식 투자 판단을 제공할 수 없습니다.",
  });
}

function asianManagerFallback(run, summary, managerStatus) {
  const key = languageKey(run.language);
  if (!new Set(["ja", "ko"]).has(key)) return null;
  const c = localized(run.language, {
    ja: {
      title: "投資委員会ドラフト", conclusion: "結論", analyst: "アナリスト作業記録", debate: "強気・弱気討論記録", masters: "メソッド席", long: "強気論点", short: "弱気論点", market: "市場期待と織り込み条件", rating: "アナリスト評価と目標株価の変更", call: "決算説明会の経営シグナル", quant: "定量・ファクター視点", news: "ニュースと企業・業界シグナル", borrow: "空売り・貸株・オプション情報", transaction: "戦略取引・銀行イベント", valuation: "企業価値評価レンジ", price: "価格条件", catalysts: "主要カタリスト", risks: "主要リスク", position: "ポジション提案", shortTerm: "短期1–4週間の見通し", mediumTerm: "中期3–6か月の見通し", longTerm: "長期12か月の見通し", gaps: "データ欠落・利用不可データ", invalidation: "無効化条件", confidence: "信頼度", sources: "出典表",
      unavailable: "今回の実行では同じ言語で確認できる情報を取得できませんでした。", managerMissing: managerStatus, draftOnly: "この文書はドラフトであり、正式なポジションを示しません。", noPackets: "証拠パケットは生成されませんでした。", noMaster: "完了したメソッド席はありません。", keyFindings: "主要所見", dataGaps: "データ欠落", packetSummary: "要約", packetConfidence: "信頼度", sourceCount: "出典数",
    },
    ko: {
      title: "투자위원회 초안", conclusion: "결론", analyst: "분석가 작업 기록", debate: "강세·약세 토론 기록", masters: "방법론 좌석", long: "강세 논거", short: "약세 논거", market: "시장 기대와 내재 조건", rating: "애널리스트 등급 및 목표가 변경", call: "실적 발표 콜 경영진 신호", quant: "정량·팩터 관점", news: "뉴스 및 기업·산업 신호", borrow: "공매도·대차·옵션 정보", transaction: "전략적 거래·금융 이벤트", valuation: "가치평가 범위", price: "가격 조건", catalysts: "핵심 촉매", risks: "주요 위험", position: "포지션 제안", shortTerm: "단기 1–4주 전망", mediumTerm: "중기 3–6개월 전망", longTerm: "장기 12개월 전망", gaps: "데이터 공백·사용 불가 데이터", invalidation: "무효화 조건", confidence: "신뢰도", sources: "출처 표",
      unavailable: "이번 실행에서는 같은 언어로 확인 가능한 정보를 확보하지 못했습니다.", managerMissing: managerStatus, draftOnly: "이 문서는 초안이며 공식 포지션을 제시하지 않습니다.", noPackets: "증거 패킷이 생성되지 않았습니다.", noMaster: "완료된 방법론 좌석이 없습니다.", keyFindings: "핵심 발견", dataGaps: "데이터 공백", packetSummary: "요약", packetConfidence: "신뢰도", sourceCount: "출처 수",
    },
  });
  const analystLog = run.packets.length
    ? run.packets.map((packet) => {
      const claims = (packet.claims || []).slice(0, 5).map((claim) => `  - ${claim.claim}`).join("\n");
      const gaps = (packet.open_questions || []).slice(0, 3).map((item) => `  - ${item}`).join("\n");
      return `### ${packet.task}\n- ${c.packetConfidence}: ${packet.confidence || "unknown"}\n- ${c.packetSummary}: ${packet.summary || c.unavailable}\n${claims ? `- ${c.keyFindings}:\n${claims}\n` : ""}${gaps ? `- ${c.dataGaps}:\n${gaps}\n` : ""}`;
    }).join("\n\n")
    : c.noPackets;
  const masterLog = (run.master_opinions || []).length
    ? run.master_opinions.map((opinion) => `- ${opinion.master}: ${opinion.stance} - ${opinion.summary || opinion.verdict || c.unavailable}`).join("\n")
    : `- ${c.noMaster}`;
  const long = summary.thesis.filter((claim) => claim.confidence !== "low").slice(0, 6).map((claim) => `- ${claim.claim}`).join("\n") || `- ${c.unavailable}`;
  const short = summary.open_questions.slice(0, 6).map((item) => `- ${item}`).join("\n") || `- ${c.unavailable}`;
  const gaps = summary.open_questions.length ? summary.open_questions.map((item) => `- ${item}`).join("\n") : `- ${c.unavailable}`;
  const report = `# ${run.symbol} ${c.title}\n\n## ${c.conclusion}\n${summary.final_decision} — ${c.managerMissing}\n\n## ${c.analyst}\n${analystLog}\n\n## ${c.debate}\n${c.managerMissing}\n\n## ${c.masters}\n${masterLog}\n\n## ${c.long}\n${long}\n\n## ${c.short}\n${short}\n\n## ${c.market}\n${c.unavailable}\n\n## ${c.rating}\n${c.unavailable}\n\n## ${c.call}\n${c.unavailable}\n\n## ${c.quant}\n${c.unavailable}\n\n## ${c.news}\n${c.unavailable}\n\n## ${c.borrow}\n${c.unavailable}\n\n## ${c.transaction}\n${c.unavailable}\n\n## ${c.valuation}\n${c.unavailable}\n\n## ${c.price}\n${c.managerMissing} ${c.unavailable}\n\n## ${c.catalysts}\n${c.managerMissing}\n\n## ${c.risks}\n${short}\n\n## ${c.position}\n${c.draftOnly}\n\n## ${c.shortTerm}\n${c.managerMissing}\n\n## ${c.mediumTerm}\n${c.managerMissing}\n\n## ${c.longTerm}\n${c.managerMissing}\n\n## ${c.gaps}\n${gaps}\n\n## ${c.invalidation}\n${c.managerMissing} ${c.draftOnly}\n\n## ${c.confidence}\n${summary.confidence}\n\n## ${c.sources}\n- ${c.sourceCount}: ${summary.source_count}\n`;
  return { copy: c, analystLog, masterLog, report };
}

export function mergeDebateRounds(rounds) {
  const list = (rounds || []).filter(Boolean);
  if (list.length === 0) return null;
  const base = list[list.length - 1];
  const debate_rounds = list.map((packet, index) => ({
    round: index + 1,
    summary: packet.summary || "",
    long_thesis: packet.long_thesis || [],
    short_thesis: packet.short_thesis || [],
    company_dossier_hash_ack: packet.company_dossier_hash_ack || null,
    questions: packet.questions || [],
    questions_answered: packet.questions_answered || [],
    raw_text: packet.raw_text || "",
  }));
  return { ...base, debate_rounds };
}

function threeNonEmptyStrings(value) {
  return Array.isArray(value)
    && value.length === 3
    && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function threeBoundAnswers(value, expectedQuestions) {
  return threeNonEmptyStrings(expectedQuestions)
    && Array.isArray(value)
    && value.length === 3
    && value.every((item, index) => (
      item
      && typeof item === "object"
      && !Array.isArray(item)
      && item.question === expectedQuestions[index]
      && typeof item.answer === "string"
      && item.answer.trim().length > 0
  ));
}

/** Validate one headless debate worker against the Q&A context that was frozen for its round. */
export function debateRoundQnaGate({ role, round, packet, questionsYouAsked, questionsForYou } = {}) {
  if (!new Set(["bull_researcher", "bear_researcher"]).has(role) || ![2, 3].includes(round)) {
    return { status: "passed", errors: [] };
  }
  const errors = [];
  if (round === 2 && !threeNonEmptyStrings(packet?.questions)) {
    errors.push(`${role} round 2 must ask exactly 3 opponent questions`);
  }
  if (round === 3) {
    if (!threeBoundAnswers(packet?.questions_answered, questionsForYou)) {
      errors.push(`${role} round 3 must answer exactly 3 opponent questions with exact question bindings`);
    }
    if (!threeNonEmptyStrings(questionsYouAsked)
      || JSON.stringify(packet?.questions) !== JSON.stringify(questionsYouAsked)) {
      errors.push(`${role} round 3 must preserve its round 2 questions`);
    }
  }
  return { status: errors.length ? "failed" : "passed", errors };
}

/** Fail closed when the advertised Q&A round did not actually exchange questions. */
export function debateQnaGate({ bullR2, bearR2, bullR3, bearR3 } = {}) {
  const errors = [];
  if (!threeNonEmptyStrings(bullR2?.questions)) {
    errors.push("bull_researcher round 2 must ask exactly 3 opponent questions");
  }
  if (!threeNonEmptyStrings(bearR2?.questions)) {
    errors.push("bear_researcher round 2 must ask exactly 3 opponent questions");
  }
  if (!threeBoundAnswers(bullR3?.questions_answered, bearR2?.questions)) {
    errors.push("bull_researcher round 3 must answer exactly 3 opponent questions with exact question bindings");
  }
  if (!threeBoundAnswers(bearR3?.questions_answered, bullR2?.questions)) {
    errors.push("bear_researcher round 3 must answer exactly 3 opponent questions with exact question bindings");
  }
  if (threeNonEmptyStrings(bullR2?.questions)
    && JSON.stringify(bullR3?.questions) !== JSON.stringify(bullR2.questions)) {
    errors.push("bull_researcher round 3 must preserve its round 2 questions");
  }
  if (threeNonEmptyStrings(bearR2?.questions)
    && JSON.stringify(bearR3?.questions) !== JSON.stringify(bearR2.questions)) {
    errors.push("bear_researcher round 3 must preserve its round 2 questions");
  }
  return { status: errors.length ? "failed" : "passed", errors };
}

/** Return the actual failed round, not merely the final round in the role's sequence. */
export function firstFailedDebateResult(steps = []) {
  return steps.find((step) => step?.result?.ok !== true)?.result || null;
}

export function confidenceScore(value) {
  return ({ high: 3, medium: 2, low: 1 })[value] || 1;
}

export function summarizeRun(run, userPrompt = "") {
  const claims = run.packets.flatMap((packet) =>
    packet.claims.map((claim) => ({ ...claim, task: packet.task, packet_confidence: packet.confidence }))
  );
  const avg = run.packets.reduce((sum, packet) => sum + confidenceScore(packet.confidence), 0) / Math.max(1, run.packets.length);
  const confidence = avg >= 2.5 ? "high" : avg >= 1.7 ? "medium" : "low";
  return {
    run_id: run.run_id,
    symbol: run.symbol,
    as_of: run.as_of,
    objective: userPrompt,
    final_decision: run.dry_run ? "DRY_RUN" : "NEEDS_MANAGER_REVIEW",
    confidence,
    thesis: claims.slice(0, 12),
    open_questions: [...new Set(run.packets.flatMap((packet) => packet.open_questions || []))],
    source_count: run.packets.reduce((sum, packet) => sum + (packet.sources?.length || 0), 0),
    evidence_path: join(runPath(run.run_id), "evidence.json"),
  };
}

export function managerFallback(run, userPrompt = "", failurePacket = null) {
  // Evidence confidence is not decision confidence. A fallback has no usable PM decision,
  // so its own confidence is always low even when every underlying packet is high-confidence.
  const summary = { ...summarizeRun(run, userPrompt), confidence: "low" };
  const managerStatus = managerFallbackStatus(run, failurePacket);
  const asian = asianManagerFallback(run, summary, managerStatus);
  if (asian) {
    return normalizeDebate({
      verdict: summary.final_decision,
      decision_available: false,
      rating: null,
      winner: "unknown",
      summary: asian.copy.managerMissing,
      long_thesis: summary.thesis.filter((claim) => claim.confidence !== "low").slice(0, 6).map((claim) => claim.claim),
      short_thesis: summary.open_questions.slice(0, 6),
      confidence: summary.confidence,
      report_markdown: asian.report,
    }, "portfolio_manager", run);
  }
  const chinese = isChineseLanguage(run.language);
  const analystLog = run.packets.length
    ? run.packets.map((packet) => {
        const claims = (packet.claims || []).slice(0, 5).map((claim) => `  - ${claim.claim}`).join("\n");
        const gaps = (packet.open_questions || []).slice(0, 3).map((item) => `  - ${item}`).join("\n");
        return `### ${packet.task}\n- Confidence: ${packet.confidence || "unknown"}\n- Summary: ${packet.summary || "None"}\n${claims ? `- Key findings:\n${claims}\n` : ""}${gaps ? `- Data gaps:\n${gaps}\n` : ""}`;
      }).join("\n\n")
    : (chinese ? "未生成 evidence packets。" : "No evidence packets were generated.");
  const debateRecord = chinese
    ? `${managerStatus} 已完成的多空材料仅作为降级初稿保留。`
    : `${managerStatus} Completed bull/bear material is retained only as a degraded draft.`;
  const masterLog = (run.master_opinions || []).length
    ? run.master_opinions.map((opinion) => `- ${opinion.master}: ${opinion.stance} - ${opinion.summary || opinion.verdict || "no summary"}`).join("\n")
    : (chinese ? "- 本轮没有已完成的大师意见。" : "- No completed master opinion is available in this run.");
  return normalizeDebate({
    verdict: summary.final_decision,
    decision_available: false,
    rating: null,
    winner: "unknown",
    summary: managerStatus,
    long_thesis: summary.thesis.filter((claim) => claim.confidence !== "low").slice(0, 6).map((claim) => claim.claim),
    short_thesis: summary.open_questions.slice(0, 6),
    confidence: summary.confidence,
    report_markdown: chinese
      ? `# ${run.symbol} 投资委员会初稿\n\n## 结论\n${summary.final_decision}\n\n## 分析师工作记录\n${analystLog}\n\n## 多空辩论记录\n${debateRecord}\n\n## 大师席意见\n${masterLog}\n\n## 多头观点\n${summary.thesis.filter((claim) => claim.confidence !== "low").slice(0, 6).map((claim) => `- ${claim.claim}`).join("\n") || "- 本轮没有可用多头论点。"}\n\n## 空头观点\n${summary.open_questions.slice(0, 6).map((item) => `- ${item}`).join("\n") || "- 本轮没有可用空头论点。"}\n\n## 市场预期与隐含门槛\n${clip(packetSummary(run, "forward_expectations"), 900) || "- 本轮没有前瞻预期证据。"}\n\n## 分析师评级/目标价变化\n${clip(packetSummary(run, "forward_expectations"), 900) || "- 本轮没有卖方修正证据。"}\n\n## 电话会管理层信号\n${clip(packetSummary(run, "earnings_deep_dive"), 900) || "- 本轮没有电话会证据。"}\n\n## 量化/因子视角\n${clip(packetSummary(run, "quant_factor"), 900) || "- 本轮没有量化因子证据。"}\n\n## 新闻和公司/行业人物发言信号\n${clip([packetSummary(run, "news_industry_management"), packetSummary(run, "management_industry_voices")].filter(Boolean).join("\n"), 1200) || "- 本轮没有新闻或人物发言证据。"}\n\n## short interest / borrow / options 信息\n${clip(packetSummary(run, "quant_factor"), 700) || "- 本轮没有 short interest / borrow / options 数据。"}\n\n## 战略交易 / 银行事件\n${clip(packetSummary(run, "ib_event_analysis"), 900) || "- 本轮没有交易事件证据。"}\n\n## 估值区间\n${clip(packetSummary(run, "valuation_long_short"), 900) || "- 本轮没有估值证据。"}\n\n## 价位参考\n- 经理综合未完成，无法给出价格条件表。需要：估值区间、最差年份盈利、历史估值分位。\n\n## 关键催化剂\n- 等待 portfolio_manager 完整综合。\n\n## 主要风险\n${summary.open_questions.slice(0, 6).map((item) => `- ${item}`).join("\n") || "- 暂未发现额外风险。"}\n\n## 仓位建议\n- 经理综合未完成前仅作为初稿，不给正式仓位。\n\n## 短线 1-4 周判断\n- 需等待完整经理综合。\n\n## 中期 3-6 个月判断\n- 需等待完整经理综合。\n\n## 长期 12 个月判断\n- 需等待完整经理综合。\n\n## 数据缺口/未覆盖项\n${summary.open_questions.length ? summary.open_questions.map((item) => `- ${item}`).join("\n") : "- 未发现关键数据缺口。"}\n\n## 反证条件\n- 若证据来源缺失或完整经理综合失败，本初稿不能作为正式结论。\n\n## 置信度\n${summary.confidence}\n\n## 来源表\n- 来源数量: ${summary.source_count}\n`
      : `# ${run.symbol} Investment Committee Draft\n\n## Conclusion\n${summary.final_decision}\n\n## Analyst Work Log\n${analystLog}\n\n## Bull/Bear Debate Record\n${debateRecord}\n\n## Master Bench\n${masterLog}\n\n## Long Thesis\n${summary.thesis.filter((claim) => claim.confidence !== "low").slice(0, 6).map((claim) => `- ${claim.claim}`).join("\n") || "- No usable long thesis yet."}\n\n## Short Thesis\n${summary.open_questions.slice(0, 6).map((item) => `- ${item}`).join("\n") || "- No usable short thesis yet."}\n\n## Market Expectations and Implied Thresholds\n${clip(packetSummary(run, "forward_expectations"), 900) || "- No forward-expectations evidence in this run."}\n\n## Analyst Rating and Target-Price Revisions\n${clip(packetSummary(run, "forward_expectations"), 900) || "- No sell-side revision evidence in this run."}\n\n## Earnings Call Management Signals\n${clip(packetSummary(run, "earnings_deep_dive"), 900) || "- No earnings-call evidence in this run."}\n\n## Quant Factor / Technical Risk View\n${clip(packetSummary(run, "quant_factor"), 900) || "- No quant-factor evidence in this run."}\n\n## News and Company / Industry Voice Signals\n${clip([packetSummary(run, "news_industry_management"), packetSummary(run, "management_industry_voices")].filter(Boolean).join("\n"), 1200) || "- No news or voice evidence in this run."}\n\n## Short Interest / Borrow / Options Information\n${clip(packetSummary(run, "quant_factor"), 700) || "- No short interest / borrow / options data in this run."}\n\n## Strategic Transaction or Banking Event\n${clip(packetSummary(run, "ib_event_analysis"), 900) || "- No transaction evidence in this run."}\n\n## Valuation Range\n${clip(packetSummary(run, "valuation_long_short"), 900) || "- No valuation evidence in this run."}\n\n## Price Levels\n- Manager synthesis did not complete, so no price-condition table can be given. Needed: a valuation range, worst-year earnings, and the historical valuation percentile.\n\n## Key Catalysts\n- Wait for completed portfolio-manager synthesis.\n\n## Major Risks\n${summary.open_questions.slice(0, 6).map((item) => `- ${item}`).join("\n") || "- No additional risks surfaced yet."}\n\n## Position Recommendation\n- Draft only; no formal position before completed manager synthesis.\n\n## Short-Term 1-4 Week View\n- Requires completed manager synthesis.\n\n## Medium-Term 3-6 Month View\n- Requires completed manager synthesis.\n\n## Long-Term 12 Month View\n- Requires completed manager synthesis.\n\n## Data Gaps / Unavailable Data\n${summary.open_questions.length ? summary.open_questions.map((item) => `- ${item}`).join("\n") : "- No critical data gaps were found."}\n\n## Invalidation Conditions\n- If evidence sources are missing or manager synthesis fails, this draft cannot stand as the final decision.\n\n## Confidence\n${summary.confidence}\n\n## Source Table\n- Source count: ${summary.source_count}\n`,
  }, "portfolio_manager", run);
}

/**
 * Common ways a caller says a stance that is not one of the four we store.
 *
 * Mapping these is not politeness. An unmapped value used to fall through to "cautious",
 * which is a real stance carrying real weight -- so a caller writing "avoid" got a seat
 * that looked deliberate and voted. Ten such seats render as unanimity that no master
 * produced.
 */
const STANCE_SYNONYMS = new Map([
  ["long", "constructive"], ["bullish", "constructive"], ["buy", "constructive"],
  ["positive", "constructive"], ["overweight", "constructive"],
  ["neutral", "cautious"], ["hold", "cautious"], ["mixed", "cautious"], ["wait", "cautious"],
  ["short", "opposed"], ["bearish", "opposed"], ["sell", "opposed"], ["avoid", "opposed"],
  ["negative", "opposed"], ["underweight", "opposed"],
  ["n/a", "out_of_scope"], ["na", "out_of_scope"], ["skip", "out_of_scope"],
  ["abstain", "out_of_scope"], ["unknown", "out_of_scope"],
]);

/**
 * Never silently invent a stance.
 *
 * Anything we cannot map becomes `out_of_scope`, which weights.mjs already treats as
 * carrying zero weight. Guessing "cautious" for an unrecognised value manufactures a
 * confident-looking seat out of a caller's typo; declining to score it does not.
 */
export function coerceStance(value, masterId = "") {
  if (MASTER_STANCES.includes(value)) return value;
  if (typeof value === "string") {
    const mapped = STANCE_SYNONYMS.get(value.trim().toLowerCase());
    if (mapped) return mapped;
  }
  if (value !== undefined && value !== null && value !== "") {
    process.emitWarning(
      `alphacouncil: unrecognised master stance ${JSON.stringify(value)}`
      + `${masterId ? ` from ${masterId}` : ""}; recorded as out_of_scope (zero weight). `
      + `Allowed: ${MASTER_STANCES.join(", ")}.`
    );
  }
  return "out_of_scope";
}

/**
 * A master's opinion. Deliberately NOT a debate packet: a master issues no rating and
 * declares no winner. out_of_scope is a first-class stance -- "by my method this name is
 * outside what I can judge" is a conclusion, not an abstention.
 */
export function normalizeMasterOpinion(packet, masterId, run, raw = "") {
  const stringList = (value) => (Array.isArray(value) ? value.filter((x) => typeof x === "string") : []);
  const proseList = (value) => stringList(value).map(sanitizeStatementMarkdown).filter(Boolean);
  const stance = coerceStance(packet?.stance, masterId);
  const source_ids = assertSourceIdsResolve(run, stringList(packet?.source_ids), masterId, {
    allowEmpty: stance === "out_of_scope",
  });
  const normalized = {
    master: masterId,
    symbol: run.symbol,
    as_of: run.as_of,
    verdict: sanitizeStatementMarkdown(typeof packet?.verdict === "string" ? packet.verdict : ""),
    stance,
    summary: sanitizeStatementMarkdown(typeof packet?.summary === "string" ? packet.summary : raw.slice(0, LIMITS.CLEAN_LOG_BYTES)),
    key_findings: proseList(packet?.key_findings),
    disagreements: proseList(packet?.disagreements),
    disqualifiers_triggered: proseList(packet?.disqualifiers_triggered),
    what_would_change_my_mind: proseList(packet?.what_would_change_my_mind),
    source_ids,
    confidence: ["high", "medium", "low"].includes(packet?.confidence) ? packet.confidence : "low",
    thread_id: typeof packet?.thread_id === "string" ? packet.thread_id : undefined,
    raw_text: raw,
  };
  const readerEntries = [
    { field: "verdict", path: "/verdict", value: normalized.verdict },
    { field: "summary", path: "/summary", value: normalized.summary },
    ...["key_findings", "disagreements", "disqualifiers_triggered", "what_would_change_my_mind"]
      .flatMap((field) => normalized[field].map((value, index) => ({
        field, path: `/${field}/${index}`, value,
      }))),
  ];
  const authorityEntries = readerEntries.filter((entry) => containsProtectedRatingAuthority(entry.value));
  if (authorityEntries.length) {
    throw invalidParams(`method worker attempted to author server-owned rating authority prose for ${masterId}`, {
      reason: "METHOD_VOICE_SERVER_RATING_AUTHORITY_SPOOF",
      owner: masterId,
      invalid_fields: [...new Set(authorityEntries.map((entry) => entry.field))],
      invalid_paths: authorityEntries.map((entry) => entry.path),
    });
  }
  if (stance === "out_of_scope") {
    const directionalEntries = readerEntries.filter((entry) => containsDirectionalAbstentionToken(entry.value));
    if (directionalEntries.length) {
      throw invalidParams(`method worker added directional prose to an abstaining seat ${masterId}`, {
        reason: "METHOD_VOICE_DIRECTIONAL_ABSTENTION",
        owner: masterId,
        invalid_fields: [...new Set(directionalEntries.map((entry) => entry.field))],
        invalid_paths: directionalEntries.map((entry) => entry.path),
      });
    }
  }
  return normalized;
}

/**
 * A dedicated v3 method worker explains an already frozen decision; it never gets to
 * choose or rewrite the stance. Keeping this packet separate from normalizeMasterOpinion
 * makes a persuasive narrative incapable of overriding deterministic policy output.
 */
/**
 * A worker statement is prose that gets interpolated into a system-owned report section.
 * Left raw, a statement containing a line such as `## Conclusion` emits a real level-2
 * heading inside that section; heading assignment keeps the richest body, so the injected
 * block becomes the section the quality gate validates and the genuine PM conclusion drops
 * out of the gate's view entirely. Escape structural markdown at the trust boundary rather
 * than at each render site, so a new renderer cannot reintroduce the hole.
 */
export function sanitizeStatementMarkdown(value) {
  return sanitizeReaderInline(value);
}

const DIRECTIONAL_ABSTENTION_PATTERNS = Object.freeze([
  /\b(?:i|we)\s+(?:(?:would|will|should|could|can|must|may|might|do|does|intend\s+to|plan\s+to|choose\s+to|refuse\s+to|decline\s+to|am\s+going\s+to|want\s+to|prefer\s+to)\s+)?(?:not\s+)?(?:buy|sell|overweight|underweight|accumulate|trim)\b/iu,
  /\b(?:i|we)\s+(?:(?:would|will|should|could|can|must|may|might|intend\s+to|plan\s+to|want\s+to|prefer\s+to)\s+)?(?:not\s+)?(?:purchase|acquire|own|hold|retain|liquidate|divest|unload|dispose\s+of|invest\s+(?:in|into))\b[^.!?\n]{0,40}\b(?:stock|shares?|security|name|position|exposure|allocation|company)\b/iu,
  /\b(?:i|we)\s+(?:(?:would|will|should|could|can|must|may|might|intend\s+to|plan\s+to|want\s+to|prefer\s+to)\s+)?(?:not\s+)?(?:cash\s+out|de-?risk|stay\s+away|take\s+profits?|exit|enter|initiate|open|close)\b/iu,
  /\b(?:i|we)\s+(?:(?:would|will|should|could|can|must|may|might|intend\s+to|plan\s+to|want\s+to|prefer\s+to)\s+)?(?:not\s+)?(?:take|establish|build)\s+(?:a\s+|the\s+)?(?:stake|position|exposure)\b|\b(?:i|we)\s+(?:(?:would|will|should|could|can|must|may|might)\s+)?(?:deploy|allocate|commit)\s+(?:capital|funds?)\b/iu,
  /\b(?:i|we)\s+(?:(?:would|will|should|could|can|must|may|might|intend\s+to|plan\s+to)\s+)?(?:not\s+)?(?:add\s+to|reduce|increase|cut|pare)\s+(?:the\s+)?(?:position|exposure|allocation|stake)\b|\b(?:i|we)\s+(?:(?:would|will|should|could|can|must|may|might)\s+)?(?:be|become|remain)\s+(?:a\s+)?(?:buyer|seller|owner)\b/iu,
  /\b(?:i|we)\s+(?:(?:would|will|should|could|can|must|may|might|do|does)\s+)?(?:not\s+)?(?:recommend(?:s|ed|ing)?|consider(?:s|ed|ing)?)\s+(?:not\s+)?(?:buying|selling|holding|owning|investing|purchasing|acquiring|accumulating|trimming|overweighting|underweighting|adding\s+to|reducing|building|establishing|taking|opening|closing|exiting|entering|liquidating|divesting|unloading|allocating|deploying)\b|\b(?:i|we)\s+(?:prefer|favor)\s+(?:owning|ownership)\b/iu,
  /\b(?:i|we)\s+(?:(?:would|will|should|could|can|must|may|might)\s+)?(?:recommend|advise|advocate|favor|favour|suggest|consider)\b[^.!?\n]{0,40}\b(?:(?:buying|selling|holding|owning|investing|purchasing|acquiring|accumulating|trimming|overweighting|underweighting|liquidating|divesting|unloading)\b|(?:adding\s+to|reducing|building|establishing|taking|opening|initiating|closing|exiting|entering)\s+(?:a\s+|the\s+|this\s+|my\s+|our\s+)?(?:stake|position|exposure|allocation|stock|shares?|security|name)\b|(?:allocating|deploying|committing)\s+(?:capital|funds?)\b)/iu,
  /\b(?:i\s+am|we\s+are)\s+(?:(?:clearly|decidedly|strongly|moderately|slightly)\s+)?(?:bullish|bearish)\b|\b(?:i|we)\s+(?:(?:would|will|should|could|can|may|might|intend\s+to|plan\s+to)\s+)?(?:go|stay|remain|turn)\s+(?:long|short)\b|\b(?:i|we)\s+(?:(?:would|will|should|could|can|may|might)\s+)?take\s+(?:a\s+)?(?:long|short)\s+position\b/iu,
  /\b(?:my\s+(?:conclusion|rating)|in\s+my\s+view\s+(?:the\s+)?rating|this\s+method(?:'s)?\s+rating)\s*(?::|is|remains|would\s+be)\s*(?:a\s+)?(?:buy|sell|hold|overweight|underweight)\b|\b(?:i\s+conclude|i\s+rate|this\s+method\s+(?:rates?|says?|calls?))\b[^.!?\n]{0,80}\b(?:buy|sell|hold|overweight|underweight)\b/iu,
  /\b(?:i|we)\s+(?:(?:would|will|should|could|can|may|might|intend\s+to|plan\s+to)\s+)?(?:not\s+)?hold\s+(?:the\s+|this\s+)?(?:stock|shares?|security|name|position|exposure|allocation)\b/iu,
  /\b(?:i|we)\s+(?:(?:would|will|should|could|can|may|might|intend\s+to|plan\s+to)\s+)?(?:not\s+)?(?:avoid\s+(?:the\s+|this\s+)?(?:stock|security|name|shares?)|pass\s+on\s+(?:it|the\s+stock|this\s+stock|the\s+name|this\s+name)|build\s+(?:a\s+|the\s+)?stake|favor\s+ownership|cut\s+(?:the\s+)?(?:position|exposure|allocation)|pare\s+(?:the\s+)?(?:position|exposure|allocation))\b/iu,
  /\b(?:i|we)\s+(?:assign|set|give)\s+(?:the\s+)?(?:rating\s+(?:to|at)\s+)?(?:buy|sell|hold|overweight|underweight)\b|\b(?:i|we)\s+(?:(?:would|will|should|could|can|may|might)\s+)?go\s+(?:overweight|underweight)\b/iu,
  // A disagreement field is expected to say things such as "我不同意把增长当作买入理由".
  // Treating any trade word within thirty characters of 我 as this seat's own action made that
  // safe analytical objection indistinguishable from "我会在资料补齐后买入". Exclude the two
  // explicit disagreement constructions while retaining the bounded action search; the frozen
  // position_intent independently keeps the stance from being widened through the enum field.
  /(?:我|我们|本席|本方法)(?!(?:不同意|反对|不认可|不接受))[^。！？：:\n]{0,40}?(?:买入|卖出|加仓|减仓|增持|减持|持有|建仓|清仓|抄底|配置|购入|买进|卖掉|回避|放弃|退出|离场|入场|止盈|获利了结|继续持仓)/u,
  /(?:我|我们|本席|本方法)(?:明确|目前|仍然|整体)?(?:看多|看空|偏多|偏空|做多|做空|超配|低配)/u,
  /(?:私|私は|当席|本席|本方法)[^。！？\n]{0,50}?(?:買います|買う|買い増(?:す|し|した|せ)?|売ります|売る|売り|購入|保有|売却|見送|回避|投資|所有|手放|撤退|ポジションを取)/u,
  /(?:私|私は|当席|本席)[^。！？\n]{0,20}?(?:強気(?:です|だ)|弱気(?:です|だ)|ロング(?:です|だ|にする)|ショート(?:です|だ|にする))/u,
  /(?:저는|나는|우리는|본\s*좌석은|본\s*방법은)[^.!?\n]{0,50}?(?:추가\s*매수|매수|매도|매입|보유|진입|청산|회피|투자|소유|처분|비중을\s*(?:늘|줄))/u,
  /(?:저는|나는|우리는|본\s*좌석은)[^.!?\n]{0,20}?(?:강세(?:입니다|라고\s*봅니다)|약세(?:입니다|라고\s*봅니다)|롱\s*포지션|숏\s*포지션)/u,
  /(?:나의|제|저의|본\s*방법의)?(?:\s*)(?:결론|등급|평가)(?:은|는|이|가|:)?\s*(?:매수|매도|보유|비중\s*확대|비중\s*축소)/u,
  /(?:我的|本方法的?)(?:结论|评级|判断)(?:是|为|：|:)?(?:买入|卖出|持有|增持|减持)|(?:在我看来|我认为)(?:本方法|该股|这只股票)?(?:的)?(?:评级|结论)(?:是|为|：|:)?(?:买入|卖出|持有|增持|减持)/u,
  /(?:私の|本(?:メソッド|方法)の)(?:結論|評価)(?:は|:|：)?(?:買い|売り|中立|オーバーウェイト|アンダーウェイト)/u,
]);

function neutralizeNonDirectionalEvidence(value) {
  return String(value || "")
    .replace(/\bneither\s+(?:bullish\s+nor\s+bearish|bearish\s+nor\s+bullish)\b/giu, "directionally neutral")
    .replace(/\bnot\s+(?:bullish\s+(?:or|nor)\s+bearish|bearish\s+(?:or|nor)\s+bullish)\b/giu, "directionally neutral")
    .replace(/\b(?:i|we)\s+(?:do|would|will)\s+not\s+(?:exit|enter)\b[^.!?\n]{0,24}\b(?:or|nor)\s+(?:enter|exit)\b/giu, "remain unpositioned")
    .replace(/\b(?:analysts?|brokers?|consensus|sell[-\s]?side|buy[-\s]?side|third[-\s]?part(?:y|ies)|the\s+market)\b[^.!?\n]{0,64}\b(?:buy(?:ing)?|sell(?:ing)?|hold(?:ing)?|overweight|underweight|bullish|bearish)\b/giu, "external view")
    .replace(/\b(?:i|we)\s+(?:disagree\s+with|reject|dispute|oppose|do\s+not\s+(?:accept|treat))\b[^.!?\n]{0,100}/giu, "analytical objection")
    .replace(/\b(?:buy|sell)[-\s]+side\b|\b(?:buy|sell|hold)\s+(?:signal|recommendation)\b/giu, "market evidence")
    .replace(/\bshort[-\s]+(?:interest|selling|seller(?:s)?|squeeze|borrow(?:ing)?|covering|volume|ratio|sale(?:s)?)\b/giu, "market evidence")
    .replace(/\b(?:long|short)[-\s]+(?:term|duration|dated)\b|\bshort[-\s]+list(?:s|ed|ing)?\b/giu, "non-directional")
    .replace(/\blong\s+(?:cash\s+conversion\s+cycle|lead\s+time|operating\s+cycle|history)\b/giu, "non-directional")
    .replace(/\bshort\s+(?:operating\s+history|track\s+record|lead\s+time|cash\s+cycle)\b/giu, "non-directional")
    .replace(/\b(?:hold|holding)\s+period\b/giu, "investment horizon")
    .replace(/(?:既不|不)(?:看多|偏多)(?:也|又)(?:不)?(?:看空|偏空)|(?:既不|不)(?:看空|偏空)(?:也|又)(?:不)?(?:看多|偏多)/gu, "方向中性")
    .replace(/(?:我|我们)(?:不同意|反对|不认可|不接受|不把|不认为)[^。！？\n]{0,100}(?:买入|卖出|持有|增持|减持|看多|看空)[^。！？\n]*/gu, "分析异议")
    .replace(/(?:分析师|机构|券商|市场|一致预期)[^。！？\n]{0,64}(?:买入|卖出|持有|增持|减持|看多|看空)/gu, "外部观点")
    .replace(/(?:机构|基金|股东|内部人|管理层|投资者)[^。！？\n]{0,32}(?:持有|持仓|持股)|(?:持有期|持仓期|持股比例|持股数据)/gu, "持仓数据")
    .replace(/(?:強気|弱気)でも(?:弱気|強気)でも(?:ありません|ない|ありませんでした)/gu, "方向中立")
    .replace(/(?:アナリスト|証券会社|市場|コンセンサス)[^。！？\n]{0,64}(?:買い|売り|保有|強気|弱気)/gu, "外部見解")
    .replace(/空売り(?:比率|残高|データ|需要|コスト|統計|情報)|保有(?:期間|比率|データ)/gu, "市場データ")
    // A paired long/short phrase is research context when the same bounded phrase ends in a
    // strategy/research noun. Match intervening grammar (両方の, についての, リスク) rather
    // than enumerating separators; a later standalone stance remains outside this replacement.
    .replace(/(?:ロング|ショート)[^。！？\n]{0,40}(?:ショート|ロング)[^。！？\n]{0,40}(?:戦略|研究|ファンド|運用|分析|データ|比較|仮説|検証|証拠|検討|調査|候補|差分|論点|精査)/giu, "市場中立")
    .replace(/(?:ロング|ショート)[・\s-]*ターム/gu, "期間")
    .replace(/(?:강세|약세)도\s*(?:약세|강세)도\s*(?:아닙니다|아니다|아니었습니다)/gu, "방향 중립")
    .replace(/(?:애널리스트|증권사|시장|컨센서스)[^.!?\n]{0,64}(?:매수|매도|보유|강세|약세)/gu, "외부 견해")
    .replace(/공매도\s*(?:비율|잔고|데이터|수요|비용|통계|정보)|보유\s*(?:기간|비율|데이터|현황)/gu, "시장 데이터")
    .replace(/(?:롱|숏)[^.!?\n]{0,40}(?:숏|롱)[^.!?\n]{0,40}(?:전략|연구|펀드|운용|분석|데이터|비교|가설|검증|근거|검토|조사|후보|차이)/giu, "시장 중립")
    .replace(/(?:롱|숏)[\s-]*텀/gu, "기간");
}

function containsDirectActionClause(value) {
  const text = String(value || "");
  // Imperative or headline-style action prose has no first-person marker, so it needs a
  // separate structural gate from the first-person voice patterns above. Require an investable
  // object for ambiguous English verbs; this keeps ordinary uses such as "open questions" and
  // "build a model" available to an abstaining research seat.
  const englishActionObject = /\b(?:build(?:ing)?|establish(?:ing)?|tak(?:e|ing)|open(?:ing)?|initiat(?:e|ing)|enter(?:ing)?|clos(?:e|ing)|exit(?:ing)?|liquidat(?:e|ing)|divest(?:ing)?|unload(?:ing)?|dispos(?:e|ing)\s+of|own(?:ing)?|hold(?:ing)?|retain(?:ing)?|maintain(?:ing)?|keep(?:ing)?|purchas(?:e|ing)|acquir(?:e|ing)|buy(?:ing)?|sell(?:ing)?|long(?:ing)?|short(?:ing)?|accumulat(?:e|ing)|overweight(?:ing)?|underweight(?:ing)?|avoid(?:ing)?|add(?:ing)?\s+to|reduc(?:e|ing)|trim(?:ming)?|increas(?:e|ing)|cut(?:ting)?|par(?:e|ing))\s+(?:a\s+|the\s+|this\s+|these\s+|my\s+|our\s+)?(?:(?:long|short)\s+)?(?:stake|position|exposure|allocation|stock|shares?|security|name)\b/iu;
  const englishCapitalAction = /\b(?:deploy|allocate|commit)\s+(?:the\s+|this\s+|my\s+|our\s+)?(?:capital|funds?)\b|\b(?:stay\s+away\s+from|pass\s+on|cash\s+out\s+of|de-?risk)\s+(?:the\s+|this\s+)?(?:stock|shares?|security|name|position|stake|exposure)\b|\b(?:go|stay|remain|turn)\s+(?:decidedly\s+|clearly\s+|strongly\s+)?(?:long|short)\b/iu;
  const chineseAction = /(?:(?:应该|應該|应当|應當|应|應|建议|建議|考虑|考慮|宜)\s*)?(?:继续|繼續)?(?:持有|持仓|持倉|加仓|加倉|减仓|減倉|建仓|建倉|清仓|清倉|平仓|平倉|退出|撤退|离场|離場|入场|入場|购入|購入|买进|買進|卖掉|賣掉|抛售|拋售|回避|配置)|(?:降低|提高|增加|减少|減少|维持|維持)\s*(?:仓位|倉位|头寸|頭寸)/u;
  const japaneseAction = /(?:保有を続ける|持ち続ける|手仕舞い(?:する|す)?|(?:保有|購入|売却|撤退|回避|維持)(?:する|す)?|見送る|ポジション(?:を取る|に入る|を閉じる|を解消する|を維持(?:する|す)?|を縮小(?:する|す)?|を拡大(?:する|す)?))\s*(?:べき|ことを推奨)|(?:株|株式|銘柄|ポジション)を[^。！？\n]{0,12}(?:買って|売って|売却|保有して|手放して)(?:ください|下さい|しましょう)/u;
  const koreanAction = /(?:(?:포지션|지분|비중)(?:을|에)\s*)?(?:(?:진입|청산|보유|매입|회피|처분|유지)\s*(?:해야|합시다|하세요|할\s*것을\s*권고)|(?:늘려|줄여)\s*야)|(?:주식|종목|포지션)(?:을|를)\s*(?:사세요|팔아야|보유하세요|처분하세요|유지해야)|계속\s*들고\s*가세요|비중을\s*(?:확대|축소)하세요/u;
  return englishActionObject.test(text)
    || englishCapitalAction.test(text)
    || chineseAction.test(text)
    || japaneseAction.test(text)
    || koreanAction.test(text);
}

function containsDirectionalStanceText(value) {
  // OOS is a structural zero-direction state. Canonical ratings are rejected wherever they
  // appear in the seat's own prose, while explicit third-party/objection and market-data
  // constructions are neutralized first. Long/short is recognized only as a stance/action,
  // never merely because a method needs a long history or a position has a long settlement.
  const text = neutralizeNonDirectionalEvidence(value);
  return /\b(?:bullish|bearish)\b|(?:看多|看空|偏多|偏空|做多|做空)|(?:強気|弱気|ロング|ショート)|(?:강세|약세|롱|숏)/iu.test(text)
    || /\b(?:buy|sell|hold|overweight|underweight)\b/iu.test(text)
    || /\b(?:action|recommendation|conclusion)\s*(?::|is|would\s+be)\s*(?:to\s+)?(?:own|invest|build|establish|take|open|close|exit|enter|liquidate|divest|unload|allocate|deploy|avoid|pass|stay\s+away|cash\s+out|de-?risk)\b/iu.test(text)
    || /(?:买入|卖出|增持|减持|值得买|这只股票[^。！？\n]{0,12}(?:持有|超配|低配)|(?:结论|评级|判断|建议|行动建议)(?:是|为|：|:)?(?:应当|应该|应)?(?:买入|卖出|持有|增持|减持|建仓|清仓|退出|回避|配置)|(?:应当|应该|应)(?:建仓|清仓|退出|回避|配置))/u.test(text)
    || /(?:買い|売り|オーバーウェイト|アンダーウェイト|この株[^。！？\n]{0,12}保有|(?:結論|評価|判断|推奨|行動)(?:は|:|：)?(?:買い|売り|保有|購入|売却|見送|回避)|ポジションを(?:取る|持つ|閉じる|解消)(?:べき|ことを推奨)?)/u.test(text)
    || /(?:매수|매도|비중\s*확대|비중\s*축소|이\s*주식[^.!?\n]{0,16}보유|(?:결론|등급|평가|권고|행동)(?:은|는|이|가|:)?(?:매수|매도|보유|매입|진입|청산|회피))/u.test(text)
    || /\b(?:i\s+am|we\s+are)\s+(?:decidedly\s+|clearly\s+|strongly\s+)?(?:long|short)\b|\b(?:(?:my|this|the)\s+(?:method|seat|stance|conclusion))\s+(?:is|remain(?:s)?|stay(?:s)?|turn(?:s)?|lean(?:s)?|look(?:s)?|read(?:s)?)\s+(?:decidedly\s+|clearly\s+|strongly\s+)?(?:long|short)\b/iu.test(text)
    || /\b(?:i|we)\b[^.!?\n]{0,48}\b(?:take|open|establish|maintain)\s+(?:a\s+)?(?:long|short)\s+(?:position|stance|exposure)\b/iu.test(text)
    || /\b(?:my|our|this|the)\s+(?:position|stance|bias|exposure|book)\s+(?:is|remains|stays|looks)\s+(?:long|short)\b/iu.test(text);
}

function containsDirectionalAbstentionToken(value) {
  return readerVisibleTextCandidates(value).some((text) => {
    const decisionText = neutralizeNonDirectionalEvidence(text);
    return DIRECTIONAL_ABSTENTION_PATTERNS.some((pattern) => pattern.test(decisionText))
      || containsDirectionalStanceText(decisionText)
      || containsDirectActionClause(decisionText);
  });
}

export function normalizeMasterVoice(packet, masterId, run, frozenOpinion, raw = "") {
  // Every one of these is rendered into the system-owned bench, so all of them are escaped.
  const proseList = (value) => (Array.isArray(value)
    ? value.map(sanitizeStatementMarkdown).filter(Boolean)
    : []);
  const stringList = (value) => (Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : []);
  if (packet?.master !== masterId) {
    throw invalidParams(`dedicated method worker returned the wrong master id for ${masterId}`, {
      reason: "METHOD_VOICE_MASTER_MISMATCH",
      owner: masterId,
    });
  }
  if (packet?.acknowledged_stance !== frozenOpinion?.stance) {
    throw invalidParams(`dedicated method worker attempted to change frozen stance for ${masterId}`, {
      reason: "METHOD_VOICE_STANCE_MISMATCH",
      owner: masterId,
    });
  }
  if (packet?.voice_mode !== FIRST_PERSON_VOICE_MODE) {
    throw invalidParams(`dedicated method worker did not use the required first-person voice mode for ${masterId}`, {
      reason: "METHOD_VOICE_MODE_MISMATCH",
      owner: masterId,
    });
  }
  if (packet?.disclosure_ack !== FIRST_PERSON_DISCLOSURE_ACK) {
    throw invalidParams(`dedicated method worker did not acknowledge the fixed identity disclosure for ${masterId}`, {
      reason: "METHOD_VOICE_DISCLOSURE_ACK_MISMATCH",
      owner: masterId,
    });
  }
  const voice = Object.fromEntries(VOICE_FIELDS
    .map((field) => [field, sanitizeStatementMarkdown(packet?.voice?.[field])])
    .filter(([, text]) => text));
  const proseArrays = Object.fromEntries([
    "key_findings",
    "disagreements",
    "what_would_change_my_mind",
  ].map((field) => [field, proseList(packet?.[field])]));
  const evidencePacketAcks = assertCompanyDossierPacketAcks(packet, run, `master voice ${masterId}`)
    .map((ack) => ({ ...ack, note: sanitizeStatementMarkdown(ack.note) }));
  const missingVoiceFields = VOICE_FIELDS.filter((field) => !voice[field]);
  if (missingVoiceFields.length) {
    throw invalidParams(`dedicated method worker omitted required first-person voice fields for ${masterId}: ${missingVoiceFields.join(", ")}`, {
      reason: "METHOD_VOICE_FIELDS_MISSING",
      owner: masterId,
      missing_fields: missingVoiceFields,
    });
  }
  const authorityEntries = [
    ...VOICE_FIELDS.map((field) => ({ field, path: `/voice/${field}`, value: voice[field] })),
    ...Object.entries(proseArrays).flatMap(([field, values]) => values.map((value, index) => ({
      field,
      path: `/${field}/${index}`,
      value,
    }))),
    ...evidencePacketAcks.map((ack, index) => ({
      field: "evidence_packet_acks",
      path: `/evidence_packet_acks/${index}/note`,
      value: ack.note,
    })),
  ].filter((entry) => containsProtectedRatingAuthority(entry.value));
  if (authorityEntries.length) {
    throw invalidParams(`dedicated method worker attempted to author server-owned rating authority prose for ${masterId}`, {
      reason: "METHOD_VOICE_SERVER_RATING_AUTHORITY_SPOOF",
      owner: masterId,
      invalid_fields: [...new Set(authorityEntries.map((entry) => entry.field))],
      invalid_paths: authorityEntries.map((entry) => entry.path),
    });
  }
  // Reject directional abstention text before checking voice style. An out-of-scope worker
  // must not evade the zero-direction contract merely by phrasing its view as "this method is
  // bearish" instead of using a first-person construction.
  if (frozenOpinion?.stance === "out_of_scope") {
    const directionalEntries = [
      ...VOICE_FIELDS.flatMap((field) => (
        containsDirectionalAbstentionToken(voice[field])
          ? [{ field, path: `/voice/${field}` }]
          : []
      )),
      ...Object.entries(proseArrays).flatMap(([field, values]) => values.flatMap((value, index) => (
        containsDirectionalAbstentionToken(value)
          ? [{ field, path: `/${field}/${index}` }]
          : []
      ))),
      ...evidencePacketAcks.flatMap((ack, index) => (
        containsDirectionalAbstentionToken(ack.note)
          ? [{ field: "evidence_packet_acks", path: `/evidence_packet_acks/${index}/note` }]
          : []
      )),
    ];
    if (directionalEntries.length) {
      const directionalFields = [...new Set(directionalEntries.map((entry) => entry.field))];
      const directionalPaths = directionalEntries.map((entry) => entry.path);
      throw invalidParams(`dedicated method worker added directional prose to an abstaining seat ${masterId}: ${directionalPaths.join(", ")}`, {
        reason: "METHOD_VOICE_DIRECTIONAL_ABSTENTION",
        owner: masterId,
        // Preserve the coarse field list for existing clients while making every rejected array
        // item and voice field independently auditable through an exact JSON Pointer.
        invalid_fields: directionalFields,
        invalid_paths: directionalPaths,
      });
    }
  }
  // Target-language validation runs immediately after normalization. This gate asks the
  // orthogonal question: did the worker use first person at all? Keeping the checks separate
  // means an English "I" in a Chinese run is reported as a language mismatch, not parse failure.
  const thirdPersonFields = VOICE_FIELDS.filter((field) => !hasAnyFirstPersonMarker(voice[field]));
  if (thirdPersonFields.length) {
    throw invalidParams(`dedicated method worker returned non-first-person method prose for ${masterId}: ${thirdPersonFields.join(", ")}`, {
      reason: "METHOD_VOICE_FIRST_PERSON_MISMATCH",
      owner: masterId,
      invalid_fields: thirdPersonFields,
    });
  }
  const statement = composeVoiceStatement(voice, run.language);

  // Intent narrows the frozen stance; it never reopens it. Rejected the same way a changed
  // stance is, so a worker cannot turn `opposed` into `would_buy` by choosing a label.
  const requested = packet?.position_intent;
  if (requested === undefined) {
    throw invalidParams(`dedicated method worker omitted position_intent for ${masterId}`, {
      reason: "METHOD_VOICE_POSITION_INTENT_MISSING",
      owner: masterId,
    });
  }
  if (!isIntentAllowed(requested, frozenOpinion.stance)) {
    throw invalidParams(
      `dedicated method worker returned an intent outside the frozen stance for ${masterId}: `
      + `${JSON.stringify(requested)} is not one of ${intentsForStance(frozenOpinion.stance).join(", ")}`,
      {
        reason: "METHOD_VOICE_POSITION_INTENT_MISMATCH",
        owner: masterId,
      },
    );
  }

  const workerSourceIds = stringList(packet?.source_ids);
  const frozenEvidenceSourceIds = sourceIdList(
    frozenOpinion?.evidence_source_ids || frozenOpinion?.source_ids || [],
  );
  const methodSourceIds = sourceIdList(frozenOpinion?.method_source_ids || []);
  assertSourceIdsResolve(run, methodSourceIds, `${masterId} method provenance`, {
    allowEmpty: true,
    domain: "method_provenance",
  });
  assertSourceIdsResolve(run, frozenEvidenceSourceIds, `${masterId} frozen evidence`, {
    allowEmpty: frozenOpinion.stance === "out_of_scope",
    domain: "evidence",
  });
  assertSourceIdsResolve(
    run,
    workerSourceIds,
    `${masterId} worker evidence`,
    {
      allowEmpty: frozenOpinion.stance === "out_of_scope" && !requiresOperatingCompanyDossier(run),
      domain: "evidence",
    },
  );
  const allowedSourceIds = methodVoiceAllowedSourceIds(run, frozenOpinion);
  const allowed = new Set(allowedSourceIds);
  const outsideAllowed = workerSourceIds.filter((id) => !allowed.has(id));
  if (outsideAllowed.length) {
    throw invalidParams(`${masterId} cited evidence IDs outside its bounded method-voice context: ${outsideAllowed.join(", ")}`, {
      reason: "METHOD_VOICE_SOURCE_SCOPE_MISMATCH",
      owner: masterId,
      unknown_source_ids: outsideAllowed,
      allowed_source_ids: allowedSourceIds,
    });
  }
  const frozenConfidence = ["high", "medium", "low"].includes(frozenOpinion?.confidence)
    ? frozenOpinion.confidence
    : "low";

  return {
    master: masterId,
    symbol: run.symbol,
    as_of: run.as_of,
    acknowledged_stance: frozenOpinion.stance,
    voice_mode: FIRST_PERSON_VOICE_MODE,
    disclosure_ack: FIRST_PERSON_DISCLOSURE_ACK,
    disclosure: voiceDisclaimer(run.language),
    position_intent: requested,
    voice: Object.keys(voice).length ? voice : null,
    statement,
    key_findings: proseArrays.key_findings,
    disagreements: proseArrays.disagreements,
    what_would_change_my_mind: proseArrays.what_would_change_my_mind,
    source_ids: workerSourceIds,
    // Confidence belongs to the deterministic decision. The voice worker can explain the view,
    // but cannot strengthen or weaken the signal that downstream advocates receive.
    confidence: frozenConfidence,
    company_dossier_hash_ack: typeof packet?.company_dossier_hash_ack === "string"
      ? packet.company_dossier_hash_ack
      : undefined,
    evidence_packet_acks: evidencePacketAcks,
    language: run.language,
    raw_text: raw,
  };
}

/** Compact master opinions for injection into the debate prompt. */
export function compactMasterOpinions(run) {
  const panelContext = run?.master_selection?.method_panel_context;
  const calibrated = panelContext?.schema_version === 1;
  const decisions = new Map((panelContext?.decisions || [])
    .map((decision) => [decision.master_id, decision]));
  return (run.master_opinions || []).flatMap((opinion) => {
    const decision = decisions.get(opinion.master);
    const contribution = opinion.stance === "out_of_scope"
      ? "none"
      : decision?.rating_contribution || (calibrated ? "none" : "primary");
    // Calibrated supporting/context methods have exactly one downstream route: the PM's
    // non-directional risk context. Sending them to Bull/Bear as well would let the same finding
    // influence the rating twice. Out-of-scope methods never enter a directional advocate path.
    if (opinion.stance === "out_of_scope" || (calibrated && contribution !== "primary")) return [];
    return [{
      roles: decision?.roles || [],
      rating_contribution: contribution,
      master: opinion.master,
      stance: opinion.stance,
      verdict: opinion.verdict,
      key_findings: opinion.key_findings,
      disagreements: opinion.disagreements,
      disqualifiers_triggered: opinion.disqualifiers_triggered,
      confidence: opinion.confidence,
    }];
  });
}

/**
 * Preserve non-directional method risk without letting the PM count a method stance twice.
 *
 * Directional method reasoning reaches the PM once, through Bull/Bear. Supporting and context
 * lenses can still carry a hard veto or an invalidation condition that neither advocate should
 * be allowed to erase. Out-of-scope seats stay solely in the separately rendered method bench:
 * excluding them from the PM prompt makes zero rating influence structural instead of relying on
 * model compliance. This projection deliberately contains no stance, verdict, action intent,
 * seat weight, share or vote count.
 */
export function compactMethodRiskContext(run) {
  const panelContext = run?.master_selection?.method_panel_context;
  // Legacy runs already send method opinions through Bull/Bear. Without a bound calibrated
  // taxonomy, adding the same opinions here would expose them to the PM a second time.
  if (panelContext?.schema_version !== 1) return [];
  const decisions = new Map((panelContext.decisions || [])
    .map((decision) => [decision.master_id, decision]));
  const compactBasis = (value) => (Array.isArray(value) ? value.slice(0, 12).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const basis = {
      fact_id: typeof item.fact_id === "string" ? item.fact_id : null,
      producer_id: typeof item.producer_id === "string" ? item.producer_id : null,
      derivation: typeof item.derivation === "string" ? item.derivation : null,
      confidence: typeof item.confidence === "number" && Number.isFinite(item.confidence)
        ? item.confidence : null,
    };
    return Object.values(basis).some((entry) => entry !== null) ? [basis] : [];
  }) : []);
  return (run?.master_opinions || []).flatMap((opinion, opinionIndex) => {
    const decision = decisions.get(opinion.master);
    if (!decision) return [];
    if (opinion.stance === "out_of_scope") return [];
    const contribution = decision?.rating_contribution || "none";
    if (contribution === "primary") return [];
    const riskFindings = [
      ...(opinion.disqualifiers_triggered || []),
      ...(opinion.common_projection?.veto_ids || []),
    ].filter((value) => typeof value === "string" && value.trim());
    const reopenConditions = (opinion.what_would_change_my_mind || [])
      .filter((value) => typeof value === "string" && value.trim());
    const dataGaps = (opinion.missing_required_fact_types || [])
      .filter((value) => typeof value === "string" && value.trim());
    const evidenceQualityBasis = compactBasis(opinion.evidence_quality_basis);
    if (!riskFindings.length && !reopenConditions.length && !dataGaps.length
      && !evidenceQualityBasis.length && !opinion.evidence_quality) return [];
    // `source_ids` may include citations added by the explanation worker. Only the frozen
    // deterministic evidence ledger can authorize a PM rating adjustment.
    const deterministicSourceIds = Array.isArray(opinion.evidence_source_ids)
      ? opinion.evidence_source_ids
      : opinion.source_ids || [];
    const sourceIds = deterministicSourceIds.slice(0, 20);
    const ratingAdjustmentEligible = sourceIds.length > 0 && (
      riskFindings.length > 0 || ["estimated_only", "mixed"].includes(opinion.evidence_quality)
    );
    return [{
      context_id: `method_context_${opinionIndex + 1}`,
      coverage_roles: decision?.roles || [],
      rating_contribution: contribution,
      directional_vote_allowed: false,
      scope_status: "in_scope",
      rating_adjustment_eligible: ratingAdjustmentEligible,
      risk_or_veto_ids: [...new Set(riskFindings)].slice(0, 12),
      data_gaps: [...new Set(dataGaps)].slice(0, 12),
      reopen_conditions: [...new Set(reopenConditions)].slice(0, 8).map((item) => clip(item, 500)),
      evidence_quality: opinion.evidence_quality || null,
      evidence_quality_basis: evidenceQualityBasis,
      source_ids: sourceIds,
    }];
  });
}

/**
 * Server-owned causal ledger for the PM's optional one-notch downside adjustment.
 *
 * A source ID proves where a fact came from, not why a second penalty is warranted. Requiring a
 * stable context ID prevents arbitrary prose (or an out-of-scope method) from turning any valid
 * citation into a downgrade. Base-case evidence without one of these contexts belongs in the
 * return estimate itself.
 */
export function pmRatingAdjustmentContexts(run) {
  const methodContexts = compactMethodRiskContext(run)
    .filter((context) => context.rating_adjustment_eligible === true)
    .map((context) => ({
      context_id: context.context_id,
      context_type: "method_risk",
      source_ids: [...new Set(context.source_ids || [])],
    }));
  const claims = new Map(allEvidenceClaims(run).map((claim) => [claim.claim_id, claim]));
  const verificationContexts = hardVerificationFindings(run).flatMap((finding) => {
    const claim = claims.get(finding.claim_id);
    const sourceIds = [...new Set((claim?.source_ids || []).map((id, index) => (
      scopedSourceId(claim.task, id, index)
    )))];
    if (!sourceIds.length) return [];
    return [{
      context_id: `verification:${finding.finding_id}`,
      context_type: "hard_verification_finding",
      source_ids: sourceIds,
    }];
  });
  const seen = new Set();
  return [...methodContexts, ...verificationContexts].filter((context) => {
    if (!context.context_id || seen.has(context.context_id) || !context.source_ids.length) return false;
    seen.add(context.context_id);
    return true;
  });
}
