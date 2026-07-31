import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_FILE = ".asyncapi-generator.json";
const TEMPLATE_DIRECTORY = fileURLToPath(new URL("../template", import.meta.url));
const require = createRequire(import.meta.url);

function templateNodeModulesDirectory() {
  let current = dirname(require.resolve("@asyncapi/generator-react-sdk/package.json", {
    paths: [dirname(require.resolve("@asyncapi/generator/package.json"))]
  }));
  while (basename(current) !== "node_modules") {
    const parent = dirname(current);
    if (parent === current) throw new Error("Cannot locate the AsyncAPI template dependency directory");
    current = parent;
  }
  return current;
}

export class GeneratedOutputMismatchError extends Error {
  constructor(differences) {
    super(`Generated AsyncAPI output is stale:\n${differences.map(value => `- ${value}`).join("\n")}`);
    this.name = "GeneratedOutputMismatchError";
    this.differences = differences;
  }
}

function manifestFor(options, files) {
  return {
    schemaVersion: 1,
    generator: "@soenan/asyncapi-generator",
    language: options.language,
    moduleName: options.moduleName,
    files: [...files].sort()
  };
}

function manifestBytes(options, files) {
  return Buffer.from(`${JSON.stringify(manifestFor(options, files), null, 2)}\n`, "utf8");
}

function assertRelativeGeneratedPath(path) {
  if (path.length === 0 || path.startsWith("/") || path.split(/[\\/]/).includes("..")) {
    throw new Error(`Unsafe generated path ${JSON.stringify(path)}`);
  }
}

async function collectFiles(root, directory = root) {
  const result = new Map();
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Generator template produced a symbolic link: ${relative(root, absolute)}`);
    }
    if (entry.isDirectory()) {
      for (const [path, contents] of await collectFiles(root, absolute)) result.set(path, contents);
    } else if (entry.isFile()) {
      const path = relative(root, absolute).split(sep).join("/");
      assertRelativeGeneratedPath(path);
      result.set(path, await readFile(absolute));
    }
  }
  return result;
}

async function stage(options) {
  assertSupportedNodeVersion();
  const temporary = await mkdtemp(join(tmpdir(), "asyncapi-generator-"));
  const isolatedTemplate = join(temporary, "template");
  const output = join(temporary, "output");
  try {
    await cp(TEMPLATE_DIRECTORY, isolatedTemplate, {
      recursive: true,
      filter(source) {
        const path = relative(TEMPLATE_DIRECTORY, source).split(sep).join("/");
        return path !== "__transpiled" && !path.startsWith("__transpiled/") && path !== "node_modules";
      }
    });
    await symlink(templateNodeModulesDirectory(), join(isolatedTemplate, "node_modules"), "dir");
    if (options.language === "swift") {
      await mkdir(join(output, "Sources", options.moduleName), { recursive: true });
    } else {
      await mkdir(join(output, "lib", "src"), { recursive: true });
    }
    const generatorModule = await import("@asyncapi/generator");
    const imported = generatorModule.default ?? generatorModule;
    const Generator = imported.Generator ?? imported.default ?? imported;
    const generator = new Generator(isolatedTemplate, output, {
      forceWrite: true,
      install: false,
      templateParams: {
        language: options.language,
        moduleName: options.moduleName
      }
    });
    await generator.generateFromFile(options.input);
    const files = await collectFiles(output);
    if (files.size === 0) throw new Error("Template invariant failed: no source files were generated");
    files.set(MANIFEST_FILE, manifestBytes(options, files.keys()));
    return files;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function readPreviousManifest(output) {
  try {
    const contents = await readFile(join(output, MANIFEST_FILE), "utf8");
    const parsed = JSON.parse(contents);
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.files)) {
      throw new Error("unsupported manifest shape");
    }
    for (const path of parsed.files) assertRelativeGeneratedPath(path);
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${MANIFEST_FILE}: ${error.message}`, { cause: error });
  }
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, contents, { mode: 0o644 });
  await rename(temporary, path);
}

async function removeEmptyParents(path, output) {
  let current = dirname(path);
  while (current !== output && current.startsWith(`${output}${sep}`)) {
    try {
      await rmdir(current);
    } catch (error) {
      if (error?.code === "ENOTEMPTY" || error?.code === "ENOENT") return;
      throw error;
    }
    current = dirname(current);
  }
}

function assertObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
}

function assertKnownKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${path} contains unknown property ${JSON.stringify(key)}`);
  }
}

function requireNonEmptyString(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

export function validateConfig(value, configPath) {
  const absoluteConfigPath = resolve(requireNonEmptyString(configPath, "configPath"));
  const base = dirname(absoluteConfigPath);
  assertObject(value, "config");
  assertKnownKeys(value, new Set(["$schema", "input", "targets"]), "config");
  if (value.$schema !== undefined) requireNonEmptyString(value.$schema, "config.$schema");
  const input = resolve(base, requireNonEmptyString(value.input, "config.input"));
  if (!Array.isArray(value.targets) || value.targets.length === 0) {
    throw new TypeError("config.targets must be a non-empty array");
  }
  const targets = value.targets.map((target, index) => {
    const path = `config.targets[${index}]`;
    assertObject(target, path);
    assertKnownKeys(target, new Set(["language", "moduleName", "output"]), path);
    if (target.language !== "swift" && target.language !== "dart") {
      throw new TypeError(`${path}.language must be swift or dart`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target.moduleName ?? "")) {
      throw new TypeError(`${path}.moduleName must be a Swift and Dart compatible identifier`);
    }
    const output = resolve(base, requireNonEmptyString(target.output, `${path}.output`));
    if (dirname(output) === output) throw new TypeError(`${path}.output must not be a filesystem root`);
    return {
      language: target.language,
      moduleName: target.moduleName,
      output
    };
  });
  for (let left = 0; left < targets.length; left += 1) {
    for (let right = left + 1; right < targets.length; right += 1) {
      if (pathsOverlap(targets[left].output, targets[right].output)) {
        throw new TypeError(`config.targets[${left}].output overlaps config.targets[${right}].output`);
      }
    }
  }
  return { configPath: absoluteConfigPath, input, targets };
}

export async function loadConfig(configPath) {
  const absoluteConfigPath = resolve(requireNonEmptyString(configPath, "configPath"));
  let source;
  try {
    source = await readFile(absoluteConfigPath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read config ${absoluteConfigPath}: ${error.message}`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Cannot parse config ${absoluteConfigPath}: ${error.message}`, { cause: error });
  }
  return validateConfig(parsed, absoluteConfigPath);
}

export function assertSupportedNodeVersion(version = process.versions.node) {
  const [major, minor, patch] = String(version).split(".").map(value => Number.parseInt(value, 10));
  const supported = major === 24 && (minor > 11 || (minor === 11 && patch >= 1));
  if (!supported) {
    throw new Error(`Node.js ${version} is unsupported; @soenan/asyncapi-generator requires Node.js >=24.11.1 <25`);
  }
}

async function assertInputFile(input) {
  await access(input, fsConstants.R_OK);
  const metadata = await stat(input);
  if (!metadata.isFile()) throw new TypeError(`Input is not a file: ${input}`);
}

async function writeStagedTarget(target, files) {
  const previous = await readPreviousManifest(target.output);
  await mkdir(target.output, { recursive: true });

  for (const [path, contents] of files) {
    await atomicWrite(join(target.output, path), contents);
  }

  const nextPaths = new Set(files.keys());
  for (const stale of previous?.files ?? []) {
    if (nextPaths.has(stale)) continue;
    const absolute = join(target.output, stale);
    try {
      await unlink(absolute);
      await removeEmptyParents(absolute, target.output);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function targetDifferences(target, expected) {
  const differences = [];
  const previous = await readPreviousManifest(target.output);

  for (const [path, expectedContents] of expected) {
    try {
      const actual = await readFile(join(target.output, path));
      if (!actual.equals(expectedContents)) differences.push(`changed ${path}`);
    } catch (error) {
      if (error?.code === "ENOENT") differences.push(`missing ${path}`);
      else throw error;
    }
  }
  const expectedPaths = new Set(expected.keys());
  for (const stale of previous?.files ?? []) {
    if (!expectedPaths.has(stale)) differences.push(`stale ${stale}`);
  }
  return differences.sort();
}

function resultFor(config, stagedTargets) {
  return {
    input: config.input,
    targets: stagedTargets.map(({ target, files }) => ({
      output: target.output,
      ...manifestFor(target, [...files.keys()].filter(path => path !== MANIFEST_FILE))
    }))
  };
}

async function stageConfig(config) {
  await assertInputFile(config.input);
  return Promise.all(config.targets.map(async target => ({
    target,
    files: await stage({ input: config.input, ...target })
  })));
}

export async function generate(configPath) {
  const config = await loadConfig(configPath);
  const stagedTargets = await stageConfig(config);
  await Promise.all(stagedTargets.map(({ target, files }) => writeStagedTarget(target, files)));
  return resultFor(config, stagedTargets);
}

export async function check(configPath) {
  const config = await loadConfig(configPath);
  const stagedTargets = await stageConfig(config);
  const targetResults = await Promise.all(stagedTargets.map(async ({ target, files }) => ({
    target,
    differences: await targetDifferences(target, files)
  })));
  const differences = targetResults.flatMap(({ target, differences: values }) =>
    values.map(value => `${target.language} ${target.moduleName} at ${target.output}: ${value}`)
  ).sort();
  if (differences.length > 0) throw new GeneratedOutputMismatchError(differences);
  return resultFor(config, stagedTargets);
}

export { MANIFEST_FILE };
