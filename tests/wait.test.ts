import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { runWait } from "../src/cli/commands/wait";
import type { ParsedArgs } from "../src/cli/argv";
import type { Event } from "../src/core/types";

async function freshProject() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-wait-"));
  const store = new LocalFsStore(path.join(root, ".gojaja"), { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  await store.createRole({ id: "TL", title: "Tech Lead" });
  await store.createRole({ id: "PM", title: "Product Manager" });
  await store.createRole({ id: "Backend", title: "Backend" });
  return { root, store };
}

interface Captured {
  stdout: string;
  stderr: string;
  release: () => void;
}

function captureStdio(): Captured {
  const cap: Captured = { stdout: "", stderr: "", release: () => undefined };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    cap.stdout += chunk;
    return true;
  };
  (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    cap.stderr += chunk;
    return true;
  };
  cap.release = () => {
    (process.stdout as unknown as { write: typeof origOut }).write = origOut;
    (process.stderr as unknown as { write: typeof origErr }).write = origErr;
  };
  return cap;
}

function args(role: string, flags: Record<string, string | boolean>): ParsedArgs {
  return { command: "wait", positional: [role], flags };
}

function waitJsonPath(root: string, role: string): string {
  return path.join(root, ".gojaja", "comms", "pending", role, "wait.json");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

describe("gojaja wait (PR8i)", () => {
  let ctx: { root: string; store: LocalFsStore };
  let envOrig: string | undefined;
  beforeEach(async () => {
    ctx = await freshProject();
    envOrig = process.env.GOJAJA_SESSION;
    const s = await ctx.store.claimSession("TL", 60);
    process.env.GOJAJA_SESSION = s.sessionId;
    // Drain baseline events so wait starts from a clean cursor.
    const m = await ctx.store.openOrCreatePlan("TL");
    await ctx.store.ackManifest("TL", m.ackToken);
  });
  afterEach(async () => {
    if (envOrig === undefined) delete process.env.GOJAJA_SESSION;
    else process.env.GOJAJA_SESSION = envOrig;
    await fsp.rm(ctx.root, { recursive: true, force: true });
  });

  // ---------- deadline / blocking basics ----------

  it("--in 1s --for attention with no events → TIMEOUT, wait.json cleared", async () => {
    const cap = captureStdio();
    try {
      const code = await runWait(
        args("TL", { in: "1s", "poll-interval": "5s", root: ctx.root }),
      );
      expect(code).toBe(0);
      // Start line printed before blocking, with a current timestamp.
      expect(cap.stdout).toMatch(/WAITING role=TL now=\d{4}-\d{2}-\d{2}T/);
      expect(cap.stdout).toContain("TIMEOUT");
      expect(cap.stdout).toContain("role=TL");
      expect(await exists(waitJsonPath(ctx.root, "TL"))).toBe(false);
    } finally {
      cap.release();
    }
  });

  it("--json output stays a single parseable object (no WAITING start line)", async () => {
    const cap = captureStdio();
    try {
      const code = await runWait(
        args("TL", { in: "0s", json: "true", root: ctx.root }),
      );
      expect(code).toBe(0);
      expect(cap.stdout).not.toContain("WAITING");
      // Whole stdout must parse as one JSON object.
      const parsed = JSON.parse(cap.stdout.trim());
      expect(parsed.status).toBe("timeout");
    } finally {
      cap.release();
    }
  });

  it("--in 2s with mid-sleep event from another role → ATTENTION, wait.json cleared", async () => {
    const cap = captureStdio();
    try {
      const t = runWait(args("TL", { in: "2s", "poll-interval": "200ms", root: ctx.root }));
      setTimeout(() => {
        void ctx.store.publishReport({ from: "PM", to: "TL", message: "ping" });
      }, 200);
      const code = await t;
      expect(code).toBe(0);
      expect(cap.stdout).toContain("ATTENTION");
      expect(cap.stdout).toMatch(/newEvents=[1-9]/);
      expect(await exists(waitJsonPath(ctx.root, "TL"))).toBe(false);
    } finally {
      cap.release();
    }
  });

  it("--in 0s → immediate TIMEOUT and never writes wait.json", async () => {
    const cap = captureStdio();
    try {
      const before = Date.now();
      const code = await runWait(args("TL", { in: "0s", root: ctx.root }));
      const elapsed = Date.now() - before;
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(500);
      expect(cap.stdout).toContain("TIMEOUT");
      expect(await exists(waitJsonPath(ctx.root, "TL"))).toBe(false);
    } finally {
      cap.release();
    }
  });

  it("--until <past ISO> → immediate TIMEOUT", async () => {
    const cap = captureStdio();
    try {
      const code = await runWait(
        args("TL", {
          until: "2020-01-01T00:00:00Z",
          root: ctx.root,
        }),
      );
      expect(code).toBe(0);
      expect(cap.stdout).toContain("TIMEOUT");
    } finally {
      cap.release();
    }
  });

  it("a single call BLOCKS to the deadline then TIMEOUT (no RESUME); wait.json cleared", async () => {
    const cap = captureStdio();
    try {
      const before = Date.now();
      const code = await runWait(
        args("TL", { in: "1s", "poll-interval": "200ms", root: ctx.root }),
      );
      const elapsed = Date.now() - before;
      expect(code).toBe(0);
      expect(cap.stdout).toContain("TIMEOUT");
      // The wait blocks for the whole deadline in one call — it does NOT
      // exit-and-resume after a single poll interval.
      expect(cap.stdout).not.toContain("RESUME");
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(await exists(waitJsonPath(ctx.root, "TL"))).toBe(false);
    } finally {
      cap.release();
    }
  });

  it("no --in/--until → INDEFINITE wait: never TIMEOUTs, wakes on an event", async () => {
    const cap = captureStdio();
    try {
      // Bare wait (no deadline) blocks indefinitely; only an event ends
      // it. Inject a report mid-block and confirm ATTENTION (not TIMEOUT).
      const t = runWait(args("TL", { "poll-interval": "200ms", root: ctx.root }));
      // Session on disk should record deadline=null while blocked.
      await new Promise((r) => setTimeout(r, 250));
      const ws = JSON.parse(
        await fsp.readFile(waitJsonPath(ctx.root, "TL"), "utf8"),
      ) as { deadline: string | null };
      expect(ws.deadline).toBeNull();
      void ctx.store.publishReport({ from: "PM", to: "TL", message: "ping" });
      const code = await t;
      expect(code).toBe(0);
      expect(cap.stdout).toContain("ATTENTION");
      expect(cap.stdout).not.toContain("TIMEOUT");
      expect(await exists(waitJsonPath(ctx.root, "TL"))).toBe(false);
    } finally {
      cap.release();
    }
  });

  it("re-invoking with NO deadline flags resumes the in-progress wait (host-kill recovery)", async () => {
    const cap = captureStdio();
    try {
      // Simulate a wait the host killed mid-block: a live session on
      // disk that was never cleared.
      const deadlineIso = new Date(Date.now() + 1000).toISOString();
      await ctx.store.writeWaitState({
        role: "TL",
        deadline: deadlineIso,
        for: { kind: "attention" },
        startedAt: new Date().toISOString(),
        ackedThroughAtStart: "",
        idleBroadcastSent: false,
      });
      const before = Date.now();
      const code = await runWait(args("TL", { "poll-interval": "200ms", root: ctx.root }));
      const elapsed = Date.now() - before;
      expect(code).toBe(0);
      expect(cap.stdout).toContain("TIMEOUT");
      // It resumed the ~1s on-disk deadline, NOT a fresh default 10m wait
      // (which would block far longer).
      expect(elapsed).toBeLessThan(4000);
      expect(await exists(waitJsonPath(ctx.root, "TL"))).toBe(false);
    } finally {
      cap.release();
    }
  });

  // ---------- --for task-assigned idle broadcast ----------

  it("--for task-assigned broadcasts the idle worklog once, and not again on resume", async () => {
    const cap = captureStdio();
    try {
      // Fresh wait: broadcasts the idle worklog once, blocks ~1s, TIMEOUT.
      await runWait(
        args("TL", {
          in: "1s",
          for: "task-assigned",
          "poll-interval": "200ms",
          root: ctx.root,
        }),
      );

      // Simulate a killed-then-resumed wait: a live session already
      // flagged idleBroadcastSent. A no-arg resume must NOT re-broadcast.
      await ctx.store.writeWaitState({
        role: "TL",
        deadline: new Date(Date.now() + 800).toISOString(),
        for: { kind: "task-assigned" },
        startedAt: new Date().toISOString(),
        ackedThroughAtStart: "",
        idleBroadcastSent: true,
      });
      await runWait(args("TL", { "poll-interval": "200ms", root: ctx.root }));

      const events = (await ctx.store.listEventsAfter("")) as Event[];
      const idleWorklogs = events.filter(
        (e) =>
          e.type === "WORKLOG" &&
          e.from === "TL" &&
          typeof (e.payload as { message?: unknown }).message === "string" &&
          (e.payload as { message: string }).message.includes("is idle since"),
      );
      expect(idleWorklogs.length).toBe(1);
    } finally {
      cap.release();
    }
  });

  it("a peer's idle worklog does NOT wake another peer's wait (no mutual-wakeup loop)", async () => {
    // Regression for the mutual-wakeup loop: when two non-owner roles
    // both went idle around the same time, each one's wait would
    // ATTENTION-fire on the other's "I am idle" worklog (a broadcast
    // visible to everyone before this PR), ack it, re-park, re-broadcast
    // its own idle worklog, and so on — burning turns indefinitely.
    //
    // The fix: idle worklogs carry `kind: "idle"` and
    // `filterVisibleEventsForRole` narrows them to task-board owners
    // only. Neither TL nor Backend owns the task board in the default
    // freshProject() role set, so Backend's idle worklog must NOT be
    // visible attention for TL.
    const cap = captureStdio();
    try {
      // Backend goes idle first (manually emit the same shape `wait
      // --for task-assigned` would produce, so the test does not depend
      // on running two waits concurrently).
      await ctx.store.publishWorklog({
        from: "Backend",
        message: "Backend is idle since ...; waiting for new task assignment.",
        kind: "idle",
      });
      // TL waits with --for attention (the default — strictly broader
      // than --for task-assigned, so if the regression were here it
      // would show up under attention too).
      const before = Date.now();
      const code = await runWait(
        args("TL", { in: "1s", "poll-interval": "200ms", root: ctx.root }),
      );
      const elapsed = Date.now() - before;
      expect(code).toBe(0);
      // No visible event for TL → the wait must time out cleanly,
      // not wake on Backend's idle broadcast.
      expect(cap.stdout).toContain("TIMEOUT");
      expect(cap.stdout).not.toContain("ATTENTION");
      expect(elapsed).toBeGreaterThanOrEqual(900);
    } finally {
      cap.release();
    }
  });

  it("--for task-assigned exits CONDITION_MET when a TASK_ASSIGNED event names self", async () => {
    const cap = captureStdio();
    try {
      const deadlineMs = Date.now() + 3000;
      const deadlineIso = new Date(deadlineMs).toISOString();
      const t = runWait(
        args("TL", {
          until: deadlineIso,
          for: "task-assigned",
          "poll-interval": "200ms",
          root: ctx.root,
        }),
      );
      setTimeout(() => {
        void (async () => {
          const task = await ctx.store.createTask({
            title: "do thing",
            owner: "TL",
            actor: "SYSTEM",
          });
          // createTask with non-null owner already emits TASK_ASSIGNED; if not,
          // explicit reassign would too. Either way the predicate fires.
          void task;
        })();
      }, 200);
      const code = await t;
      expect(code).toBe(0);
      expect(cap.stdout).toContain("CONDITION_MET");
      expect(cap.stdout).toContain("condition=task-assigned");
    } finally {
      cap.release();
    }
  });

  // ---------- other --for predicates ----------

  it("--for rfc-decided:<id> upgrades the wake verdict to CONDITION_MET on the named RFC", async () => {
    const cap = captureStdio();
    try {
      // PM decides so the resulting RFC_DECIDED event has `from=PM`;
      // the manifest projection would drop a `from=TL` self-event for
      // the role we're waiting as. TL is a voter, so it's still an
      // RFC participant and sees the broadcast.
      const rfc = await ctx.store.createRfc({
        slug: "alpha",
        title: "Alpha",
        voters: ["TL"],
        deciders: ["PM"],
        options: [{ id: "A", summary: "do a" }],
        createdBy: "TL",
        description: "ctx",
      });
      // Comment-coverage gate (PR8u): TL is the creator (excluded);
      // PM is the only required commenter.
      await ctx.store.commentRfc({
        rfcId: rfc.id, role: "PM", preferred: "", rationale: "in",
      });
      await ctx.store.preDecideRfc({
        rfcId: rfc.id,
        decidedBy: "PM",
        chosenOption: "A",
        rationale: "let's go",
      });
      await ctx.store.ackRfc({ rfcId: rfc.id, role: "TL" });
      // Drain pre-wait events so the wait cursor is current and only
      // the deferred decide event will wake it.
      const m = await ctx.store.openOrCreatePlan("TL");
      await ctx.store.ackManifest("TL", m.ackToken);

      const t = runWait(
        args("TL", {
          in: "3s",
          for: `rfc-decided:${rfc.id}`,
          "poll-interval": "200ms",
          root: ctx.root,
        }),
      );
      setTimeout(() => {
        void ctx.store.decideRfc({
          rfcId: rfc.id,
          decidedBy: "PM",
          chosenOption: "A",
          rationale: "ok",
        });
      }, 200);
      const code = await t;
      expect(code).toBe(0);
      expect(cap.stdout).toContain("CONDITION_MET");
      expect(cap.stdout).toContain(`condition=rfc-decided:${rfc.id}`);
    } finally {
      cap.release();
    }
  });

  it("--for X still wakes (as ATTENTION) on unrelated visible events — `--for` is not a filter", async () => {
    // Regression for the user-reported bug: a developer parked on
    // `--for task-assigned` was missing all-hands events (CTO opens an
    // RFC requesting input from everyone). `--for` is a verdict tag /
    // side-effect, not an event filter; any event that would land in
    // the role's manifest must wake the wait.
    const cap = captureStdio();
    try {
      const t = runWait(
        args("TL", {
          in: "3s",
          for: "task-assigned",
          "poll-interval": "100ms",
          root: ctx.root,
        }),
      );
      setTimeout(() => {
        // RFC where TL is a voter — visible to TL via the manifest
        // projection; does NOT match `task-assigned`.
        void ctx.store.createRfc({
          slug: "all-hands",
          title: "All hands",
          voters: ["TL"],
          deciders: ["PM"],
          options: [{ id: "A", summary: "do a" }],
          createdBy: "PM",
          description: "everyone weigh in",
        });
      }, 200);
      const code = await t;
      expect(code).toBe(0);
      expect(cap.stdout).toContain("ATTENTION");
      expect(cap.stdout).not.toContain("CONDITION_MET");
      expect(cap.stdout).not.toContain("TIMEOUT");
      expect(await exists(waitJsonPath(ctx.root, "TL"))).toBe(false);
    } finally {
      cap.release();
    }
  });

  it("--for rfc-acked:<id> fires on ack and on object", async () => {
    const cap = captureStdio();
    try {
      const rfc = await ctx.store.createRfc({
        slug: "thing",
        title: "Thing",
        voters: ["PM", "Backend"],
        deciders: ["TL"],
        options: [{ id: "A", summary: "do a" }],
        createdBy: "TL",
        description: "ctx",
      });
      // Comment-coverage gate (PR8u): TL is the creator (excluded);
      // PM and Backend must comment before pre-decide is allowed.
      for (const role of ["PM", "Backend"] as const) {
        await ctx.store.commentRfc({
          rfcId: rfc.id, role, preferred: "", rationale: "in",
        });
      }
      const m = await ctx.store.openOrCreatePlan("TL");
      await ctx.store.ackManifest("TL", m.ackToken);

      // Pre-decide so PM/Backend can ack/object.
      await ctx.store.preDecideRfc({
        rfcId: rfc.id,
        decidedBy: "TL",
        chosenOption: "A",
        rationale: "let's go with A",
      });
      // Drain — pre-decide produced new events.
      const m3 = await ctx.store.openOrCreatePlan("TL");
      await ctx.store.ackManifest("TL", m3.ackToken);

      const t = runWait(
        args("TL", {
          in: "2s",
          for: `rfc-acked:${rfc.id}`,
          "poll-interval": "200ms",
          root: ctx.root,
        }),
      );
      setTimeout(() => {
        void ctx.store.ackRfc({
          rfcId: rfc.id,
          role: "PM",
          rationale: "agreed",
        });
      }, 200);
      const code = await t;
      expect(code).toBe(0);
      expect(cap.stdout).toContain("CONDITION_MET");
    } finally {
      cap.release();
    }
  });

  it("--for report-from:<role> upgrades to CONDITION_MET on a report from that role", async () => {
    const cap = captureStdio();
    try {
      const t = runWait(
        args("TL", {
          in: "2s",
          for: "report-from:PM",
          "poll-interval": "200ms",
          root: ctx.root,
        }),
      );
      setTimeout(() => {
        void ctx.store.publishReport({ from: "PM", to: "TL", message: "wanted" });
      }, 200);
      const code = await t;
      expect(code).toBe(0);
      expect(cap.stdout).toContain("CONDITION_MET");
      expect(cap.stdout).toContain("condition=report-from:PM");
    } finally {
      cap.release();
    }
  });

  it("--for report-from:<role> still wakes (as ATTENTION) on a report from a DIFFERENT role", async () => {
    // Same shape as the all-hands regression above, but for the
    // narrower `report-from` predicate: a directed REPORT from another
    // role is visible attention and must wake the wait, just without
    // upgrading the verdict to CONDITION_MET.
    const cap = captureStdio();
    try {
      const t = runWait(
        args("TL", {
          in: "2s",
          for: "report-from:PM",
          "poll-interval": "100ms",
          root: ctx.root,
        }),
      );
      setTimeout(() => {
        void ctx.store.publishReport({
          from: "Backend",
          to: "TL",
          message: "fyi",
        });
      }, 200);
      const code = await t;
      expect(code).toBe(0);
      expect(cap.stdout).toContain("ATTENTION");
      expect(cap.stdout).not.toContain("CONDITION_MET");
      expect(cap.stdout).not.toContain("TIMEOUT");
    } finally {
      cap.release();
    }
  });

  // ---------- USAGE / regression ----------

  it("removed flags --mode / --idle / --idle-seconds → USAGE", async () => {
    const cap = captureStdio();
    try {
      await expect(
        runWait(args("TL", { mode: "exit", root: ctx.root })),
      ).rejects.toMatchObject({ code: "USAGE" });
      await expect(
        runWait(args("TL", { idle: "5", root: ctx.root })),
      ).rejects.toMatchObject({ code: "USAGE" });
      await expect(
        runWait(args("TL", { "idle-seconds": "5", root: ctx.root })),
      ).rejects.toMatchObject({ code: "USAGE" });
    } finally {
      cap.release();
    }
  });

  it("--until and --in together → USAGE", async () => {
    const cap = captureStdio();
    try {
      await expect(
        runWait(
          args("TL", {
            until: new Date(Date.now() + 60000).toISOString(),
            in: "30s",
            root: ctx.root,
          }),
        ),
      ).rejects.toMatchObject({ code: "USAGE" });
    } finally {
      cap.release();
    }
  });

  it("bad --in duration → USAGE", async () => {
    const cap = captureStdio();
    try {
      await expect(
        runWait(args("TL", { in: "7banana", root: ctx.root })),
      ).rejects.toMatchObject({ code: "USAGE" });
    } finally {
      cap.release();
    }
  });

  it("pendingManifest outstanding → USAGE (regression preserved from H-04)", async () => {
    await ctx.store.publishReport({ from: "PM", to: "TL", message: "ping" });
    await ctx.store.openOrCreatePlan("TL");
    const cap = captureStdio();
    try {
      await expect(
        runWait(args("TL", { in: "0s", root: ctx.root })),
      ).rejects.toMatchObject({ code: "USAGE" });
      expect(cap.stderr + cap.stdout).not.toContain("ATTENTION");
    } finally {
      cap.release();
    }
  });

  it("--for task-assigned still emits worklog when no role owns the task board", async () => {
    // Worklog target is "*" so this is just a smoke test: the broadcast
    // does not depend on any reportsTo / task-board-owner registration.
    const cap = captureStdio();
    try {
      await runWait(
        args("TL", {
          in: "100ms",
          for: "task-assigned",
          "poll-interval": "50ms",
          root: ctx.root,
        }),
      );
      const events = (await ctx.store.listEventsAfter("")) as Event[];
      const idle = events.find(
        (e) =>
          e.type === "WORKLOG" &&
          e.from === "TL" &&
          (e.payload as { message?: string }).message?.includes("is idle since"),
      );
      expect(idle).toBeDefined();
    } finally {
      cap.release();
    }
  });

  it("a resumed wait still detects attention mid-block and clears the session", async () => {
    const cap = captureStdio();
    try {
      // Live session on disk (as if the host killed the prior call).
      await ctx.store.writeWaitState({
        role: "TL",
        deadline: new Date(Date.now() + 2000).toISOString(),
        for: { kind: "attention" },
        startedAt: new Date().toISOString(),
        ackedThroughAtStart: "",
        idleBroadcastSent: false,
      });
      const t = runWait(args("TL", { "poll-interval": "200ms", root: ctx.root }));
      setTimeout(() => {
        void ctx.store.publishReport({ from: "PM", to: "TL", message: "go" });
      }, 200);
      const code = await t;
      expect(code).toBe(0);
      expect(cap.stdout).toContain("ATTENTION");
      expect(await exists(waitJsonPath(ctx.root, "TL"))).toBe(false);
    } finally {
      cap.release();
    }
  });
});
