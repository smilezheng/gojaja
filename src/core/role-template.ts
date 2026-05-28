import type { RoleConfig, RoleId } from "./types";

/**
 * Render the human-readable role contract markdown.
 *
 * Two design choices worth noting:
 *
 *   1. We intentionally do NOT inline the structured fields (owns,
 *      reportsTo, mustNotEdit) as bullet lists inside the markdown. Those
 *      live in `config.yaml` only. Inlining them would create two sources
 *      of truth and inevitably drift the moment a user edits one and not
 *      the other. The markdown points to the yaml instead.
 *
 *   2. The startup checklist references real commands (plan / ack / wait).
 *      It is short on purpose: the deep protocol lives in
 *      `docs/PROTOCOL.md`, and the live identity/state lives in the
 *      manifest returned by `gojaja plan`.
 */
export function renderRoleMarkdown(input: { id: RoleId } & RoleConfig): string {
  const { id, title, description } = input;
  const desc = description.trim().length > 0 ? description.trim() : "TBD";
  return [
    `# ${title}`,
    "",
    `Role id: \`${id}\``,
    "",
    "## Role",
    "",
    desc,
    "",
    "## Responsibilities",
    "",
    "- TBD (describe in prose; humans edit this section)",
    "- TBD (RFC decision scopes this role is expected to take — e.g.",
    "  \"decides any RFC touching <some path or area>\". Agents opening",
    "  RFCs read this section when picking `--deciders`.)",
    "",
    "## Scope and reporting",
    "",
    `Machine-readable scope for this role (owns, reportsTo, mustNotEdit) lives in \`config.yaml\` under \`roles.${id}\`.`,
    "Edit there if you change permissions; do not duplicate those lists here.",
    "",
    "## Startup checklist (every turn)",
    "",
    "1. `gojaja plan` — fetch your manifest of unread events and assigned work.",
    "2. Process each item.",
    "3. `gojaja ack --token <t>` — confirm what you saw.",
    "4. `gojaja wait` — keep the window alive without burning tokens.",
    "",
    "See [docs/PROTOCOL.md](../../docs/PROTOCOL.md) for the wire-level contract.",
    "",
  ].join("\n");
}
