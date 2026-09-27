# AsyncAPI Swift and Dart Generator

`@soenan/asyncapi-generator` turns an AsyncAPI 3.1 contract into compile-ready
Swift server types and Dart client types. Duplex WebSocket contracts generate
typed sessions and adapters. HTTP Server-Sent Events contracts generate
one-way message unions and public codecs without pretending the stream is a
socket. Both outputs come from the same validated intermediate model.

The generator intentionally supports a narrow contract surface. It rejects
wire semantics that it cannot preserve instead of producing plausible but
incomplete code.

## Five-minute quick start

The CLI requires Node.js `>=24.11.1 <25`.

1. Install the package as a development dependency.

   ```sh
   npm install --save-dev @soenan/asyncapi-generator
   ```

2. Save this minimal contract as `contracts/realtime.yaml`.

   ```yaml
   asyncapi: 3.1.0
   info:
     title: Realtime chat
     version: 1.0.0
   defaultContentType: application/json
   channels:
     roomChat:
       address: /realtime/rooms/{roomId}/chat
       parameters:
         roomId:
           description: Stable room identifier.
       messages:
         postMessage:
           name: PostMessage
           payload:
             type: object
             additionalProperties: false
             required: [type, roomId, text]
             properties:
               type: { type: string, const: chat.message.post }
               roomId: { type: string, minLength: 1 }
               text: { type: string, minLength: 1, maxLength: 500 }
         messagePosted:
           name: MessagePosted
           payload:
             type: object
             additionalProperties: false
             required: [type, roomId, messageId, text]
             properties:
               type: { type: string, const: chat.message.posted }
               roomId: { type: string, minLength: 1 }
               messageId: { type: string, minLength: 1 }
               text: { type: string, minLength: 1, maxLength: 500 }
   operations:
     receiveChatCommand:
       action: receive
       channel: { $ref: '#/channels/roomChat' }
       messages: [{ $ref: '#/channels/roomChat/messages/postMessage' }]
     sendChatEvent:
       action: send
       channel: { $ref: '#/channels/roomChat' }
       messages: [{ $ref: '#/channels/roomChat/messages/messagePosted' }]
   ```

3. Save this config as `contracts/generator.json`.

   ```json
   {
     "input": "realtime.yaml",
     "targets": [
       {
         "language": "swift",
         "moduleName": "RealtimeChatAPI",
         "output": "../generated/swift"
       },
       {
         "language": "dart",
         "moduleName": "RealtimeChatAPI",
         "output": "../generated/dart"
       }
     ]
   }
   ```

4. Add scripts to the consuming `package.json` and run them.

   ```json
   {
     "scripts": {
       "asyncapi:generate": "asyncapi-soenan-generator generate --config contracts/generator.json",
       "asyncapi:check": "asyncapi-soenan-generator check --config contracts/generator.json"
     }
   }
   ```

   ```sh
   npm run asyncapi:generate
   npm run asyncapi:check
   ```

`generate` stages every target before writing. `check` is read-only and exits
non-zero when a generated file is missing, changed, or stale.

## Configuration

The CLI accepts exactly one configuration file:

```text
asyncapi-soenan-generator generate --config FILE
asyncapi-soenan-generator check --config FILE
```

The config has one `input` and one or more `targets`:

| Field | Meaning |
| --- | --- |
| `input` | AsyncAPI 3.1 YAML or JSON document. Local `$ref` files are supported. |
| `targets[].language` | `swift` or `dart`. |
| `targets[].moduleName` | A shared Swift/Dart identifier such as `RealtimeChatAPI`. |
| `targets[].output` | Destination directory owned by this target. |

Relative `input` and `output` paths resolve from the config file's directory,
not the caller's current directory. Target output directories must not be equal
or nested, and a filesystem root is never accepted as an output. Unknown config
fields fail validation. The published `asyncapi-generator.schema.json` can be
used for editor validation.

## Supported contract surface

The current generator supports:

- AsyncAPI `3.1.0` documents in YAML or JSON, including local file references.
- Duplex WebSocket channels with `ws` or `wss` servers.
- One-way Server-Sent Events channels with `http` or `https` servers, the
  `x-server-sent-events` framing declaration, and an HTTP 0.3.0 `GET` operation
  binding with a closed query schema.
- Whole-segment `{parameterName}` string path parameters.
- One or more JSON messages for each declared operation.
- A shared required string `const` discriminator when a direction has multiple
  messages.
- Closed fixed-property objects, typed maps, arrays, string enums, strings,
  bounded integers, numbers, booleans, and nullable types.
- String patterns in the portable, bounded regular-expression subset described
  under Security and limitations.
- `int32` as Swift `Int32` and bounded `int64` as Swift `Int64`.
- WebSocket close signals declared with the
  `x-websocket-close-signals` root extension for WebSocket contracts only.

Channel literal segments use ASCII URI-unreserved characters only. Empty,
`.`, `..`, percent-encoded, Unicode, colon, and backslash segments are rejected.
Every integer must fit Dart Web's exact JSON integer range.

The generator rejects unsupported schema composition, dynamic properties,
tuple arrays, unknown formats or validation keywords, non-JSON payloads,
headers, replies, unsupported bindings, security requirements, traits,
correlation IDs, path-parameter validation, ambiguous discriminators, and
unsupported transport directions. Titles, descriptions, tags, examples, and
external documentation remain valid annotations when they do not change wire
behavior.

## Generated output

Each target contains an `.asyncapi-generator.json` ownership manifest.
Regeneration replaces current generated files and removes only stale files
listed by the previous manifest; unrelated files are not deleted.

Swift output is written to
`Sources/<ModuleName>/AsyncAPIGenerated.swift`. It includes Codable models,
strict JSON codecs, typed direction unions, operation metadata, and channel
metadata. WebSocket contracts additionally include channel registration, close
signals, and a server session. An SSE server-message union codec is public and
accepts or returns raw JSON `Data`.

Dart output provides `lib/<module_name>.dart` as the public library and keeps
implementation code in `lib/src/asyncapi_generated.dart`. It includes models,
strict codecs, typed message unions, operation metadata, and channel metadata.
WebSocket contracts additionally include typed sessions, close signals, and the
`AsyncApiSocketAdapter`. An SSE server-message union codec is public and accepts
or returns `Uint8List`.

Generated code is deterministic for the same generator version, config, and
contract. Commit generated output when consumers must build without running
Node.js, and run `check` in CI to detect drift.

## Swift runtime relationship

Generated WebSocket Swift output imports `AsyncAPIRuntime` from the separate
[`swift-asyncapi-runtime`](https://github.com/soenan-apps/swift-asyncapi-runtime)
package. SSE output has no transport-runtime dependency. The generator does not
copy or discover a local runtime checkout.
Consumers should pin an exact runtime release compatible with their generator
version.

Acceptance tests compile generated Swift against the public runtime URL at
exact version `0.1.0`. `SWIFT_ASYNCAPI_RUNTIME_PATH` may explicitly select a
local checkout only while bootstrapping the first matching runtime release; it
is not an automatic fallback and should not be used in normal CI.

The generated Dart adapter interfaces have no external runtime package
dependency. Applications provide their WebSocket implementation explicitly.

## Versioning

The npm package follows Semantic Versioning. Before `1.0.0`, a minor release
may intentionally change the config, accepted AsyncAPI surface, generated API,
or runtime compatibility. Patch releases must not intentionally change a valid
contract's public generated API. Pin the generator and Swift runtime exactly
when reproducible generated output is required.

Generation manifests have their own schema version. An unsupported manifest is
rejected rather than guessed or silently migrated.

## Contributing

Install the repository toolchain and run the complete acceptance suite:

```sh
mise install
mise exec -- npm ci
npm test
npm pack --dry-run
```

The tests cover config and diagnostic behavior, concurrent deterministic
generation, package contents, Dart analysis and execution, and compilation of
generated Swift against `AsyncAPIRuntime`. The generator uses the official
AsyncAPI parser and writes the validated intermediate model through its direct
Swift and Dart emitters; it does not install or execute a template runtime.

Changes should include the smallest fixture that demonstrates the contract
boundary. New AsyncAPI features must either be represented completely in both
languages or fail with a stable path-qualified diagnostic.

## Security and limitations

Generated validation is not authentication or authorization. Applications are
responsible for authenticating connections, authorizing channel parameters,
limiting message and connection resources, selecting TLS settings, and safely
handling decoded content. Unsupported security schemes and protocol bindings
are rejected because the generator cannot enforce them.

Run the generator only on trusted local contracts and references. Do not place
secrets in contracts or generator configs; file paths and diagnostics can be
reported in local and CI logs. Remote and authority-bearing `$ref` documents are
rejected before resolution. Local references, including resolved symlinks, must
remain within the input contract's directory.

String `pattern` validation is deliberately narrower than arbitrary
ECMAScript regular expressions. Patterns are limited to 256 UTF-8 bytes,
literals, anchors, dot, character classes, portable character categories,
fixed repetition up to 256, and at most one variable repetition. Groups,
alternation, lookarounds, backreferences, multiple variable repetitions, and
other engine-specific constructs fail generation with
`schema.pattern.unsafe`. The generator normalizes `\s`, `\d`, and `\w` before
emission so Foundation and Dart use the same character sets and absolute end
semantics. Each unique accepted pattern is compiled once in a generated static
registry, and patterned input is rejected above 4,096 Unicode code points
before regular-expression evaluation.

The differential pattern corpus keeps both hand-written boundary vectors and a
fixed derived operation trace. Swift and Dart stock generated codecs execute
the same trace and assert exact verdicts plus deterministic compilation and
validation operation counts; wall-clock timing is not an acceptance oracle.

Report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/soenan-apps/asyncapi-generator/security/advisories/new).
Use the public issue tracker for non-sensitive bugs and feature proposals.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and
[NOTICE](NOTICE).
