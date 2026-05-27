import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { runWait } from "../src/cli/commands/wait";
import type { ParsedArgs } from "../src/cli/argv";

async function freshProject() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-wait-"));
  const store = new LocalFsStore(path.join(root, ".multi-agent"), { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  await store.createRole({ id: "TL", title: "Tech Lead" });
  await store.createRole({ id: "PM", title: "Product Manager" });
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

describe("agentctl wait", () => {
  let ctx: { root: string; store: LocalFsStore };
  let envOrig: string | undefined;
  beforeEach(async () => {
    ctx = await freshProject();
    envOrig = process.env.MA_SESSION;
    const s = await ctx.store.claimSession("TL", 60);
    process.env.MA_SESSION = s.sessionId;
    // Drain baseline events (SESSION_CLAIMED for TL and PM) so wait starts
    // from a clean cursor, matching the real per-turn pattern.
    const m = await ctx.store.openOrCreatePlan("TL");
    await ctx.store.ackManifest("TL", m.ackToken);
  });
  afterEach(async () => {
    if (envOrig === undefined) delete process.env.MA_SESSION;
    else process.env.MA_SESSION = envOrig;
    await fsp.rm(ctx.root, { recursive: true, force: true });
  });

  it("block mode with no events returns IDLE", async () => {
    const cap = captureStdio();
    try {
      const code = await runWait(args("TL", { "idle-seconds": "1", root: ctx.root }));
      expect(code).toBe(0);
      expect(cap.stdout).toContain("IDLE");
      expect(cap.stdout).toContain("role=TL");
      expect(cap.stdout).toContain("newEvents=0");
    } finally {
      cap.release();
    }
  });

  it("block mode notices an event that arrived during the wait", async () => {
    const cap = captureStdio();
    try {
      const t = runWait(args("TL", { "idle-seconds": "2", root: ctx.root }));
      // Inject an event mid-wait. Use a separate role as the sender so the
      // self-filter does not hide it.
      setTimeout(() => {
        void ctx.store.publishReport({ from: "PM", to: "TL", message: "ping" });
      }, 250);
      const code = await t;
      expect(code).toBe(0);
      expect(cap.stdout).toContain("ATTENTION");
      expect(cap.stdout).toContain("newEvents=1");
    } finally {
      cap.release();
    }
  });

  it("exit mode writes the .wait sentinel and returns immediately", async () => {
    const cap = captureStdio();
    try {
      const before = Date.now();
      const code = await runWait(args("TL", { mode: "exit", root: ctx.root }));
      const elapsed = Date.now() - before;
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(500);
      const sentinel = await fsp.readFile(
        path.join(ctx.root, ".multi-agent", "comms", "pending", "TL", ".wait"),
        "utf8",
      );
      expect(sentinel).toContain('"mode": "exit"');
      expect(cap.stdout).toContain(".wait");
    } finally {
      cap.release();
    }
  });

  it("block mode does not move the cursor", async () => {
    const cap = captureStdio();
    try {
      const before = await ctx.store.readCursor("TL");
      // Publish then wait briefly; cursor still must not move.
      await ctx.store.publishReport({ from: "PM", to: "TL", message: "x" });
      await runWait(args("TL", { "idle-seconds": "1", root: ctx.root }));
      const after = await ctx.store.readCursor("TL");
      expect(after.ackedThrough).toBe(before.ackedThrough);
      expect(after.pendingManifest).toBe(before.pendingManifest);
    } finally {
      cap.release();
    }
  });

  it("rejects unknown --mode", async () => {
    const cap = captureStdio();
    try {
      await expect(
        runWait(args("TL", { mode: "bogus", root: ctx.root })),
      ).rejects.toMatchObject({ code: "USAGE" });
    } finally {
      cap.release();
    }
  });

  it("regression H-04: refuses block mode when a plan manifest is outstanding", async () => {
    // Set up: emit an event, plan (creates pending manifest), then wait
    // WITHOUT acking. Without the fix the count is computed against the
    // pre-plan cursor; every event in the manifest is counted again and
    // wait returns ATTENTION forever, looping the agent.
    await ctx.store.publishReport({ from: "PM", to: "TL", message: "ping" });
    await ctx.store.openOrCreatePlan("TL");

    const cap = captureStdio();
    try {
      await expect(
        runWait(args("TL", { "idle-seconds": "0", root: ctx.root })),
      ).rejects.toMatchObject({ code: "USAGE" });
      // The error message must steer the agent to ack first.
      expect(cap.stderr + cap.stdout).not.toContain("ATTENTION");
    } finally {
      cap.release();
    }
  });
});
