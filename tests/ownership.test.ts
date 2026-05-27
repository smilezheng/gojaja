import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";

async function freshStore() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-own-"));
  const store = new LocalFsStore(root);
  await store.initialise("2.0.0-test");
  // PM owns project goals + the entire state/ subtree.
  await store.createRole({
    id: "PM", title: "Product Manager",
    owns: ["state/project_state.md", "state/task_board.yaml"],
    mustNotEdit: ["state/architecture.md"],
  });
  await store.createRole({
    id: "TL", title: "Tech Lead",
    owns: ["state/architecture.md"],
  });
  await store.createRole({
    id: "Backend", title: "Backend Engineer",
    // No owns -- Backend can only update tasks it owns, nothing else.
  });
  return { root, store };
}

describe("Store.writeStateFile", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("allows a role to write its owned file", async () => {
    const r = await ctx.store.writeStateFile({
      actor: "PM",
      relPath: "state/project_state.md",
      content: "# Goal: launch v1\n",
    });
    expect(r.relPath).toBe("state/project_state.md");
    const back = await fsp.readFile(r.absolutePath, "utf8");
    expect(back).toBe("# Goal: launch v1\n");
  });

  it("refuses a role writing outside its owns with FORBIDDEN", async () => {
    await expect(
      ctx.store.writeStateFile({
        actor: "TL",
        relPath: "state/project_state.md",
        content: "...",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses even an owner when the path is also in mustNotEdit", async () => {
    // Add architecture.md to PM's owns to set up the conflict
    const config = await ctx.store.readConfig();
    config.roles.PM.owns.push("state/architecture.md");
    await ctx.store.writeConfig(config);
    await expect(
      ctx.store.writeStateFile({
        actor: "PM",
        relPath: "state/architecture.md",
        content: "...",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("SYSTEM bypasses the gate", async () => {
    const r = await ctx.store.writeStateFile({
      actor: "SYSTEM",
      relPath: "state/project_state.md",
      content: "from human\n",
    });
    expect(r.relPath).toBe("state/project_state.md");
  });

  it("refuses writes outside state/ subtree", async () => {
    await expect(
      ctx.store.writeStateFile({
        actor: "SYSTEM",
        relPath: "config.yaml",
        content: "...",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
    await expect(
      ctx.store.writeStateFile({
        actor: "SYSTEM",
        relPath: "comms/events/bogus.json",
        content: "...",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("refuses path-traversal", async () => {
    await expect(
      ctx.store.writeStateFile({
        actor: "SYSTEM",
        relPath: "state/../../etc/passwd",
        content: "...",
      }),
    ).rejects.toMatchObject({ code: "PATH_INVALID" });
  });

  it("a directory entry in owns covers files inside it", async () => {
    // Give Backend ownership of the whole state/ tree
    const config = await ctx.store.readConfig();
    config.roles.Backend.owns = ["state/"];
    await ctx.store.writeConfig(config);
    const r = await ctx.store.writeStateFile({
      actor: "Backend",
      relPath: "state/project_state.md",
      content: "Backend wrote this\n",
    });
    expect(r.relPath).toBe("state/project_state.md");
  });

  it("refuses unknown actor role", async () => {
    await expect(
      ctx.store.writeStateFile({
        actor: "Ghost",
        relPath: "state/project_state.md",
        content: "...",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("Task ownership enforcement", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("createTask refuses an actor without task_board ownership", async () => {
    await expect(
      ctx.store.createTask({
        title: "leak", owner: "Backend", actor: "Backend",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("createTask allows the owning role (PM)", async () => {
    const t = await ctx.store.createTask({
      title: "ok", owner: "Backend", actor: "PM",
    });
    expect(t.id).toBe("T-0001");
  });

  it("createTask SYSTEM bypass works for bootstrap", async () => {
    const t = await ctx.store.createTask({
      title: "bootstrap", owner: null, actor: "SYSTEM",
    });
    expect(t.id).toBe("T-0001");
  });

  it("assignTask refuses non-owning actor", async () => {
    const t = await ctx.store.createTask({
      title: "x", owner: "Backend", actor: "PM",
    });
    await expect(
      ctx.store.assignTask({
        taskId: t.id, newOwner: "TL", actor: "Backend",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("setTaskStatus allowed by task owner exception (Backend on its own task)", async () => {
    const t = await ctx.store.createTask({
      title: "x", owner: "Backend", actor: "PM",
    });
    // Backend does not own state/task_board.yaml, but IS the task's owner.
    const updated = await ctx.store.setTaskStatus({
      taskId: t.id, newStatus: "InProgress", actor: "Backend",
    });
    expect(updated.status).toBe("InProgress");
  });

  it("setTaskStatus refuses unrelated role even for status-only change", async () => {
    const t = await ctx.store.createTask({
      title: "x", owner: "Backend", actor: "PM",
    });
    await expect(
      ctx.store.setTaskStatus({
        taskId: t.id, newStatus: "Review", actor: "TL",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
