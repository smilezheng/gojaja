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
  prompt --target codex|claude|cursor|generic [--write] [--no-handbook]
                                              Print (and with --write,
                                              install) the host-specific
                                              runtime artifact for this
                                              project. ROLE-FREE: same
                                              artifact for every role; do
                                              not pass a role.
  activate <role> --target codex|claude|cursor|generic [--no-handbook]
                                              Print the chat-paste snippet
                                              that binds <role> to one
                                              agent window. Never writes
                                              to disk; role binding stays
                                              at the window/shell layer.

Task board (PM/TL or any role with appropriate scope):
  task new --title <text> [--owner <role>] [--priority P0|P1|P2|P3]
           [--depends-on T-NNNN,...] [--acceptance <text>]
  task assign <task-id> --to <role>
  task status <task-id> <Backlog|Ready|InProgress|Blocked|Review|Done>
  task list [--owner <role>] [--status <s>]
  task show <task-id>

RFCs (open a proposal, gather opinions, a decider chooses):
  rfc new <slug> --title <text> --deciders <r1,...> --options <A:summary,B:summary>
                 [--voters <r1,...>] [--deadline <iso>]
  rfc comment <rfc-id> --rationale <text> [--option <opt>]
  rfc decide  <rfc-id> --option <opt> --rationale <text>
  rfc reject  <rfc-id> --rationale <text>
  rfc list    [--status open|accepted|rejected|superseded]
  rfc show    <rfc-id>

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

Ownership-gated writes:
  write-state --file <state/path> [--content <text>]
                                              Write atomically into the
                                              layer, gated by the actor's
                                              config.yaml owns. Content
                                              comes from --content or stdin.

Global options:
  --root <path>                               Override project root.
  --json                                      Force JSON output.

Information:
  version                                     CLI and schema version.
  help                                        Show this help.

Not yet implemented (see docs/ROADMAP.md): doctor, upgrade.
`;
