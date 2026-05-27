import { boolFlag, optionalString, requireString, type ParsedArgs } from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { buildRuntime, writeArtifactFile } from "../prompts";
import type { Target } from "../prompts";

const TARGETS: ReadonlySet<Target> = new Set(["codex", "claude", "cursor", "generic"]);

/**
 * `agentctl prompt --target <host> [--write] [--no-handbook] [--json]`
 *
 * Strictly role-free. Builds the runtime artifact for a host — the same
 * artifact for every role on that host. To bind a role to a specific
 * chat window, the user (or agent) runs `agentctl activate <role> ...`
 * separately. This separation prevents role identifiers from leaking
 * into project-shared files like `.cursor/rules/*` or `CLAUDE.md`,
 * which would otherwise lock the project to a single role per host.
 *
 * Passing a positional argument is refused with a hint pointing at
 * `activate`, so users coming from earlier versions get a clear signal
 * rather than silent rebinding.
 */
export async function runPrompt(args: ParsedArgs): Promise<number> {
  if (args.positional.length > 0) {
    throw new UsageError(
      `'prompt' no longer accepts a role argument (got '${args.positional[0]}'). ` +
        `Use 'agentctl activate <role> --target <host>' to get a per-window activation snippet. ` +
        `'prompt' installs the host-wide runtime artifact only.`,
    );
  }
  const target = requireString(args.flags, "target") as Target;
  if (!TARGETS.has(target)) {
    throw new UsageError(`Unknown --target '${target}'. Use codex, claude, cursor, or generic.`);
  }
  const write = boolFlag(args.flags, "write");
  const json = boolFlag(args.flags, "json");
  const withHandbook = !boolFlag(args.flags, "no-handbook");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());

  // Even though we never embed a role, sanity-check that the layer is
  // initialised so users get a clear error before we start writing files
  // they may not have asked for.
  await openStoreOrThrow(root);

  const artifact = buildRuntime(target, root, { withHandbook });

  if (write && target === "generic") {
    throw new UsageError(
      "--write is not supported for --target generic (no persistent install location). " +
        "Use `agentctl activate <role> --target generic` instead — it bundles the runtime body.",
    );
  }

  const writeResults: Array<{ path: string; result: "wrote" | "skipped" }> = [];
  if (write) {
    for (const f of artifact.files) {
      const result = await writeArtifactFile(f);
      writeResults.push({ path: f.path, result });
    }
  }

  if (json) {
    process.stdout.write(
      JSON.stringify({
        target,
        wrote: writeResults,
        body: artifact.body,
      }) + "\n",
    );
    return 0;
  }

  process.stdout.write(artifact.body);
  if (!artifact.body.endsWith("\n")) process.stdout.write("\n");
  process.stdout.write("\n");
  if (write) {
    process.stdout.write("Files:\n");
    for (const r of writeResults) {
      process.stdout.write(`  - ${r.result === "wrote" ? "WROTE   " : "SKIPPED "} ${r.path}\n`);
    }
    process.stdout.write(
      `\nNext: open one agent window per role and run\n` +
        `  agentctl activate <role> --target ${target}\n` +
        `to get the chat-paste snippet for that window.\n`,
    );
  } else if (artifact.files.length > 0) {
    process.stdout.write(
      `Re-run with --write to install the persistent artifact(s):\n` +
        artifact.files.map((f) => `  - ${f.path}`).join("\n") +
        "\n",
    );
  }
  return 0;
}
