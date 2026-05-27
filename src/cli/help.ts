import { CLI_VERSION } from "./runtime";

export const HELP_TEXT = `agentctl ${CLI_VERSION}

Usage:
  agentctl <command> [options]

Bootstrap:
  init [--root <path>]           Initialise a .multi-agent layer.
  version                        Print CLI and schema version.

Session lifecycle:
  claim <role> [--ttl <s>] [--force]
                                 Lease a role for this shell.
                                 Print the session id; export it as MA_SESSION.
  release [<role>]               End the current session.

Per-turn loop (require MA_SESSION):
  plan [<role>]                  Fetch unread events as a JSON manifest with
                                 an ack token. Idempotent across retry.
  ack  [<role>] --token <t>      Confirm a manifest; advance the cursor only
                                 to that manifest's snapshot point.

Messaging (require MA_SESSION):
  report --to <role> --message <text> [--ref <id>]
                                 Send a directed event to another role.
  worklog --message <text>       Broadcast a worklog entry; also writes
                                 worklog/<role>/<id>.md for humans.

Global options:
  --root <path>                  Override project root (default: walk up).
  --json                         Force JSON output where supported.

Unimplemented (planned, see docs/ROADMAP.md):
  wait, rfc *, role *, doctor, upgrade, reset
`;
