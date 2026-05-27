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
});
