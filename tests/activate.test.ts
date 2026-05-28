import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { runActivate } from "../src/cli/commands/activate";
import type { ParsedArgs } from "../src/cli/argv";

async function freshProject(opts: { fillRoleDescription?: boolean } = {}) {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-activate-"));
  const root = path.join(projectRoot, ".gojaja");
  const store = new LocalFsStore(root, { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  await store.createRole({
    id: "PM",
    title: "Product Manager",
    description: opts.fillRoleDescription
      ? "Owns product scope; sets acceptance criteria; signs off Done."
      : "",
  });
  if (opts.fillRoleDescription) {
    // Overwrite the rendered markdown so it no longer contains TBD.
    // (createRole keeps TBD in the Responsibilities bullet by default;
    // for tests that simulate "user filled it in", we drop that too.)
    const mdPath = path.join(root, "roles/PM.md");
    let md = await fsp.readFile(mdPath, "utf8");
    md = md.replace(/- TBD.*/g, "- Run the product backlog; clarify acceptance.");
    await fsp.writeFile(mdPath, md);
  }
  return { projectRoot, root, store };
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

function args(role: string, flags: Record<string, string | boolean>): ParsedArgs {
  return { command: "activate", positional: [role], flags };
}

describe("gojaja activate", () => {
  let ctx: { projectRoot: string; root: string; store: LocalFsStore };
  afterEach(async () => {
    if (ctx) await fsp.rm(ctx.projectRoot, { recursive: true, force: true });
  });

  it("PR8e: refuses to activate while the role's markdown still has TBD sections", async () => {
    // First-week failure mode: user runs role create + activate without
    // filling roles/<id>.md. The agent gets bound to a role it knows
    // only by id+title and asks the user every trivial question. Block
    // activation outright until TBD is gone.
    ctx = await freshProject(); // description empty -> TBD remains
    await expect(
      runActivate(args("PM", { target: "cursor", root: ctx.projectRoot, "no-copy": true })),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("PR8e: succeeds once TBD is filled, prints divider-framed snippet with 'You are'", async () => {
    ctx = await freshProject({ fillRoleDescription: true });
    const cap = captureStdout();
    try {
      const code = await runActivate(
        args("PM", { target: "cursor", root: ctx.projectRoot, "no-copy": true }),
      );
      expect(code).toBe(0);
      // Second-person framing — the snippet addresses the agent itself.
      expect(cap.stdout).toContain("You are the PM agent");
      expect(cap.stdout).not.toContain("I am the PM agent");
      // Both dividers present (box-drawing characters, distinguishable
      // from markdown noise) and the BEGIN one comes before the END one.
      const begin = cap.stdout.indexOf("BEGIN PASTE TO AGENT");
      const end = cap.stdout.indexOf("END PASTE TO AGENT");
      expect(begin).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(begin);
      // Snippet teaches the agent the right next steps.
      expect(cap.stdout).toContain("gojaja role show PM");
      expect(cap.stdout).toContain("gojaja -h");
      // Uses --eval form so the agent doesn't forget to export.
      expect(cap.stdout).toContain('eval "$(gojaja claim PM --eval)"');
    } finally {
      cap.release();
    }
  });

  it("PR8e: --no-copy explicitly skips clipboard and says so", async () => {
    ctx = await freshProject({ fillRoleDescription: true });
    const cap = captureStdout();
    try {
      await runActivate(
        args("PM", { target: "cursor", root: ctx.projectRoot, "no-copy": true }),
      );
      // Clipboard either succeeded (then we say "copied to clipboard")
      // or failed (then we say "Could not copy"). Neither should appear
      // when the user explicitly said --no-copy.
      expect(cap.stdout).not.toContain("copied to clipboard");
      expect(cap.stdout).not.toContain("Could not copy to clipboard");
      // Should mention skip-due-to-flag so the user knows it was a
      // deliberate choice, not a missing tool.
      expect(cap.stdout).toContain("--no-copy");
    } finally {
      cap.release();
    }
  });

  it("PR8e: JSON output carries copiedToClipboard and clipboardTool fields", async () => {
    ctx = await freshProject({ fillRoleDescription: true });
    const cap = captureStdout();
    try {
      await runActivate(
        args("PM", { target: "cursor", root: ctx.projectRoot, json: true, "no-copy": true }),
      );
      const parsed = JSON.parse(cap.stdout);
      expect(parsed.role).toBe("PM");
      expect(parsed.target).toBe("cursor");
      expect(typeof parsed.activation).toBe("string");
      expect(parsed.copiedToClipboard).toBe(false);
      expect(parsed.clipboardTool).toBeNull();
    } finally {
      cap.release();
    }
  });
});
