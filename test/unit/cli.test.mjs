import assert from "node:assert/strict";
import test from "node:test";
import { parseArguments, USAGE } from "../../src/cli.mjs";

test("CLI accepts only generate or check with one config file", () => {
  assert.deepEqual(parseArguments(["generate", "--config", "contracts/generator.json"]), {
    command: "generate",
    config: "contracts/generator.json"
  });
  assert.deepEqual(parseArguments(["check", "--config", "contracts/generator.json"]), {
    command: "check",
    config: "contracts/generator.json"
  });
  assert.throws(() => parseArguments(["generate", "--input", "contract.json"]), /unknown option --input/);
  assert.throws(() => parseArguments(["generate", "--config"]), /exactly --config FILE/);
  assert.throws(() => parseArguments(["generate", "--config", "one.json", "--config", "two.json"]), /exactly --config FILE/);
});

test("CLI help documents the config-only contract", () => {
  assert.deepEqual(parseArguments(["--help"]), { help: true });
  assert.match(USAGE, /asyncapi-soenan-generator generate --config FILE/);
  assert.doesNotMatch(USAGE, /--input/);
});
