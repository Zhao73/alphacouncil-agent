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
export function table(headers, rows, { title, empty = "_(no rows)_" } = {}) {
  const parts = title ? [`**${title}**`, ""] : [];
  if (!rows.length) return [...parts, empty].join("\n");
  parts.push(`| ${headers.map(escape).join(" | ")} |`);
  parts.push(`|${headers.map(() => "---").join("|")}|`);
  for (const row of rows) parts.push(`| ${row.map(escape).join(" | ")} |`);
  return parts.join("\n");
}

/** A pass/fail marker that reads correctly in a terminal and in rendered markdown. */
export const mark = (ok) => (ok ? "pass" : "**FAIL**");

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
