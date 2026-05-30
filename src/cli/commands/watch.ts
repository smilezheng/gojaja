import * as http from "node:http";
import { spawn } from "node:child_process";
import { boolFlag, optionalString, type ParsedArgs } from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, layerRoot } from "../runtime";
import { LocalFsStore } from "../../core/local-fs-store";
import { DASHBOARD_HTML } from "../dashboard/html";
import { inspectInitState, performInit } from "./init";

const DEFAULT_PORT = 7421;
const EVENT_TAIL = 300;
/**
 * Threshold past which a `live`-session role with no `wait` session
 * on disk is flagged as `stalled-no-wait`. Empirically the most
 * common per-turn failure mode is "agent runs `gojaja ack`, sees the
 * success line, sits silent waiting for the user" — the role still
 * holds a live session lease, but no event can wake it because
 * nothing parked it on `wait`. The dashboard surfaces this so the
 * human-as-scheduler can nudge.
 *
 * 60 s is a deliberately lenient default: a fast turn (read manifest,
 * post one worklog, wait) finishes well under this; only a role that
 * actually got stuck shows red. Tunable via `?stalledThresholdMs=`
 * on the `/api/state` query string for ops that prefer tighter
 * monitoring.
 */
const STALLED_NO_WAIT_THRESHOLD_MS = 60_000;

/**
 * `gojaja watch [--port <n>] [--host <addr>] [--no-open] [--root <path>]`
 *
 * Starts a local HTTP dashboard over the project's `.gojaja/` state
 * and opens it in the browser. This is the human-as-scheduler view:
 * on a single machine there is no way to wake a turn-ended agent, so
 * the operator needs one screen showing who is idle, what is blocked,
 * which RFCs await a decision, and the live activity feed across
 * every window. Default 127.0.0.1 bind also exposes write actions
 * (`report`, `rfc new`, `task new`); non-loopback binds hide them.
 *
 * Uninitialised projects: `runWatch` no longer refuses to start when
 * `.gojaja/` is missing — it serves a single-screen "Initialise this
 * project" landing page instead. The HTTP layer carries an
 * `initialised` flag in `/api/state` so the front-end can decide
 * which UI to render. This is what makes the dashboard a viable
 * first-run experience.
 *
 * Long-running: the returned promise resolves only when the server
 * closes (Ctrl-C / SIGTERM), so the CLI process stays up serving.
 */
export async function runWatch(args: ParsedArgs): Promise<number> {
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  // The store is opened lazily per-request. We keep an
  // `unchecked`-style instance here so `runWatch` still works
  // against an uninitialised project (the front-end will steer the
  // user through `gojaja init` via the dashboard); each handler
  // gets its own `isInitialised` check before touching anything.
  const store = new LocalFsStore(layerRoot(root));

  const host = optionalString(args.flags, "host") ?? "127.0.0.1";
  const portRaw = optionalString(args.flags, "port");
  let port = portRaw ? Number(portRaw) : DEFAULT_PORT;
  if (portRaw && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new UsageError(`Invalid --port '${portRaw}'. Use 0-65535.`);
  }
  const noOpen = boolFlag(args.flags, "no-open");

  const server = http.createServer((req, res) => {
    handleRequest(req, res, store, root, host).catch((err) => {
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

  // Never resolves; the process exits when a stop signal arrives. We
  // exit immediately rather than `server.close()`-ing, because the
  // browser's keep-alive socket keeps a graceful close (and the event
  // loop) alive forever — that's why Ctrl-C used to do nothing. A
  // read-only viewer has nothing to flush. `once` so no listener
  // accumulates if signals repeat.
  return new Promise<number>(() => {
    const shutdown = () => {
      process.stdout.write("\ngojaja watch stopped.\n");
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
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

/**
 * Loopback addresses bypass the "no write endpoints over the network"
 * gate. Anything else (a LAN-bound `--host 0.0.0.0` mostly) returns
 * 403 on POSTs — `gojaja watch` is a personal scheduler dashboard; a
 * `report --to <peer>` button accessible from the LAN would let any
 * device on the network push directives at the team. The dashboard
 * HTML stays read-only over those binds (so users can demo it
 * without exposing writes).
 */
function isLoopbackBind(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost"
  );
}

function readJsonBody(
  req: http.IncomingMessage,
  maxBytes = 64 * 1024,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${(err as Error).message}`));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/**
 * Test-only export of the request handler. Lets the integration
 * suite (`tests/watch.test.ts`) spin a real HTTP server bound to a
 * fresh ephemeral port and exercise the full method-and-path
 * routing, the loopback gate, and the error-mapping for write
 * endpoints — all without exposing the handler as a public API
 * (the underscore prefix is the convention).
 */
export const __test_handleRequest = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: LocalFsStore,
  root: string,
  host: string,
): Promise<void> => handleRequest(req, res, store, root, host);

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: LocalFsStore,
  root: string,
  host: string,
): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "GET" && (url === "/" || url === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(DASHBOARD_HTML);
    return;
  }
  if (method === "GET" && url.startsWith("/api/state")) {
    // Uninitialised projects: return a minimal envelope so the
    // front-end can render the "Initialise" landing page. We
    // include the git inspection so the front-end can warn about
    // dirty / non-git roots before the user clicks the button.
    if (!(await store.isInitialised())) {
      const init = await inspectInitState(root);
      sendJson(res, 200, {
        initialised: false,
        project: { root, generatedAt: new Date().toISOString() },
        init: {
          layerDir: init.layerDir,
          git: init.git,
        },
        capabilities: { writeEnabled: isLoopbackBind(host) },
      });
      return;
    }
    const u = new URL(url, "http://placeholder/");
    const overrideRaw = u.searchParams.get("stalledThresholdMs");
    const override = overrideRaw === null ? null : Number(overrideRaw);
    const stalledThresholdMs =
      override !== null && Number.isFinite(override) && override > 0
        ? override
        : STALLED_NO_WAIT_THRESHOLD_MS;
    const snapshot = await buildSnapshot(store, root, stalledThresholdMs);
    // Capabilities tell the dashboard front-end whether the Actions
    // panel should render. The server-side gate (POST handlers)
    // re-checks the same condition, so a hand-crafted curl from the
    // wrong host still fails — this is purely UX so users do not
    // see a panel that would 403 on submit.
    sendJson(res, 200, {
      initialised: true,
      ...snapshot,
      capabilities: { writeEnabled: isLoopbackBind(host) },
    });
    return;
  }

  // Write endpoints — gated to loopback. The dashboard HTML hides
  // the Actions / Setup panels when its capability check (GET
  // /api/state - see `writeEnabled`) returns false, but we re-check
  // here so a direct POST cannot bypass the UI gate.
  if (method === "POST" && url.startsWith("/api/")) {
    if (!isLoopbackBind(host)) {
      sendJson(res, 403, {
        error:
          "Write actions are disabled when watch is bound to a non-loopback " +
          "address (this prevents anyone on the LAN from pushing directives " +
          "at the team via the dashboard). Re-run `gojaja watch` without " +
          "`--host`, or with `--host 127.0.0.1`.",
      });
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
      return;
    }
    try {
      // `/api/init` is the only write endpoint that runs when the
      // project is NOT yet initialised — by definition. All other
      // writes need the layer present and refuse with 409 if not
      // (the front-end's first-screen "Initialise" landing page
      // should keep users out of that path; the server-side check
      // is a defence-in-depth in case the front-end is bypassed).
      if (url === "/api/init") {
        const out = await postInit(root, body);
        sendJson(res, 200, out);
        return;
      }
      if (!(await store.isInitialised())) {
        sendJson(res, 409, {
          error:
            "Project is not initialised yet. POST /api/init first " +
            "(or run `gojaja init` from the project root).",
          errorCode: "NOT_INITIALISED",
        });
        return;
      }
      if (url === "/api/report") {
        const out = await postReport(store, body);
        sendJson(res, 200, out);
        return;
      }
      if (url === "/api/rfc") {
        const out = await postRfc(store, body);
        sendJson(res, 200, out);
        return;
      }
      if (url === "/api/task") {
        const out = await postTask(store, body);
        sendJson(res, 200, out);
        return;
      }
    } catch (err) {
      // The store layer throws UsageError / ForbiddenError with a
      // `code` field; init throws InitGitGateError /
      // AlreadyInitialisedError. We surface the message so the form
      // can render it inline. Map error classes to HTTP status:
      //   USAGE              → 400  client should fix and retry
      //   FORBIDDEN          → 403  permission, not retriable here
      //   INIT_GIT_GATE      → 409  state conflict; front-end shows
      //                              git detail and re-submits with
      //                              { force: true } if the user
      //                              confirms
      //   ALREADY_INITIALISED→ 409  state conflict; front-end
      //                              should refresh `/api/state`
      //   anything else      → 500  unexpected; show as-is
      const e = err as {
        code?: string;
        message?: string;
        git?: unknown;
        layerDir?: string;
      };
      let code = 500;
      if (e.code === "USAGE") code = 400;
      else if (e.code === "FORBIDDEN") code = 403;
      else if (e.code === "INIT_GIT_GATE") code = 409;
      else if (e.code === "ALREADY_INITIALISED") code = 409;
      const payload: Record<string, unknown> = {
        error: e.message ?? String(err),
        errorCode: e.code ?? null,
      };
      // Attach init-specific detail so the front-end can render
      // the git status sample inline (rather than a generic "409 —
      // try again" toast).
      if (e.code === "INIT_GIT_GATE" && e.git) payload.git = e.git;
      sendJson(res, code, payload);
      return;
    }
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

// ---- write-endpoint handlers ---------------------------------------

/**
 * `gojaja watch` writes are always emitted as `actor: "SYSTEM"` —
 * the dashboard is the project owner's window, equivalent to running
 * the CLI in a shell with no `GOJAJA_SESSION`. The same SYSTEM-friendly
 * paths the CLI already exposes (`report`, `rfc new`, `task new`)
 * back these endpoints; downstream audit / manifest projection /
 * recipient routing are unchanged.
 */

async function postInit(root: string, body: unknown) {
  // First call from the front-end has no body (or `{}`). If the
  // working tree is dirty we throw INIT_GIT_GATE; the front-end
  // shows the git status and (only after a clear "I understand") re-
  // submits with `{ force: true }`. The not-a-repo case is the same
  // first-call-then-confirm flow — the warning is rendered in the
  // browser instead of via readline.
  const b = (body ?? {}) as Record<string, unknown>;
  const force = b.force === true;
  const result = await performInit(root, { force });
  return {
    status: "initialised",
    layerDir: result.layerDir,
    version: result.version,
  };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStringArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

async function postReport(store: LocalFsStore, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const to = asString(b.to).trim();
  const message = asString(b.message);
  const ref = asString(b.ref).trim() || undefined;
  if (!to) throw makeUsage("`to` is required.");
  if (!message) throw makeUsage("`message` is required.");
  const event = await store.publishReport({ from: "SYSTEM", to, ref, message });
  return { status: "reported", event };
}

async function postRfc(store: LocalFsStore, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const slug = asString(b.slug).trim();
  const title = asString(b.title).trim();
  const deciders = asStringArr(b.deciders);
  const voters = asStringArr(b.voters);
  const description = asString(b.description);
  const optionsRaw = b.options;
  const options = Array.isArray(optionsRaw)
    ? optionsRaw
        .filter(
          (o): o is { id: string; summary: string } =>
            !!o &&
            typeof (o as { id?: unknown }).id === "string" &&
            typeof (o as { summary?: unknown }).summary === "string",
        )
        .map((o) => ({ id: o.id.trim(), summary: o.summary.trim() }))
    : [];
  const deadline = asString(b.deadline).trim() || null;
  const relatedTasks = asStringArr(b.relatedTasks);
  if (!slug) throw makeUsage("`slug` is required.");
  if (!title) throw makeUsage("`title` is required.");
  if (deciders.length === 0)
    throw makeUsage("`deciders` is required (one or more roles).");
  const proposal = await store.createRfc({
    slug,
    title,
    voters,
    deciders,
    options,
    description,
    deadline,
    relatedTasks,
    createdBy: "SYSTEM",
  });
  return { status: "created", proposal };
}

async function postTask(store: LocalFsStore, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const title = asString(b.title).trim();
  const owner = asString(b.owner).trim() || null;
  const priority = asString(b.priority).trim() || "P2";
  const acceptance = asString(b.acceptance);
  const dependsOn = asStringArr(b.dependsOn);
  const tags = asStringArr(b.tags);
  const reviewers = asStringArr(b.reviewers);
  if (!title) throw makeUsage("`title` is required.");
  const task = await store.createTask({
    title,
    owner,
    priority,
    dependsOn,
    acceptance,
    tags,
    reviewers,
    actor: "SYSTEM",
  });
  return { status: "created", task };
}

function makeUsage(message: string): Error & { code: string } {
  // Mimic the `code: "USAGE"` shape the store throws so `handleRequest`
  // routes us to a 400 with `errorCode: "USAGE"` for inline form
  // rendering. Avoid pulling UsageError from core because that adds
  // a tighter dependency than the CLI layer needs here.
  const err = new Error(message) as Error & { code: string };
  err.code = "USAGE";
  return err;
}

/**
 * Build the JSON snapshot served by `/api/state`. Exported for unit
 * tests of the dashboard's derived signals (in particular the
 * "stalled-no-wait" health status); production code path goes via
 * `handleRequest`.
 */
export async function buildSnapshot(
  store: LocalFsStore,
  root: string,
  stalledThresholdMs: number,
) {
  const now = Date.now();
  const [version, config, board, rfcs, allEvents] = await Promise.all([
    store.readVersion().catch(() => "unknown"),
    store.readConfig(),
    store.readTaskBoard(),
    store.listRfcs(),
    store.listEventsAfter("").catch(() => []),
  ]);

  // Index the most recent event per role-as-author. Used below to
  // detect "live session but no follow-up after ack" — the
  // single-most-common per-turn failure mode the dashboard exists to
  // surface (see STALLED_NO_WAIT_THRESHOLD_MS).
  const lastActionAtMsByRole = new Map<string, number>();
  for (const e of allEvents) {
    if (e.from === "SYSTEM") continue;
    const prev = lastActionAtMsByRole.get(e.from) ?? 0;
    const ts = Date.parse(e.ts);
    if (Number.isFinite(ts) && ts > prev) lastActionAtMsByRole.set(e.from, ts);
  }

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

      // Health status — a derived "what should the operator do about
      // this role right now" signal. Five states, ordered by
      // urgency:
      //   "no-session"        no claim; nothing to nudge
      //   "stale-session"     session lease expired; auto-takeover-eligible
      //   "waiting"           wait.json present — the agent is parked,
      //                       loop is alive, no action needed
      //   "active"            live session, no wait.json, but the
      //                       last action was recent: still mid-turn
      //   "stalled-no-wait"   live session, no wait.json, last action
      //                       older than the threshold — ack-but-no-
      //                       wait failure mode; operator should nudge
      const lastActionAtMs = lastActionAtMsByRole.get(id) ?? null;
      const lastActionAgeMs =
        lastActionAtMs === null ? null : now - lastActionAtMs;
      let healthStatus:
        | "no-session"
        | "stale-session"
        | "waiting"
        | "active"
        | "stalled-no-wait" = "no-session";
      if (sessionState === "none") {
        healthStatus = "no-session";
      } else if (sessionState === "stale") {
        healthStatus = "stale-session";
      } else if (wait) {
        healthStatus = "waiting";
      } else if (
        lastActionAgeMs !== null &&
        lastActionAgeMs > stalledThresholdMs
      ) {
        healthStatus = "stalled-no-wait";
      } else {
        healthStatus = "active";
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
        lastActionAt: lastActionAtMs === null ? null : new Date(lastActionAtMs).toISOString(),
        lastActionAgeMs,
        healthStatus,
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
      stalledRoles: roles.filter((r) => r.healthStatus === "stalled-no-wait").length,
    },
    config: { stalledThresholdMs },
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
