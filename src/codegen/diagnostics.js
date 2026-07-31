export class GeneratorDiagnostic {
  constructor(code, path, message) {
    this.code = code;
    this.path = path;
    this.message = message;
  }

  toString() {
    return `${this.code} at ${this.path}: ${this.message}`;
  }
}

export class UnsupportedAsyncAPIFeaturesError extends Error {
  constructor(diagnostics) {
    const sorted = [...diagnostics].sort((left, right) =>
      left.path.localeCompare(right.path) || left.code.localeCompare(right.code)
    );
    super(`AsyncAPI generation failed:\n${sorted.map(item => `- ${item}`).join("\n")}`);
    this.name = "UnsupportedAsyncAPIFeaturesError";
    this.diagnostics = sorted;
  }
}
