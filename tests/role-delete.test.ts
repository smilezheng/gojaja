import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { runRole } from "../src/cli/commands/role";
import { runWorklog } from "../src/cli/commands/worklog";
import type { ParsedArgs } from "../src/cli/argv";

async function freshProject() {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-role-del-"));
  const root = path.join(projectRoot, ".multi-agent");
  const store = new LocalFsStore(root, { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  await store.createRole({
    id: "PM",
    title: "Product Manager",
    owns: ["state/project_state.md", "state/task_board.yaml"],
  });
  await store.createRole({ id: "Backend", title: "Backend Engineer" });
  return { projectRoot, root, store };
}

interface Captured { stdout: string; release: () => void }
function captureStdout(): Captured {
  const cap: Captured = { stdout: "", release: () => undefined };
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    cap.stdout += chunk;
    return true;
  };
  cap.release = () => {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  };
  return cap;
}

function args(positional: string[], flags: Record<string, string | boolean>): ParsedArgs {
  return { command: "role", positional, flags };
}

describe("Store.deleteRole", () => {
  let ctx: { projectRoot: string; root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshProject(); });
  afterEach(async () => { await fsp.rm(ctx.projectRoot, { recursive: true, force: true }); });

  it("removes config entry, role.md, session file, and emits ROLE_DELETED", async () => {
    await ctx.store.claimSession("Backend", 60);
    expect(await fsp.stat(path.join(ctx.root, "roles/Backend.md")).then(() => true)).toBe(true);
    expect(await fsp.stat(path.join(ctx.root, "comms/sessions/Backend.json")).then(() => true)).toBe(true);

    const result = await ctx.store.deleteRole({ id: "Backend", actor: "SYSTEM" });
    expect(result).toEqual({ role: "Backend", removedSessions: 1 });

    const cfg = await ctx.store.readConfig();
    expect(cfg.roles.Backend).toBeUndefined();
    await expect(fsp.stat(path.join(ctx.root, "roles/Backend.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fsp.stat(path.join(ctx.root, "comms/sessions/Backend.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const events = await ctx.store.listEventsAfter("");
    const ev = events.find((e) => e.type === "ROLE_DELETED" && e.ref === "Backend");
    expect(ev).toBeDefined();
    expect(ev!.payload).toMatchObject({ roleId: "Backend", removedSessions: 1 });
  });

  it("rejects deleting an unregistered role with USAGE", async () => {
    await expect(
      ctx.store.deleteRole({ id: "GhostRole", actor: "SYSTEM" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("returns removedSessions: 0 when no live session existed", async () => {
    // No claimSession call for PM.
    const result = await ctx.store.deleteRole({ id: "PM", actor: "SYSTEM" });
    expect(result).toEqual({ role: "PM", removedSessions: 0 });
  });

  it("leaves task_board.yaml untouched — orphan tasks survive deletion", async () => {
    const t = await ctx.store.createTask({
      title: "Build /login", owner: "Backend", actor: "PM",
    });
    await ctx.store.deleteRole({ id: "Backend", actor: "SYSTEM" });

    // Task still exists with the now-deleted role as owner. Recreating
    // a role with the same id reinherits it without further action.
    const board = await ctx.store.readTaskBoard();
    expect(board.tasks[t.id]).toBeDefined();
    expect(board.tasks[t.id].owner).toBe("Backend");

    await ctx.store.createRole({ id: "Backend", title: "Backend Engineer (new)" });
    const m = await ctx.store.openOrCreatePlan("Backend");
    expect(m.tasks.find((tk) => tk.id === t.id)).toBeDefined();
  });

  it("refuses non-SYSTEM actor with FORBIDDEN — role deletion is project-governance only", async () => {
    await expect(
      ctx.store.deleteRole({ id: "Backend", actor: "PM" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("an authenticated command using the old MA_SESSION fails after role delete", async () => {
    const s = await ctx.store.claimSession("Backend", 60);
    await ctx.store.deleteRole({ id: "Backend", actor: "SYSTEM" });

    // Simulate the agent's lingering MA_SESSION: findSessionById should
    // now return null because the session file is gone.
    const found = await ctx.store.findSessionById(s.sessionId);
    expect(found).toBeNull();

    // And driving through the CLI confirms the user-visible failure
    // mode: USAGE rather than a silent success on a phantom role.
    const originalEnv = process.env.MA_SESSION;
    process.env.MA_SESSION = s.sessionId;
    try {
      await expect(
        runWorklog({
          command: "worklog",
          positional: [],
          flags: { message: "post-delete worklog", root: ctx.projectRoot },
        }),
      ).rejects.toMatchObject({ code: "USAGE" });
    } finally {
      if (originalEnv !== undefined) process.env.MA_SESSION = originalEnv;
      else delete process.env.MA_SESSION;
    }
  });

  it("role delete concurrent with createRfc keeps config self-consistent", async () => {
    // Both go through updateConfig under config-yaml lock; one should
    // see the post-delete shape, the other the post-RFC shape, neither
    // should lose the other's mutation.
    const [, rfc] = await Promise.all([
      ctx.store.deleteRole({ id: "Backend", actor: "SYSTEM" }),
      ctx.store.createRfc({
        slug: "auth", title: "Auth", voters: [], deciders: ["PM"],
        options: [{ id: "A" }], createdBy: "SYSTEM",
      }),
    ]);
    const cfg = await ctx.store.readConfig();
    expect(cfg.roles.Backend).toBeUndefined();
    expect(cfg.rfcCounter).toBeGreaterThanOrEqual(1);
    expect(rfc.id).toBe("RFC-0001");
  });
});

describe("agentctl role delete (CLI)", () => {
  let ctx: { projectRoot: string; root: string; store: LocalFsStore };
  const originalEnv = process.env.MA_SESSION;
  beforeEach(async () => {
    ctx = await freshProject();
    delete process.env.MA_SESSION;
  });
  afterEach(async () => {
    if (originalEnv !== undefined) process.env.MA_SESSION = originalEnv;
    else delete process.env.MA_SESSION;
    await fsp.rm(ctx.projectRoot, { recursive: true, force: true });
  });

  it("succeeds and prints the orphan-task and session-cleanup hints", async () => {
    await ctx.store.claimSession("Backend", 60);
    const cap = captureStdout();
    try {
      const code = await runRole(args(["delete", "Backend"], { root: ctx.projectRoot }));
      expect(code).toBe(0);
      expect(cap.stdout).toContain("Deleted role 'Backend'");
      expect(cap.stdout).toContain("Invalidated 1 live session");
      expect(cap.stdout).toContain("Open task assignments");
    } finally { cap.release(); }
  });

  it("refuses to run when MA_SESSION is exported, with a clear hint to unset it", async () => {
    process.env.MA_SESSION = "01HXSOMESESSIONXSOMETHING1";
    const cap = captureStdout();
    try {
      await expect(
        runRole(args(["delete", "Backend"], { root: ctx.projectRoot })),
      ).rejects.toMatchObject({ code: "USAGE" });
    } finally { cap.release(); }
  });
});
