import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MAXIMUM_PATTERN_INPUT_CODE_POINTS,
  portablePatternMatches
} from "../../src/codegen/pattern-policy.js";

const corpusPath = resolve("test/fixtures/pattern-validation/corpus.json");
const arbitraryAlphabet = ["a", "f", "0", "9", "_", "-", " ", "\t", "\n", "\r", "\u00A0", "\u2028", "日", "😀", "\u0000"];

function xorshift32(state) {
  let value = state >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

function expandInput(input) {
  if (typeof input === "string") return input;
  return input.value.repeat(input.count);
}

function accepts(pattern, field, input) {
  const length = [...input].length;
  if (field === "text" && (length < 1 || length > 128)) return false;
  return portablePatternMatches(pattern, input);
}

export async function loadPatternCorpus() {
  return JSON.parse(await readFile(corpusPath, "utf8"));
}

export function derivePatternOperations(corpus) {
  const patterns = new Map(corpus.patterns.map(pattern => [pattern.id, pattern.source]));
  const operations = corpus.boundaryVectors.map((vector, step) => {
    const input = expandInput(vector.input);
    const expected = accepts(patterns.get(vector.pattern), vector.field, input);
    if (expected !== vector.expected) {
      throw new Error("stored boundary verdict changed at seed " + corpus.seed + ", step " + step + " (" + vector.id + ")");
    }
    return { seed: corpus.seed, step, id: vector.id, field: vector.field, pattern: vector.pattern, input, expected };
  });

  let state = corpus.seed >>> 0;
  for (let index = 0; index < corpus.arbitraryOperationCount; index += 1) {
    state = xorshift32(state);
    const pattern = corpus.patterns[state % corpus.patterns.length];
    state = xorshift32(state);
    const boundaryLength = [0, 1, 31, 32, 33, 127, 128, 129, 4_095, 4_096, 4_097];
    const length = index % 17 === 0 ? boundaryLength[state % boundaryLength.length] : state % 160;
    let input = "";
    for (let character = 0; character < length; character += 1) {
      state = xorshift32(state);
      input += arbitraryAlphabet[state % arbitraryAlphabet.length];
    }
    const field = pattern.field;
    operations.push({
      seed: corpus.seed,
      step: operations.length,
      id: "arbitrary-" + index,
      field,
      pattern: pattern.id,
      input,
      expected: accepts(pattern.source, field, input)
    });
  }
  return operations;
}

export function operationTraceDigest(operations) {
  const trace = operations.map(operation => ({
    step: operation.step,
    id: operation.id,
    field: operation.field,
    pattern: operation.pattern,
    input: operation.input,
    expected: operation.expected
  }));
  return createHash("sha256").update(JSON.stringify(trace)).digest("hex");
}

export function assertStoredTrace(corpus, operations) {
  if (operations.length !== corpus.metrics.patternValidationOperations) {
    throw new Error("pattern validation operation count changed");
  }
  const samples = corpus.traceSamples.map(sample => operations[sample.step]).map(operation => ({
    step: operation.step,
    id: operation.id,
    field: operation.field,
    pattern: operation.pattern,
    input: operation.input,
    expected: operation.expected
  }));
  if (JSON.stringify(samples) !== JSON.stringify(corpus.traceSamples)) {
    throw new Error("derived operation trace samples changed");
  }
  const digest = operationTraceDigest(operations);
  if (digest !== corpus.traceSha256) {
    throw new Error("derived operation trace changed: expected " + corpus.traceSha256 + ", received " + digest);
  }
  if (operations.some(operation => [...operation.input].length > MAXIMUM_PATTERN_INPUT_CODE_POINTS && operation.expected)) {
    throw new Error("pattern input budget accepted an oversized operation");
  }
}

export function codecVectors(operations) {
  const base = {
    type: "chat.message.post",
    roomId: "room-1",
    text: "Hello",
    retryCount: 0,
    encrypted: true,
    clientNote: null
  };
  return operations.map(operation => ({
    name: "seed-" + operation.seed + "-step-" + operation.step + ":" + operation.id,
    valid: operation.expected,
    json: { ...base, [operation.field]: operation.input }
  }));
}
