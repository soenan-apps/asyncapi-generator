import assert from "node:assert/strict";
import test from "node:test";
import {
  dartIdentifier,
  dartStringLiteral,
  dartTypeName,
  snakeCase,
  swiftIdentifier,
  swiftStringLiteral,
  swiftTypeName
} from "../../template/src/names.js";

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
