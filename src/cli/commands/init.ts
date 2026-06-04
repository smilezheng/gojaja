import * as path from "node:path";
import * as readline from "node:readline";
import { LocalFsStore } from "../../core/local-fs-store";
import { LAYER_DIRNAME, SCHEMA_VERSION } from "../runtime";
import type { ParsedArgs } from "../argv";
import { boolFlag, optionalString } from "../argv";
import { freshId } from "../../core/ids";
import {
  centralRootForProject,
  writeProjectJson,
} from "../central-root";
import { inspectGit, type GitState } from "../util/git-state";
import type { ProjectJson } from "../../core/types";

/** Re-export for backward compatibility — gitState lives in util now. */
export { type GitState } from "../util/git-state";

/**
 * Headless inspector + initializer for use outside the interactive
 * CLI (`gojaja watch`'s POST /api/init in particular). Splits the
 * command's logic into two pieces:
 *
 *   - `inspectInitState(root)` — pure inspection: is the layer
 *     already there, what does git look like? Never writes.
 *   - `performInit(root, opts)` — does the actual write. Refuses
 *     dirty / non-git unless `opts.force === true`. Never reads
 *     stdin or writes stdout — error reporting is via thrown
 *     classed errors that the HTTP layer maps to 400/409 codes.
 *
 * The interactive `runInit` below composes these two with readline-
 * based confirmation; the HTTP path composes them with a "first
 * call probes, second call (force:true) confirms" pattern in the
 * front-end.
 */
export interface InitInspection {
  alreadyInitialised: boolean;
  layerDir: string;
  git: GitState;
}

export async function inspectInitState(root: string): Promise<InitInspection> {
  const layerDir = path.join(root, LAYER_DIRNAME);
  // Both v2 and v3 projects carry VERSION under the user tree, so
  // a single-root probe is the right check for "already
  // initialised". project.json (the v3 marker) is supplemental.
  const store = new LocalFsStore(layerDir);
  const alreadyInitialised = await store.isInitialised();
  const git = alreadyInitialised
    ? ({ kind: "clean" } as GitState)
    : await inspectGit(root);
  return { alreadyInitialised, layerDir, git };
}

/**
 * Thrown by `performInit` when the working tree is dirty or not a
 * git repo and the caller did not pass `force: true`. Carries the
 * git inspection so the HTTP layer can render it inline.
 */
export class InitGitGateError extends Error {
  readonly code = "INIT_GIT_GATE";
  constructor(
    public readonly git: GitState,
    public readonly layerDir: string,
  ) {
    super(
      git.kind === "dirty"
        ? `Refusing to init: working tree has uncommitted git changes.`
        : `Refusing to init: not a git repository (no clean revert path).`,
    );
  }
}

export class AlreadyInitialisedError extends Error {
  readonly code = "ALREADY_INITIALISED";
  constructor(public readonly layerDir: string) {
    super(`gojaja layer already initialised at ${layerDir}.`);
  }
}

export interface PerformInitResult {
  layerDir: string;
  version: string;
  /** PR9.2: the v3 project ULID minted at init time. */
  projectId: string;
  /** PR9.2: the per-machine central root assigned to this project. */
  centralRoot: string;
}

export async function performInit(
  root: string,
  opts: { force?: boolean } = {},
): Promise<PerformInitResult> {
  const layerDir = path.join(root, LAYER_DIRNAME);
  // PR9.2: every fresh init now mints a v3 layout. ULID is generated
  // here, used to derive the central tree path, and recorded in the
  // project.json marker under the user tree (the only piece of the
  // v3 layout that travels with git). Subsequent gojaja invocations
  // re-derive `centralRoot` by reading project.json — see
  // `openStoreOrThrow`.
  const projectId = freshId();
  const centralRoot = centralRootForProject(projectId);
  const store = new LocalFsStore(layerDir, { centralRoot });
  if (await store.isInitialised()) {
    throw new AlreadyInitialisedError(layerDir);
  }
  if (!opts.force) {
    const git = await inspectGit(root);
    if (git.kind !== "clean") {
      throw new InitGitGateError(git, layerDir);
    }
  }
  await store.initialise(SCHEMA_VERSION);
  // project.json must land AFTER store.initialise — initialise
  // creates the user tree on disk, so writing project.json there is
  // safe at this point.
  const project: ProjectJson = {
    id: projectId,
    name: path.basename(root),
    schema: SCHEMA_VERSION,
  };
  await writeProjectJson(layerDir, project);
  return {
    layerDir,
    version: SCHEMA_VERSION,
    projectId,
    centralRoot,
  };
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
  const json = boolFlag(args.flags, "json");
  const force = boolFlag(args.flags, "force");

  const inspection = await inspectInitState(root);
  if (inspection.alreadyInitialised) {
    if (json) {
      process.stdout.write(
        JSON.stringify({ status: "already_initialised", root: inspection.layerDir }) + "\n",
      );
    } else {
      process.stderr.write(
        `gojaja layer already initialised at ${inspection.layerDir}. ` +
          `Use 'gojaja reset' to remove it before re-initialising.\n`,
      );
    }
    return 4;
  }

  // Interactive safety gate (TTY only): mirrors the HTTP path's
  // first-call-then-confirm pattern. `--force` and `--json` both
  // skip — the latter assumes the caller is automated and has
  // explicitly opted in.
  let effectiveForce = force;
  if (!force && !json) {
    if (inspection.git.kind === "dirty") {
      process.stderr.write(
        `Refusing to init: ${root} has uncommitted git changes.\n\n` +
          inspection.git.sample.map((l) => `    ${l}`).join("\n") +
          (inspection.git.sample.length >= 10 ? "\n    ...\n" : "\n") +
          `\nCommit or stash them first so gojaja's changes land in a\n` +
          `clean, revertable state. Then re-run 'gojaja init'.\n` +
          `(Override with 'gojaja init --force' if you understand the risk.)\n`,
      );
      return 2;
    }
    if (inspection.git.kind === "not-a-repo") {
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
      effectiveForce = true;
    }
  }

  const result = await performInit(root, { force: effectiveForce });

  if (json) {
    process.stdout.write(
      JSON.stringify({
        status: "initialised",
        root: result.layerDir,
        version: result.version,
        projectId: result.projectId,
        centralRoot: result.centralRoot,
      }) + "\n",
    );
  } else {
    process.stdout.write(
      `Initialised gojaja layer (v${result.version}) at ${result.layerDir}\n` +
        `  project id:    ${result.projectId}\n` +
        `  central root:  ${result.centralRoot}\n` +
        `\n` +
        `<project>/.gojaja/ (git-tracked) carries:\n` +
        `  VERSION, project.json, config.yaml, roles/, state/project_state.md\n` +
        `Runtime state (task board, events, sessions, RFCs, worklog, locks)\n` +
        `lives in the central root above — never committed. Cloning this\n` +
        `project on another machine? Each clone gets its own central tree\n` +
        `(see RFC-0001).\n`,
    );
  }
  return 0;
}
