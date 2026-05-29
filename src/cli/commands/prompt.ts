import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { boolFlag, optionalString, requireString, type ParsedArgs } from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { buildRuntime, writeArtifactFile } from "../prompts";
import { CLAUDE_MARKER_BEGIN } from "../prompts/claude";
import type { Target } from "../prompts";

const TARGETS: ReadonlySet<Target> = new Set(["codex", "claude", "cursor", "generic"]);

/**
 * Which gojaja runtime artifacts are currently installed in the project.
 * Used to warn about duplicate system-prompt injection: a single host
 * often reads more than one of these. As of 2026 AGENTS.md is a
 * cross-tool standard — Cursor reads BOTH AGENTS.md and
 * `.cursor/rules/*.mdc`, and Claude Code reads CLAUDE.md (and, on
 * recent versions, AGENTS.md too). So if several targets are installed,
 * one window can inject the same block twice (wasteful, not broken).
 */
async function installedRuntimeFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const cursorRule = path.join(root, ".cursor", "rules", "gojaja-runtime.mdc");
  try {
    await fsp.access(cursorRule);
    out.push(".cursor/rules/gojaja-runtime.mdc");
  } catch {
    /* not installed */
  }
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const text = await fsp.readFile(path.join(root, name), "utf8");
      if (text.includes(CLAUDE_MARKER_BEGIN)) out.push(name);
    } catch {
      /* absent */
    }
  }
  return out;
}

/**
 * `gojaja prompt --target <host> [--write] [--no-handbook] [--json]`
 *
 * Strictly role-free. Builds the runtime artifact for a host — the same
 * artifact for every role on that host. To bind a role to a specific
 * chat window, the user (or agent) runs `gojaja activate <role> ...`
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
        `Use 'gojaja activate <role> --target <host>' to get a per-window activation snippet. ` +
        `'prompt' installs the host-wide runtime artifact only.`,
    );
  }
  const target = requireString(args.flags, "target") as Target;
  if (!TARGETS.has(target)) {
    throw new UsageError(`Unknown --target '${target}'. Use codex, claude, cursor, or generic.`);
  }
  const write = boolFlag(args.flags, "write");
  const forceRewrite = boolFlag(args.flags, "force-rewrite");
  if (forceRewrite && !write) {
    throw new UsageError("--force-rewrite requires --write.");
  }
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
        "Use `gojaja activate <role> --target generic` instead — it bundles the runtime body.",
    );
  }

  const writeResults: Array<{ path: string; result: "wrote" | "unchanged" }> = [];
  if (write) {
    for (const f of artifact.files) {
      const result = await writeArtifactFile(f, { force: forceRewrite });
      writeResults.push({ path: f.path, result });
    }
  }

  // After a write, check whether multiple runtime artifacts now coexist
  // in the project — a single host may read more than one of them and
  // inject the block twice (see installedRuntimeFiles).
  const coexisting = write ? await installedRuntimeFiles(root) : [];
  const overlap = coexisting.length > 1;

  if (json) {
    process.stdout.write(
      JSON.stringify({
        target,
        wrote: writeResults,
        body: artifact.body,
        // Hosts (Cursor / Claude Code / Codex) inject these rule
        // files into the system prompt only when an agent window
        // opens. Surface this as a structured field so scripted
        // installers don't have to scrape stdout.
        requiresWindowRestart: write && writeResults.some((r) => r.result === "wrote"),
        installedRuntimeFiles: coexisting,
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
      const label = r.result === "wrote" ? "WROTE    " : "UNCHANGED";
      const suffix = r.result === "unchanged" ? "  (already up to date)" : "";
      process.stdout.write(`  - ${label} ${r.path}${suffix}\n`);
    }
    const anyWrote = writeResults.some((r) => r.result === "wrote");
    if (anyWrote) {
      // Hosts only inject rule files into the system prompt at window
      // open time. If the user already has an agent window open, the
      // new content will NOT take effect there — they need to close
      // and re-open that window. This is the most common first-run
      // mistake; pay the caveat cost on every write.
      process.stdout.write(
        `\nIMPORTANT: ${describeHost(target)} injects these rule files into the\n` +
          `agent's system prompt only when the agent window first opens.\n` +
          `If you already have an agent window open for this project,\n` +
          `restart it before chatting — the new rule will NOT take effect\n` +
          `in an already-running window.\n`,
      );
    } else {
      process.stdout.write(
        `\nTip: if a file is "UNCHANGED" but you suspect drift,\n` +
          `re-run with --write --force-rewrite to overwrite from template.\n`,
      );
    }
    if (overlap) {
      process.stdout.write(
        `\nNote: this project now has ${coexisting.length} gojaja runtime files:\n` +
          coexisting.map((f) => `  - ${f}`).join("\n") +
          `\nMany hosts read more than one of these (Cursor reads AGENTS.md\n` +
          `AND .cursor/rules; Claude Code reads CLAUDE.md and, recently,\n` +
          `AGENTS.md), so one window may inject the same block twice —\n` +
          `wasteful, though not harmful. AGENTS.md alone already covers\n` +
          `Cursor + Codex (+ Copilot / Windsurf / Zed); add the Cursor or\n` +
          `Claude target only if you need that host's native file. Use\n` +
          `'gojaja reset' to remove a runtime file you don't want.\n`,
      );
    }
    process.stdout.write(
      `\nNext: open one agent window per role and run\n` +
        `  gojaja activate <role> --target ${target}\n` +
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

function describeHost(target: Target): string {
  switch (target) {
    case "cursor": return "Cursor";
    case "claude": return "Claude Code";
    case "codex":  return "Codex CLI";
    default:       return "The agent host";
  }
}
