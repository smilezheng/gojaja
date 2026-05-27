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
    path.join(root, ".multi-agent"),
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

describe("agentctl claim — role registration gate", () => {
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

  it("Step 4a: --eval prints exactly one `export MA_SESSION=<ulid>` line suitable for shell eval", async () => {
    // Output contract: agent runs `eval "$(agentctl claim PM --eval)"`.
    // Anything other than a single line of `export VAR=value\n` would
    // either fail eval or — worse — get partially interpreted as a
    // chained command. Strict format matters.
    const cap = captureStdio();
    try {
      const code = await runClaim(args("PM", { root: ctx.root, eval: true }));
      expect(code).toBe(0);
      expect(cap.stdout).toMatch(/^export MA_SESSION=[0-9A-Z]{26}\n$/);
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
});
