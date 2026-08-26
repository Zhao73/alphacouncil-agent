import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FORBIDDEN_ABOVE_FOLD_TERMS,
  SECTION_MARKERS,
  aboveReferenceFold,
  checkReadmeConversion,
  countEnglishWords,
  readReadmeDocuments,
  validateReadmeDocuments,
} from "../../scripts/check-readme-conversion.mjs";

function mutateDocument(documents, path, transform) {
  const copy = new Map(documents);
  copy.set(path, transform(copy.get(path)));
  return copy;
}

test("three concise READMEs satisfy the conversion and moved-reference contract", () => {
  const result = checkReadmeConversion();
  assert.deepEqual(result, {
    readmes: 3,
    references: 3,
    sections: 11,
    benefitRows: 5,
    englishAboveFoldWords: countEnglishWords(aboveReferenceFold(readReadmeDocuments().get("README.md"))),
  });
  assert.ok(result.englishAboveFoldWords < 1500);
});

test("the three README marker sequences are identical and complete", () => {
  const documents = readReadmeDocuments();
  assert.deepEqual(validateReadmeDocuments(documents), []);
  for (const text of documents.values()) {
    const markers = [...text.matchAll(/<!-- readme-section:([a-z-]+) -->/gu)].map((match) => match[1]);
    assert.deepEqual(markers, SECTION_MARKERS);
  }
});

for (const term of FORBIDDEN_ABOVE_FOLD_TERMS) {
  test(`README conversion gate rejects above-fold contract jargon: ${term}`, () => {
    const documents = readReadmeDocuments();
    const mutated = mutateDocument(documents, "README.md", (text) => (
      text.replace("<!-- readme-section:reference-fold -->", `${term}\n<!-- readme-section:reference-fold -->`)
    ));
    assert.ok(validateReadmeDocuments(mutated).some((error) => error.includes(term)));
  });
}

test("README conversion gate rejects structural drift", () => {
  const documents = readReadmeDocuments();
  const mutated = mutateDocument(documents, "README.ja.md", (text) => (
    text.replace("<!-- readme-section:comparison -->", "")
  ));
  assert.ok(validateReadmeDocuments(mutated).some((error) => error.includes("section markers")));
});

test("README conversion gate rejects a sixth benefit row", () => {
  const documents = readReadmeDocuments();
  const mutated = mutateDocument(documents, "README.zh-CN.md", (text) => (
    text.replace("<!-- readme-section:comparison -->", "| **额外一行** | 不允许 |\n\n<!-- readme-section:comparison -->")
  ));
  assert.ok(validateReadmeDocuments(mutated).some((error) => error.includes("exactly 5")));
});

test("README conversion gate rejects unsupported numeric cost copy", () => {
  const documents = readReadmeDocuments();
  const mutated = mutateDocument(documents, "README.md", (text) => (
    text.replace("<!-- readme-section:reference-fold -->", "$2 per run\n<!-- readme-section:reference-fold -->")
  ));
  assert.ok(validateReadmeDocuments(mutated).some((error) => error.includes("token or currency")));
});
