import { boolFlag, optionalString, requireString, type ParsedArgs } from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { resolveActor } from "../identity";
import { nextLoopHint } from "../next-hint";

/**
 * `gojaja state <subcommand>` — operations on `state/*` files.
 *
 * Subcommands:
 *   edit    Edit a state file: overwrite / append / replace modes.
 *
 * Other subcommands (list / show / ...) are reserved for future use.
 * This file replaces the previous `gojaja write-state` command name,
 * which had become misleading once append/replace modes were added —
 * "write" reads like overwrite-only.
 */
export async function runState(args: ParsedArgs): Promise<number> {
  const sub = args.positional[0];
  switch (sub) {
    case "edit":
      return runStateEdit(args);
    default:
      throw new UsageError(
        "Usage: gojaja state <edit> [flags]\n" +
          "  gojaja state edit --file state/<path> [--content <text> | --append <text> | --replace <old> --with <new> [--batch]]",
      );
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

/**
 * `gojaja state edit --file state/<path> ...`
 *
 * Three mutually-exclusive write modes:
 *
 *   overwrite (default): --content <text> OR pipe to stdin.
 *                        Replaces the whole file. Use only when you
 *                        actually intend to rewrite from scratch.
 *   append:              --append <text>.
 *                        Adds text at the end; caller provides the
 *                        newline if they want one. Good for
 *                        decisions.md / risks.yaml log-style writes.
 *   replace:             --replace <oldText> --with <newText> [--batch].
 *                        Literal-string find-and-replace. Default
 *                        refuses count !== 1 to prevent surprises;
 *                        --batch allows N>1. No regex.
 *
 * Ownership / mustNotEdit / path canonical-form gates apply to all
 * three modes.
 */
async function runStateEdit(args: ParsedArgs): Promise<number> {
  const relPath = requireString(args.flags, "file");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);

  // Identity: agent invocations (GOJAJA_SESSION set) get their gated role;
  // bare human invocations bypass via "SYSTEM" (see Store.requireOwnership).
  // A stale/invalid GOJAJA_SESSION must NOT silently downgrade to SYSTEM —
  // that would be privilege escalation against the ownership gate.
  const { actor } = await resolveActor(store);

  // Decide which mode the caller asked for. We look at the *presence*
  // of each flag rather than its value so an empty string still counts
  // as "I'm using this mode" (a deliberate empty replacement is valid).
  const hasContent = args.flags.content !== undefined;
  const hasAppend = args.flags.append !== undefined;
  const hasReplace = args.flags.replace !== undefined;
  const hasWith = args.flags.with !== undefined;
  const hasBatch = boolFlag(args.flags, "batch");

  // Mutual exclusion: at most one of content / append / replace.
  const modeFlagsUsed = [hasContent, hasAppend, hasReplace].filter(Boolean).length;
  if (modeFlagsUsed > 1) {
    throw new UsageError(
      "Pick exactly one of --content / --append / --replace. " +
        "They are mutually exclusive.",
    );
  }
  // --with only makes sense with --replace.
  if (hasWith && !hasReplace) {
    throw new UsageError("--with requires --replace.");
  }
  if (hasReplace && !hasWith) {
    throw new UsageError("--replace requires --with.");
  }
  // --batch only makes sense with --replace.
  if (hasBatch && !hasReplace) {
    throw new UsageError("--batch requires --replace.");
  }

  let result;
  let mode: "overwrite" | "append" | "replace";

  if (hasAppend) {
    mode = "append";
    const appendText = optionalString(args.flags, "append") ?? "";
    result = await store.writeStateFile({
      actor,
      relPath,
      mode: "append",
      appendText,
    });
  } else if (hasReplace) {
    mode = "replace";
    const oldText = optionalString(args.flags, "replace") ?? "";
    const newText = optionalString(args.flags, "with") ?? "";
    result = await store.writeStateFile({
      actor,
      relPath,
      mode: "replace",
      oldText,
      newText,
      batch: hasBatch,
    });
  } else {
    mode = "overwrite";
    let content = optionalString(args.flags, "content");
    if (content === undefined) content = await readStdin();
    if (typeof content !== "string") content = "";
    result = await store.writeStateFile({
      actor,
      relPath,
      content,
      mode: "overwrite",
    });
  }

  if (json) {
    process.stdout.write(
      JSON.stringify({ status: "wrote", mode, actor, ...result }) + "\n",
    );
    return 0;
  }

  if (mode === "overwrite") {
    process.stdout.write(
      `Wrote ${result.relPath} (${result.bytesWritten} bytes) as ${actor}.\n`,
    );
  } else if (mode === "append") {
    process.stdout.write(
      `Appended ${result.bytesWritten} bytes to ${result.relPath} as ${actor}.\n`,
    );
  } else {
    const n = result.replacedOccurrences ?? 1;
    const noun = n === 1 ? "occurrence" : "occurrences";
    process.stdout.write(
      `Replaced ${n} ${noun} in ${result.relPath} as ${actor}.\n`,
    );
  }
  process.stdout.write(nextLoopHint({ json, actor }));
  return 0;
}
