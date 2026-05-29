import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { runClaim } from "../src/cli/commands/claim";
import type { ParsedArgs } from "../src/cli/argv";

async function freshProject() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-claim-"));
  const store = new LocalFsStore(
    path.join(root, ".gojaja"),
    { safetyMarginMs: 0 },
  );
  await store.initialise("2.0.0-test");
  await store.createRole({ id: "PM", title: "Product Manager" });
  return { root, store };
}

function args(role: string, flags: Record<string, string | boolean>): ParsedArgs {
  return { command: "claim", positional: [role], flags };
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

describe("gojaja claim — role registration gate", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshProject(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("registered role can be claimed", async () => {
    const cap = captureStdio();
    try {
      const code = await runClaim(args("PM", { root: ctx.root, json: true }));
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.stdout);
      expect(parsed.session.role).toBe("PM");
    } finally {
      cap.release();
    }
  });

  it("unregistered role is refused with a hint to create it first", async () => {
    // Without the gate, `claim Frontend` would silently create a session
    // for a role that no manifest can route to — agent waits forever for
    // tasks it can never receive.
    const cap = captureStdio();
    try {
      await expect(
        runClaim(args("Frontend", { root: ctx.root })),
      ).rejects.toMatchObject({ code: "USAGE" });
    } finally {
      cap.release();
    }
  });

  it("Step 4a: --eval prints exactly one `export GOJAJA_SESSION=<ulid>` line suitable for shell eval", async () => {
    // Output contract: agent runs `eval "$(gojaja claim PM --eval)"`.
    // Anything other than a single line of `export VAR=value\n` would
    // either fail eval or — worse — get partially interpreted as a
    // chained command. Strict format matters.
    const cap = captureStdio();
    try {
      const code = await runClaim(args("PM", { root: ctx.root, eval: true }));
      expect(code).toBe(0);
      expect(cap.stdout).toMatch(/^export GOJAJA_SESSION=[0-9A-Z]{26}\n$/);
      expect(cap.stderr).toBe("");
    } finally {
      cap.release();
    }
  });

  it("Step 4b: claim against a live peer does NOT advertise --force in the error", async () => {
    // First claim succeeds.
    const cap1 = captureStdio();
    try {
      await runClaim(args("PM", { root: ctx.root, json: true }));
    } finally {
      cap1.release();
    }
    // Second claim against the same live role: error message must NOT
    // mention `--force` (LLM agents reflexively retry with --force,
    // silently killing the peer). It MUST tell the agent to ask the
    // user.
    const cap2 = captureStdio();
    try {
      await runClaim(args("PM", { root: ctx.root }));
      throw new Error("expected to throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain("--force");
      expect(msg).toMatch(/ask the user/i);
    } finally {
      cap2.release();
    }
  });

  it("--session <id>: matches the live session → idempotent, re-exports the same id", async () => {
    // First claim mints a session.
    const s = await ctx.store.claimSession("PM", 60);
    const captured = captureStdio();
    try {
      // Second claim with the matching session id — recovery path.
      // Must NOT mint a new session, NOT emit a SESSION_CLAIMED /
      // SESSION_TAKEOVER event, and the --eval output must export
      // exactly the original id.
      const code = await runClaim(
        args("PM", { root: ctx.root, eval: true, session: s.sessionId }),
      );
      expect(code).toBe(0);
      expect(captured.stdout).toBe(
        `export GOJAJA_SESSION=${s.sessionId}\n`,
      );
      // Confirm no new SESSION_CLAIMED / SESSION_TAKEOVER event landed
      // (recovery is a no-op on the audit stream).
      const events = await ctx.store.listEventsAfter("");
      const sessionEvents = events.filter(
        (e) =>
          e.type === "SESSION_CLAIMED" || e.type === "SESSION_TAKEOVER",
      );
      // Just the original CLAIMED, nothing else.
      expect(sessionEvents).toHaveLength(1);
      expect(sessionEvents[0].type).toBe("SESSION_CLAIMED");
    } finally {
      captured.release();
    }
  });

  it("--session <id>: mismatch with a live session is REFUSED (does not silently take over)", async () => {
    // Original claim mints a session.
    await ctx.store.claimSession("PM", 60);
    // A second window comes in with a DIFFERENT id, claiming "I'm
    // the rightful owner". The store must refuse — this is exactly
    // the situation where silent takeover would kill a peer.
    const cap = captureStdio();
    try {
      await expect(
        runClaim(
          args("PM", {
            root: ctx.root,
            session: "01HBOGUSBOGUSBOGUSBOGUSBOG",
          }),
        ),
      ).rejects.toMatchObject({ code: "USAGE" });
    } finally {
      cap.release();
    }
  });

  it("--session <id>: id pointing at an expired/missing session falls through to a fresh claim", async () => {
    // No live session for PM. The recovery hint is harmless here —
    // there is nothing alive to recover, so we mint a new one. This
    // matches what an agent retrying after a long absence would
    // naturally expect (a new id, not an error).
    const cap = captureStdio();
    try {
      const code = await runClaim(
        args("PM", {
          root: ctx.root,
          session: "01HBOGUSBOGUSBOGUSBOGUSBOG",
          eval: true,
        }),
      );
      expect(code).toBe(0);
      // The exported id is NEW (not the bogus one we passed).
      const m = cap.stdout.match(/^export GOJAJA_SESSION=([0-9A-Z]{26})\n$/);
      expect(m).not.toBeNull();
      expect(m![1]).not.toBe("01HBOGUSBOGUSBOGUSBOGUSBOG");
    } finally {
      cap.release();
    }
  });

  it("--session and --force are mutually exclusive (USAGE)", async () => {
    const cap = captureStdio();
    try {
      await expect(
        runClaim(
          args("PM", {
            root: ctx.root,
            session: "01HBOGUSBOGUSBOGUSBOGUSBOG",
            force: true,
          }),
        ),
      ).rejects.toMatchObject({ code: "USAGE" });
    } finally {
      cap.release();
    }
  });

  it("the live-peer error names the recovery path with `--session <id>` so agents see it", async () => {
    // Empirically the most common claim failure is "agent lost
    // GOJAJA_SESSION and tried to re-claim". The error must put the
    // recovery path (re-export the previous id with --session) FIRST,
    // ahead of the human-only --force path; otherwise agents collapse
    // straight to "ask the user" and the human gets pinged for every
    // context-loss.
    await ctx.store.claimSession("PM", 60);
    try {
      await runClaim(args("PM", { root: ctx.root }));
      throw new Error("expected to throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/--session/);
      expect(msg).toMatch(/recover/i);
      expect(msg).toMatch(/chat history/i);
    }
  });
});
