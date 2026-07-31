import { Parser, fromFile } from "@asyncapi/parser";

function throwParserDiagnostics(diagnostics) {
  if (diagnostics.length === 0) return;
  const details = diagnostics.map(diagnostic => `${diagnostic.path?.join("/") ?? "$"}: ${diagnostic.message}`).join("\n");
  throw new Error(`AsyncAPI parser rejected the test document:\n${details}`);
}

export async function parseFile(path) {
  const result = await fromFile(new Parser(), path).parse();
  throwParserDiagnostics(result.diagnostics);
  if (!result.document) throw new Error(`AsyncAPI parser produced no document for ${path}`);
  return result.document;
}

export async function parseObject(value) {
  const result = await new Parser().parse(value);
  throwParserDiagnostics(result.diagnostics);
  if (!result.document) throw new Error("AsyncAPI parser produced no document");
  return result.document;
}

export function duplexDocument({ clientPayload, serverPayload, extension } = {}) {
  return {
    asyncapi: "3.1.0",
    info: { title: "Diagnostic fixture", version: "1.0.0" },
    defaultContentType: "application/json",
    ...(extension ?? {}),
    channels: {
      events: {
        address: "/events",
        messages: {
          client: {
            name: "ClientEvent",
            payload: clientPayload ?? {
              type: "object",
              additionalProperties: false,
              required: ["type"],
              properties: { type: { const: "client" } }
            }
          },
          server: {
            name: "ServerEvent",
            payload: serverPayload ?? {
              type: "object",
              additionalProperties: false,
              required: ["type"],
              properties: { type: { const: "server" } }
            }
          }
        }
      }
    },
    operations: {
      receiveEvent: {
        action: "receive",
        channel: { $ref: "#/channels/events" },
        messages: [{ $ref: "#/channels/events/messages/client" }]
      },
      sendEvent: {
        action: "send",
        channel: { $ref: "#/channels/events" },
        messages: [{ $ref: "#/channels/events/messages/server" }]
      }
    }
  };
}
