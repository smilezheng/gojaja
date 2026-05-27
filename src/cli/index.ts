import { parseArgv } from "./argv";
import { AgentctlError, UsageError } from "../core/errors";
import { runInit } from "./commands/init";
import { runVersion } from "./commands/version";
import { HELP_TEXT } from "./help";

async function dispatch(): Promise<number> {
  const raw = process.argv.slice(2);

  // Treat `--version` / `--help` at the front as their own commands.
  if (raw.length === 0 || raw[0] === "help" || raw[0] === "--help" || raw[0] === "-h") {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (raw[0] === "--version" || raw[0] === "-v") {
    raw[0] = "version";
  }

  const args = parseArgv(raw);

  switch (args.command) {
    case "init":
      return runInit(args);
    case "version":
      return runVersion(args);
    default:
      throw new UsageError(`Unknown command: ${args.command}`);
  }
}

dispatch().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof AgentctlError) {
      process.stderr.write(`${err.code}: ${err.message}\n`);
      process.exitCode = err.exitCode;
      return;
    }
    process.stderr.write(
      `internal_error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exitCode = 99;
  },
);
