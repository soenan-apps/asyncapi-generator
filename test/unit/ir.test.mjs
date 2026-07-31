import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { buildIR } from "../../src/codegen/ir.js";
import { duplexDocument, parseFile, parseObject } from "../support/parse.mjs";

const realtimeChatFixture = resolve("test/fixtures/realtime-chat/asyncapi.yaml");

async function diagnosticsFor(document) {
  const parsed = await parseObject(document);
  try {
    buildIR(parsed, { moduleName: "DiagnosticAPI" });
    return [];
  } catch (error) {
    return error.diagnostics ?? [];
  }
}

test("official parser models resolve operation to channel to external message payload refs", async () => {
  const ir = buildIR(await parseFile(realtimeChatFixture), { moduleName: "RealtimeChatAPI" });
  assert.equal(ir.channels.length, 1);
  assert.deepEqual(ir.channels[0].parameterNames, ["roomId"]);
  assert.deepEqual(ir.channels[0].incoming.cases.map(value => value.message.id), ["postMessage", "setTyping"]);
  assert.deepEqual(ir.channels[0].outgoing.cases.map(value => value.message.id), ["messagePosted", "messageRejected", "typingUpdated"]);
  assert.equal(ir.channels[0].incoming.discriminator, "type");
  assert.equal(ir.channels[0].outgoing.discriminator, "type");
  assert.deepEqual(ir.closeSignals.map(value => value.code), [4401, 4404]);
});

test("root close extension rejects component placement and invalid wire values", async () => {
  const misplaced = duplexDocument({
    extension: {
      components: {
        "x-websocket-close-signals": { expired: { code: 4401, reason: "expired" } }
      }
    }
  });
  assert.deepEqual((await diagnosticsFor(misplaced)).map(value => value.code), ["close-signals.location"]);

  const invalid = duplexDocument({
    extension: {
      "x-websocket-close-signals": {
        reserved: { code: 1005, reason: "x".repeat(124) }
      }
    }
  });
  assert.deepEqual((await diagnosticsFor(invalid)).map(value => value.code).sort(), ["close-signal.code", "close-signal.reason-length"]);

  const strict = duplexDocument({
    extension: {
      "x-websocket-close-signals": {
        "class": { code: 4400, reason: "first", retryable: true },
        "class_": { code: 4401, reason: "second" }
      }
    }
  });
  const strictCodes = (await diagnosticsFor(strict)).map(value => value.code);
  assert.ok(strictCodes.includes("close-signal.property.unsupported"));
  assert.ok(strictCodes.includes("close-signal.swift.identifier-collision"));
  assert.ok(strictCodes.includes("close-signal.dart.identifier-collision"));
});

test("declared servers are restricted to WebSocket without ignored bindings or security", async () => {
  const document = duplexDocument();
  document.servers = {
    realtime: {
      host: "example.com",
      protocol: "kafka",
      bindings: { ws: {} },
      security: [{ type: "http", scheme: "bearer" }]
    }
  };
  const codes = (await diagnosticsFor(document)).map(value => value.code);
  assert.ok(codes.includes("server.protocol.unsupported"));
  assert.ok(codes.includes("server.bindings.unsupported"));
  assert.ok(codes.includes("server.security.unsupported"));

  document.servers.realtime.protocol = "wss";
  delete document.servers.realtime.bindings;
  delete document.servers.realtime.security;
  assert.equal((await diagnosticsFor(document)).length, 0);
});

test("channel, operation, and message wire semantics fail instead of being discarded", async () => {
  const document = duplexDocument();
  document.channels.events.bindings = { ws: {} };
  document.operations.receiveEvent.bindings = { ws: {} };
  document.operations.receiveEvent.security = [{ type: "http", scheme: "bearer" }];
  document.operations.receiveEvent.traits = [{ bindings: { ws: {} } }];
  document.channels.events.messages.client.bindings = { ws: {} };
  document.channels.events.messages.client.correlationId = { location: "$message.payload#/requestId" };
  document.channels.events.messages.client.traits = [{ bindings: { ws: {} } }];
  const codes = (await diagnosticsFor(document)).map(value => value.code);
  for (const expected of [
    "channel.bindings.unsupported",
    "operation.bindings.unsupported",
    "operation.security.unsupported",
    "operation.traits.unsupported",
    "message.bindings.unsupported",
    "message.correlation-id.unsupported",
    "message.traits.unsupported"
  ]) {
    assert.ok(codes.includes(expected), `missing ${expected}: ${codes.join(", ")}`);
  }
});

test("channel parameters allow only unconstrained string path replacement", async () => {
  const document = duplexDocument();
  document.channels.events.address = "/events/{eventId}";
  document.channels.events.parameters = {
    eventId: {
      description: "A human-readable annotation is allowed.",
      enum: ["event-1"],
      default: "event-1",
      examples: ["event-1"],
      location: "$message.payload#/eventId"
    }
  };
  const codes = (await diagnosticsFor(document)).map(value => value.code);
  assert.deepEqual(codes.filter(value => value.startsWith("channel.parameter.")).sort(), [
    "channel.parameter.default.unsupported",
    "channel.parameter.enum.unsupported",
    "channel.parameter.examples.unsupported",
    "channel.parameter.location.unsupported"
  ]);

  document.channels.events.parameters.eventId = { description: "Annotation only." };
  assert.equal((await diagnosticsFor(document)).length, 0);
});

test("channel literal paths match the runtime URI-unreserved grammar", async () => {
  for (const address of [
    "/events/%65ncoded",
    "/events/日本語",
    "/events/key:value",
    "/events/back\\slash",
    "/events/.",
    "/events/.."
  ]) {
    const document = duplexDocument();
    document.channels.events.address = address;
    const codes = (await diagnosticsFor(document)).map(value => value.code);
    assert.ok(codes.includes("channel.address"), `${address} should be rejected: ${codes.join(", ")}`);
  }

  const valid = duplexDocument();
  valid.channels.events.address = "/events/realtime_v1.0~beta-2";
  assert.equal((await diagnosticsFor(valid)).length, 0);
});

test("unidirectional contracts fail with a stable diagnostic", async () => {
  const document = duplexDocument();
  delete document.operations.sendEvent;
  assert.ok((await diagnosticsFor(document)).some(value => value.code === "channel.duplex.required"));
});

test("enum cases that collide in generated languages fail before emission", async () => {
  const payload = {
    type: "object",
    additionalProperties: false,
    required: ["type", "mode"],
    properties: {
      type: { const: "client" },
      mode: { type: "string", enum: ["foo-bar", "foo_bar"] }
    }
  };
  const codes = (await diagnosticsFor(duplexDocument({ clientPayload: payload }))).map(value => value.code);
  assert.ok(codes.includes("schema-enum-case.swift.identifier-collision"));
  assert.ok(codes.includes("schema-enum-case.dart.identifier-collision"));
});

test("reserved type escaping cannot collide with another declared schema", async () => {
  const document = duplexDocument();
  delete document.channels.events.messages.client;
  document.channels.events.messages.error = {
    name: "Error",
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: { type: { const: "error" } }
    }
  };
  document.channels.events.messages.errorValue = {
    name: "ErrorValue",
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: { type: { const: "error_value" } }
    }
  };
  document.operations.receiveEvent.messages = [
    { $ref: "#/channels/events/messages/error" },
    { $ref: "#/channels/events/messages/errorValue" }
  ];
  const codes = (await diagnosticsFor(document)).map(value => value.code);
  assert.ok(codes.includes("schema-type.swift.identifier-collision"));
  assert.ok(codes.includes("schema-type.dart.identifier-collision"));
});

test("unsupported validation semantics fail instead of being dropped", async () => {
  const payload = {
    type: "object",
    properties: { type: { const: "client" } },
    required: ["type"],
    additionalProperties: { type: "string" },
    minProperties: 1
  };
  const codes = (await diagnosticsFor(duplexDocument({ clientPayload: payload }))).map(value => value.code);
  assert.ok(codes.includes("schema.additional-properties.unsupported"));
  assert.ok(codes.includes("schema.validation-keyword.unsupported"));

  const openPayload = structuredClone(payload);
  openPayload.additionalProperties = true;
  delete openPayload.minProperties;
  assert.ok((await diagnosticsFor(duplexDocument({ clientPayload: openPayload }))).some(value => value.code === "schema.additional-properties.open-unsupported"));
});

test("unsafe regular-expression shapes fail before source emission", async () => {
  const payload = {
    type: "object",
    additionalProperties: false,
    required: ["type", "value"],
    properties: {
      type: { const: "client" },
      value: { type: "string", pattern: "^(a+)+$" }
    }
  };
  const diagnostics = await diagnosticsFor(duplexDocument({ clientPayload: payload }));
  assert.deepEqual(
    diagnostics.filter(value => value.code === "schema.pattern.unsafe").map(value => value.path),
    ["/operations/receiveEvent/messages/0/payload/properties/value/pattern"]
  );
});

test("integer formats have explicit cross-language bounds", async () => {
  const int32Payload = {
    type: "object",
    additionalProperties: false,
    required: ["type", "value"],
    properties: { type: { const: "client" }, value: { type: "integer", format: "int32" } }
  };
  const int32IR = buildIR(await parseObject(duplexDocument({ clientPayload: int32Payload })), { moduleName: "IntegerAPI" });
  const value = int32IR.messages.find(message => message.typeName === "ClientEvent").schema.properties.find(property => property.wireName === "value").schema;
  assert.equal(value.minimum, -2147483648);
  assert.equal(value.maximum, 2147483647);

  const invalidInt64 = structuredClone(int32Payload);
  invalidInt64.properties.value = { type: "integer", format: "int64", minimum: 0 };
  assert.ok((await diagnosticsFor(duplexDocument({ clientPayload: invalidInt64 }))).some(value => value.code === "schema.integer.int64-range"));

  const unknown = structuredClone(int32Payload);
  unknown.properties.value.format = "uint32";
  assert.ok((await diagnosticsFor(duplexDocument({ clientPayload: unknown }))).some(value => value.code === "schema.format.unsupported"));
});
