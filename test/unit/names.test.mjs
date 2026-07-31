import assert from "node:assert/strict";
import test from "node:test";
import {
  dartIdentifier,
  dartStringLiteral,
  dartTypeName,
  snakeCase,
  sourceCommentLiteral,
  swiftIdentifier,
  swiftStringLiteral,
  swiftTypeName
} from "../../src/codegen/names.js";

test("language identifiers escape keywords consistently", () => {
  assert.equal(swiftIdentifier("class"), "class_");
  assert.equal(swiftTypeName("Self"), "SelfValue");
  assert.equal(swiftTypeName("Error"), "ErrorValue");
  assert.equal(dartIdentifier("class"), "class_");
  assert.equal(dartTypeName("Function"), "FunctionValue");
  assert.equal(dartTypeName("Object"), "ObjectValue");
  assert.equal(dartTypeName("Uint8List"), "Uint8ListValue");
  assert.equal(snakeCase("RealtimeChatAPI"), "realtime_chat_api");
});

test("string literals use language-specific escaping", () => {
  assert.equal(swiftStringLiteral("a\"\\\n\u0001$"), '"a\\"\\\\\\n\\u{1}$"');
  assert.equal(dartStringLiteral("a\"\\\n\u0001$"), '"a\\"\\\\\\n\\u0001\\$"');
});

test("source metadata is a quoted single-line representation without control or format characters", () => {
  assert.equal(
    sourceCommentLiteral("safe\n\u0085\u2028\u2029\u202E\u{E0001}"),
    '"safe\\n\\u0085\\u2028\\u2029\\u202E\\uDB40\\uDC01"'
  );
});
