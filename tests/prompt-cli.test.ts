import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { runPrompt } from "../src/cli/commands/prompt";
import type { ParsedArgs } from "../src/cli/argv";

async function freshProject() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-prompt-cli-"));
  const store = new LocalFsStore(
    path.join(root, ".multi-agent"),
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

function args(flags: Record<string, string | boolean>): ParsedArgs {
  return { command: "prompt", positional: [], flags };
}

describe("agentctl prompt", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshProject(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("PR8d: --write success prints the window-restart caveat", async () => {
    // First-run mistake: user runs `prompt --write` AFTER opening the
    // agent window. Cursor / Claude / Codex inject rule files into the
    // system prompt only at window-open time, so the freshly installed
    // rule has no effect in the existing window. Surfacing this on
    // every successful write removes the silent failure mode.
    const cap = captureStdout();
    try {
      const code = await runPrompt(args({ target: "cursor", write: true, root: ctx.root }));
      expect(code).toBe(0);
      expect(cap.stdout).toContain("restart it before chatting");
      expect(cap.stdout).toContain("WROTE");
    } finally {
      cap.release();
    }
  });

  it("PR8d: --write second run shows UNCHANGED (already up to date), not SKIPPED", async () => {
    // Wording matters: 'SKIPPED' reads as 'the tool refused to do
    // anything for some opaque reason'. 'UNCHANGED (already up to
    // date)' reads as 'this is the expected idempotent state'.
    {
      const cap = captureStdout();
      try { await runPrompt(args({ target: "cursor", write: true, root: ctx.root })); }
      finally { cap.release(); }
    }
    const cap = captureStdout();
    try {
      const code = await runPrompt(args({ target: "cursor", write: true, root: ctx.root }));
      expect(code).toBe(0);
      expect(cap.stdout).toContain("UNCHANGED");
      expect(cap.stdout).toContain("already up to date");
      expect(cap.stdout).not.toContain("SKIPPED");
      // Restart caveat should NOT fire when nothing actually changed —
      // the live window's system prompt already has the same bytes.
      expect(cap.stdout).not.toContain("restart it before chatting");
      // Instead, show the force-rewrite tip.
      expect(cap.stdout).toContain("--force-rewrite");
    } finally {
      cap.release();
    }
  });

  it("PR8d: --write --force-rewrite re-installs even when bytes match", async () => {
    {
      const cap = captureStdout();
      try { await runPrompt(args({ target: "cursor", write: true, root: ctx.root })); }
      finally { cap.release(); }
    }
    const cap = captureStdout();
    try {
      const code = await runPrompt(args({
        target: "cursor", write: true, "force-rewrite": true, root: ctx.root,
      }));
      expect(code).toBe(0);
      expect(cap.stdout).toContain("WROTE");
      expect(cap.stdout).not.toContain("UNCHANGED");
      // Force-rewrite did write, so the restart caveat is relevant.
      expect(cap.stdout).toContain("restart it before chatting");
    } finally {
      cap.release();
    }
  });

  it("PR8d: --force-rewrite without --write is a usage error", async () => {
    await expect(
      runPrompt(args({ target: "cursor", "force-rewrite": true, root: ctx.root })),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("PR8d: JSON output carries requiresWindowRestart matching whether any file was written", async () => {
    // First run: at least one file wrote → requiresWindowRestart true.
    {
      const cap = captureStdout();
      try {
        await runPrompt(args({ target: "cursor", write: true, json: true, root: ctx.root }));
        const parsed = JSON.parse(cap.stdout);
        expect(parsed.requiresWindowRestart).toBe(true);
      } finally { cap.release(); }
    }
    // Second run: no file changed → requiresWindowRestart false.
    {
      const cap = captureStdout();
      try {
        await runPrompt(args({ target: "cursor", write: true, json: true, root: ctx.root }));
        const parsed = JSON.parse(cap.stdout);
        expect(parsed.requiresWindowRestart).toBe(false);
      } finally { cap.release(); }
    }
  });
});
