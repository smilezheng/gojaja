import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { exists } from "../src/core/atomic";
import { Paths } from "../src/core/paths";

/**
 * Integration tests for the v3 split-mode `LocalFsStore` (RFC-0001 §2.6).
 *
 * Boots a store with `userRoot !== centralRoot`, exercises a few
 * representative operations through the public Store API, and asserts
 * that each file landed on the correct physical tree. The classifier
 * unit tests in `path-routing.test.ts` cover the routing table itself;
 * this file proves that `abs()` actually consults it under live writes.
 */

interface Ctx {
  userRoot: string;
  centralRoot: string;
  store: LocalFsStore;
  cleanup: () => Promise<void>;
}

async function freshSplit(): Promise<Ctx> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "gojaja-split-"));
  const userRoot = path.join(base, "project", ".gojaja");
  const centralRoot = path.join(base, "central", "projects", "01JZ9X7T", "");
  await fsp.mkdir(path.dirname(userRoot), { recursive: true });
  await fsp.mkdir(centralRoot, { recursive: true });
  const store = new LocalFsStore(userRoot, {
    centralRoot,
    safetyMarginMs: 0,
  });
  await store.initialise("3.0.0-test");
  return {
    userRoot,
    centralRoot,
    store,
    cleanup: () => fsp.rm(base, { recursive: true, force: true }),
  };
}

describe("LocalFsStore split mode: initialise", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await freshSplit(); });
  afterEach(async () => { await ctx.cleanup(); });

  it("writes VERSION to the user tree (git-tracked schema marker)", async () => {
    const userVersion = path.join(ctx.userRoot, Paths.versionFile);
    const centralVersion = path.join(ctx.centralRoot, Paths.versionFile);
    expect(await exists(userVersion)).toBe(true);
    expect(await exists(centralVersion)).toBe(false);
  });

  it("writes config.yaml to the user tree (ownership contract)", async () => {
    const userConfig = path.join(ctx.userRoot, Paths.configFile);
    const centralConfig = path.join(ctx.centralRoot, Paths.configFile);
    expect(await exists(userConfig)).toBe(true);
    expect(await exists(centralConfig)).toBe(false);
  });

  it("writes state/project_state.md to the user tree (human-authored)", async () => {
    const userPsm = path.join(ctx.userRoot, Paths.projectStateFile);
    const centralPsm = path.join(ctx.centralRoot, Paths.projectStateFile);
    expect(await exists(userPsm)).toBe(true);
    expect(await exists(centralPsm)).toBe(false);
  });

  it("writes state/task_board.yaml to the central tree (mutable runtime)", async () => {
    const userTb = path.join(ctx.userRoot, Paths.taskBoardFile);
    const centralTb = path.join(ctx.centralRoot, Paths.taskBoardFile);
    expect(await exists(userTb)).toBe(false);
    expect(await exists(centralTb)).toBe(true);
  });

  it("creates the roles/ dir on the user tree only", async () => {
    expect(await exists(path.join(ctx.userRoot, Paths.rolesDir))).toBe(true);
    expect(await exists(path.join(ctx.centralRoot, Paths.rolesDir))).toBe(
      false,
    );
  });

  it("creates the comms/ subtree on the central tree only", async () => {
    expect(await exists(path.join(ctx.centralRoot, Paths.eventsDir))).toBe(
      true,
    );
    expect(await exists(path.join(ctx.centralRoot, Paths.sessionsDir))).toBe(
      true,
    );
    expect(await exists(path.join(ctx.userRoot, Paths.eventsDir))).toBe(false);
    expect(await exists(path.join(ctx.userRoot, Paths.sessionsDir))).toBe(
      false,
    );
  });

  it("creates locks/ on the central tree only", async () => {
    expect(await exists(path.join(ctx.centralRoot, Paths.locksDir))).toBe(true);
    expect(await exists(path.join(ctx.userRoot, Paths.locksDir))).toBe(false);
  });

  it("writes .gitignore to the user tree (next to the layer code)", async () => {
    expect(await exists(path.join(ctx.userRoot, Paths.gitignoreFile))).toBe(
      true,
    );
    expect(await exists(path.join(ctx.centralRoot, Paths.gitignoreFile))).toBe(
      false,
    );
  });
});

describe("LocalFsStore split mode: live writes through the public API", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await freshSplit(); });
  afterEach(async () => { await ctx.cleanup(); });

  it("createRole writes the role markdown to the user tree", async () => {
    await ctx.store.createRole({
      id: "PM",
      title: "Product Manager",
      owns: ["state/project_state.md"],
    });
    const userRoleMd = path.join(ctx.userRoot, "roles", "PM.md");
    const centralRoleMd = path.join(ctx.centralRoot, "roles", "PM.md");
    expect(await exists(userRoleMd)).toBe(true);
    expect(await exists(centralRoleMd)).toBe(false);
  });

  it("createRole updates config.yaml on the user tree", async () => {
    const before = await fsp.readFile(
      path.join(ctx.userRoot, Paths.configFile),
      "utf8",
    );
    await ctx.store.createRole({
      id: "PM",
      title: "Product Manager",
      owns: ["state/project_state.md"],
    });
    const after = await fsp.readFile(
      path.join(ctx.userRoot, Paths.configFile),
      "utf8",
    );
    expect(after).not.toBe(before);
    expect(after).toContain("PM");
  });

  it("createTask writes events to central and updates task_board on central", async () => {
    // PM owns task_board.yaml for task creation gating.
    await ctx.store.createRole({
      id: "PM",
      title: "Product Manager",
      owns: ["state/task_board.yaml"],
    });
    const task = await ctx.store.createTask({
      title: "Hello",
      actor: "PM",
    });
    expect(task.id).toMatch(/^T-\d+$/);

    // events: central only.
    const userEvents = path.join(ctx.userRoot, Paths.eventsDir);
    const centralEvents = path.join(ctx.centralRoot, Paths.eventsDir);
    const userEvCount = await dirEntryCount(userEvents);
    const centralEvCount = await dirEntryCount(centralEvents);
    expect(userEvCount).toBe(0);
    expect(centralEvCount).toBeGreaterThan(0);

    // task_board.yaml: central only.
    const userTb = path.join(ctx.userRoot, Paths.taskBoardFile);
    const centralTb = path.join(ctx.centralRoot, Paths.taskBoardFile);
    expect(await exists(userTb)).toBe(false);
    expect(await exists(centralTb)).toBe(true);
  });

  it("publishWorklog writes the markdown copy to central worklog/", async () => {
    await ctx.store.createRole({ id: "PM", title: "PM" });
    await ctx.store.claimSession("PM", 60);
    const ev = await ctx.store.publishWorklog({ from: "PM", message: "hi" });
    const userWlEntry = path.join(ctx.userRoot, "worklog", "PM", `${ev.id}.md`);
    const centralWlEntry = path.join(
      ctx.centralRoot,
      "worklog",
      "PM",
      `${ev.id}.md`,
    );
    expect(await exists(userWlEntry)).toBe(false);
    expect(await exists(centralWlEntry)).toBe(true);
  });

  it("sessions / cursors / pending all live in central", async () => {
    await ctx.store.createRole({ id: "PM", title: "PM" });
    await ctx.store.claimSession("PM", 60);
    const userSession = path.join(ctx.userRoot, "comms", "sessions", "PM.json");
    const centralSession = path.join(
      ctx.centralRoot,
      "comms",
      "sessions",
      "PM.json",
    );
    expect(await exists(userSession)).toBe(false);
    expect(await exists(centralSession)).toBe(true);
  });
});

describe("LocalFsStore split mode: rootDescription", () => {
  it("collapses to a single path in single-root mode (backward compat)", () => {
    const s = new LocalFsStore("/tmp/example/.gojaja");
    expect(s.rootDescription).toBe(path.resolve("/tmp/example/.gojaja"));
  });

  it("describes both roots in split mode for diagnostic clarity", () => {
    const s = new LocalFsStore("/tmp/example/.gojaja", {
      centralRoot: "/Users/x/.gojaja/projects/01JZ9X",
    });
    expect(s.rootDescription).toContain("user=");
    expect(s.rootDescription).toContain("central=");
  });
});

async function dirEntryCount(dir: string): Promise<number> {
  try {
    const entries = await fsp.readdir(dir);
    return entries.length;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return 0;
    throw err;
  }
}
