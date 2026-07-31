# AsyncAPI Swift and Dart Generator

`@soenan/asyncapi-generator` turns one AsyncAPI 3.1 WebSocket contract into
compile-ready Swift server types and Dart client types. Both outputs come from
the same validated intermediate model, so a backend and frontend do not need
separate handwritten message, operation, or path contracts.

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
- Whole-segment `{parameterName}` string path parameters.
- One or more JSON messages for each send or receive operation.
- A shared required string `const` discriminator when a direction has multiple
  messages.
- Closed fixed-property objects, typed maps, arrays, string enums, strings,
  bounded integers, numbers, booleans, and nullable types.
- `int32` as Swift `Int32` and bounded `int64` as Swift `Int64`.
- WebSocket close signals declared with the
  `x-websocket-close-signals` root extension.

Channel literal segments use ASCII URI-unreserved characters only. Empty,
`.`, `..`, percent-encoded, Unicode, colon, and backslash segments are rejected.
Every integer must fit Dart Web's exact JSON integer range.

The generator rejects unsupported schema composition, dynamic properties,
tuple arrays, unknown formats or validation keywords, non-JSON payloads,
headers, replies, bindings, security requirements, traits, correlation IDs,
parameter validation, ambiguous discriminators, and unidirectional channels.
Titles, descriptions, tags, examples, and external documentation remain valid
annotations when they do not change wire behavior.

## Generated output

Each target contains an `.asyncapi-generator.json` ownership manifest.
Regeneration replaces current generated files and removes only stale files
listed by the previous manifest; unrelated files are not deleted.

Swift output is written to
`Sources/<ModuleName>/AsyncAPIGenerated.swift`. It includes Codable models,
strict JSON codecs, typed direction unions, operation metadata, channel
registration, close signals, and a server session. A channel's
`<Channel>IncomingMessages` is a lazy `AsyncSequence`: each iterator `next()`
pulls and decodes one transport message without adding another inbound buffer.

Dart output provides `lib/<module_name>.dart` as the public library and keeps
implementation code in `lib/src/asyncapi_generated.dart`. It includes models,
strict codecs, typed sessions, operation metadata, close signals, and the
`AsyncApiSocketAdapter` interface used to open a connection.

Generated code is deterministic for the same generator version, config, and
contract. Commit generated output when consumers must build without running
Node.js, and run `check` in CI to detect drift.

## Swift runtime relationship

Swift output imports `AsyncAPIRuntime` from the separate
[`swift-asyncapi-runtime`](https://github.com/soenan-apps/swift-asyncapi-runtime)
package. The generator does not copy or discover a local runtime checkout.
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
generated Swift against `AsyncAPIRuntime`. Template sources live under
`template/src/`; `template/__transpiled/` is generated scratch output and must
not be edited or published.

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
reported in local and CI logs. Remote `$ref` documents are outside the supported
contract; use trusted local files.

Report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/soenan-apps/asyncapi-generator/security/advisories/new).
Use the public issue tracker for non-sensitive bugs and feature proposals.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and
[NOTICE](NOTICE).
