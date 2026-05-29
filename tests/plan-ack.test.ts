import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { isUlid } from "../src/core/ids";
import { runPlan } from "../src/cli/commands/plan";
import type { ParsedArgs } from "../src/cli/argv";

async function freshStore(): Promise<{ root: string; store: LocalFsStore }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-plan-"));
  const store = new LocalFsStore(root, { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  // PR8b requires recipients to be registered; seed a small role set so
  // existing tests can freely publishReport between them without each
  // one having to repeat the boilerplate.
  for (const id of ["PM", "TL", "Backend", "QA"]) {
    await store.createRole({ id, title: `${id} Agent` });
  }
  return { root, store };
}

describe("Store.publishReport", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("writes one event of type REPORT", async () => {
    const e = await ctx.store.publishReport({
      from: "PM", to: "TL", ref: "T-0001", message: "Goals locked",
    });
    expect(e.type).toBe("REPORT");
    expect(e.from).toBe("PM");
    expect(e.to).toBe("TL");
    expect(e.ref).toBe("T-0001");
    expect(e.payload.message).toBe("Goals locked");
    expect(isUlid(e.id)).toBe(true);
  });

  it("rejects empty messages", async () => {
    await expect(
      ctx.store.publishReport({ from: "PM", to: "TL", message: "" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("rejects unknown role names", async () => {
    await expect(
      ctx.store.publishReport({ from: "../etc", to: "TL", message: "x" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("refuses an unregistered recipient role (PROTOCOL.md contract)", async () => {
    // The recipient passes syntactic role-id validation but has no
    // config.yaml entry. Without this gate the report is emitted into
    // the void — no one's plan ever routes to "Frontend".
    await expect(
      ctx.store.publishReport({ from: "PM", to: "Frontend", message: "x" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });
});

// ----------------------------------------------------------------------------
// runPlan CLI behaviour (TTY detection + text body content).
// ----------------------------------------------------------------------------

interface Captured {
  stdout: string;
  stderr: string;
  release: () => void;
}

function captureStdio(forceTty: boolean): Captured {
  const cap: Captured = { stdout: "", stderr: "", release: () => undefined };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origIsTTY = (process.stdout as unknown as { isTTY: boolean }).isTTY;
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    cap.stdout += chunk;
    return true;
  };
  (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    cap.stderr += chunk;
    return true;
  };
  (process.stdout as unknown as { isTTY: boolean }).isTTY = forceTty;
  cap.release = () => {
    (process.stdout as unknown as { write: typeof origOut }).write = origOut;
    (process.stderr as unknown as { write: typeof origErr }).write = origErr;
    (process.stdout as unknown as { isTTY: boolean }).isTTY = origIsTTY;
  };
  return cap;
}

function planArgs(role: string, flags: Record<string, string | boolean>): ParsedArgs {
  return { command: "plan", positional: [role], flags };
}

// runPlan uses openStoreOrThrow(root) which expects a PROJECT root and
// appends `.gojaja`. The freshStore above intentionally pins the
// layer root directly for the unit-style tests; for CLI tests we need
// the project shape.
async function freshProject(): Promise<{ root: string; store: LocalFsStore }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-plan-proj-"));
  const store = new LocalFsStore(path.join(root, ".gojaja"), { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  // PM owns the task board so the runPlan tests can createTask via PM
  // under PR7 ownership enforcement.
  await store.createRole({
    id: "PM", title: "PM Agent",
    owns: ["state/task_board.yaml"],
  });
  for (const id of ["TL", "Backend", "QA"]) {
    await store.createRole({ id, title: `${id} Agent` });
  }
  return { root, store };
}

describe("runPlan — TTY-aware output", () => {
  let ctx: { root: string; store: LocalFsStore };
  const originalEnv = process.env.GOJAJA_SESSION;
  beforeEach(async () => {
    ctx = await freshProject();
    delete process.env.GOJAJA_SESSION;
    const s = await ctx.store.claimSession("TL", 60);
    process.env.GOJAJA_SESSION = s.sessionId;
  });
  afterEach(async () => {
    if (originalEnv === undefined) delete process.env.GOJAJA_SESSION;
    else process.env.GOJAJA_SESSION = originalEnv;
    await fsp.rm(ctx.root, { recursive: true, force: true });
  });

  it("emits JSON automatically when stdout is not a TTY (agent default)", async () => {
    await ctx.store.publishReport({ from: "PM", to: "TL", message: "x" });
    const cap = captureStdio(false /* not a TTY */);
    try {
      const code = await runPlan(planArgs("TL", { root: ctx.root }));
      expect(code).toBe(0);
      // Output must be a single parseable JSON line, not the human text.
      expect(cap.stdout).not.toContain("ack token       :");
      const parsed = JSON.parse(cap.stdout);
      expect(parsed.role).toBe("TL");
      expect(Array.isArray(parsed.tasks)).toBe(true);
      expect(Array.isArray(parsed.rfcs)).toBe(true);
    } finally {
      cap.release();
    }
  });

  it("emits human text when stdout is a TTY, with both Tasks and RFCs sections", async () => {
    // Seed a task assigned to TL so the text section has content.
    await ctx.store.createTask({
      title: "Build login", owner: "TL", priority: "P1", actor: "PM",
    });
    const tasks = await ctx.store.readTaskBoard();
    const taskId = Object.keys(tasks.tasks)[0];
    await ctx.store.setTaskStatus({
      taskId, newStatus: "Ready", actor: "PM",
    });
    const cap = captureStdio(true /* a TTY */);
    try {
      await runPlan(planArgs("TL", { root: ctx.root }));
      expect(cap.stdout).toContain("active tasks    :");
      expect(cap.stdout).toContain("pending RFCs    :");
      expect(cap.stdout).toContain("Build login");
    } finally {
      cap.release();
    }
  });

  it("explicit --json still forces JSON in a TTY", async () => {
    const cap = captureStdio(true);
    try {
      await runPlan(planArgs("TL", { root: ctx.root, json: true }));
      const parsed = JSON.parse(cap.stdout);
      expect(parsed.role).toBe("TL");
    } finally {
      cap.release();
    }
  });
});

describe("Store.publishWorklog", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("writes a WORKLOG event broadcast to '*' and a markdown file", async () => {
    const e = await ctx.store.publishWorklog({ from: "PM", message: "Drafted criteria" });
    expect(e.type).toBe("WORKLOG");
    expect(e.to).toBe("*");
    const md = await fsp.readFile(
      path.join(ctx.root, "worklog", "PM", `${e.id}.md`),
      "utf8",
    );
    expect(md).toContain("Drafted criteria");
    expect(md).toContain(`Worklog entry ${e.id}`);
  });

  it("kind: 'idle' is narrowed to task-board owners (peer idle agents do not see it)", async () => {
    // Use an isolated store so we can configure `owns` cleanly:
    // freshStore() creates roles with no `owns`, and we need PM to own
    // the task board for this scenario.
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-idle-"));
    const store = new LocalFsStore(root, { safetyMarginMs: 0 });
    try {
      await store.initialise("2.0.0-test");
      await store.createRole({
        id: "PM",
        title: "PM",
        owns: ["state/task_board.yaml"],
      });
      await store.createRole({ id: "TL", title: "TL" });
      await store.createRole({ id: "Backend", title: "Backend" });
      await store.createRole({ id: "QA", title: "QA" });

      const e = await store.publishWorklog({
        from: "TL",
        message: "TL is idle since ...; waiting for new task assignment.",
        kind: "idle",
      });
      expect(e.type).toBe("WORKLOG");
      expect((e.payload as { kind?: string }).kind).toBe("idle");

      // PM owns the task board → sees it (so it can push work to TL).
      const visiblePM = await store.filterVisibleEventsForRole([e], "PM");
      expect(visiblePM).toHaveLength(1);

      // Backend / QA are peer roles, not task-board owners → must NOT
      // see it. Without this filter, two peer-idle agents would
      // ATTENTION-fire on each other's idle worklog and burn turns in
      // a mutual-wakeup loop.
      const visibleBackend = await store.filterVisibleEventsForRole([e], "Backend");
      expect(visibleBackend).toHaveLength(0);
      const visibleQA = await store.filterVisibleEventsForRole([e], "QA");
      expect(visibleQA).toHaveLength(0);

      // The author never sees their own event (self-events are
      // filtered separately, before the kind check).
      const visibleSelf = await store.filterVisibleEventsForRole([e], "TL");
      expect(visibleSelf).toHaveLength(0);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("regular worklog (no kind) stays broadcast to every role", async () => {
    const e = await ctx.store.publishWorklog({
      from: "TL",
      message: "shipped login flow",
    });
    expect((e.payload as { kind?: unknown }).kind).toBeUndefined();
    // Visible to every other role; only TL itself filters out via the
    // self-event rule.
    for (const role of ["PM", "Backend", "QA"] as const) {
      const visible = await ctx.store.filterVisibleEventsForRole([e], role);
      expect(visible).toHaveLength(1);
    }
    const visibleSelf = await ctx.store.filterVisibleEventsForRole([e], "TL");
    expect(visibleSelf).toHaveLength(0);
  });
});

describe("Store.openOrCreatePlan — safetyMarginMs watermark", () => {
  async function freshWatermarkStore(safetyMarginMs: number) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-water-"));
    const store = new LocalFsStore(root, { safetyMarginMs });
    await store.initialise("2.0.0-test");
    for (const id of ["PM", "TL"]) {
      await store.createRole({ id, title: `${id} Agent` });
    }
    return { root, store };
  }

  it("fresh events are deferred to the next plan when watermark > 0", async () => {
    const { root, store } = await freshWatermarkStore(1000);
    try {
      await store.publishReport({ from: "PM", to: "TL", message: "fresh" });

      const m1 = await store.openOrCreatePlan("TL");
      expect(m1.events).toHaveLength(0);
      expect(m1.advanceCursorTo).toBe("");
      await store.ackManifest("TL", m1.ackToken);

      await new Promise((r) => setTimeout(r, 1100));
      const m2 = await store.openOrCreatePlan("TL");
      expect(m2.events.map((e) => e.payload.message)).toContain("fresh");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("events newer than the watermark cannot advance the cursor", async () => {
    // Core safety promise: cross-process same-ms ULID races cannot cause
    // the cursor to skip past an event that has not been seen.
    const { root, store } = await freshWatermarkStore(500);
    try {
      const old = await store.publishReport({ from: "PM", to: "TL", message: "old" });
      await new Promise((r) => setTimeout(r, 600));
      await store.publishReport({ from: "PM", to: "TL", message: "fresh" });

      const m = await store.openOrCreatePlan("TL");
      expect(m.events.map((e) => e.payload.message)).toEqual(["old"]);
      expect(m.advanceCursorTo).toBe(old.id);
      await store.ackManifest("TL", m.ackToken);

      const cursor = await store.readCursor("TL");
      expect(cursor.ackedThrough).toBe(old.id);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Store.openOrCreatePlan", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("returns empty manifest when there are no events", async () => {
    const m = await ctx.store.openOrCreatePlan("PM");
    expect(m.role).toBe("PM");
    expect(m.events).toHaveLength(0);
    expect(m.fromCursor).toBe("");
    expect(isUlid(m.ackToken)).toBe(true);
  });

  it("includes a compact roleReminder anchored on every plan", async () => {
    // Without a config entry, the reminder still has id/title/protocol.
    const m1 = await ctx.store.openOrCreatePlan("PM");
    expect(m1.roleReminder.id).toBe("PM");
    expect(m1.roleReminder.title).toBe("PM Agent");
    expect(m1.roleReminder.protocol).toMatch(/plan/);
    expect(m1.roleReminder.protocol).toMatch(/ack/);
    expect(m1.roleReminder.protocol).toMatch(/never hand-edit/);
    // PR8f-C: roleReminder reminds the agent how to recover its own
    // contract if it has lost context. Cheaper than re-pasting the
    // activation snippet, and routes the agent through the right
    // CLI command.
    expect(m1.roleReminder.protocol).toMatch(/gojaja role show/);
    // Empty fields must NOT be serialised — keep manifests tight.
    expect(m1.roleReminder.owns).toBeUndefined();
    expect(m1.roleReminder.mustNotEdit).toBeUndefined();
    expect(m1.roleReminder.reportsTo).toBeUndefined();
  });

  it("reminder picks up config.yaml fields when set, still omits empty ones", async () => {
    // freshStore seeds Backend with default config; use a distinct id so
    // we can exercise the "rich config" path without collision.
    await ctx.store.createRole({
      id: "BackendRich",
      title: "Backend Engineer",
      owns: ["src/api/", "src/db/"],
      reportsTo: ["TL", "PM"],
      mustNotEdit: [], // intentionally empty
    });
    const m = await ctx.store.openOrCreatePlan("BackendRich");
    expect(m.roleReminder.id).toBe("BackendRich");
    expect(m.roleReminder.title).toBe("Backend Engineer");
    expect(m.roleReminder.owns).toEqual(["src/api/", "src/db/"]);
    expect(m.roleReminder.reportsTo).toEqual(["TL", "PM"]);
    expect(m.roleReminder.mustNotEdit).toBeUndefined();
  });

  it("reminder serialised size stays small (<300 bytes for a fully-populated reminder)", async () => {
    await ctx.store.createRole({
      id: "BackendFull",
      title: "Backend Engineer",
      owns: ["src/api/", "src/db/"],
      reportsTo: ["TL"],
      mustNotEdit: ["state/architecture.md"],
    });
    const m = await ctx.store.openOrCreatePlan("BackendFull");
    const bytes = Buffer.byteLength(JSON.stringify(m.roleReminder));
    expect(bytes).toBeLessThan(300);
  });

  it("filters events by recipient (to == role || to == '*'), excludes self-sent", async () => {
    await ctx.store.publishReport({ from: "PM", to: "TL", message: "for TL only" });
    await ctx.store.publishReport({ from: "PM", to: "Backend", message: "for BE only" });
    await ctx.store.publishWorklog({ from: "PM", message: "broadcast from PM" });
    await ctx.store.publishReport({ from: "Backend", to: "PM", message: "for PM" });

    const planTL = await ctx.store.openOrCreatePlan("TL");
    const seenByTL = planTL.events.map((e) => e.payload.message);
    expect(seenByTL).toContain("for TL only");
    expect(seenByTL).toContain("broadcast from PM");
    expect(seenByTL).not.toContain("for BE only");
    expect(seenByTL).not.toContain("for PM");

    const planPM = await ctx.store.openOrCreatePlan("PM");
    const seenByPM = planPM.events.map((e) => e.payload.message);
    // PM's own broadcasts/reports must NOT appear in PM's own plan.
    expect(seenByPM).not.toContain("for TL only");
    expect(seenByPM).not.toContain("broadcast from PM");
    expect(seenByPM).toContain("for PM");
  });

  it("is idempotent across retry: re-calling returns the SAME manifest", async () => {
    await ctx.store.publishReport({ from: "PM", to: "TL", message: "one" });
    const m1 = await ctx.store.openOrCreatePlan("TL");
    const m2 = await ctx.store.openOrCreatePlan("TL");
    expect(m2.ackToken).toBe(m1.ackToken);
    expect(m2.events.map((e) => e.id)).toEqual(m1.events.map((e) => e.id));
  });

  it("stamps the cursor with pendingManifest", async () => {
    await ctx.store.publishReport({ from: "PM", to: "TL", message: "one" });
    const m = await ctx.store.openOrCreatePlan("TL");
    const cursor = await ctx.store.readCursor("TL");
    expect(cursor.pendingManifest).toBe(m.ackToken);
    expect(cursor.ackedThrough).toBe("");
  });
});

describe("Store.ackManifest", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("advances cursor to manifest.advanceCursorTo on the correct token", async () => {
    await ctx.store.publishReport({ from: "PM", to: "TL", message: "one" });
    const m = await ctx.store.openOrCreatePlan("TL");
    const result = await ctx.store.ackManifest("TL", m.ackToken);
    expect(result.ackedThrough).toBe(m.advanceCursorTo);
    expect(result.eventsAcked).toBe(m.events.length);
    const cursor = await ctx.store.readCursor("TL");
    expect(cursor.ackedThrough).toBe(m.advanceCursorTo);
    expect(cursor.pendingManifest).toBeNull();
  });

  it("rejects the wrong ack token", async () => {
    await ctx.store.publishReport({ from: "PM", to: "TL", message: "one" });
    await ctx.store.openOrCreatePlan("TL");
    await expect(
      ctx.store.ackManifest("TL", "01HXNOTAREALTOKENXXXXXXXXX"),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("rejects ack when no manifest is outstanding", async () => {
    await expect(
      ctx.store.ackManifest("TL", "01HXNOTAREALTOKENXXXXXXXXX"),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("does NOT skip events that arrived after plan", async () => {
    // Critical v0.1 bug: ack reading "current latest" silently jumps past
    // events that plan never showed. Our ack must only advance to the
    // manifest's snapshot point.
    await ctx.store.publishReport({ from: "PM", to: "TL", message: "first" });
    const m = await ctx.store.openOrCreatePlan("TL");
    // Inject an event AFTER plan but BEFORE ack.
    const late = await ctx.store.publishReport({
      from: "PM", to: "TL", message: "late",
    });
    await ctx.store.ackManifest("TL", m.ackToken);

    // The late event must still appear in the next plan.
    const next = await ctx.store.openOrCreatePlan("TL");
    expect(next.events.map((e) => e.id)).toContain(late.id);
    expect(next.events.map((e) => e.payload.message)).toContain("late");
  });

  it("allows a fresh plan after ack with a new token", async () => {
    await ctx.store.publishReport({ from: "PM", to: "TL", message: "first" });
    const m1 = await ctx.store.openOrCreatePlan("TL");
    await ctx.store.ackManifest("TL", m1.ackToken);

    await ctx.store.publishReport({ from: "PM", to: "TL", message: "second" });
    const m2 = await ctx.store.openOrCreatePlan("TL");
    expect(m2.ackToken).not.toBe(m1.ackToken);
    expect(m2.events.map((e) => e.payload.message)).toContain("second");
    expect(m2.events.map((e) => e.payload.message)).not.toContain("first");
  });

  it("survives concurrent plan attempts: any number of plans returns one token", async () => {
    await ctx.store.publishReport({ from: "PM", to: "TL", message: "x" });
    const planResults = await Promise.all(
      Array.from({ length: 8 }, () => ctx.store.openOrCreatePlan("TL")),
    );
    const tokens = new Set(planResults.map((m) => m.ackToken));
    expect(tokens.size).toBe(1);
  });

  it("never loses an event across a fast publish/plan/ack loop", async () => {
    // Property test: emit 30 events to TL, drain via plan/ack in batches,
    // confirm every event is observed exactly once.
    const N = 30;
    const sent: string[] = [];
    for (let i = 0; i < N; i++) {
      const e = await ctx.store.publishReport({
        from: "PM", to: "TL", message: `msg-${i}`,
      });
      sent.push(e.id);
    }
    const seen = new Set<string>();
    for (let iter = 0; iter < N; iter++) {
      const m = await ctx.store.openOrCreatePlan("TL");
      if (m.events.length === 0) break;
      for (const e of m.events) seen.add(e.id);
      await ctx.store.ackManifest("TL", m.ackToken);
    }
    expect(seen.size).toBe(N);
    for (const id of sent) expect(seen.has(id)).toBe(true);
  });
});
