import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { isUlid } from "../src/core/ids";

async function freshStore(): Promise<{ root: string; store: LocalFsStore }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-plan-"));
  const store = new LocalFsStore(root);
  await store.initialise("2.0.0-test");
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
    // Empty fields must NOT be serialised — keep manifests tight.
    expect(m1.roleReminder.owns).toBeUndefined();
    expect(m1.roleReminder.mustNotEdit).toBeUndefined();
    expect(m1.roleReminder.reportsTo).toBeUndefined();
  });

  it("reminder picks up config.yaml fields when set, still omits empty ones", async () => {
    await ctx.store.createRole({
      id: "Backend",
      title: "Backend Engineer",
      owns: ["src/api/", "src/db/"],
      reportsTo: ["TL", "PM"],
      mustNotEdit: [], // intentionally empty
    });
    const m = await ctx.store.openOrCreatePlan("Backend");
    expect(m.roleReminder.id).toBe("Backend");
    expect(m.roleReminder.title).toBe("Backend Engineer");
    expect(m.roleReminder.owns).toEqual(["src/api/", "src/db/"]);
    expect(m.roleReminder.reportsTo).toEqual(["TL", "PM"]);
    expect(m.roleReminder.mustNotEdit).toBeUndefined();
  });

  it("reminder serialised size stays small (<300 bytes for a fully-populated reminder)", async () => {
    await ctx.store.createRole({
      id: "Backend",
      title: "Backend Engineer",
      owns: ["src/api/", "src/db/"],
      reportsTo: ["TL"],
      mustNotEdit: ["state/architecture.md"],
    });
    const m = await ctx.store.openOrCreatePlan("Backend");
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
