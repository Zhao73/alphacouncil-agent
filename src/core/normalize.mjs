// Deterministic clean-up of model packets. The schema guarantees shape; this enforces meaning
// (citations resolve, dates are dates, bear <= base <= bull) without spending another model call.
// Every change is reported as a warning and saved with the run.

const LOCAL = /^S\d{1,3}$/;
const cleanId = (id) => String(id ?? "").trim().replace(/^\[|\]$/g, "");

function normDate(raw, asOf) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const iso = s.match(/^(\d{4})(-\d{2})?(-\d{2})?/);
  let out = iso ? iso[0] : "";
  if (!out) {
    const t = Date.parse(s);
    out = Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
  }
  if (out && asOf && out > asOf) return "";
  return out;
}

/** Known citation IDs for a run: snapshot sources, lenses and recorded desk sources. */
export function knownIds(snapshot, desks = {}) {
  const ids = new Set(Object.keys(snapshot.sources || {}));
  for (const l of snapshot.lenses || []) ids.add(`lens:${l.id}`);
  for (const [desk, p] of Object.entries(desks)) for (const s of p?.sources || []) ids.add(`${desk}:${s.id}`);
  return ids;
}

export function normalizeDesk(p, { desk, snapshot, asOf }) {
  const warnings = [];
  const sources = [];
  const seen = new Set();
  for (const s of p.sources || []) {
    const id = cleanId(s.id);
    if (!LOCAL.test(id) || seen.has(id)) {
      warnings.push(`dropped source with bad or duplicate id ${JSON.stringify(s.id)}`);
      continue;
    }
    if (!/^https?:\/\//.test(String(s.url || ""))) {
      warnings.push(`dropped source ${id}: no http(s) URL`);
      continue;
    }
    seen.add(id);
    sources.push({ id, title: String(s.title || s.url).slice(0, 300), url: s.url, date: normDate(s.date, asOf) });
  }
  const local = new Set(sources.map((s) => s.id));
  const global = knownIds(snapshot);
  const findings = [];
  for (const f of p.findings || []) {
    const refs = [...new Set((f.sources || []).map(cleanId))].filter((id) => local.has(id) || global.has(id));
    if (!refs.length) {
      warnings.push(`dropped unsourced finding: ${String(f.claim).slice(0, 80)}`);
      continue;
    }
    findings.push({ claim: f.claim, impact: f.impact, sources: refs });
  }
  return {
    packet: {
      summary: p.summary,
      stance: p.stance,
      findings: findings.slice(0, 10),
      key_numbers: (p.key_numbers || []).filter((k) => k && k.label && k.value).map((k) => ({ label: k.label, value: String(k.value), source: local.has(cleanId(k.source)) || global.has(cleanId(k.source)) ? cleanId(k.source) : "" })).slice(0, 12),
      sources,
      gaps: (p.gaps || []).filter(Boolean),
    },
    warnings,
    ok: findings.length >= 2,
    desk,
  };
}

function filterRefs(list, known, warnings, where) {
  const out = [];
  for (const raw of list || []) {
    const id = cleanId(raw);
    if (known.has(id)) out.push(id);
    else warnings.push(`${where}: removed unknown citation ${JSON.stringify(raw)}`);
  }
  return [...new Set(out)];
}

export function normalizeCase(p, { known }) {
  const warnings = [];
  const points = (p.points || []).map((x, i) => ({ point: x.point, evidence: filterRefs(x.evidence, known, warnings, `points[${i}]`) }));
  return { packet: { ...p, points }, warnings, ok: points.length >= 2 };
}

export function normalizeDecision(p, { known, snapshot }) {
  const warnings = [];
  const v = { ...p.valuation };
  const vals = [v.bear, v.base, v.bull].map(Number);
  if (vals.every((x) => Number.isFinite(x) && x > 0) && !(vals[0] <= vals[1] && vals[1] <= vals[2])) {
    [v.bear, v.base, v.bull] = [...vals].sort((a, b) => a - b);
    warnings.push("valuation re-ordered to bear <= base <= bull");
  }
  const quoteCcy = snapshot.quote?.currency;
  if (quoteCcy && v.currency && v.currency !== quoteCcy) warnings.push(`valuation currency ${v.currency} differs from quote currency ${quoteCcy}`);
  return {
    packet: { ...p, valuation: v, key_sources: filterRefs(p.key_sources, known, warnings, "key_sources") },
    warnings,
    ok: true,
  };
}
