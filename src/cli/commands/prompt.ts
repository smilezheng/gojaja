import { boolFlag, optionalString, type ParsedArgs } from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { buildArtifact, writeArtifactFile } from "../prompts";
import type { Target } from "../prompts";

const TARGETS: ReadonlySet<Target> = new Set(["codex", "claude", "cursor", "generic"]);

export async function runPrompt(args: ParsedArgs): Promise<number> {
  const role = args.positional[0];
  if (!role) {
    throw new UsageError(
      "Usage: agentctl prompt <role> [--target codex|claude|cursor|generic] [--write] [--json]",
    );
  }
  const target = (optionalString(args.flags, "target") ?? "generic") as Target;
  if (!TARGETS.has(target)) {
    throw new UsageError(`Unknown --target '${target}'. Use codex, claude, cursor, or generic.`);
  }
  const write = boolFlag(args.flags, "write");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());

  // Validate the role exists. We could skip this for `generic`, but
  // catching the typo early matters more than a tiny ergonomics win.
  const store = await openStoreOrThrow(root);
  const config = await store.readConfig();
  if (!config.roles[role]) {
    throw new UsageError(
      `Unknown role '${role}'. Create it first: agentctl role create ${role} "<title>"`,
    );
  }

  const artifact = buildArtifact(target, role, root);

  if (write && target === "generic") {
    throw new UsageError("--write is not supported for --target generic (no persistence location).");
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
        role,
        target,
        wrote: writeResults,
        body: artifact.body,
        activation: artifact.activation,
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
    process.stdout.write("\n");
  } else if (artifact.files.length > 0) {
    process.stdout.write(
      `Re-run with --write to install the persistent artifact(s):\n` +
        artifact.files.map((f) => `  - ${f.path}`).join("\n") +
        "\n\n",
    );
  }
  process.stdout.write("Activation snippet (paste this into the agent chat for this window):\n\n");
  process.stdout.write(artifact.activation);
  if (!artifact.activation.endsWith("\n")) process.stdout.write("\n");
  return 0;
}
