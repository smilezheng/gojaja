import { boolFlag, optionalString, requireString, type ParsedArgs } from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { buildActivation } from "../prompts";
import type { Target } from "../prompts";
import { roleMarkdownHasTbd } from "./role";
import { copyToClipboard } from "../util/clipboard";

const TARGETS: ReadonlySet<Target> = new Set(["agents", "claude", "cursor", "generic"]);

const DIVIDER_TOP    = "═══════════════════════ BEGIN PASTE TO AGENT ═══════════════════════";
const DIVIDER_BOTTOM = "════════════════════════ END PASTE TO AGENT ════════════════════════";

/**
 * `gojaja activate <role> --target <host> [--no-handbook] [--json]`
 *
 * Prints the chat-paste snippet that binds a role to one specific agent
 * window. Never writes to disk — role identifiers live only in the chat
 * scrollback of the window that pasted them, and in the `GOJAJA_SESSION` env
 * var of that window's shell.
 *
 * For `--target generic`, the snippet bundles the runtime body too,
 * since there is no persistent install location to read it from. For
 * the other targets, the runtime body is assumed already installed via
 * `gojaja prompt --target <host> --write`.
 *
 * `--no-handbook` is only meaningful for `--target generic` (where the
 * runtime body is embedded in the snippet); for other targets the
 * handbook setting was fixed at `prompt --write` time.
 */
export async function runActivate(args: ParsedArgs): Promise<number> {
  const role = args.positional[0];
  if (!role) {
    throw new UsageError(
      "Usage: gojaja activate <role> --target agents|claude|cursor|generic [--no-handbook] [--json]",
    );
  }
  const target = requireString(args.flags, "target") as Target;
  if (!TARGETS.has(target)) {
    throw new UsageError(`Unknown --target '${target}'. Use agents, claude, cursor, or generic.`);
  }
  const withHandbook = !boolFlag(args.flags, "no-handbook");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());

  const store = await openStoreOrThrow(root);
  const config = await store.readConfig();
  if (!config.roles[role]) {
    throw new UsageError(
      `Unknown role '${role}'. Create it first: gojaja role create ${role} "<title>"`,
    );
  }

  // Hard refusal if the role contract still has TBD placeholders.
  // Without a real description, the agent will keep bouncing
  // identity questions back to the user; blocking activation forces
  // the user to fill it out at the right moment (before they have an
  // agent window open and started asking).
  if (await roleMarkdownHasTbd(store, role)) {
    throw new UsageError(
      `Role '${role}' still has TBD sections in .gojaja/roles/${role}.md ` +
        `(Role description and/or Responsibilities). Open that file, fill them ` +
        `in (this is the agent's self-introduction), and re-run.`,
    );
  }

  const activation = buildActivation(target, role, root, { withHandbook });
  const noCopy = boolFlag(args.flags, "no-copy");
  const clipboardTool = noCopy ? null : await copyToClipboard(activation);

  if (json) {
    process.stdout.write(
      JSON.stringify({
        role,
        target,
        activation,
        copiedToClipboard: clipboardTool !== null,
        clipboardTool,
      }) + "\n",
    );
    return 0;
  }

  // Human output: explicit dividers so it is obvious where the paste
  // payload begins and ends. Without them, users (and reviewers
  // skim-reading the output) cannot tell the descriptive lines apart
  // from the prompt itself.
  if (clipboardTool !== null) {
    process.stdout.write(
      `Activation snippet copied to clipboard via ${clipboardTool}.\n` +
        `Open the agent window for role '${role}' and paste (Cmd/Ctrl+V).\n` +
        `For reference, the payload is also printed below between the dividers.\n\n`,
    );
  } else if (noCopy) {
    process.stdout.write(
      `Copy the block between the dividers and paste it into the agent\n` +
        `window for role '${role}' (clipboard copy skipped due to --no-copy).\n\n`,
    );
  } else {
    process.stdout.write(
      `Could not copy to clipboard (no pbcopy / wl-copy / xclip / xsel /\n` +
        `clip.exe found). Copy the block between the dividers manually and\n` +
        `paste it into the agent window for role '${role}'.\n\n`,
    );
  }
  process.stdout.write(`${DIVIDER_TOP}\n`);
  process.stdout.write(activation);
  if (!activation.endsWith("\n")) process.stdout.write("\n");
  process.stdout.write(`${DIVIDER_BOTTOM}\n`);
  return 0;
}
