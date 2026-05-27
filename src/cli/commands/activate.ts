import { boolFlag, optionalString, requireString, type ParsedArgs } from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { buildActivation } from "../prompts";
import type { Target } from "../prompts";

const TARGETS: ReadonlySet<Target> = new Set(["codex", "claude", "cursor", "generic"]);

/**
 * `agentctl activate <role> --target <host> [--no-handbook] [--json]`
 *
 * Prints the chat-paste snippet that binds a role to one specific agent
 * window. Never writes to disk — role identifiers live only in the chat
 * scrollback of the window that pasted them, and in the `MA_SESSION` env
 * var of that window's shell.
 *
 * For `--target generic`, the snippet bundles the runtime body too,
 * since there is no persistent install location to read it from. For
 * the other targets, the runtime body is assumed already installed via
 * `agentctl prompt --target <host> --write`.
 *
 * `--no-handbook` is only meaningful for `--target generic` (where the
 * runtime body is embedded in the snippet); for other targets the
 * handbook setting was fixed at `prompt --write` time.
 */
export async function runActivate(args: ParsedArgs): Promise<number> {
  const role = args.positional[0];
  if (!role) {
    throw new UsageError(
      "Usage: agentctl activate <role> --target codex|claude|cursor|generic [--no-handbook] [--json]",
    );
  }
  const target = requireString(args.flags, "target") as Target;
  if (!TARGETS.has(target)) {
    throw new UsageError(`Unknown --target '${target}'. Use codex, claude, cursor, or generic.`);
  }
  const withHandbook = !boolFlag(args.flags, "no-handbook");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());

  const store = await openStoreOrThrow(root);
  const config = await store.readConfig();
  if (!config.roles[role]) {
    throw new UsageError(
      `Unknown role '${role}'. Create it first: agentctl role create ${role} "<title>"`,
    );
  }

  const activation = buildActivation(target, role, root, { withHandbook });

  if (json) {
    process.stdout.write(
      JSON.stringify({ role, target, activation }) + "\n",
    );
    return 0;
  }

  process.stdout.write(
    `Paste the following into the agent window assigned to role '${role}':\n\n`,
  );
  process.stdout.write(activation);
  if (!activation.endsWith("\n")) process.stdout.write("\n");
  return 0;
}
