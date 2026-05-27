import { CLI_VERSION } from "./runtime";

export const HELP_TEXT = `agentctl ${CLI_VERSION}

Usage:
  agentctl <command> [options]

Commands:
  init                       Initialise a .multi-agent layer in the current project.
  version                    Print the schema version of the current layer.
  help                       Show this help.

Global options:
  --root <path>              Override project root (default: walk up from CWD).
  --json                     Force JSON output where supported.

This is v2.0.0-alpha. Many subcommands (claim, plan, ack, report, rfc, ...) are
not yet implemented; they will land in upcoming PRs.
`;
