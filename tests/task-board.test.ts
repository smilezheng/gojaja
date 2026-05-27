import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";

async function freshStore() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-task-"));
  const store = new LocalFsStore(root);
  await store.initialise("2.0.0-test");
  // PM owns the task board; Backend/QA do not, but they are still able to
  // update their own task's status thanks to the task-owner exception.
  await store.createRole({
    id: "PM", title: "Product Manager",
    owns: ["state/task_board.yaml"],
  });
  await store.createRole({ id: "Backend", title: "Backend Engineer" });
  await store.createRole({ id: "QA", title: "Quality Assurance" });
  return { root, store };
}

describe("Store.createTask", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("assigns sequential T-NNNN ids starting from T-0001", async () => {
    const a = await ctx.store.createTask({ title: "first", actor: "PM" });
    const b = await ctx.store.createTask({ title: "second", actor: "PM" });
    const c = await ctx.store.createTask({ title: "third", actor: "PM" });
    expect(a.id).toBe("T-0001");
    expect(b.id).toBe("T-0002");
    expect(c.id).toBe("T-0003");
  });

  it("emits TASK_CREATED broadcast and TASK_ASSIGNED when an owner is given", async () => {
    await ctx.store.createTask({
      title: "build login",
      owner: "Backend",
      priority: "P1",
      actor: "PM",
    });
    const events = await ctx.store.listEventsAfter("");
    const created = events.find((e) => e.type === "TASK_CREATED");
    const assigned = events.find((e) => e.type === "TASK_ASSIGNED");
    expect(created?.from).toBe("PM");
    expect(created?.to).toBe("*");
    expect(created?.payload.taskId).toBe("T-0001");
    expect(assigned?.to).toBe("Backend");
    expect(assigned?.payload.newOwner).toBe("Backend");
    expect(assigned?.payload.previousOwner).toBeNull();
  });

  it("does NOT emit TASK_ASSIGNED for an unassigned task", async () => {
    await ctx.store.createTask({ title: "to triage", actor: "PM" });
    const events = await ctx.store.listEventsAfter("");
    expect(events.some((e) => e.type === "TASK_ASSIGNED")).toBe(false);
  });

  it("rejects empty titles", async () => {
    await expect(
      ctx.store.createTask({ title: "   ", actor: "PM" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("validates owner role id", async () => {
    await expect(
      ctx.store.createTask({ title: "x", owner: "../etc", actor: "PM" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("serialises concurrent creates; ids remain unique and contiguous", async () => {
    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        ctx.store.createTask({ title: `t-${i}`, actor: "PM" }),
      ),
    );
    const ids = new Set(results.map((t) => t.id));
    expect(ids.size).toBe(N);
    const board = await ctx.store.readTaskBoard();
    expect(board.nextId).toBe(N);
  });
});

describe("Store.assignTask / setTaskStatus", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("assigning a different owner emits TASK_ASSIGNED with previousOwner", async () => {
    const t = await ctx.store.createTask({
      title: "x", owner: "Backend", actor: "PM",
    });
    const seenBefore = (await ctx.store.listEventsAfter("")).length;
    await ctx.store.assignTask({ taskId: t.id, newOwner: "QA", actor: "PM" });
    const events = (await ctx.store.listEventsAfter("")).slice(seenBefore);
    const assigned = events.find((e) => e.type === "TASK_ASSIGNED");
    expect(assigned?.payload.previousOwner).toBe("Backend");
    expect(assigned?.payload.newOwner).toBe("QA");
  });

  it("assigning to the same owner is a no-op and emits no event", async () => {
    const t = await ctx.store.createTask({ title: "x", owner: "Backend", actor: "PM" });
    const before = (await ctx.store.listEventsAfter("")).length;
    await ctx.store.assignTask({ taskId: t.id, newOwner: "Backend", actor: "PM" });
    const after = (await ctx.store.listEventsAfter("")).length;
    expect(after).toBe(before);
  });

  it("setTaskStatus emits TASK_STATUS_CHANGED and updates the board", async () => {
    const t = await ctx.store.createTask({ title: "x", owner: "Backend", actor: "PM" });
    await ctx.store.setTaskStatus({ taskId: t.id, newStatus: "InProgress", actor: "Backend" });
    const updated = await ctx.store.readTask(t.id);
    expect(updated.status).toBe("InProgress");
    const events = await ctx.store.listEventsAfter("");
    const change = events.find((e) => e.type === "TASK_STATUS_CHANGED");
    expect(change?.payload.previousStatus).toBe("Backlog");
    expect(change?.payload.newStatus).toBe("InProgress");
  });

  it("rejects unknown status strings", async () => {
    const t = await ctx.store.createTask({ title: "x", actor: "PM" });
    await expect(
      // @ts-expect-error testing runtime validation
      ctx.store.setTaskStatus({ taskId: t.id, newStatus: "Bogus", actor: "PM" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("rejects unknown task ids", async () => {
    await expect(
      ctx.store.setTaskStatus({ taskId: "T-9999", newStatus: "Ready", actor: "PM" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });
});

describe("Manifest.tasks", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("includes only tasks owned by the role with an ACTIVE status", async () => {
    // Two for Backend, one for QA. Vary statuses.
    const t1 = await ctx.store.createTask({ title: "BE Ready", owner: "Backend", priority: "P1", actor: "PM" });
    const t2 = await ctx.store.createTask({ title: "BE Backlog", owner: "Backend", priority: "P2", actor: "PM" });
    const t3 = await ctx.store.createTask({ title: "QA later", owner: "QA", priority: "P2", actor: "PM" });
    const t4 = await ctx.store.createTask({ title: "BE Done", owner: "Backend", priority: "P3", actor: "PM" });
    await ctx.store.setTaskStatus({ taskId: t1.id, newStatus: "Ready", actor: "PM" });
    await ctx.store.setTaskStatus({ taskId: t4.id, newStatus: "Done", actor: "PM" });
    // t2 stays Backlog; t3 stays Backlog.

    const m = await ctx.store.openOrCreatePlan("Backend");
    const ids = m.tasks.map((t) => t.id).sort();
    expect(ids).toEqual([t1.id]); // only Ready Backend task
    const summary = m.tasks[0];
    expect(summary.title).toBe("BE Ready");
    expect(summary.priority).toBe("P1");
    expect(summary.blockedBy).toEqual([]);
  });

  it("computes blockedBy from dependsOn entries that are not Done", async () => {
    const dep = await ctx.store.createTask({ title: "dep", owner: "Backend", actor: "PM" });
    const blocked = await ctx.store.createTask({
      title: "blocked",
      owner: "Backend",
      dependsOn: [dep.id],
      actor: "PM",
    });
    await ctx.store.setTaskStatus({ taskId: blocked.id, newStatus: "Ready", actor: "PM" });
    let m = await ctx.store.openOrCreatePlan("Backend");
    let summary = m.tasks.find((t) => t.id === blocked.id);
    expect(summary?.blockedBy).toEqual([dep.id]);

    await ctx.store.setTaskStatus({ taskId: dep.id, newStatus: "Done", actor: "PM" });
    // New plan must be a fresh manifest (current one is still pending). Ack first.
    await ctx.store.ackManifest("Backend", m.ackToken);
    m = await ctx.store.openOrCreatePlan("Backend");
    summary = m.tasks.find((t) => t.id === blocked.id);
    expect(summary?.blockedBy).toEqual([]);
  });

  it("the assigned role sees the TASK_ASSIGNED event in its next plan", async () => {
    await ctx.store.createTask({ title: "x", owner: "Backend", actor: "PM" });
    const m = await ctx.store.openOrCreatePlan("Backend");
    const types = m.events.map((e) => e.type);
    expect(types).toContain("TASK_ASSIGNED");
    expect(types).toContain("TASK_CREATED"); // broadcast also visible
  });
});
