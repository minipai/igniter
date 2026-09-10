import type { CAC } from "cac";
import type { CliRuntime } from "./runtime.ts";

export async function runParsedCli(
  args: string[],
  runtime: CliRuntime,
  session: { code: number },
  cli: CAC,
  worker: CAC,
): Promise<number> {
  try {
    if (args[0] === "worker") {
      if (args.length === 1) {
        worker.outputHelp();
        return 1;
      }
      await parse(worker, args.slice(1));
      return session.code;
    }
    if (args.length === 0) {
      cli.outputHelp();
      return 1;
    }
    await parse(cli, normalizeInput(args));
    return session.code;
  } catch (error) {
    runtime.stderr((error as Error).message);
    return 1;
  }
}

export function configureCli(
  cli: CAC,
  version: string,
  runtime: CliRuntime,
  session: { code: number },
): void {
  cli.version(version);
  cli.outputVersion = () => runtime.stdout(version);
  cli.addEventListener("command:*", (event) => {
    if (cli.options.help || cli.options.version) return;
    runtime.stderr(`Unknown command: ${(event as CustomEvent<string>).detail}`);
    session.code = 1;
  });
}

async function parse(cli: CAC, args: string[]): Promise<void> {
  cli.parse([...process.argv.slice(0, 2), ...args], { run: false });
  await cli.runMatchedCommand();
}

function normalizeInput(args: string[]): string[] {
  const normalized = [...args];
  const input = normalized.indexOf("--input");
  if (args[0] === "submit" && input >= 0 && normalized[input + 1] === "-") {
    normalized.splice(input, 2, "--input=-");
  }
  return normalized;
}
