import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { isUlid } from "../src/core/ids";
import { _writeRawLockForTest } from "../src/core/file-lock";

async function freshStore(): Promise<{ root: string; store: LocalFsStore }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-test-"));
  const store = new LocalFsStore(root);
  await store.initialise("2.0.0-test");
  return { root, store };
}

describe("LocalFsStore.initialise", () => {
  let root: string;

  afterEach(async () => {
    if (root) await fsp.rm(root, { recursive: true, force: true });
  });

  it("creates the canonical directory layout and VERSION", async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-test-"));
    const store = new LocalFsStore(root);
    await store.initialise("2.0.0-test");

    for (const sub of [
      "protocol",
      "roles",
      "state",
      "comms/events",
      "comms/inbox",
      "comms/cursors",
      "comms/pending",
      "comms/sessions",
      "comms/heartbeats",
      "rfcs",
      "worklog",
      "locks",
    ]) {
      const stat = await fsp.stat(path.join(root, sub));
      expect(stat.isDirectory()).toBe(true);
    }
    expect((await fsp.readFile(path.join(root, "VERSION"), "utf8")).trim()).toBe(
      "2.0.0-test",
    );
    expect(await store.isInitialised()).toBe(true);
  });

  it("rejects re-initialisation", async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-test-"));
    const store = new LocalFsStore(root);
    await store.initialise("2.0.0-test");
    await expect(store.initialise("2.0.0-test")).rejects.toMatchObject({
      code: "ALREADY_INITIALIZED",
    });
  });
});

describe("LocalFsStore.appendEvent / listEventsAfter", () => {
  let ctx: { root: string; store: LocalFsStore };

  beforeEach(async () => {
    ctx = await freshStore();
  });
  afterEach(async () => {
    await fsp.rm(ctx.root, { recursive: true, force: true });
  });

  it("assigns ULIDs and lists in order", async () => {
    const e1 = await ctx.store.appendEvent({
      type: "REPORT",
      from: "PM",
      to: "TL",
      payload: { msg: "hello" },
    });
    const e2 = await ctx.store.appendEvent({
      type: "REPORT",
      from: "TL",
      to: "PM",
      payload: { msg: "ack" },
    });
    expect(isUlid(e1.id)).toBe(true);
    expect(isUlid(e2.id)).toBe(true);
    expect(e1.id < e2.id).toBe(true);

    const all = await ctx.store.listEventsAfter("");
    expect(all.map((e) => e.id)).toEqual([e1.id, e2.id]);
  });

  it("survives messages with tabs, newlines and quotes", async () => {
    const ugly = 'line1\nline2\twith tab and "quotes" and \\ backslash';
    const e = await ctx.store.appendEvent({
      type: "REPORT",
      from: "PM",
      to: "TL",
      payload: { msg: ugly },
    });
    const back = await ctx.store.listEventsAfter("");
    expect(back).toHaveLength(1);
    expect(back[0].id).toBe(e.id);
    expect(back[0].payload.msg).toBe(ugly);
  });

  it("filters by afterId exclusively", async () => {
    const e1 = await ctx.store.appendEvent({ type: "SYSTEM", from: "SYSTEM", to: "*", payload: {} });
    const e2 = await ctx.store.appendEvent({ type: "SYSTEM", from: "SYSTEM", to: "*", payload: {} });
    const after1 = await ctx.store.listEventsAfter(e1.id);
    expect(after1.map((e) => e.id)).toEqual([e2.id]);
  });

  it("rejects an invalid cursor", async () => {
    await expect(ctx.store.listEventsAfter("not-a-ulid")).rejects.toMatchObject({
      code: "USAGE",
    });
  });

  it("handles N concurrent writers without losing events", async () => {
    const N = 50;
    const ids = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        ctx.store.appendEvent({
          type: "REPORT",
          from: "PM",
          to: "TL",
          payload: { i },
        }),
      ),
    );
    const uniq = new Set(ids.map((e) => e.id));
    expect(uniq.size).toBe(N);
    const listed = await ctx.store.listEventsAfter("");
    expect(listed.length).toBe(N);
    for (let i = 1; i < listed.length; i++) {
      expect(listed[i - 1].id < listed[i].id).toBe(true);
    }
  });
});

describe("LocalFsStore.updateCursor", () => {
  let ctx: { root: string; store: LocalFsStore };

  beforeEach(async () => {
    ctx = await freshStore();
  });
  afterEach(async () => {
    await fsp.rm(ctx.root, { recursive: true, force: true });
  });

  it("defaults to empty cursor for fresh role", async () => {
    const cur = await ctx.store.readCursor("PM");
    expect(cur.ackedThrough).toBe("");
    expect(cur.pendingManifest).toBeNull();
  });

  it("monotonically advances and refuses going backward", async () => {
    const e1 = await ctx.store.appendEvent({
      type: "SYSTEM", from: "SYSTEM", to: "*", payload: {},
    });
    const e2 = await ctx.store.appendEvent({
      type: "SYSTEM", from: "SYSTEM", to: "*", payload: {},
    });

    await ctx.store.updateCursor("PM", (c) => ({ ...c, ackedThrough: e1.id }));
    await ctx.store.updateCursor("PM", (c) => ({ ...c, ackedThrough: e2.id }));

    await expect(
      ctx.store.updateCursor("PM", (c) => ({ ...c, ackedThrough: e1.id })),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("serialises concurrent updates via per-role lock", async () => {
    // Two writers each "ack +1 event". With a per-role lock the resulting
    // cursor must equal the latest event id; no torn writes.
    const events = await Promise.all(
      Array.from({ length: 10 }, () =>
        ctx.store.appendEvent({ type: "SYSTEM", from: "SYSTEM", to: "*", payload: {} }),
      ),
    );
    const ids = events.map((e) => e.id).sort();
    await Promise.all(
      ids.map((id) =>
        ctx.store.updateCursor("PM", (c) => ({
          ...c,
          ackedThrough: id > c.ackedThrough ? id : c.ackedThrough,
        })),
      ),
    );
    const final = await ctx.store.readCursor("PM");
    expect(final.ackedThrough).toBe(ids[ids.length - 1]);
  });
});

describe("LocalFsStore.claimSession", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("issues a session id and records a SESSION_CLAIMED event", async () => {
    const s = await ctx.store.claimSession("PM", 60);
    expect(s.role).toBe("PM");
    expect(isUlid(s.sessionId)).toBe(true);
    const events = await ctx.store.listEventsAfter("");
    expect(events.some((e) => e.type === "SESSION_CLAIMED" && e.ref === "PM")).toBe(true);
  });

  it("refuses to claim an already-claimed live role", async () => {
    await ctx.store.claimSession("PM", 60);
    await expect(ctx.store.claimSession("PM", 60)).rejects.toMatchObject({
      code: "USAGE",
    });
  });

  it("auto-takes-over when the existing session is past lease TTL", async () => {
    const first = await ctx.store.claimSession("PM", 60);
    // Forge an old heartbeat so the lease is expired.
    const file = path.join(ctx.root, "comms/sessions/PM.json");
    const data = JSON.parse(await fsp.readFile(file, "utf8"));
    data.heartbeatAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    data.leaseTtlSeconds = 60;
    await fsp.writeFile(file, JSON.stringify(data));

    const second = await ctx.store.claimSession("PM", 60);
    expect(second.sessionId).not.toBe(first.sessionId);
    const events = await ctx.store.listEventsAfter("");
    expect(events.some((e) => e.type === "SESSION_TAKEOVER" && e.ref === "PM")).toBe(true);
  });

  it("can be released and re-claimed", async () => {
    const s = await ctx.store.claimSession("PM", 60);
    await ctx.store.releaseSession("PM", s.sessionId);
    const after = await ctx.store.readSession("PM");
    expect(after).toBeNull();
    const s2 = await ctx.store.claimSession("PM", 60);
    expect(s2.sessionId).not.toBe(s.sessionId);
  });

  it("rejects release with the wrong session id", async () => {
    const s = await ctx.store.claimSession("PM", 60);
    await expect(ctx.store.releaseSession("PM", "wrong-id")).rejects.toMatchObject({
      code: "USAGE",
    });
    expect((await ctx.store.readSession("PM"))?.sessionId).toBe(s.sessionId);
  });
});

describe("LocalFsStore.withLock", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("serialises critical sections", async () => {
    const seen: string[] = [];
    async function critical(tag: string): Promise<void> {
      await ctx.store.withLock("test-key", async () => {
        seen.push(`${tag}-enter`);
        await new Promise((r) => setTimeout(r, 30));
        seen.push(`${tag}-leave`);
      });
    }
    await Promise.all([critical("A"), critical("B"), critical("C")]);
    // Every enter must be immediately followed by its own leave (no interleave).
    for (let i = 0; i < seen.length; i += 2) {
      const [tagA] = seen[i].split("-");
      const [tagB] = seen[i + 1].split("-");
      expect(tagA).toBe(tagB);
    }
  });

  it("breaks stale locks and emits LOCK_BROKEN", async () => {
    const lockPath = path.join(ctx.root, "locks", "test-stale.lock");
    await _writeRawLockForTest(lockPath, {
      pid: 0x7fffffff,
      acquiredAt: Date.now() - 5 * 60 * 1000,
      leaseExpiresAt: Date.now() - 60 * 1000,
    });
    const value = await ctx.store.withLock("test-stale", async () => 42);
    expect(value).toBe(42);
    const events = await ctx.store.listEventsAfter("");
    expect(events.some((e) => e.type === "LOCK_BROKEN" && e.ref === "test-stale")).toBe(true);
  });

  it("rejects invalid lock keys", async () => {
    await expect(
      ctx.store.withLock("../escape", async () => 1),
    ).rejects.toMatchObject({ code: "USAGE" });
  });
});

describe("path validation", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("rejects invalid role ids", async () => {
    await expect(ctx.store.readCursor("../etc/passwd")).rejects.toMatchObject({
      code: "USAGE",
    });
    await expect(ctx.store.readCursor("SYSTEM")).rejects.toMatchObject({
      code: "USAGE",
    });
    await expect(ctx.store.readCursor("")).rejects.toMatchObject({
      code: "USAGE",
    });
  });
});
