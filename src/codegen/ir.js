import { GeneratorDiagnostic, UnsupportedAsyncAPIFeaturesError } from "./diagnostics.js";
import { camelCase, dartIdentifier, dartTypeName, pascalCase, swiftIdentifier, swiftTypeName } from "./names.js";
import { normalizeSafePattern, UnsafePatternError } from "./pattern-policy.js";

const CLOSE_SIGNAL_EXTENSION = "x-websocket-close-signals";
const COMPOSITION_ACCESSORS = ["allOf", "anyOf", "oneOf", "not", "if", "then", "else"];
const UNSUPPORTED_VALIDATION_KEYWORDS = [
  "contains", "contentEncoding", "contentMediaType", "contentSchema",
  "dependencies", "dependentRequired", "dependentSchemas", "maxContains",
  "maxProperties", "minContains", "minProperties", "multipleOf", "prefixItems",
  "unevaluatedItems", "unevaluatedProperties", "uniqueItems"
];

function sortedModels(collection) {
  if (!collection || typeof collection.all !== "function") return [];
  return [...collection.all()].sort((left, right) => left.id().localeCompare(right.id()));
}

function sortedEntries(value) {
  return Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right));
}

function fingerprint(value) {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${sortedEntries(value).map(([key, item]) => `${JSON.stringify(key)}:${fingerprint(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function modelPath(model, fallback) {
  return typeof model?.jsonPath === "function" ? model.jsonPath() : fallback;
}

function normalizeNullableType(rawType) {
  if (!Array.isArray(rawType)) return { type: rawType, nullable: false };
  const concrete = rawType.filter(value => value !== "null");
  if (concrete.length === 1 && concrete.length !== rawType.length) {
    return { type: concrete[0], nullable: true };
  }
  return { type: undefined, nullable: false };
}

function isValidCloseCode(code) {
  if (!Number.isInteger(code) || code < 0 || code > 65_535) return false;
  return [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].includes(code)
    || (code >= 3000 && code <= 4999);
}

const DART_EXACT_INTEGER_LIMIT = 9_007_199_254_740_991;
const INT32_MINIMUM = -2_147_483_648;
const INT32_MAXIMUM = 2_147_483_647;

class IRBuilder {
  constructor(asyncapi, moduleName) {
    if (!asyncapi || typeof asyncapi.channels !== "function" || typeof asyncapi.operations !== "function") {
      throw new TypeError("The generator requires an official AsyncAPI Parser v3 document.");
    }
    this.asyncapi = asyncapi;
    this.rawDocument = asyncapi.json();
    this.moduleName = pascalCase(moduleName);
    this.diagnostics = [];
    this.namedSchemas = new Map();
    this.messages = new Map();
    this.patterns = new Set();
  }

  diagnostic(code, path, message) {
    this.diagnostics.push(new GeneratorDiagnostic(code, path, message));
  }

  build() {
    if (this.asyncapi.version() !== "3.1.0") {
      this.diagnostic("asyncapi.version", "$.asyncapi", `expected 3.1.0, received ${JSON.stringify(this.asyncapi.version())}`);
    }

    this.validateServers();
    const channels = sortedModels(this.asyncapi.channels()).map(channel => this.buildChannel(channel));
    this.assertUniqueNames(channels.filter(Boolean), "channel", "$.channels");
    const closeSignals = this.buildCloseSignals();
    this.assertLanguageTypeNames(
      [...this.namedSchemas.values()].map(value => ({ id: value.path, value: value.schema.name })),
      "$.schemas"
    );
    if (this.diagnostics.length > 0) throw new UnsupportedAsyncAPIFeaturesError(this.diagnostics);

    return {
      title: this.asyncapi.info().title(),
      version: this.asyncapi.info().version(),
      moduleName: this.moduleName,
      channels: channels.filter(Boolean),
      messages: [...this.messages.values()].map(value => value.message).sort((left, right) => left.typeName.localeCompare(right.typeName)),
      schemas: [...this.namedSchemas.values()].map(value => value.schema).sort((left, right) => left.name.localeCompare(right.name)),
      patterns: [...this.patterns].sort(),
      closeSignals
    };
  }

  validateServers() {
    for (const serverModel of sortedModels(this.asyncapi.servers())) {
      const id = serverModel.id();
      const path = modelPath(serverModel, `$.servers.${id}`);
      const protocol = serverModel.protocol();
      if (protocol !== "ws" && protocol !== "wss") {
        this.diagnostic(
          "server.protocol.unsupported",
          `${path}/protocol`,
          `generated transports require ws or wss, received ${JSON.stringify(protocol)}`
        );
      }
      this.rejectBindings(serverModel, "server", path);
      if (serverModel.security().length > 0) {
        this.diagnostic("server.security.unsupported", `${path}/security`, "server security requirements are not generated yet");
      }
    }
  }

  rejectBindings(model, kind, path) {
    const bindings = model.bindings();
    if (bindings && !bindings.isEmpty()) {
      this.diagnostic(`${kind}.bindings.unsupported`, `${path}/bindings`, `${kind} bindings are not generated yet`);
    }
  }

  buildChannel(channelModel) {
    const id = channelModel.id();
    const path = modelPath(channelModel, `$.channels.${id}`);
    const address = channelModel.address();
    this.rejectBindings(channelModel, "channel", path);
    if (typeof address !== "string" || !address.startsWith("/")) {
      this.diagnostic("channel.address", `${path}/address`, "a channel address beginning with / is required");
      return undefined;
    }
    const addressSegments = address.split("/").slice(1);
    if (address !== "/" && addressSegments.some(segment => {
      if (segment.length === 0 || segment === "." || segment === "..") return true;
      if (/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(segment)) return false;
      return !/^[A-Za-z0-9._~-]+$/.test(segment);
    })) {
      this.diagnostic(
        "channel.address",
        `${path}/address`,
        "channel addresses require ASCII URI-unreserved literal segments or whole-segment {parameterName} placeholders; . and .. are forbidden"
      );
    }
    const addressParameters = [...address.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
    const parameterModels = sortedModels(channelModel.parameters());
    const declaredParameters = parameterModels.map(parameter => parameter.id());
    for (const parameterModel of parameterModels) this.validateChannelParameter(parameterModel, path);
    if (new Set(addressParameters).size !== addressParameters.length
      || new Set(addressParameters).size !== new Set(declaredParameters).size
      || addressParameters.some(name => !declaredParameters.includes(name))) {
      this.diagnostic("channel.parameters", `${path}/parameters`, "declared parameters must exactly match unique address placeholders");
    }

    const operations = sortedModels(channelModel.operations())
      .map(operation => this.buildOperation(operation, path))
      .filter(Boolean);
    if (operations.length === 0) {
      this.diagnostic("channel.operations", path, "at least one operation is required");
    }
    this.assertUniqueNames(operations, "operation", `${path}/operations`);

    const incomingOperations = operations.filter(operation => operation.action === "receive");
    const outgoingOperations = operations.filter(operation => operation.action === "send");
    if (incomingOperations.length === 0 || outgoingOperations.length === 0) {
      this.diagnostic("channel.duplex.required", path, "generated sessions require at least one send and one receive operation");
    }
    const incoming = this.buildDirectionUnion(id, "ClientMessage", incomingOperations, `${path}/operations`);
    const outgoing = this.buildDirectionUnion(id, "ServerMessage", outgoingOperations, `${path}/operations`);

    return {
      id,
      name: camelCase(id),
      typeName: pascalCase(id),
      address,
      parameterNames: addressParameters,
      operations,
      incoming,
      outgoing
    };
  }

  validateChannelParameter(parameterModel, channelPath) {
    const id = parameterModel.id();
    const path = modelPath(parameterModel, `${channelPath}/parameters/${id}`);
    const schema = parameterModel.schema();
    if (schema?.enum() !== undefined) {
      this.diagnostic("channel.parameter.enum.unsupported", `${path}/enum`, "parameter enum validation is not generated yet");
    }
    if (schema?.default() !== undefined) {
      this.diagnostic("channel.parameter.default.unsupported", `${path}/default`, "parameter defaults are not generated yet");
    }
    if (schema?.examples() !== undefined) {
      this.diagnostic("channel.parameter.examples.unsupported", `${path}/examples`, "parameter examples are not generated yet");
    }
    if (parameterModel.hasLocation()) {
      this.diagnostic("channel.parameter.location.unsupported", `${path}/location`, "parameter runtime locations are not generated yet");
    }
  }

  buildOperation(operationModel, channelPath) {
    const id = operationModel.id();
    const path = modelPath(operationModel, `${channelPath}/operations/${id}`);
    this.rejectBindings(operationModel, "operation", path);
    if (operationModel.security().length > 0) {
      this.diagnostic("operation.security.unsupported", `${path}/security`, "operation security requirements are not generated yet");
    }
    if (!operationModel.traits().isEmpty()) {
      this.diagnostic("operation.traits.unsupported", `${path}/traits`, "operation traits are not generated yet");
    }
    if (operationModel.reply()) {
      this.diagnostic("operation.reply.unsupported", `${path}/reply`, "request/reply operations are not generated yet");
    }
    const action = operationModel.action();
    if (action !== "send" && action !== "receive") {
      this.diagnostic("operation.action", `${path}/action`, `expected send or receive, received ${JSON.stringify(action)}`);
      return undefined;
    }
    const messageModels = sortedModels(operationModel.messages());
    if (messageModels.length === 0) {
      this.diagnostic("operation.messages", `${path}/messages`, "at least one message is required");
      return undefined;
    }
    const messages = messageModels.map(message => this.buildMessage(message)).filter(Boolean);
    return { id, name: camelCase(id), typeName: pascalCase(id), action, messages };
  }

  buildMessage(messageModel) {
    const id = messageModel.id();
    const path = modelPath(messageModel, `$.messages.${id}`);
    this.rejectBindings(messageModel, "message", path);
    if (messageModel.hasCorrelationId()) {
      this.diagnostic("message.correlation-id.unsupported", `${path}/correlationId`, "message correlation IDs are not generated yet");
    }
    if (!messageModel.traits().isEmpty()) {
      this.diagnostic("message.traits.unsupported", `${path}/traits`, "message traits are not generated yet");
    }
    if (messageModel.hasHeaders()) {
      this.diagnostic("message.headers.unsupported", `${path}/headers`, "typed application headers are not generated yet");
    }
    const contentType = messageModel.contentType() ?? this.asyncapi.defaultContentType() ?? "application/json";
    if (!(contentType === "application/json" || contentType.endsWith("+json"))) {
      this.diagnostic("message.content-type", `${path}/contentType`, `JSON is required, received ${JSON.stringify(contentType)}`);
    }
    const schemaFormat = messageModel.schemaFormat();
    if (schemaFormat && !(schemaFormat.startsWith("application/vnd.aai.asyncapi") || schemaFormat.startsWith("application/schema+json"))) {
      this.diagnostic("message.schema-format", `${path}/payload/schemaFormat`, `JSON Schema is required, received ${JSON.stringify(schemaFormat)}`);
    }
    const payload = messageModel.payload();
    if (!payload) {
      this.diagnostic("message.payload", `${path}/payload`, "an object JSON payload schema is required");
      return undefined;
    }
    const typeName = pascalCase(messageModel.name() ?? id);
    const schema = this.buildSchema(payload, typeName, true, new Set());
    if (!schema) return undefined;

    const schemaIdentity = fingerprint(payload.json());
    const existing = this.messages.get(typeName);
    if (existing && existing.fingerprint !== schemaIdentity) {
      this.diagnostic("message.name.collision", path, `message name ${typeName} maps to more than one payload schema`);
      return existing.message;
    }
    const message = existing?.message ?? {
      id,
      name: camelCase(messageModel.name() ?? id),
      typeName,
      contentType,
      schema
    };
    this.messages.set(typeName, { fingerprint: schemaIdentity, message });
    return message;
  }

  buildDirectionUnion(channelId, suffix, operations, path) {
    const messageUses = new Map();
    for (const operation of operations) {
      for (const message of operation.messages) {
        const uses = messageUses.get(message.typeName) ?? { message, operations: [] };
        uses.operations.push(operation);
        messageUses.set(message.typeName, uses);
      }
    }
    for (const use of messageUses.values()) {
      if (use.operations.length > 1) {
        this.diagnostic(
          "message.operation.ambiguous",
          path,
          `${use.message.typeName} is referenced by multiple ${operations[0]?.action ?? "direction"} operations: ${use.operations.map(value => value.id).join(", ")}`
        );
      }
    }
    const uses = [...messageUses.values()].sort((left, right) => left.message.typeName.localeCompare(right.message.typeName));
    const discriminator = uses.length > 1 ? this.findDiscriminator(uses.map(use => use.message), path) : undefined;
    const cases = uses.map(use => ({
      name: use.message.name,
      message: use.message,
      operation: use.operations[0],
      discriminatorValue: discriminator?.values.get(use.message.typeName)
    }));
    this.assertUniqueNames(cases, "message case", path);
    this.assertLanguageIdentifierNames(cases.map(value => ({ id: value.message.id, value: value.name })), "union-case", path);
    return {
      name: `${pascalCase(channelId)}${suffix}`,
      discriminator: discriminator?.wireName,
      cases
    };
  }

  findDiscriminator(messages, path) {
    const candidatesByMessage = messages.map(message => {
      const candidates = new Map();
      for (const property of message.schema.properties) {
        if (property.required && property.schema.kind === "enum" && property.schema.values.length === 1) {
          candidates.set(property.wireName, property.schema.values[0]);
        }
      }
      return candidates;
    });
    const common = [...candidatesByMessage[0].keys()]
      .filter(name => candidatesByMessage.every(candidates => candidates.has(name)))
      .filter(name => new Set(candidatesByMessage.map(candidates => candidates.get(name))).size === messages.length)
      .sort((left, right) => (left === "type" ? -1 : right === "type" ? 1 : left.localeCompare(right)));
    if (common.length === 0) {
      this.diagnostic("message.discriminator", path, "multiple messages require a common required const string discriminator with unique values");
      return undefined;
    }
    const wireName = common[0];
    return {
      wireName,
      values: new Map(messages.map((message, index) => [message.typeName, candidatesByMessage[index].get(wireName)]))
    };
  }

  buildSchema(schemaModel, proposedName, requireObject, ancestors) {
    const path = modelPath(schemaModel, proposedName);
    const rawSchema = schemaModel.json() ?? {};
    if (schemaModel.isCircular()) {
      this.diagnostic("schema.recursion.unsupported", path, "recursive schemas are not generated yet");
      return undefined;
    }
    if (ancestors.has(schemaModel)) {
      this.diagnostic("schema.recursion.unsupported", path, "recursive schemas are not generated yet");
      return undefined;
    }
    for (const accessor of COMPOSITION_ACCESSORS) {
      if (schemaModel[accessor]()) {
        this.diagnostic("schema.composition.unsupported", `${path}/${accessor}`, `${accessor} is not generated yet`);
      }
    }
    for (const keyword of UNSUPPORTED_VALIDATION_KEYWORDS) {
      if (Object.hasOwn(rawSchema, keyword)) {
        this.diagnostic("schema.validation-keyword.unsupported", `${path}/${keyword}`, `${keyword} validation is not generated yet`);
      }
    }
    if (schemaModel.patternProperties() || schemaModel.propertyNames()) {
      this.diagnostic("schema.dynamic-keys.unsupported", path, "patternProperties and propertyNames are not generated yet");
    }

    const { type, nullable } = normalizeNullableType(schemaModel.type());
    if (type === undefined && Array.isArray(schemaModel.type())) {
      this.diagnostic("schema.type.union", `${path}/type`, "only one concrete type plus null is supported");
      return undefined;
    }
    const constant = schemaModel.const();
    const enumeration = schemaModel.enum();
    const inferredScalarType = Object.hasOwn(rawSchema, "const") && constant !== null
      ? typeof constant
      : enumeration?.length > 0 && enumeration.every(value => typeof value === "string")
        ? "string"
        : undefined;
    const effectiveType = type ?? (schemaModel.properties() ? "object" : inferredScalarType);
    if (requireObject && effectiveType !== "object") {
      this.diagnostic("message.payload.object", path, `message payload must be an object, received ${JSON.stringify(effectiveType)}`);
      return undefined;
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(schemaModel);
    const constraints = this.constraints(schemaModel, nullable, effectiveType, path);

    if (effectiveType === "object") {
      const properties = sortedEntries(schemaModel.properties());
      const additionalProperties = schemaModel.additionalProperties();
      if (properties.length > 0 && additionalProperties && typeof additionalProperties === "object") {
        this.diagnostic(
          "schema.additional-properties.unsupported",
          `${path}/additionalProperties`,
          "an additionalProperties schema cannot be combined with fixed properties yet"
        );
      } else if (properties.length > 0 && rawSchema.additionalProperties !== false) {
        this.diagnostic(
          "schema.additional-properties.open-unsupported",
          `${path}/additionalProperties`,
          "fixed-property objects must set additionalProperties to false so generated codecs do not discard unknown values"
        );
      }
      if (properties.length === 0 && additionalProperties && typeof additionalProperties === "object") {
        const values = this.buildSchema(additionalProperties, `${proposedName}Value`, false, nextAncestors);
        return values ? { kind: "map", values, ...constraints } : undefined;
      }
      if (properties.length === 0 && additionalProperties === true) {
        this.diagnostic("schema.free-form.unsupported", `${path}/additionalProperties`, "free-form JSON objects require an explicit value schema");
      }
      const required = new Set(schemaModel.required() ?? []);
      const seen = new Map();
      const builtProperties = [];
      for (const [wireName, propertyModel] of properties) {
        const propertyName = camelCase(wireName);
        if (seen.has(propertyName)) {
          this.diagnostic("schema.property.collision", modelPath(propertyModel, `${path}/properties/${wireName}`), `${wireName} and ${seen.get(propertyName)} map to ${propertyName}`);
          continue;
        }
        seen.set(propertyName, wireName);
        const child = this.buildSchema(propertyModel, `${proposedName}${pascalCase(wireName)}`, false, nextAncestors);
        if (child) builtProperties.push({ wireName, name: propertyName, required: required.has(wireName), schema: child });
      }
      const object = {
        kind: "object",
        name: pascalCase(proposedName),
        properties: builtProperties,
        additionalProperties: schemaModel.json("additionalProperties") !== false,
        description: schemaModel.description(),
        ...constraints
      };
      this.registerNamedSchema(object, schemaModel, path);
      return object;
    }
    if (effectiveType === "array") {
      const itemsModel = schemaModel.items();
      if (Array.isArray(itemsModel)) {
        this.diagnostic("schema.tuple.unsupported", `${path}/items`, "tuple arrays are not generated yet");
        return undefined;
      }
      if (!itemsModel) {
        this.diagnostic("schema.array.items", `${path}/items`, "array items are required");
        return undefined;
      }
      const items = this.buildSchema(itemsModel, `${proposedName}Item`, false, nextAncestors);
      return items ? { kind: "array", items, ...constraints } : undefined;
    }
    if (effectiveType === "string") {
      const enumValues = schemaModel.enum() ?? (Object.hasOwn(rawSchema, "const") ? [schemaModel.const()] : undefined);
      if (enumValues) {
        if (enumValues.length === 0 || enumValues.some(value => typeof value !== "string")) {
          this.diagnostic("schema.enum.unsupported", `${path}/enum`, "only non-empty string enums are supported");
          return undefined;
        }
        this.assertLanguageIdentifierNames(
          enumValues.map(value => ({ id: value, value })),
          "schema-enum-case",
          `${path}/enum`
        );
        const enumeration = { kind: "enum", name: pascalCase(proposedName), values: [...enumValues], description: schemaModel.description(), ...constraints };
        this.registerNamedSchema(enumeration, schemaModel, path);
        return enumeration;
      }
      return { kind: "string", format: schemaModel.format(), ...constraints };
    }
    if (effectiveType === "integer") return { kind: "integer", format: schemaModel.format(), ...constraints };
    if (effectiveType === "number") return { kind: "number", format: schemaModel.format(), ...constraints };
    if (effectiveType === "boolean") return { kind: "boolean", ...constraints };
    this.diagnostic("schema.type.unsupported", `${path}/type`, `unsupported or missing type ${JSON.stringify(effectiveType)}`);
    return undefined;
  }

  constraints(schema, nullable, effectiveType, path) {
    const format = schema.format();
    let minimum = schema.minimum();
    let maximum = schema.maximum();
    if (format !== undefined) {
      if (effectiveType !== "integer" || (format !== "int32" && format !== "int64")) {
        this.diagnostic("schema.format.unsupported", `${path}/format`, `${JSON.stringify(format)} format validation is not generated yet`);
      } else if (format === "int32") {
        if ((minimum !== undefined && minimum < INT32_MINIMUM) || (maximum !== undefined && maximum > INT32_MAXIMUM)) {
          this.diagnostic("schema.integer.int32-range", `${path}/format`, "int32 bounds must stay within the signed 32-bit range");
        }
        minimum = Math.max(minimum ?? INT32_MINIMUM, INT32_MINIMUM);
        maximum = Math.min(maximum ?? INT32_MAXIMUM, INT32_MAXIMUM);
      }
    }
    if (effectiveType === "integer" && format !== "int32") {
      const lowerBound = minimum ?? schema.exclusiveMinimum();
      const upperBound = maximum ?? schema.exclusiveMaximum();
      if (lowerBound === undefined || upperBound === undefined
        || lowerBound < -DART_EXACT_INTEGER_LIMIT || upperBound > DART_EXACT_INTEGER_LIMIT) {
        this.diagnostic(
          format === "int64" ? "schema.integer.int64-range" : "schema.integer.safe-range",
          format === "int64" ? `${path}/format` : path,
          `integer schemas require explicit bounds within Dart Web's exact JSON range (-${DART_EXACT_INTEGER_LIMIT}...${DART_EXACT_INTEGER_LIMIT})`
        );
      }
    }
    let pattern;
    if (schema.pattern() !== undefined) {
      try {
        pattern = normalizeSafePattern(schema.pattern());
        this.patterns.add(pattern);
      } catch (error) {
        if (!(error instanceof UnsafePatternError)) throw error;
        this.diagnostic("schema.pattern.unsafe", path + "/pattern", error.message);
      }
    }
    return {
      nullable,
      minimum,
      maximum,
      exclusiveMinimum: schema.exclusiveMinimum(),
      exclusiveMaximum: schema.exclusiveMaximum(),
      minLength: schema.minLength(),
      maxLength: schema.maxLength(),
      pattern,
      minItems: schema.minItems(),
      maxItems: schema.maxItems()
    };
  }

  registerNamedSchema(schema, model, path) {
    const valueFingerprint = fingerprint(model.json());
    const existing = this.namedSchemas.get(schema.name);
    if (existing && existing.fingerprint !== valueFingerprint) {
      this.diagnostic("schema.name.collision", path, `more than one schema maps to ${schema.name}`);
      return;
    }
    this.namedSchemas.set(schema.name, { fingerprint: valueFingerprint, schema, path });
  }

  buildCloseSignals() {
    if (this.rawDocument.components?.[CLOSE_SIGNAL_EXTENSION] !== undefined) {
      this.diagnostic("close-signals.location", `$.components.${CLOSE_SIGNAL_EXTENSION}`, `move ${CLOSE_SIGNAL_EXTENSION} to the document root`);
    }
    const extension = this.rawDocument[CLOSE_SIGNAL_EXTENSION];
    if (extension === undefined) return [];
    if (!extension || typeof extension !== "object" || Array.isArray(extension)) {
      this.diagnostic("close-signals.shape", `$.${CLOSE_SIGNAL_EXTENSION}`, "expected a map of signal names to code and reason");
      return [];
    }
    const signals = [];
    for (const [name, signal] of sortedEntries(extension)) {
      const path = `$.${CLOSE_SIGNAL_EXTENSION}.${name}`;
      if (!signal || typeof signal !== "object" || Array.isArray(signal)) {
        this.diagnostic("close-signal.shape", path, "expected an object with code and reason");
        continue;
      }
      for (const key of Object.keys(signal).sort()) {
        if (key !== "code" && key !== "reason") {
          this.diagnostic("close-signal.property.unsupported", `${path}.${key}`, `unsupported close signal property ${JSON.stringify(key)}`);
        }
      }
      if (!isValidCloseCode(signal.code)) {
        this.diagnostic("close-signal.code", `${path}.code`, "expected a sendable RFC WebSocket close code (1000-1014 excluding reserved codes, or 3000-4999)");
      }
      if (typeof signal.reason !== "string") {
        this.diagnostic("close-signal.reason", `${path}.reason`, "expected a UTF-8 string");
      } else if (Buffer.byteLength(signal.reason, "utf8") > 123) {
        this.diagnostic("close-signal.reason-length", `${path}.reason`, `reason is ${Buffer.byteLength(signal.reason, "utf8")} UTF-8 bytes; maximum is 123`);
      }
      signals.push({ rawName: name, name: camelCase(name), code: signal.code, reason: signal.reason });
    }
    this.assertLanguageIdentifierNames(
      signals.map(signal => ({ id: signal.rawName, value: signal.name })),
      "close-signal",
      `$.${CLOSE_SIGNAL_EXTENSION}`
    );
    return signals.map(({ rawName: _, ...signal }) => signal);
  }

  assertUniqueNames(values, kind, path) {
    const names = new Map();
    for (const value of values) {
      if (names.has(value.name)) {
        this.diagnostic(`${kind.replaceAll(" ", "-")}.name.collision`, path, `${value.id ?? value.name} and ${names.get(value.name)} map to ${value.name}`);
      }
      names.set(value.name, value.id ?? value.name);
    }
  }

  assertLanguageIdentifierNames(values, kind, path) {
    for (const [language, identifier] of [["swift", swiftIdentifier], ["dart", dartIdentifier]]) {
      const seen = new Map();
      for (const value of values) {
        const generated = identifier(value.value);
        if (seen.has(generated)) {
          this.diagnostic(
            `${kind}.${language}.identifier-collision`,
            path,
            `${JSON.stringify(value.id)} and ${JSON.stringify(seen.get(generated))} both map to ${generated}`
          );
        }
        seen.set(generated, value.id);
      }
    }
  }

  assertLanguageTypeNames(values, path) {
    for (const [language, identifier] of [["swift", swiftTypeName], ["dart", dartTypeName]]) {
      const seen = new Map();
      for (const value of values) {
        const generated = identifier(value.value);
        if (seen.has(generated) && seen.get(generated) !== value.id) {
          this.diagnostic(
            `schema-type.${language}.identifier-collision`,
            path,
            `${JSON.stringify(value.id)} and ${JSON.stringify(seen.get(generated))} both declare ${generated}`
          );
        }
        seen.set(generated, value.id);
      }
    }
  }
}

export function buildIR(asyncapi, options) {
  if (!options?.moduleName || typeof options.moduleName !== "string") throw new TypeError("moduleName is required");
  return new IRBuilder(asyncapi, options.moduleName).build();
}
