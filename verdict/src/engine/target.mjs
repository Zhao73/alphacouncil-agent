// Turn free text into { symbol, question }: "is 0700.HK cheap?" → 0700.HK + the question;
// "microsoft earnings" → MSFT via symbol search when no ticker is written.

import * as data from "./data.mjs";

const TICKER = /^\^?[A-Za-z0-9]{1,6}(?:[.-][A-Za-z0-9]{1,4})?$/;
const STOP = new Set(["IS", "IT", "A", "AN", "THE", "BUY", "SELL", "HOLD", "NOW", "OR", "AND", "TO", "OF", "IN", "ON", "FOR", "ME", "MY", "I", "DO", "WHAT", "HOW", "WHY", "CAN", "SHOULD", "EPS", "PE", "AI", "CEO", "ETF", "IPO", "USD", "Q1", "Q2", "Q3", "Q4"]);

export async function resolveTarget(text, { search = data.searchSymbol } = {}) {
  const raw = Array.isArray(text) ? text.join(" ") : String(text || "");
  const clean = raw.trim();
  if (!clean) return null;
  const tokens = clean.split(/[\s,，。？?！!、:：]+/).filter(Boolean);
  const candidates = tokens.filter((tk) => TICKER.test(tk) && /[A-Za-z^]/.test(tk));
  const upper = candidates.filter((tk) => tk === tk.toUpperCase() && /[A-Z]/.test(tk) && !STOP.has(tk));
  const pick = candidates.find((tk) => /[.^]/.test(tk) && /[A-Za-z0-9]{2}/.test(tk)) || upper[0] || (candidates.length === 1 && tokens.length <= 6 && !STOP.has(candidates[0].toUpperCase()) ? candidates[0] : null);
  if (pick) return { symbol: data.normalizeSymbol(pick), question: clean.replace(pick, "").replace(/\s{2,}/g, " ").replace(/^[\s,，:：]+/, "").trim() };
  const found = (await search(clean).catch(() => null)) || (tokens[0] ? await search(tokens[0]).catch(() => null) : null);
  return found ? { symbol: data.normalizeSymbol(found.symbol), question: clean } : null;
}
