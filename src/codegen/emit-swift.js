import {
  sourceCommentLiteral,
  swiftIdentifier,
  swiftStringLiteral,
  swiftTypeName
} from "./names.js";

const joinLines = items => items.filter(value => value !== undefined && value !== "").join("\n");
const literal = value => value === undefined ? "nil" : String(value);
const quoted = swiftStringLiteral;

function docs(value, indentation = "") {
  if (!value) return undefined;
  return String(value).split(/\r?\n/).map(line => `${indentation}/// ${line}`).join("\n");
}

function type(schema) {
  let value;
  switch (schema.kind) {
    case "object":
    case "enum": value = swiftTypeName(schema.name); break;
    case "array": value = `[${type(schema.items)}]`; break;
    case "map": value = `[String: ${type(schema.values)}]`; break;
    case "string": value = "String"; break;
    case "integer": value = schema.format === "int64" ? "Int64" : schema.format === "int32" ? "Int32" : "Int"; break;
    case "number": value = "Double"; break;
    case "boolean": value = "Bool"; break;
    default: throw new TypeError(`unknown schema kind ${schema.kind}`);
  }
  return schema.nullable ? `${value}?` : value;
}

function propertyType(property) {
  const value = type(property.schema);
  return property.required || value.endsWith("?") ? value : `${value}?`;
}

function emitEnum(schema) {
  return joinLines([
    docs(schema.description),
    `public enum ${swiftTypeName(schema.name)}: String, Codable, Sendable, Equatable {`,
    ...schema.values.map(value => `  case ${swiftIdentifier(value)} = ${quoted(value)}`),
    "}"
  ]);
}

function emitObject(schema) {
  const schemaType = swiftTypeName(schema.name);
  const properties = schema.properties.flatMap(property => [
    docs(property.schema.description, "  "),
    `  public var ${swiftIdentifier(property.wireName)}: ${propertyType(property)}`
  ]);
  if (schema.properties.length === 0) {
    return joinLines([docs(schema.description), `public struct ${schemaType}: Codable, Sendable, Equatable {`, "  public init() {}", "}"]);
  }
  const parameters = schema.properties.map((property, index) =>
    `    ${swiftIdentifier(property.wireName)}: ${propertyType(property)}${property.required ? "" : " = nil"}${index === schema.properties.length - 1 ? "" : ","}`
  );
  const needsCustomEncoding = schema.properties.some(property => property.required && property.schema.nullable);
  const needsCodingKeys = needsCustomEncoding || schema.properties.some(property => swiftIdentifier(property.wireName) !== property.wireName);
  const codingKeys = needsCodingKeys
    ? schema.properties.map(property => swiftIdentifier(property.wireName) === property.wireName
      ? `    case ${swiftIdentifier(property.wireName)}`
      : `    case ${swiftIdentifier(property.wireName)} = ${quoted(property.wireName)}`)
    : [];
  const encoding = needsCustomEncoding ? [
    "  public func encode(to encoder: any Encoder) throws {",
    "    var container = encoder.container(keyedBy: CodingKeys.self)",
    ...schema.properties.map(property => property.required
      ? `    try container.encode(${swiftIdentifier(property.wireName)}, forKey: .${swiftIdentifier(property.wireName)})`
      : `    try container.encodeIfPresent(${swiftIdentifier(property.wireName)}, forKey: .${swiftIdentifier(property.wireName)})`),
    "  }"
  ] : [];
  return joinLines([
    docs(schema.description),
    `public struct ${schemaType}: Codable, Sendable, Equatable {`,
    ...properties,
    "",
    "  public init(",
    ...parameters,
    "  ) {",
    ...schema.properties.map(property => `    self.${swiftIdentifier(property.wireName)} = ${swiftIdentifier(property.wireName)}`),
    "  }",
    codingKeys.length ? "" : undefined,
    codingKeys.length ? "  private enum CodingKeys: String, CodingKey {" : undefined,
    ...codingKeys,
    codingKeys.length ? "  }" : undefined,
    encoding.length ? "" : undefined,
    ...encoding,
    "}"
  ]);
}

function schemaExpression(schema, patternNames) {
  let kind;
  switch (schema.kind) {
    case "object":
      kind = `.object(properties: [${schema.properties.map(property => `${quoted(property.wireName)}: _AsyncAPIField(required: ${property.required}, schema: ${schemaExpression(property.schema, patternNames)})`).join(", ")}], additionalProperties: ${schema.additionalProperties})`;
      break;
    case "array": kind = `.array(items: ${schemaExpression(schema.items, patternNames)})`; break;
    case "map": kind = `.map(values: ${schemaExpression(schema.values, patternNames)})`; break;
    case "enum": kind = `.string(allowed: [${schema.values.map(quoted).join(", ")}])`; break;
    case "string": kind = ".string(allowed: nil)"; break;
    case "integer": kind = ".integer"; break;
    case "number": kind = ".number"; break;
    case "boolean": kind = ".boolean"; break;
    default: throw new TypeError(`unknown schema kind ${schema.kind}`);
  }
  return `_AsyncAPISchema(kind: ${kind}, nullable: ${schema.nullable}, minimum: ${literal(schema.minimum)}, maximum: ${literal(schema.maximum)}, exclusiveMinimum: ${literal(schema.exclusiveMinimum)}, exclusiveMaximum: ${literal(schema.exclusiveMaximum)}, minLength: ${literal(schema.minLength)}, maxLength: ${literal(schema.maxLength)}, pattern: ${schema.pattern === undefined ? "nil" : `_AsyncAPIPatternRegistry.${patternNames.get(schema.pattern)}`}, minItems: ${literal(schema.minItems)}, maxItems: ${literal(schema.maxItems)})`;
}

function emitStrictRuntime(patterns, includeTransportMessages = true) {
  return `private enum _AsyncAPICodecError: Error {
  case invalid(path: String, reason: String)
}

private struct _AsyncAPIPattern: @unchecked Sendable {
  private let expression: NSRegularExpression

  init(_ source: String) {
    self.expression = try! NSRegularExpression(pattern: source)
  }

  func matches(_ value: String) -> Bool {
    expression.firstMatch(
      in: value,
      range: NSRange(value.startIndex..<value.endIndex, in: value)
    ) != nil
  }
}

private enum _AsyncAPIPatternRegistry {
${patterns.map((pattern, index) => `  static let p${index} = _AsyncAPIPattern(${quoted(pattern)})`).join("\n")}
}

private struct _AsyncAPIField: Sendable {
  let required: Bool
  let schema: _AsyncAPISchema
}

private indirect enum _AsyncAPISchemaKind: Sendable {
  case object(properties: [String: _AsyncAPIField], additionalProperties: Bool)
  case array(items: _AsyncAPISchema)
  case map(values: _AsyncAPISchema)
  case string(allowed: Set<String>?)
  case integer
  case number
  case boolean
}

private struct _AsyncAPISchema: Sendable {
  let kind: _AsyncAPISchemaKind
  let nullable: Bool
  let minimum: Double?
  let maximum: Double?
  let exclusiveMinimum: Double?
  let exclusiveMaximum: Double?
  let minLength: Int?
  let maxLength: Int?
  let pattern: _AsyncAPIPattern?
  let minItems: Int?
  let maxItems: Int?

  init(
    kind: _AsyncAPISchemaKind,
    nullable: Bool = false,
    minimum: Double? = nil,
    maximum: Double? = nil,
    exclusiveMinimum: Double? = nil,
    exclusiveMaximum: Double? = nil,
    minLength: Int? = nil,
    maxLength: Int? = nil,
    pattern: _AsyncAPIPattern? = nil,
    minItems: Int? = nil,
    maxItems: Int? = nil
  ) {
    self.kind = kind
    self.nullable = nullable
    self.minimum = minimum
    self.maximum = maximum
    self.exclusiveMinimum = exclusiveMinimum
    self.exclusiveMaximum = exclusiveMaximum
    self.minLength = minLength
    self.maxLength = maxLength
    self.pattern = pattern
    self.minItems = minItems
    self.maxItems = maxItems
  }
}

private enum _AsyncAPIStrictJSON {
  static func value(from data: Data) throws -> Any {
    try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
  }
${includeTransportMessages ? `
  static func data(from message: AsyncAPITransportMessage) -> Data {
    switch message {
    case .text(let text): return Data(text.utf8)
    case .binary(let bytes): return Data(bytes)
    }
  }
` : ""}

  static func validate(_ value: Any, schema: _AsyncAPISchema, path: String = "$") throws {
    if value is NSNull {
      guard schema.nullable else { throw _AsyncAPICodecError.invalid(path: path, reason: "null is not allowed") }
      return
    }
    switch schema.kind {
    case .object(let properties, let additionalProperties):
      guard let object = value as? [String: Any] else { throw _AsyncAPICodecError.invalid(path: path, reason: "expected object") }
      if !additionalProperties, let unknown = object.keys.first(where: { properties[$0] == nil }) {
        throw _AsyncAPICodecError.invalid(path: "\\(path).\\(unknown)", reason: "unknown property")
      }
      for (name, field) in properties {
        guard let child = object[name] else {
          if field.required { throw _AsyncAPICodecError.invalid(path: "\\(path).\\(name)", reason: "required property is missing") }
          continue
        }
        try validate(child, schema: field.schema, path: "\\(path).\\(name)")
      }
    case .array(let items):
      guard let array = value as? [Any] else { throw _AsyncAPICodecError.invalid(path: path, reason: "expected array") }
      if let minimum = schema.minItems, array.count < minimum { throw _AsyncAPICodecError.invalid(path: path, reason: "array is shorter than minItems") }
      if let maximum = schema.maxItems, array.count > maximum { throw _AsyncAPICodecError.invalid(path: path, reason: "array is longer than maxItems") }
      for (index, child) in array.enumerated() { try validate(child, schema: items, path: "\\(path)[\\(index)]") }
    case .map(let values):
      guard let object = value as? [String: Any] else { throw _AsyncAPICodecError.invalid(path: path, reason: "expected object") }
      for (name, child) in object { try validate(child, schema: values, path: "\\(path).\\(name)") }
    case .string(let allowed):
      guard let string = value as? String else { throw _AsyncAPICodecError.invalid(path: path, reason: "expected string") }
      let length = string.unicodeScalars.count
      if let minimum = schema.minLength, length < minimum { throw _AsyncAPICodecError.invalid(path: path, reason: "string is shorter than minLength") }
      if let maximum = schema.maxLength, length > maximum { throw _AsyncAPICodecError.invalid(path: path, reason: "string is longer than maxLength") }
      if schema.pattern != nil, length > 4_096 { throw _AsyncAPICodecError.invalid(path: path, reason: "string exceeds pattern input budget") }
      if let pattern = schema.pattern, !pattern.matches(string) { throw _AsyncAPICodecError.invalid(path: path, reason: "string does not match pattern") }
      if let allowed, !allowed.contains(string) { throw _AsyncAPICodecError.invalid(path: path, reason: "unknown enum or const value") }
    case .integer:
      guard let number = value as? NSNumber,
        CFGetTypeID(number) != CFBooleanGetTypeID(),
        number.doubleValue.rounded(.towardZero) == number.doubleValue
      else {
        throw _AsyncAPICodecError.invalid(path: path, reason: "expected integer")
      }
      try validateNumber(number.doubleValue, schema: schema, path: path)
    case .number:
      guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
        throw _AsyncAPICodecError.invalid(path: path, reason: "expected number")
      }
      try validateNumber(number.doubleValue, schema: schema, path: path)
    case .boolean:
      guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
        throw _AsyncAPICodecError.invalid(path: path, reason: "expected boolean")
      }
    }
  }

  private static func validateNumber(_ value: Double, schema: _AsyncAPISchema, path: String) throws {
    if let minimum = schema.minimum, value < minimum { throw _AsyncAPICodecError.invalid(path: path, reason: "number is below minimum") }
    if let maximum = schema.maximum, value > maximum { throw _AsyncAPICodecError.invalid(path: path, reason: "number is above maximum") }
    if let minimum = schema.exclusiveMinimum, value <= minimum { throw _AsyncAPICodecError.invalid(path: path, reason: "number is below exclusiveMinimum") }
    if let maximum = schema.exclusiveMaximum, value >= maximum { throw _AsyncAPICodecError.invalid(path: path, reason: "number is above exclusiveMaximum") }
  }
}`;
}

function emitMessageCodec(message, patternNames) {
  const messageType = swiftTypeName(message.typeName);
  return `public enum ${messageType}Codec {
  private static let schema = ${schemaExpression(message.schema, patternNames)}

  public static func decode(_ data: Data) throws -> ${messageType} {
    try _AsyncAPIStrictJSON.validate(_AsyncAPIStrictJSON.value(from: data), schema: schema)
    return try JSONDecoder().decode(${messageType}.self, from: data)
  }

  public static func encode(_ message: ${messageType}) throws -> Data {
    let data = try JSONEncoder().encode(message)
    try _AsyncAPIStrictJSON.validate(_AsyncAPIStrictJSON.value(from: data), schema: schema)
    return data
  }
}`;
}

function emitUnion(union) {
  const cases = union.cases.map(value => `  case ${swiftIdentifier(value.name)}(${swiftTypeName(value.message.typeName)})`);
  return joinLines([`public enum ${swiftTypeName(union.name)}: Sendable, Equatable {`, ...cases, "}"]);
}

function emitUnionCodec(union) {
  const unionType = swiftTypeName(union.name);
  const discriminatorDecode = union.cases.length === 1
    ? `return .${swiftIdentifier(union.cases[0].name)}(try ${swiftTypeName(union.cases[0].message.typeName)}Codec.decode(data))`
    : `guard let object = try _AsyncAPIStrictJSON.value(from: data) as? [String: Any],
      let discriminator = object[${quoted(union.discriminator)}] as? String
    else { throw _AsyncAPICodecError.invalid(path: "$.${union.discriminator}", reason: "message discriminator is missing") }
    switch discriminator {
${union.cases.map(value => `    case ${quoted(value.discriminatorValue)}: return .${swiftIdentifier(value.name)}(try ${swiftTypeName(value.message.typeName)}Codec.decode(data))`).join("\n")}
    default: throw _AsyncAPICodecError.invalid(path: "$.${union.discriminator}", reason: "unknown message discriminator")
    }`;
  return `private enum ${unionType}Codec {
  static func decode(_ transportMessage: AsyncAPITransportMessage) throws -> ${unionType} {
    let data = _AsyncAPIStrictJSON.data(from: transportMessage)
    ${discriminatorDecode}
  }

  static func encode(_ message: ${unionType}) throws -> AsyncAPITransportMessage {
    let data: Data
    switch message {
${union.cases.map(value => `    case .${swiftIdentifier(value.name)}(let value): data = try ${swiftTypeName(value.message.typeName)}Codec.encode(value)`).join("\n")}
    }
    return .text(String(decoding: data, as: UTF8.self))
  }
}`;
}

function emitSSEUnionCodec(union) {
  const unionType = swiftTypeName(union.name);
  const discriminatorDecode = union.cases.length === 1
    ? `return .${swiftIdentifier(union.cases[0].name)}(try ${swiftTypeName(union.cases[0].message.typeName)}Codec.decode(data))`
    : `guard let object = try _AsyncAPIStrictJSON.value(from: data) as? [String: Any],
      let discriminator = object[${quoted(union.discriminator)}] as? String
    else { throw _AsyncAPICodecError.invalid(path: "$.${union.discriminator}", reason: "message discriminator is missing") }
    switch discriminator {
${union.cases.map(value => `    case ${quoted(value.discriminatorValue)}: return .${swiftIdentifier(value.name)}(try ${swiftTypeName(value.message.typeName)}Codec.decode(data))`).join("\n")}
    default: throw _AsyncAPICodecError.invalid(path: "$.${union.discriminator}", reason: "unknown message discriminator")
    }`;
  return `public enum ${unionType}Codec {
  public static func decode(_ data: Data) throws -> ${unionType} {
    ${discriminatorDecode}
  }

  public static func encode(_ message: ${unionType}) throws -> Data {
    switch message {
${union.cases.map(value => `    case .${swiftIdentifier(value.name)}(let value): return try ${swiftTypeName(value.message.typeName)}Codec.encode(value)`).join("\n")}
    }
  }
}`;
}

function emitSSEChannel(channel) {
  return `${emitUnion(channel.outgoing)}

${emitSSEUnionCodec(channel.outgoing)}`;
}

function emitChannel(channel) {
  const session = `${swiftTypeName(channel.typeName)}ServerSession`;
  const incomingType = swiftTypeName(channel.incoming.name);
  const incomingSequence = `${swiftTypeName(channel.typeName)}IncomingMessages`;
  const outgoingType = swiftTypeName(channel.outgoing.name);
  const incomingCodec = `${incomingType}Codec`;
  return `${emitUnion(channel.incoming)}

${emitUnion(channel.outgoing)}

${emitUnionCodec(channel.incoming)}

${emitUnionCodec(channel.outgoing)}

public struct ${incomingSequence}: AsyncSequence, Sendable {
  public typealias Element = ${incomingType}

  public struct Iterator: AsyncIteratorProtocol {
    private var base: AsyncThrowingStream<AsyncAPITransportMessage, any Error>.Iterator

    fileprivate init(base: AsyncThrowingStream<AsyncAPITransportMessage, any Error>.Iterator) {
      self.base = base
    }

    public mutating func next() async throws -> Element? {
      guard let message = try await base.next() else { return nil }
      return try ${incomingCodec}.decode(message)
    }
  }

  private let messages: AsyncThrowingStream<AsyncAPITransportMessage, any Error>

  fileprivate init(messages: AsyncThrowingStream<AsyncAPITransportMessage, any Error>) {
    self.messages = messages
  }

  public func makeAsyncIterator() -> Iterator {
    Iterator(base: messages.makeAsyncIterator())
  }
}

public struct ${session}<ConnectionContext: Sendable>: Sendable {
  private let connection: AsyncAPIConnection<ConnectionContext>
  public let incoming: ${incomingSequence}

  public init(connection: AsyncAPIConnection<ConnectionContext>) {
    self.connection = connection
    self.incoming = ${incomingSequence}(messages: connection.messages)
  }

  public var applicationContext: ConnectionContext { connection.applicationContext }
  public var parameters: [String: String] { connection.parameters }

  public func send(_ message: ${outgoingType}) async throws {
    try await connection.send(try ${outgoingType}Codec.encode(message))
  }

  public func close(_ signal: AsyncAPICloseSignal) async throws {
    try await connection.close(signal)
  }
}`;
}

function emitOperationMetadata(channel) {
  return `public enum ${swiftTypeName(channel.typeName)}Operations {
${channel.operations.map(operation => `  public static let ${swiftIdentifier(operation.id)} = ${quoted(operation.id)}`).join("\n")}
}`;
}

function emitCloseSignals(ir) {
  if (!ir.closeSignals.length) return undefined;
  return `public enum ${swiftTypeName(ir.moduleName)}WebSocketCloseSignals {
${ir.closeSignals.map(signal => `  public static let ${swiftIdentifier(signal.name)}: AsyncAPICloseSignal = {
    let code = AsyncAPICloseCode(rawValue: ${signal.code})!
    return try! AsyncAPICloseSignal(code: code, reason: ${quoted(signal.reason)})
  }()`).join("\n\n")}
}`;
}

function emitSSEAPI(ir) {
  const moduleType = swiftTypeName(ir.moduleName);
  return `public struct AsyncAPIServerSentEventsChannel: Sendable, Equatable {
  public let name: String
  public let address: String

  public init(name: String, address: String) {
    self.name = name
    self.address = address
  }
}

public enum ${moduleType}Channels {
${ir.channels.map(channel => `  public static let ${swiftIdentifier(channel.name)} = AsyncAPIServerSentEventsChannel(
    name: ${quoted(channel.id)},
    address: ${quoted(channel.address)}
  )`).join("\n\n")}
}`;
}

function emitAPI(ir) {
  const moduleType = swiftTypeName(ir.moduleName);
  const protocolType = moduleType.endsWith("API") ? `${moduleType}Protocol` : `${moduleType}APIProtocol`;
  return `public protocol ${protocolType}: Sendable {
  associatedtype ConnectionContext: Sendable = Void
${ir.channels.map(channel => `  func ${swiftIdentifier(channel.name)}(_ session: ${swiftTypeName(channel.typeName)}ServerSession<ConnectionContext>) async throws`).join("\n")}
}

public enum ${moduleType}Channels {
${ir.channels.map(channel => `  public static let ${swiftIdentifier(channel.name)} = try! AsyncAPIChannel(
    name: ${quoted(channel.id)},
    address: ${quoted(channel.address)},
    parameterNames: [${channel.parameterNames.map(quoted).join(", ")}]
  )`).join("\n\n")}
}

public struct ${moduleType}ServerRegistration<Handler: ${protocolType}>: Sendable {
  public let handler: Handler

  public init(handler: Handler) { self.handler = handler }

  public func register<Transport: AsyncAPIServerTransport>(on transport: Transport) throws
  where Transport.ApplicationContext == Handler.ConnectionContext {
${ir.channels.map(channel => `    try transport.register(channel: ${moduleType}Channels.${swiftIdentifier(channel.name)}) { connection in
      try await handler.${swiftIdentifier(channel.name)}(${swiftTypeName(channel.typeName)}ServerSession(connection: connection))
    }`).join("\n")}
  }
}`;
}

export function emitSwift(ir) {
  const schemas = ir.schemas.map(schema => schema.kind === "enum" ? emitEnum(schema) : emitObject(schema));
  const patternNames = new Map(ir.patterns.map((pattern, index) => [pattern, `p${index}`]));
  const isSSE = ir.transport === "sse";
  return `${joinLines([
    "// Generated by @soenan/asyncapi-generator. Do not edit.",
    `// Source: ${sourceCommentLiteral(ir.title)} ${sourceCommentLiteral(ir.version)}`,
    "",
    isSSE ? undefined : "import AsyncAPIRuntime",
    "import CoreFoundation",
    "import Foundation",
    "",
    emitStrictRuntime(ir.patterns, !isSSE),
    "",
    ...schemas.flatMap((value, index) => index ? ["", value] : [value]),
    "",
    ...ir.messages.map(message => emitMessageCodec(message, patternNames)).flatMap((value, index) => index ? ["", value] : [value]),
    "",
    ...ir.channels.flatMap((channel, index) => index
      ? ["", emitOperationMetadata(channel), "", isSSE ? emitSSEChannel(channel) : emitChannel(channel)]
      : [emitOperationMetadata(channel), "", isSSE ? emitSSEChannel(channel) : emitChannel(channel)]),
    "",
    isSSE ? emitSSEAPI(ir) : emitAPI(ir),
    "",
    isSSE ? undefined : emitCloseSignals(ir)
  ])}\n`;
}
