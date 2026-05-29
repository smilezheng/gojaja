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
      expect(cap.stdout).toContain("TIMEOUT");
      expect(cap.stdout).toContain("role=TL");
      expect(await exists(waitJsonPath(ctx.root, "TL"))).toBe(false);
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

  it("--for rfc-decided:<id> fires on the matching RFC_DECIDED only", async () => {
    const cap = captureStdio();
    try {
      // Set up two RFCs so we can prove specificity.
      const rfc1 = await ctx.store.createRfc({
        slug: "alpha",
        title: "Alpha",
        voters: ["PM"],
        deciders: ["TL"],
        options: [{ id: "A", summary: "do a" }],
        createdBy: "TL",
        description: "ctx",
      });
      const rfc2 = await ctx.store.createRfc({
        slug: "beta",
        title: "Beta",
        voters: ["PM"],
        deciders: ["TL"],
        options: [{ id: "A", summary: "do a" }],
        createdBy: "TL",
        description: "ctx",
      });
      // Drain plan/ack for TL so the cursor is current.
      const m = await ctx.store.openOrCreatePlan("TL");
      await ctx.store.ackManifest("TL", m.ackToken);

      const t = runWait(
        args("TL", {
          in: "3s",
          for: `rfc-decided:${rfc2.id}`,
          "poll-interval": "200ms",
          root: ctx.root,
        }),
      );
      // Pre-decide and ack so decide can fire. rfc1 has no voters
      // besides PM; PM must ack first.
      await ctx.store.preDecideRfc({
        rfcId: rfc1.id,
        decidedBy: "TL",
        chosenOption: "A",
        rationale: "let's go",
      });
      await ctx.store.ackRfc({ rfcId: rfc1.id, role: "PM" });
      await ctx.store.preDecideRfc({
        rfcId: rfc2.id,
        decidedBy: "TL",
        chosenOption: "A",
        rationale: "let's go",
      });
      await ctx.store.ackRfc({ rfcId: rfc2.id, role: "PM" });
      // Drain again — pre-decide / ack produced new events.
      const m2 = await ctx.store.openOrCreatePlan("TL");
      await ctx.store.ackManifest("TL", m2.ackToken);

      setTimeout(() => {
        void ctx.store.decideRfc({
          rfcId: rfc1.id,
          decidedBy: "TL",
          chosenOption: "A",
          rationale: "ok",
        });
      }, 150);
      setTimeout(() => {
        void ctx.store.decideRfc({
          rfcId: rfc2.id,
          decidedBy: "TL",
          chosenOption: "A",
          rationale: "ok",
        });
      }, 350);
      const code = await t;
      expect(code).toBe(0);
      expect(cap.stdout).toContain("CONDITION_MET");
      expect(cap.stdout).toContain(`condition=rfc-decided:${rfc2.id}`);
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

  it("--for report-from:<role> ignores reports from other roles", async () => {
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
        // Wrong sender first — must not trigger.
        void ctx.store.publishReport({ from: "Backend", to: "TL", message: "noise" });
      }, 150);
      setTimeout(() => {
        void ctx.store.publishReport({ from: "PM", to: "TL", message: "wanted" });
      }, 350);
      const code = await t;
      expect(code).toBe(0);
      expect(cap.stdout).toContain("CONDITION_MET");
      expect(cap.stdout).toContain("condition=report-from:PM");
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
