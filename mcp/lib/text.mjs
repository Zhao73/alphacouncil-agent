export function appendLimited(base, chunk, max = 20000) {
  const next = `${base}${chunk}`;
  return next.length > max ? next.slice(-max) : next;
}

export function cleanLog(value, max = 4000) {
  return String(value || "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .slice(-max);
}

export function fence(value, lang = "text") {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return `~~~${lang}\n${text.replaceAll("~~~", "~~~\\u200b")}\n~~~`;
}

export function bullets(items) {
  if (!Array.isArray(items) || items.length === 0) return "- None";
  return items.map((item) => `- ${typeof item === "string" ? item : JSON.stringify(item)}`).join("\n");
}

export function clip(text, max = 520) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
