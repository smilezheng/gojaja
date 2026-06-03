import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import {
  inspectMigrate,
  planMigrate,
  performMigrate,
  MigrateNoLayerError,
  MigrateAlreadyV3Error,
} from "../src/cli/migrate";
import {
  readProjectJson,
  centralRootForProject,
} from "../src/cli/central-root";
import { openStoreOrThrow } from "../src/cli/runtime";
import { exists } from "../src/core/atomic";
import { isUlid } from "../src/core/ids";
import { Paths } from "../src/core/paths";

/**
 * PR9.3 — `gojaja migrate` walker tests.
 *
 * Setup: each test creates a temporary v2 layer (a `LocalFsStore`
 * initialised with `"2.0.0-test"` and no `centralRoot`). The
 * migrator then promotes it to v3 by:
 *   - minting a ULID,
 *   - copying `classifyPath === "central"` files to
 *     `~/.gojaja/projects/<ULID>/...`,
 *   - writing `<project>/.gojaja/project.json`,
 *   - bumping VERSION.
 *
 * Tests live under `GOJAJA_HOME=<baseDir>/home/.gojaja` so they
 * don't touch the developer's real home dir.
 */

interface Ctx {
  baseDir: string;
  projectRoot: string;
  layerDir: string;
  store: LocalFsStore;
  fakeHome: string;
  savedHome: string | undefined;
}

async function freshV2Layer(): Promise<Ctx> {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gojaja-migrate-"));
  const projectRoot = path.join(baseDir, "project");
  const layerDir = path.join(projectRoot, ".gojaja");
  const fakeHome = path.join(baseDir, "home", ".gojaja");
  await fsp.mkdir(projectRoot, { recursive: true });
  await fsp.mkdir(fakeHome, { recursive: true });
  const savedHome = process.env.GOJAJA_HOME;
  process.env.GOJAJA_HOME = fakeHome;

  // Construct a v2 layer (single-root) and populate with realistic
  // runtime content the walker needs to migrate.
  const store = new LocalFsStore(layerDir, { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  await store.createRole({
    id: "PM",
    title: "PM",
    owns: ["state/task_board.yaml", "state/project_state.md"],
  });
  await store.createRole({ id: "Backend", title: "Backend" });
  await store.claimSession("PM", 60);
  const task = await store.createTask({
    title: "first",
    owner: "Backend",
    actor: "PM",
  });
  await store.publishWorklog({ from: "PM", message: "hello" });
  // An RFC for completeness.
  await store.createRfc({
    slug: "ctx",
    title: "ctx",
    voters: [],
    deciders: ["PM"],
    options: [],
    createdBy: "PM",
    description: "x",
    relatedTasks: [task.id],
  });

  return { baseDir, projectRoot, layerDir, store, fakeHome, savedHome };
}

async function cleanup(ctx: Ctx) {
  if (ctx.savedHome === undefined) delete process.env.GOJAJA_HOME;
  else process.env.GOJAJA_HOME = ctx.savedHome;
  await fsp.rm(ctx.baseDir, { recursive: true, force: true });
}

describe("inspectMigrate: state detection", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await freshV2Layer(); });
  afterEach(async () => { await cleanup(ctx); });

  it("identifies a v2 layer as ready to migrate", async () => {
    const insp = await inspectMigrate(ctx.projectRoot);
    expect(insp.hasLayer).toBe(true);
    expect(insp.version).toBe("2.0.0-test");
    expect(insp.project).toBeNull();
    expect(insp.action.kind).toBe("ready");
    if (insp.action.kind === "ready") {
      expect(isUlid(insp.action.projectId)).toBe(true);
      expect(insp.action.fromVersion).toBe("2.0.0-test");
    }
  });

  it("identifies an absent layer as no-layer", async () => {
    const empty = await fsp.mkdtemp(path.join(os.tmpdir(), "gojaja-empty-"));
    try {
      const insp = await inspectMigrate(empty);
      expect(insp.hasLayer).toBe(false);
      expect(insp.action.kind).toBe("no-layer");
    } finally {
      await fsp.rm(empty, { recursive: true, force: true });
    }
  });

  it("identifies an already-migrated layer", async () => {
    await performMigrate(ctx.projectRoot);
    const insp = await inspectMigrate(ctx.projectRoot);
    expect(insp.project).not.toBeNull();
    expect(insp.action.kind).toBe("already-v3");
  });
});

describe("planMigrate: dry-run", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await freshV2Layer(); });
  afterEach(async () => { await cleanup(ctx); });

  it("plans only central-classified files for copying", async () => {
    const insp = await inspectMigrate(ctx.projectRoot);
    const plan = await planMigrate(insp);
    // Plan must include the task_board, at least one event, at
    // least one session file, and the rfc proposal — all central.
    const paths = plan.copies.map((c) => c.relPath);
    expect(paths).toContain(Paths.taskBoardFile);
    expect(paths.some((p) => p.startsWith("comms/events/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("comms/sessions/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("rfcs/"))).toBe(true);
    // Plan must NOT include user-tree contracts.
    expect(paths).not.toContain(Paths.configFile);
    expect(paths).not.toContain(Paths.projectStateFile);
    expect(paths.some((p) => p.startsWith("roles/"))).toBe(false);
    expect(paths).not.toContain("project.json");
    expect(paths).not.toContain(Paths.versionFile);
  });
});

describe("performMigrate: execution", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await freshV2Layer(); });
  afterEach(async () => { await cleanup(ctx); });

  it("copies central-classified files to ~/.gojaja/projects/<id>/", async () => {
    const result = await performMigrate(ctx.projectRoot);
    expect(isUlid(result.projectId)).toBe(true);
    expect(result.centralRoot).toBe(centralRootForProject(result.projectId));
    expect(result.copied).toBeGreaterThan(0);

    // task_board.yaml landed in central.
    const centralTb = path.join(result.centralRoot, Paths.taskBoardFile);
    expect(await exists(centralTb)).toBe(true);
    const centralTbBody = await fsp.readFile(centralTb, "utf8");
    expect(centralTbBody).toContain("first");
  });

  it("writes project.json with the new ULID and bumps VERSION to 3.0.0", async () => {
    const result = await performMigrate(ctx.projectRoot);
    const project = await readProjectJson(result.layerDir);
    expect(project?.id).toBe(result.projectId);
    expect(project?.schema).toBe("3.0.0");
    const versionTxt = await fsp.readFile(
      path.join(result.layerDir, Paths.versionFile),
      "utf8",
    );
    expect(versionTxt.trim()).toBe("3.0.0");
  });

  it("leaves the user-tree v2 source files alone by default (safety net)", async () => {
    const result = await performMigrate(ctx.projectRoot);
    // The pre-migration task_board copy lives in the user tree
    // until --cleanup runs.
    const userTb = path.join(result.layerDir, Paths.taskBoardFile);
    expect(await exists(userTb)).toBe(true);
  });

  it("--cleanup removes the central-classified files from the user tree", async () => {
    const result = await performMigrate(ctx.projectRoot, { cleanup: true });
    expect(result.cleanedUp).toBeGreaterThan(0);
    const userTb = path.join(result.layerDir, Paths.taskBoardFile);
    expect(await exists(userTb)).toBe(false);
    // User-tree contracts MUST still be there.
    expect(await exists(path.join(result.layerDir, Paths.configFile))).toBe(true);
    expect(await exists(path.join(result.layerDir, "project.json"))).toBe(true);
  });

  it("is idempotent: re-running without cleanup throws ALREADY_V3", async () => {
    await performMigrate(ctx.projectRoot);
    await expect(performMigrate(ctx.projectRoot)).rejects.toBeInstanceOf(
      MigrateAlreadyV3Error,
    );
  });

  it("re-running --cleanup on an already-migrated layer is a no-op cleanup pass", async () => {
    const first = await performMigrate(ctx.projectRoot, { cleanup: true });
    const again = await performMigrate(ctx.projectRoot, { cleanup: true });
    // Already cleaned → second cleanup finds nothing to remove.
    expect(again.copied).toBe(0);
    expect(again.cleanedUp).toBe(0);
    expect(again.projectId).toBe(first.projectId);
  });

  it("throws MIGRATE_NO_LAYER on an empty project", async () => {
    const empty = await fsp.mkdtemp(path.join(os.tmpdir(), "gojaja-empty-"));
    try {
      await expect(performMigrate(empty)).rejects.toBeInstanceOf(
        MigrateNoLayerError,
      );
    } finally {
      await fsp.rm(empty, { recursive: true, force: true });
    }
  });

  it("end-to-end: migrated layer opens via openStoreOrThrow as v3 split-mode", async () => {
    const result = await performMigrate(ctx.projectRoot, { cleanup: true });
    const store = await openStoreOrThrow(ctx.projectRoot);
    expect(store.rootDescription).toContain("user=");
    expect(store.rootDescription).toContain("central=");
    // Read back the task that originally lived in the v2 store.
    const board = await store.readTaskBoard();
    const titles = Object.values(board.tasks).map((t) => t.title);
    expect(titles).toContain("first");
    // Events survive too.
    const events = await store.listEventsAfter("");
    expect(events.some((e) => e.type === "WORKLOG")).toBe(true);
    expect(events.some((e) => e.type === "TASK_CREATED")).toBe(true);
    expect(result.toVersion).toBe("3.0.0");
  });
});
