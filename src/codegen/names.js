const SWIFT_KEYWORDS = new Set([
  "associatedtype", "class", "deinit", "enum", "extension", "fileprivate",
  "func", "import", "init", "inout", "internal", "let", "open", "operator",
  "private", "protocol", "public", "rethrows", "static", "struct", "subscript",
  "typealias", "var", "break", "case", "continue", "default", "defer", "do",
  "else", "fallthrough", "for", "guard", "if", "in", "repeat", "return",
  "switch", "where", "while", "as", "Any", "catch", "false", "is", "nil",
  "super", "self", "Self", "throw", "throws", "true", "try"
]);

const DART_KEYWORDS = new Set([
  "abstract", "as", "assert", "async", "await", "base", "break", "case",
  "catch", "class", "const", "continue", "covariant", "default", "deferred",
  "do", "dynamic", "else", "enum", "export", "extends", "extension", "external",
  "factory", "false", "final", "finally", "for", "Function", "get", "hide",
  "if", "implements", "import", "in", "interface", "is", "late", "library",
  "mixin", "new", "null", "of", "on", "operator", "part", "required",
  "rethrow", "return", "sealed", "set", "show", "static", "super", "switch",
  "sync", "this", "throw", "true", "try", "typedef", "var", "void", "when",
  "while", "with", "yield"
]);

const SWIFT_STANDARD_TYPE_NAMES = new Set([
  "Array", "AsyncAPIChannel", "AsyncAPICloseCode", "AsyncAPICloseSignal",
  "AsyncAPIConnection", "AsyncAPIServerTransport", "AsyncAPITransportMessage",
  "AsyncStream", "AsyncThrowingStream", "Bool", "Data", "Dictionary", "Double",
  "Error", "Float", "Int", "Int32", "Int64", "Never", "Optional", "Result",
  "Set", "String", "Task", "UInt", "UInt16", "Void"
]);

const DART_STANDARD_TYPE_NAMES = new Set([
  "AsyncApiAction", "AsyncApiChannel", "AsyncApiOperation", "AsyncApiPeerClose",
  "AsyncApiSocketAdapter", "AsyncApiSocketConnection", "AsyncApiWebSocketCloseSignal",
  "BigInt", "DateTime", "Duration", "Enum", "Error", "Exception", "Future",
  "Function", "Iterable", "List", "Map", "Match", "Never", "Null", "Object",
  "Pattern", "Record", "RegExp", "Set", "StackTrace", "Stream", "String",
  "Symbol", "Type", "Uint8List", "Uri"
]);

function asciiWords(value) {
  const expanded = String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([^\x00-\x7F])/g, character => `_u${character.codePointAt(0).toString(16)}_`)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim();
  return expanded.length === 0 ? ["generated"] : expanded.split(/\s+/);
}

export function pascalCase(value) {
  const result = asciiWords(value)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
  return /^[0-9]/.test(result) ? `_${result}` : result;
}

export function camelCase(value) {
  const result = pascalCase(value);
  const camel = result.charAt(0).toLowerCase() + result.slice(1);
  return /^[0-9]/.test(camel) ? `_${camel}` : camel;
}

export function snakeCase(value) {
  const words = asciiWords(value);
  const result = words.map(word => word.toLowerCase()).join("_");
  return /^[0-9]/.test(result) ? `_${result}` : result;
}

export function swiftIdentifier(value) {
  const identifier = camelCase(value);
  return SWIFT_KEYWORDS.has(identifier) ? `${identifier}_` : identifier;
}

export function dartIdentifier(value) {
  const identifier = camelCase(value);
  return DART_KEYWORDS.has(identifier) ? `${identifier}_` : identifier;
}

export function swiftTypeName(value) {
  const identifier = pascalCase(value);
  return SWIFT_KEYWORDS.has(identifier) || SWIFT_STANDARD_TYPE_NAMES.has(identifier)
    ? `${identifier}Value`
    : identifier;
}

export function dartTypeName(value) {
  const identifier = pascalCase(value);
  return DART_KEYWORDS.has(identifier) || DART_STANDARD_TYPE_NAMES.has(identifier)
    ? `${identifier}Value`
    : identifier;
}

export function sourceCommentLiteral(value) {
  return JSON.stringify(String(value)).replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    character => {
      const codePoint = character.codePointAt(0);
      if (codePoint <= 0xFFFF) {
        return `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
      }
      const offset = codePoint - 0x10000;
      const high = 0xD800 + (offset >> 10);
      const low = 0xDC00 + (offset & 0x3FF);
      return `\\u${high.toString(16).toUpperCase()}\\u${low.toString(16).toUpperCase()}`;
    }
  );
}

export function swiftStringLiteral(value) {
  let result = '"';
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0);
    switch (character) {
      case '"': result += '\\"'; break;
      case "\\": result += "\\\\"; break;
      case "\n": result += "\\n"; break;
      case "\r": result += "\\r"; break;
      case "\t": result += "\\t"; break;
      case "\0": result += "\\0"; break;
      default:
        result += codePoint < 0x20 || codePoint === 0x7F
          ? `\\u{${codePoint.toString(16).toUpperCase()}}`
          : character;
    }
  }
  return `${result}"`;
}

export function dartStringLiteral(value) {
  let result = '"';
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0);
    switch (character) {
      case '"': result += '\\"'; break;
      case "\\": result += "\\\\"; break;
      case "\n": result += "\\n"; break;
      case "\r": result += "\\r"; break;
      case "\t": result += "\\t"; break;
      case "$": result += "\\$"; break;
      default:
        result += codePoint < 0x20 || codePoint === 0x7F
          ? codePoint <= 0xFFFF
            ? `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`
            : `\\u{${codePoint.toString(16).toUpperCase()}}`
          : character;
    }
  }
  return `${result}"`;
}
