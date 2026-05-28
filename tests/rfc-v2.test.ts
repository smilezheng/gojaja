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
    const r = await ctx.store.createRfc(NEW_RFC);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    await ctx.store.ackRfc({ rfcId: r.id, role: "DevOps" });
    await ctx.store.ackRfc({ rfcId: r.id, role: "PM" });
    const d = await ctx.store.decideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "all acked",
    });
    expect(d.outcome).toBe("accepted");
  });

  it("mix of ack and object also unblocks decide", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    await ctx.store.ackRfc({ rfcId: r.id, role: "DevOps" });
    await ctx.store.objectRfc({
      rfcId: r.id, role: "PM", rationale: "prefer B", preferredOption: "B",
    });
    // Decider knows PM objected (visible in comments); still allowed
    // to decide A. Audit trail is preserved.
    const d = await ctx.store.decideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "noted",
    });
    expect(d.outcome).toBe("accepted");
  });

  it("partial response → decide still refused, naming who's outstanding", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
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
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    await expect(
      ctx.store.objectRfc({ rfcId: r.id, role: "DevOps", rationale: "" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("object with preferredOption not in proposal is USAGE", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
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

  it("re-publish: posting a new pre-decision invalidates all prior ACKs", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "first round",
    });
    await ctx.store.ackRfc({ rfcId: r.id, role: "DevOps" });
    await ctx.store.ackRfc({ rfcId: r.id, role: "PM" });
    // Re-publish (different option, same decider — also covers "same
    // option" via the same code path since the gate keys off ts).
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
    const r = await ctx.store.createRfc(NEW_RFC);
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
    expect(ePM?.pendingPreDecision?.awaitingAckFrom?.sort()).toEqual(["DevOps", "PM"]);
    // TL (the pre-decider) sees the pre-decision but doesn't owe ACK
    // themselves (they're the one waiting).
    const mTL = await ctx.store.openOrCreatePlan("TL");
    const eTL = mTL.rfcs.find((x) => x.id === r.id);
    expect(eTL?.pendingPreDecision?.myAckOwed).toBe(false);
    expect(eTL?.pendingPreDecision?.awaitingAckFrom?.sort()).toEqual(["DevOps", "PM"]);
  });

  it("PR8g.1: voter ack shrinks awaitingAckFrom (from decider's view) and drops voter from their own manifest", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await ctx.store.preDecideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "lean A",
    });
    await ctx.store.ackRfc({ rfcId: r.id, role: "DevOps" });
    // Decider sees PM still outstanding.
    const mTL = await ctx.store.openOrCreatePlan("TL");
    const eTL = mTL.rfcs.find((x) => x.id === r.id);
    expect(eTL?.pendingPreDecision?.awaitingAckFrom).toEqual(["PM"]);
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

describe("PR8g — back-compat detector (legacy per-role JSON layout)", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("readRfc refuses to proceed if comments/<role>.json files are present", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    // Plant a pre-PR8g shape: comments/Backend.json.
    const dir = path.join(ctx.root, "rfcs", `${r.id}-${r.slug}`, "comments");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, "Backend.json"),
      JSON.stringify({ rfcId: r.id, role: "Backend", preferred: "A", ts: "", rationale: "legacy" }),
    );
    await expect(ctx.store.readRfc(r.id)).rejects.toMatchObject({
      code: "USAGE",
      message: expect.stringMatching(/pre-PR8g/),
    });
  });

  it("PR8g.1: readRfc refuses proposal.yaml with status='pre-decide' (PR8g status removed)", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    // Forge a PR8g-era proposal.yaml with status: pre-decide.
    const proposalPath = path.join(ctx.root, "rfcs", `${r.id}-${r.slug}`, "proposal.yaml");
    const raw = await fsp.readFile(proposalPath, "utf8");
    await fsp.writeFile(
      proposalPath,
      raw.replace(/status:\s*open/, "status: pre-decide"),
    );
    await expect(ctx.store.readRfc(r.id)).rejects.toMatchObject({
      code: "USAGE",
      message: expect.stringMatching(/pre-decide.*PR8g/s),
    });
  });

  it("PR8g.1: readRfc refuses proposal.yaml with a preDecision field (PR8g shape)", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    const proposalPath = path.join(ctx.root, "rfcs", `${r.id}-${r.slug}`, "proposal.yaml");
    const raw = await fsp.readFile(proposalPath, "utf8");
    await fsp.writeFile(
      proposalPath,
      raw + "\npreDecision:\n  decidedBy: TL\n  chosenOption: A\n  ts: '2026-05-28T00:00:00Z'\n  rationale: legacy\n",
    );
    await expect(ctx.store.readRfc(r.id)).rejects.toMatchObject({
      code: "USAGE",
      message: expect.stringContaining("preDecision"),
    });
  });
});
