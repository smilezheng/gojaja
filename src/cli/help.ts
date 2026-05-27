import { CLI_VERSION } from "./runtime";

export const HELP_TEXT = `agentctl ${CLI_VERSION}

Usage:
  agentctl <command> [options]

Bootstrap (run once per project, by you):
  init [--root <path>]                        Initialise a .multi-agent layer.
  role create <id> [<title>]                  Register a role; writes
                                              roles/<id>.md and config.yaml.
  role list                                   List configured roles.
  role show <id>                              Show role config + markdown.
  prompt <role> [--target codex|claude|cursor|generic] [--write]
                                              Print the agent activation
                                              prompt; with --write, install
                                              the host-specific persistent
                                              artifact (skill / rule /
                                              CLAUDE.md block).

Task board (PM/TL or any role with appropriate scope):
  task new --title <text> [--owner <role>] [--priority P0|P1|P2|P3]
           [--depends-on T-NNNN,...] [--acceptance <text>]
  task assign <task-id> --to <role>
  task status <task-id> <Backlog|Ready|InProgress|Blocked|Review|Done>
  task list [--owner <role>] [--status <s>]
  task show <task-id>

Session lifecycle (run once per agent window, then export MA_SESSION):
  claim <role> [--ttl <s>] [--force]
  release [<role>]

Per-turn loop (called by the agent; requires MA_SESSION):
  plan [<role>]                               Fetch a manifest with ackToken.
  ack  [<role>] --token <t>                   Confirm a manifest.

Messaging (requires MA_SESSION):
  report --to <role> --message <text> [--ref <id>]
  worklog --message <text>

Keepalive (requires MA_SESSION):
  wait [<role>] [--idle <minutes>] [--mode block|exit]
                                              Block-mode sleeps without
                                              burning tokens; exit-mode
                                              writes a .wait sentinel and
                                              returns immediately.

Global options:
  --root <path>                               Override project root.
  --json                                      Force JSON output.

Information:
  version                                     CLI and schema version.
  help                                        Show this help.

Not yet implemented (see docs/ROADMAP.md): rfc *, doctor, upgrade.
`;
