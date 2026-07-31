import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { assertSupportedNodeVersion, validateConfig } from "../../src/generator.mjs";

test("Node support is explicit and checked before parsing input", () => {
  assert.doesNotThrow(() => assertSupportedNodeVersion("24.11.1"));
  assert.throws(() => assertSupportedNodeVersion("24.3.0"), /requires Node\.js >=24\.11\.1 <25/);
  assert.throws(() => assertSupportedNodeVersion("25.0.0"), /requires Node\.js >=24\.11\.1 <25/);
});

test("config paths resolve relative to the config file", () => {
  const configPath = join(process.cwd(), "examples", "contracts", "generator.json");
  const config = validateConfig({
    input: "realtime-chat.yaml",
    targets: [
      { language: "swift", moduleName: "RealtimeChatAPI", output: "../../server/Generated" },
      { language: "dart", moduleName: "RealtimeChatAPI", output: "generated/dart" }
    ]
  }, configPath);
  assert.equal(config.input, join(process.cwd(), "examples", "contracts", "realtime-chat.yaml"));
  assert.equal(config.targets[0].output, join(process.cwd(), "server", "Generated"));
  assert.equal(config.targets[1].output, join(process.cwd(), "examples", "contracts", "generated", "dart"));
  assert.equal(config.configPath, configPath);
});

test("config rejects empty targets, unknown fields, and unsafe target values", () => {
  const path = join(process.cwd(), "generator.json");
  assert.throws(() => validateConfig({ input: "contract.json", targets: [] }, path), /non-empty array/);
  assert.throws(() => validateConfig({ input: "contract.json", targets: [], typo: true }, path), /unknown property "typo"/);
  assert.throws(() => validateConfig({
    input: "contract.json",
    targets: [{ language: "kotlin", moduleName: "API", output: "generated" }]
  }, path), /swift or dart/);
  assert.throws(() => validateConfig({
    input: "contract.json",
    targets: [{ language: "swift", moduleName: "../API", output: "generated" }]
  }, path), /compatible identifier/);
  assert.throws(() => validateConfig({
    input: "contract.json",
    targets: [{ language: "swift", moduleName: "API", output: "generated", typo: true }]
  }, path), /unknown property "typo"/);
  assert.throws(() => validateConfig({
    input: "contract.json",
    targets: [{ language: "swift", moduleName: "API", output: "/" }]
  }, path), /must not be a filesystem root/);
});

test("config rejects exact and nested output collisions before generation", () => {
  const path = join(process.cwd(), "generator.json");
  const config = outputs => ({
    input: "contract.json",
    targets: outputs.map((output, index) => ({
      language: index % 2 === 0 ? "swift" : "dart",
      moduleName: `API${index}`,
      output
    }))
  });
  assert.throws(() => validateConfig(config(["generated", "generated"]), path), /output overlaps/);
  assert.throws(() => validateConfig(config(["generated", "generated/dart"]), path), /output overlaps/);
  assert.doesNotThrow(() => validateConfig(config(["generated-swift", "generated-dart"]), path));
});
