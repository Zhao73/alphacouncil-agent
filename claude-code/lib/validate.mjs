// Packet validators. Errors are phrased as repair instructions so a worker can fix its own
// packet in one bounded retry.

import { RATINGS } from "./spec.mjs";

const SIGNALS = ["bullish", "bearish", "neutral", "mixed"];
const IMPACTS = ["bullish", "bearish", "neutral", "mixed"];
const LEVELS = ["low", "medium", "high"];
const LOCAL_ID = /^S\d{1,3}$/;
export const GLOBAL_ID = /^[a-z_]+:[A-Za-z0-9_]+$/;

function ctx() {
  const errors = [];
  const warnings = [];
  const str = (v, path, min = 1, max = 20000) => {
    if (typeof v !== "string" || v.trim().length < min) errors.push(`${path}: required string (min ${min} chars)`);
    else if (v.length > max) errors.push(`${path}: too long (max ${max} chars)`);
  };
  const oneOf = (v, path, values) => {
    if (!values.includes(v)) errors.push(`${path}: must be one of ${values.join(" | ")}`);
  };
  const arr = (v, path, min = 0, max = 100) => {
    if (!Array.isArray(v)) {
      errors.push(`${path}: required array`);
      return false;
    }
    if (v.length < min) errors.push(`${path}: needs at least ${min} item(s)`);
    if (v.length > max) errors.push(`${path}: at most ${max} item(s)`);
    return true;
  };
  const obj = (v, path) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      errors.push(`${path}: required object`);
      return false;
    }
    return true;
  };
  return { errors, warnings, str, oneOf, arr, obj };
}

const PARTIAL_DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

/** Keep YYYY, YYYY-MM and YYYY-MM-DD (and ISO timestamps); drop anything else with a warning. */
function normalizeSourceDates(p, warnings) {
  if (!Array.isArray(p?.sources)) return;
  p.sources.forEach((s, i) => {
    if (!s || typeof s !== "object" || s.date === undefined || s.date === null) return;
    const raw = String(s.date).trim();
    const iso = raw.match(/^(\d{4}-\d{2}-\d{2})T/);
    if (iso) s.date = iso[1];
    else if (!raw) delete s.date;
    else if (!PARTIAL_DATE.test(raw)) {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) s.date = new Date(parsed).toISOString().slice(0, 10);
      else {
        warnings.push(`sources[${i}].date ${JSON.stringify(raw)} is not a date; dropped`);
        delete s.date;
      }
    }
  });
}

export function validateEvidence(p, { maxFindings = 14, role = "", asOf = null } = {}) {
  const c = ctx();
  if (!c.obj(p, "packet")) return c;
  c.str(p.summary, "summary", 40, 2000);
  c.oneOf(p.signal, "signal", SIGNALS);
  c.oneOf(p.confidence, "confidence", LEVELS);
  normalizeSourceDates(p, c.warnings);
  const ids = new Set();
  if (c.arr(p.sources, "sources", 1, 40)) {
    p.sources.forEach((s, i) => {
      if (!c.obj(s, `sources[${i}]`)) return;
      if (!LOCAL_ID.test(s.id || "")) c.errors.push(`sources[${i}].id: use local IDs S1, S2, ... (got ${JSON.stringify(s.id)})`);
      else if (ids.has(s.id)) c.errors.push(`sources[${i}].id: duplicate ${s.id}`);
      else ids.add(s.id);
      c.str(s.title, `sources[${i}].title`, 3, 400);
      if (typeof s.url !== "string" || !/^(https?:\/\/|tool:)/.test(s.url)) c.errors.push(`sources[${i}].url: an http(s) URL, or tool:<tool_name> for data returned by a tool`);
      if (asOf && s.date && String(s.date).slice(0, 10) > asOf) c.errors.push(`sources[${i}].date: ${s.date} is after the run date ${asOf}`);
    });
  }
  if (c.arr(p.findings, "findings", 3, maxFindings)) {
    p.findings.forEach((f, i) => {
      if (!c.obj(f, `findings[${i}]`)) return;
      c.str(f.claim, `findings[${i}].claim`, 15, 1500);
      c.oneOf(f.impact, `findings[${i}].impact`, IMPACTS);
      if (c.arr(f.sources, `findings[${i}].sources`, 1, 10)) {
        for (const id of f.sources) if (!ids.has(id)) c.errors.push(`findings[${i}].sources: ${JSON.stringify(id)} is not in this packet's sources list`);
      }
    });
  }
  if (c.arr(p.data_gaps, "data_gaps", 0, 30)) p.data_gaps.forEach((g, i) => c.str(g, `data_gaps[${i}]`, 3, 600));
  if (p.metrics !== undefined && (typeof p.metrics !== "object" || Array.isArray(p.metrics))) c.errors.push("metrics: object of name -> value, or omit");
  if (role === "news_industry_management" && asOf && Array.isArray(p.sources)) {
    const floor = new Date(Date.parse(asOf) - 120 * 864e5).toISOString().slice(0, 10);
    const stale = p.sources.filter((s) => s.date && String(s.date).slice(0, 10) < floor);
    if (stale.length) c.warnings.push(`${stale.length} source(s) older than the 120-day news window; keep them only as background, not as recent news`);
  }
  return c;
}

function checkEvidenceRefs(c, list, path, known, max = 12) {
  if (!c.arr(list, path, 1, max)) return;
  for (const id of list) {
    if (typeof id !== "string" || !GLOBAL_ID.test(id)) c.errors.push(`${path}: ${JSON.stringify(id)} must be a global ID like market_data:S1, grounding:quote or lens:deep_value`);
    else if (!known.has(id)) c.errors.push(`${path}: ${id} does not exist in this run (read the briefing's source list)`);
  }
}

export function validateDebate(p, { round, known, opponentQuestions = [] }) {
  const c = ctx();
  if (!c.obj(p, "packet")) return c;
  if (round === 1) {
    c.str(p.thesis, "thesis", 40, 3000);
    if (c.arr(p.arguments, "arguments", 2, 8)) {
      p.arguments.forEach((a, i) => {
        if (!c.obj(a, `arguments[${i}]`)) return;
        c.str(a.point, `arguments[${i}].point`, 20, 2000);
        checkEvidenceRefs(c, a.evidence, `arguments[${i}].evidence`, known);
      });
    }
    if (p.concessions !== undefined) c.arr(p.concessions, "concessions", 0, 6);
  } else if (round === 2) {
    if (c.arr(p.rebuttals, "rebuttals", 1, 6)) {
      p.rebuttals.forEach((r, i) => {
        if (!c.obj(r, `rebuttals[${i}]`)) return;
        c.str(r.target, `rebuttals[${i}].target`, 5, 600);
        c.str(r.response, `rebuttals[${i}].response`, 20, 2000);
        checkEvidenceRefs(c, r.evidence, `rebuttals[${i}].evidence`, known);
      });
    }
    if (c.arr(p.questions, "questions", 1, 3)) {
      const seen = new Set();
      p.questions.forEach((q, i) => {
        if (!c.obj(q, `questions[${i}]`)) return;
        if (!/^Q[1-3]$/.test(q.id || "")) c.errors.push(`questions[${i}].id: Q1, Q2 or Q3`);
        if (seen.has(q.id)) c.errors.push(`questions[${i}].id: duplicate ${q.id}`);
        seen.add(q.id);
        c.str(q.question, `questions[${i}].question`, 15, 800);
      });
    }
  } else if (round === 3) {
    const expected = opponentQuestions.map((q) => q.id);
    if (c.arr(p.answers, "answers", expected.length, expected.length)) {
      const got = p.answers.map((a) => a?.question_id);
      for (const id of expected) if (!got.includes(id)) c.errors.push(`answers: missing an answer for opponent question ${id}`);
      p.answers.forEach((a, i) => {
        if (!c.obj(a, `answers[${i}]`)) return;
        if (!expected.includes(a.question_id)) c.errors.push(`answers[${i}].question_id: ${JSON.stringify(a.question_id)} is not an opponent question (${expected.join(", ")})`);
        c.str(a.answer, `answers[${i}].answer`, 20, 2000);
        checkEvidenceRefs(c, a.evidence, `answers[${i}].evidence`, known);
      });
    }
    c.str(p.closing, "closing", 30, 2000);
  }
  return c;
}

export function validatePm(p, { known, mode = "full" }) {
  const c = ctx();
  if (!c.obj(p, "packet")) return c;
  c.oneOf(p.rating, "rating", RATINGS);
  c.str(p.conclusion, "conclusion", 60, 4000);
  c.oneOf(p.confidence, "confidence", LEVELS);
  c.str(p.confidence_rationale, "confidence_rationale", 20, 1500);
  c.oneOf(p.debate_winner, "debate_winner", ["bull", "bear", "balanced"]);
  c.str(p.debate_assessment, "debate_assessment", 40, 3000);
  c.str(p.long_thesis, "long_thesis", 40, 3000);
  c.str(p.short_thesis, "short_thesis", 40, 3000);
  c.str(p.market_expectations, "market_expectations", 40, 3000);
  if (c.obj(p.valuation, "valuation")) {
    const v = p.valuation;
    for (const k of ["bear", "base", "bull"]) if (!(Number(v[k]) > 0)) c.errors.push(`valuation.${k}: positive number (per-share value)`);
    if (Number(v.bear) > Number(v.base) || Number(v.base) > Number(v.bull)) c.errors.push("valuation: must satisfy bear <= base <= bull");
    c.str(v.currency, "valuation.currency", 3, 3);
    c.str(v.method, "valuation.method", 10, 1500);
  }
  if (c.arr(p.price_levels, "price_levels", 3, 6)) {
    p.price_levels.forEach((l, i) => {
      if (!c.obj(l, `price_levels[${i}]`)) return;
      c.str(l.range, `price_levels[${i}].range`, 2, 80);
      c.str(l.meaning, `price_levels[${i}].meaning`, 10, 600);
      c.str(l.action, `price_levels[${i}].action`, 3, 300);
    });
  }
  if (c.arr(p.catalysts, "catalysts", 2, 10)) {
    p.catalysts.forEach((x, i) => {
      if (!c.obj(x, `catalysts[${i}]`)) return;
      c.str(x.event, `catalysts[${i}].event`, 5, 600);
      c.str(x.timing, `catalysts[${i}].timing`, 2, 100);
      c.oneOf(x.direction, `catalysts[${i}].direction`, ["positive", "negative", "either"]);
    });
  }
  if (c.arr(p.risks, "risks", 3, 10)) {
    p.risks.forEach((x, i) => {
      if (!c.obj(x, `risks[${i}]`)) return;
      c.str(x.risk, `risks[${i}].risk`, 10, 800);
      c.oneOf(x.severity, `risks[${i}].severity`, LEVELS);
    });
  }
  if (c.obj(p.position, "position")) {
    for (const k of ["action", "sizing", "entry", "exit"]) c.str(p.position[k], `position.${k}`, 3, 800);
  }
  if (mode === "full" || p.horizons !== undefined) {
    if (c.obj(p.horizons, "horizons")) for (const k of ["short_term", "medium_term", "long_term"]) c.str(p.horizons[k], `horizons.${k}`, 20, 1500);
  }
  if (c.arr(p.invalidation, "invalidation", 2, 8)) p.invalidation.forEach((x, i) => c.str(x, `invalidation[${i}]`, 10, 600));
  if (c.arr(p.data_gaps, "data_gaps", 0, 30)) p.data_gaps.forEach((x, i) => c.str(x, `data_gaps[${i}]`, 3, 600));
  checkEvidenceRefs(c, p.key_sources, "key_sources", known, 25);
  return c;
}

/** Workers sometimes send the packet as a JSON string or wrapped in a code fence. */
export function coercePacket(packet) {
  if (typeof packet !== "string") return packet;
  const trimmed = packet.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return packet;
  }
}
