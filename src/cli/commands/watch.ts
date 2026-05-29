import * as http from "node:http";
import { spawn } from "node:child_process";
import { boolFlag, optionalString, type ParsedArgs } from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import type { LocalFsStore } from "../../core/local-fs-store";
import { DASHBOARD_HTML } from "../dashboard/html";

const DEFAULT_PORT = 7421;
const EVENT_TAIL = 300;

/**
 * `gojaja watch [--port <n>] [--host <addr>] [--no-open] [--root <path>]`
 *
 * Starts a local, read-only HTTP dashboard over the project's `.gojaja/`
 * state and opens it in the browser. This is the human-as-scheduler
 * view: on a single machine there is no way to wake a turn-ended agent,
 * so the operator needs one screen showing who is idle, what is blocked,
 * which RFCs await a decision, and the live activity feed across every
 * window. The server is read-only — it never mutates coordination state.
 *
 * Long-running: the returned promise resolves only when the server
 * closes (Ctrl-C / SIGTERM), so the CLI process stays up serving.
 */
export async function runWatch(args: ParsedArgs): Promise<number> {
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);

  const host = optionalString(args.flags, "host") ?? "127.0.0.1";
  const portRaw = optionalString(args.flags, "port");
  let port = portRaw ? Number(portRaw) : DEFAULT_PORT;
  if (portRaw && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new UsageError(`Invalid --port '${portRaw}'. Use 0-65535.`);
  }
  const noOpen = boolFlag(args.flags, "no-open");

  const server = http.createServer((req, res) => {
    handleRequest(req, res, store, root).catch((err) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String((err as Error)?.message ?? err) }));
    });
  });

  port = await listenWithFallback(server, port, host);
  const url = `http://${host}:${port}/`;

  process.stdout.write(
    `gojaja watch — dashboard for ${root}\n` +
      `  serving at ${url}\n` +
      `  (read-only; Ctrl-C to stop)\n`,
  );
  if (!noOpen) openBrowser(url);

  return new Promise<number>((resolve) => {
    const shutdown = () => {
      server.close(() => resolve(0));
      // If close hangs on a lingering keep-alive socket, force-exit soon.
      setTimeout(() => resolve(0), 500).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

/** Try the requested port; on EADDRINUSE fall back to an ephemeral port. */
function listenWithFallback(
  server: http.Server,
  port: number,
  host: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && port !== 0) {
        server.removeListener("error", onError);
        server.listen(0, host, () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : 0);
        });
        return;
      }
      reject(err);
    };
    server.on("error", onError);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: LocalFsStore,
  root: string,
): Promise<void> {
  const url = req.url ?? "/";
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(DASHBOARD_HTML);
    return;
  }
  if (url.startsWith("/api/state")) {
    const snapshot = await buildSnapshot(store, root);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(snapshot));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

async function buildSnapshot(store: LocalFsStore, root: string) {
  const now = Date.now();
  const [version, config, board, rfcs, allEvents] = await Promise.all([
    store.readVersion().catch(() => "unknown"),
    store.readConfig(),
    store.readTaskBoard(),
    store.listRfcs(),
    store.listEventsAfter("").catch(() => []),
  ]);

  const roleIds = Object.keys(config.roles).sort();
  const roles = await Promise.all(
    roleIds.map(async (id) => {
      const r = config.roles[id];
      const session = await store.readSession(id).catch(() => null);
      const wait = await store.readWaitState(id).catch(() => null);
      let sessionState: "live" | "stale" | "none" = "none";
      let heartbeatAgeMs: number | null = null;
      if (session) {
        const hb = Date.parse(session.heartbeatAt);
        heartbeatAgeMs = Number.isFinite(hb) ? now - hb : null;
        const expiresAt = hb + session.leaseTtlSeconds * 1000;
        sessionState = expiresAt > now ? "live" : "stale";
      }
      return {
        id,
        title: r.title ?? "",
        owns: r.owns ?? [],
        reportsTo: r.reportsTo ?? [],
        session: session
          ? {
              state: sessionState,
              sessionId: session.sessionId,
              pid: session.pid,
              host: session.host,
              startedAt: session.startedAt,
              heartbeatAt: session.heartbeatAt,
              heartbeatAgeMs,
            }
          : { state: "none" as const },
        wait: wait
          ? {
              for: wait.for,
              deadline: wait.deadline,
              idleBroadcastSent: wait.idleBroadcastSent ?? false,
            }
          : null,
      };
    }),
  );

  const tasks = Object.values(board.tasks).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    owner: t.owner,
    priority: t.priority,
    dependsOn: t.dependsOn ?? [],
    parent: t.parent ?? null,
    creator: t.creator ?? null,
    reviewers: t.reviewers ?? [],
    tags: t.tags ?? [],
    deliverables: (t.deliverables ?? []).length,
    updatedAt: t.updatedAt,
  }));

  const rfcList = rfcs.map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    deciders: p.deciders,
    voters: p.voters,
    createdBy: p.createdBy,
    options: (p.options ?? []).map((o) => o.id),
    relatedTasks: p.relatedTasks ?? [],
    deadline: p.deadline ?? null,
  }));

  // Newest-first tail of the global event stream = the activity feed.
  const events = allEvents
    .slice(-EVENT_TAIL)
    .reverse()
    .map((e) => ({
      id: e.id,
      ts: e.ts,
      type: e.type,
      from: e.from,
      to: e.to,
      ref: e.ref ?? null,
      message:
        typeof (e.payload as { message?: unknown })?.message === "string"
          ? String((e.payload as { message: string }).message).split("\n")[0].slice(0, 200)
          : null,
    }));

  return {
    project: { root, version, generatedAt: new Date(now).toISOString() },
    roles,
    tasks,
    rfcs: rfcList,
    events,
    counts: {
      totalEvents: allEvents.length,
      liveRoles: roles.filter((r) => r.session.state === "live").length,
      openRfcs: rfcList.filter((r) => r.status === "open" || r.status === "revising").length,
    },
  };
}

function openBrowser(url: string): void {
  let cmd: string;
  let cmdArgs: string[];
  switch (process.platform) {
    case "darwin":
      cmd = "open";
      cmdArgs = [url];
      break;
    case "win32":
      cmd = "cmd";
      cmdArgs = ["/c", "start", "", url];
      break;
    default:
      cmd = "xdg-open";
      cmdArgs = [url];
      break;
  }
  try {
    const child = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* no browser available; the URL was already printed */
    });
    child.unref();
  } catch {
    /* ignore — URL is printed for manual open */
  }
}
