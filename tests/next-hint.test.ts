import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { runWorklog } from "../src/cli/commands/worklog";
import { runReport } from "../src/cli/commands/report";
import { runRfc } from "../src/cli/commands/rfc";
import { runTask } from "../src/cli/commands/task";
import { runAck } from "../src/cli/commands/ack";
import { runClaim } from "../src/cli/commands/claim";
import type { ParsedArgs } from "../src/cli/argv";

/**
 * `nextLoopHint` is the per-command "Next: another action, or `gojaja
 * plan` / `gojaja wait` ..." reminder appended to the plain-text
 * output of action commands. It exists so an agent that just got back
 * a successful confirmation does not silently end its turn — without
 * a follow-up action or a wait, the role goes dark and the team's
 * loop stops driving forward.
 *
 * The contract these tests pin down:
 *
 *  - Every action-class command prints the hint in plain-text mode.
 *  - The hint is OMITTED in `--json` mode (output must stay a single
 *    parseable JSON object).
 *  - The hint is OMITTED when the actor is SYSTEM (a human running
 *    the CLI does not have a turn to keep alive — same reasoning as
 *    the SYSTEM-allowed `rfc new` / `rfc comment` path).
 *  - `claim` uses a specialised hint pointing the agent at `plan`
 *    (its immediate next step, not "another action").
 *  - `wait` is intentionally NOT covered here — it has its own
 *    verdict-specific Next lines that already cover the same ground.
 */

interface Captured {
  stdout: string;
  release: () => void;
}

function captureStdout(): Captured {
  const cap: Captured = { stdout: "", release: () => undefined };
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (
    c: string,
  ) => {
    cap.stdout += c;
    return true;
  };
  cap.release = () => {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  };
  return cap;
}

const HINT_RE =
  /Next: continue this turn with another action, or run `gojaja plan` \(see new events\) \/ `gojaja wait` \(park until attention\)\. Ending without one stalls the role\./;

async function freshProject() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-hint-"));
  const store = new LocalFsStore(path.join(root, ".gojaja"), { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  await store.createRole({
    id: "PM",
    title: "PM",
    owns: ["state/task_board.yaml"],
  });
  await store.createRole({ id: "Backend", title: "Backend" });
  return { root, store };
}

function args(positional: string[], flags: Record<string, string | boolean>): ParsedArgs {
  return { command: positional[0] ?? "", positional, flags };
}

describe("nextLoopHint", () => {
  let ctx: { root: string; store: LocalFsStore };
  let envOrig: string | undefined;
  beforeEach(async () => {
    ctx = await freshProject();
    envOrig = process.env.GOJAJA_SESSION;
  });
  afterEach(async () => {
    if (envOrig === undefined) delete process.env.GOJAJA_SESSION;
    else process.env.GOJAJA_SESSION = envOrig;
    await fsp.rm(ctx.root, { recursive: true, force: true });
  });

  it("worklog: prints the hint in plain mode and omits it in --json", async () => {
    const s = await ctx.store.claimSession("PM", 60);
    process.env.GOJAJA_SESSION = s.sessionId;

    const cap1 = captureStdout();
    try {
      await runWorklog(
        args([], { message: "shipped login", root: ctx.root }),
      );
      expect(cap1.stdout).toMatch(HINT_RE);
    } finally {
      cap1.release();
    }

    const cap2 = captureStdout();
    try {
      await runWorklog(
        args([], {
          message: "shipped login again",
          json: true,
          root: ctx.root,
        }),
      );
      // JSON mode: stdout must remain a single parseable object.
      const parsed = JSON.parse(cap2.stdout.trim());
      expect(parsed.status).toBe("logged");
      expect(cap2.stdout).not.toMatch(HINT_RE);
    } finally {
      cap2.release();
    }
  });

  it("report: prints the hint in plain mode", async () => {
    const s = await ctx.store.claimSession("PM", 60);
    process.env.GOJAJA_SESSION = s.sessionId;
    const cap = captureStdout();
    try {
      await runReport(
        args([], {
          to: "Backend",
          message: "please pick this up",
          root: ctx.root,
        }),
      );
      expect(cap.stdout).toMatch(HINT_RE);
    } finally {
      cap.release();
    }
  });

  it("ack: prints the stronger ack-specific warning, NOT the soft generic loop hint", async () => {
    const s = await ctx.store.claimSession("PM", 60);
    process.env.GOJAJA_SESSION = s.sessionId;
    // Need a manifest to ack — create one via plan.
    const m = await ctx.store.openOrCreatePlan("PM");
    const cap = captureStdout();
    try {
      await runAck(
        args([], { token: m.ackToken, root: ctx.root }),
      );
      // ack uses a deliberately stronger, command-shaped variant
      // because the most common per-turn failure mode is "agent runs
      // ack, sees success line, sits silent". The generic
      // disjunctive hint was too soft for this case.
      expect(cap.stdout).toMatch(/WARNING: TURN NOT COMPLETE/);
      expect(cap.stdout).toMatch(/ack is a housekeeping op/);
      expect(cap.stdout).toMatch(/`gojaja wait`/);
      expect(cap.stdout).not.toMatch(HINT_RE); // not the generic one
    } finally {
      cap.release();
    }
  });

  it("ack: --json suppresses the warning (JSON output stays single object)", async () => {
    const s = await ctx.store.claimSession("PM", 60);
    process.env.GOJAJA_SESSION = s.sessionId;
    const m = await ctx.store.openOrCreatePlan("PM");
    const cap = captureStdout();
    try {
      await runAck(
        args([], { token: m.ackToken, json: true, root: ctx.root }),
      );
      const parsed = JSON.parse(cap.stdout.trim());
      expect(parsed.status).toBe("acked");
      expect(cap.stdout).not.toMatch(/WARNING: TURN NOT COMPLETE/);
    } finally {
      cap.release();
    }
  });

  it("task new with a SYSTEM caller (no GOJAJA_SESSION) does NOT print the hint", async () => {
    delete process.env.GOJAJA_SESSION;
    const cap = captureStdout();
    try {
      // runTask dispatches on positional[0]; the runner sub-command is
      // the first positional. Outer runTask is the dispatcher.
      await runTask(
        args(["new"], {
          title: "seed task",
          owner: "Backend",
          root: ctx.root,
        }),
      );
      expect(cap.stdout).toContain("Created T-");
      expect(cap.stdout).not.toMatch(HINT_RE);
    } finally {
      cap.release();
    }
  });

  it("task assign with an agent caller prints the hint", async () => {
    delete process.env.GOJAJA_SESSION;
    const t = await ctx.store.createTask({
      title: "task to reassign",
      owner: "Backend",
      actor: "SYSTEM",
    });
    const s = await ctx.store.claimSession("PM", 60);
    process.env.GOJAJA_SESSION = s.sessionId;
    const cap = captureStdout();
    try {
      await runTask(
        args(["assign", t.id], { to: "Backend", root: ctx.root }),
      );
      expect(cap.stdout).toMatch(HINT_RE);
    } finally {
      cap.release();
    }
  });

  it("rfc new with an agent caller prints the hint; --json omits it", async () => {
    const s = await ctx.store.claimSession("PM", 60);
    process.env.GOJAJA_SESSION = s.sessionId;

    const cap1 = captureStdout();
    try {
      await runRfc(
        args(["new", "talk"], {
          title: "Talk",
          deciders: "PM",
          root: ctx.root,
        }),
      );
      expect(cap1.stdout).toMatch(HINT_RE);
    } finally {
      cap1.release();
    }

    const cap2 = captureStdout();
    try {
      await runRfc(
        args(["new", "talk-2"], {
          title: "Talk2",
          deciders: "PM",
          json: true,
          root: ctx.root,
        }),
      );
      const parsed = JSON.parse(cap2.stdout.trim());
      expect(parsed.status).toBe("created");
      expect(cap2.stdout).not.toMatch(HINT_RE);
    } finally {
      cap2.release();
    }
  });

  it("rfc comment as SYSTEM (no session) does NOT print the hint", async () => {
    delete process.env.GOJAJA_SESSION;
    const proposal = await ctx.store.createRfc({
      slug: "ctx",
      title: "ctx",
      voters: ["Backend"],
      deciders: ["PM"],
      options: [],
      createdBy: "SYSTEM",
      description: "",
      relatedTasks: [],
    });
    const cap = captureStdout();
    try {
      await runRfc(
        args(["comment", proposal.id], {
          rationale: "from the user",
          root: ctx.root,
        }),
      );
      expect(cap.stdout).toContain("Recorded comment");
      expect(cap.stdout).not.toMatch(HINT_RE);
    } finally {
      cap.release();
    }
  });

  it("claim prints the specialised plan-pointing hint", async () => {
    const cap = captureStdout();
    try {
      await runClaim(
        args(["PM"], { root: ctx.root }),
      );
      expect(cap.stdout).toMatch(/Next: run `gojaja plan` to read your manifest\./);
    } finally {
      cap.release();
    }
  });
});
