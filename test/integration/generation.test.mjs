import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { check, generate, GeneratedOutputMismatchError } from "../../src/generator.mjs";

const fixture = resolve("test/fixtures/realtime-chat/asyncapi.yaml");
const keywordFixture = resolve("test/fixtures/keyword-json/asyncapi.json");
const swiftRuntimeURL = "https://github.com/soenan-apps/swift-asyncapi-runtime.git";
const swiftRuntimeVersion = "0.1.0";
const swiftRuntimePath = process.env.SWIFT_ASYNCAPI_RUNTIME_PATH
  ? resolve(process.env.SWIFT_ASYNCAPI_RUNTIME_PATH)
  : undefined;
const vectorsPath = resolve("test/fixtures/realtime-chat/codec-vectors.json");
const packageRoot = resolve(".");
const executable = resolve("bin/asyncapi-soenan-generator.mjs");
let configSequence = 0;

async function inTemporaryDirectory(prefix, operation) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function run(executable, arguments_, options = {}) {
  return execFileSync(executable, arguments_, {
    encoding: "utf8",
    stdio: "pipe",
    ...options
  });
}

function runSwift(arguments_, packageRoot) {
  const moduleCache = join(packageRoot, ".cache", "clang");
  return run("swift", arguments_, {
    env: {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: moduleCache,
      SWIFTPM_MODULECACHE_OVERRIDE: moduleCache
    }
  });
}

async function configFor(root, input, targets) {
  const path = join(root, `.asyncapi-generator-${configSequence += 1}.json`);
  await writeFile(path, `${JSON.stringify({ input, targets }, null, 2)}\n`, "utf8");
  return path;
}

async function runConfigured(operation, root, input, targets) {
  return operation(await configFor(root, input, targets));
}

async function configureSwiftPackage(output, moduleName, testSource) {
  const runtimeDependency = swiftRuntimePath
    ? `.package(path: ${JSON.stringify(swiftRuntimePath)})`
    : `.package(url: ${JSON.stringify(swiftRuntimeURL)}, exact: ${JSON.stringify(swiftRuntimeVersion)})`;
  await writeFile(join(output, "Package.swift"), `// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "GeneratedAcceptance",
  platforms: [.macOS(.v15)],
  products: [.library(name: "${moduleName}", targets: ["${moduleName}"])],
  dependencies: [${runtimeDependency}],
  targets: [
    .target(name: "${moduleName}", dependencies: [.product(name: "AsyncAPIRuntime", package: "swift-asyncapi-runtime")]),
    .testTarget(name: "GeneratedAcceptanceTests", dependencies: ["${moduleName}"])
  ]
)
`, "utf8");
  const tests = join(output, "Tests", "GeneratedAcceptanceTests");
  await mkdir(tests, { recursive: true });
  await writeFile(join(tests, "GeneratedAcceptanceTests.swift"), testSource, "utf8");
}

function swiftVectorTests(vectors) {
  const encoded = vectors.map(vector => ({
    name: vector.name,
    valid: vector.valid,
    base64: Buffer.from(JSON.stringify(vector.json), "utf8").toString("base64")
  }));
  const swiftVectors = encoded.map(vector => `(${JSON.stringify(vector.name)}, ${vector.valid}, ${JSON.stringify(vector.base64)})`).join(", ");
  return `import AsyncAPIRuntime
import Foundation
import Testing
@testable import FixtureAPI

private struct Handler: FixtureAPIProtocol {
  typealias ConnectionContext = Void
  func roomChat(_ session: RoomChatServerSession<Void>) async throws {}
}

private final class Transport: @unchecked Sendable, AsyncAPIServerTransport {
  typealias ApplicationContext = Void
  var registrations = 0
  func register(channel: AsyncAPIChannel, handler: @escaping AsyncAPIConnectionHandler<Void>) throws {
    registrations += 1
  }
}

private actor PullSource {
  private var pulls = 0
  private let message: AsyncAPITransportMessage

  init(message: AsyncAPITransportMessage) { self.message = message }

  func next() -> AsyncAPITransportMessage? {
    pulls += 1
    return pulls == 1 ? message : nil
  }

  func count() -> Int { pulls }
}

@Test func strictCodecVectorsAndTypedRegistration() throws {
  let vectors: [(String, Bool, String)] = [${swiftVectors}]
  for (_, expected, base64) in vectors {
    let data = Data(base64Encoded: base64)!
    let accepted = (try? PostMessageCodec.decode(data)) != nil
    #expect(accepted == expected)
  }
  var invalidEncodeWasRejected = false
  do {
    _ = try PostMessageCodec.encode(PostMessage(
      clientNote: nil,
      encrypted: true,
      retryCount: 4,
      roomId: "room-1",
      text: " leading",
      type: .chatMessagePost
    ))
  } catch {
    invalidEncodeWasRejected = true
  }
  #expect(invalidEncodeWasRejected)
  let validEncoded = try PostMessageCodec.encode(PostMessage(
    clientNote: nil,
    encrypted: true,
    retryCount: 0,
    roomId: "room-1",
    text: "Hello",
    type: .chatMessagePost
  ))
  let validObject = try #require(JSONSerialization.jsonObject(with: validEncoded) as? [String: Any])
  #expect(validObject.keys.contains("clientNote"))
  #expect(validObject["clientNote"] is NSNull)
  let transport = Transport()
  try FixtureAPIServerRegistration(handler: Handler()).register(on: transport)
  #expect(transport.registrations == 1)
  #expect(FixtureAPIChannels.roomChat.address == "/realtime/rooms/{roomId}/chat")
}

@Test func typedIncomingMessagesPullLazilyWithoutRebuffering() async throws {
  let data = try PostMessageCodec.encode(PostMessage(
    clientNote: nil,
    encrypted: true,
    retryCount: 0,
    roomId: "room-1",
    text: "Hello",
    type: .chatMessagePost
  ))
  let source = PullSource(message: .binary(Array(data)))
  let messages = AsyncThrowingStream<AsyncAPITransportMessage, any Error>(unfolding: {
    await source.next()
  })
  let connection = AsyncAPIConnection<Void>(
    parameters: ["roomId": "room-1"],
    messages: messages,
    send: { _ in },
    close: { _ in }
  )
  let session = RoomChatServerSession<Void>(connection: connection)
  #expect(await source.count() == 0)
  var iterator = session.incoming.makeAsyncIterator()
  #expect(try await iterator.next() != nil)
  #expect(await source.count() == 1)
}
`;
}

function dartExecutable() {
  if (process.env.DART_BIN && existsSync(process.env.DART_BIN)) return process.env.DART_BIN;
  const fvmDart = join(homedir(), "fvm", "versions", "3.44.2", "bin", "cache", "dart-sdk", "bin", "dart");
  return existsSync(fvmDart) ? fvmDart : undefined;
}

function dartAcceptance(vectors) {
  const encoded = vectors.map(vector => ({
    ...vector,
    base64: Buffer.from(JSON.stringify(vector.json), "utf8").toString("base64")
  }));
  return `import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:generated_acceptance/realtime_chat_api.dart';

final class _Connection implements AsyncApiSocketConnection {
  @override
  Stream<Uint8List> get messages => const Stream<Uint8List>.empty();
  @override
  Future<AsyncApiPeerClose> get closed async => const AsyncApiPeerClose(1000, 'done');
  @override
  Future<void> send(Uint8List payload) async {}
  @override
  Future<void> close(AsyncApiWebSocketCloseSignal signal) async {}
}

final class _Adapter implements AsyncApiSocketAdapter {
  int calls = 0;
  @override
  Future<AsyncApiSocketConnection> connect(AsyncApiChannel channel, Map<String, String> parameters) async {
    calls += 1;
    if (parameters['roomId'] != 'room-1') throw StateError('missing typed path parameter');
    return _Connection();
  }
}

Future<void> main() async {
  const vectors = ${JSON.stringify(encoded.map(({ name, valid, base64 }) => ({ name, valid, base64 })))};
  for (final vector in vectors) {
    var accepted = true;
    try {
      const PostMessageCodec().decode(Uint8List.fromList(base64Decode(vector['base64']! as String)));
    } on Object {
      accepted = false;
    }
    if (accepted != vector['valid']) throw StateError('codec vector failed: \${vector['name']}');
  }
  var invalidEncodeWasRejected = false;
  try {
    const PostMessageCodec().encode(const PostMessage(
      clientNote: null,
      encrypted: true,
      roomId: 'room-1',
      retryCount: 4,
      text: ' leading',
      type: PostMessageType.chatMessagePost,
    ));
  } on Object {
    invalidEncodeWasRejected = true;
  }
  if (!invalidEncodeWasRejected) throw StateError('strict encode accepted invalid constraints');
  final validEncoded = const PostMessageCodec().encode(const PostMessage(
    clientNote: null,
    encrypted: true,
    roomId: 'room-1',
    retryCount: 0,
    text: 'Hello',
    type: PostMessageType.chatMessagePost,
  ));
  final validObject = jsonDecode(utf8.decode(validEncoded)) as Map<String, Object?>;
  if (!validObject.containsKey('clientNote') || validObject['clientNote'] != null) {
    throw StateError('required nullable key was not encoded as explicit null');
  }
  final adapter = _Adapter();
  final client = RealtimeChatAPIClient(adapter);
  final first = await client.connectRoomChat(roomId: 'room-1');
  final second = await client.connectRoomChat(roomId: 'room-1');
  if (identical(first, second) || adapter.calls != 2) throw StateError('adapter must be injected for every connection');
  final peerClose = await first.closed;
  if (peerClose.code != 1000 || peerClose.reason != 'done') throw StateError('typed peer close was not exposed');
}
`;
}

test("npm package contains the executable and direct emitter sources", async () => {
  await inTemporaryDirectory("asyncapi-pack-", async root => {
    const npmCLI = process.env.npm_execpath;
    assert.ok(npmCLI, "npm_execpath is required for package acceptance");
    const packed = JSON.parse(run(process.execPath, [npmCLI, "pack", "--dry-run", "--json"], {
      cwd: packageRoot,
      env: { ...process.env, npm_config_cache: join(root, "npm-cache") }
    }));
    const files = new Map(packed[0].files.map(file => [file.path, file]));
    assert.equal(files.get("bin/asyncapi-soenan-generator.mjs")?.mode, 0o755);
    for (const path of [
      "LICENSE",
      "NOTICE",
      "README.md",
      "asyncapi-generator.schema.json",
      "src/cli.mjs",
      "src/generator.mjs",
      "src/codegen/ir.js",
      "src/codegen/emit-dart.js",
      "src/codegen/emit-swift.js"
    ]) {
      assert.ok(files.has(path), `package is missing ${path}`);
    }
    assert.equal([...files.keys()].some(path => path.includes("__transpiled")), false);
  });
});

test("published runtime dependencies stay parser-only", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const lock = await readFile(join(packageRoot, "package-lock.json"), "utf8");
  assert.deepEqual(manifest.dependencies, { "@asyncapi/parser": "3.6.1" });
  assert.equal(lock.includes("@asyncapi/generator-react-sdk"), false);
  assert.equal(lock.includes('"node_modules/react"'), false);
  assert.equal(lock.includes('"node_modules/rollup"'), false);
});

test("package bin generates and checks multiple config-relative targets without a workspace wrapper", async () => {
  await inTemporaryDirectory("asyncapi-cli-", async root => {
    const contract = join(root, "contract");
    const configDirectory = join(root, "config");
    await cp(resolve("test/fixtures/realtime-chat"), contract, { recursive: true });
    await mkdir(configDirectory, { recursive: true });
    const config = join(configDirectory, "generator.json");
    await writeFile(config, `${JSON.stringify({
      input: "../contract/asyncapi.yaml",
      targets: [
        { language: "swift", moduleName: "FixtureAPI", output: "../generated/swift" },
        { language: "dart", moduleName: "FixtureAPI", output: "../generated/dart" }
      ]
    }, null, 2)}\n`, "utf8");
    const options = {
      cwd: root,
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` }
    };
    const generated = run(executable, ["generate", "--config", "config/generator.json"], options);
    assert.match(generated, /generate swift FixtureAPI/);
    assert.match(generated, /generate dart FixtureAPI/);
    assert.equal(existsSync(join(root, "generated/swift/Sources/FixtureAPI/AsyncAPIGenerated.swift")), true);
    assert.equal(existsSync(join(root, "generated/dart/lib/fixture_api.dart")), true);
    const checked = run(executable, ["check", "--config", "config/generator.json"], options);
    assert.match(checked, /check swift FixtureAPI/);
    assert.match(checked, /check dart FixtureAPI/);
  });
});

test("direct emitter output is deterministic, multi-file aware, and isolated under concurrency", async () => {
  await inTemporaryDirectory("asyncapi-determinism-", async root => {
    const first = join(root, "first");
    const second = join(root, "second");
    const target = output => [{ output, language: "dart", moduleName: "RealtimeChatAPI" }];
    await Promise.all([
      runConfigured(generate, root, fixture, target(first)),
      runConfigured(generate, root, fixture, target(second))
    ]);
    await Promise.all([
      runConfigured(check, root, fixture, target(first)),
      runConfigured(check, root, fixture, target(second))
    ]);
    const firstManifest = JSON.parse(await readFile(join(first, ".asyncapi-generator.json"), "utf8"));
    assert.deepEqual(firstManifest.files, ["lib/realtime_chat_api.dart", "lib/src/asyncapi_generated.dart"]);
    assert.deepEqual(await readFile(join(first, "lib/realtime_chat_api.dart")), await readFile(join(second, "lib/realtime_chat_api.dart")));
    assert.deepEqual(await readFile(join(first, "lib/src/asyncapi_generated.dart")), await readFile(join(second, "lib/src/asyncapi_generated.dart")));

    await writeFile(join(first, "lib/src/asyncapi_generated.dart"), "stale\n", "utf8");
    await assert.rejects(
      runConfigured(check, root, fixture, target(first)),
      error => error instanceof GeneratedOutputMismatchError
        && error.differences.some(value => value.endsWith("changed lib/src/asyncapi_generated.dart"))
    );

    await runConfigured(generate, root, fixture, [{ output: first, language: "swift", moduleName: "FixtureAPI" }]);
    assert.equal(existsSync(join(first, "lib/realtime_chat_api.dart")), false);
    assert.equal(existsSync(join(first, "Sources/FixtureAPI/AsyncAPIGenerated.swift")), true);
  });
});

test("generic YAML and keyword JSON output compile against the Swift runtime release", async () => {
  await inTemporaryDirectory("asyncapi-swift-", async root => {
    const realtime = join(root, "realtime");
    await runConfigured(generate, root, fixture, [
      { output: realtime, language: "swift", moduleName: "RealtimeChatAPI" }
    ]);
    assert.match(await readFile(join(realtime, "Sources/RealtimeChatAPI/AsyncAPIGenerated.swift"), "utf8"), /public var sequence: Int64/);
    await configureSwiftPackage(realtime, "RealtimeChatAPI", `import Testing
@testable import RealtimeChatAPI

@Test func generatedNamesAndChannelCompile() {
  #expect(RealtimeChatAPIChannels.roomChat.address.hasPrefix("/realtime/rooms/"))
  _ = MessageRejected.self
}
`);
    runSwift(["test", "--disable-sandbox", "--package-path", realtime], realtime);

    const keyword = join(root, "keyword");
    await runConfigured(generate, root, keywordFixture, [
      { output: keyword, language: "swift", moduleName: "KeywordAPI" }
    ]);
    await configureSwiftPackage(keyword, "KeywordAPI", `import Testing
@testable import KeywordAPI

@Test func keywordTypesCompile() {
  _ = AnyValue.self
  _ = Function.self
  #expect(KeywordAPIChannels.self_.parameterNames == ["class"])
}
`);
    runSwift(["test", "--disable-sandbox", "--package-path", keyword], keyword);
  });
});

const dart = dartExecutable();
test("Dart public library analyzes and enforces the shared codec vectors", { skip: dart ? false : "Dart SDK not found; set DART_BIN" }, async () => {
  await inTemporaryDirectory("asyncapi-dart-", async output => {
    await runConfigured(generate, output, fixture, [
      { output, language: "dart", moduleName: "RealtimeChatAPI" }
    ]);
    await writeFile(join(output, "pubspec.yaml"), `name: generated_acceptance
environment:
  sdk: '>=3.8.0 <4.0.0'
`, "utf8");
    const bin = join(output, "bin");
    await mkdir(bin, { recursive: true });
    const vectors = JSON.parse(await readFile(vectorsPath, "utf8"));
    await writeFile(join(bin, "acceptance.dart"), dartAcceptance(vectors), "utf8");
    const dartOptions = {
      cwd: output,
      env: {
        ...process.env,
        CI: "true",
        DART_SUPPRESS_ANALYTICS: "true",
        FLUTTER_SUPPRESS_ANALYTICS: "true"
      }
    };
    run(dart, ["pub", "get", "--offline"], dartOptions);
    run(dart, ["analyze"], dartOptions);
    run(dart, ["run", "bin/acceptance.dart"], dartOptions);
  });
  await inTemporaryDirectory("asyncapi-dart-keywords-", async output => {
    await runConfigured(generate, output, keywordFixture, [
      { output, language: "dart", moduleName: "KeywordAPI" }
    ]);
    await writeFile(join(output, "pubspec.yaml"), `name: keyword_acceptance
environment:
  sdk: '>=3.8.0 <4.0.0'
`, "utf8");
    const bin = join(output, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "acceptance.dart"), `import 'package:keyword_acceptance/keyword_api.dart';

void main() {
  const any = Any(cashValue: 'value', class_: 'class', displayName: 'display', type: AnyType.clientSend);
  const function = FunctionValue(result: true, type: FunctionType.serverResult);
  if (any.toJson().isEmpty || function.toJson().isEmpty) throw StateError('keyword type mismatch');
  if (KeywordAPIChannels.self.address != '/keyword/{class}') throw StateError('keyword channel mismatch');
}
`, "utf8");
    const dartOptions = {
      cwd: output,
      env: {
        ...process.env,
        CI: "true",
        DART_SUPPRESS_ANALYTICS: "true",
        FLUTTER_SUPPRESS_ANALYTICS: "true"
      }
    };
    run(dart, ["pub", "get", "--offline"], dartOptions);
    run(dart, ["analyze"], dartOptions);
    run(dart, ["run", "bin/acceptance.dart"], dartOptions);
  });
});

test("Swift codec uses the same cross-language strict vectors", async () => {
  await inTemporaryDirectory("asyncapi-swift-vectors-", async output => {
    await runConfigured(generate, output, fixture, [
      { output, language: "swift", moduleName: "FixtureAPI" }
    ]);
    const vectors = JSON.parse(await readFile(vectorsPath, "utf8"));
    await configureSwiftPackage(output, "FixtureAPI", swiftVectorTests(vectors));
    runSwift(["test", "--disable-sandbox", "--package-path", output], output);
  });
});
