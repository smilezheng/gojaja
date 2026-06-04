import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { performInit } from "../src/cli/commands/init";
import { runReset } from "../src/cli/commands/reset";
import { exists } from "../src/core/atomic";
import type { ParsedArgs } from "../src/cli/argv";

/**
 * PR9.6 — `gojaja reset` on v3 projects.
 *
 * v3 projects carry both a user tree (`<project>/.gojaja/`) and a
 * central tree (`~/.gojaja/projects/<id>/`). `reset` must clean up
 * both. The default behaviour moves the central tree to the trash
 * (`~/.gojaja/trash/<id>-<ts>/`) for a 7d soft-delete window;
 * `--purge` skips trash and hard-deletes.
 *
 * Tests use GOJAJA_HOME isolation so they never touch the
 * developer's real `~/.gojaja/`.
 */

interface Ctx {
  baseDir: string;
  projectRoot: string;
  fakeHome: string;
  savedHome: string | undefined;
  savedSession: string | undefined;
}

async function freshV3Project(): Promise<Ctx> {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gojaja-reset-v3-"));
  const projectRoot = path.join(baseDir, "project");
  const fakeHome = path.join(baseDir, "home", ".gojaja");
  await fsp.mkdir(projectRoot, { recursive: true });
  await fsp.mkdir(fakeHome, { recursive: true });
  const savedHome = process.env.GOJAJA_HOME;
  const savedSession = process.env.GOJAJA_SESSION;
  process.env.GOJAJA_HOME = fakeHome;
  delete process.env.GOJAJA_SESSION;
  await performInit(projectRoot, { force: true });
  return { baseDir, projectRoot, fakeHome, savedHome, savedSession };
}

async function cleanupCtx(ctx: Ctx) {
  if (ctx.savedHome === undefined) delete process.env.GOJAJA_HOME;
  else process.env.GOJAJA_HOME = ctx.savedHome;
  if (ctx.savedSession === undefined) delete process.env.GOJAJA_SESSION;
  else process.env.GOJAJA_SESSION = ctx.savedSession;
  await fsp.rm(ctx.baseDir, { recursive: true, force: true });
}

function args(flags: Record<string, string | boolean>): ParsedArgs {
  return { command: "reset", positional: [], flags };
}

function captureStdout(): { stdout: string; release: () => void } {
  const cap = { stdout: "", release: () => undefined };
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (
    c: string,
  ) => {
    cap.stdout += c;
    return true;
  };
  cap.release = () => {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  };
  return cap;
}

describe("reset on v3 projects: trash by default", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await freshV3Project(); });
  afterEach(async () => { await cleanupCtx(ctx); });

  it("preview lists both user-tree layer and central-tree-trash item", async () => {
    const cap = captureStdout();
    try {
      const code = await runReset(args({ root: ctx.projectRoot, json: true }));
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.stdout);
      expect(parsed.status).toBe("preview");
      const kinds = parsed.willRemove.map((it: { kind: string }) => it.kind);
      expect(kinds).toContain("layer-dir");
      expect(kinds).toContain("central-tree-trash");
    } finally {
      cap.release();
    }
  });

  it("--confirm moves the central tree to ~/.gojaja/trash/<id>-<ts>/", async () => {
    const cap = captureStdout();
    try {
      const code = await runReset(
        args({
          root: ctx.projectRoot,
          confirm: path.basename(ctx.projectRoot),
          // Tests use tmpdir projects (not git repos); --force
          // bypasses reset's git-state safety gate.
          force: true,
          json: true,
        }),
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.stdout);
      const trashEntry = parsed.removed.find(
        (it: { kind: string }) => it.kind === "central-tree-trash",
      );
      expect(trashEntry).toBeDefined();
      expect(trashEntry.movedTo).toContain(
        path.join(ctx.fakeHome, "trash"),
      );
      // The trash destination exists.
      expect(await exists(trashEntry.movedTo)).toBe(true);
      // The original central path is gone.
      expect(await exists(trashEntry.path)).toBe(false);
      // The user tree is also gone.
      expect(await exists(path.join(ctx.projectRoot, ".gojaja"))).toBe(false);
    } finally {
      cap.release();
    }
  });

  it("--purge hard-deletes the central tree (no trash)", async () => {
    const cap = captureStdout();
    try {
      const code = await runReset(
        args({
          root: ctx.projectRoot,
          confirm: path.basename(ctx.projectRoot),
          purge: true,
          force: true,
          json: true,
        }),
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.stdout);
      const purgeEntry = parsed.removed.find(
        (it: { kind: string }) => it.kind === "central-tree-purge",
      );
      expect(purgeEntry).toBeDefined();
      expect(purgeEntry.movedTo).toBeUndefined();
      // The trash directory was NOT created.
      expect(await exists(path.join(ctx.fakeHome, "trash"))).toBe(false);
    } finally {
      cap.release();
    }
  });

  it("v3 project with missing central tree on this machine: no centralTree entry", async () => {
    // Simulate a fresh clone on a new machine: user tree exists,
    // but ~/.gojaja/projects/<id>/ was never created here.
    await fsp.rm(path.join(ctx.fakeHome, "projects"), {
      recursive: true,
      force: true,
    });
    const cap = captureStdout();
    try {
      await runReset(args({ root: ctx.projectRoot, json: true }));
      const parsed = JSON.parse(cap.stdout);
      const kinds = parsed.willRemove.map((it: { kind: string }) => it.kind);
      expect(kinds).toContain("layer-dir");
      expect(kinds).not.toContain("central-tree-trash");
      expect(kinds).not.toContain("central-tree-purge");
    } finally {
      cap.release();
    }
  });
});
