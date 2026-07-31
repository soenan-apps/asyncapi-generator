import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser } from "@asyncapi/parser";
import { parseWithPointers } from "@stoplight/yaml";
import {
  GeneratorDiagnostic,
  UnsupportedAsyncAPIFeaturesError
} from "./codegen/diagnostics.js";
import { emitDart } from "./codegen/emit-dart.js";
import { emitSwift } from "./codegen/emit-swift.js";
import { buildIR } from "./codegen/ir.js";
import { snakeCase } from "./codegen/names.js";

const MANIFEST_FILE = ".asyncapi-generator.json";

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

function parserDiagnosticPath(diagnostic) {
  return diagnostic.path?.join("/") ?? "$";
}

function referenceDiagnosticPath(segments) {
  const pointer = segments
    .map(segment => String(segment).replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/");
  return `$/${pointer}`;
}

function isRemoteOrAuthorityReference(reference) {
  const value = reference.trimStart();
  if (value.startsWith("//") || value.startsWith("\\\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value)?.[1]?.toLowerCase();
  if (scheme === undefined) return false;
  if (scheme !== "file") return true;

  const filePath = value.slice("file:".length);
  return !filePath.startsWith("/")
    || /^\/\/[^/]/.test(filePath)
    || filePath.startsWith("////");
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

async function readStableLocalFile(path) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new TypeError("local reference is not a regular file");
    const source = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    const current = await stat(path, { bigint: true });
    if (!sameFileSnapshot(before, after) || !sameFileSnapshot(after, current)) {
      throw new Error("local reference changed while it was being read");
    }
    return source;
  } finally {
    await handle.close();
  }
}

function isWithinRoot(root, path) {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === ""
    || (pathFromRoot !== ".."
      && !pathFromRoot.startsWith(`..${sep}`)
      && !isAbsolute(pathFromRoot));
}

function referenceViolation(code, message, path = "$") {
  return new GeneratorDiagnostic(code, path, message);
}

function restrictedReferenceResolvers(referenceRoot, recordViolation) {
  const blockedRemoteResolver = schema => ({
    schema,
    order: 1,
    read: () => {
      recordViolation(referenceViolation(
        "reference.remote",
        "remote and authority-based references are not supported; use a local file or fragment reference"
      ));
      return "{}";
    }
  });

  const localFileResolver = {
    schema: "file",
    order: 1,
    read: async uri => {
      const scheme = uri.scheme().toLowerCase();
      const isWindowsDrive = /^[a-z]$/i.test(scheme) && uri.path().startsWith("/");
      if ((scheme !== "" && scheme !== "file" && !isWindowsDrive)
        || uri.authority().length > 0
        || uri.query().length > 0) {
        recordViolation(referenceViolation(
          "reference.remote",
          "remote and authority-based references are not supported; use a local file or fragment reference"
        ));
        return "{}";
      }

      try {
        const rawPath = scheme === "file"
          ? fileURLToPath(uri.href())
          : uri.href();
        const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(referenceRoot, rawPath);
        const canonicalPath = await realpath(absolutePath);
        if (!isWithinRoot(referenceRoot, canonicalPath)) {
          recordViolation(referenceViolation(
            "reference.local.outsideRoot",
            "local references must remain within the input contract directory"
          ));
          return "{}";
        }

        const source = await readStableLocalFile(canonicalPath);
        try {
          assertLocalReferences(source);
        } catch (error) {
          if (error instanceof UnsupportedAsyncAPIFeaturesError) {
            for (const diagnostic of error.diagnostics) recordViolation(diagnostic);
          } else {
            recordViolation(referenceViolation(
              "reference.local.invalid",
              "a local reference could not be inspected safely"
            ));
          }
          return "{}";
        }
        return source;
      } catch {
        recordViolation(referenceViolation(
          "reference.local.unreadable",
          "a local reference could not be read safely"
        ));
        return "{}";
      }
    }
  };

  return [
    localFileResolver,
    blockedRemoteResolver("http"),
    blockedRemoteResolver("https")
  ];
}

export function assertLocalReferences(source) {
  const parsed = parseWithPointers(source);
  if (parsed.diagnostics.length > 0) {
    throw new Error("AsyncAPI reference preflight could not parse the input safely");
  }

  const diagnostics = [];
  const visited = new WeakSet();
  const pending = [[parsed.data, []]];
  while (pending.length > 0) {
    const [value, path] = pending.pop();
    if (value === null || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);

    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key];
      if (key === "$ref" && typeof child === "string" && isRemoteOrAuthorityReference(child)) {
        diagnostics.push(new GeneratorDiagnostic(
          "reference.remote",
          referenceDiagnosticPath(childPath),
          "remote and authority-based references are not supported; use a local file or fragment reference"
        ));
      }
      if (child !== null && typeof child === "object") pending.push([child, childPath]);
    }
  }

  if (diagnostics.length > 0) throw new UnsupportedAsyncAPIFeaturesError(diagnostics);
}

async function parseInput(input) {
  const canonicalInput = await realpath(input);
  const referenceRoot = dirname(canonicalInput);
  const source = await readStableLocalFile(canonicalInput);
  assertLocalReferences(source);
  const referenceViolations = new Map();
  const recordViolation = diagnostic => {
    referenceViolations.set(
      `${diagnostic.code}\u0000${diagnostic.path}\u0000${diagnostic.message}`,
      diagnostic
    );
  };
  const parser = new Parser({
    __unstable: {
      resolver: {
        resolvers: restrictedReferenceResolvers(referenceRoot, recordViolation)
      }
    }
  });
  let result;
  try {
    result = await parser.parse(source, { source: canonicalInput });
  } catch (error) {
    if (referenceViolations.size > 0) {
      throw new UnsupportedAsyncAPIFeaturesError(referenceViolations.values());
    }
    throw error;
  }
  if (referenceViolations.size > 0) {
    throw new UnsupportedAsyncAPIFeaturesError(referenceViolations.values());
  }
  if (result.diagnostics.length > 0) {
    const diagnostics = [...result.diagnostics].sort((left, right) =>
      parserDiagnosticPath(left).localeCompare(parserDiagnosticPath(right))
        || left.message.localeCompare(right.message)
    );
    const details = diagnostics
      .map(diagnostic => `${parserDiagnosticPath(diagnostic)}: ${diagnostic.message}`)
      .join("\n");
    throw new Error(`AsyncAPI parser rejected ${input}:\n${details}`);
  }
  if (!result.document) throw new Error(`AsyncAPI parser produced no document for ${input}`);
  return result.document;
}

function stage(document, options) {
  const ir = buildIR(document, { moduleName: options.moduleName });
  const files = new Map();
  if (options.language === "swift") {
    files.set(
      `Sources/${ir.moduleName}/AsyncAPIGenerated.swift`,
      Buffer.from(`${emitSwift(ir)}\n`, "utf8")
    );
  } else {
    const libraryName = snakeCase(ir.moduleName);
    files.set("lib/src/asyncapi_generated.dart", Buffer.from(`${emitDart(ir)}\n`, "utf8"));
    files.set(
      `lib/${libraryName}.dart`,
      Buffer.from("// Generated by @soenan/asyncapi-generator. Do not edit.\nexport 'src/asyncapi_generated.dart';\n\n", "utf8")
    );
  }
  for (const path of files.keys()) assertRelativeGeneratedPath(path);
  files.set(MANIFEST_FILE, manifestBytes(options, files.keys()));
  return files;
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
  assertSupportedNodeVersion();
  await assertInputFile(config.input);
  const document = await parseInput(config.input);
  return config.targets.map(target => ({
    target,
    files: stage(document, target)
  }));
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
