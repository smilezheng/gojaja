import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { resolveIdentity } from "../src/cli/identity";

async function freshStore() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-id-"));
  const store = new LocalFsStore(root, { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  return { root, store };
}

describe("resolveIdentity", () => {
  let ctx: { root: string; store: LocalFsStore };
  const originalEnv = process.env.GOJAJA_SESSION;
  beforeEach(async () => {
    ctx = await freshStore();
    delete process.env.GOJAJA_SESSION;
  });
  afterEach(async () => {
    if (originalEnv !== undefined) process.env.GOJAJA_SESSION = originalEnv;
    else delete process.env.GOJAJA_SESSION;
    await fsp.rm(ctx.root, { recursive: true, force: true });
  });

  it("uses GOJAJA_SESSION to derive the role", async () => {
    const session = await ctx.store.claimSession("PM", 60);
    process.env.GOJAJA_SESSION = session.sessionId;
    const id = await resolveIdentity(ctx.store, { requireSession: true });
    expect(id.role).toBe("PM");
    expect(id.session?.sessionId).toBe(session.sessionId);
  });

  it("rejects GOJAJA_SESSION that does not match any session", async () => {
    process.env.GOJAJA_SESSION = "01HXBOGUSXBOGUSXBOGUSXBOG1";
    await expect(
      resolveIdentity(ctx.store, { requireSession: true }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("rejects when GOJAJA_SESSION's role disagrees with the explicit role argument", async () => {
    const session = await ctx.store.claimSession("PM", 60);
    process.env.GOJAJA_SESSION = session.sessionId;
    await expect(
      resolveIdentity(ctx.store, { explicitRole: "TL", requireSession: true }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("requires GOJAJA_SESSION when requireSession is true", async () => {
    await expect(
      resolveIdentity(ctx.store, { requireSession: true }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("accepts an explicit role with no session when requireSession is false", async () => {
    const id = await resolveIdentity(ctx.store, {
      explicitRole: "PM",
      requireSession: false,
    });
    expect(id.role).toBe("PM");
    expect(id.session).toBeNull();
  });

  it("refuses a session whose heartbeat is past its lease", async () => {
    const s = await ctx.store.claimSession("PM", 60);
    // Backdate the session's heartbeat past its lease.
    const file = path.join(ctx.root, "comms/sessions/PM.json");
    const data = JSON.parse(await fsp.readFile(file, "utf8"));
    data.heartbeatAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await fsp.writeFile(file, JSON.stringify(data));

    process.env.GOJAJA_SESSION = s.sessionId;
    await expect(
      resolveIdentity(ctx.store, { requireSession: true }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("M3: refuses a session whose heartbeatAt is corrupt (empty / non-parseable)", async () => {
    // Before fix: `if (isFinite(heartbeat) && expired) return null` would
    // skip the expiry check entirely on a NaN heartbeat → corrupt
    // session lives forever and can authenticate. Fix is fail-closed.
    const s = await ctx.store.claimSession("PM", 60);
    const file = path.join(ctx.root, "comms/sessions/PM.json");
    const data = JSON.parse(await fsp.readFile(file, "utf8"));
    data.heartbeatAt = ""; // corrupt
    await fsp.writeFile(file, JSON.stringify(data));

    process.env.GOJAJA_SESSION = s.sessionId;
    await expect(
      resolveIdentity(ctx.store, { requireSession: true }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("refreshes heartbeat on every successful resolveIdentity", async () => {
    const s = await ctx.store.claimSession("PM", 60);
    const fileBefore = path.join(ctx.root, "comms/sessions/PM.json");
    const before = JSON.parse(await fsp.readFile(fileBefore, "utf8"));

    // Wait long enough that timestamps differ.
    await new Promise((r) => setTimeout(r, 20));
    process.env.GOJAJA_SESSION = s.sessionId;
    await resolveIdentity(ctx.store, { requireSession: true });

    const after = JSON.parse(await fsp.readFile(fileBefore, "utf8"));
    expect(Date.parse(after.heartbeatAt)).toBeGreaterThan(
      Date.parse(before.heartbeatAt),
    );
  });
});

describe("resolveActor — strict GOJAJA_SESSION semantics", () => {
  let ctx: { root: string; store: LocalFsStore };
  const originalEnv = process.env.GOJAJA_SESSION;
  beforeEach(async () => {
    ctx = await freshStore();
    delete process.env.GOJAJA_SESSION;
  });
  afterEach(async () => {
    if (originalEnv !== undefined) process.env.GOJAJA_SESSION = originalEnv;
    else delete process.env.GOJAJA_SESSION;
    await fsp.rm(ctx.root, { recursive: true, force: true });
  });

  it("throws USAGE when GOJAJA_SESSION is unset and allowSystemBypass is false (PR9 SYSTEM-1)", async () => {
    // SYSTEM-1: missing session is no longer an implicit SYSTEM signal.
    // The caller must opt in to the bypass explicitly. This closes the
    // hole where any agent process could `unset GOJAJA_SESSION` to
    // promote itself to SYSTEM authority.
    const { resolveActor } = await import("../src/cli/identity");
    await expect(resolveActor(ctx.store)).rejects.toMatchObject({
      code: "USAGE",
    });
    await expect(
      resolveActor(ctx.store, { allowSystemBypass: false }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("returns SYSTEM when GOJAJA_SESSION is unset and allowSystemBypass is true", async () => {
    const { resolveActor } = await import("../src/cli/identity");
    const { actor } = await resolveActor(ctx.store, {
      allowSystemBypass: true,
    });
    expect(actor).toBe("SYSTEM");
  });

  it("returns the role when GOJAJA_SESSION resolves successfully", async () => {
    const { resolveActor } = await import("../src/cli/identity");
    const s = await ctx.store.claimSession("PM", 60);
    process.env.GOJAJA_SESSION = s.sessionId;
    const { actor } = await resolveActor(ctx.store);
    expect(actor).toBe("PM");
  });

  it("returns the role even with allowSystemBypass=true when a session is present", async () => {
    // A live session always wins. `--as-system` is ignored when
    // GOJAJA_SESSION is set, so a careless agent that includes
    // `--as-system` "just in case" does NOT escalate past their
    // own role's ownership gate.
    const { resolveActor } = await import("../src/cli/identity");
    const s = await ctx.store.claimSession("PM", 60);
    process.env.GOJAJA_SESSION = s.sessionId;
    const { actor } = await resolveActor(ctx.store, {
      allowSystemBypass: true,
    });
    expect(actor).toBe("PM");
  });

  it("regression: bogus GOJAJA_SESSION must NOT silently downgrade to SYSTEM", async () => {
    // The previous pattern was `try { resolveIdentity(...) } catch
    // { actor = "SYSTEM" }`, which gave a stale token full ownership
    // bypass. resolveActor must propagate the USAGE error instead.
    // SYSTEM-1 reinforces this: even with allowSystemBypass=true, a
    // stale token still throws (the bypass only kicks in when the
    // env var is UNSET, not when it's set-but-bad).
    const { resolveActor } = await import("../src/cli/identity");
    process.env.GOJAJA_SESSION = "01HXBOGUSXBOGUSXBOGUSXBOG1";
    await expect(resolveActor(ctx.store)).rejects.toMatchObject({
      code: "USAGE",
    });
    await expect(
      resolveActor(ctx.store, { allowSystemBypass: true }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });
});
