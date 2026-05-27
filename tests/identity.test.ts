import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { resolveIdentity } from "../src/cli/identity";

async function freshStore() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-id-"));
  const store = new LocalFsStore(root);
  await store.initialise("2.0.0-test");
  return { root, store };
}

describe("resolveIdentity", () => {
  let ctx: { root: string; store: LocalFsStore };
  const originalEnv = process.env.MA_SESSION;
  beforeEach(async () => {
    ctx = await freshStore();
    delete process.env.MA_SESSION;
  });
  afterEach(async () => {
    if (originalEnv !== undefined) process.env.MA_SESSION = originalEnv;
    else delete process.env.MA_SESSION;
    await fsp.rm(ctx.root, { recursive: true, force: true });
  });

  it("uses MA_SESSION to derive the role", async () => {
    const session = await ctx.store.claimSession("PM", 60);
    process.env.MA_SESSION = session.sessionId;
    const id = await resolveIdentity(ctx.store, { requireSession: true });
    expect(id.role).toBe("PM");
    expect(id.session?.sessionId).toBe(session.sessionId);
  });

  it("rejects MA_SESSION that does not match any session", async () => {
    process.env.MA_SESSION = "01HXBOGUSXBOGUSXBOGUSXBOG1";
    await expect(
      resolveIdentity(ctx.store, { requireSession: true }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("rejects when MA_SESSION's role disagrees with the explicit role argument", async () => {
    const session = await ctx.store.claimSession("PM", 60);
    process.env.MA_SESSION = session.sessionId;
    await expect(
      resolveIdentity(ctx.store, { explicitRole: "TL", requireSession: true }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("requires MA_SESSION when requireSession is true", async () => {
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
});
