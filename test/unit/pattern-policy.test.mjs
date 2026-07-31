import assert from "node:assert/strict";
import test from "node:test";
import {
  MAXIMUM_PATTERN_INPUT_CODE_POINTS,
  normalizeSafePattern,
  portablePatternMatches,
  UnsafePatternError
} from "../../src/codegen/pattern-policy.js";
import {
  assertStoredTrace,
  derivePatternOperations,
  loadPatternCorpus
} from "../support/pattern-corpus.mjs";

test("portable patterns normalize cross-runtime character categories", () => {
  assert.equal(
    normalizeSafePattern("^[^\\s].*"),
    "^[^\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF].*"
  );
  assert.equal(normalizeSafePattern("^prj_[0-9a-f]{32}$"), "^prj_[0-9a-f]{32}(?![\\s\\S])");
  assert.equal(portablePatternMatches("^[^\\s].*", "日本語😀"), true);
  assert.equal(portablePatternMatches("^[^\\s].*", "\u00A0leading"), false);
  assert.equal(portablePatternMatches("^prj_[0-9a-f]{32}$", "prj_" + "a".repeat(32)), true);
});

test("unsafe or potentially super-linear pattern shapes fail at generation", () => {
  const invalid = [
    ["nested repetition", "^(a+)+$"],
    ["ambiguous alternation", "^(a|aa)+$"],
    ["lookahead", "^(?=a)a$"],
    ["backreference", "^(a)\\1$"],
    ["two variable repetitions", "^a+b+$"],
    ["unbounded repetition form", "^a{1,}$"],
    ["oversized bounded repetition", "^a{257}$"],
    ["raw control", "^a\nb$"],
    ["oversized pattern", "^" + "a".repeat(256) + "$"]
  ];
  for (const [name, pattern] of invalid) {
    assert.throws(
      () => normalizeSafePattern(pattern),
      error => error instanceof UnsafePatternError,
      name
    );
  }
});

test("pattern input work is capped before regular-expression evaluation", () => {
  assert.equal(portablePatternMatches("a*", "a".repeat(MAXIMUM_PATTERN_INPUT_CODE_POINTS)), true);
  assert.equal(portablePatternMatches("a*", "a".repeat(MAXIMUM_PATTERN_INPUT_CODE_POINTS + 1)), false);
});

test("fixed derived corpus and arbitrary operation trace remain replayable", async () => {
  const corpus = await loadPatternCorpus();
  const operations = derivePatternOperations(corpus);
  assert.equal(operations.length, corpus.boundaryVectors.length + corpus.arbitraryOperationCount);
  assert.equal(operations.some(operation => operation.id.startsWith("arbitrary-")), true);
  assert.equal(operations.some(operation => operation.input.includes("😀")), true);
  assert.equal(operations.some(operation => operation.input.includes("\n")), true);
  assert.equal(operations.some(operation => [...operation.input].length === 4_096), true);
  assert.equal(operations.some(operation => [...operation.input].length === 4_097), true);
  assertStoredTrace(corpus, operations);
});
