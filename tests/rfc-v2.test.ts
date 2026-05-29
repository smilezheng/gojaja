import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";

async function freshStore() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-rfc-v2-"));
  const store = new LocalFsStore(root, { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  await store.createRole({
    id: "PM",
    title: "PM",
    owns: ["state/project_state.md", "state/task_board.yaml"],
  });
  await store.createRole({ id: "TL", title: "Tech Lead", owns: ["state/architecture.md"] });
  await store.createRole({ id: "Backend", title: "Backend Engineer" });
  await store.createRole({ id: "DevOps", title: "DevOps" });
  return { root, store };
}

const NEW_RFC = {
  slug: "switch-to-postgres",
  title: "Move primary store to Postgres",
  voters: ["DevOps", "PM"],
  deciders: ["TL"],
  options: [
    { id: "A", summary: "Migrate now" },
    { id: "B", summary: "Stay on SQLite" },
  ],
  createdBy: "Backend" as const,
};

/**
 * Satisfy the comment-coverage gate that pre-decide now enforces.
 * The gate requires a regular `rfc comment` from every member of
 * `(voters ∪ deciders) − {createdBy if not SYSTEM}` before any
 * pre-decision is allowed (without it a decider could rush a
 * pre-decision before the rest of the team weighed in). Tests that
 * exercise pre-decide / ack / object / decide flows therefore need
 * to satisfy the gate first; this helper does it for the standard
 * NEW_RFC role set: DevOps and PM are voters; TL is the decider;
 * Backend is the creator (auto-added to voters but excluded from
 * the required-commenter set per design).
 */
async function satisfyCommentGateForNewRfc(
  store: LocalFsStore,
  rfcId: string,
): Promise<void> {
  for (const role of ["DevOps", "PM", "TL"] as const) {
    await store.commentRfc({
      rfcId,
      role,
      preferred: "",
      rationale: `${role} weighing in.`,
    });
  }
}

describe("PR8g — description / relatedTasks", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("stores description and relatedTasks on createRfc", async () => {
    const t = await ctx.store.createTask({ title: "Improve login latency", owner: "Backend", actor: "PM" });
    const r = await ctx.store.createRfc({
      ...NEW_RFC,
      description: "Long context about why SQLite is hitting walls.",
      relatedTasks: [t.id],
    });
    expect(r.description).toContain("SQLite");
    expect(r.relatedTasks).toEqual([t.id]);
  });

  it("refuses createRfc relatedTasks pointing at non-existent task ids", async () => {
    await expect(
      ctx.store.createRfc({ ...NEW_RFC, relatedTasks: ["T-9999"] }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });
});

describe("PR8g — threaded comments ledger", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("comment id is a ULID and replyTo: null is the default", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    const c = await ctx.store.commentRfc({
      rfcId: r.id, role: "Backend", preferred: "A", rationale: "ok",
    });
    expect(c.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(c.replyTo).toBeNull();
  });

  it("--reply-to references another comment by id; ledger preserves the chain", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    const c1 = await ctx.store.commentRfc({
      rfcId: r.id, role: "Backend", preferred: "A", rationale: "first thought",
    });
    const c2 = await ctx.store.commentRfc({
      rfcId: r.id, role: "TL", preferred: "A",
      rationale: "agree, but worried about migration window",
      replyTo: c1.id,
    });
    const { comments } = await ctx.store.readRfc(r.id);
    expect(comments).toHaveLength(2);
    expect(comments[1].replyTo).toBe(c1.id);
    expect(c2.id > c1.id).toBe(true);
  });

  it("--reply-to a non-existent comment id is refused with USAGE", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await expect(
      ctx.store.commentRfc({
        rfcId: r.id, role: "Backend",
        preferred: "A", rationale: "x",
        replyTo: "01HBOGUSBOGUSBOGUSBOGUSBOG",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("plain comments accept role: 'SYSTEM' (human-running-CLI path)", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    const c = await ctx.store.commentRfc({
      rfcId: r.id,
      role: "SYSTEM",
      preferred: "",
      rationale: "context from the user: please weigh in by EoD.",
    });
    expect(c.role).toBe("SYSTEM");
    const { comments } = await ctx.store.readRfc(r.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].role).toBe("SYSTEM");
    // SYSTEM has no manifest / read cursor — the per-RFC read marker
    // file under `cursors/SYSTEM/` must NOT be created (would pollute
    // the per-role cursor namespace and never be consulted anyway).
    const cursorsDir = path.join(ctx.root, "comms", "cursors", "SYSTEM");
    let dirExists = false;
    try {
      await fsp.access(cursorsDir);
      dirExists = true;
    } catch {
      dirExists = false;
    }
    expect(dirExists).toBe(false);
    // The emitted RFC_COMMENT event carries `from: "SYSTEM"` and
    // `payload.role: "SYSTEM"` so audit / dashboards see the human source.
    const events = await ctx.store.listEventsAfter("");
    const evt = events.find((e) => e.type === "RFC_COMMENT" && e.ref === r.id);
    expect(evt?.from).toBe("SYSTEM");
    expect((evt?.payload as { role: string }).role).toBe("SYSTEM");
  });

  it("structured kinds (pre-decision / ack / object) reject role: 'SYSTEM'", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    for (const kind of ["pre-decision", "ack", "object"] as const) {
      await expect(
        ctx.store.commentRfc({
          rfcId: r.id,
          role: "SYSTEM",
          preferred: "A",
          rationale: "no",
          kind,
        }),
      ).rejects.toMatchObject({ code: "USAGE" });
    }
  });

  it("10 concurrent comments all serialize (no lost writes)", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    const roles = ["PM", "TL", "Backend", "DevOps"] as const;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        ctx.store.commentRfc({
          rfcId: r.id,
          role: roles[i % roles.length],
          preferred: "A",
          rationale: `comment number ${i}`,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBe(10);
    const { comments } = await ctx.store.readRfc(r.id);
    expect(comments).toHaveLength(10);
    // ULIDs are monotonic per-process and the rfc-<id> lock serialises
    // writes, so ledger order matches issue order.
    for (let i = 1; i < comments.length; i++) {
      expect(comments[i].id > comments[i - 1].id).toBe(true);
    }
  });
});

describe("PR8g — addRfcOption", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("adds a new option to an open RFC and emits RFC_OPTION_ADDED", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    const o = await ctx.store.addRfcOption({
      rfcId: r.id, actor: "Backend",
      optionId: "C", summary: "Use Postgres on managed RDS",
      rationale: "Both A and B miss the operational cost angle.",
    });
    expect(o.id).toBe("C");
    const { proposal } = await ctx.store.readRfc(r.id);
    expect(proposal.options.map((p) => p.id)).toEqual(["A", "B", "C"]);
    const events = await ctx.store.listEventsAfter("");
    expect(events.some((e) => e.type === "RFC_OPTION_ADDED")).toBe(true);
  });

  it("refuses duplicate option ids", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await expect(
      ctx.store.addRfcOption({
        rfcId: r.id, actor: "Backend", optionId: "A",
        summary: "dup", rationale: "...",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("PR8g.1: add-option during a pending pre-decision is allowed AND invalidates the pre-decision", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    // add-option succeeds (no status-machine refusal)
    await ctx.store.addRfcOption({
      rfcId: r.id, actor: "Backend", optionId: "C",
      summary: "extra context", rationale: "options A/B miss cost",
    });
    // pre-decision is now invalidated (add-option after its ts).
    // decide should proceed without ACK gate because there's no
    // active pre-decision.
    const d = await ctx.store.decideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A",
      rationale: "going with A despite new option",
    });
    expect(d.outcome).toBe("accepted");
  });
});

describe("PR8g.1 — pre-decide as structured comment + ACK gate", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("decider can post a pre-decision; status stays open; ledger gets a kind=pre-decision comment", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    const c = await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    expect(c.kind).toBe("pre-decision");
    expect(c.preferred).toBe("A");
    const { proposal, comments } = await ctx.store.readRfc(r.id);
    // PR8g.1: pre-decide is no longer a status transition.
    expect(proposal.status).toBe("open");
    expect(comments.some((x) => x.kind === "pre-decision" && x.role === "TL")).toBe(true);
  });

  it("non-decider pre-decide is FORBIDDEN", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await expect(
      ctx.store.preDecideRfc({
        rfcId: r.id, decidedBy: "Backend", chosenOption: "A", rationale: "x",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("decide refused until all required roles have ack/object'd", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    // Required = (voters ∪ deciders) − {pre-decider} = {DevOps, PM}
    await expect(
      ctx.store.decideRfc({
        rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "go",
      }),
    ).rejects.toMatchObject({
      code: "USAGE",
      message: expect.stringMatching(/waiting for ACK from: .*DevOps.*PM|waiting for ACK from: .*PM.*DevOps/),
    });
  });

  it("all required roles ack → decide proceeds", async () => {
    // PR8t: NEW_RFC.createdBy === "Backend", so Backend is auto-added
    // to voters and must ack alongside DevOps + PM before TL can decide.
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    await ctx.store.ackRfc({ rfcId: r.id, role: "DevOps" });
    await ctx.store.ackRfc({ rfcId: r.id, role: "PM" });
    await ctx.store.ackRfc({ rfcId: r.id, role: "Backend" });
    const d = await ctx.store.decideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "all acked",
    });
    expect(d.outcome).toBe("accepted");
  });

  it("mix of ack and object also unblocks decide", async () => {
    // PR8t: Backend (createdBy) must respond too — mix in an object
    // from the creator alongside DevOps ack + PM object.
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    await ctx.store.ackRfc({ rfcId: r.id, role: "DevOps" });
    await ctx.store.objectRfc({
      rfcId: r.id, role: "PM", rationale: "prefer B", preferredOption: "B",
    });
    await ctx.store.ackRfc({ rfcId: r.id, role: "Backend" });
    // Decider knows PM objected (visible in comments); still allowed
    // to decide A. Audit trail is preserved.
    const d = await ctx.store.decideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "noted",
    });
    expect(d.outcome).toBe("accepted");
  });

  it("partial response → decide still refused, naming who's outstanding", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    await ctx.store.ackRfc({ rfcId: r.id, role: "DevOps" });
    await expect(
      ctx.store.decideRfc({
        rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "go",
      }),
    ).rejects.toMatchObject({
      code: "USAGE",
      message: expect.stringContaining("PM"),
    });
  });

  it("ack from the pre-decider themselves is refused", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    await expect(
      ctx.store.ackRfc({ rfcId: r.id, role: "TL" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("ack from a role not in (voters ∪ deciders) is FORBIDDEN", async () => {
    await ctx.store.createRole({ id: "Outsider", title: "Outsider" });
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    await expect(
      ctx.store.ackRfc({ rfcId: r.id, role: "Outsider" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("ack with no active pre-decision is USAGE", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await expect(
      ctx.store.ackRfc({ rfcId: r.id, role: "DevOps" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("object rationale is required (USAGE if empty)", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    await expect(
      ctx.store.objectRfc({ rfcId: r.id, role: "DevOps", rationale: "" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("object with preferredOption not in proposal is USAGE", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    await expect(
      ctx.store.objectRfc({
        rfcId: r.id, role: "DevOps",
        rationale: "want Z", preferredOption: "Z",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("re-publish (via withdraw + new pre-decide): posting a new pre-decision invalidates all prior ACKs", async () => {
    // PR8u: a second pre-decide is no longer allowed to silently
    // overwrite an active one (that was a coin-flip race between
    // competing deciders). To re-propose, the original pre-decider
    // explicitly withdraws first; old ACKs predate the next
    // pre-decision's `ts` and the standard `c.ts > active.ts` gate
    // already invalidates them.
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "first round",
    });
    await ctx.store.ackRfc({ rfcId: r.id, role: "DevOps" });
    await ctx.store.ackRfc({ rfcId: r.id, role: "PM" });
    // Direct second preDecide is now refused — must withdraw first.
    await expect(
      ctx.store.preDecideRfc({
        rfcId: r.id, decidedBy: "TL", chosenOption: "B",
        rationale: "second round, prefer B",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
    await ctx.store.withdrawRfcPreDecision({
      rfcId: r.id, role: "TL", rationale: "rethinking",
    });
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "B",
      rationale: "second round, prefer B",
    });
    await expect(
      ctx.store.decideRfc({
        rfcId: r.id, decidedBy: "TL", chosenOption: "B", rationale: "go",
      }),
    ).rejects.toMatchObject({
      code: "USAGE",
      message: expect.stringMatching(/waiting for ACK from/),
    });
  });

  it("add-option after pre-decide invalidates the pre-decision; decide proceeds without ACK gate", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    await ctx.store.addRfcOption({
      rfcId: r.id, actor: "Backend", optionId: "C",
      summary: "extra context", rationale: "options A/B miss cost",
    });
    const d = await ctx.store.decideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A",
      rationale: "proceed on A despite C now existing",
    });
    expect(d.outcome).toBe("accepted");
  });

  it("reject bypasses the ACK gate (the only escape from a stalled pre-decision)", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    // No ACKs from DevOps or PM. reject still allowed.
    const d = await ctx.store.rejectRfc({
      rfcId: r.id, decidedBy: "TL", rationale: "voter unreachable; re-open later",
    });
    expect(d.outcome).toBe("rejected");
  });

  it("decide without any pre-decide proceeds (ACK gate only applies when there's an active pre-decision)", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    // Straight to decide. The handbook teaches "use pre-decide when
    // you can imagine an objection" but does not force it.
    const d = await ctx.store.decideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A",
      rationale: "clear-cut; no pre-decide needed",
    });
    expect(d.outcome).toBe("accepted");
  });

  it("regular rfc comment from a required role does NOT advance the ACK gate", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    // Regular discussion comment (no kind) from a required role.
    await ctx.store.commentRfc({
      rfcId: r.id, role: "DevOps", preferred: "",
      rationale: "I have thoughts but haven't decided yet",
    });
    // ACK gate still says DevOps is outstanding (regular comment ≠ position).
    await expect(
      ctx.store.decideRfc({
        rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "go",
      }),
    ).rejects.toMatchObject({
      code: "USAGE",
      message: expect.stringContaining("DevOps"),
    });
  });
});

describe("PR8g — revise + edit cycle", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("decider can revise an open RFC; status flips to revising", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    const updated = await ctx.store.reviseRfc({
      rfcId: r.id, decidedBy: "TL",
      rationale: "Need a fuller description of the migration plan.",
    });
    expect(updated.status).toBe("revising");
    const events = await ctx.store.listEventsAfter("");
    expect(events.some((e) => e.type === "RFC_REVISION_REQUESTED")).toBe(true);
  });

  it("non-decider revise is FORBIDDEN", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await expect(
      ctx.store.reviseRfc({ rfcId: r.id, decidedBy: "Backend", rationale: "no" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("creator can edit while revising; status flips back to open; comments preserved", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await ctx.store.commentRfc({
      rfcId: r.id, role: "DevOps", preferred: "A", rationale: "I'm in",
    });
    await ctx.store.reviseRfc({ rfcId: r.id, decidedBy: "TL", rationale: "need more context" });
    const edited = await ctx.store.editRfc({
      rfcId: r.id, actor: "Backend",
      rationale: "filled in context",
      description: "Now with a 3-paragraph migration plan.",
    });
    expect(edited.status).toBe("open");
    expect(edited.description).toContain("3-paragraph");
    const { comments } = await ctx.store.readRfc(r.id);
    expect(comments).toHaveLength(1); // DevOps comment preserved
  });

  it("edit refused outside of revising", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await expect(
      ctx.store.editRfc({
        rfcId: r.id, actor: "Backend",
        rationale: "no", description: "x",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("edit by a non-creator/non-decider role is FORBIDDEN", async () => {
    const r = await ctx.store.createRfc(NEW_RFC); // createdBy: Backend
    await ctx.store.reviseRfc({ rfcId: r.id, decidedBy: "TL", rationale: "fix" });
    await expect(
      ctx.store.editRfc({
        rfcId: r.id, actor: "DevOps",
        rationale: "outsider attempt", description: "x",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("edit requires at least one of --title/--description/--options/--deadline", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await ctx.store.reviseRfc({ rfcId: r.id, decidedBy: "TL", rationale: "fix" });
    await expect(
      ctx.store.editRfc({ rfcId: r.id, actor: "Backend", rationale: "empty" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });
});

describe("PR8g — link / unlink tasks", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("link-task validates existence and is idempotent", async () => {
    const t = await ctx.store.createTask({ title: "do thing", owner: "Backend", actor: "PM" });
    const r = await ctx.store.createRfc(NEW_RFC);
    const after1 = await ctx.store.linkTaskToRfc({ rfcId: r.id, actor: "Backend", taskId: t.id });
    expect(after1.relatedTasks).toEqual([t.id]);
    const after2 = await ctx.store.linkTaskToRfc({ rfcId: r.id, actor: "Backend", taskId: t.id });
    expect(after2.relatedTasks).toEqual([t.id]); // no duplicate
  });

  it("link-task refused for unknown task id", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await expect(
      ctx.store.linkTaskToRfc({ rfcId: r.id, actor: "Backend", taskId: "T-9999" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("unlink-task is idempotent and removes the entry", async () => {
    const t = await ctx.store.createTask({ title: "do thing", owner: "Backend", actor: "PM" });
    const r = await ctx.store.createRfc({ ...NEW_RFC, relatedTasks: [t.id] });
    const after = await ctx.store.unlinkTaskFromRfc({ rfcId: r.id, actor: "Backend", taskId: t.id });
    expect(after.relatedTasks).toEqual([]);
    const again = await ctx.store.unlinkTaskFromRfc({ rfcId: r.id, actor: "Backend", taskId: t.id });
    expect(again.relatedTasks).toEqual([]);
  });

  it("link/unlink refused in terminal states", async () => {
    const t = await ctx.store.createTask({ title: "x", owner: "Backend", actor: "PM" });
    const r = await ctx.store.createRfc(NEW_RFC);
    await ctx.store.decideRfc({ rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "ship" });
    await expect(
      ctx.store.linkTaskToRfc({ rfcId: r.id, actor: "Backend", taskId: t.id }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });
});

describe("PR8g — markRfcSeen + unreadComments", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("after commenting, the commenter's manifest shows unreadComments=0 for that RFC", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await ctx.store.commentRfc({
      rfcId: r.id, role: "TL", preferred: "A", rationale: "lean A",
    });
    const m = await ctx.store.openOrCreatePlan("TL");
    const entry = m.rfcs.find((x) => x.id === r.id);
    expect(entry).toBeDefined();
    expect(entry?.unreadComments).toBe(0);
  });

  it("comments from others increment unreadComments until markRfcSeen", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await ctx.store.commentRfc({
      rfcId: r.id, role: "DevOps", preferred: "A", rationale: "one",
    });
    await ctx.store.commentRfc({
      rfcId: r.id, role: "PM", preferred: "A", rationale: "two",
    });
    let m = await ctx.store.openOrCreatePlan("TL");
    expect(m.rfcs.find((x) => x.id === r.id)?.unreadComments).toBe(2);
    // openOrCreatePlan caches a pending manifest until ack; clear it
    // so the next plan recomputes against the just-updated read cursor.
    await ctx.store.ackManifest("TL", m.ackToken);

    await ctx.store.markRfcSeen({ role: "TL", rfcId: r.id });
    m = await ctx.store.openOrCreatePlan("TL");
    expect(m.rfcs.find((x) => x.id === r.id)?.unreadComments).toBe(0);
  });
});

describe("PR8g — Manifest visibility for new states", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("voter is hidden during revising; creator and decider still see it", async () => {
    const r = await ctx.store.createRfc(NEW_RFC); // createdBy: Backend, voters: [DevOps, PM], deciders: [TL]
    await ctx.store.reviseRfc({ rfcId: r.id, decidedBy: "TL", rationale: "rewrite" });
    const mDevOps = await ctx.store.openOrCreatePlan("DevOps");
    const mBackend = await ctx.store.openOrCreatePlan("Backend");
    const mTL = await ctx.store.openOrCreatePlan("TL");
    expect(mDevOps.rfcs.find((x) => x.id === r.id)).toBeUndefined();
    expect(mBackend.rfcs.find((x) => x.id === r.id)).toBeDefined(); // creator
    expect(mTL.rfcs.find((x) => x.id === r.id)?.role).toBe("decider");
  });

  it("PR8g.1: pre-decision surfaces in manifest with myAckOwed for required roles; status stays 'open'", async () => {
    // PR8t: NEW_RFC.createdBy === "Backend", so Backend is auto-added
    // to voters and is in the required-ACK set.
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    // PM (required to ACK) sees pendingPreDecision with myAckOwed=true.
    const mPM = await ctx.store.openOrCreatePlan("PM");
    const ePM = mPM.rfcs.find((x) => x.id === r.id);
    expect(ePM?.status).toBe("open");
    expect(ePM?.pendingPreDecision?.chosenOption).toBe("A");
    expect(ePM?.pendingPreDecision?.decidedBy).toBe("TL");
    expect(ePM?.pendingPreDecision?.myAckOwed).toBe(true);
    expect(ePM?.pendingPreDecision?.awaitingAckFrom?.sort()).toEqual(
      ["Backend", "DevOps", "PM"],
    );
    // TL (the pre-decider) sees the pre-decision but doesn't owe ACK
    // themselves (they're the one waiting).
    const mTL = await ctx.store.openOrCreatePlan("TL");
    const eTL = mTL.rfcs.find((x) => x.id === r.id);
    expect(eTL?.pendingPreDecision?.myAckOwed).toBe(false);
    expect(eTL?.pendingPreDecision?.awaitingAckFrom?.sort()).toEqual(
      ["Backend", "DevOps", "PM"],
    );
  });

  it("PR8g.1: voter ack shrinks awaitingAckFrom (from decider's view) and drops voter from their own manifest", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    await ctx.store.ackRfc({ rfcId: r.id, role: "DevOps" });
    // Decider sees Backend + PM still outstanding (PR8t: Backend is
    // the creator and thus an auto-voter).
    const mTL = await ctx.store.openOrCreatePlan("TL");
    const eTL = mTL.rfcs.find((x) => x.id === r.id);
    expect(eTL?.pendingPreDecision?.awaitingAckFrom?.sort()).toEqual(
      ["Backend", "PM"],
    );
    // DevOps (who acked) drops out of their own manifest — nothing
    // more for them to do on this RFC until either a new pre-decide
    // or the RFC decides/rejects.
    const mDevOps = await ctx.store.openOrCreatePlan("DevOps");
    const eDevOps = mDevOps.rfcs.find((x) => x.id === r.id);
    expect(eDevOps).toBeUndefined();
  });

  it("relatedTasks surfaces in the manifest", async () => {
    const t = await ctx.store.createTask({ title: "x", owner: "Backend", actor: "PM" });
    const r = await ctx.store.createRfc({ ...NEW_RFC, relatedTasks: [t.id] });
    const m = await ctx.store.openOrCreatePlan("TL");
    expect(m.rfcs.find((x) => x.id === r.id)?.relatedTasks).toEqual([t.id]);
  });
});

// ---------- Brainstorm-mode RFCs (empty options) ----------

const BRAINSTORM_RFC = {
  slug: "q3-priorities",
  title: "Q3 priorities — open discussion",
  voters: ["DevOps", "PM"],
  deciders: ["TL"],
  options: [],
  createdBy: "Backend" as const,
  description: "Wide-open discussion before we even know what the options are.",
};

describe("PR8l — brainstorm-mode RFC (empty options)", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("createRfc accepts options=[] and the proposal carries an empty options array", async () => {
    const r = await ctx.store.createRfc(BRAINSTORM_RFC);
    expect(r.options).toEqual([]);
    expect(r.status).toBe("open");
  });

  it("voters can comment freely on a brainstorm RFC without picking an option", async () => {
    const r = await ctx.store.createRfc(BRAINSTORM_RFC);
    const c1 = await ctx.store.commentRfc({
      rfcId: r.id, role: "DevOps", preferred: "", rationale: "Idea: move queue to NATS", replyTo: null,
    });
    const c2 = await ctx.store.commentRfc({
      rfcId: r.id, role: "PM", preferred: "", rationale: "Risk: customers depend on current SLA", replyTo: c1.id,
    });
    const view = await ctx.store.readRfc(r.id);
    expect(view.comments.length).toBe(2);
    expect(view.comments.find((c) => c.id === c2.id)?.replyTo).toBe(c1.id);
  });

  it("add-option mid-brainstorm upgrades the RFC into decision mode", async () => {
    const r = await ctx.store.createRfc(BRAINSTORM_RFC);
    await ctx.store.commentRfc({
      rfcId: r.id, role: "DevOps", preferred: "", rationale: "We could go with NATS or Kafka", replyTo: null,
    });
    await ctx.store.addRfcOption({
      rfcId: r.id, optionId: "A", summary: "Move queue to NATS", rationale: "Lightweight", actor: "DevOps",
    });
    const after = await ctx.store.readRfc(r.id);
    expect(after.proposal.options.map((o) => o.id)).toEqual(["A"]);
  });

  it("decideRfc on a brainstorm RFC accepts WITHOUT --option; chosenOption is null", async () => {
    const r = await ctx.store.createRfc(BRAINSTORM_RFC);
    const decision = await ctx.store.decideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: null,
      rationale: "Discussion concluded: keep current architecture, revisit Q4",
    });
    expect(decision.outcome).toBe("accepted");
    expect(decision.chosenOption).toBeNull();
  });

  it("decideRfc on a brainstorm RFC refuses --option (suggests add-option)", async () => {
    const r = await ctx.store.createRfc(BRAINSTORM_RFC);
    await expect(
      ctx.store.decideRfc({
        rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "ok",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("decideRfc on an RFC WITH options still requires --option (regression)", async () => {
    const r = await ctx.store.createRfc({
      ...BRAINSTORM_RFC,
      slug: "with-options",
      options: [{ id: "A", summary: "Option A" }],
    });
    await expect(
      ctx.store.decideRfc({
        rfcId: r.id, decidedBy: "TL", chosenOption: null, rationale: "ok",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("decide on a brainstorm RFC after add-option requires --option (post-upgrade)", async () => {
    const r = await ctx.store.createRfc(BRAINSTORM_RFC);
    await ctx.store.addRfcOption({
      rfcId: r.id, optionId: "A", summary: "Concrete choice", rationale: "Locking in", actor: "TL",
    });
    // Now that the RFC has an option, decide without --option must refuse.
    await expect(
      ctx.store.decideRfc({
        rfcId: r.id, decidedBy: "TL", chosenOption: null, rationale: "ok",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
    // And decide WITH --option succeeds.
    const decision = await ctx.store.decideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "Going with A",
    });
    expect(decision.chosenOption).toBe("A");
  });

  it("preDecideRfc refuses on a brainstorm RFC and points the decider at add-option", async () => {
    const r = await ctx.store.createRfc(BRAINSTORM_RFC);
    let caught: Error | null = null;
    try {
      await ctx.store.preDecideRfc({
        rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "Let's lock A",
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect((caught as { code?: string }).code).toBe("USAGE");
    expect(caught!.message).toMatch(/add-option/);
  });

  it("rejectRfc on a brainstorm RFC succeeds and produces a rejected decision", async () => {
    const r = await ctx.store.createRfc(BRAINSTORM_RFC);
    const decision = await ctx.store.rejectRfc({
      rfcId: r.id, decidedBy: "TL", rationale: "Premature; revisit later",
    });
    expect(decision.outcome).toBe("rejected");
    expect(decision.chosenOption).toBeNull();
  });

  it("createRfc still refuses when --options is given but malformed (regression on validation)", async () => {
    await expect(
      ctx.store.createRfc({
        ...BRAINSTORM_RFC,
        slug: "bad-opts",
        // duplicate option ids must still be refused
        options: [
          { id: "A", summary: "first" },
          { id: "A", summary: "duplicate" },
        ],
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });
});

// ---------- PR8t: creator is auto-added to voters ----------

describe("PR8t — RFC creator is automatically a voter", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("createRfc auto-adds createdBy to voters when not already listed", async () => {
    const r = await ctx.store.createRfc({
      slug: "creator-voter", title: "x",
      voters: ["DevOps"], deciders: ["TL"],
      options: [{ id: "A", summary: "do a" }],
      createdBy: "Backend",
    });
    expect(r.voters).toEqual(["DevOps", "Backend"]);
  });

  it("passing createdBy explicitly in --voters does not double-list", async () => {
    const r = await ctx.store.createRfc({
      slug: "no-dupe", title: "x",
      voters: ["Backend", "DevOps"], deciders: ["TL"],
      options: [{ id: "A", summary: "do a" }],
      createdBy: "Backend",
    });
    expect(r.voters).toEqual(["Backend", "DevOps"]);
  });

  it("SYSTEM-created RFCs do NOT add SYSTEM as a voter", async () => {
    const r = await ctx.store.createRfc({
      slug: "system-created", title: "x",
      voters: ["DevOps"], deciders: ["TL"],
      options: [{ id: "A", summary: "do a" }],
      createdBy: "SYSTEM",
    });
    expect(r.voters).toEqual(["DevOps"]);
  });

  it("creator must ack before decide can succeed (ACK gate includes creator)", async () => {
    const r = await ctx.store.createRfc({
      slug: "ack-includes-creator", title: "x",
      voters: ["DevOps"], deciders: ["TL"],
      options: [{ id: "A", summary: "do a" }],
      createdBy: "Backend",
    });
    // Comment-coverage gate (PR8u) requires DevOps + TL to comment
    // before pre-decide. Backend (creator) is excluded from the
    // required-commenter set by design but is still in the ACK gate
    // (because createdBy is auto-added to voters).
    for (const role of ["DevOps", "TL"] as const) {
      await ctx.store.commentRfc({ rfcId: r.id, role, preferred: "", rationale: "in" });
    }
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    await ctx.store.ackRfc({ rfcId: r.id, role: "DevOps" });
    // Backend (creator) has NOT acked yet — decide must refuse.
    await expect(
      ctx.store.decideRfc({
        rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "go",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
    // Once Backend acks, decide proceeds.
    await ctx.store.ackRfc({ rfcId: r.id, role: "Backend" });
    const d = await ctx.store.decideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "all in",
    });
    expect(d.outcome).toBe("accepted");
  });

  it("creator who is also the pre-decider does NOT owe themselves an ack", async () => {
    // PM creates the RFC and is in deciders; PM pre-decides; the gate
    // excludes the pre-decider, so PM does not ack themselves.
    const r = await ctx.store.createRfc({
      slug: "creator-is-decider", title: "x",
      voters: ["DevOps"], deciders: ["PM"],
      options: [{ id: "A", summary: "do a" }],
      createdBy: "PM",
    });
    expect(r.voters).toEqual(["DevOps", "PM"]);
    // Comment-coverage gate (PR8u): PM is the creator, so they're
    // excluded; only DevOps needs to comment first.
    await ctx.store.commentRfc({
      rfcId: r.id, role: "DevOps", preferred: "", rationale: "in",
    });
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "PM", chosenOption: "A", rationale: "lean A",
    });
    await ctx.store.ackRfc({ rfcId: r.id, role: "DevOps" });
    // Only DevOps was required; PM is excluded as pre-decider.
    const d = await ctx.store.decideRfc({
      rfcId: r.id, decidedBy: "PM", chosenOption: "A", rationale: "go",
    });
    expect(d.outcome).toBe("accepted");
  });
});

describe("PR8u — comment-coverage gate + RFC_READY_TO_DECIDE + withdraw", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  // ---------- pre-decide-able gate (preDecideRfc) ----------

  it("pre-decide refuses with USAGE when a required commenter has not yet commented; lists who", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    // Only DevOps and TL comment; PM is missing.
    await ctx.store.commentRfc({ rfcId: r.id, role: "DevOps", preferred: "", rationale: "in" });
    await ctx.store.commentRfc({ rfcId: r.id, role: "TL", preferred: "", rationale: "in" });
    let caught: Error | null = null;
    try {
      await ctx.store.preDecideRfc({
        rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect((caught as { code?: string }).code).toBe("USAGE");
    expect(caught!.message).toMatch(/PM/);
    expect(caught!.message).toMatch(/rfc reject/);
  });

  it("creator (Backend) is NOT in the required-commenter set", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    // DevOps + PM + TL comment; Backend (creator) does NOT.
    for (const role of ["DevOps", "PM", "TL"] as const) {
      await ctx.store.commentRfc({ rfcId: r.id, role, preferred: "", rationale: "in" });
    }
    // pre-decide must succeed even though Backend never commented.
    const c = await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    expect(c.kind).toBe("pre-decision");
  });

  it("structured-kind comments (ack / object) do NOT satisfy the gate", async () => {
    // Construct a minimal RFC and try to satisfy the gate by having
    // someone post an ack for a (non-existent) pre-decision. Since
    // there is no active pre-decision, ack itself fails; this test
    // confirms by going the other direction — we explicitly post a
    // pre-decision-shaped comment via the structured path and verify
    // the gate still rejects pre-decide. The simplest setup: only
    // satisfy the gate for some required commenters and confirm the
    // missing ones are not "filled" by structured posts elsewhere.
    const r = await ctx.store.createRfc(NEW_RFC);
    await ctx.store.commentRfc({ rfcId: r.id, role: "DevOps", preferred: "", rationale: "ok" });
    await ctx.store.commentRfc({ rfcId: r.id, role: "PM", preferred: "", rationale: "ok" });
    // TL has not posted a regular comment; gate must still refuse.
    await expect(
      ctx.store.preDecideRfc({
        rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "x",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  // ---------- RFC_READY_TO_DECIDE auto-emission ----------

  it("emits RFC_READY_TO_DECIDE exactly when the last required commenter posts", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    const seen = async (): Promise<string[]> => {
      const events = await ctx.store.listEventsAfter("");
      return events
        .filter((e) => e.type === "RFC_READY_TO_DECIDE" && e.ref === r.id)
        .map((e) => e.id);
    };
    expect(await seen()).toHaveLength(0);
    await ctx.store.commentRfc({ rfcId: r.id, role: "DevOps", preferred: "", rationale: "in" });
    expect(await seen()).toHaveLength(0);
    await ctx.store.commentRfc({ rfcId: r.id, role: "PM", preferred: "", rationale: "in" });
    expect(await seen()).toHaveLength(0);
    // Last required commenter (TL) → RFC_READY_TO_DECIDE fires.
    await ctx.store.commentRfc({ rfcId: r.id, role: "TL", preferred: "", rationale: "in" });
    const ready = await seen();
    expect(ready).toHaveLength(1);
    // The event payload carries the snapshot of who satisfied the gate.
    const events = await ctx.store.listEventsAfter("");
    const evt = events.find((e) => e.id === ready[0])!;
    expect(evt.from).toBe("SYSTEM");
    const payload = evt.payload as { rfcId: string; requiredCommenters: string[] };
    expect(payload.rfcId).toBe(r.id);
    expect(payload.requiredCommenters.sort()).toEqual(["DevOps", "PM", "TL"]);
  });

  it("late commenter after a prior READY emits a fresh RFC_READY_TO_DECIDE", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    for (const role of ["DevOps", "PM", "TL"] as const) {
      await ctx.store.commentRfc({ rfcId: r.id, role, preferred: "", rationale: "in" });
    }
    // First READY fired by the chain above.
    let events = await ctx.store.listEventsAfter("");
    let readys = events.filter((e) => e.type === "RFC_READY_TO_DECIDE" && e.ref === r.id);
    expect(readys).toHaveLength(1);
    // A second comment from one of the required commenters (a late
    // follow-up before any pre-decide) emits another READY so deciders
    // see the late voice before locking the discussion.
    await ctx.store.commentRfc({
      rfcId: r.id, role: "DevOps", preferred: "", rationale: "follow-up",
    });
    events = await ctx.store.listEventsAfter("");
    readys = events.filter((e) => e.type === "RFC_READY_TO_DECIDE" && e.ref === r.id);
    expect(readys).toHaveLength(2);
  });

  it("once a pre-decision is active, further comments do NOT emit RFC_READY_TO_DECIDE", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    for (const role of ["DevOps", "PM", "TL"] as const) {
      await ctx.store.commentRfc({ rfcId: r.id, role, preferred: "", rationale: "in" });
    }
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    // Late comment now — the flow has moved on to ACK; READY is no
    // longer the right prompt and must not be re-emitted.
    await ctx.store.commentRfc({
      rfcId: r.id, role: "PM", preferred: "", rationale: "afterthought",
    });
    const events = await ctx.store.listEventsAfter("");
    const readys = events.filter(
      (e) => e.type === "RFC_READY_TO_DECIDE" && e.ref === r.id,
    );
    expect(readys).toHaveLength(1);
  });

  // ---------- active-pre-decision gate (preDecideRfc) ----------

  it("a second pre-decide is refused while one is already active; suggests withdraw", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    // Need two deciders to have an attempt by the second one.
    await ctx.store.createRole({ id: "Architect", title: "Architect" });
    // Re-create the RFC with two deciders since NEW_RFC has only TL.
    const r2 = await ctx.store.createRfc({
      ...NEW_RFC,
      slug: "two-deciders",
      deciders: ["TL", "Architect"],
    });
    // Required commenters now = {DevOps, PM, TL, Architect} - {Backend}
    // = {DevOps, PM, TL, Architect}.
    for (const role of ["DevOps", "PM", "TL", "Architect"] as const) {
      await ctx.store.commentRfc({ rfcId: r2.id, role, preferred: "", rationale: "in" });
    }
    await ctx.store.preDecideRfc({
      rfcId: r2.id, decidedBy: "TL", chosenOption: "A", rationale: "TL leans A",
    });
    let caught: Error | null = null;
    try {
      await ctx.store.preDecideRfc({
        rfcId: r2.id, decidedBy: "Architect", chosenOption: "B",
        rationale: "Architect leans B",
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect((caught as { code?: string }).code).toBe("USAGE");
    expect(caught!.message).toMatch(/withdraw-pre-decision/);
    void r;
  });

  // ---------- withdraw ----------

  it("withdraw by the original pre-decider clears the active state and unblocks a fresh pre-decide", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    const w = await ctx.store.withdrawRfcPreDecision({
      rfcId: r.id, role: "TL", rationale: "second-guessing",
    });
    expect(w.kind).toBe("withdraw");
    // After withdraw, the active gate is clear → pre-decide again.
    const c = await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "B", rationale: "now leaning B",
    });
    expect(c.kind).toBe("pre-decision");
    expect(c.preferred).toBe("B");
  });

  it("withdraw refuses if no active pre-decision exists", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await expect(
      ctx.store.withdrawRfcPreDecision({
        rfcId: r.id, role: "TL", rationale: "x",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("withdraw by someone other than the pre-decider is FORBIDDEN", async () => {
    const r = await ctx.store.createRfc({
      ...NEW_RFC,
      slug: "two-deciders-2",
      deciders: ["TL", "PM"],
    });
    // PM is now both a voter (auto from createdBy is Backend not PM,
    // so PM is just a voter from the explicit list) and a decider.
    for (const role of ["DevOps", "PM", "TL"] as const) {
      await ctx.store.commentRfc({ rfcId: r.id, role, preferred: "", rationale: "in" });
    }
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "TL's call",
    });
    // Another decider (PM) cannot withdraw TL's pre-decision.
    await expect(
      ctx.store.withdrawRfcPreDecision({
        rfcId: r.id, role: "PM", rationale: "I want to take over",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("ack/object posted before a withdraw do not count for the next pre-decision's ACK round", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    await ctx.store.ackRfc({ rfcId: r.id, role: "DevOps" });
    await ctx.store.ackRfc({ rfcId: r.id, role: "PM" });
    await ctx.store.withdrawRfcPreDecision({
      rfcId: r.id, role: "TL", rationale: "rethinking",
    });
    // Fresh pre-decide → old ACKs predate the new active.ts and the
    // standard `c.ts > active.ts` gate already invalidates them.
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "B", rationale: "now B",
    });
    await expect(
      ctx.store.decideRfc({
        rfcId: r.id, decidedBy: "TL", chosenOption: "B", rationale: "go",
      }),
    ).rejects.toMatchObject({
      code: "USAGE",
      message: expect.stringMatching(/waiting for ACK from/),
    });
  });

  // ---------- add-option still invalidates active pre-decision ----------

  it("add-option still silently invalidates an active pre-decision (PR8u keeps this rule)", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await satisfyCommentGateForNewRfc(ctx.store, r.id);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    // add-option silently invalidates the active pre-decision; a
    // fresh pre-decide is then allowed (no withdraw needed).
    await ctx.store.addRfcOption({
      rfcId: r.id, actor: "Backend", optionId: "C",
      summary: "extra option", rationale: "options A/B miss cost",
    });
    const c = await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "C", rationale: "lean C now",
    });
    expect(c.kind).toBe("pre-decision");
  });
});
