import { parseArgv } from "./argv";
import { AgentctlError, UsageError } from "../core/errors";
import { runAck } from "./commands/ack";
import { runClaim } from "./commands/claim";
import { runInit } from "./commands/init";
import { runPlan } from "./commands/plan";
import { runPrompt } from "./commands/prompt";
import { runRelease } from "./commands/release";
import { runReport } from "./commands/report";
import { runRfc } from "./commands/rfc";
import { runRole } from "./commands/role";
import { runTask } from "./commands/task";
import { runVersion } from "./commands/version";
import { runWait } from "./commands/wait";
import { runWorklog } from "./commands/worklog";
import { runWriteState } from "./commands/write-state";
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
    case "claim":
      return runClaim(args);
    case "release":
      return runRelease(args);
    case "plan":
      return runPlan(args);
    case "ack":
      return runAck(args);
    case "report":
      return runReport(args);
    case "worklog":
      return runWorklog(args);
    case "role":
      return runRole(args);
    case "task":
      return runTask(args);
    case "rfc":
      return runRfc(args);
    case "prompt":
      return runPrompt(args);
    case "wait":
      return runWait(args);
    case "write-state":
      return runWriteState(args);
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
