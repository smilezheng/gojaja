import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import type { RfcProposal } from "../src/core/types";

async function freshStore() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-rfc-"));
  const store = new LocalFsStore(root, { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  await store.createRole({ id: "PM", title: "Product Manager" });
  await store.createRole({ id: "TL", title: "Tech Lead" });
  await store.createRole({ id: "Backend", title: "Backend Engineer" });
  await store.createRole({ id: "DevOps", title: "Site Reliability" });
  return { root, store };
}

const NEW_RFC = {
  slug: "switch-to-postgres",
  title: "Switch primary store to Postgres",
  voters: ["PM", "TL", "Backend", "DevOps"],
  deciders: ["TL"],
  options: [
    { id: "A", summary: "Use Postgres" },
    { id: "B", summary: "Stay on SQLite" },
  ],
  createdBy: "PM" as const,
};

describe("Store.createRfc", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("allocates sequential RFC-NNNN ids and writes proposal.yaml", async () => {
    const a = await ctx.store.createRfc(NEW_RFC);
    const b = await ctx.store.createRfc({ ...NEW_RFC, slug: "second-rfc" });
    expect(a.id).toBe("RFC-0001");
    expect(b.id).toBe("RFC-0002");
    const proposalFile = path.join(
      ctx.root, "rfcs", "RFC-0001-switch-to-postgres", "proposal.yaml",
    );
    const raw = await fsp.readFile(proposalFile, "utf8");
    const proposal = yaml.load(raw) as RfcProposal;
    expect(proposal.title).toBe(NEW_RFC.title);
    expect(proposal.status).toBe("open");
  });

  it("emits RFC_CREATED broadcast on creation", async () => {
    await ctx.store.createRfc(NEW_RFC);
    const events = await ctx.store.listEventsAfter("");
    const e = events.find((e) => e.type === "RFC_CREATED");
    expect(e?.to).toBe("*");
    expect(e?.ref).toBe("RFC-0001");
  });

  it("rejects path-traversal slugs", async () => {
    await expect(
      ctx.store.createRfc({ ...NEW_RFC, slug: "../etc" }),
    ).rejects.toMatchObject({ code: "USAGE" });
    await expect(
      ctx.store.createRfc({ ...NEW_RFC, slug: "Bad Slug" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("rejects duplicate slug", async () => {
    await ctx.store.createRfc(NEW_RFC);
    await expect(ctx.store.createRfc(NEW_RFC)).rejects.toMatchObject({
      code: "USAGE",
    });
  });

  it("rejects empty options or duplicate option ids", async () => {
    await expect(
      ctx.store.createRfc({ ...NEW_RFC, slug: "x", options: [] }),
    ).rejects.toMatchObject({ code: "USAGE" });
    await expect(
      ctx.store.createRfc({
        ...NEW_RFC, slug: "y",
        options: [{ id: "A", summary: "" }, { id: "A", summary: "dup" }],
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("rejects empty deciders list", async () => {
    await expect(
      ctx.store.createRfc({ ...NEW_RFC, slug: "z", deciders: [] }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });
});

describe("Store.commentRfc", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("appends to comments.yaml ledger and emits RFC_COMMENT (PR8g shape)", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    const c = await ctx.store.commentRfc({
      rfcId: r.id, role: "Backend",
      preferred: "A", rationale: "Migration is tractable.",
    });
    expect(c.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(c.replyTo).toBeNull();
    const cf = path.join(ctx.root, "rfcs", `${r.id}-${r.slug}`, "comments.yaml");
    const raw = await fsp.readFile(cf, "utf8");
    expect(raw).toContain("Backend");
    expect(raw).toContain("Migration is tractable");
    const events = await ctx.store.listEventsAfter("");
    expect(events.some((e) => e.type === "RFC_COMMENT" && e.from === "Backend")).toBe(true);
  });

  it("PR8g: preserves every comment from the same role in order (no overwrite)", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await ctx.store.commentRfc({
      rfcId: r.id, role: "Backend", preferred: "A", rationale: "v1",
    });
    await ctx.store.commentRfc({
      rfcId: r.id, role: "Backend", preferred: "B", rationale: "changed my mind",
    });
    const { comments } = await ctx.store.readRfc(r.id);
    const beComments = comments.filter((c) => c.role === "Backend");
    expect(beComments).toHaveLength(2);
    expect(beComments[0].rationale).toBe("v1");
    expect(beComments[1].rationale).toBe("changed my mind");
    // ULIDs are monotonic so the second comment id sorts after the first.
    expect(beComments[1].id > beComments[0].id).toBe(true);
  });

  it("rejects empty rationale", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await expect(
      ctx.store.commentRfc({ rfcId: r.id, role: "Backend", preferred: "A", rationale: "" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("rejects unknown option preference", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await expect(
      ctx.store.commentRfc({
        rfcId: r.id, role: "Backend", preferred: "Z", rationale: "x",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("allows commenters that are NOT in the voters list", async () => {
    const r = await ctx.store.createRfc({ ...NEW_RFC, voters: ["PM", "TL"] });
    // Backend is not in voters but should still be allowed to comment.
    const c = await ctx.store.commentRfc({
      rfcId: r.id, role: "Backend", preferred: "A", rationale: "fyi",
    });
    expect(c.role).toBe("Backend");
  });

  it("rejects comments on a closed RFC", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await ctx.store.decideRfc({ rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "ship it" });
    await expect(
      ctx.store.commentRfc({ rfcId: r.id, role: "Backend", preferred: "A", rationale: "late" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });
});

describe("Store.decideRfc / rejectRfc", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("accepts only when caller is in deciders, advances status, emits RFC_DECIDED", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    const decision = await ctx.store.decideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "ship it",
    });
    expect(decision.outcome).toBe("accepted");
    expect(decision.chosenOption).toBe("A");
    const { proposal } = await ctx.store.readRfc(r.id);
    expect(proposal.status).toBe("accepted");
    const events = await ctx.store.listEventsAfter("");
    expect(events.some((e) => e.type === "RFC_DECIDED")).toBe(true);
  });

  it("refuses decide from a non-decider role (FORBIDDEN, not USAGE)", async () => {
    // M2: permission denial, not user error. Exit code FORBIDDEN (9) so
    // the handbook can teach agents to escalate rather than retry.
    const r = await ctx.store.createRfc(NEW_RFC);
    await expect(
      ctx.store.decideRfc({
        rfcId: r.id, decidedBy: "Backend", chosenOption: "A", rationale: "x",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { proposal } = await ctx.store.readRfc(r.id);
    expect(proposal.status).toBe("open"); // unchanged
  });

  it("refuses decide with an unknown option", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await expect(
      ctx.store.decideRfc({
        rfcId: r.id, decidedBy: "TL", chosenOption: "Z", rationale: "x",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("refuses decide twice", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    await ctx.store.decideRfc({
      rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "first",
    });
    await expect(
      ctx.store.decideRfc({
        rfcId: r.id, decidedBy: "TL", chosenOption: "B", rationale: "again",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("reject sets status=rejected with chosenOption=null", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    const d = await ctx.store.rejectRfc({ rfcId: r.id, decidedBy: "TL", rationale: "not now" });
    expect(d.outcome).toBe("rejected");
    expect(d.chosenOption).toBeNull();
    const { proposal, decision } = await ctx.store.readRfc(r.id);
    expect(proposal.status).toBe("rejected");
    expect(decision?.outcome).toBe("rejected");
  });

  it("H3 regression: N concurrent readers observing the inconsistent shape emit exactly ONE RFC_REPAIRED", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    const decisionPath = path.join(
      ctx.root, "rfcs", `${r.id}-${r.slug}`, "decision.json",
    );
    await fsp.writeFile(
      decisionPath,
      JSON.stringify({
        rfcId: r.id,
        decidedBy: "TL",
        ts: new Date().toISOString(),
        outcome: "accepted",
        chosenOption: "A",
        rationale: "first decision",
      }),
    );

    // 10 concurrent readRfc calls all observe the inconsistent shape.
    // Without the lock-then-re-verify pattern, each would self-heal and
    // each would emit its own RFC_REPAIRED. We assert exactly one event.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => ctx.store.readRfc(r.id)),
    );
    for (const { proposal } of results) {
      expect(proposal.status).toBe("accepted");
    }
    const events = await ctx.store.listEventsAfter("");
    const repaired = events.filter((e) => e.type === "RFC_REPAIRED" && e.ref === r.id);
    expect(repaired.length).toBe(1);
  });

  it("self-heals when decision.json exists but proposal.yaml is still open (crash recovery)", async () => {
    // Simulate the crash window inside finaliseRfc: decision written but
    // proposal.yaml never updated. Without recovery, the next decideRfc
    // would re-pass the open-status guard and overwrite the decision.
    const r = await ctx.store.createRfc(NEW_RFC);
    // Drop a decision.json directly, bypassing finaliseRfc.
    const decisionPath = path.join(
      ctx.root, "rfcs", `${r.id}-${r.slug}`, "decision.json",
    );
    await fsp.writeFile(
      decisionPath,
      JSON.stringify({
        rfcId: r.id,
        decidedBy: "TL",
        ts: new Date().toISOString(),
        outcome: "accepted",
        chosenOption: "A",
        rationale: "first decision (lost write to proposal)",
      }),
    );

    // readRfc must detect the inconsistency and repair proposal.yaml.
    const { proposal, decision } = await ctx.store.readRfc(r.id);
    expect(proposal.status).toBe("accepted");
    expect(decision?.chosenOption).toBe("A");

    const events = await ctx.store.listEventsAfter("");
    expect(events.some((e) => e.type === "RFC_REPAIRED" && e.ref === r.id)).toBe(true);

    // Critical: a follow-up decideRfc must now be refused (cannot
    // double-decide just because the proposal had been wedged open).
    await expect(
      ctx.store.decideRfc({
        rfcId: r.id, decidedBy: "TL", chosenOption: "B", rationale: "tries to overwrite",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });
});

describe("Manifest.rfcs", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("voter sees the RFC until they comment", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    let m = await ctx.store.openOrCreatePlan("Backend");
    let entry = m.rfcs.find((x) => x.id === r.id);
    expect(entry?.role).toBe("voter");
    expect(entry?.commented).toBe(false);
    await ctx.store.ackManifest("Backend", m.ackToken);

    await ctx.store.commentRfc({
      rfcId: r.id, role: "Backend", preferred: "A", rationale: "ok",
    });
    m = await ctx.store.openOrCreatePlan("Backend");
    entry = m.rfcs.find((x) => x.id === r.id);
    expect(entry).toBeUndefined(); // commented voter falls out of action list
  });

  it("decider stays in the list until the RFC is closed (even after commenting)", async () => {
    const r = await ctx.store.createRfc(NEW_RFC);
    let m = await ctx.store.openOrCreatePlan("TL");
    expect(m.rfcs.find((x) => x.id === r.id)?.role).toBe("decider");
    await ctx.store.commentRfc({ rfcId: r.id, role: "TL", preferred: "A", rationale: "x" });
    await ctx.store.ackManifest("TL", m.ackToken);

    m = await ctx.store.openOrCreatePlan("TL");
    const entry = m.rfcs.find((x) => x.id === r.id);
    expect(entry?.role).toBe("decider");
    expect(entry?.commented).toBe(true);

    await ctx.store.decideRfc({ rfcId: r.id, decidedBy: "TL", chosenOption: "A", rationale: "ship" });
    await ctx.store.ackManifest("TL", m.ackToken);
    m = await ctx.store.openOrCreatePlan("TL");
    expect(m.rfcs.find((x) => x.id === r.id)).toBeUndefined();
  });

  it("roles outside voters/deciders never see the RFC in their manifest", async () => {
    await ctx.store.createRole({ id: "Outsider", title: "Outsider" });
    await ctx.store.createRfc({ ...NEW_RFC });
    const m = await ctx.store.openOrCreatePlan("Outsider");
    expect(m.rfcs).toEqual([]);
  });
});
