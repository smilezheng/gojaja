import { boolFlag, optionalString, requireString, type ParsedArgs } from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { resolveIdentity } from "../identity";
import type { RoleId } from "../../core/types";

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
  try {
    const { role } = await resolveIdentity(store, { requireSession: true });
    return { root, actor: role };
  } catch {
    return { root, actor: "SYSTEM" };
  }
}

async function runRfcNew(args: ParsedArgs): Promise<number> {
  const slug = args.positional[1];
  if (!slug) {
    throw new UsageError(
      "Usage: agentctl rfc new <slug> --title <text> --deciders <r1,r2> [--voters <r1,r2,...>] [--options A:summary,B:summary] [--deadline <iso>]",
    );
  }
  const title = requireString(args.flags, "title");
  const voters = splitList(optionalString(args.flags, "voters"));
  const deciders = splitList(optionalString(args.flags, "deciders"));
  if (deciders.length === 0) {
    throw new UsageError("Specify at least one decider with --deciders <role>[,role2,...].");
  }
  const options = parseOptions(optionalString(args.flags, "options"));
  if (options.length === 0) {
    throw new UsageError(
      "Specify at least one option with --options <id>[:summary][,<id>[:summary]...].",
    );
  }
  const deadline = optionalString(args.flags, "deadline") ?? null;
  const json = boolFlag(args.flags, "json");
  const { root, actor } = await actorRole(args);
  const store = await openStoreOrThrow(root);
  const proposal = await store.createRfc({
    slug, title, voters, deciders, options, deadline, createdBy: actor,
  });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "created", proposal }) + "\n");
  } else {
    process.stdout.write(
      `Created ${proposal.id} (${proposal.status}): ${proposal.title}\n` +
        `  voters:   ${proposal.voters.join(", ") || "(none)"}\n` +
        `  deciders: ${proposal.deciders.join(", ")}\n` +
        `  options:  ${proposal.options.map((o) => o.id).join(", ")}\n`,
    );
  }
  return 0;
}

async function runRfcComment(args: ParsedArgs): Promise<number> {
  const rfcId = args.positional[1];
  if (!rfcId) {
    throw new UsageError("Usage: agentctl rfc comment <rfc-id> --rationale <text> [--option <opt>]");
  }
  const preferred = optionalString(args.flags, "option") ?? "";
  const rationale = requireString(args.flags, "rationale");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const { role } = await resolveIdentity(store, { requireSession: true });
  const comment = await store.commentRfc({ rfcId, role, preferred, rationale });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "commented", comment }) + "\n");
  } else {
    process.stdout.write(
      `Recorded comment from ${role} on ${rfcId}` +
        (preferred ? ` (prefers ${preferred})` : "") +
        ".\n",
    );
  }
  return 0;
}

async function runRfcDecide(args: ParsedArgs): Promise<number> {
  const rfcId = args.positional[1];
  if (!rfcId) {
    throw new UsageError("Usage: agentctl rfc decide <rfc-id> --option <opt> --rationale <text>");
  }
  const chosenOption = requireString(args.flags, "option");
  const rationale = requireString(args.flags, "rationale");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const { role } = await resolveIdentity(store, { requireSession: true });
  const decision = await store.decideRfc({ rfcId, decidedBy: role, chosenOption, rationale });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "decided", decision }) + "\n");
  } else {
    process.stdout.write(`Accepted ${rfcId} (option ${chosenOption}) by ${role}.\n`);
  }
  return 0;
}

async function runRfcReject(args: ParsedArgs): Promise<number> {
  const rfcId = args.positional[1];
  if (!rfcId) {
    throw new UsageError("Usage: agentctl rfc reject <rfc-id> --rationale <text>");
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
    process.stdout.write(`Rejected ${rfcId} by ${role}.\n`);
  }
  return 0;
}

async function runRfcList(args: ParsedArgs): Promise<number> {
  const statusFilter = optionalString(args.flags, "status");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const allowed = new Set(["open", "accepted", "rejected", "superseded"]);
  if (statusFilter && !allowed.has(statusFilter)) {
    throw new UsageError(`Invalid --status '${statusFilter}'.`);
  }
  const list = await store.listRfcs(
    statusFilter ? { status: statusFilter as "open" | "accepted" | "rejected" | "superseded" } : undefined,
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
    process.stdout.write(`${r.id.padEnd(10)} ${r.status.padEnd(10)} ${r.title}\n`);
  }
  return 0;
}

async function runRfcShow(args: ParsedArgs): Promise<number> {
  const rfcId = args.positional[1];
  if (!rfcId) {
    throw new UsageError("Usage: agentctl rfc show <rfc-id>");
  }
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const data = await store.readRfc(rfcId);
  if (json) {
    process.stdout.write(JSON.stringify(data) + "\n");
    return 0;
  }
  const { proposal, comments, decision } = data;
  process.stdout.write(`# ${proposal.id}: ${proposal.title}\n\n`);
  process.stdout.write(`status:    ${proposal.status}\n`);
  process.stdout.write(`voters:    ${proposal.voters.join(", ") || "(none)"}\n`);
  process.stdout.write(`deciders:  ${proposal.deciders.join(", ")}\n`);
  process.stdout.write(`options:   ${proposal.options.map((o) => `${o.id}=${o.summary}`).join(" | ")}\n`);
  process.stdout.write(`deadline:  ${proposal.deadline ?? "(none)"}\n`);
  process.stdout.write(`createdBy: ${proposal.createdBy}\n`);
  process.stdout.write(`\nComments (${comments.length}):\n`);
  for (const c of comments) {
    process.stdout.write(
      `  - ${c.role}` +
        (c.preferred ? ` -> ${c.preferred}` : "") +
        `: ${c.rationale.split("\n")[0]}\n`,
    );
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
    case "new":     return runRfcNew(args);
    case "comment": return runRfcComment(args);
    case "decide":  return runRfcDecide(args);
    case "reject":  return runRfcReject(args);
    case "list":    return runRfcList(args);
    case "show":    return runRfcShow(args);
    default:
      throw new UsageError(
        "Usage: agentctl rfc <new|comment|decide|reject|list|show> [args]\n" +
          "  agentctl rfc new <slug> --title <text> --deciders <r1,r2> [--voters <...>] [--options A:summary,B:summary] [--deadline <iso>]\n" +
          "  agentctl rfc comment <rfc-id> --rationale <text> [--option <opt>]\n" +
          "  agentctl rfc decide <rfc-id> --option <opt> --rationale <text>\n" +
          "  agentctl rfc reject <rfc-id> --rationale <text>\n" +
          "  agentctl rfc list [--status open|accepted|rejected|superseded]\n" +
          "  agentctl rfc show <rfc-id>",
      );
  }
}
