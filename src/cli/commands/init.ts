import * as path from "node:path";
import { execFile } from "node:child_process";
import * as readline from "node:readline";
import { LocalFsStore } from "../../core/local-fs-store";
import { LAYER_DIRNAME, SCHEMA_VERSION } from "../runtime";
import type { ParsedArgs } from "../argv";
import { boolFlag, optionalString } from "../argv";

type GitState =
  | { kind: "clean" }
  | { kind: "dirty"; sample: string[] }
  | { kind: "not-a-repo" };

/**
 * Inspect the git state of `root`. `gojaja init` writes a new `.gojaja/`
 * tree (and later `prompt --write` touches `.cursor/` / `CLAUDE.md`); we
 * want the user to have a clean revert point first, and to consciously
 * accept the risk if the project is not under version control at all.
 *
 * Resolution:
 *   - git present + inside a work tree + clean      → { clean }
 *   - git present + inside a work tree + dirty       → { dirty, sample }
 *   - git missing, or not inside a work tree         → { not-a-repo }
 */
async function inspectGit(root: string): Promise<GitState> {
  const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside === null || inside.trim() !== "true") {
    return { kind: "not-a-repo" };
  }
  const status = await runGit(root, ["status", "--porcelain"]);
  if (status === null || status.trim().length === 0) {
    return { kind: "clean" };
  }
  const sample = status
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 10);
  return { kind: "dirty", sample };
}

function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(stdout);
    });
  });
}

/** Ask a yes/no question on a TTY. Resolves false on EOF / non-yes. */
function confirmYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export async function runInit(args: ParsedArgs): Promise<number> {
  const root = path.resolve(
    optionalString(args.flags, "root") ?? args.positional[0] ?? process.cwd(),
  );
  const layerDir = path.join(root, LAYER_DIRNAME);
  const store = new LocalFsStore(layerDir);
  const json = boolFlag(args.flags, "json");
  const force = boolFlag(args.flags, "force");

  if (await store.isInitialised()) {
    if (json) {
      process.stdout.write(
        JSON.stringify({ status: "already_initialised", root: layerDir }) + "\n",
      );
    } else {
      process.stderr.write(
        `gojaja layer already initialised at ${layerDir}. ` +
          `Use 'gojaja reset' to remove it before re-initialising.\n`,
      );
    }
    return 4;
  }

  // Safety gate: protect the user's working tree before we start writing
  // files. `--force` skips all checks (scripts, CI, or "I know what I'm
  // doing"). Skipped entirely in --json mode too, since a JSON caller is
  // non-interactive and has opted into automation.
  if (!force && !json) {
    const git = await inspectGit(root);
    if (git.kind === "dirty") {
      process.stderr.write(
        `Refusing to init: ${root} has uncommitted git changes.\n\n` +
          git.sample.map((l) => `    ${l}`).join("\n") +
          (git.sample.length >= 10 ? "\n    ...\n" : "\n") +
          `\nCommit or stash them first so gojaja's changes land in a\n` +
          `clean, revertable state. Then re-run 'gojaja init'.\n` +
          `(Override with 'gojaja init --force' if you understand the risk.)\n`,
      );
      return 2;
    }
    if (git.kind === "not-a-repo") {
      const interactive = process.stdin.isTTY === true;
      if (!interactive) {
        process.stderr.write(
          `Refusing to init: ${root} is not a git repository and stdin is\n` +
            `not a TTY, so I cannot ask for confirmation. Without version\n` +
            `control there is no clean way to undo gojaja's changes if\n` +
            `something goes wrong. Re-run 'gojaja init --force' to proceed\n` +
            `anyway, or initialise git first ('git init && git add -A &&\n` +
            `git commit -m initial').\n`,
        );
        return 2;
      }
      process.stdout.write(
        `Warning: ${root} is not a git repository.\n` +
          `gojaja will create a .gojaja/ directory (and later 'prompt\n` +
          `--write' may touch .cursor/ or CLAUDE.md). Without git there is\n` +
          `no clean way to undo these changes if something goes wrong.\n\n`,
      );
      const ok = await confirmYesNo("Proceed with init anyway? [y/N] ");
      if (!ok) {
        process.stdout.write("Aborted. No files were created.\n");
        return 0;
      }
    }
  }

  await store.initialise(SCHEMA_VERSION);

  if (json) {
    process.stdout.write(
      JSON.stringify({
        status: "initialised",
        root: layerDir,
        version: SCHEMA_VERSION,
      }) + "\n",
    );
  } else {
    process.stdout.write(`Initialised gojaja layer (v${SCHEMA_VERSION}) at ${layerDir}\n`);
  }
  return 0;
}
