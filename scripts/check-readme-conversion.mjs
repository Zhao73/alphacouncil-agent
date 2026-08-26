#!/usr/bin/env node
/** Keep the three concise README entry points aligned, honest, and package-visible. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export const README_FILES = Object.freeze([
  "README.md",
  "README.zh-CN.md",
  "README.ja.md",
]);

export const REFERENCE_FILES = Object.freeze([
  "docs/reference/README.en.md",
  "docs/reference/README.zh-CN.md",
  "docs/reference/README.ja.md",
]);

export const SECTION_MARKERS = Object.freeze([
  "hero",
  "demo",
  "promise",
  "install",
  "first-run",
  "call-structure",
  "benefits",
  "comparison",
  "honesty",
  "disclaimer",
  "reference-fold",
]);

export const FORBIDDEN_ABOVE_FOLD_TERMS = Object.freeze([
  "full_v2",
  "quick_v1",
  "selection_receipt",
  "operator_lens",
  "method_model",
  "analyze_symbol",
  "plan_visible_run",
  "fail-closed",
  "begin_council_selection",
]);

const marker = (name) => `<!-- readme-section:${name} -->`;

export function readReadmeDocuments(root = repoRoot) {
  return new Map(README_FILES.map((path) => [path, readFileSync(resolve(root, path), "utf8")]));
}

export function extractSection(text, start, end) {
  const startIndex = text.indexOf(marker(start));
  const endIndex = text.indexOf(marker(end));
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) return "";
  return text.slice(startIndex + marker(start).length, endIndex);
}

export function aboveReferenceFold(text) {
  const foldIndex = text.indexOf(marker("reference-fold"));
  return foldIndex < 0 ? text : text.slice(0, foldIndex);
}

/**
 * Deterministic English word count for the conversion gate:
 * fenced code, HTML comments/tags, image destinations, and link destinations are removed;
 * then ASCII word tokens in the rendered prose are counted.
 */
export function countEnglishWords(text) {
  const prose = text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/[`*_#>|]/gu, " ");
  return prose.match(/[A-Za-z0-9]+(?:[’'-][A-Za-z0-9]+)*/gu)?.length ?? 0;
}

function markdownTableDataRows(section) {
  const tableLines = section.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("|"));
  if (tableLines.length < 2) return -1;
  return tableLines.length - 2;
}

function orderedMarkers(text) {
  return [...text.matchAll(/<!-- readme-section:([a-z-]+) -->/gu)].map((match) => match[1]);
}

const honestyPatterns = Object.freeze(new Map([
  ["README.md", [/AI-authored reconstructions/iu, /pending human review/iu, /not a validated investment model/iu]],
  ["README.zh-CN.md", [/AI[^\n]*重构/u, /尚待人工评审/u, /不是已验证的投资模型/u]],
  ["README.ja.md", [/AI[^\n]*再構成/u, /人間のレビュー待ち/u, /検証済み投資モデルではありません/u]],
]));

const disclaimerPatterns = Object.freeze(new Map([
  ["README.md", /not investment advice/iu],
  ["README.zh-CN.md", /不构成投资建议/u],
  ["README.ja.md", /投資助言[^\n]*ありません/u],
]));

export function validateReadmeDocuments(documents) {
  const errors = [];
  const expectedMarkers = SECTION_MARKERS.join(",");

  for (const path of README_FILES) {
    const text = documents.get(path);
    if (typeof text !== "string") {
      errors.push(`${path}: missing README text`);
      continue;
    }

    const actualMarkers = orderedMarkers(text);
    if (actualMarkers.join(",") !== expectedMarkers) {
      errors.push(`${path}: section markers must be exactly ${expectedMarkers}; got ${actualMarkers.join(",")}`);
    }

    const aboveFold = aboveReferenceFold(text);
    for (const term of FORBIDDEN_ABOVE_FOLD_TERMS) {
      if (aboveFold.toLowerCase().includes(term.toLowerCase())) {
        errors.push(`${path}: forbidden above-fold contract term ${term}`);
      }
    }

    const callStructure = extractSection(text, "call-structure", "benefits");
    if (!callStructure.includes("|")) errors.push(`${path}: call-structure table is missing`);
    for (const minutes of [10, 15, 30, 60]) {
      if (!new RegExp(`\\b${minutes}\\b`, "u").test(callStructure)) {
        errors.push(`${path}: call-structure table is missing ${minutes}-minute bound`);
      }
    }

    const benefits = extractSection(text, "benefits", "comparison");
    const benefitRows = markdownTableDataRows(benefits);
    if (benefitRows !== 5) errors.push(`${path}: benefit table must contain exactly 5 data rows; got ${benefitRows}`);

    if (!aboveFold.includes("assets/demo.mp4")) errors.push(`${path}: demo.mp4 link is missing above the fold`);
    if (!aboveFold.includes("docs/examples/final_report.SOX.zh.md")) errors.push(`${path}: example-report link is missing above the fold`);
    for (const pattern of honestyPatterns.get(path) ?? []) {
      if (!pattern.test(aboveFold)) errors.push(`${path}: honesty note is missing ${pattern}`);
    }
    if (!disclaimerPatterns.get(path)?.test(aboveFold)) errors.push(`${path}: localized disclaimer is missing above the fold`);

    if (/(?:[$€£¥￥]|USD|EUR|JPY|CNY)\s*\d/iu.test(aboveFold)
      || /\b\d[\d,.]*\s*(?:tokens?|トークン)\b/iu.test(aboveFold)) {
      errors.push(`${path}: unmeasured numeric token or currency claim appears above the fold`);
    }
  }

  const englishWords = countEnglishWords(aboveReferenceFold(documents.get("README.md") ?? ""));
  if (englishWords >= 1500) errors.push(`README.md: above-fold English word count must be <1500; got ${englishWords}`);
  return errors;
}

function localTargets(text) {
  const targets = [];
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) targets.push(match[1].trim());
  for (const match of text.matchAll(/(?:href|src)="([^"]+)"/gu)) targets.push(match[1].trim());
  return [...new Set(targets)];
}

export function localLinkErrors(root, path, text) {
  const errors = [];
  for (const target of localTargets(text)) {
    if (!target || target.startsWith("#") || /^[a-z][a-z\d+.-]*:/iu.test(target)) continue;
    const relativePath = target.split("#", 1)[0];
    if (!relativePath) continue;
    const resolved = resolve(root, dirname(path), relativePath);
    if (!existsSync(resolved)) errors.push(`${path}: missing local link target ${target}`);
  }
  return errors;
}

export function checkReadmeConversion(root = repoRoot) {
  const documents = readReadmeDocuments(root);
  const errors = validateReadmeDocuments(documents);
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

  if (!manifest.files?.includes("docs/reference/")) {
    errors.push("package.json: files must explicitly include docs/reference/");
  }
  if (!/check-readme-conversion\.mjs/u.test(manifest.scripts?.["docs:readme:check"] ?? "")) {
    errors.push("package.json: docs:readme:check script is missing");
  }

  const minimumReferenceLines = [600, 430, 390];
  for (const [index, path] of REFERENCE_FILES.entries()) {
    const absolute = resolve(root, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      errors.push(`${path}: moved detailed reference is missing`);
      continue;
    }
    const text = readFileSync(absolute, "utf8");
    const lines = text.split("\n").length;
    if (lines < minimumReferenceLines[index]) {
      errors.push(`${path}: detailed reference appears truncated; got ${lines} lines`);
    }
    errors.push(...localLinkErrors(root, path, text));
  }
  for (const [path, text] of documents) errors.push(...localLinkErrors(root, path, text));

  if (errors.length > 0) {
    throw new Error(`README conversion contract failed:\n- ${errors.join("\n- ")}`);
  }

  return Object.freeze({
    readmes: README_FILES.length,
    references: REFERENCE_FILES.length,
    sections: SECTION_MARKERS.length,
    benefitRows: 5,
    englishAboveFoldWords: countEnglishWords(aboveReferenceFold(documents.get("README.md"))),
  });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const result = checkReadmeConversion();
    process.stdout.write(
      `readme-conversion-check: passed readmes=${result.readmes} references=${result.references} `
      + `sections=${result.sections} benefits=${result.benefitRows} `
      + `english_above_fold_words=${result.englishAboveFoldWords} local_links=ok\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
