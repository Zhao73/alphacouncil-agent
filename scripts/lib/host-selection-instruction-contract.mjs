/**
 * Static contract for the selector instructions shipped to every supported host.
 *
 * The selector response is the roster authority. A prose count can be correct today and stale
 * tomorrow, so host instructions must say to display the returned catalog instead of repeating
 * the current canonical count.
 */

export const HOST_SELECTION_INSTRUCTION_PATHS = Object.freeze([
  "AGENTS.md",
  "CLAUDE.md",
  "commands/alpha.md",
  ".claude/commands/alpha.md",
  ".opencode/command/alpha.md",
  ".grok/commands/alpha.md",
  "skills/alphacouncil-agent/SKILL.md",
  "skills/agent-skills-governance/SKILL.md",
]);

const DYNAMIC_CATALOG_PATTERNS = Object.freeze([
  /\bevery\s+returned\s+(?:entry|entries|lens|lenses|master|masters|method|methods)\b/iu,
  /\bevery\s+(?:entry|entries|lens|lenses|master|masters|method|methods)\s+returned\b/iu,
  /\bcomplete\s+returned\s+catalog\b/iu,
  /\b(?:catalog|directory)\s+returned\s+by\b/iu,
]);

const HARDCODED_CATALOG_PATTERNS = Object.freeze([
  Object.freeze({
    kind: "display_all_count",
    pattern: /\b(?:display|print|render|show|shows|showing)\b.{0,80}?\b(?:all|complete|entire)\s+(?<count>\d{2,3})(?:[- ]seat)?(?:\s+returned)?(?:\s+(?:entries|lenses|masters|methods|seats|catalog))?\b/giu,
  }),
  Object.freeze({
    kind: "display_counted_catalog",
    pattern: /\b(?:display|print|render|show|shows|showing)\s+(?:the\s+)?(?<count>\d{2,3})(?:[- ]seat)?\s+(?:returned\s+)?(?:entries|lenses|masters|methods|seats|catalog)\b/giu,
  }),
  Object.freeze({
    kind: "counted_catalog",
    pattern: /\b(?<count>\d{2,3})[- ]seat\s+(?:master\s+|method\s+)?(?:catalog|directory|display)\b/giu,
  }),
  Object.freeze({
    kind: "catalog_contains_count",
    pattern: /\b(?:catalog|directory)\b.{0,48}?\b(?:contains|has|with)\s+(?<count>\d{2,3})\s+(?:selectable\s+)?(?:entries|lenses|masters|methods|seats)\b/giu,
  }),
  Object.freeze({
    kind: "cjk_display_count",
    pattern: /(?:展示|显示|表示|표시).{0,48}?(?<count>\d{2,3})\s*(?:个|個|位|席|개)?\s*(?:方法席?|メソッド|方法論|방법론?|席)/gu,
  }),
]);

function compact(text) {
  return String(text || "").replace(/\s+/gu, " ").trim();
}

function excerpt(text, index, length) {
  const start = Math.max(0, index - 36);
  const end = Math.min(text.length, index + length + 36);
  return text.slice(start, end);
}

export function inspectHostSelectionInstruction(text, {
  path = "(inline)",
  canonicalCount = null,
} = {}) {
  const normalized = compact(text);
  const errors = [];

  if (!DYNAMIC_CATALOG_PATTERNS.some((pattern) => pattern.test(normalized))) {
    errors.push({
      code: "MISSING_DYNAMIC_SELECTOR_CATALOG_INSTRUCTION",
      path,
      message: "instruction must require every selector-returned entry or the complete returned catalog",
    });
  }

  for (const { kind, pattern } of HARDCODED_CATALOG_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of normalized.matchAll(pattern)) {
      errors.push({
        code: "HARDCODED_SELECTOR_CATALOG_COUNT",
        path,
        kind,
        count: Number(match.groups?.count),
        canonical_count_at_check: Number.isInteger(canonicalCount) ? canonicalCount : null,
        excerpt: excerpt(normalized, match.index || 0, match[0].length),
        message: "selector instructions must derive catalog size from the returned entries",
      });
    }
  }

  return Object.freeze({
    schema_version: 1,
    contract_id: "host_selector_returned_catalog_v1",
    path,
    canonical_count_at_check: Number.isInteger(canonicalCount) ? canonicalCount : null,
    status: errors.length ? "failed" : "passed",
    errors: Object.freeze(errors),
  });
}
