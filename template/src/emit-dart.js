import { dartIdentifier, dartStringLiteral, dartTypeName } from "./names.js";

const joinLines = items => items.filter(value => value !== undefined && value !== "").join("\n");
const literal = value => value === undefined ? "null" : String(value);
const quoted = dartStringLiteral;

function type(schema) {
  let value;
  switch (schema.kind) {
    case "object":
    case "enum": value = dartTypeName(schema.name); break;
    case "array": value = `List<${type(schema.items)}>`; break;
    case "map": value = `Map<String, ${type(schema.values)}>`; break;
    case "string": value = "String"; break;
    case "integer": value = "int"; break;
    case "number": value = "double"; break;
    case "boolean": value = "bool"; break;
    default: throw new TypeError(`unknown schema kind ${schema.kind}`);
  }
  return schema.nullable ? `${value}?` : value;
}

function propertyType(property) {
  const value = type(property.schema);
  return property.required || value.endsWith("?") ? value : `${value}?`;
}

function decode(schema, expression) {
  let value;
  switch (schema.kind) {
    case "object": value = `${dartTypeName(schema.name)}.fromJson(Map<String, Object?>.from(${expression} as Map))`; break;
    case "enum": value = `${dartTypeName(schema.name)}.fromJson(${expression} as String)`; break;
    case "array": value = `(${expression} as List).map((value) => ${decode(schema.items, "value")}).toList(growable: false)`; break;
    case "map": value = `Map<String, Object?>.from(${expression} as Map).map((key, value) => MapEntry(key, ${decode(schema.values, "value")}))`; break;
    case "string": value = `${expression} as String`; break;
    case "integer": value = `${expression} as int`; break;
    case "number": value = `(${expression} as num).toDouble()`; break;
    case "boolean": value = `${expression} as bool`; break;
    default: throw new TypeError(`unknown schema kind ${schema.kind}`);
  }
  return schema.nullable ? `${expression} == null ? null : ${value}` : value;
}

function encode(schema, expression) {
  switch (schema.kind) {
    case "object": return `${expression}${schema.nullable ? "?" : ""}.toJson()`;
    case "enum": return `${expression}${schema.nullable ? "?" : ""}.toJson()`;
    case "array": return `${expression}${schema.nullable ? "?" : ""}.map((value) => ${encode(schema.items, "value")}).toList(growable: false)`;
    case "map": return `${expression}${schema.nullable ? "?" : ""}.map((key, value) => MapEntry(key, ${encode(schema.values, "value")}))`;
    default: return expression;
  }
}

function emitEnum(schema) {
  const schemaType = dartTypeName(schema.name);
  return `enum ${schemaType} {
${schema.values.map(value => `  ${dartIdentifier(value)}(${quoted(value)})`).join(",\n")};

  const ${schemaType}(this.wireValue);
  final String wireValue;

  static ${schemaType} fromJson(String value) => values.firstWhere(
        (candidate) => candidate.wireValue == value,
        orElse: () => throw FormatException(${quoted(`Unknown ${schema.name} value: `)} + value),
      );

  String toJson() => wireValue;
}`;
}

function emitObject(schema) {
  const schemaType = dartTypeName(schema.name);
  if (!schema.properties.length) {
    return `final class ${schemaType} {
  const ${schemaType}();
  factory ${schemaType}.fromJson(Map<String, Object?> json) => const ${schemaType}();
  Map<String, Object?> toJson() => const <String, Object?>{};
}`;
  }
  const encoded = schema.properties.flatMap(property => {
    const propertyName = dartIdentifier(property.wireName);
    const expression = !property.required && !property.schema.nullable ? `${propertyName}!` : propertyName;
    const entry = `${quoted(property.wireName)}: ${encode(property.schema, expression)},`;
    return property.required || property.schema.nullable
      ? [`        ${entry}`]
      : [`        if (${dartIdentifier(property.wireName)} != null) ${entry}`];
  });
  return `final class ${schemaType} {
  const ${schemaType}({
${schema.properties.map(property => `    ${property.required ? "required " : ""}this.${dartIdentifier(property.wireName)},`).join("\n")}
  });

${schema.properties.map(property => `  final ${propertyType(property)} ${dartIdentifier(property.wireName)};`).join("\n")}

  factory ${schemaType}.fromJson(Map<String, Object?> json) => ${schemaType}(
${schema.properties.map(property => {
  const access = `json[${quoted(property.wireName)}]`;
  const decoded = decode(property.schema, access);
  return `        ${dartIdentifier(property.wireName)}: ${property.required || property.schema.nullable ? decoded : `${access} == null ? null : ${decoded}`},`;
}).join("\n")}
      );

  Map<String, Object?> toJson() => <String, Object?>{
${encoded.join("\n")}
      };
}`;
}

function schemaExpression(schema) {
  let kind;
  let extras = "";
  switch (schema.kind) {
    case "object":
      kind = "_AsyncApiSchemaKind.object";
      extras = `, properties: <String, _AsyncApiField>{${schema.properties.map(property => `${quoted(property.wireName)}: _AsyncApiField(${property.required}, ${schemaExpression(property.schema)})`).join(", ")}}, additionalProperties: ${schema.additionalProperties}`;
      break;
    case "array": kind = "_AsyncApiSchemaKind.array"; extras = `, items: ${schemaExpression(schema.items)}`; break;
    case "map": kind = "_AsyncApiSchemaKind.map"; extras = `, values: ${schemaExpression(schema.values)}`; break;
    case "enum": kind = "_AsyncApiSchemaKind.string"; extras = `, allowed: <String>{${schema.values.map(quoted).join(", ")}}`; break;
    case "string": kind = "_AsyncApiSchemaKind.string"; break;
    case "integer": kind = "_AsyncApiSchemaKind.integer"; break;
    case "number": kind = "_AsyncApiSchemaKind.number"; break;
    case "boolean": kind = "_AsyncApiSchemaKind.boolean"; break;
    default: throw new TypeError(`unknown schema kind ${schema.kind}`);
  }
  return `_AsyncApiSchema(${kind}, nullable: ${schema.nullable}, minimum: ${literal(schema.minimum)}, maximum: ${literal(schema.maximum)}, exclusiveMinimum: ${literal(schema.exclusiveMinimum)}, exclusiveMaximum: ${literal(schema.exclusiveMaximum)}, minLength: ${literal(schema.minLength)}, maxLength: ${literal(schema.maxLength)}, pattern: ${schema.pattern === undefined ? "null" : quoted(schema.pattern)}, minItems: ${literal(schema.minItems)}, maxItems: ${literal(schema.maxItems)}${extras})`;
}

function emitStrictRuntime() {
  return `enum _AsyncApiSchemaKind { object, array, map, string, integer, number, boolean }

final class _AsyncApiField {
  const _AsyncApiField(this.required, this.schema);
  final bool required;
  final _AsyncApiSchema schema;
}

final class _AsyncApiSchema {
  const _AsyncApiSchema(
    this.kind, {
    this.nullable = false,
    this.minimum,
    this.maximum,
    this.exclusiveMinimum,
    this.exclusiveMaximum,
    this.minLength,
    this.maxLength,
    this.pattern,
    this.minItems,
    this.maxItems,
    this.properties,
    this.additionalProperties = true,
    this.items,
    this.values,
    this.allowed,
  });

  final _AsyncApiSchemaKind kind;
  final bool nullable;
  final num? minimum;
  final num? maximum;
  final num? exclusiveMinimum;
  final num? exclusiveMaximum;
  final int? minLength;
  final int? maxLength;
  final String? pattern;
  final int? minItems;
  final int? maxItems;
  final Map<String, _AsyncApiField>? properties;
  final bool additionalProperties;
  final _AsyncApiSchema? items;
  final _AsyncApiSchema? values;
  final Set<String>? allowed;
}

abstract final class _AsyncApiStrictJson {
  static Object? decode(Uint8List bytes) => jsonDecode(utf8.decode(bytes));

  static void validate(Object? value, _AsyncApiSchema schema, [String path = r'$']) {
    if (value == null) {
      if (!schema.nullable) throw FormatException('null is not allowed at $path');
      return;
    }
    switch (schema.kind) {
      case _AsyncApiSchemaKind.object:
        if (value is! Map) throw FormatException('expected object at $path');
        final object = Map<String, Object?>.from(value);
        final properties = schema.properties!;
        if (!schema.additionalProperties) {
          final unknown = object.keys.where((key) => !properties.containsKey(key)).firstOrNull;
          if (unknown != null) throw FormatException('unknown property at $path.$unknown');
        }
        for (final MapEntry(key: name, value: field) in properties.entries) {
          if (!object.containsKey(name)) {
            if (field.required) throw FormatException('required property is missing at $path.$name');
            continue;
          }
          validate(object[name], field.schema, '$path.$name');
        }
        return;
      case _AsyncApiSchemaKind.array:
        if (value is! List) throw FormatException('expected array at $path');
        final minimumItems = schema.minItems;
        final maximumItems = schema.maxItems;
        if (minimumItems != null && value.length < minimumItems) throw FormatException('array is shorter than minItems at $path');
        if (maximumItems != null && value.length > maximumItems) throw FormatException('array is longer than maxItems at $path');
        for (var index = 0; index < value.length; index++) { validate(value[index], schema.items!, '$path[$index]'); }
        return;
      case _AsyncApiSchemaKind.map:
        if (value is! Map) throw FormatException('expected object at $path');
        for (final entry in value.entries) { validate(entry.value, schema.values!, '$path.\${entry.key}'); }
        return;
      case _AsyncApiSchemaKind.string:
        if (value is! String) throw FormatException('expected string at $path');
        final length = value.runes.length;
        final minimumLength = schema.minLength;
        final maximumLength = schema.maxLength;
        final pattern = schema.pattern;
        final allowed = schema.allowed;
        if (minimumLength != null && length < minimumLength) throw FormatException('string is shorter than minLength at $path');
        if (maximumLength != null && length > maximumLength) throw FormatException('string is longer than maxLength at $path');
        if (pattern != null && !RegExp(pattern).hasMatch(value)) throw FormatException('string does not match pattern at $path');
        if (allowed != null && !allowed.contains(value)) throw FormatException('unknown enum or const value at $path');
        return;
      case _AsyncApiSchemaKind.integer:
        if (value is! int) throw FormatException('expected integer at $path');
        _validateNumber(value, schema, path);
        return;
      case _AsyncApiSchemaKind.number:
        if (value is! num) throw FormatException('expected number at $path');
        _validateNumber(value, schema, path);
        return;
      case _AsyncApiSchemaKind.boolean:
        if (value is! bool) throw FormatException('expected boolean at $path');
        return;
    }
  }

  static void _validateNumber(num value, _AsyncApiSchema schema, String path) {
    final minimum = schema.minimum;
    final maximum = schema.maximum;
    final exclusiveMinimum = schema.exclusiveMinimum;
    final exclusiveMaximum = schema.exclusiveMaximum;
    if (minimum != null && value < minimum) throw FormatException('number is below minimum at $path');
    if (maximum != null && value > maximum) throw FormatException('number is above maximum at $path');
    if (exclusiveMinimum != null && value <= exclusiveMinimum) throw FormatException('number is below exclusiveMinimum at $path');
    if (exclusiveMaximum != null && value >= exclusiveMaximum) throw FormatException('number is above exclusiveMaximum at $path');
  }
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}`;
}

function emitMessageCodec(message) {
  const messageType = dartTypeName(message.typeName);
  return `final class ${messageType}Codec {
  const ${messageType}Codec();
  static final _schema = ${schemaExpression(message.schema)};

  ${messageType} decode(Uint8List bytes) {
    final value = _AsyncApiStrictJson.decode(bytes);
    _AsyncApiStrictJson.validate(value, _schema);
    return ${messageType}.fromJson(Map<String, Object?>.from(value! as Map));
  }

  Uint8List encode(${messageType} message) {
    final value = message.toJson();
    _AsyncApiStrictJson.validate(value, _schema);
    return Uint8List.fromList(utf8.encode(jsonEncode(value)));
  }
}`;
}

function unionCaseName(union, item) {
  return dartTypeName(`${union.name}${item.message.typeName}`);
}

function emitUnion(union, operationContainer) {
  const unionType = dartTypeName(union.name);
  return `sealed class ${unionType} {
  const ${unionType}();
  AsyncApiOperation get operation;
}

${union.cases.map(item => `final class ${unionCaseName(union, item)} extends ${unionType} {
  const ${unionCaseName(union, item)}(this.value);
  final ${dartTypeName(item.message.typeName)} value;
  @override
  AsyncApiOperation get operation => ${operationContainer}.${dartIdentifier(item.operation.id)};
}`).join("\n\n")}`;
}

function emitUnionCodec(union, { decode: includeDecode, encode: includeEncode }) {
  const unionType = dartTypeName(union.name);
  const decodeBody = union.cases.length === 1
    ? `return ${unionCaseName(union, union.cases[0])}(const ${dartTypeName(union.cases[0].message.typeName)}Codec().decode(bytes));`
    : `final value = _AsyncApiStrictJson.decode(bytes);
    if (value is! Map || value[${quoted(union.discriminator)}] is! String) {
      throw const FormatException(${quoted(`message discriminator ${union.discriminator} is missing`)});
    }
    switch (value[${quoted(union.discriminator)}]) {
${union.cases.map(item => `      case ${quoted(item.discriminatorValue)}: return ${unionCaseName(union, item)}(const ${dartTypeName(item.message.typeName)}Codec().decode(bytes));`).join("\n")}
      default: throw const FormatException('unknown message discriminator');
    }`;
  const decodeMethod = includeDecode ? `  static ${unionType} decode(Uint8List bytes) {
    ${decodeBody}
  }` : "";

  const encodeMethod = includeEncode ? `  static Uint8List encode(${unionType} message) => switch (message) {
${union.cases.map(item => `        ${unionCaseName(union, item)}(:final value) => const ${dartTypeName(item.message.typeName)}Codec().encode(value),`).join("\n")}
      };` : "";
  return `abstract final class _${unionType}Codec {
${decodeMethod}
${includeDecode && includeEncode ? "\n" : ""}
${encodeMethod}
}`;
}

function emitChannel(channel) {
  const channelType = dartTypeName(channel.typeName);
  const incomingType = dartTypeName(channel.incoming.name);
  const outgoingType = dartTypeName(channel.outgoing.name);
  const operationContainer = `${channelType}Operations`;
  return `abstract final class ${operationContainer} {
${channel.operations.map(operation => `  static const ${dartIdentifier(operation.id)} = AsyncApiOperation(${quoted(operation.id)}, AsyncApiAction.${operation.action}, <String>[${operation.messages.map(message => quoted(message.typeName)).join(", ")}]);`).join("\n")}
}

${emitUnion(channel.incoming, operationContainer)}

${emitUnion(channel.outgoing, operationContainer)}

${emitUnionCodec(channel.incoming, { decode: false, encode: true })}

${emitUnionCodec(channel.outgoing, { decode: true, encode: false })}

final class ${channelType}ClientSession {
  const ${channelType}ClientSession(this._connection);
  final AsyncApiSocketConnection _connection;

  Stream<${outgoingType}> get incoming => _connection.messages.map(_${outgoingType}Codec.decode);

  Future<AsyncApiPeerClose> get closed => _connection.closed;

  Future<void> send(${incomingType} message) => _connection.send(_${incomingType}Codec.encode(message));

  Future<void> close(AsyncApiWebSocketCloseSignal signal) => _connection.close(signal);
}`;
}

function emitPublicRuntime(ir) {
  return `enum AsyncApiAction { send, receive }

final class AsyncApiOperation {
  const AsyncApiOperation(this.id, this.action, this.messageNames);
  final String id;
  final AsyncApiAction action;
  final List<String> messageNames;
}

final class AsyncApiChannel {
  const AsyncApiChannel(this.name, this.address, this.parameterNames);
  final String name;
  final String address;
  final List<String> parameterNames;
}

final class AsyncApiWebSocketCloseSignal {
  const AsyncApiWebSocketCloseSignal(this.code, this.reason);
  final int code;
  final String reason;
}

final class AsyncApiPeerClose {
  const AsyncApiPeerClose(this.code, this.reason);
  final int code;
  final String reason;
}

abstract interface class AsyncApiSocketConnection {
  Stream<Uint8List> get messages;
  Future<AsyncApiPeerClose> get closed;
  Future<void> send(Uint8List payload);
  Future<void> close(AsyncApiWebSocketCloseSignal signal);
}

abstract interface class AsyncApiSocketAdapter {
  Future<AsyncApiSocketConnection> connect(
    AsyncApiChannel channel,
    Map<String, String> parameters,
  );
}

abstract final class ${dartTypeName(ir.moduleName)}Channels {
${ir.channels.map(channel => `  static const ${dartIdentifier(channel.name)} = AsyncApiChannel(${quoted(channel.id)}, ${quoted(channel.address)}, <String>[${channel.parameterNames.map(quoted).join(", ")}]);`).join("\n")}
}`;
}

function emitClient(ir) {
  const moduleType = dartTypeName(ir.moduleName);
  return `final class ${moduleType}Client {
  const ${moduleType}Client(this.adapter);
  final AsyncApiSocketAdapter adapter;

${ir.channels.map(channel => `  Future<${dartTypeName(channel.typeName)}ClientSession> connect${dartTypeName(channel.typeName)}(${channel.parameterNames.length ? `{${channel.parameterNames.map(name => `required String ${dartIdentifier(name)}`).join(", ")}}` : ""}) async {
    final connection = await adapter.connect(
      ${moduleType}Channels.${dartIdentifier(channel.name)},
      <String, String>{${channel.parameterNames.map(name => `${quoted(name)}: ${dartIdentifier(name)}`).join(", ")}},
    );
    return ${dartTypeName(channel.typeName)}ClientSession(connection);
  }`).join("\n\n")}
}`;
}

function emitCloseSignals(ir) {
  if (!ir.closeSignals.length) return undefined;
  return `abstract final class ${dartTypeName(ir.moduleName)}WebSocketCloseSignals {
${ir.closeSignals.map(signal => `  static const ${dartIdentifier(signal.name)} = AsyncApiWebSocketCloseSignal(${signal.code}, ${quoted(signal.reason)});`).join("\n")}
}`;
}

export function emitDart(ir) {
  const schemas = ir.schemas.map(schema => schema.kind === "enum" ? emitEnum(schema) : emitObject(schema));
  return `${joinLines([
    "// Generated by @soenan/asyncapi-generator. Do not edit.",
    `// Source: ${ir.title} ${ir.version}`,
    "// ignore_for_file: unused_element_parameter",
    "",
    "import 'dart:async';",
    "import 'dart:convert';",
    "import 'dart:typed_data';",
    "",
    emitPublicRuntime(ir),
    "",
    emitStrictRuntime(),
    "",
    ...schemas.flatMap((value, index) => index ? ["", value] : [value]),
    "",
    ...ir.messages.map(emitMessageCodec).flatMap((value, index) => index ? ["", value] : [value]),
    "",
    ...ir.channels.flatMap((channel, index) => index ? ["", emitChannel(channel)] : [emitChannel(channel)]),
    "",
    emitClient(ir),
    "",
    emitCloseSignals(ir)
  ])}\n`;
}
