/**
 * Markdown tables for tool output.
 *
 * Hosts render the `content[0].text` of a tool result as markdown, so a table there is a
 * table the user actually sees. Structured data still goes in structuredContent for the
 * model; this is the human-facing half, and a screen result with seven metrics is far
 * easier to check as a table than as a sentence.
 */

const escape = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

/**
 * @param {string[]} headers
 * @param {Array<Array<unknown>>} rows
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {string} [options.empty] shown instead of an empty table
 */
/**
 * Reduce any cell to display text.
 *
 * A {en, zh} label reaching a template literal renders as "[object Object]", which sits
 * next to real numbers and reads as a broken field rather than a missing one -- so the
 * reader distrusts the surrounding data without being able to say why. Two shipped that
 * way before this existed, in the grounding block's skipped rules and its macro readings.
 */
const cellText = (cell, zh) => {
  if (cell == null) return "";
  if (typeof cell === "object" && !Array.isArray(cell)) {
    if ("en" in cell || "zh" in cell) return (zh ? cell.zh : cell.en) ?? cell.en ?? cell.zh ?? "";
    return JSON.stringify(cell);
  }
  return String(cell);
};

export function table(headers, rows, { title, empty = "_(no rows)_", zh = false } = {}) {
  const parts = title ? [`**${title}**`, ""] : [];
  if (!rows.length) return [...parts, empty].join("\n");
  parts.push(`| ${headers.map(escape).join(" | ")} |`);
  parts.push(`|${headers.map(() => "---").join("|")}|`);
  for (const row of rows) parts.push(`| ${row.map((cell) => escape(cellText(cell, zh))).join(" | ")} |`);
  return parts.join("\n");
}

/**
 * Status markers. A glyph plus a word: the glyph gives the row a shape you can scan, the
 * word survives a terminal that renders the glyph badly.
 */
export const mark = (ok) => (ok ? "✅ pass" : "❌ **FAIL**");
export const SKIPPED = "⚪ skipped";
export const skippedMark = (zh) => (zh ? "⚪ 跳过" : SKIPPED);

/** A label that may be a plain string or a {en, zh} pair. */
export const label = (value, zh) => (typeof value === "string" ? value : (zh ? value?.zh : value?.en) ?? "");

/** Threshold with its direction, so "27.17% vs 15" cannot be read backwards. */
export function threshold(value, direction, unit) {
  const arrow = direction === "max" ? "≤" : direction === "min" ? "≥" : "";
  return `${arrow}${arrow ? " " : ""}${metricValue(value, unit)}`;
}

/** Compact money, so a table column stays readable. */
export function money(value, currency = "USD") {
  if (value === null || value === undefined) return "n/a";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}T ${currency}`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}bn ${currency}`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}m ${currency}`;
  return `${value.toLocaleString("en-US")} ${currency}`;
}

export function metricValue(value, unit) {
  if (value === null || value === undefined) return "n/a";
  if (unit === "%") return `${value}%`;
  if (unit === "USD") return money(value);
  return unit ? `${value} ${unit}` : String(value);
}


/**
 * One dashboard for a whole grounding payload.
 *
 * A run currently answers across several tool calls, and the reader has to hold five
 * results in their head to see the picture. This renders the lot as sections of a single
 * document: what is established, what could not be fetched, and who is in play with which
 * data behind them.
 */
export function groundingDashboard(g, language = "English") {
  const zh = /中文|chinese|zh/i.test(String(language));
  const t = (en, cn) => (zh ? cn : en);
  const out = [];

  out.push(`# ${t("Research dashboard", "研究总览")}${g.quote?.symbol ? ` — ${g.quote.symbol}` : ""}`);

  const facts = [];
  if (g.filer) facts.push([t("Filer", "主体"), `${g.filer.name} (SIC ${g.filer.sic ?? "?"})`, g.filer.sic_description ?? "-", "SEC"]);
  if (g.quote) {
    facts.push([t("Quote", "行情"), `${g.quote.price}${g.quote.currency ? " " + g.quote.currency : ""}`,
      g.quote.change_pct != null ? `${g.quote.change_pct > 0 ? "+" : ""}${g.quote.change_pct}%` : "-",
      `${g.quote.source} ${t("(~15m delayed)", "（延迟约15分钟）")}`]);
  }
  if (g.market?.financials) {
    const f = g.market.financials;
    facts.push([t("Latest filing", "最新申报"), `${f.gregorian_year ?? f.period?.year}Q${f.period?.quarter}`,
      `${t("revenue", "营收")} ${f.revenue?.toLocaleString() ?? "n/a"} ${f.currency}`, f.source]);
  }
  if (facts.length) out.push("", table([t("Item", "项目"), t("Value", "数值"), t("Detail", "细节"), t("Source", "来源")], facts, { title: t("Established facts", "已确立的事实") }));

  if (g.screen) {
    const rows = g.screen.metrics.map((m) => [
      label(m.label, zh), metricValue(m.value, m.unit), threshold(m.threshold, m.direction, m.unit), mark(m.passed),
    ]);
    for (const sk of g.screen.skipped || []) rows.push([
      typeof sk === "string" ? sk : label(sk.label, zh),
      t("not computable", "无法计算"), "-", skippedMark(zh),
    ]);
    out.push("", table([t("Rule", "规则"), t("Measured", "实测"), t("Threshold", "阈值"), t("Result", "结果")], rows,
      { title: `${t("Mechanical screen", "硬指标筛选")} — ${g.screen.verdict} (${g.screen.rules_computed}/${g.screen.rules_total})` }));
  }

  if (g.macro?.derived?.length) {
    out.push("", table([t("Reading", "读数"), t("Value", "数值")],
      g.macro.derived.map((d) => [label(d.label, zh), String(d.value)]), { title: t("Macro", "宏观") }));
  }

  if (g.coverage?.rows?.length) {
    out.push("", table(
      [t("Symbol", "标的"), t("Market", "市场"), t("Structured financials", "结构化财务"), t("Blocker", "阻碍")],
      g.coverage.rows.map((r) => [
        r.symbol, r.market,
        zh ? { yes: "有", "summary only": "仅摘要", no: "无" }[r.structured_financials] ?? r.structured_financials
           : r.structured_financials,
        r.needs_env || (r.reason ? r.reason.slice(0, 40) : "-"),
      ]),
      { title: t("Data coverage", "数据覆盖") }));
  }

  if (g.industry?.participants?.length) {
    out.push("", table([t("Layer", "环节"), t("Company", "公司"), t("Symbol", "代码"), t("Market", "市场")],
      g.industry.participants.map((p) => [p.layer?.[zh ? "zh" : "en"] ?? "-", p.name, p.symbol ?? t("unlisted", "未上市"), p.market ?? "-"]),
      { title: t("Value chain", "产业链") }));
  }

  if (g.unavailable?.length) {
    out.push("", `**${t("Data gaps — do not fill these from memory", "数据缺口 — 禁止用记忆填补")}**`, "",
      ...g.unavailable.map((u) => `- ${u}`));
  }

  return out.join("\n");
}
