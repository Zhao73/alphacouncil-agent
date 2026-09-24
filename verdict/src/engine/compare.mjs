// Compare several tickers: research each (a few at a time), then one ranking call over the
// finished verdicts. Saved under ~/.verdict/compare/<id>/.

import { join } from "node:path";
import { normalizeLanguage } from "./i18n.mjs";
import { languageLine } from "./prompts.mjs";
import { research } from "./pipeline.mjs";
import { upside } from "../render/markdown.mjs";
import { homeDir, newRunId, writeJson, writeText } from "./store.mjs";
import { normalizeSymbol } from "./data.mjs";

const str = (description) => ({ type: "string", description });
export const RANK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "ranking"],
  properties: {
    summary: str("2-4 sentences: which is the best idea now and why, answering the user's question if any"),
    ranking: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["symbol", "rank", "why"],
        properties: { symbol: str("ticker"), rank: { type: "number", description: "1 = most attractive" }, why: str("one sentence") },
      },
    },
  },
};

async function pool(items, limit, fn) {
  const queue = items.map((x, i) => [x, i]);
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length) {
      const [x, i] = queue.shift();
      out[i] = await fn(x);
    }
  }));
  return out;
}

function brief(run) {
  const d = run.decision;
  if (!d) return `${run.symbol}: no verdict (${run.state}: ${run.reason})`;
  const up = upside(run);
  return [
    `${run.symbol}${run.name ? ` (${run.name})` : ""}: ${d.rating}, confidence ${d.confidence}; price ${run.snapshot?.quote?.price ?? "n/a"} ${run.snapshot?.quote?.currency ?? ""}; value ${d.valuation.bear}/${d.valuation.base}/${d.valuation.bull}${up === null ? "" : ` (${up.toFixed(0)}% to base)`}`,
    `  conclusion: ${d.conclusion}`,
    `  top risks: ${d.risks.slice(0, 3).map((r) => r.risk).join("; ")}`,
  ].join("\n");
}

export async function compare({ symbols, mode = "fast", language = "en", question = "", backend, onEvent = () => {}, signal, concurrency = 3 }) {
  const list = [...new Set(symbols.map(normalizeSymbol))];
  if (list.length < 2) throw new Error("compare needs at least two tickers");
  const id = newRunId(list.join("-").slice(0, 30));
  const started = Date.now();
  onEvent({ type: "compare", id, symbols: list });
  const runs = await pool(list, concurrency, (symbol) => research({ symbol, mode, language, question, backend, signal, onEvent: (e) => onEvent({ ...e, symbol }) }));
  const decided = runs.filter((r) => r.decision);
  let ranking = null;
  let cost = runs.reduce((a, r) => a + (r.cost_usd || 0), 0);
  if (decided.length >= 2) {
    onEvent({ type: "stage", stage: "ranking" });
    const r = await backend.call({
      tier: "decision",
      system: `You rank investment ideas that a research team already analysed. Use only the verdicts given; do not invent numbers. Rank by risk-adjusted attractiveness at today's prices. ${languageLine(normalizeLanguage(language))}`,
      user: `${question ? `The user asks: ${question}\n\n` : ""}${decided.map(brief).join("\n\n")}`,
      schema: RANK_SCHEMA,
      effort: "medium",
      timeoutMs: 180_000,
      signal,
    });
    cost += r.costUsd || 0;
    const known = new Set(decided.map((x) => x.symbol));
    ranking = { summary: r.data.summary, ranking: r.data.ranking.filter((x) => known.has(String(x.symbol).toUpperCase())).sort((a, b) => a.rank - b.rank) };
  }
  const result = { id, symbols: list, mode, language, question, created_at: new Date(started).toISOString(), elapsed_ms: Date.now() - started, cost_usd: cost, run_ids: runs.map((r) => r.run_id), ranking };
  const dir = join(homeDir(), "compare", id);
  writeJson(join(dir, "compare.json"), result);
  writeText(join(dir, "compare.md"), compareMarkdown(result, runs));
  onEvent({ type: "compared", result, runs });
  return { ...result, runs };
}

export function compareRows(runs) {
  return runs.map((r) => ({
    symbol: r.symbol,
    name: r.name,
    rating: r.decision?.rating || r.state,
    confidence: r.decision?.confidence || "",
    price: r.snapshot?.quote?.price ?? null,
    currency: r.snapshot?.quote?.currency || r.decision?.valuation?.currency || "",
    base: r.decision?.valuation?.base ?? null,
    upside: upside(r),
    pe: r.snapshot?.fundamentals?.ratios?.pe_ttm ?? null,
    ret12m: r.snapshot?.technicals?.return_12m_pct ?? null,
    top_risk: r.decision?.risks?.[0]?.risk || "",
  }));
}

export function compareMarkdown(result, runs) {
  const rows = compareRows(runs);
  const rank = new Map((result.ranking?.ranking || []).map((x) => [String(x.symbol).toUpperCase(), x]));
  const lines = [`# ${result.symbols.join(" vs ")}`, "", `> ${result.created_at.slice(0, 10)} · ${result.mode}${result.question ? ` · ${result.question}` : ""}`, ""];
  if (result.ranking) lines.push(result.ranking.summary, "");
  lines.push("| # | Ticker | Verdict | Price | Base value | Upside | P/E | 12m | Why |", "|---|---|---|---|---|---|---|---|---|");
  const ordered = [...rows].sort((a, b) => (rank.get(a.symbol)?.rank ?? 99) - (rank.get(b.symbol)?.rank ?? 99));
  for (const r of ordered) {
    const k = rank.get(r.symbol);
    lines.push(`| ${k?.rank ?? "–"} | **${r.symbol}** | ${r.rating} | ${r.price ?? "n/a"} | ${r.base ?? "n/a"} | ${r.upside === null ? "n/a" : `${r.upside >= 0 ? "+" : ""}${r.upside.toFixed(0)}%`} | ${r.pe ?? "n/a"} | ${r.ret12m === null ? "n/a" : `${r.ret12m}%`} | ${String(k?.why || "").replace(/\|/g, "/")} |`);
  }
  lines.push("", `Reports: ${result.run_ids.join(", ")}`);
  return `${lines.join("\n")}\n`;
}
