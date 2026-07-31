const MAXIMUM_PATTERN_UTF8_BYTES = 256;
export const MAXIMUM_PATTERN_INPUT_CODE_POINTS = 4_096;

const RAW_CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const ESCAPABLE_LITERAL = new Set([..."\\.^$*+?()[]{}|-"]);
const CLASS_CONTENT = {
  s: "\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF",
  d: "0-9",
  w: "0-9A-Z_a-z"
};

export class UnsafePatternError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "UnsafePatternError";
  }
}

function unsafe(reason) {
  throw new UnsafePatternError(reason);
}

function parsePortablePattern(source) {
  if (typeof source !== "string") unsafe("pattern must be a string");
  if (!source.isWellFormed()) unsafe("pattern must contain well-formed Unicode");
  if (Buffer.byteLength(source, "utf8") > MAXIMUM_PATTERN_UTF8_BYTES) {
    unsafe("pattern exceeds the 256-byte generation budget");
  }
  const characters = [...source];
  let index = 0;
  let variableRepetitions = 0;
  const normalized = [];
  if (characters[index] === "^") {
    normalized.push("^");
    index += 1;
  }
  while (index < characters.length) {
    if (characters[index] === "$" && index === characters.length - 1) {
      normalized.push("(?![\\s\\S])");
      index += 1;
      break;
    }
    let atom;
    if (characters[index] === "[") {
      const characterClass = ["["];
      index += 1;
      if (characters[index] === "^") {
        characterClass.push("^");
        index += 1;
      }
      let entries = 0;
      while (index < characters.length && characters[index] !== "]") {
        if (characters[index] === "\\") {
          const escaped = characters[index + 1];
          if (escaped === undefined) unsafe("a trailing backslash is not allowed");
          if (!"sdwSDWnrtf\\.^$*+?()[]{}|-".includes(escaped)) {
            unsafe("escape \\" + escaped + " is outside the portable pattern subset");
          }
          if ("SDW".includes(escaped)) unsafe("negated character categories cannot be nested in a character class");
          characterClass.push(CLASS_CONTENT[escaped] ?? "\\" + escaped);
          index += 2;
          entries += 1;
          continue;
        }
        if (RAW_CONTROL_OR_FORMAT.test(characters[index]) || characters[index] === "[") {
          unsafe("character classes cannot contain controls, formatting code points, or nested classes");
        }
        if (characters[index] === "-" && entries === 0) unsafe("a leading - must be escaped");
        characterClass.push(characters[index]);
        index += 1;
        entries += 1;
      }
      if (characters[index] !== "]") unsafe("an unterminated character class is not allowed");
      if (entries === 0) unsafe("an empty character class is not allowed");
      index += 1;
      characterClass.push("]");
      atom = characterClass.join("");
    } else if (characters[index] === "\\") {
      const escaped = characters[index + 1];
      if (escaped === undefined) unsafe("a trailing backslash is not allowed");
      if (!"sdwSDWnrtf\\.^$*+?()[]{}|-".includes(escaped)) {
        unsafe("escape \\" + escaped + " is outside the portable pattern subset");
      }
      if (CLASS_CONTENT[escaped.toLowerCase()] !== undefined) {
        atom = "[" + (escaped === escaped.toUpperCase() ? "^" : "") + CLASS_CONTENT[escaped.toLowerCase()] + "]";
      } else {
        atom = "\\" + escaped;
      }
      index += 2;
    } else if (characters[index] === ".") {
      atom = ".";
      index += 1;
    } else {
      const value = characters[index];
      if (RAW_CONTROL_OR_FORMAT.test(value)) unsafe("patterns cannot contain raw control or formatting code points");
      if ("^$*+?(){}|]".includes(value)) {
        unsafe(value + " is outside the portable pattern subset or must be escaped");
      }
      atom = ESCAPABLE_LITERAL.has(value) ? "\\" + value : value;
      index += 1;
    }
    let quantifier = "";
    let variable = false;
    if ("?*+".includes(characters[index])) {
      quantifier = characters[index];
      variable = true;
      index += 1;
    } else if (characters[index] === "{") {
      let closing = index + 1;
      while (closing < characters.length && characters[closing] !== "}") closing += 1;
      if (closing >= characters.length) unsafe("an unterminated repetition is not allowed");
      const body = characters.slice(index + 1, closing).join("");
      const match = /^(\d+)(?:,(\d*))?$/.exec(body);
      if (!match) unsafe("repetitions must use {n}, {n,m}, or {n,}");
      const minimum = Number(match[1]);
      const maximum = match[2] === undefined ? minimum : match[2] === "" ? Infinity : Number(match[2]);
      if (minimum > 256 || maximum > 256) unsafe("bounded repetition values must not exceed 256");
      if (maximum < minimum) unsafe("a repetition maximum must not be below its minimum");
      quantifier = "{" + body + "}";
      variable = minimum !== maximum;
      index = closing + 1;
    }
    if (variable) variableRepetitions += 1;
    if (variableRepetitions > 1) unsafe("at most one variable repetition is allowed per pattern");
    normalized.push(atom + quantifier);
  }
  const normalizedSource = normalized.join("");
  try {
    new RegExp(normalizedSource, "u");
  } catch {
    unsafe("pattern is not valid in the portable regular-expression subset");
  }
  return normalizedSource;
}

export function normalizeSafePattern(source) {
  return parsePortablePattern(source);
}

export function portablePatternMatches(source, input) {
  if (typeof input !== "string" || [...input].length > MAXIMUM_PATTERN_INPUT_CODE_POINTS) return false;
  return new RegExp(parsePortablePattern(source), "u").test(input);
}
