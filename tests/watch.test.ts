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

// ---- HTTP endpoints (write surface, loopback-only) ------------------

describe("watch HTTP server — Actions endpoints (loopback-gated)", () => {
  let ctx: { root: string; store: LocalFsStore };
  let envOrig: string | undefined;
  beforeEach(async () => {
    ctx = await freshStore();
    // The Actions endpoints write as `actor: "SYSTEM"`; that path is
    // gated by `resolveActor` returning SYSTEM iff GOJAJA_SESSION is
    // unset. Start each test with a clean env so a stray session from
    // some other suite cannot accidentally promote our calls.
    envOrig = process.env.GOJAJA_SESSION;
    delete process.env.GOJAJA_SESSION;
  });
  afterEach(async () => {
    if (envOrig === undefined) delete process.env.GOJAJA_SESSION;
    else process.env.GOJAJA_SESSION = envOrig;
    await fsp.rm(ctx.root, { recursive: true, force: true });
  });

  /**
   * Spin up the real HTTP server bound to a fresh ephemeral port on
   * 127.0.0.1, run the test against it, then close. Keeping
   * end-to-end so the loopback gate / JSON parsing / error mapping
   * actually run as wired in `runWatch`.
   */
  async function withServer<T>(
    host: "127.0.0.1" | "0.0.0.0",
    body: (origin: string) => Promise<T>,
  ): Promise<T> {
    // Re-import the server-bootstrapping helpers via runWatch's
    // private surface would be brittle; instead spin a tiny inline
    // server using the same handler. We import handleRequest by
    // exporting it as part of the buildSnapshot surface — but it is
    // module-private. So we exercise the full runWatch wiring is
    // overkill here; we use createServer with a thin shim that
    // matches the real wiring 1:1 (kept identical to runWatch).
    const http = await import("node:http");
    const watch = await import("../src/cli/commands/watch");
    // The exported buildSnapshot proves the module loads; we only
    // need handleRequest's behaviour. Instead of exporting the
    // private handler we ship a minimal server here that mirrors
    // the production switch on method+path. In practice the
    // production handler IS what we want to exercise; export it for
    // testability.
    const handleRequest = (
      watch as unknown as {
        __test_handleRequest: (
          req: import("node:http").IncomingMessage,
          res: import("node:http").ServerResponse,
          store: LocalFsStore,
          root: string,
          host: string,
        ) => Promise<void>;
      }
    ).__test_handleRequest;
    if (!handleRequest) {
      throw new Error(
        "watch.ts must export `__test_handleRequest` for the watch HTTP test " +
          "to exercise the real server logic.",
      );
    }
    const server = http.createServer((req, res) => {
      handleRequest(req, res, ctx.store, ctx.root, host).catch((err) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String((err as Error)?.message ?? err) }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    const addr = server.address();
    const port =
      typeof addr === "object" && addr ? addr.port : 0;
    const origin = `http://${host}:${port}`;
    try {
      return await body(origin);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("GET /api/state on a loopback bind reports capabilities.writeEnabled = true", async () => {
    await withServer("127.0.0.1", async (origin) => {
      const r = await fetch(`${origin}/api/state`);
      expect(r.ok).toBe(true);
      const body = (await r.json()) as { capabilities: { writeEnabled: boolean } };
      expect(body.capabilities.writeEnabled).toBe(true);
    });
  });

  it("GET /api/state on a non-loopback bind reports capabilities.writeEnabled = false", async () => {
    await withServer("0.0.0.0", async (origin) => {
      const r = await fetch(`${origin}/api/state`);
      expect(r.ok).toBe(true);
      const body = (await r.json()) as { capabilities: { writeEnabled: boolean } };
      expect(body.capabilities.writeEnabled).toBe(false);
    });
  });

  it("POST /api/report (loopback) emits a REPORT event with from=SYSTEM", async () => {
    await withServer("127.0.0.1", async (origin) => {
      const r = await fetch(`${origin}/api/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "Backend", message: "please ship" }),
      });
      expect(r.ok).toBe(true);
      const body = (await r.json()) as {
        status: string;
        event: { type: string; from: string; to: string };
      };
      expect(body.status).toBe("reported");
      expect(body.event.type).toBe("REPORT");
      expect(body.event.from).toBe("SYSTEM");
      expect(body.event.to).toBe("Backend");
    });
  });

  it("POST /api/report from a non-loopback bind is refused with 403", async () => {
    await withServer("0.0.0.0", async (origin) => {
      const r = await fetch(`${origin}/api/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "Backend", message: "x" }),
      });
      expect(r.status).toBe(403);
      const body = (await r.json()) as { error: string };
      expect(body.error).toMatch(/loopback/);
    });
  });

  it("POST /api/report with missing fields returns 400 USAGE", async () => {
    await withServer("127.0.0.1", async (origin) => {
      const r = await fetch(`${origin}/api/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "Backend" }),
      });
      expect(r.status).toBe(400);
      const body = (await r.json()) as { error: string; errorCode: string };
      expect(body.errorCode).toBe("USAGE");
      expect(body.error).toMatch(/message/);
    });
  });

  it("POST /api/report with an unregistered recipient surfaces the store's USAGE error", async () => {
    await withServer("127.0.0.1", async (origin) => {
      const r = await fetch(`${origin}/api/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "Forntend", message: "x" }),
      });
      expect(r.status).toBe(400);
      const body = (await r.json()) as { error: string; errorCode: string };
      expect(body.errorCode).toBe("USAGE");
      expect(body.error).toMatch(/Forntend/);
    });
  });

  it("POST /api/rfc creates a SYSTEM-authored RFC", async () => {
    await withServer("127.0.0.1", async (origin) => {
      const r = await fetch(`${origin}/api/rfc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "via-watch",
          title: "From the dashboard",
          deciders: ["PM"],
          options: [{ id: "A", summary: "do" }],
          description: "ctx",
        }),
      });
      expect(r.ok).toBe(true);
      const body = (await r.json()) as {
        status: string;
        proposal: { createdBy: string; status: string };
      };
      expect(body.status).toBe("created");
      expect(body.proposal.createdBy).toBe("SYSTEM");
      expect(body.proposal.status).toBe("open");
    });
  });

  it("POST /api/task creates a SYSTEM-authored task", async () => {
    await withServer("127.0.0.1", async (origin) => {
      const r = await fetch(`${origin}/api/task`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Spike X",
          owner: "Backend",
          priority: "P1",
          acceptance: "Spike report attached.",
        }),
      });
      expect(r.ok).toBe(true);
      const body = (await r.json()) as {
        status: string;
        task: { creator: string; owner: string; priority: string };
      };
      expect(body.status).toBe("created");
      expect(body.task.creator).toBe("SYSTEM");
      expect(body.task.owner).toBe("Backend");
      expect(body.task.priority).toBe("P1");
    });
  });
});
