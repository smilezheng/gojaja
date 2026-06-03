import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { performInit } from "../src/cli/commands/init";
import {
  readProjectJson,
  centralRootForProject,
} from "../src/cli/central-root";
import { openStoreOrThrow } from "../src/cli/runtime";
import { exists } from "../src/core/atomic";
import { isUlid } from "../src/core/ids";
import { Paths } from "../src/core/paths";

/**
 * PR9.2 — `gojaja init` writes the v3 two-tree layout.
 *
 * After init:
 *   - `<project>/.gojaja/` contains exactly the git-tracked
 *     contracts (VERSION, project.json, config.yaml, roles/,
 *     state/project_state.md, .gitignore).
 *   - `~/.gojaja/projects/<ULID>/` contains the runtime state
 *     (state/task_board.yaml, comms/, locks/, ...).
 *   - `openStoreOrThrow` reads project.json and reconstructs the
 *     same split-mode store on subsequent invocations.
 *
 * Tests run with a fake home directory via `GOJAJA_HOME` so they
 * don't touch the developer's real `~/.gojaja/`.
 */

interface Ctx {
  baseDir: string;        // tmp dir holding both the project AND the fake home
  projectRoot: string;    // <baseDir>/project
  fakeHome: string;       // <baseDir>/home/.gojaja/   (GOJAJA_HOME)
  savedHome: string | undefined;
}

async function freshCtx(): Promise<Ctx> {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gojaja-initv3-"));
  const projectRoot = path.join(baseDir, "project");
  const fakeHome = path.join(baseDir, "home", ".gojaja");
  await fsp.mkdir(projectRoot, { recursive: true });
  await fsp.mkdir(fakeHome, { recursive: true });
  const savedHome = process.env.GOJAJA_HOME;
  process.env.GOJAJA_HOME = fakeHome;
  return { baseDir, projectRoot, fakeHome, savedHome };
}

async function cleanup(ctx: Ctx) {
  if (ctx.savedHome === undefined) delete process.env.GOJAJA_HOME;
  else process.env.GOJAJA_HOME = ctx.savedHome;
  await fsp.rm(ctx.baseDir, { recursive: true, force: true });
}

describe("performInit: v3 layout", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await freshCtx(); });
  afterEach(async () => { await cleanup(ctx); });

  it("writes a project.json with a fresh ULID and schema 3.0.0", async () => {
    const result = await performInit(ctx.projectRoot, { force: true });
    expect(result.version).toBe("3.0.0");
    expect(isUlid(result.projectId)).toBe(true);

    const project = await readProjectJson(result.layerDir);
    expect(project).not.toBeNull();
    expect(project?.id).toBe(result.projectId);
    expect(project?.name).toBe("project");
    expect(project?.schema).toBe("3.0.0");
  });

  it("mints a unique project ULID on each fresh init", async () => {
    // Same baseDir, two separate project subdirs.
    const a = path.join(ctx.baseDir, "a");
    const b = path.join(ctx.baseDir, "b");
    await fsp.mkdir(a, { recursive: true });
    await fsp.mkdir(b, { recursive: true });
    const ra = await performInit(a, { force: true });
    const rb = await performInit(b, { force: true });
    expect(ra.projectId).not.toBe(rb.projectId);
  });

  it("creates the user tree with only the v3 contracts", async () => {
    const result = await performInit(ctx.projectRoot, { force: true });
    // User tree (git-tracked) files we EXPECT.
    expect(await exists(path.join(result.layerDir, Paths.versionFile))).toBe(true);
    expect(await exists(path.join(result.layerDir, "project.json"))).toBe(true);
    expect(await exists(path.join(result.layerDir, Paths.configFile))).toBe(true);
    expect(await exists(path.join(result.layerDir, Paths.projectStateFile))).toBe(true);
    expect(await exists(path.join(result.layerDir, Paths.gitignoreFile))).toBe(true);
    expect(await exists(path.join(result.layerDir, Paths.rolesDir))).toBe(true);
    // Central-tree paths that MUST NOT be present in the user tree.
    expect(await exists(path.join(result.layerDir, Paths.taskBoardFile))).toBe(false);
    expect(await exists(path.join(result.layerDir, Paths.eventsDir))).toBe(false);
    expect(await exists(path.join(result.layerDir, Paths.sessionsDir))).toBe(false);
    expect(await exists(path.join(result.layerDir, Paths.locksDir))).toBe(false);
  });

  it("creates the central tree under GOJAJA_HOME and stocks it with runtime dirs", async () => {
    const result = await performInit(ctx.projectRoot, { force: true });
    expect(result.centralRoot).toBe(
      centralRootForProject(result.projectId),
    );
    // Central tree (per-machine, never in git) files we EXPECT.
    expect(await exists(path.join(result.centralRoot, Paths.taskBoardFile))).toBe(true);
    expect(await exists(path.join(result.centralRoot, Paths.eventsDir))).toBe(true);
    expect(await exists(path.join(result.centralRoot, Paths.sessionsDir))).toBe(true);
    expect(await exists(path.join(result.centralRoot, Paths.locksDir))).toBe(true);
    // User-tree files that MUST NOT leak into central.
    expect(await exists(path.join(result.centralRoot, "project.json"))).toBe(false);
    expect(await exists(path.join(result.centralRoot, Paths.configFile))).toBe(false);
    expect(await exists(path.join(result.centralRoot, Paths.projectStateFile))).toBe(false);
  });

  it("refuses to init twice in the same project (idempotency at the user layer)", async () => {
    await performInit(ctx.projectRoot, { force: true });
    await expect(
      performInit(ctx.projectRoot, { force: true }),
    ).rejects.toMatchObject({ code: "ALREADY_INITIALISED" });
  });

  it("openStoreOrThrow on the same project re-derives the central root from project.json", async () => {
    const initResult = await performInit(ctx.projectRoot, { force: true });
    const store = await openStoreOrThrow(ctx.projectRoot);
    expect(store.rootDescription).toContain("user=");
    expect(store.rootDescription).toContain("central=");
    expect(store.rootDescription).toContain(initResult.projectId);
    // The store must actually be functional — its operations must
    // route to the central root.
    await store.createRole({
      id: "PM",
      title: "PM",
      owns: ["state/task_board.yaml"],
      actor: "SYSTEM",
    });
    // Roles are user-tree (git tracked).
    expect(
      await exists(path.join(initResult.layerDir, "roles", "PM.md")),
    ).toBe(true);
    // A task-board write hits the central tree.
    const task = await store.createTask({
      title: "first",
      actor: "PM",
    });
    expect(task.id).toMatch(/^T-\d+$/);
    const onDiskBoard = await fsp.readFile(
      path.join(initResult.centralRoot, Paths.taskBoardFile),
      "utf8",
    );
    expect(onDiskBoard).toContain("first");
  });
});

describe("openStoreOrThrow: backward compatibility with v2 layout", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await freshCtx(); });
  afterEach(async () => { await cleanup(ctx); });

  it("opens a legacy v2 layer in single-root mode (no project.json)", async () => {
    // Hand-construct a v2 layer: write VERSION + config but no
    // project.json. This emulates a project initialised against an
    // older gojaja binary.
    const { LocalFsStore } = await import("../src/core/local-fs-store");
    const layerDir = path.join(ctx.projectRoot, ".gojaja");
    const legacyStore = new LocalFsStore(layerDir);
    await legacyStore.initialise("2.0.0-test");
    expect(await exists(path.join(layerDir, "project.json"))).toBe(false);

    const store = await openStoreOrThrow(ctx.projectRoot);
    // Single-root description matches the legacy shape (no
    // user=/central= prefix).
    expect(store.rootDescription).not.toContain("user=");
    expect(store.rootDescription).not.toContain("central=");
  });
});
