import { boolFlag, optionalString, requireString, type ParsedArgs } from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { resolveActor, resolveIdentity } from "../identity";
import { nextLoopHint } from "../next-hint";
import type { RfcComment, RoleId } from "../../core/types";

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Parse `--options A:summary,B:summary` into structured RfcOptions. The
 * comma separator and the `:` delimiter are both restricted to make
 * shell-level parsing predictable.
 */
function parseOptions(raw: string | undefined) {
  if (!raw) return [];
  const out: { id: string; summary: string }[] = [];
  for (const chunk of raw.split(",")) {
    const piece = chunk.trim();
    if (piece.length === 0) continue;
    const colon = piece.indexOf(":");
    if (colon < 0) {
      out.push({ id: piece, summary: "" });
    } else {
      out.push({ id: piece.slice(0, colon).trim(), summary: piece.slice(colon + 1).trim() });
    }
  }
  return out;
}

async function actorRole(args: ParsedArgs): Promise<{ root: string; actor: RoleId | "SYSTEM" }> {
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const { actor } = await resolveActor(store);
  return { root, actor };
}

async function runRfcNew(args: ParsedArgs): Promise<number> {
  const slug = args.positional[1];
  if (!slug) {
    throw new UsageError(
      "Usage: gojaja rfc new <slug> --title <text> --deciders <r1,r2> " +
        "[--description <text>] [--voters <r1,r2,...>] " +
        "[--options A:summary,B:summary] [--task T-NNNN[,T-NNNN]] [--deadline <iso>]",
    );
  }
  const title = requireString(args.flags, "title");
  const description = optionalString(args.flags, "description") ?? "";
  const voters = splitList(optionalString(args.flags, "voters"));
  const deciders = splitList(optionalString(args.flags, "deciders"));
  if (deciders.length === 0) {
    throw new UsageError("Specify at least one decider with --deciders <role>[,role2,...].");
  }
  // --options is optional. Empty means "brainstorm mode" — the
  // RFC opens with no concrete choices on the table. Voters post free
  // comments; anyone can later run `rfc add-option` to introduce a
  // pickable choice, which upgrades the RFC into a decision flow.
  // `rfc decide` then refuses to be given --option until options exist.
  const options = parseOptions(optionalString(args.flags, "options"));
  const relatedTasks = splitList(optionalString(args.flags, "task"));
  const deadline = optionalString(args.flags, "deadline") ?? null;
  const json = boolFlag(args.flags, "json");
  const { root, actor } = await actorRole(args);
  const store = await openStoreOrThrow(root);
  const proposal = await store.createRfc({
    slug, title, voters, deciders, options, deadline,
    createdBy: actor, description, relatedTasks,
  });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "created", proposal }) + "\n");
  } else {
    const optionsLine =
      proposal.options.length === 0
        ? "(brainstorm — no options yet; run `rfc add-option` to add one)"
        : proposal.options.map((o) => o.id).join(", ");
    process.stdout.write(
      `Created ${proposal.id} (${proposal.status}): ${proposal.title}\n` +
        `  voters:        ${proposal.voters.join(", ") || "(none)"}\n` +
        `  deciders:      ${proposal.deciders.join(", ")}\n` +
        `  options:       ${optionsLine}\n` +
        `  relatedTasks:  ${proposal.relatedTasks.join(", ") || "(none)"}\n`,
    );
    if (proposal.description.length === 0) {
      // soft warning. Description is the channel where the
      // creator gives non-participants enough context to weigh in.
      // A future release will harden this to a required field.
      process.stdout.write(
        `\nHint: this RFC has no --description. Voters and deciders read this\n` +
          `field for context; without it they may have to revise the RFC back\n` +
          `to you for a fuller writeup. Add one with 'gojaja rfc edit ${proposal.id}\n` +
          `--description "..." --rationale "fill in context"' after 'rfc revise'.\n`,
      );
    }
    process.stdout.write(nextLoopHint({ json, actor }));
  }
  return 0;
}

async function runRfcComment(args: ParsedArgs): Promise<number> {
  const rfcId = args.positional[1];
  if (!rfcId) {
    throw new UsageError(
      "Usage: gojaja rfc comment <rfc-id> --rationale <text> [--option <opt>] [--reply-to <comment-id>]",
    );
  }
  const preferred = optionalString(args.flags, "option") ?? "";
  const rationale = requireString(args.flags, "rationale");
  const replyTo = optionalString(args.flags, "reply-to") ?? null;
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  // Plain discussion comments accept SYSTEM (a human running the CLI
  // without GOJAJA_SESSION) symmetrically with `rfc new`. Structured
  // kinds (pre-decide / ack / object) still require a session — those
  // commands continue to use `resolveIdentity({ requireSession: true })`.
  const { actor } = await resolveActor(store);
  const comment = await store.commentRfc({
    rfcId,
    role: actor,
    preferred,
    rationale,
    replyTo,
  });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "commented", comment }) + "\n");
  } else {
    process.stdout.write(
      `Recorded comment ${comment.id} from ${actor} on ${rfcId}` +
        (preferred ? ` (prefers ${preferred})` : "") +
        (replyTo ? ` (reply to ${replyTo})` : "") +
        ".\n" +
        nextLoopHint({ json, actor }),
    );
  }
  return 0;
}

async function runRfcAddOption(args: ParsedArgs): Promise<number> {
  const rfcId = args.positional[1];
  if (!rfcId) {
    throw new UsageError(
      "Usage: gojaja rfc add-option <rfc-id> --option <id>:<summary> --rationale <text>",
    );
  }
  const optionRaw = requireString(args.flags, "option");
  const rationale = requireString(args.flags, "rationale");
  const parsed = parseOptions(optionRaw);
  if (parsed.length !== 1) {
    throw new UsageError("--option must be a single <id>:<summary> entry.");
  }
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const { role } = await resolveIdentity(store, { requireSession: true });
  const option = await store.addRfcOption({
    rfcId,
    actor: role,
    optionId: parsed[0].id,
    summary: parsed[0].summary,
    rationale,
  });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "option-added", option }) + "\n");
  } else {
    process.stdout.write(
      `Added option '${option.id}' to ${rfcId} by ${role}.\n` +
        nextLoopHint({ json, actor: role }),
    );
  }
  return 0;
}

async function runRfcPreDecide(args: ParsedArgs): Promise<number> {
  const rfcId = args.positional[1];
  if (!rfcId) {
    throw new UsageError(
      "Usage: gojaja rfc pre-decide <rfc-id> --option <opt> --rationale <text>",
    );
  }
  const chosenOption = requireString(args.flags, "option");
  const rationale = requireString(args.flags, "rationale");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const { role } = await resolveIdentity(store, { requireSession: true });
  const comment = await store.preDecideRfc({
    rfcId, decidedBy: role, chosenOption, rationale,
  });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "pre-decided", comment }) + "\n");
  } else {
    // print the required-ACK set so the decider knows exactly
    // who they're waiting on. We re-read the RFC to compute it (cheap;
    // happens once per pre-decide invocation).
    const { proposal } = await store.readRfc(rfcId);
    const required = new Set<RoleId>([
      ...proposal.voters,
      ...proposal.deciders,
    ]);
    required.delete(role);
    process.stdout.write(
      `Posted pre-decision on ${rfcId} as option '${chosenOption}' by ${role} (comment ${comment.id}).\n` +
        `\nRequired ACK from: ${[...required].join(", ") || "(none — no other voters or deciders, you can decide directly)"}.\n` +
        `Each role must run \`gojaja rfc ack ${rfcId}\` or \`gojaja rfc object ${rfcId} --rationale ...\`\n` +
        `before \`gojaja rfc decide ${rfcId} --option ${chosenOption} --rationale ...\` will succeed.\n` +
        `Silence does NOT count as consent. The only escape from a stalled ACK round is\n` +
        `\`gojaja rfc reject ${rfcId}\`.\n` +
        nextLoopHint({ json, actor: role }),
    );
  }
  return 0;
}

async function runRfcAck(args: ParsedArgs): Promise<number> {
  const rfcId = args.positional[1];
  if (!rfcId) {
    throw new UsageError(
      "Usage: gojaja rfc ack <rfc-id> [--rationale <text>]",
    );
  }
  const rationale = optionalString(args.flags, "rationale");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const { role } = await resolveIdentity(store, { requireSession: true });
  const comment = await store.ackRfc({ rfcId, role, rationale });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "acked", comment }) + "\n");
  } else {
    process.stdout.write(
      `Acked the active pre-decision on ${rfcId} as ${role} (comment ${comment.id}).\n` +
        nextLoopHint({ json, actor: role }),
    );
  }
  return 0;
}

async function runRfcObject(args: ParsedArgs): Promise<number> {
  const rfcId = args.positional[1];
  if (!rfcId) {
    throw new UsageError(
      "Usage: gojaja rfc object <rfc-id> --rationale <text> [--option <preferred-opt>]",
    );
  }
  const rationale = requireString(args.flags, "rationale");
  const preferredOption = optionalString(args.flags, "option") ?? "";
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const { role } = await resolveIdentity(store, { requireSession: true });
  const comment = await store.objectRfc({ rfcId, role, rationale, preferredOption });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "objected", comment }) + "\n");
  } else {
    process.stdout.write(
      `Objected to the active pre-decision on ${rfcId} as ${role} (comment ${comment.id})` +
        (preferredOption ? `, preferring option '${preferredOption}'` : "") +
        `.\n` +
        nextLoopHint({ json, actor: role }),
    );
  }
  return 0;
}

async function runRfcDecide(args: ParsedArgs): Promise<number> {
  const rfcId = args.positional[1];
  if (!rfcId) {
    throw new UsageError(
      "Usage: gojaja rfc decide <rfc-id> [--option <opt>] --rationale <text>\n" +
        "  --option is required for RFCs that have options, and must NOT be\n" +
        "  passed for brainstorm-mode RFCs (created without --options).",
    );
  }
  // --option is conditional. The store enforces the matching
  // invariant against the proposal; we just forward what the caller
  // gave (or null) and let it return the right error message.
  const chosenOption = optionalString(args.flags, "option") ?? null;
  const rationale = requireString(args.flags, "rationale");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const { role } = await resolveIdentity(store, { requireSession: true });
  const decision = await store.decideRfc({ rfcId, decidedBy: role, chosenOption, rationale });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "decided", decision }) + "\n");
  } else {
    if (chosenOption) {
      process.stdout.write(`Accepted ${rfcId} (option ${chosenOption}) by ${role}.\n`);
    } else {
      process.stdout.write(`Accepted ${rfcId} (brainstorm — no option chosen) by ${role}.\n`);
    }
    process.stdout.write(nextLoopHint({ json, actor: role }));
  }
  return 0;
}

async function runRfcReject(args: ParsedArgs): Promise<number> {
  const rfcId = args.positional[1];
  if (!rfcId) {
    throw new UsageError("Usage: gojaja rfc reject <rfc-id> --rationale <text>");
  }
  const rationale = requireString(args.flags, "rationale");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const { role } = await resolveIdentity(store, { requireSession: true });
  const decision = await store.rejectRfc({ rfcId, decidedBy: role, rationale });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "rejected", decision }) + "\n");
  } else {
    process.stdout.write(
      `Rejected ${rfcId} by ${role}.\n` +
        nextLoopHint({ json, actor: role }),
    );
  }
  return 0;
}

async function runRfcRevise(args: ParsedArgs): Promise<number> {
  const rfcId = args.positional[1];
  if (!rfcId) {
    throw new UsageError(
      "Usage: gojaja rfc revise <rfc-id> --rationale <text>",
    );
  }
  const rationale = requireString(args.flags, "rationale");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const { role } = await resolveIdentity(store, { requireSession: true });
  const proposal = await store.reviseRfc({ rfcId, decidedBy: role, rationale });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "revising", proposal }) + "\n");
  } else {
    process.stdout.write(
      `Sent ${rfcId} back for revision by ${role}.\n` +
        `Creator (or any decider) can now run 'gojaja rfc edit ${rfcId} ...'\n` +
        `to update the proposal; that re-opens the RFC.\n` +
        nextLoopHint({ json, actor: role }),
    );
  }
  return 0;
}

async function runRfcEdit(args: ParsedArgs): Promise<number> {
  const rfcId = args.positional[1];
  if (!rfcId) {
    throw new UsageError(
      "Usage: gojaja rfc edit <rfc-id> --rationale <text> " +
        "[--title <text>] [--description <text>] " +
        "[--options A:summary,B:summary] [--deadline <iso>]",
    );
  }
  const rationale = requireString(args.flags, "rationale");
  const title = optionalString(args.flags, "title");
  const description = optionalString(args.flags, "description");
  const optionsRaw = optionalString(args.flags, "options");
  const options = optionsRaw === undefined ? undefined : parseOptions(optionsRaw);
  const deadlineRaw = optionalString(args.flags, "deadline");
  // deadline: explicit empty string clears it (sets to null); not
  // passing the flag leaves it untouched.
  const deadline =
    deadlineRaw === undefined ? undefined : (deadlineRaw === "" ? null : deadlineRaw);
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const { role } = await resolveIdentity(store, { requireSession: true });
  const proposal = await store.editRfc({
    rfcId, actor: role, rationale, title, description, options, deadline,
  });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "revised", proposal }) + "\n");
  } else {
    process.stdout.write(
      `Edited ${rfcId} by ${role}; status is now ${proposal.status}.\n` +
        nextLoopHint({ json, actor: role }),
    );
  }
  return 0;
}

async function runRfcLinkTask(args: ParsedArgs): Promise<number> {
  const rfcId = args.positional[1];
  if (!rfcId) {
    throw new UsageError("Usage: gojaja rfc link-task <rfc-id> --task T-NNNN");
  }
  const taskId = requireString(args.flags, "task");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const { role } = await resolveIdentity(store, { requireSession: true });
  const proposal = await store.linkTaskToRfc({ rfcId, actor: role, taskId });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "linked", proposal }) + "\n");
  } else {
    process.stdout.write(
      `Linked ${taskId} to ${rfcId} by ${role}. relatedTasks: ${proposal.relatedTasks.join(", ")}.\n` +
        nextLoopHint({ json, actor: role }),
    );
  }
  return 0;
}

async function runRfcUnlinkTask(args: ParsedArgs): Promise<number> {
  const rfcId = args.positional[1];
  if (!rfcId) {
    throw new UsageError("Usage: gojaja rfc unlink-task <rfc-id> --task T-NNNN");
  }
  const taskId = requireString(args.flags, "task");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const { role } = await resolveIdentity(store, { requireSession: true });
  const proposal = await store.unlinkTaskFromRfc({ rfcId, actor: role, taskId });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "unlinked", proposal }) + "\n");
  } else {
    process.stdout.write(
      `Unlinked ${taskId} from ${rfcId} by ${role}. relatedTasks: ${proposal.relatedTasks.join(", ") || "(none)"}.\n` +
        nextLoopHint({ json, actor: role }),
    );
  }
  return 0;
}

async function runRfcList(args: ParsedArgs): Promise<number> {
  const statusFilter = optionalString(args.flags, "status");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  // pre-decide and revising are new valid statuses.
  const allowed = new Set([
    "open",
    "revising",
    "accepted",
    "rejected",
    "superseded",
  ]);
  if (statusFilter && !allowed.has(statusFilter)) {
    throw new UsageError(`Invalid --status '${statusFilter}'.`);
  }
  const list = await store.listRfcs(
    statusFilter
      ? { status: statusFilter as "open" | "revising" | "accepted" | "rejected" | "superseded" }
      : undefined,
  );
  if (json) {
    process.stdout.write(JSON.stringify({ rfcs: list }) + "\n");
    return 0;
  }
  if (list.length === 0) {
    process.stdout.write("(no matching RFCs)\n");
    return 0;
  }
  for (const r of list) {
    process.stdout.write(`${r.id.padEnd(10)} ${r.status.padEnd(11)} ${r.title}\n`);
  }
  return 0;
}

/**
 * Render comments as a tree by `replyTo` chains. Depth-2 indents are
 * meaningful; deeper threads flatten to depth-2 to keep output legible.
 * kind=pre-decision / ack / object comments get a [kind] tag
 * so the position-statement comments stand out from regular discussion.
 */
function renderCommentTree(comments: RfcComment[]): string[] {
  const byParent = new Map<string | null, RfcComment[]>();
  for (const c of comments) {
    const key = c.replyTo;
    const bucket = byParent.get(key) ?? [];
    bucket.push(c);
    byParent.set(key, bucket);
  }
  const lines: string[] = [];
  const visit = (parent: string | null, depth: number) => {
    const children = byParent.get(parent) ?? [];
    children.sort((a, b) => a.ts.localeCompare(b.ts));
    for (const c of children) {
      const indent = "  ".repeat(Math.min(depth, 3));
      const first = c.rationale.split("\n")[0] ?? "";
      const tag = c.preferred ? ` -> ${c.preferred}` : "";
      const kindTag = c.kind ? ` [${c.kind}]` : "";
      lines.push(`${indent}- [${c.id}]${kindTag} ${c.role}${tag}: ${first}`);
      visit(c.id, depth + 1);
    }
  };
  visit(null, 0);
  return lines;
}

/**
 * compute the currently-active pre-decision (latest
 * kind=pre-decision comment not invalidated by a later add-option).
 * Mirrors `computeActivePreDecisionInLedger` in the store; we
 * duplicate the small filter here rather than expose store internals.
 */
function activePreDecisionFromComments(comments: RfcComment[]): RfcComment | null {
  let latest: RfcComment | null = null;
  for (const c of comments) {
    if (c.kind === "pre-decision") latest = c;
  }
  return latest;
}

async function runRfcShow(args: ParsedArgs): Promise<number> {
  const rfcId = args.positional[1];
  if (!rfcId) {
    throw new UsageError("Usage: gojaja rfc show <rfc-id> [--json] [--no-mark-seen]");
  }
  const json = boolFlag(args.flags, "json");
  const noMarkSeen = boolFlag(args.flags, "no-mark-seen");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const data = await store.readRfc(rfcId);

  // opportunistically advance the role's read marker for this
  // RFC if there's an GOJAJA_SESSION (so subsequent `plan` results reflect
  // "no unread comments"). A bare-hands SYSTEM call (no GOJAJA_SESSION)
  // doesn't move a per-role cursor; that's correct.
  if (!noMarkSeen) {
    try {
      const { role, session } = await resolveIdentity(store, { requireSession: false });
      if (session) await store.markRfcSeen({ role, rfcId });
    } catch {
      // Reading should never fail because of cursor-update problems.
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify(data) + "\n");
    return 0;
  }
  const { proposal, comments, decision } = data;
  process.stdout.write(`# ${proposal.id}: ${proposal.title}\n\n`);
  process.stdout.write(`status:        ${proposal.status}\n`);
  process.stdout.write(`voters:        ${proposal.voters.join(", ") || "(none)"}\n`);
  process.stdout.write(`deciders:      ${proposal.deciders.join(", ")}\n`);
  process.stdout.write(`options:       ${proposal.options.map((o) => `${o.id}=${o.summary}`).join(" | ")}\n`);
  process.stdout.write(`relatedTasks:  ${proposal.relatedTasks.join(", ") || "(none)"}\n`);
  process.stdout.write(`deadline:      ${proposal.deadline ?? "(none)"}\n`);
  process.stdout.write(`createdBy:     ${proposal.createdBy}\n`);
  if (proposal.description && proposal.description.length > 0) {
    process.stdout.write(`\nDescription:\n${proposal.description}\n`);
  } else {
    process.stdout.write(`\nDescription: (empty — consider 'rfc revise' if context is missing)\n`);
  }
  // pending pre-decision is now a computed view over the
  // comments ledger; render it with the outstanding ACK list and
  // already-responded roles so the agent can see at a glance what's
  // blocking decide.
  const activePd = activePreDecisionFromComments(comments);
  if (activePd !== null) {
    const required = new Set<RoleId>([
      ...proposal.voters,
      ...proposal.deciders,
    ]);
    required.delete(activePd.role);
    const ackedRoles: RoleId[] = [];
    const objectedRoles: { role: RoleId; preferred: string }[] = [];
    for (const c of comments) {
      if (c.ts <= activePd.ts) continue;
      if (c.kind === "ack" && required.has(c.role)) ackedRoles.push(c.role);
      if (c.kind === "object" && required.has(c.role)) {
        objectedRoles.push({ role: c.role, preferred: c.preferred });
      }
    }
    const respondedSet = new Set<RoleId>([
      ...ackedRoles,
      ...objectedRoles.map((o) => o.role),
    ]);
    const awaiting = [...required].filter((r) => !respondedSet.has(r));
    process.stdout.write(
      `\nPending pre-decision by ${activePd.role} at ${activePd.ts}:\n` +
        `  option:        ${activePd.preferred}\n` +
        `  rationale:     ${activePd.rationale}\n` +
        `  awaiting ACK:  ${awaiting.join(", ") || "(none — ready to decide)"}\n` +
        `  acked:         ${ackedRoles.join(", ") || "(none)"}\n` +
        `  objected:      ${
          objectedRoles
            .map((o) => `${o.role}${o.preferred ? ` → ${o.preferred}` : ""}`)
            .join(", ") || "(none)"
        }\n` +
        `(Silence does NOT count as consent. Every required role must run\n` +
        ` 'gojaja rfc ack ${proposal.id}' or 'gojaja rfc object ${proposal.id} --rationale ...'\n` +
        ` before 'gojaja rfc decide' will succeed.)\n`,
    );
  }
  process.stdout.write(`\nComments (${comments.length}):\n`);
  if (comments.length === 0) {
    process.stdout.write("  (no comments yet)\n");
  } else {
    for (const line of renderCommentTree(comments)) {
      process.stdout.write(`  ${line}\n`);
    }
  }
  if (decision) {
    process.stdout.write(`\nDecision (${decision.outcome}) by ${decision.decidedBy} at ${decision.ts}:\n`);
    if (decision.chosenOption) process.stdout.write(`  option:    ${decision.chosenOption}\n`);
    process.stdout.write(`  rationale: ${decision.rationale}\n`);
  } else {
    process.stdout.write("\nDecision: (pending)\n");
  }
  return 0;
}

export async function runRfc(args: ParsedArgs): Promise<number> {
  const sub = args.positional[0];
  switch (sub) {
    case "new":           return runRfcNew(args);
    case "comment":       return runRfcComment(args);
    case "add-option":    return runRfcAddOption(args);
    case "pre-decide":    return runRfcPreDecide(args);
    case "ack":           return runRfcAck(args);
    case "object":        return runRfcObject(args);
    case "decide":        return runRfcDecide(args);
    case "reject":        return runRfcReject(args);
    case "revise":        return runRfcRevise(args);
    case "edit":          return runRfcEdit(args);
    case "link-task":     return runRfcLinkTask(args);
    case "unlink-task":   return runRfcUnlinkTask(args);
    case "list":          return runRfcList(args);
    case "show":          return runRfcShow(args);
    default:
      throw new UsageError(
        "Usage: gojaja rfc <new|comment|add-option|pre-decide|ack|object|decide|reject|revise|edit|link-task|unlink-task|list|show> [args]\n" +
          "  gojaja rfc new <slug> --title <text> --deciders <r1,r2> [--description <text>] [--voters <...>] [--options A:summary,B:summary] [--task T-NNNN[,T-NNNN]] [--deadline <iso>]\n" +
          "  gojaja rfc comment <rfc-id> --rationale <text> [--option <opt>] [--reply-to <comment-id>]\n" +
          "  gojaja rfc add-option <rfc-id> --option <id>:<summary> --rationale <text>\n" +
          "  gojaja rfc pre-decide <rfc-id> --option <opt> --rationale <text>\n" +
          "  gojaja rfc ack <rfc-id> [--rationale <text>]\n" +
          "  gojaja rfc object <rfc-id> --rationale <text> [--option <preferred-opt>]\n" +
          "  gojaja rfc decide <rfc-id> --option <opt> --rationale <text>\n" +
          "  gojaja rfc reject <rfc-id> --rationale <text>\n" +
          "  gojaja rfc revise <rfc-id> --rationale <text>\n" +
          "  gojaja rfc edit <rfc-id> --rationale <text> [--title <text>] [--description <text>] [--options A:summary,B:summary] [--deadline <iso>]\n" +
          "  gojaja rfc link-task <rfc-id> --task T-NNNN\n" +
          "  gojaja rfc unlink-task <rfc-id> --task T-NNNN\n" +
          "  gojaja rfc list [--status open|revising|accepted|rejected|superseded]\n" +
          "  gojaja rfc show <rfc-id> [--no-mark-seen]",
      );
  }
}
