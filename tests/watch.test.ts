import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { buildSnapshot } from "../src/cli/commands/watch";

/**
 * The dashboard's most operator-actionable signal is `healthStatus`
 * — and specifically the `"stalled-no-wait"` value, which surfaces
 * the empirically most common per-turn failure mode: an agent runs
 * `gojaja ack`, sees the success line, and sits silent waiting for
 * user input (live session, no wait.json, no recent action). The
 * dashboard exists in large part to give the human-as-scheduler one
 * place to spot this and nudge.
 *
 * These tests pin the derivation rules; the dashboard.html
 * rendering is not unit-tested (it's an offline-friendly
 * single-file template; visual regression tests belong elsewhere).
 */
async function freshStore() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-watch-"));
  const store = new LocalFsStore(root, { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  await store.createRole({ id: "PM", title: "PM" });
  await store.createRole({ id: "Backend", title: "Backend" });
  return { root, store };
}

describe("watch buildSnapshot — healthStatus derivation", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("no session -> 'no-session'", async () => {
    const snap = await buildSnapshot(ctx.store, ctx.root, 60_000);
    const pm = snap.roles.find((r) => r.id === "PM")!;
    expect(pm.healthStatus).toBe("no-session");
  });

  it("live session + wait.json -> 'waiting' (the green path)", async () => {
    await ctx.store.claimSession("PM", 60);
    await ctx.store.writeWaitState({
      role: "PM",
      deadline: new Date(Date.now() + 60_000).toISOString(),
      for: { kind: "attention" },
      startedAt: new Date().toISOString(),
      ackedThroughAtStart: "",
      idleBroadcastSent: false,
    });
    const snap = await buildSnapshot(ctx.store, ctx.root, 60_000);
    const pm = snap.roles.find((r) => r.id === "PM")!;
    expect(pm.healthStatus).toBe("waiting");
  });

  it("live session, no wait.json, no events at all -> 'active' (the role just claimed)", async () => {
    await ctx.store.claimSession("PM", 60);
    const snap = await buildSnapshot(ctx.store, ctx.root, 60_000);
    const pm = snap.roles.find((r) => r.id === "PM")!;
    // No events authored by PM yet, so lastActionAgeMs is null and
    // the threshold check defaults to "active" (we are not yet
    // certain the role is stalled — they just started).
    expect(pm.lastActionAgeMs).toBeNull();
    expect(pm.healthStatus).toBe("active");
  });

  it("live session, no wait.json, last action recent -> 'active'", async () => {
    await ctx.store.claimSession("PM", 60);
    await ctx.store.publishWorklog({ from: "PM", message: "starting" });
    const snap = await buildSnapshot(ctx.store, ctx.root, 60_000);
    const pm = snap.roles.find((r) => r.id === "PM")!;
    expect(pm.healthStatus).toBe("active");
    expect(pm.lastActionAgeMs).toBeGreaterThanOrEqual(0);
  });

  it("live session, no wait.json, last action older than threshold -> 'stalled-no-wait'", async () => {
    await ctx.store.claimSession("PM", 60);
    await ctx.store.publishWorklog({ from: "PM", message: "long ago" });
    // Use a very small threshold so the just-emitted worklog
    // immediately qualifies as "old".
    const snap = await buildSnapshot(ctx.store, ctx.root, 1);
    const pm = snap.roles.find((r) => r.id === "PM")!;
    expect(pm.healthStatus).toBe("stalled-no-wait");
    expect(pm.lastActionAgeMs).toBeGreaterThanOrEqual(0);
    // Counts roll up so the header chip can show a quick total.
    expect(snap.counts.stalledRoles).toBeGreaterThanOrEqual(1);
  });

  it("a role parked on `wait` is NEVER flagged stalled, even if last action is ancient", async () => {
    await ctx.store.claimSession("PM", 60);
    await ctx.store.publishWorklog({ from: "PM", message: "long ago" });
    await ctx.store.writeWaitState({
      role: "PM",
      deadline: new Date(Date.now() + 60_000).toISOString(),
      for: { kind: "attention" },
      startedAt: new Date().toISOString(),
      ackedThroughAtStart: "",
      idleBroadcastSent: false,
    });
    const snap = await buildSnapshot(ctx.store, ctx.root, 1);
    const pm = snap.roles.find((r) => r.id === "PM")!;
    expect(pm.healthStatus).toBe("waiting");
  });

  it("SYSTEM-authored events do not count as the role's lastAction", async () => {
    // A human running `task new` from a SYSTEM shell creates events
    // with `from: "SYSTEM"`. Those should not register as a role's
    // own action — we are tracking whether the agent itself made
    // progress this turn.
    await ctx.store.claimSession("PM", 60);
    // Create a SYSTEM-authored task; this does NOT update PM's
    // lastActionAgeMs.
    await ctx.store.createTask({
      title: "x",
      owner: "PM",
      actor: "SYSTEM",
    });
    const snap = await buildSnapshot(ctx.store, ctx.root, 60_000);
    const pm = snap.roles.find((r) => r.id === "PM")!;
    expect(pm.lastActionAgeMs).toBeNull();
    expect(pm.healthStatus).toBe("active");
  });

  it("snapshot.config echoes the threshold so the UI can label what triggered red", async () => {
    const snap = await buildSnapshot(ctx.store, ctx.root, 12_345);
    expect(snap.config.stalledThresholdMs).toBe(12_345);
  });
});
