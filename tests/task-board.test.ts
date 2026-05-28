import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";

async function freshStore() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-task-"));
  const store = new LocalFsStore(root, { safetyMarginMs: 0 });
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

  it("Step 5b: createTask with --owner defaults status to Ready", async () => {
    // The whole point: PM creates and assigns; the owner must see the
    // task in their next plan, which filters Backlog out. So new tasks
    // with an owner start in Ready.
    const t = await ctx.store.createTask({
      title: "Build login", owner: "Backend", actor: "PM",
    });
    expect(t.status).toBe("Ready");
  });

  it("Step 5b: createTask without --owner defaults status to Backlog", async () => {
    const t = await ctx.store.createTask({
      title: "Triage idea", actor: "PM",
    });
    expect(t.status).toBe("Backlog");
    expect(t.owner).toBeNull();
  });

  it("Step 12: createTask refuses an owner that is not registered (USAGE — likely a typo)", async () => {
    // PM types `--owner Forntend` instead of `Frontend`. Without the
    // gate, the TASK_ASSIGNED event goes to a role no manifest will
    // ever surface. Refuse loudly with a hint about role list/create.
    await expect(
      ctx.store.createTask({
        title: "Build login", owner: "Forntend", actor: "PM",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("Step 12: assignTask refuses --to that is not a registered role", async () => {
    const t = await ctx.store.createTask({
      title: "x", owner: "Backend", actor: "PM",
    });
    await expect(
      ctx.store.assignTask({
        taskId: t.id, newOwner: "Forntend", actor: "PM",
      }),
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
    // Step 5b: createTask with an owner defaults to Ready, not Backlog.
    expect(change?.payload.previousStatus).toBe("Ready");
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
    // Step 5b: tasks with an owner default to Ready, so to land in
    // Backlog we explicitly push them back.
    const t1 = await ctx.store.createTask({ title: "BE Ready", owner: "Backend", priority: "P1", actor: "PM" });
    const t2 = await ctx.store.createTask({ title: "BE Backlog", owner: "Backend", priority: "P2", actor: "PM" });
    const t3 = await ctx.store.createTask({ title: "QA later", owner: "QA", priority: "P2", actor: "PM" });
    const t4 = await ctx.store.createTask({ title: "BE Done", owner: "Backend", priority: "P3", actor: "PM" });
    // t1 created Ready by default — no setTaskStatus needed.
    await ctx.store.setTaskStatus({ taskId: t2.id, newStatus: "Backlog", actor: "PM" });
    await ctx.store.setTaskStatus({ taskId: t3.id, newStatus: "Backlog", actor: "PM" });
    await ctx.store.setTaskStatus({ taskId: t4.id, newStatus: "Done", actor: "PM" });

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

  it("the assigned role sees TASK_ASSIGNED but NOT the TASK_CREATED broadcast (PR8n)", async () => {
    // PR8n manifest filtering: TASK_ASSIGNED is directed, so Backend
    // sees it. TASK_CREATED is broadcast and now only lands in the
    // manifests of roles that own state/task_board.yaml (the triage
    // set). Backend is not in that set, so the broadcast is hidden.
    // The event itself still exists on disk for audit / doctor.
    await ctx.store.createTask({ title: "x", owner: "Backend", actor: "PM" });
    const m = await ctx.store.openOrCreatePlan("Backend");
    const types = m.events.map((e) => e.type);
    expect(types).toContain("TASK_ASSIGNED");
    expect(types).not.toContain("TASK_CREATED");
    // The event still exists in the global stream.
    const allEvents = await ctx.store.listEventsAfter("");
    expect(allEvents.some((e) => e.type === "TASK_CREATED")).toBe(true);
  });

  it("task-board owners see TASK_CREATED in their manifest (PR8n: triage signal)", async () => {
    // PM owns state/task_board.yaml in freshStore, so PM is the
    // triage role. PM herself created this task and is filtered by
    // `from === role`; we use a SYSTEM-created task to confirm the
    // visibility path independently.
    await ctx.store.createTask({ title: "Triage me", actor: "SYSTEM" });
    const m = await ctx.store.openOrCreatePlan("PM");
    const types = m.events.map((e) => e.type);
    expect(types).toContain("TASK_CREATED");
  });
});

// ---------- PR8j: parent / assets / deliverables / assignedBy / tags ----------

/**
 * PR8j fixture: tempdir is the PROJECT root; `.multi-agent/` lives at
 * `<project>/.multi-agent/`. This lets deliverable file refs (relative
 * paths like `docs/x.md`) be controlled by the test.
 */
async function freshProjectStore() {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-pj-"));
  const layerRoot = path.join(projectRoot, ".multi-agent");
  const store = new LocalFsStore(layerRoot, { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  await store.createRole({
    id: "PM", title: "Product Manager",
    owns: ["state/task_board.yaml"],
  });
  await store.createRole({ id: "Frontend", title: "Frontend Engineer" });
  return { projectRoot, layerRoot, store };
}

async function touch(filePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, "");
}

describe("PR8j: task model expansion", () => {
  let ctx: { projectRoot: string; layerRoot: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshProjectStore(); });
  afterEach(async () => {
    await fsp.rm(ctx.projectRoot, { recursive: true, force: true });
  });

  it("createTask records assignedBy from actor", async () => {
    const t = await ctx.store.createTask({
      title: "thing", owner: "Frontend", actor: "PM",
    });
    expect(t.assignedBy).toBe("PM");
    expect(t.parent).toBeNull();
    expect(t.assets).toEqual([]);
    expect(t.deliverables).toEqual([]);
    expect(t.tags).toEqual([]);
  });

  it("assignTask does NOT change assignedBy (it records the original creator)", async () => {
    const t = await ctx.store.createTask({ title: "x", owner: "Frontend", actor: "PM" });
    expect(t.assignedBy).toBe("PM");
    // Add another role so we can reassign.
    await ctx.store.createRole({ id: "Backend", title: "Backend" });
    await ctx.store.assignTask({ taskId: t.id, newOwner: "Backend", actor: "PM" });
    const after = await ctx.store.readTask(t.id);
    expect(after.assignedBy).toBe("PM");
    expect(after.owner).toBe("Backend");
  });

  it("createTask --parent succeeds when parent exists", async () => {
    const epic = await ctx.store.createTask({ title: "Epic", owner: "PM", actor: "PM" });
    const sub = await ctx.store.createTask({
      title: "Sub", owner: "Frontend", parent: epic.id, actor: "PM",
    });
    expect(sub.parent).toBe(epic.id);
  });

  it("createTask --parent refuses unknown parent", async () => {
    await expect(
      ctx.store.createTask({ title: "x", parent: "T-9999", actor: "PM" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("createTask refuses chain longer than MAX_TASK_DEPTH=5", async () => {
    // Build chain: t1 -> t2 -> t3 -> t4 -> t5 (depth 5). t6 must refuse.
    let prev: string | null = null;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await ctx.store.createTask({
        title: `level ${i}`, owner: "PM", parent: prev, actor: "PM",
      });
      ids.push(t.id);
      prev = t.id;
    }
    await expect(
      ctx.store.createTask({ title: "too deep", parent: ids[4], actor: "PM" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("readTaskBoard detects a hand-edited parent cycle and refuses", async () => {
    const a = await ctx.store.createTask({ title: "A", owner: "PM", actor: "PM" });
    const b = await ctx.store.createTask({ title: "B", owner: "PM", parent: a.id, actor: "PM" });
    // Hand-edit yaml: set a.parent = b.id (creates cycle a -> b -> a).
    const boardPath = path.join(ctx.layerRoot, "state", "task_board.yaml");
    const text = await fsp.readFile(boardPath, "utf8");
    const board = yaml.load(text) as { tasks: Record<string, { parent: string | null }> };
    board.tasks[a.id].parent = b.id;
    await fsp.writeFile(boardPath, yaml.dump(board));
    await expect(ctx.store.readTaskBoard()).rejects.toMatchObject({
      code: "STATE_CORRUPT",
    });
  });

  it("createTask validates assets and refuses .. escape", async () => {
    await expect(
      ctx.store.createTask({
        title: "x", actor: "PM",
        assets: [{ kind: "file", ref: "../../../etc/passwd", description: "" }],
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("createTask refuses deliverable file ref that points inside .multi-agent/", async () => {
    await expect(
      ctx.store.createTask({
        title: "x", actor: "PM",
        deliverables: [
          { kind: "file", ref: ".multi-agent/state/secret.md", description: "" },
        ],
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("setTaskStatus Done refuses when a file deliverable is missing", async () => {
    const t = await ctx.store.createTask({
      title: "x", owner: "Frontend", actor: "PM",
      deliverables: [{ kind: "file", ref: "docs/spec.md", description: "Final spec" }],
    });
    // Move through the lifecycle but keep the file absent.
    await ctx.store.setTaskStatus({ taskId: t.id, newStatus: "InProgress", actor: "Frontend" });
    await expect(
      ctx.store.setTaskStatus({ taskId: t.id, newStatus: "Done", actor: "Frontend" }),
    ).rejects.toMatchObject({ code: "USAGE" });
    // Touch the file; now Done succeeds.
    await touch(path.join(ctx.projectRoot, "docs", "spec.md"));
    const done = await ctx.store.setTaskStatus({
      taskId: t.id, newStatus: "Done", actor: "Frontend",
    });
    expect(done.status).toBe("Done");
  });

  it("setTaskStatus Done with --force-incomplete emits TASK_DELIVERABLE_BYPASSED before status change", async () => {
    const t = await ctx.store.createTask({
      title: "x", owner: "Frontend", actor: "PM",
      deliverables: [
        { kind: "file", ref: "docs/spec.md", description: "" },
        { kind: "file", ref: "docs/api.md", description: "" },
      ],
    });
    const before = (await ctx.store.listEventsAfter("")).length;
    await ctx.store.setTaskStatus({
      taskId: t.id, newStatus: "Done", actor: "Frontend", forceIncomplete: true,
    });
    const newEvents = (await ctx.store.listEventsAfter("")).slice(before);
    const bypass = newEvents.find((e) => e.type === "TASK_DELIVERABLE_BYPASSED");
    const change = newEvents.find((e) => e.type === "TASK_STATUS_CHANGED");
    expect(bypass).toBeDefined();
    expect(change).toBeDefined();
    // bypass must come BEFORE the status change in the event stream.
    expect(newEvents.indexOf(bypass!)).toBeLessThan(newEvents.indexOf(change!));
    expect(bypass!.payload.taskId).toBe(t.id);
    expect((bypass!.payload as { missing: string[] }).missing.sort()).toEqual(
      ["docs/api.md", "docs/spec.md"],
    );
    expect(bypass!.payload.by).toBe("Frontend");
  });

  it("forceIncomplete on a Done with NO missing deliverables does NOT emit the bypass event", async () => {
    const t = await ctx.store.createTask({
      title: "x", owner: "Frontend", actor: "PM",
      deliverables: [{ kind: "file", ref: "docs/ok.md", description: "" }],
    });
    await touch(path.join(ctx.projectRoot, "docs", "ok.md"));
    const before = (await ctx.store.listEventsAfter("")).length;
    await ctx.store.setTaskStatus({
      taskId: t.id, newStatus: "Done", actor: "Frontend", forceIncomplete: true,
    });
    const newEvents = (await ctx.store.listEventsAfter("")).slice(before);
    expect(newEvents.some((e) => e.type === "TASK_DELIVERABLE_BYPASSED")).toBe(false);
    expect(newEvents.some((e) => e.type === "TASK_STATUS_CHANGED")).toBe(true);
  });

  it("only kind=file deliverables block Done; url/manual are ignored", async () => {
    const t = await ctx.store.createTask({
      title: "x", owner: "Frontend", actor: "PM",
      deliverables: [
        { kind: "url", ref: "https://example.com/spec", description: "" },
        { kind: "manual", ref: "", description: "Demo recorded in shared drive" },
      ],
    });
    const done = await ctx.store.setTaskStatus({
      taskId: t.id, newStatus: "Done", actor: "Frontend",
    });
    expect(done.status).toBe("Done");
  });

  it("manifest TaskSummary carries parent / childCounts / unmetDeliverables / tags", async () => {
    // Build epic + two children. PM owns the epic; Frontend owns a child;
    // the epic also has a missing-file deliverable.
    const epic = await ctx.store.createTask({
      title: "Epic",
      owner: "PM",
      actor: "PM",
      tags: ["q3", "auth"],
      deliverables: [
        { kind: "file", ref: "docs/epic.md", description: "Final spec" },
      ],
    });
    const c1 = await ctx.store.createTask({
      title: "Child 1", owner: "Frontend", parent: epic.id, actor: "PM",
    });
    const c2 = await ctx.store.createTask({
      title: "Child 2", owner: "Frontend", parent: epic.id, actor: "PM",
    });
    await ctx.store.setTaskStatus({ taskId: c2.id, newStatus: "InProgress", actor: "Frontend" });

    // PM's manifest carries the epic summary.
    const pm = await ctx.store.openOrCreatePlan("PM");
    const epicSummary = pm.tasks.find((t) => t.id === epic.id);
    expect(epicSummary).toBeDefined();
    expect(epicSummary!.tags).toEqual(["q3", "auth"]);
    expect(epicSummary!.childCounts).toEqual({
      ready: 1, inProgress: 1, blocked: 0, review: 0, done: 0,
    });
    expect(epicSummary!.unmetDeliverables).toBe(1);
    expect(epicSummary!.parent).toBeUndefined();

    // Frontend's manifest carries c1.parent pointing at the epic.
    const fe = await ctx.store.openOrCreatePlan("Frontend");
    const c1Summary = fe.tasks.find((t) => t.id === c1.id);
    expect(c1Summary?.parent).toBe(epic.id);
    expect(c1Summary?.childCounts).toBeUndefined();
  });

  it("readTaskBoard backfills legacy yaml (without new fields) with safe defaults", async () => {
    // Hand-write a board that mirrors the pre-PR8j layout.
    const boardPath = path.join(ctx.layerRoot, "state", "task_board.yaml");
    const legacy = `schemaVersion: "1.0.0-legacy"
nextId: 1
tasks:
  T-0001:
    id: T-0001
    title: Old task
    status: Ready
    owner: Frontend
    priority: P2
    dependsOn: []
    acceptance: ''
    createdAt: '2024-01-01T00:00:00.000Z'
    updatedAt: '2024-01-01T00:00:00.000Z'
`;
    await fsp.writeFile(boardPath, legacy);
    const board = await ctx.store.readTaskBoard();
    const t = board.tasks["T-0001"];
    expect(t.parent).toBeNull();
    expect(t.assignedBy).toBeNull();
    expect(t.assets).toEqual([]);
    expect(t.deliverables).toEqual([]);
    expect(t.tags).toEqual([]);
  });
});

// ---------- PR8n: manifest event visibility filter ----------

describe("PR8n: manifest event filter", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("TASK_STATUS_CHANGED on T-X surfaces only to T-X's owner / parent owner / dependants", async () => {
    // Setup: epic owned by PM, child owned by Backend, sibling (QA owns)
    // depending on Backend's task. QA should see status changes on the
    // Backend task (it blocks her); Frontend should not (no relation).
    await ctx.store.createRole({ id: "Frontend", title: "Frontend" });
    const epic = await ctx.store.createTask({ title: "Epic", owner: "PM", actor: "PM" });
    const child = await ctx.store.createTask({
      title: "Backend work", owner: "Backend", parent: epic.id, actor: "PM",
    });
    await ctx.store.createTask({
      title: "QA test plan", owner: "QA", dependsOn: [child.id], actor: "PM",
    });
    // Backend moves their task; this generates TASK_STATUS_CHANGED.
    await ctx.store.setTaskStatus({ taskId: child.id, newStatus: "InProgress", actor: "Backend" });

    // PM sees it (parent owner).
    const pm = await ctx.store.openOrCreatePlan("PM");
    expect(pm.events.some((e) => e.type === "TASK_STATUS_CHANGED" && e.ref === child.id)).toBe(true);
    // QA sees it (dependant).
    const qa = await ctx.store.openOrCreatePlan("QA");
    expect(qa.events.some((e) => e.type === "TASK_STATUS_CHANGED" && e.ref === child.id)).toBe(true);
    // Frontend does NOT see it (no relation).
    const fe = await ctx.store.openOrCreatePlan("Frontend");
    expect(fe.events.some((e) => e.type === "TASK_STATUS_CHANGED" && e.ref === child.id)).toBe(false);
  });

  it("WORKLOG is broadcast to everyone (the manual team-status channel)", async () => {
    await ctx.store.publishWorklog({ from: "PM", message: "End-of-day update" });
    const backend = await ctx.store.openOrCreatePlan("Backend");
    const qa = await ctx.store.openOrCreatePlan("QA");
    expect(backend.events.some((e) => e.type === "WORKLOG")).toBe(true);
    expect(qa.events.some((e) => e.type === "WORKLOG")).toBe(true);
  });

  it("SESSION_* / LOCK_BROKEN never land in any manifest (operational events)", async () => {
    // Trigger a session event by claiming a role.
    await ctx.store.claimSession("Backend", 30);
    const events = await ctx.store.listEventsAfter("");
    expect(events.some((e) => e.type === "SESSION_CLAIMED")).toBe(true);
    // None of QA / PM should see it in their manifest.
    const qa = await ctx.store.openOrCreatePlan("QA");
    expect(qa.events.some((e) => e.type === "SESSION_CLAIMED")).toBe(false);
    const pm = await ctx.store.openOrCreatePlan("PM");
    expect(pm.events.some((e) => e.type === "SESSION_CLAIMED")).toBe(false);
  });

  it("operational events stay on disk for audit even when no manifest carries them", async () => {
    await ctx.store.claimSession("Backend", 30);
    const all = await ctx.store.listEventsAfter("");
    const claim = all.find((e) => e.type === "SESSION_CLAIMED");
    expect(claim).toBeDefined();
    // No manifest carried it (verified above); the file is still on disk.
  });

  it("RFC discussion events go only to participants (voters + deciders + createdBy)", async () => {
    await ctx.store.createRole({ id: "DevOps", title: "DevOps" });
    const rfc = await ctx.store.createRfc({
      slug: "thing", title: "Decision",
      voters: ["DevOps"], deciders: ["PM"],
      options: [{ id: "A", summary: "do a" }],
      createdBy: "Backend",
    });
    // Backend (createdBy) and DevOps (voter) and PM (decider) are
    // participants. QA is not.
    const pm = await ctx.store.openOrCreatePlan("PM");
    expect(pm.events.some((e) => e.type === "RFC_CREATED" && e.ref === rfc.id)).toBe(true);
    const devops = await ctx.store.openOrCreatePlan("DevOps");
    expect(devops.events.some((e) => e.type === "RFC_CREATED" && e.ref === rfc.id)).toBe(true);
    const qa = await ctx.store.openOrCreatePlan("QA");
    expect(qa.events.some((e) => e.type === "RFC_CREATED" && e.ref === rfc.id)).toBe(false);

    // Add a comment from DevOps; PM (decider) sees it, QA does not.
    await ctx.store.ackManifest("PM", pm.ackToken);
    await ctx.store.commentRfc({
      rfcId: rfc.id, role: "DevOps", preferred: "", rationale: "Comment", replyTo: null,
    });
    const pm2 = await ctx.store.openOrCreatePlan("PM");
    expect(pm2.events.some((e) => e.type === "RFC_COMMENT" && e.ref === rfc.id)).toBe(true);
    await ctx.store.ackManifest("QA", qa.ackToken);
    const qa2 = await ctx.store.openOrCreatePlan("QA");
    expect(qa2.events.some((e) => e.type === "RFC_COMMENT" && e.ref === rfc.id)).toBe(false);
  });

  it("RFC_DECIDED is true broadcast: everyone sees it (decisions are team-wide)", async () => {
    await ctx.store.createRole({ id: "Frontend", title: "Frontend" });
    const rfc = await ctx.store.createRfc({
      slug: "decide", title: "Decision",
      voters: ["PM"], deciders: ["PM"],
      options: [{ id: "A", summary: "do a" }],
      createdBy: "PM",
    });
    await ctx.store.decideRfc({
      rfcId: rfc.id, decidedBy: "PM", chosenOption: "A", rationale: "Going A",
    });
    // Frontend is NOT a participant of the RFC; should still see the
    // decision in their manifest.
    const fe = await ctx.store.openOrCreatePlan("Frontend");
    expect(fe.events.some((e) => e.type === "RFC_DECIDED" && e.ref === rfc.id)).toBe(true);
  });

  it("ackedThrough advances past hidden events (they do NOT re-appear next plan)", async () => {
    // SESSION_CLAIMED is generated; QA never sees it but the cursor
    // still advances past it. A subsequent plan with no other events
    // produces an empty manifest, not a re-surfacing of SESSION_CLAIMED.
    await ctx.store.claimSession("Backend", 30);
    const qa = await ctx.store.openOrCreatePlan("QA");
    await ctx.store.ackManifest("QA", qa.ackToken);
    // No new event. Next plan must show zero events for QA.
    const qa2 = await ctx.store.openOrCreatePlan("QA");
    expect(qa2.events).toEqual([]);
    // Cursor advanced past SESSION_CLAIMED.
    expect(qa2.fromCursor).not.toBe("");
  });
});
