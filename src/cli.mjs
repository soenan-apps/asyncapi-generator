import { check, generate } from "./generator.mjs";

const USAGE = `Usage:
  asyncapi-soenan-generator generate --config FILE
  asyncapi-soenan-generator check    --config FILE
`;

function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const [command, ...rest] = argv;
  if (command !== "generate" && command !== "check") {
    throw new TypeError(`expected generate or check\n\n${USAGE}`);
  }
  if (rest.length !== 2 || rest[0] !== "--config" || rest[1].startsWith("--")) {
    if (rest[0]?.startsWith("--") && rest[0] !== "--config") {
      throw new TypeError(`unknown option ${rest[0]}\n\n${USAGE}`);
    }
    throw new TypeError(`expected exactly --config FILE\n\n${USAGE}`);
  }
  return { command, config: rest[1] };
}

export async function run(argv, io = process) {
  try {
    const parsed = parseArguments(argv);
    if (parsed.help) {
      io.stdout.write(USAGE);
      return 0;
    }
    const result = parsed.command === "generate"
      ? await generate(parsed.config)
      : await check(parsed.config);
    for (const target of result.targets) {
      io.stdout.write(`${parsed.command} ${target.language} ${target.moduleName} -> ${target.output}: ${target.files.join(", ")}\n`);
    }
    return 0;
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
}

export { parseArguments, USAGE };
