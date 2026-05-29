import { parseArgv } from "./argv";
import { GojajaError, UsageError } from "../core/errors";
import { runAck } from "./commands/ack";
import { runActivate } from "./commands/activate";
import { runClaim } from "./commands/claim";
import { runInit } from "./commands/init";
import { runPlan } from "./commands/plan";
import { runPrompt } from "./commands/prompt";
import { runRelease } from "./commands/release";
import { runReport } from "./commands/report";
import { runReset } from "./commands/reset";
import { runRfc } from "./commands/rfc";
import { runRole } from "./commands/role";
import { runTask } from "./commands/task";
import { runVersion } from "./commands/version";
import { runWait } from "./commands/wait";
import { runWatch } from "./commands/watch";
import { runWorklog } from "./commands/worklog";
import { runState } from "./commands/state";
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

  // A `--help` / `-h` anywhere in a subcommand prints help and exits
  // WITHOUT running the command. Without this, e.g. `gojaja wait --help`
  // would fall through to `runWait` and actually block on a wait, and
  // `gojaja init --help` would initialise the project — both surprising
  // and a footgun for the common `<cmd> --help` reflex.
  if (raw.slice(1).some((a) => a === "--help" || a === "-h")) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const args = parseArgv(raw);

  // `--session <id>` is a host-portability escape hatch. Identity is
  // normally read from the GOJAJA_SESSION env var, but some agent hosts
  // run each tool call in a fresh shell and do NOT persist the `export`
  // from `gojaja claim`. On those hosts the agent can pass the session
  // id explicitly on every command instead. Setting it here means all
  // downstream identity resolution (which reads process.env) works
  // unchanged. An explicit flag wins over an inherited env var.
  if (typeof args.flags.session === "string" && args.flags.session.length > 0) {
    process.env.GOJAJA_SESSION = args.flags.session;
  }

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
    case "activate":
      return runActivate(args);
    case "wait":
      return runWait(args);
    case "watch":
      return runWatch(args);
    case "state":
      return runState(args);
    case "reset":
      return runReset(args);
    default:
      throw new UsageError(`Unknown command: ${args.command}`);
  }
}

dispatch().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof GojajaError) {
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
