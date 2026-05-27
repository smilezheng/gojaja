import { boolFlag, optionalString, requireString, type ParsedArgs } from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { resolveIdentity } from "../identity";
import { TASK_STATUSES, type RoleId, type Task, type TaskStatus } from "../../core/types";

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function actorRole(args: ParsedArgs): Promise<{ root: string; actor: RoleId | "SYSTEM" }> {
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  // Tasks may be created by an agent (with MA_SESSION) or by the human
  // running CLI manually before any role has claimed a session. We allow
  // both; the actor is recorded in the resulting event so audit is honest.
  try {
    const { role } = await resolveIdentity(store, { requireSession: true });
    return { root, actor: role };
  } catch {
    return { root, actor: "SYSTEM" };
  }
}

async function runTaskNew(args: ParsedArgs): Promise<number> {
  const title = requireString(args.flags, "title");
  const owner = optionalString(args.flags, "owner") ?? null;
  const priority = optionalString(args.flags, "priority") ?? "P2";
  const dependsOn = splitList(optionalString(args.flags, "depends-on"));
  const acceptance = optionalString(args.flags, "acceptance") ?? "";
  const json = boolFlag(args.flags, "json");
  const { root, actor } = await actorRole(args);
  const store = await openStoreOrThrow(root);
  const task = await store.createTask({ title, owner, priority, dependsOn, acceptance, actor });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "created", task }) + "\n");
  } else {
    process.stdout.write(
      `Created ${task.id} (${task.status}, ${task.priority})` +
        (task.owner ? ` -> ${task.owner}` : "") +
        `: ${task.title}\n`,
    );
  }
  return 0;
}

async function runTaskAssign(args: ParsedArgs): Promise<number> {
  const taskId = args.positional[1];
  const newOwner = requireString(args.flags, "to");
  if (!taskId) {
    throw new UsageError("Usage: agentctl task assign <task-id> --to <role>");
  }
  const json = boolFlag(args.flags, "json");
  const { root, actor } = await actorRole(args);
  const store = await openStoreOrThrow(root);
  const task = await store.assignTask({ taskId, newOwner, actor });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "assigned", task }) + "\n");
  } else {
    process.stdout.write(`Assigned ${task.id} -> ${task.owner}\n`);
  }
  return 0;
}

async function runTaskStatus(args: ParsedArgs): Promise<number> {
  const taskId = args.positional[1];
  const newStatusRaw = args.positional[2];
  if (!taskId || !newStatusRaw) {
    throw new UsageError(
      `Usage: agentctl task status <task-id> <${TASK_STATUSES.join("|")}>`,
    );
  }
  if (!(TASK_STATUSES as readonly string[]).includes(newStatusRaw)) {
    throw new UsageError(
      `Invalid status '${newStatusRaw}'. Use one of: ${TASK_STATUSES.join(", ")}.`,
    );
  }
  const newStatus = newStatusRaw as TaskStatus;
  const json = boolFlag(args.flags, "json");
  const { root, actor } = await actorRole(args);
  const store = await openStoreOrThrow(root);
  const task = await store.setTaskStatus({ taskId, newStatus, actor });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "updated", task }) + "\n");
  } else {
    process.stdout.write(`${task.id} status -> ${task.status}\n`);
  }
  return 0;
}

async function runTaskList(args: ParsedArgs): Promise<number> {
  const ownerFilter = optionalString(args.flags, "owner");
  const statusFilter = optionalString(args.flags, "status");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const board = await store.readTaskBoard();
  let tasks: Task[] = Object.values(board.tasks);
  if (ownerFilter) tasks = tasks.filter((t) => t.owner === ownerFilter);
  if (statusFilter) {
    if (!(TASK_STATUSES as readonly string[]).includes(statusFilter)) {
      throw new UsageError(`Invalid --status '${statusFilter}'.`);
    }
    tasks = tasks.filter((t) => t.status === statusFilter);
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id));

  if (json) {
    process.stdout.write(JSON.stringify({ tasks }) + "\n");
    return 0;
  }
  if (tasks.length === 0) {
    process.stdout.write("(no matching tasks)\n");
    return 0;
  }
  for (const t of tasks) {
    process.stdout.write(
      `${t.id.padEnd(8)} ${t.status.padEnd(11)} ${(t.owner ?? "-").padEnd(12)} ${t.priority.padEnd(4)} ${t.title}\n`,
    );
  }
  return 0;
}

async function runTaskShow(args: ParsedArgs): Promise<number> {
  const taskId = args.positional[1];
  if (!taskId) {
    throw new UsageError("Usage: agentctl task show <task-id>");
  }
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const task = await store.readTask(taskId);
  if (json) {
    process.stdout.write(JSON.stringify({ task }) + "\n");
    return 0;
  }
  process.stdout.write(`id:         ${task.id}\n`);
  process.stdout.write(`title:      ${task.title}\n`);
  process.stdout.write(`status:     ${task.status}\n`);
  process.stdout.write(`owner:      ${task.owner ?? "(unassigned)"}\n`);
  process.stdout.write(`priority:   ${task.priority}\n`);
  process.stdout.write(`dependsOn:  ${task.dependsOn.join(", ") || "(none)"}\n`);
  process.stdout.write(`createdAt:  ${task.createdAt}\n`);
  process.stdout.write(`updatedAt:  ${task.updatedAt}\n`);
  if (task.acceptance.trim().length > 0) {
    process.stdout.write(`\nacceptance:\n${task.acceptance}\n`);
  }
  return 0;
}

export async function runTask(args: ParsedArgs): Promise<number> {
  const sub = args.positional[0];
  switch (sub) {
    case "new":
      return runTaskNew(args);
    case "assign":
      return runTaskAssign(args);
    case "status":
      return runTaskStatus(args);
    case "list":
      return runTaskList(args);
    case "show":
      return runTaskShow(args);
    default:
      throw new UsageError(
        "Usage: agentctl task <new|assign|status|list|show> [args]\n" +
          "  agentctl task new --title <text> [--owner <role>] [--priority P0|P1|P2|P3] [--depends-on T-XXXX,...] [--acceptance <text>]\n" +
          "  agentctl task assign <task-id> --to <role>\n" +
          `  agentctl task status <task-id> <${TASK_STATUSES.join("|")}>\n` +
          "  agentctl task list [--owner <role>] [--status <s>]\n" +
          "  agentctl task show <task-id>",
      );
  }
}
