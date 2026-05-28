import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { runRelease } from "../src/cli/commands/release";

async function freshProject() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-release-"));
  const store = new LocalFsStore(
    path.join(root, ".gojaja"),
    { safetyMarginMs: 0 },
  );
  await store.initialise("2.0.0-test");
  await store.createRole({ id: "PM", title: "Product Manager" });
  return { root, store };
}

interface Captured { stdout: string; release: () => void }
function captureStdout(): Captured {
  const cap: Captured = { stdout: "", release: () => undefined };
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    cap.stdout += chunk;
    return true;
  };
  cap.release = () => {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  };
  return cap;
}

describe("gojaja release", () => {
  let ctx: { root: string; store: LocalFsStore };
  const originalEnv = process.env.GOJAJA_SESSION;
  beforeEach(async () => {
    ctx = await freshProject();
    delete process.env.GOJAJA_SESSION;
  });
  afterEach(async () => {
    if (originalEnv !== undefined) process.env.GOJAJA_SESSION = originalEnv;
    else delete process.env.GOJAJA_SESSION;
    await fsp.rm(ctx.root, { recursive: true, force: true });
  });

  it("Step 10: human output includes an `unset GOJAJA_SESSION` reminder", async () => {
    const s = await ctx.store.claimSession("PM", 60);
    process.env.GOJAJA_SESSION = s.sessionId;
    const cap = captureStdout();
    try {
      const code = await runRelease({
        command: "release",
        positional: [],
        flags: { root: ctx.root },
      });
      expect(code).toBe(0);
      // Subtly important: agents that release but forget to unset get
      // confused on the very next command because the stale session id
      // is still in the env. The hint must be exactly `unset GOJAJA_SESSION`
      // (a shell-runnable line they can copy verbatim).
      expect(cap.stdout).toContain("unset GOJAJA_SESSION");
    } finally {
      cap.release();
    }
  });
});
