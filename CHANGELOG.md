# Changelog

All notable changes to this project are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Tracking v2.0.0; see [docs/ROADMAP](./docs/ROADMAP.md) for PR sequencing.

### `gojaja watch`: single-instance gate, auto-archive sweep, Archived tab

Follow-up to the backend archive PR. Three changes wire the live
dashboard onto the new `Task.archived` substrate, plus a long-asked-for
"don't let me accidentally start two of these" gate.

**Single-instance gate.** The first `gojaja watch` to start writes a
`.gojaja/watch.lock` recording its pid, host, port, and URL. A
second `gojaja watch` against the same `.gojaja/`:

  - reads the lock, checks `process.kill(pid, 0)` on this host,
  - if the existing process is alive: prints its URL + pid, opens
    the user's browser at that URL (the friendliest signal that
    "you already have one of these"), and exits 0,
  - if the recorded process is dead or written by another host:
    silently overwrites the lock and continues.

`--force` skips the check (escape hatch for a wedged process that
still passes the liveness probe). Cleanup is wired through
`process.on("exit", ...)` (sync, covers normal drain) AND signal
handlers (SIGINT / SIGTERM, for ergonomics) so the lock vanishes
on Ctrl-C the same as on a clean stop.

The lock file deliberately lives at `.gojaja/watch.lock`, NOT
under `Paths.locksDir/` — that directory is the store layer's
short-lived per-resource lock; the watch lock is a long-lived
process registration with very different semantics.

**Auto-archive sweep.** On startup AND every 30 minutes thereafter,
`runWatch` calls `Store.autoArchiveDoneTasks({ thresholdMs: 48 h })`.
Silent housekeeping per the backend PR — no events, no `updatedAt`
bump. The sweep is gated on `store.isInitialised()` so a watch
opened on a not-yet-initialised project doesn't fail noisily. A
failed sweep logs to stderr but never breaks the dashboard
serving path: archiving is cosmetic, the dashboard is not.

The 30-minute timer is `.unref()`-ed so an otherwise-idle event
loop (in tests) isn't kept alive by it.

**`/api/state` split.** Tasks are split into two projections:

  - `tasks` — active board (whatever the sweep has not yet hidden).
    Drops `archived === true` from the response, so the existing
    Task-board UI continues to show only what the user wants on
    their plate.
  - `archivedTasks` — archived tasks, server-side pre-sorted
    newest-`updatedAt` first so the front-end can render per-day
    buckets in a single pass.

`counts.archivedTasks` is added for the tab badge.

**Archived tab.** New top-level tab in the dashboard:

  - One block per local-time day (today's `updatedAt`).
    Day label is "Today" / "Yesterday" for the two most recent
    days, then `YYYY-MM-DD`.
  - Lean card per task — `id · title · owner · priority` only.
    Archived tasks are historical residue; the user is scanning
    for "did we ship X" not "what's the next move on Y", so the
    cards are deliberately tighter than the active board's.
  - Tab label carries a small count badge when non-zero;
    hidden entirely on a clean board so the chrome doesn't grow
    visual noise for projects with nothing to archive yet.
  - Friendly empty state explains "tasks land here after 48 h
    in Done" so users who navigate to the tab on a fresh project
    don't see a blank panel and wonder if it's broken.

Tests in `tests/watch.test.ts` cover:

  - `buildSnapshot` splits archived out of `tasks` and into
    `archivedTasks`, with the count chip reflecting the split.
  - Archived list is sorted newest `updatedAt` first regardless
    of the order tasks were archived.
  - Clean board produces an empty `archivedTasks` and zero count
    (no chip noise).
  - `watch-lock`: round-trip read/write; malformed lock returns
    null (treated as stale rather than throwing); cross-host
    locks are never reported live; a clearly-dead pid on the
    same host returns false; `removeWatchLockSync` is idempotent.

### Task archive: silent housekeeping for Done tasks (backend)

Long-running projects accumulate finished tasks in the `Done` column
of `gojaja watch`'s Task board. After a few sprints the column
becomes a wall of text nobody reads, drowning the columns that
actually need attention. This PR adds the data model + store APIs
to soft-archive those stale finishes; the watch dashboard wiring
(auto-run on startup, 30-minute periodic sweep, dedicated Archived
tab) lands separately so this change stays focused on the contract.

`Task` gains an optional `archived?: boolean` field. Two new store
APIs flip it:

  - `archiveTask({ taskId })` — set `archived = true` for one task.
    Idempotent on already-archived tasks; throws `USAGE` on unknown
    ids.
  - `autoArchiveDoneTasks({ thresholdMs })` — sweep the board for
    `status === "Done" && !archived && updatedAt < now - thresholdMs`
    and archive matches in a single locked transaction. Returns the
    list of archived ids; an empty sweep skips the YAML rewrite
    entirely (no churn on quiet projects).

Both APIs are **deliberately silent**:

  - **No event is emitted.** Archiving is a watch-dashboard view
    decision, not a governance change. Emitting `TASK_ARCHIVED`
    would wake every interested agent every 30 minutes for nothing.
  - **`updatedAt` is NOT bumped.** The Archived tab groups entries
    by `updatedAt` (= "completed on day X"), which is the timeline
    the user actually cares about. Bumping it would scramble that
    view every sweep.

Downstream filters drop archived tasks by default:

  - `manifest.tasks` (the agent's plan) — defensive `if (t.archived)
    continue` inside `taskSummariesForRole`. Today the only path to
    archived is via `Done`, which is already excluded by the
    `ACTIVE_TASK_STATUSES` gate; the explicit check protects against
    a future hand-edit or status-set extension that would otherwise
    leak archived work back into manifests.
  - `gojaja task list` — hidden unless `--include-archived` is set.
    Matches the principle that a default `task list` is "what's on
    the team's plate", not historical residue. The archive flag is
    the audit / debug escape hatch.
  - `gojaja task show` annotates archived tasks with `[archived]` on
    the status line so an agent that fetched a specific id (e.g. via
    `gojaja wait --for event-ref T-0123`) is not surprised the task
    no longer appears in their plan.

`backfillTaskFields` aggressively strips `archived !== true` to keep
the on-disk YAML tight in the (overwhelming) un-archived case.

Tests in `tests/task-board.test.ts` cover:

  - `archiveTask` flips the field, emits no event, leaves `updatedAt`
    untouched, and is idempotent / refuses unknown ids.
  - `autoArchiveDoneTasks` only archives `Done` tasks past the
    threshold (not `Done` under threshold, not non-`Done` over
    threshold), never emits, and short-circuits without a YAML write
    when the board is clean.
  - `manifest.tasks` drops a hand-archived task even when its status
    is still `Ready` (defence-in-depth check).

### Runtime body: frame `wait` as a parked state, suppress 30 s narration

Codex-specific failure mode reported in the wild: the Codex agent
host prompts its agent to "provide a status update" every 30 s while
a tool call is running. With nothing in the runtime body telling the
agent to ignore that for `gojaja wait`, the agent dutifully narrates
every 30 s for the whole duration of the wait — burning tokens on
an idle block. The same anti-pattern shows up in milder forms on
other hosts (agents that get nervous about a long-running tool
call and start "I'm still waiting..." check-ins).

The runtime body's End-of-turn ritual paragraph gains an explicit
parked-state framing:

> **`wait` is a parked state, not active work.** Once it starts:
> no progress narration, no polling, no check-ins with the user.
> The block IS the work — some hosts (e.g. Codex) prompt you to
> "update" every 30 s while a tool is running; ignore that prompt
> for `wait`, or you'll burn tokens narrating an idle block.

Three things the wording does deliberately:

  - "parked state, not active work" is the framing the user-
    reported fix suggested (it's the conceptual root; "do not
    narrate / do not poll" are corollaries).
  - The list of forbidden behaviours is enumerated (narration /
    polling / check-ins) so an agent reading the rule cannot
    rationalise "well, I'll just send one quick update".
  - The Codex callout is named so a Codex agent reading "your host
    is prompting you to update" recognises the situation and knows
    to ignore it. Other hosts benefit from the same rule without
    needing the same callout.

Total runtime card grew by ~5 lines (90/95 → 95/100 across hosts),
still well under the 130-line CLAUDE.md budget.

`tests/prompt.test.ts` gains a regression asserting all three
trigger phrases ("parked state, not active work" / "no progress
narration" / the Codex callout) are present in every host's
runtime body.

### `gojaja watch` Setup tab: role create / prompt --write / activate

Follow-up to the previous PR's tab + init scaffold. The dashboard
now carries the project-bootstrapping operations alongside the
already-shipped Actions, so a user can drive an entire project from
`gojaja init` to "agent windows are activated and looping" without
leaving the browser.

Three new POST endpoints (loopback-only, same gate as the existing
write surface):

- `POST /api/role     { id, title?, description?, owns?, reportsTo?, mustNotEdit? }`
  - Equivalent to `gojaja role create`. Returns the created config
    plus a `needsFill` boolean so the front-end can surface the
    "fill the TBD sections in `.gojaja/roles/<id>.md`" warning that
    matters for `activate` later.
- `POST /api/prompt   { target, forceRewrite?, withHandbook? }`
  - Equivalent to `gojaja prompt --target <X> --write`. Writes the
    runtime files for the chosen host (AGENTS.md / CLAUDE.md /
    `.cursor/rules/gojaja-runtime.mdc`). For `target: "generic"`
    there is no install location — the endpoint returns the
    runtime body without writing files (matches the CLI's preview
    behaviour). Reports `requiresWindowRestart: true` when any
    file actually changed so the front-end can flag "restart your
    open agent windows".
- `POST /api/activate { role, target, withHandbook? }`
  - Equivalent to `gojaja activate <role> --target <X>`. Returns
    the chat-paste snippet directly in JSON; the front-end shows
    it in a textarea with a Copy button (no clipboard side-effects
    on the server side, unlike the CLI which copies via
    pbcopy/wl-copy). Refuses with the same TBD gate the CLI uses,
    so a user cannot generate an activation for a role whose
    markdown is still empty.

Front-end changes:

- New `Setup` tab (between Dashboard and Actions). Three side-by-
  side cards (Create role / Install runtime / Activate). Activate's
  role dropdown auto-populates from the live `roles` snapshot;
  if there are no roles yet it shows "(no roles yet — Create role
  first)" so the empty-state isn't ambiguous.
- Activate output renders into a read-only textarea with a Copy
  button. Uses `navigator.clipboard.writeText` on supported
  browsers and falls back to `document.execCommand("copy")`
  otherwise.
- Both Setup and Actions panels are gated on
  `capabilities.writeEnabled` (loopback-only); on a non-loopback
  bind the tab still appears but the inner panel renders empty
  (the section is hidden), matching the existing Actions behaviour.

Tests in `tests/watch.test.ts` (8 new cases): `POST /api/role` happy
path with the `needsFill` warning surface; missing `id` returns 400
USAGE; `POST /api/prompt` writes AGENTS.md and reports
`requiresWindowRestart: true` on first write, false on idempotent
re-run; generic target previews without writing; unknown target
returns 400 USAGE; `POST /api/activate` refuses while role markdown
has TBD; once the markdown is filled returns the snippet (mentions
the role id verbatim); unknown role returns 400 USAGE.

### `gojaja watch` works on uninitialised projects (init from the dashboard)

Previously `runWatch` called `openStoreOrThrow` and crashed if
`.gojaja/` did not exist. Newcomers ran into "Not initialised; run
`gojaja init` first" before the dashboard could even render — even
though the dashboard is the natural place to drive that first init.
The server now stays up regardless and serves a single-screen
"Initialise this project" landing page for uninitialised roots.

The dashboard layout is also reorganised into tabs to make room for
the upcoming setup actions:

- **Dashboard** tab: roles / task board / RFCs / activity feed
  (everything that was on the page before).
- **Actions** tab: the existing report / open-RFC / create-task forms,
  moved out of the main dashboard so they do not crowd the read view.

(More setup actions — `role create`, `prompt --write`, `activate` —
land in a follow-up PR; the tab structure is shipped first so the
front-end direction can be validated.)

**Init flow** (front-end + back-end):

- Front-end: when `/api/state` reports `initialised: false`, the
  dashboard chrome (tabs, count chips) is hidden and the Init
  landing page takes the whole screen. It shows the project root,
  the `git` inspection result (clean / dirty + sample / not-a-repo),
  and a single primary button.
- First click on a clean repo: `POST /api/init` succeeds; the next
  `/api/state` poll flips the dashboard on.
- First click on a dirty repo: server refuses with 409
  `INIT_GIT_GATE` and the git status sample. The front-end re-
  renders the panel showing the dirty files and switches the button
  into a "I understand — force init anyway" state. A second click
  re-submits with `{ force: true }`.
- Non-git roots: same first-call-then-confirm pattern, but the
  warning explains "no clean revert path" and the button reads
  "Initialise without git". This is the browser-equivalent of the
  CLI's readline `[y/N]` prompt — a non-interactive front-end can
  not poll readline, so the protocol surfaces the gate as a 409
  and lets the JS render confirmation UI.
- Race-safety: a parallel `gojaja init` from a terminal beats the
  dashboard to it → 409 `ALREADY_INITIALISED`; the front-end
  re-fetches `/api/state` and the dashboard appears.
- Defence-in-depth: write endpoints other than `/api/init` (i.e.
  `/api/report` / `/api/rfc` / `/api/task`) refuse with 409
  `NOT_INITIALISED` if called against an uninitialised project, so
  a hand-crafted curl that bypasses the front-end UI gate still
  cannot write into a non-existent layer.

**Code shape**:
- `src/cli/commands/init.ts` is split into pure helpers
  (`inspectInitState` / `performInit` + the `InitGitGateError` /
  `AlreadyInitialisedError` classed exceptions) and a thin
  CLI-flavoured `runInit` that composes them with readline-based
  confirmation. `runInit`'s external behaviour (exit codes, stderr
  wording, JSON shape) is unchanged. The `watch.ts` HTTP path
  composes the same helpers via `POST /api/init` and surfaces the
  errors as `errorCode` strings the front-end maps to UI states.
- `runWatch` stops calling `openStoreOrThrow`; instead it keeps an
  unchecked `LocalFsStore` and the per-request handler short-
  circuits at `isInitialised` for endpoints that need the layer.

**Tests** (`tests/watch.test.ts`, 5 new cases): GET `/api/state`
on an uninitialised project returns the landing-page envelope with
`init.git.kind === "not-a-repo"`; POST `/api/init` without `force`
on a non-git root returns 409 `INIT_GIT_GATE` plus the git detail;
POST `/api/init` with `{ force: true }` succeeds and the next
`/api/state` reports `initialised: true`; a second `/api/init`
returns 409 `ALREADY_INITIALISED`; POST `/api/report` on an
uninitialised project returns 409 `NOT_INITIALISED`.

### `gojaja watch` adds an Actions panel (loopback-only): report / open RFC / create task

The watch dashboard was previously read-only by design. In practice
the human-as-scheduler kept watching the dashboard, spotting a role
that needs a directive, and then context-switching to a terminal to
run `gojaja report --to <role> ...` — three windows of friction for
one decision. This adds the project-owner write surface directly to
the dashboard, gated to loopback so a LAN-shared dashboard remains
read-only.

Three new POST endpoints (all 127.0.0.1-only):
- `POST /api/report  { to, message, ref? }`
- `POST /api/rfc     { slug, title, deciders, voters?, options?, description?, deadline?, relatedTasks? }`
- `POST /api/task    { title, owner?, priority?, dependsOn?, acceptance?, tags?, reviewers? }`

All three write events as `actor: "SYSTEM"` — equivalent to running
the same CLI commands in a shell with no `GOJAJA_SESSION`. The
existing SYSTEM paths (`Store.publishReport`, `Store.createRfc`,
`Store.createTask`) back these endpoints; nothing about audit /
manifest projection / recipient routing changes.

Loopback gate: `isLoopbackBind(host)` (`127.0.0.1` / `::1` /
`localhost`) decides both whether the front-end shows the Actions
panel (`/api/state` returns `capabilities.writeEnabled: true`) and
whether the POST handlers accept (non-loopback → 403 with a message
pointing at `--host 127.0.0.1`). The server-side gate is enforced
independently of the front-end toggle so a hand-crafted curl from a
non-loopback origin still 403s.

Dashboard UI: a new `Actions` section between Roles and Task board,
three side-by-side cards (Report / Open RFC / Create task), inline
error / success feedback under each form (no toast), role dropdowns
auto-populated from the live `roles` snapshot. `--host 0.0.0.0` (or
any non-loopback) hides the section.

Tests in `tests/watch.test.ts` (8 new cases) spin a real HTTP server
on an ephemeral port, hit it with `fetch`, and assert: loopback bind
reports writeEnabled=true; non-loopback reports false; report happy
path records `from: SYSTEM`; report from 0.0.0.0 returns 403;
missing required field returns 400 USAGE; unknown recipient surfaces
the store-layer USAGE; rfc records `createdBy: "SYSTEM"`; task
records `creator: "SYSTEM"`. `__test_handleRequest` is exported
from `watch.ts` so the test runs the production routing verbatim.

Updated README.md / README.zh-CN.md (the watch section drops the
"read-only" language, gains a description of the Actions panel and
its loopback gate); `gojaja watch -h` updated in both the long-form
CLI help and the per-command summary.

### Runtime body: "Tasks pull" — assigned task is itself the start signal

Companion soft constraint to the previous "wait is the end-of-turn
ritual" rule. Different failure mode, same root cause: the agent
treats user chat as the primary drive signal, so a task it already
owns sits at "I'll start when you say so" instead of getting picked
up. The protocol has already pushed the task — the agent reading
"InProgress, owner: <me>" in its manifest IS the green light.

`## Rules` gains a hard rule, listed second (right after the
end-of-turn-`wait` rule):

> **Tasks pull. If your `plan` manifest shows a task you own in
> Ready / InProgress / Blocked, start working on it immediately —
> accepting the task in plan IS the start.** Do NOT pause to ask
> "shall I begin?" / "ready when you are" / "let me know when to
> proceed". The only legitimate detour is a blocking ambiguity, and
> the response to that is `gojaja report` to the right party
> (`reportsTo`, reviewer, or parent task owner) or `gojaja rfc` —
> never silent waiting for the user to push you.

The two anti-patterns ("shall I begin?" / "ready when you are") are
quoted verbatim from the literal phrasings users have reported
seeing — a regression test in `tests/prompt.test.ts` greps for them
specifically so a future softening of the rule trips loudly.

The "blocking ambiguity → report or rfc" carve-out matters because
"don't wait for the user" without an escape hatch would push agents
to plough through a genuinely-unanswered acceptance criterion. The
correct route — escalate via `report` or open an `rfc` — is named
explicitly so the rule does not reduce to "just guess".

Still a soft constraint (only PR8v's stop hook will mechanically
refuse). Total runtime card grew by ~8 lines (97/102 → 105/110
across hosts), still well under the 130-line CLAUDE.md budget.

### `gojaja claim --session <id>`: idempotent recovery from context-loss

Empirically the second-most-common per-agent failure mode (after the
"agent ends turn without `wait`" one): an agent loses `GOJAJA_SESSION`
to context compaction or a fresh shell, retries `gojaja claim`,
hits "Role 'X' is already claimed by a live session" (the live
session is its own from earlier!), and gets stuck — it cannot use
`--force` (red line for agents) and ends up bouncing the question
back to the human. Hours of lease TTL get wasted on a problem the
agent had all the information to solve, if only the CLI had given
it a path.

`gojaja claim` now accepts `--session <id>`, the idempotent
recovery flag:

- `claim <role> --session <id>` with the id matching the live
  session → refreshes heartbeat and re-exports the SAME id; no new
  session minted, no `SESSION_CLAIMED` / `SESSION_TAKEOVER` event
  emitted (recovery is a no-op on the audit stream).
- `--session <id>` with the id NOT matching the live session →
  refuses with USAGE: `"id you supplied does NOT match — that
  session was taken over or released. Stop and ask the user before
  forcing anything."` Prevents an agent from silently taking over
  a peer just by guessing.
- `--session <id>` with no live session at all → falls through to a
  fresh claim. The id is effectively a "previously-held hint" that
  turned out to be expired; this matches what an agent retrying
  after a long absence would naturally expect.
- `--session` and `--force` are mutually exclusive (USAGE) — they
  are different actions: recovery vs takeover.

The "live peer" claim error is also rewritten to put the recovery
path FIRST, ahead of the human-only takeover path:

```
Role 'X' is already claimed by a live session (sessionId 01..., heartbeat Ns ago).

If you previously held THIS session and just lost `GOJAJA_SESSION`
(context-loss / fresh shell), recover it without re-claiming:
  1. Find `GOJAJA_SESSION=<ulid>` in your earlier `gojaja claim`
     output (chat history).
  2. Run `gojaja claim X --session <that-ulid> --eval`. If the id
     matches the live session, this just re-exports it.

If the previous window is genuinely dead AND the user has confirmed
it, see `gojaja claim --help` for the human-only takeover path.

Otherwise stop and ask the user — do NOT silently take over a peer.
```

The empirical pattern this targets: an agent reading the error and
collapsing straight to "ask the user" because that was the only
path the previous error spelled out. Recovery is now path #1, with
a concrete pointer to chat history.

Type changes: `Store.claimSession`'s third parameter widened from
`force?: boolean` to `options?: { force?: boolean;
recoverSessionId?: string }`. No existing call site passed `force:
true` (verified — `Grep claimSession\(.*true` is empty), so the new
shape is backward-compatible for every two-argument call.

Tests in `tests/claim.test.ts` (5 new cases) cover: matching id is
idempotent and emits no audit event; mismatch refuses; expired id
falls through to fresh claim; `--session` + `--force` USAGE error;
the live-peer error wording names `--session` and "recover" and
"chat history". 385/385 pass.

Updated `gojaja claim -h`, `gojaja claim --help` short summary,
and `docs/PROTOCOL.md` Claim section.

### `gojaja report` accepts SYSTEM (no GOJAJA_SESSION) for project-owner directives

The same SYSTEM-friendly path that `rfc new`, `rfc comment`,
`task new`, and `state edit` already had now extends to `report`. A
human running the CLI without `GOJAJA_SESSION` had been able to open
RFCs and push tasks at any role — but trying to direct a one-line
"hey, re-evaluate this" at a specific role hit a session gate. The
gate forced the human to either bounce the directive through a peer
agent's chat or claim a role they did not own; both ugly. `report`
now resolves the actor via `resolveActor`; the resulting `REPORT`
event records `from: "SYSTEM"`.

- The recipient `to` field is still required to be a registered role
  (the typo guard from PR8b is unchanged). Humans send TO roles, not
  AS roles — the receiver's manifest displays the `from: "SYSTEM"`
  directly so they can tell whether the directive came from a peer
  agent or from the project owner.
- `worklog` deliberately stays role-only. A worklog is a team-wide
  broadcast that needs a peer-agent voice to be meaningful; the
  project owner's broadcast channel is conversational chat, not the
  team's progress feed.
- Type changes: `Store.publishReport`'s `from` widened from `RoleId`
  to `RoleId | "SYSTEM"`; `LocalFsStore.publishReport` now skips
  `validateRoleId` when `from === "SYSTEM"`. No payload schema
  change.
- Tests in `tests/plan-ack.test.ts`: SYSTEM-as-from happy path
  (event records correctly + visible to recipient + invisible to
  unrelated role); SYSTEM still cannot bypass the recipient gate
  (typo `to: "Forntend"` rejected).
- Updated README.md / README.zh-CN.md (the "without a role" tables
  and the wrap-up paragraph), `docs/PROTOCOL.md` `gojaja report`
  section, and `gojaja report -h`.

### Runtime body: `wait` is the end-of-turn ritual + hard rule against ending unparked

Direct follow-up to the previous "stalled-no-wait" PR: that one
made the failure visible (stronger ack warning + watch dashboard
red flag), this one makes the rule against it explicit at the spot
agents check most often — the runtime card injected into AGENTS.md /
CLAUDE.md / cursor rules.

Two coordinated changes to the runtime body:

- **`## Every turn` rewritten.** Steps 1–4 are unchanged
  (`plan` → work → emit → `ack`); step 5 is replaced by an
  explicit "**End-of-turn ritual: `gojaja wait`**" paragraph
  framed as the one legitimate way to end a turn. The previous
  step-5-among-many shape read as a disjunctive checklist where
  `wait` was just one option to skip; the new framing positions it
  as a ritual the turn cannot end without. Step 2 also adds a
  small carve-out — answering the user in chat is "the work" of
  that turn — so agents do not interpret a chat-only response as
  outside the loop.
- **`## Rules` gains a hard rule, listed first.** Verbatim:
  > **NEVER end a turn without `gojaja wait` as the final tool
  > call.** wait is what keeps your role reachable — without it
  > no event can wake you and the team's coordination loop breaks
  > silently. This applies EVEN when the user sent a
  > conversational message that needed no gojaja work: answer the
  > user, then run wait before letting the turn end. "I'm online,
  > waiting for instructions" is not a turn end — wait is.

  The "EVEN when the user sent a conversational message" carve-out
  directly targets the empirically observed failure mode: agents
  reading a user chat message as "no gojaja work needed" and
  ending the turn unparked. The "I'm online, waiting for
  instructions" sentence quotes the literal pattern users have
  reported seeing.

These are still soft constraints — only the planned PR8v host stop-
hook can mechanically refuse a turn that ends without `wait` — but
they raise the floor of the soft layer at the spot agents read most
often. Total runtime card grew by ~13 lines (84/89 → 97/102 across
hosts), still well under the 130-line CLAUDE.md budget.

`tests/prompt.test.ts` gains a regression that asserts every host's
runtime body contains the hard rule, the conversational-message
carve-out, and the end-of-turn-ritual framing.

### Stronger ack warning + dashboard "stalled-no-wait" red flag

Empirically the most common per-turn failure mode is "agent runs
`gojaja ack`, sees the success line, then sits silent waiting for
user input" — `plan -> ack` reads like a complete loop on its face,
because the manifest came in and got acknowledged. It's not. ack is
a housekeeping op that only advances the cursor; without a
follow-up action OR a `gojaja wait`, no event can wake the role
and the team's loop stops there.

Two layers of fix, both shipped together so the message and the
fallback are aligned:

**Layer 1 — stronger `ack` post-output warning.** The previous
generic `nextLoopHint` (also used by worklog/report/task/rfc) was
too soft for ack: it read as "do any of three things, or end the
turn", and agents collapsed it into a fourth implicit "do nothing"
option. ack now uses a dedicated `ackHint`:

  - explicit `WARNING: TURN NOT COMPLETE` framing
  - flat list of the only acceptable continuations (another
    action, or `gojaja wait`)
  - no disjunctive "or end the turn" wording — the only end-of-
    turn path is `wait`

Other action commands keep the original soft hint. `--json` mode
and SYSTEM actor both suppress the warning, same skip rules as the
existing hint helpers.

**Layer 2 — `gojaja watch` flags stalled roles in red.** When the
warning still gets ignored (it will, sometimes), the human-as-
scheduler needs to see it on the dashboard. The watch snapshot now
carries a per-role `healthStatus` derived as:

  - `no-session`        no claim; nothing to nudge
  - `stale-session`     session lease expired; takeover-eligible
  - `waiting`           wait.json present; the green path
  - `active`            live session, no wait.json, last action
                        recent (under threshold)
  - `stalled-no-wait`   live session, no wait.json, last action
                        older than threshold — **the failure mode
                        above**, surfaced in red on the dashboard

The threshold defaults to 60 s and is overridable via
`?stalledThresholdMs=` on `/api/state`. SYSTEM-authored events
(human running CLI as SYSTEM) deliberately do NOT count as the
role's `lastAction` — we're tracking whether the agent itself made
progress this turn.

**Dashboard UI:** stalled roles get a red border + red 'stalled'
badge + a clear "⚠ stalled — last action Xm ago, no `gojaja wait`
since" warning line; the header gains a `stalled <n>` chip that
hides at 0 and turns red when populated.

**Tests:** `tests/watch.test.ts` (8 cases) pin every healthStatus
branch including SYSTEM-authored events not counting and a
parked-but-ancient role staying `waiting`. `tests/next-hint.test.ts`
gains a case verifying ack uses the stronger warning (and that the
generic soft hint is NOT also emitted) plus a JSON-mode suppression
case. 377/377 pass.

### RFC pre-decide gets two structural gates + a withdraw escape (PR8u)

Multi-decider RFCs were prone to two governance failures: deciders
sat on a fully-discussed RFC because nobody felt empowered to
pre-decide first ("comment-coverage scenario A"), and competing
deciders silently overwrote each other's pre-decisions, with the
final ACK round resolved on whoever wrote last ("re-publish race").
The fix is mechanical, not advisory: the framework now blocks the
race conditions at the store layer.

**Comment-coverage gate.** `rfc pre-decide` now refuses with a
USAGE error (and lists the missing roles) until every required
commenter — `(voters ∪ deciders) − {createdBy if not SYSTEM}` — has
posted at least one regular `rfc comment`. Structured posts (ack /
object / pre-decision / withdraw) deliberately do not satisfy the
gate. The creator is excluded by design — the proposal's
`description` is their initial framing, and forcing them to also
comment would either be ceremony or self-anchor the discussion
toward whatever their first comment says.

**RFC_READY_TO_DECIDE auto-emission.** The framework emits a new
broadcast event (`from: "SYSTEM"`, payload includes the snapshot of
required commenters) the moment the comment-coverage gate flips
green and there is no active pre-decision. Re-emitted on a fresh
late comment before any pre-decide (so a late voter still gets
heard); suppressed once a pre-decision is active. Visibility
follows the standard RFC_* rule: voters ∪ deciders ∪ {createdBy if
not SYSTEM}. Wired into `filterVisibleEventsForRole`'s prepass +
broadcast switch.

**Active-pre-decision gate.** `rfc pre-decide` now refuses if one
is already active (the previous "latest-wins" behaviour was a
silent overwrite race). The error names the active proposer and
points at the two ways out:

  - `rfc withdraw-pre-decision <rfc-id> --rationale ...`
    (author-only self-revoke; appends a `kind: "withdraw"` comment
    that `computeActivePreDecisionInLedger` reads back to clear
    the active state); or
  - `rfc add-option <rfc-id> ...` — keeps the existing rule that
    add-option silently invalidates any active pre-decision (the
    option set has changed; the prior ACK round was against an
    outdated set).

**Existing acks naturally invalidate after withdraw / re-propose.**
No new code: ack/object posts predate any future pre-decision's
`ts`, and the standard `c.ts > active.ts` gate already excludes
them. The next ACK round restarts cleanly.

**New types / commands**:

  - `EventType` adds `RFC_READY_TO_DECIDE` and a matching
    `RfcReadyToDecidePayload` carrying `{ rfcId, requiredCommenters }`.
  - `RfcCommentKind` adds `"withdraw"`.
  - `Store.withdrawRfcPreDecision({ rfcId, role, rationale })`.
  - `gojaja rfc withdraw-pre-decision <rfc-id> --rationale <text>`
    CLI command.

**Tests** in `tests/rfc-v2.test.ts` (new `PR8u` describe block, 12
cases) cover: comment-coverage error / creator exclusion /
structured-kind comments don't satisfy / READY emission and
re-emission / READY suppressed once active / active gate refusal /
withdraw clears active / withdraw refused without active / withdraw
forbidden for non-author / old acks invalidate after withdraw /
add-option still invalidates active (keeps the existing rule).

**Existing tests** that pre-decided without first satisfying
comment coverage were updated to either call a new
`satisfyCommentGateForNewRfc` helper or post the specific comments
their RFC needed. The legacy "re-publish overwrites previous ACKs"
test was rewritten around the new withdraw + fresh pre-decide flow.

**Docs**: `docs/PROTOCOL.md` rewritten around the two gates plus a
new `RFC_READY_TO_DECIDE` event section + a new
`withdraw-pre-decision` subcommand section; visibility table adds
`RFC_READY_TO_DECIDE`. `docs/SCHEMA.md` event table mentions
`kind: "withdraw"` and `RFC_READY_TO_DECIDE`. `gojaja rfc -h` lists
the new subcommand and the two gates. `gojaja handbook` rewritten
in the multi-round-RFC section to cover both gates and the
withdraw escape; size budget held under 12 KB.

### `wait --for task-assigned` idle worklog narrowed to task-board owners

A direct fix for a mutual-wakeup loop introduced together with the
prior `wait --for` change ("verdict tag, not event filter"). When two
peer roles went idle around the same time, each one's `wait` would
ATTENTION-fire on the other's "I am idle" worklog (a broadcast visible
to everyone), `ack`, re-park, re-broadcast its own idle worklog, and
repeat — burning turns indefinitely with no real attention.

- `WorklogPayload` gains an optional `kind?: "idle"` field. Default
  (undefined) is the original team-wide progress update.
- `wait --for task-assigned` now passes `kind: "idle"` when emitting
  its session-open auto-broadcast.
- `filterVisibleEventsForRole`'s WORKLOG case checks `kind`: idle
  worklogs are narrowed to **task-board owners only** (the only
  audience whose attention the broadcast was ever meant to attract).
  Default-kind worklogs stay broadcast to every role, unchanged.
- The event itself is still recorded as `to: "*"` so audit / history /
  `gojaja doctor` see the full broadcast intent. Visibility is the
  per-role projection layer's concern.
- Self-events (`from === role`) are still filtered out before the
  kind check, so the author also never sees their own idle broadcast.
- Tests in `tests/plan-ack.test.ts` (idle visibility) and
  `tests/wait.test.ts` (peer idle does not wake another peer) pin
  the contract.
- Updated `docs/PROTOCOL.md`: the per-role visibility table now lists
  `WORKLOG` with and without `kind: "idle"` separately, and the wait
  side-effect description points at this rationale.

### Action commands print a `Next: ...` loop reminder

The recurring failure mode this guards against: an agent runs a
side-effect command (`worklog` / `report` / `task status` / `rfc
comment` / etc.), sees the success line, and silently ends the turn —
forgetting to either keep working or park on `gojaja wait`. Without
one of those the role goes dark and the team stops driving forward;
on a single-machine setup there's no external scheduler to wake it
back up, so the human has to nudge it manually, defeating the point
of the protocol.

- Added `src/cli/next-hint.ts` exporting `nextLoopHint` (generic) and
  `claimHint` (specialised). The generic hint reads
  `Next: continue this turn with another action, or run \`gojaja plan\`
  (see new events) / \`gojaja wait\` (park until attention). Ending
  without one stalls the role.`
- Wired into every agent-loop side-effect command: `worklog`,
  `report`, `ack`, `task new` / `assign` / `status`, `rfc new` /
  `comment` / `add-option` / `pre-decide` / `ack` / `object` /
  `decide` / `reject` / `revise` / `edit` / `link-task` /
  `unlink-task`, and `state edit`. `claim` gets the specialised
  variant pointing at `gojaja plan` (its actual next step).
- Skipped in `--json` mode (output must stay a single parseable
  object) and when the actor is `SYSTEM` (a human running the CLI
  has no per-turn loop to keep alive).
- `wait` and `plan` are NOT decorated — they each already print
  their own context-specific `Next: ...` lines (verdict-keyed for
  `wait`, ack-token-keyed for `plan`).
- Tests in `tests/next-hint.test.ts` (8 cases) pin the contract:
  hint present in plain mode, absent in `--json`, absent for SYSTEM
  callers, and the specialised `claim` variant.
- Handbook gains a one-liner pointing the agent at the in-output
  `Next:` reminder so the policy and the runtime nudge are stitched
  together.

### `rfc comment` accepts SYSTEM (no GOJAJA_SESSION) for plain comments

Symmetric with `rfc new`'s SYSTEM path: a human running the CLI without
`GOJAJA_SESSION` could open an RFC but was previously blocked from
adding any follow-up comment to it. They had to either bounce the
guidance through an agent's chat or claim a role they did not own —
both bad. Plain `rfc comment` now resolves the actor via
`resolveActor`, so SYSTEM is allowed; the resulting RFC_COMMENT event
records `from: "SYSTEM"` (and `payload.role: "SYSTEM"`), exactly like
a SYSTEM-created RFC.

- Structured kinds (`pre-decide` / `ack` / `object`) still reject
  SYSTEM at the store layer with a clear USAGE message; those carry
  a position and the ACK gate is computed over `voters ∪ deciders`,
  which SYSTEM is not in.
- SYSTEM has no manifest / read cursor, so the per-RFC read marker
  under `cursors/<role>/rfc-<id>.json` is skipped for SYSTEM (would
  otherwise create a stray `cursors/SYSTEM/` directory no role would
  ever consult).
- Type changes: `RfcComment.role` and `RfcCommentPayload.role`
  widened from `RoleId` to `RoleId | "SYSTEM"`. Downstream consumers
  (ACK gate, `filterVisibleEventsForRole`, `wait --for rfc-acked`,
  `computeActivePreDecisionInLedger`, RFC summary) are unaffected:
  they all branch on `kind ∈ {ack, object, pre-decision}` or compute
  set membership in `voters ∪ deciders`, neither of which a SYSTEM
  comment can satisfy.
- Tests in `tests/rfc-v2.test.ts` cover both directions: SYSTEM can
  post a plain comment (event `from=SYSTEM`, no `cursors/SYSTEM/`
  written); SYSTEM is rejected with USAGE for every structured kind.
- Updated `gojaja rfc comment -h` and `docs/PROTOCOL.md`.

### `wait --for` is a verdict tag, not an event filter

Restores the original intent of `--for`: a side-effect / verdict tag,
NOT a predicate that mutes unrelated events. The previous shape made
`--for X` ignore every event that wasn't `X`, which had a designed-in
correctness bug — a developer parked on `--for task-assigned` was
missing a CTO-led, all-hands RFC because the event "didn't match".

- **Behavior change.** `gojaja wait` now wakes on **any** event the
  role would see in its manifest (the same projection `plan` uses,
  `Store.filterVisibleEventsForRole`), regardless of `--for`. `--for`
  no longer filters anything.
- `--for` keeps its two original purposes: (a) verdict tag — when a
  visible wake event also satisfies the predicate, the verdict
  upgrades from `ATTENTION` to `CONDITION_MET` and the report points
  at that event's id; otherwise the verdict is `ATTENTION` and wait
  still ends; (b) for `--for task-assigned`, a one-shot idle WORKLOG
  emitted at session open so task-board owners can pick the role up.
- Both verdicts mean "run plan next"; the distinction is
  informational, not a gate. Picking the wrong `--for` cannot mute
  cross-team attention any more.
- `tests/wait.test.ts`: rewrote the `rfc-decided` and `report-from`
  cases around the new "tag, not filter" semantics, and added a
  regression covering the bug above (`--for task-assigned` waking on
  an unrelated `RFC_CREATED` as `ATTENTION`).
- Updated `-h`, handbook, `docs/PROTOCOL.md`, `docs/DESIGN.md`.

### `wait` is one blocking call again — internal polling, no RESUME loop

Restores the original intent of `wait`: a single invocation parks the
agent in ONE tool call for the whole deadline, so an idle agent burns no
LLM turns / tokens. The previous shape exited after a single
`--poll-interval` (a "RESUME" verdict) and made the agent re-invoke every
interval, which reintroduced a per-poll LLM turn and defeated the whole
point.

- A `wait` call now **blocks**, re-checking the event stream every
  `--poll-interval` (default 30s, an in-process cadence) and sleeping in
  between, until it returns one of three terminal verdicts: `ATTENTION`,
  `CONDITION_MET`, or `TIMEOUT`. The `RESUME` verdict is removed
  (`WaitStatus` no longer has `"resume"`).
- **Indefinite waits.** `--in` / `--until` are now optional; bare
  `gojaja wait` blocks indefinitely (still event-wakeable) and never
  TIMEOUTs. `wait.json` stores `deadline: null` for that case. The
  runtime body / handbook advise treating a host kill's timing as the
  host's per-tool-call timeout and capping re-runs at ~5 before ending
  the turn, so an idle wait stays long but cheap.
- `--poll-interval` is now purely a detection-latency knob, not a
  re-invocation interval — so the recommended `wait` invocation is
  uniform across hosts (no per-host `--poll-interval 30s` pin for
  Cursor).
- Host-kill recovery: if the host harness kills the long-blocking call,
  the agent re-runs `gojaja wait` with **no deadline flags**, which
  resumes the in-progress session (same deadline + condition) from
  `comms/pending/<role>/wait.json`. Passing `--in` / `--until` starts a
  fresh wait. The `--for task-assigned` idle worklog stays one-shot
  across such a resume.
- Updated prompt/runtime body, handbook, `-h`, PROTOCOL, SCHEMA, DESIGN;
  rewrote the RESUME-based wait tests around blocking + resume.

### AGENTS.md is the single canonical runtime; other targets shrink (PR8aa)

Lean into AGENTS.md as the cross-tool standard so there is essentially
one runtime file to maintain.

- **`--target agents`** writes the managed block into `AGENTS.md` — the
  cross-tool standard read by Codex, Cursor, Copilot, Windsurf, Zed, and
  more. For most projects this is the only install needed. (The old
  `codex` target — and the user-level Codex skill it used to install —
  are gone; pre-release, no compatibility shim kept.)
- **`--target claude`** now writes `AGENTS.md` (the canonical block)
  **plus** a thin `CLAUDE.md` whose managed block only imports it
  (`@AGENTS.md`). Claude Code doesn't read AGENTS.md natively yet, so
  this keeps a single source of truth while still covering Claude Code
  — `CLAUDE.md` is a one-line pointer, not a second copy of the runtime.
- **`--target cursor`** is now documented as an optional fallback
  (Cursor reads AGENTS.md; the standalone `.mdc` is only for old Cursor
  or `.mdc`-specific features).
- The duplicate-injection guard now keys off the runtime body phrase
  rather than the marker, so the `CLAUDE.md` importer (a pointer) does
  NOT count as a second full-runtime file — no false warning for the
  normal Claude setup; it still warns on AGENTS.md + a standalone
  Cursor `.mdc`.
- Marker constants moved to `prompts/markers.ts` (shared by claude.ts
  and codex.ts) to avoid a circular import; `claude.ts` re-exports the
  historical names. `reset` already strips the block from both
  CLAUDE.md and AGENTS.md.
- Docs (help, README EN+zh-CN, PROTOCOL) lead with `--target agents`.

### Duplicate-injection guard for overlapping runtime files (PR8z)

Because AGENTS.md is now a cross-tool standard (Cursor reads both
AGENTS.md and `.cursor/rules`; Claude Code reads CLAUDE.md and, on
recent versions, AGENTS.md), installing several `prompt` targets in one
project can make a single host inject the same runtime block twice —
wasteful, though not harmful (identical content).

- `gojaja prompt --write` now detects coexisting runtime files
  (`.cursor/rules/gojaja-runtime.mdc`, the AGENTS.md block, the
  CLAUDE.md block) and prints a note explaining the overlap and the
  minimal-target strategy (AGENTS.md alone covers Cursor + Codex + most
  CLI agents; add CLAUDE.md only for Claude Code; avoid stacking the
  Cursor `.mdc` on top of AGENTS.md). `--json` adds an
  `installedRuntimeFiles` array.
- README (EN + zh-CN) Step 3 now documents "install the minimum set".
- Confirmed: a marker-block target creates CLAUDE.md / AGENTS.md if
  absent (containing just the managed block) and `reset` deletes the
  file again if the block was all it held.

### Shrink injected prompt + Codex goes project-local (PR8y)

The artifact `gojaja prompt --write` injects into each host's system
prompt was ~313 lines (the runtime loop + the full ~250-line
collaboration handbook), well past Claude Code's ~200-line CLAUDE.md
budget. Split it into tiers:

- **Injected "runtime card" is now ~80 lines / ~3.7 KB** (was ~313 /
  ~14 KB). It keeps only what an agent needs to re-orient after context
  compression: the loop, identity recovery, the hard invariants, a
  compact "when to use which" cheatsheet, and pointers.
- **`gojaja handbook`** (new command) prints the full judgement layer
  (channel choice, escalation, multi-round RFC mechanics, deliverable
  gates, task lifecycle) on demand. It is no longer embedded in the
  system prompt — an agent fetches it when making a judgement call.
  `plan`'s text footer points at it; the card points at it; `gojaja -h`
  remains the command/flag reference.
- `--no-handbook` now drops just the compact cheatsheet (the full
  policy is always available via `gojaja handbook`).

### Codex runtime is now project-local in AGENTS.md (drops ref-counting)

Codex injects each project's `AGENTS.md` into the model instructions at
session start — the same always-on, survives-compaction channel as
Cursor's rule file and Claude's CLAUDE.md block, but **project-local**.

- `prompt --target codex --write` now upserts a managed
  `<!-- gojaja-runtime:BEGIN ... :END -->` block in `<project>/AGENTS.md`
  (preserving surrounding user content), instead of installing a
  user-level skill at `~/.codex/skills/gojaja-runtime/`. This also fixes
  a latent flaw: a skill is invoked on demand and not guaranteed to stay
  in the system prompt, whereas AGENTS.md always is.
- **Reference-counting is gone.** It only existed because the skill was
  user-level and shared across projects. Removed `codex-registry.ts`,
  the `prompt`/`reset` ref-count plumbing, and `reset --purge-codex-skill`
  / its `--force`. `reset` now strips the gojaja block from both
  CLAUDE.md and AGENTS.md, exactly like it already did for CLAUDE.md.
- Codex activation is now the standard chat-paste snippet (no
  `$gojaja-runtime` skill-invocation trigger).
- All three hosts are now symmetric and project-local: Cursor `.mdc`,
  Claude `CLAUDE.md` block, Codex `AGENTS.md` block — no user-level
  footprint, all removed by `reset`.

### Cross-host collaboration: dashboard, identity escape hatch, safer init (PR8x)

Hardening for the core use case — several agent windows (Cursor /
Claude Code / Codex CLI) coordinating on one machine.

- **`gojaja watch` — read-only web dashboard.** Starts a local HTTP
  server (127.0.0.1:7421 by default, falls back to a free port) and
  opens the browser. One screen shows every role's session
  (live / stale / idle-waiting + pid/host/heartbeat), the task board by
  status, open RFCs, and a live newest-first activity feed across all
  windows. On a single machine nothing can wake a turn-ended agent, so
  the human is the scheduler; this is their view. `--port` / `--host` /
  `--no-open`. Never mutates state.
- **`--session <id>` global flag.** Identity is normally read from
  `GOJAJA_SESSION`, but some hosts run each command in a fresh shell and
  drop the `export` from `claim`. Agents on those hosts can now pass the
  id explicitly on every command. Dispatch sets it into the environment
  so all existing resolution works unchanged; an explicit flag overrides
  an inherited env var. Documented in the runtime body, activation
  snippet, PROTOCOL, and the help text.
- **`gojaja init` git safety gate.** Refuses to run when the project
  has uncommitted git changes (commit/stash first for a clean revert
  point); when the project is not a git repo, warns and asks for y/n
  confirmation (or requires `--force` when stdin is not a TTY).
  `--force` bypasses both checks.
- **`.gojaja/.gitignore` written at init.** Excludes machine-specific
  runtime state (`locks/`, `comms/sessions/`, `comms/pending/`,
  `comms/heartbeats/`, `comms/cursors/`) so a committed `.gojaja/` does
  not resurrect a stale "live" session that blocks `claim`, or stale
  locks/read-cursors, on another checkout. The audit trail (events,
  worklog, rfcs, state, roles, config) stays committable.
- **Session TTL 30 min → 2 h.** Long agent tasks can keep a window busy
  well past 30 minutes without emitting a command; every authenticated
  command still auto-renews, so this only governs how long a *silent*
  session stays claimable by others.
- **Codex skill is now reference-counted.** The user-level skill at
  `~/.codex/skills/gojaja-runtime/` is shared across projects.
  `prompt --target codex --write` registers the project; `reset`
  de-registers it and `reset --purge-codex-skill` deletes the skill
  only when no other project still uses it (otherwise it is kept and
  the user is told which projects depend on it). `--force` deletes
  regardless. This replaces "delete and hope no other project needed
  it" with a safe ref-count.
- **Fixed: a second project's `prompt --target codex --write` was
  refused.** The artifact-recognition guard only accepted files
  containing "gojaja plan", but the shared `agents/openai.yaml` does
  not contain it — so once one project had written the user-level
  skill, every other project (and re-runs) hit "does not look like a
  gojaja artifact". Recognition now also accepts the "gojaja-runtime"
  marker, which all generated artifacts carry. This was what blocked
  the Codex ref-count flow above from ever seeing a second project.
- Docs: README (EN + zh-CN) gain a `watch` section, a cross-host
  identity troubleshooting entry, and the human `claim --force`
  takeover path; roadmap updated.

### Project-wide audit fixes (PR8w)

A full scan surfaced a batch of contract/text drift and two real
concurrency bugs. No compile errors and the suite was green before;
these are correctness/consistency fixes.

Behaviour / concurrency:

- **RFC self-heal no longer self-deadlocks.** `readRfcUnchecked`'s
  crash-recovery (decision.json present but proposal still `open`)
  re-entered `withLock(\`rfc-<id>\`)`. Mutating callers
  (`commentRfc` / `decideRfc` / `addOption` / `revise` / `edit` /
  `link`/`unlink-task`) already hold that non-reentrant lock, so the
  repair would hang until `LOCK_TIMEOUT`. Extracted
  `repairFinalisedRfc` (lockless) and gave `readRfcUnchecked` a
  `lockHeld` flag; locked callers repair inline. Added a regression
  test exercising the locked path.
- **`gojaja state edit` is now serialised per file.** The
  append/replace read-modify-write (and overwrite) now run under a
  per-file lock, so two concurrent edits to the same state file can no
  longer lose each other's bytes (lost update). Unrelated files still
  edit in parallel.
- **Subcommand `--help` / `-h` no longer executes the command.**
  `gojaja wait --help` used to fall through and actually block on a
  wait; `gojaja init --help` could initialise the project. A
  `--help`/`-h` anywhere now prints help and exits 0 before dispatch.

Text / contract accuracy (agent- and user-facing):

- Fixed the `gojaja -h` exit-code table to match `errors.ts`
  (`NOT_INIT=3`, `LOCK_TIMEOUT=6`, `PATH_INVALID=7`, `STATE_CORRUPT=8`,
  `FORBIDDEN=9`). It previously claimed `NOT_INIT=6` and
  `STATE_CORRUPTION=10`, which would mislead agents/scripts branching
  on the code.
- Rewrote the `rfc comment` help text that wrongly said a plain
  comment auto-reopens an RFC and "silence is consent" — the ACK gate
  requires explicit `rfc ack` / `rfc object`; silence is never consent.
- Removed the reference to a non-existent `gojaja task reviewer ...`
  command from the FORBIDDEN error on owner-Done.
- Removed the dead `--no-wait` boolean flag (no consumer).
- Docs: `PROTOCOL.md` now uses `gojaja prompt --target` (the role-free
  form) and documents the real `claim --json` shape
  (`{ status, session }`); `SCHEMA.md` VERSION example, RFC options
  ("may be empty" / brainstorm), and the `rfcs/` tree (`comments.yaml`,
  not `comments/<role>.json`) are corrected; `RFC.md` command table
  marks `--options` / `decide --option` as conditional.
- `gojaja init` re-init message now says "gojaja" (not "multi-agent")
  and points at `gojaja reset`.

### Drop back-compat hints + dead migration code (PR8v)

The project has no released users, so accumulated "migrate from
PR8X" hints and back-compat code paths were costing context budget
and clarity without buying anything.

- Removed every `PR8x` / `pre-PR8x` / `legacy ...` / `alpha-only`
  reference from user-facing artifacts: `gojaja -h`, the runtime
  prompt body, the collaboration handbook, READMEs, and the user
  docs (`PROTOCOL`, `SCHEMA`, `RFC`, `HANDBOOK`, `DESIGN`). The
  history-by-design `CHANGELOG` and `ROADMAP` are unchanged.
- Removed the dead `assignedBy → creator` promotion in
  `backfillTaskFields`. A task missing `creator` on disk now
  defaults to `"SYSTEM"` rather than `null`, and `Task.creator`
  drops the `| null` member from its type.
- Removed the `task.creator === null` fallback in `setTaskStatus`:
  the new Done-permission gate applies uniformly. A hand-edited
  task missing `creator` is treated as SYSTEM-created and refuses
  owner-Done; the task-board-owner path still works for sign-off.
- Removed the `proposal.yaml status: pre-decide` and the
  `preDecision: {...}` field detectors from `readRfc`, plus the
  `comments/<role>.json` directory detector and the
  `rfcLegacyCommentsDir` helper from `paths.ts`. Those on-disk
  shapes were ephemeral pre-release shapes.
- Source-level scaffolding comments (`// PR8x: ...`) were stripped
  in bulk; the design comments themselves are preserved, just no
  longer date-stamped.

### Planned next

- PR8h: schema-level features previously slated for PR8g (task
  `reviewers` field, `STATE_UPDATED` event, `dependsOn` cycle
  detection, schema-version compatibility check). `--description`
  becoming hard-required on `rfc new` also lands here. Maybe a
  read-only `gojaja rfc audit <id>` to surface
  "who has acked / objected / not responded yet" without the agent
  having to read `rfc show`.
- PR8k: org-hierarchy ergonomics. `directReports` reverse field,
  multi-target `report --to`, role-level RFC `decisionScopes`. Goal:
  3+ layer organisations are pleasant rather than noisy. PR8n
  subsumed the original "idle-broadcast retargeting" sub-task.
- PR8m: gate `gojaja role create` behind ownership of
  `config.yaml`, so an HR/Admin role can be granted role-creation
  authority via the normal ownership model.

## [2.0.0-alpha.26] — 2026-05-28

### Reviewers + Done permission (PR8u)

Three related changes turn the previously-temporary Review handoff
protocol into a first-class part of the task model:

**1. `task.reviewers: RoleId[]` field.** Set at create time
(`task new --reviewer X --reviewer Y`). Each reviewer must be a
registered role; duplicates are deduped. Reviewers can mark the task
`Done` regardless of ownership AND become automatic stakeholders —
\`TASK_STATUS_CHANGED\` events on the task surface in their manifest
without the owner sending an explicit report. (The previous
"task-board-owner protocol" stays as a fallback for tasks with no
reviewers.)

**2. `task.assignedBy` renamed to `task.creator`.** Same semantics
(populated from \`actor\` at \`createTask\` time, NOT updated by
\`assignTask\`). The new name reflects the field's purpose better —
it's the original creator, not "the most recent assigner".
\`readTaskBoard\` auto-promotes the legacy \`assignedBy\` value on
read, so pre-PR8u boards round-trip cleanly.

**3. Stricter Done permission.** Previously the owner-exception let
any task's owner unilaterally mark their own task Done. Now Done is a
sign-off act and requires one of:

- SYSTEM (human user running the CLI without a session),
- actor is in \`task.reviewers\`,
- actor is owner AND actor is creator (self-managed task — you both
  created it and own it; you can ship it yourself),
- actor owns \`state/task_board.yaml\` (legacy / coordinator route),
- (back-compat: legacy tasks with \`creator === null\` on disk keep
  the pre-PR8u owner-Done behaviour so existing alpha boards work).

Other transitions (InProgress / Blocked / Review / Backlog / Ready)
keep the owner-exception. Reviewers also gain non-Done permission so
they can push back to InProgress when rejecting, without a
report-then-owner-reverts dance.

A non-permitted owner trying to Done gets a clear \`FORBIDDEN\` (exit
9) that names the configured reviewers (or recommends escalation if
none).

> **Behaviour change (alpha-only).** Owner can no longer Done their
> own task unconditionally. New flow: add reviewers at create time,
> or let an explicit reviewer / task-board owner do the final Done.

Manifest changes:

- \`TaskSummary\` gains optional \`reviewers\` so the agent sees who
  else can Done their task without opening the full record.
- PR8n visibility filter: reviewers are now stakeholders, so
  \`TASK_STATUS_CHANGED\` (and \`TASK_DELIVERABLE_BYPASSED\`,
  \`TASK_CREATED\`) on a task they review automatically land in their
  manifest.

CLI:

- \`task new --reviewer <role>\` (repeatable).
- \`task show\` renders \`creator\` and \`reviewers\` when present.

Suite 321 -> 331 (10 new PR8u tests in \`task-board.test.ts\`;
PR8j-era deliverable tests updated to use PM as the Done-er
since Frontend can no longer self-Done).

## [2.0.0-alpha.25] — 2026-05-28

### RFC creator is automatically a voter (PR8t)

`createRfc` now unconditionally adds the creator (`createdBy`) to the
`voters` set (deduped against `--voters` so explicitly listing the
creator does not double-list). Semantically: opening an RFC asserts
interest in its outcome — the creator both sees manifest events for
the RFC AND owes an ack/object on any pre-decision (the ACK gate is
computed over `voters ∪ deciders`).

> **Behaviour change (alpha-only).** Pre-PR8t RFCs where the creator
> was deliberately omitted from voters had a quirky property: PM
> could open an RFC with deciders=[TL] and voters=[Backend, DevOps],
> then TL could pre-decide + Backend/DevOps could ack and TL would
> decide — with PM completely outside the audit trail of the final
> consensus. PR8t closes this; PM is now a required participant.

Edge cases handled:

- Creator passing themselves in `--voters` explicitly: deduplicated,
  no double-listing.
- SYSTEM-created RFCs (no `GOJAJA_SESSION`, CLI run by the user
  directly): SYSTEM is NOT auto-added — it's not a role and cannot
  ack/object. The voters list is exactly what was passed in.
- Creator who is also the pre-decider: the ACK gate still excludes
  the pre-decider, so they don't owe themselves an ack.
- Creator who is also a decider: same as above, normal decider rules.

No opt-out. If a creator genuinely is a relay, run the command from
the role that should be on record, not as a side-channel.

5 new tests in `rfc-v2.test.ts` cover the auto-add, dedup, SYSTEM
exclusion, ACK gate inclusion, and pre-decider exclusion paths. 4
existing tests updated where they hard-asserted the old voter set.

Suite 316 -> 321.

## [2.0.0-alpha.24] — 2026-05-28

### Fix dead doc references in user-facing artifacts (PR8s)

Five places leaked relative paths like \`docs/HANDBOOK.md\` or
\`protocol/PROTOCOL.md\` into user-facing output. Those files live in
the gojaja **source** repo on GitHub, not in the user's project; an
agent following the reference would look at \`<project>/docs/...\`
and find nothing.

Fixed:

- \`src/cli/prompts/handbook.ts\` intro: dropped "Mechanism is in
  protocol/PROTOCOL.md ... Full long-form rationale: docs/HANDBOOK.md".
  The handbook block is self-contained; the new intro just says
  "Judgement layer ... rules below are self-contained; full long-form
  rationale lives in the gojaja source repo on GitHub (you do not
  need it to follow the rules)."
- \`src/cli/help.ts\` "See:" section: replaced bare relative paths
  with an explicit GitHub URL prefix
  (\`https://github.com/smilezheng/gojaja\`) and a clear "none of
  these files are shipped into your project" note.
- \`src/core/role-template.ts\`: removed
  \`[docs/PROTOCOL.md](../../docs/PROTOCOL.md)\` from the role
  markdown skeleton. The role file is the agent's self-introduction;
  the protocol contract is in the runtime body (Cursor rule /
  CLAUDE.md / Codex skill) which the new line points at instead.
- \`PROJECT_STATE_SKELETON\` (state/project_state.md template):
  dropped "see docs/HANDBOOK.md". The acceptance criteria in that
  file are authoritative; no external link needed.
- RFC pre-PR8g migration errors: replaced "See docs/RFC.md
  Migration section" with the full GitHub URL
  (\`https://github.com/smilezheng/gojaja/blob/main/docs/RFC.md\`).

Suite 316 -> 316.

## [2.0.0-alpha.23] — 2026-05-28

### Prompt artifact compression + path portability (PR8q + PR8r)

Two related fixes for the runtime body and handbook that `gojaja
prompt --write` lands at `.cursor/rules/gojaja-runtime.mdc` and inside
the `CLAUDE.md` marker block. Both files are committed to the repo,
so they have to (a) fit a reasonable budget for CLAUDE.md (~200-line
target per Anthropic guidance) and (b) be portable across machines.

#### PR8q — handbook & runtime body compression

The pre-PR8q runtime body had accumulated rationale paragraphs and
parallel "when to use X" sections across PR8b → PR8n. Net effect:

```
.cursor/rules/gojaja-runtime.mdc:   520 lines / 22.8 KB
CLAUDE.md marker block:             516 lines / 22.6 KB
```

PR8q compresses by ~44%:

```
.cursor/rules/gojaja-runtime.mdc:   295 lines / 13.0 KB
CLAUDE.md marker block:             291 lines / 12.8 KB
```

Changes:

- Three parallel "when to use X" sections (worklog / report / RFC) →
  one three-column table.
- Three escalation paths (push upstream / escalate up / bounce to
  user) → one two-column "escalation ladder" table.
- All \`(PR8x)\` version markers removed (internal scaffolding).
- Rationale paragraphs dropped from the prompt; the long-form policy
  rationale lives in \`docs/HANDBOOK.md\` in the source repo, linked
  from the prompt's intro.
- "Idle and lifecycle" + "Idle (no work)" merged.
- Runtime body's verbose wait verdict table → one line ("RESUME means
  re-run the printed wait command").
- Identity / When-this-section-applies sections collapsed to ~3 lines
  each from ~15 lines each.

Handbook size budget tightened from 20 KB to 12 KB. Trigger-phrase
tests loosened where the compressed phrasing wraps differently across
lines.

#### PR8r — no absolute paths in committed prompt artifacts

Previously the Cursor rule and CLAUDE.md block baked the project root
path into their text:

\`\`\`
You participate in a multi-agent coordination layer rooted at:

  /Users/alice/projects/foo
\`\`\`

Both files are committed to git, so this broke immediately when the
project was checked out on another machine, moved to a different
location, or synced via Dropbox / Syncthing.

Fix: \`runtimeLoopBody\` now always renders the cwd-discovery message
("for whichever project this window is currently working in (gojaja
discovers the project root from the shell's cwd)"). The Codex skill
already did this (intentionally — it's user-level shared); Cursor and
Claude now match.

The activation snippet (\`gojaja activate\`) still includes the path
— it's pasted per-window into chat by the user and is never committed,
so a machine-specific path is correct there.

Suite 316 -> 316.

## [2.0.0-alpha.22] — 2026-05-28

### Rename — `multi-agent-coordination` → `gojaja` (过家家)

Project, CLI, layer directory, env vars, and host artifacts all
rename in one sweep. The name 过家家 (gòu-jiā-jiā) is a Chinese
phrase for kids' role-play games where each kid pretends to be a
family member — exactly what this tool lets your LLM agents do on
a shared codebase.

> **Breaking — every existing project must re-init.** No on-disk
> schema migration is provided; the directory name, env var names,
> and host artifact names all change. Alpha stage, no users, hard
> cut.

What renamed:

| Before | After |
| --- | --- |
| npm package `multi-agent-coordination` | `gojaja` |
| CLI binary `agentctl` | `gojaja` |
| Layer directory `.multi-agent/` | `.gojaja/` |
| Env var `MA_SESSION` | `GOJAJA_SESSION` |
| Env var `MA_PROJECT_ROOT` | `GOJAJA_PROJECT_ROOT` |
| Cursor rule file `multi-agent-runtime.mdc` | `gojaja-runtime.mdc` |
| Codex skill `~/.codex/skills/multi-agent-runtime/` | `~/.codex/skills/gojaja-runtime/` |
| Claude marker `<!-- multi-agent-runtime:BEGIN/END -->` | `<!-- gojaja-runtime:BEGIN/END -->` |
| Error base class `AgentctlError` | `GojajaError` |
| Repo URL `smilezheng/multi-agent-coordination` | `smilezheng/gojaja` |

What stays:

- Concept terminology — phrases like "a multi-agent collaboration
  framework" or "multi-agent project" stay; the rename targets the
  tool's self-identity, not its category.
- Schema version string `2.0.0-manifest-filter` — on-disk protocol
  marker, unaffected by branding.
- Project root directory in this repo (`codex-agent/`) — purely a
  local working name; not visible to users of the package.

Migration for any project that hand-claimed an alpha:

```bash
# In an existing project that was on alpha.21 or earlier
unset MA_SESSION          # old env var no longer recognised
agentctl reset --confirm <basename>   # if you still have the old CLI
rm -rf .multi-agent       # if reset is no longer available
npm install -g gojaja
gojaja init
# re-create roles, re-write project_state.md, etc.
```

Suite 316 -> 316 (mass token rename; no semantic changes).

## [2.0.0-alpha.21] — 2026-05-28

### `gojaja reset` — project uninstall (PR8o)

New command. Removes everything this tool installed into a project so
you can tear down the coordination layer without hand-deleting files.

Surface:

```
gojaja reset                                           # preview, no delete
gojaja reset --dry-run [--confirm <basename>]          # preview, no delete
gojaja reset --confirm <project-basename>              # delete
gojaja reset --confirm <project-basename> --purge-codex-skill
```

What it removes (when present):

- `<project>/.gojaja/` recursively — events, state, RFCs,
  worklogs, sessions, locks. Everything this tool wrote.
- `<project>/.cursor/rules/gojaja-runtime.mdc`, plus the empty
  `.cursor/rules/` and `.cursor/` directories after, so the project
  tree is not left with empty parents that belong to us.
- The `<!-- gojaja-runtime:BEGIN ... :END -->` block inside
  `<project>/CLAUDE.md`. Content outside the block is preserved.
  `CLAUDE.md` is deleted only if the marker block was its only content.
- `${CODEX_HOME:-~/.codex}/skills/gojaja-runtime/` only when
  `--purge-codex-skill` is passed. Off by default because the Codex
  skill is user-level and shared across every project the user works on.

Safety:

- `--confirm <token>` is required to actually delete. The token must
  equal `path.basename(projectRoot)`; mismatches raise `UsageError`
  (exit 2).
- `GOJAJA_SESSION` must be unset — destructive ops belong to the user, not
  to an agent (same posture as `role delete`).
- Default invocation prints a preview listing every path that would be
  touched and the exact `--confirm` token to use.

Suite 302 -> 316 (14 new reset tests + 2 helper tests).

## [2.0.0-alpha.20] — 2026-05-28

### Manifest event filter — token / attention budget (PR8n)

The events directory (`comms/events/`) stays the durable broadcast
log: every event ever produced lives there for audit and future
`gojaja doctor`. The per-role manifest is now a **projection** of
that stream onto the slice the role should attend to. Two layers,
one source of truth.

Why: pre-PR8n a busy 6-role project produced ~70 broadcast events /
role / day; each one was an LLM "should I react?" turn. WORKLOG and
RFC_DECIDED really are team-wide; everything else was over-delivered.
Net effect was bloated turns and noticeable behaviour contamination
(agents reacting to RFC threads they were not invited to, status
updates on tasks they had no stake in, session-claim noise, etc.).

Filter rules (broadcast events `to: "*"`):

- `WORKLOG`, `RFC_DECIDED` — every role (intentional team-wide
  channels).
- `RFC_CREATED`, `RFC_COMMENT`, `RFC_OPTION_ADDED`,
  `RFC_REVISION_REQUESTED`, `RFC_REVISED` — the RFC's
  `voters ∪ deciders ∪ {createdBy}`.
- `RFC_TASK_LINKED`, `RFC_TASK_UNLINKED` — RFC participants OR the
  linked task's stakeholders.
- `TASK_CREATED` — roles owning `state/task_board.yaml` (triage set).
  The new owner already gets a directed `TASK_ASSIGNED`.
- `TASK_STATUS_CHANGED`, `TASK_DELIVERABLE_BYPASSED` — task
  stakeholders (owner, parent owner, dependants).
- `SESSION_CLAIMED`, `SESSION_RELEASED`, `SESSION_TAKEOVER`,
  `LOCK_BROKEN`, `ROLE_DELETED`, `RFC_REPAIRED` — nobody. Operational
  events; surfaced only via the event stream and (planned) doctor.
- Unknown / future event types — surfaced (forward-compatibility).

Guarantees:

- The cursor advance is computed against the pre-filter list, so
  events excluded by the per-type rule do NOT re-surface on the next
  `plan`. The event remains in `comms/events/` forever.
- `gojaja wait --for attention` uses the same projection, so wait
  fires only on events that would actually appear in the manifest.
  No more "wake the agent to look at a manifest that hides everything"
  loops.

Added:

- `Store.filterVisibleEventsForRole(events, role): Promise<Event[]>`
  exposed for `wait` to reuse the same projection.

Schema version bumped to `2.0.0-manifest-filter`. Non-breaking on
disk; manifest visibility narrows. Suite 294 -> 302.

## [2.0.0-alpha.19] — 2026-05-28

### Brainstorm-mode RFC (empty options) (PR8l)

`createRfc` no longer requires `--options`. An RFC opened without
options enters **brainstorm mode** — voters comment / reply freely
with no concrete choices on the table. The same primitive now covers
both "wide-open discussion" and the existing decision flow; no new
mechanism, no new on-disk shape, no schema break.

The two modes are mutually exclusive at decide time:

- Brainstorm-mode RFC (`options: []`): `rfc decide` accepts
  **without** `--option`. The decision is recorded as `accepted`
  with `chosenOption: null` and the rationale carries the takeaway.
- Options-bearing RFC (`options.length >= 1`): `rfc decide` requires
  `--option <id>`, same as before. Both paths are enforced
  symmetrically — passing `--option` to a brainstorm RFC, or omitting
  it on an options-bearing RFC, raises USAGE with the recovery hint.

A brainstorm RFC upgrades into a decision flow the moment anyone
runs `rfc add-option`. From that point on it behaves exactly like a
PR8g-style RFC: pre-decide works, the ACK gate arms, decide requires
`--option`.

`pre-decide` refuses on a brainstorm RFC and points at `add-option`:
nothing concrete to lock in until at least one option exists.

Schema version unchanged; this is a pure constraint relaxation. CLI
signature change is purely additive:

- `gojaja rfc new <slug> ...` — `--options` is now OPTIONAL.
- `gojaja rfc decide <id> --rationale ...` — `--option` is now
  CONDITIONAL (required iff the RFC has options).

`Store.decideRfc.chosenOption` widened to `string | null`.

Suite 284 -> 294.

## [2.0.0-alpha.18] — 2026-05-28

### Task model expansion: parent / assets / deliverables / assignedBy / tags (PR8j)

Adds the task fields a multi-layer organisation needs to decompose
work, point at reference materials, and gate hard outputs.
`setTaskStatus(... Done)` now enforces a `kind: "file"` deliverable
existence check; missing files refuse the transition with USAGE
listing every absent ref. `--force-incomplete` bypasses with a
`TASK_DELIVERABLE_BYPASSED` event emitted BEFORE the corresponding
`TASK_STATUS_CHANGED`, so "approval given, then status moved" is the
permanent audit ordering.

> **Schema break (alpha-only, no users).** `Task` records gain
> `parent`, `assignedBy`, `assets`, `deliverables`, `tags`.
> `readTaskBoard` backfills missing fields with safe defaults so
> legacy `state/task_board.yaml` files round-trip cleanly. Schema
> version bumped to `2.0.0-task-v2`.

Added:

- Task fields: `parent` (string | null), `assignedBy` (RoleId |
  "SYSTEM" | null), `assets` (TaskAsset[]), `deliverables`
  (Deliverable[]), `tags` (string[]).
- New types: `TaskAsset { kind: "file" | "url", ref, description }`,
  `Deliverable { kind: "file" | "url" | "manual", ref, description }`.
- `MAX_TASK_DEPTH = 5`. Parent chains deeper than this are refused at
  creation; `readTaskBoard` runs a cycle detector and refuses
  hand-edited yaml that contains a parent cycle.
- New event `TASK_DELIVERABLE_BYPASSED { taskId, missing: string[],
  by: RoleId | "SYSTEM" }`. Emitted ONLY when `--force-incomplete`
  was needed to mark Done.
- `TaskSummary` (manifest) gains optional `parent`, `childCounts:
  { ready, inProgress, blocked, review, done }`, `unmetDeliverables:
  number`, `tags: string[]`.
- CLI:
  - `task new ... [--parent T-NNNN] [--tag <label> ...]
    [--asset 'kind:ref::desc' ...] [--deliverable 'kind:ref::desc' ...]`
  - `task status <id> Done [--force-incomplete]`
  - `task list [--tag <label> ...]` (OR-match)
  - `task show <id>` renders parent / children / assets / deliverables
    with on-disk `[x] / [ ] / [?]` markers.
- `argv.ts` gains `multiFlag(rawArgs, name)` helper and `rawArgs?` on
  `ParsedArgs` so accumulating flags can be parsed cleanly.

Constraints / refusals:

- Asset / deliverable file refs that escape the project tree (`..`)
  are refused at create time. Refs pointing inside `.gojaja/`
  are refused too — those are framework state, not project artifacts.
- `--force-incomplete` does not run the bypass event when all
  file deliverables are present (no bookkeeping noise for the clean
  path).
- `assignTask` does NOT change `task.assignedBy`. The field is the
  original-creator audit record; reassignment history lives in the
  event stream.

Suite 270 -> 284.

## [2.0.0-alpha.17] — 2026-05-28

### Wait redesigned around deadlines + RESUME + idle broadcast (PR8i)

Collapses the `--mode block | exit` dichotomy into a single
deadline-driven, chunked, resumable primitive. A long wait now
survives any host shell timeout: each chunk is one shell call, the
next chunk reads the same `--until` deadline off the command line
and continues. The PR8a `.wait` sentinel and its accompanying
`writeWaitSentinel` are gone, replaced by a session record at
`comms/pending/<role>/wait.json` that lets `--for task-assigned`
emit its idle WORKLOG exactly once per session even across resumes.

> **Breaking CLI / on-disk shape change (alpha-only, no users).**
> `--mode block`, `--mode exit`, `--idle <minutes>`, `--idle-seconds`,
> and the `.wait` sentinel are removed. Passing any removed flag
> raises USAGE pointing at the new shape. Schema version bumped to
> `2.0.0-wait-v2`.

Added:

- `gojaja wait [--until <ISO> | --in <duration>] [--for <condition>] [--poll-interval <duration>]`
- Conditions: `attention` (default), `rfc-decided:<id>`,
  `rfc-acked:<id>`, `task-assigned`, `report-from:<role>`,
  `event-ref:<id>`.
- Verdicts (all exit 0): `ATTENTION`, `CONDITION_MET`, `RESUME`,
  `TIMEOUT`. Each prints the exact next command to run.
- `--for task-assigned` auto-broadcasts a one-shot idle WORKLOG so
  any role with task-board ownership can re-assign the role.
- `Store.readWaitState` / `writeWaitState` / `clearWaitState`
  replace `writeWaitSentinel`.
- `argv.parseDuration` helper accepts `<n>{ms|s|m|h|d}`.

Runtime artifacts:

- Cursor runtime body pins `gojaja wait --in 10m --poll-interval 30s`
  so each chunk fits inside Cursor's shell timeout.
- Codex / Claude / generic bodies use `gojaja wait --in 10m`; a
  10-minute wait collapses to a single sleep on those hosts.
- Handbook gains a verdict table and a `wait --for task-assigned`
  guidance block; budget bumped 14 KB → 16 KB.

User-cancel of a chunked wait is intentionally not framework-handled:
the host's SIGTERM / SIGINT looks identical to a host-timeout from
inside the shell, so cancel is delegated to the host (kill the chat
or shell to stop; the next message redirects the loop).

Suite 260 -> 270.

## [2.0.0-alpha.16] — 2026-05-28

### RFC v2.1: pre-decide as structured comment + mandatory ACK gate (PR8g.1)

Walks back the PR8g `pre-decide` state-machine into a comment kind
with a hard ACK gate. PR8g modelled silence-as-consent; that turned
out to be unreliable in an async LLM-agent fleet (silence ≠ "saw it
and agreed"; could be "agent offline"). PR8g.1 requires every
required role to explicitly `rfc ack` or `rfc object` before
`rfc decide` succeeds. There is no silence-is-consent.

> **Breaking on-disk shape change (alpha-only, no users).** `readRfc`
> refuses any `proposal.yaml` with `status: pre-decide` or a
> `preDecision: {...}` field (both are PR8g shapes). Manual migration:
> edit `status: open`, drop `preDecision`; the pre-decision data is
> lost and agents should re-issue `rfc pre-decide`. Or `gojaja init`
> a fresh project.

Suite 247 -> 260.

#### State machine collapses pre-decide back to open

`RfcStatus` shrinks to 5 values: `{open, revising, accepted, rejected,
superseded}`. The status `pre-decide` is removed; pre-decisions are
now structured comments (`kind: "pre-decision"`) that live in the
ledger and are surfaced via a read-time computation.

#### Two new CLI verbs + reshape of one

- `gojaja rfc ack <rfc-id> [--rationale ...]` (new): structured
  agreement with the active pre-decision. Required-ACK roles only;
  pre-decider cannot ack their own.
- `gojaja rfc object <rfc-id> --rationale ... [--option Y]` (new):
  structured disagreement. Rationale required; optional preferred
  alternative.
- `gojaja rfc pre-decide ...` (reshaped): now posts a `kind:
  "pre-decision"` comment. RFC status stays `open`. The hard work
  happens in `decideRfc`'s ACK gate.

#### ACK gate inside `decideRfc`

When an active pre-decision exists (latest `kind: pre-decision`
comment, not invalidated by a later `RFC_OPTION_ADDED`), every role
in `(voters ∪ deciders) − {pre-decider}` must have posted a
`kind: ack` or `kind: object` comment with `ts > pre-decision.ts`.
Outstanding roles → USAGE with the full list and the recovery path.
**There is no override.** The only escape from a stalled ACK round
is `rfc reject` followed by a new RFC without the unreachable role.

#### Re-posting pre-decide invalidates all prior ACKs

Whether the decider keeps `chosenOption` or changes it, re-issuing
`rfc pre-decide` invalidates every prior `ack`/`object` because they
were responding to a now-superseded pre-decision. Every required
role must respond again. Same rule keeps things simple.

#### `add-option` while pending invalidates the pre-decision

Adding an option silently invalidates any active pre-decision because
voters were ACKing an outdated option set. The decider can re-issue
`rfc pre-decide` on the new option set. The existing
`RFC_OPTION_ADDED` event is the audit signal.

#### Regular `rfc comment` does NOT advance the ACK gate

A required-ACK role posting a regular `rfc comment` (no kind) does
not count toward the gate. Discussion is welcome; you still owe a
structured `ack` or `object`. Handbook teaches this.

#### Two PR8g event types collapsed

`RFC_PRE_DECISION` and `RFC_PRE_DECISION_OBJECTED` are removed. All
pre-decision / ack / object posts ride on `RFC_COMMENT` with
`payload.kind`. grep-friendly: `payload.kind === "pre-decision" |
"ack" | "object"`.

#### Manifest changes

`RfcSummary.pendingPreDecision` (PR8g field) now also carries
`awaitingAckFrom: RoleId[]` (outstanding required roles) and
`myAckOwed: boolean` (true iff this role still owes a structured
response). Visibility rules:

- Required-ACK role with `myAckOwed: true` → kept in manifest (they
  have structured work to do).
- Required-ACK voter who has already responded → dropped from their
  own manifest until decide / new pre-decide.
- Deciders → kept while RFC is open.

#### Schema additions

`RfcComment.kind?: "pre-decision" | "ack" | "object"`. Undefined =
regular discussion. PR8g `RfcProposal.preDecision` is removed.
`SCHEMA_VERSION` bumped to `"2.0.0-rfc-v2.1"`.

#### Tests

`tests/rfc-v2.test.ts`: rewrote 11 PR8g pre-decide-status tests as
PR8g.1 ACK-gate tests (+18 new). `tests/handbook.test.ts`: updated
trigger phrases for the new "silence does NOT count as consent" rules.
Suite 247 -> 260.

#### Docs

- `docs/RFC.md`: rewritten end-to-end (state machine, ACK gate
  semantics, 4-design-decision recap, walkthrough that exercises
  pre-decide → object → re-pre-decide → unanimous ack → decide).
- `docs/PROTOCOL.md`: RFC section adds `rfc ack` / `rfc object`
  command specs; `rfc decide` documents the ACK gate; `rfc reject`
  documents its "bypasses gate by design" role.
- `docs/SCHEMA.md`: removed `pre-decide` status enum entry + the
  PR8g `preDecision` field; added `kind` field on RfcComment with
  worked example; updated event table.
- `docs/HANDBOOK.md` and `src/cli/prompts/handbook.ts`: rewrite
  "RFC multi-round discussion" section to teach the mandatory-ACK
  semantics (no silence-as-consent; required roles must use
  `rfc ack` or `rfc object`; regular comments do not advance the
  gate; reject is the only escape).
- `gojaja -h`: RFC section updated similarly.

## [2.0.0-alpha.15] — 2026-05-28

### RFC v2: multi-round, threaded comments, mutable options, related tasks, revise (PR8g)

Substantial rework of the RFC mechanism. Suite 216 -> 247.

> **Breaking on-disk shape change (alpha-only, no users).** Comments
> moved from per-role JSON files (`rfcs/<dir>/comments/<role>.json`)
> to a single threaded ledger (`rfcs/<dir>/comments.yaml`). The CLI
> detects the legacy layout on first read and refuses with a clear
> `code: USAGE` message pointing at this entry. No auto-migrator —
> projects on alpha.14 or earlier should `gojaja init` fresh or
> hand-migrate.

#### State machine grew

`RfcStatus` expands from `{open, accepted, rejected, superseded}` to
`{open, pre-decide, revising, accepted, rejected, superseded}`. New
transitions:

- `open --rfc pre-decide--> pre-decide`
- `pre-decide --rfc comment (non-pre-decider)--> open` (auto-reopen)
- `open / pre-decide --rfc revise--> revising`
- `revising --rfc edit--> open`
- `decide` / `reject` accept additional starting states (see
  docs/RFC.md and docs/PROTOCOL.md).

#### New CLI verbs

- `gojaja rfc add-option <id>:<summary> --rationale ...` — surface
  a new option mid-discussion. Allowed in `open` or `revising`.
- `gojaja rfc pre-decide --option X --rationale ...` — decider
  posts "I lean X; any objections?". Voters either stay silent
  (consent) or comment (auto-reopens).
- `gojaja rfc revise --rationale "rewrite section X"` — decider
  kicks the proposal back without rejecting the topic.
- `gojaja rfc edit --rationale ... [--title T --description D
  --options A:s,B:s --deadline ISO]` — creator or decider applies
  the rewrite; status returns to `open`. Comments preserved.
- `gojaja rfc link-task --task T-NNNN` /
  `gojaja rfc unlink-task --task T-NNNN` — idempotent task pointers
  on the proposal; task ids validated against `state/task_board.yaml`.

#### New flags on existing verbs

- `rfc new --description <text>` — soft-required in PR8g (warn-on-
  empty); PR8h will harden to required. This is the channel for
  giving non-participants enough context to weigh in.
- `rfc new --task T-NNNN[,T-NNNN]` — link tasks at creation time.
- `rfc comment --reply-to <comment-id>` — thread under another
  comment by id (ULIDs printed by `rfc show` / `rfc comment`).
- `rfc show --no-mark-seen` — script-friendly read that does not
  advance the role's per-RFC read cursor.

#### New events

`RFC_OPTION_ADDED`, `RFC_PRE_DECISION`, `RFC_PRE_DECISION_OBJECTED`,
`RFC_REVISION_REQUESTED`, `RFC_REVISED`, `RFC_TASK_LINKED`,
`RFC_TASK_UNLINKED`. All broadcast (`to: "*"`).

#### Manifest additions

`manifest.rfcs[*]` now carries `unreadComments`, `relatedTasks`, and
(while in pre-decide) `pendingPreDecision`. Visibility rules for the
new states: voter hidden during `revising` unless they are the
creator; voter in `pre-decide` who commented after the pre-decision
ts drops from the manifest (both objection and silent-consent paths
end up clean). `gojaja rfc show <id>` advances the caller's per-RFC
read marker so `unreadComments` reflects "I am caught up".

#### Auto behaviours worth knowing

- `commentRfc` advances the commenter's read cursor automatically
  (no need to call `markRfcSeen` after commenting).
- Comments on `pre-decide` from a role other than the pre-decider
  auto-reopen the RFC and emit `RFC_PRE_DECISION_OBJECTED`. Comments
  from the pre-decider themselves do not (lets them add reasoning
  without aborting their own round).

#### Schema additions

`RfcProposal` gains `description: string`, `relatedTasks: string[]`,
optional `preDecision: { decidedBy, chosenOption, ts, rationale }`.
`RfcComment` gains `id: string` (ULID) and `replyTo: string | null`.
`RfcSummary` gains `unreadComments`, `relatedTasks`, optional
`pendingPreDecision`.

#### Handbook + docs

- `docs/RFC.md` rewritten end-to-end with the new state machine, the
  10-command surface, and a worked four-role simulation that exercises
  multi-round comments, `add-option`, `pre-decide` + objection, and a
  `revise` + `edit` cycle before a clean `decide`.
- `docs/PROTOCOL.md` RFC section: 6 new commands + flag additions on
  existing commands.
- `docs/SCHEMA.md`: new `comments.yaml` shape, new `proposal.yaml`
  fields, new per-role-per-RFC cursor file, 7 new events in the
  event table. Pre-PR8g `comments/<role>.json` layout flagged with
  migration note.
- `docs/HANDBOOK.md` and the in-prompt handbook gain "RFC multi-round
  discussion" guidance: when to pre-decide vs decide, when to revise
  vs reject, when to add an option, how to thread.

#### Other

- `SCHEMA_VERSION` bumped (RFC schema changed).
- Soft warning if `rfc new --description` is empty.

## [2.0.0-alpha.14] — 2026-05-27

### Rename write-state, surface mode flags in -h, roleReminder hint (PR8f-C)

Three small follow-ups to PR8f-B. No new behaviour beyond the rename.

- **`gojaja write-state` is renamed to `gojaja state edit`.** The
  old name was misleading once append/replace modes landed in PR8f-B
  — "write" reads as overwrite-only. The new name uses the
  subcommand-group style consistent with `task <new|assign|...>`,
  `role <create|list|...>`, `rfc <new|comment|...>`. Hard rename
  (alpha-stage; no backward-compatible alias): the old command name
  is gone and existing scripts must update. The Store-level interface
  `writeStateFile` is untouched (still the implementation hook).
- **`gojaja -h` now lists all three modes** for `state edit` with
  copy-pasteable invocations and the `--batch` semantics. The
  previous help text only showed `--content`, which was correct
  before PR8f-B but stale after it.
- **`manifest.roleReminder.protocol` carries a `role show` hint.**
  Compressed wording so the JSON-serialised reminder stays under the
  300-byte budget: now reads
  ``Loop: plan -> ack <t> -> wait. Lost your role? Run `gojaja
  role show <you>`. Writes via gojaja only; never hand-edit
  .gojaja/.`` — the new sentence routes any agent that has lost
  its self-understanding to the right CLI command, every turn.

Tests:
- `tests/state-edit.test.ts` replaces `tests/write-state.test.ts`
  (same coverage; updated imports + positional args + 2 new
  dispatcher tests for unknown / missing subcommand).
- `tests/plan-ack.test.ts` adds an assertion that
  `roleReminder.protocol` contains `gojaja role show`.

Docs:
- README.md / README.zh-CN.md cheatsheet rows.
- docs/PROTOCOL.md `state edit` section (renamed in place).
- docs/ROADMAP.md PR7 entry notes the rename.

## [2.0.0-alpha.13] — 2026-05-27

### init seeds project_state.md; write-state gains replace/append (PR8f-B)

Two related behaviour additions. Suite 198 -> 214.

- **`gojaja init` now seeds `state/project_state.md` with a TBD
  skeleton.** Previously the file was not auto-created and the
  handbook told agents to keep asking the user to make one — a slow
  failure mode. The new skeleton ships with three sections (Vision,
  Milestones, Acceptance criteria), each containing a `TBD` marker so
  it is obvious what to fill. Re-running `initialise` is still
  refused (existing AlreadyInitializedError), so the user's
  in-progress edits to the skeleton are never clobbered.
- **`gojaja write-state` gains `--append` and `--replace`/`--with`
  modes** alongside the existing `--content` (overwrite). Goal:
  agents that need to change a small fragment of a long file no
  longer have to re-emit the whole file (token cost), and accidental
  ambiguous replacements no longer go through silently.
  - `--append <text>`: appends to the existing file; absent file is
    treated as empty. No automatic newline prefix.
  - `--replace <oldText> --with <newText>`: literal-string find and
    replace. The default refuses if `oldText` appears 0 or N>1 times,
    with a clear hint to either expand the snippet or pass
    `--batch`. `--batch` allows N>1 (replaces all). `--with ""` is a
    valid deletion. No regex anywhere — purely literal strings, to
    eliminate the most common misuse class.
  - Strict mutual exclusion: at most one of `--content`/`--append`/
    `--replace` per invocation; `--with` requires `--replace`;
    `--batch` requires `--replace`. Each violation is its own USAGE
    error with the relevant hint.
  - Human output names the mode (`Wrote`/`Appended`/`Replaced N
    occurrences`); JSON output carries `mode` and (for replace)
    `replacedOccurrences`.
  - Ownership/`mustNotEdit`/path canonical-form gates all still
    apply to every mode.

### Cross-cutting

- `Store.writeStateFile` interface widened to a discriminated union.
- `Paths.projectStateFile` added (`state/project_state.md`).
- `BOOLEAN_FLAGS` whitelists `batch`.
- 16 new tests across `tests/init.test.ts` (new) and
  `tests/write-state.test.ts` (new).

## [2.0.0-alpha.12] — 2026-05-27

### First-run UX (PR8e)

Surfaces a number of silent-failure modes first-time users hit, plus a
README rewrite around the user-vs-agent boundary. Suite 185 -> 198.

- **`role create` nags about TBD sections.** Freshly rendered
  `roles/<id>.md` carries TBD in the Role description and
  Responsibilities sections — the agent's main self-introduction.
  Without filling them, the agent runs with only its id and title,
  and asks the user trivial role-clarifying questions every turn.
  Create output now prints a TODO block pointing at the file; JSON
  output carries `needsFill: true` and `rolePath`.
- **`role list` annotates TBD rows.** Rows for roles whose markdown
  still has TBD show `(TBD: fill role markdown)`. JSON output carries
  `needsFill` per row.
- **`gojaja activate <role>` refuses while the role contract has TBD.**
  Hard refusal at the most actionable moment — the user is about to
  bind the role to a window and would otherwise discover the missing
  self-introduction much later via every-turn agent confusion.
- **`activate` output gets explicit dividers + clipboard copy.**
  Snippet now appears between `═══ BEGIN PASTE TO AGENT ═══` and
  `═══ END PASTE TO AGENT ═══` so it is obvious where the paste
  payload begins and ends. Auto-copied to the system clipboard via
  `pbcopy` / `wl-copy` / `xclip` / `xsel` / `clip.exe` when
  available; `--no-copy` flag to skip. JSON output carries
  `copiedToClipboard` and `clipboardTool` fields.
- **Activation snippet rewritten for the agent's perspective.** Now
  reads `You are the <role> agent for ...` (second person, addresses
  the agent directly). Three numbered steps: claim via `--eval`, run
  `gojaja role show <role>` to learn its own contract, run
  `gojaja -h` to learn the CLI surface. Closes the gap where weak
  models skipped the export step or never read their own contract.
- **`gojaja -h` rewritten.** Opens with a one-paragraph description
  of what the tool is, then a runnable Quickstart, then per-section
  command listings with inline tips (`eval "$(... --eval)"`,
  `unset GOJAJA_SESSION` after release, Cursor `wait --mode exit`). Adds
  an exit-codes table with agent-actionable hints (USAGE / FORBIDDEN
  / STATE_CORRUPTION) and a See-also block to the doc set.
- **Handbook adds task-assignment rules.** New section "Task
  assignment is push, not pull" telling agents that tasks are
  assigned by the task-board owner (or a human), not self-claimed.
  New section "Multi-role task pattern" documenting the lead +
  sub-tasks + parent Blocked + report-to-assigner workflow for work
  that spans multiple roles, built on the existing single-owner
  schema. New hard don't: do not self-assign via
  `task assign --to <yourself>`.
- **README.md and README.zh-CN.md rewritten** around the user-vs-agent
  boundary (7 sections). Adds an explicit "Your job vs the agent's
  job" table, a "What you still need to write by hand" section
  highlighting that `state/project_state.md` is not auto-created, a
  "Common situations" troubleshooting block, and `npm link` /
  `npm run watch` guidance under Develop locally.
- **SCHEMA.md** flags `state/project_state.md` as not auto-created
  with an explanation of the downstream effect (agents bounce
  acceptance questions back to the user every turn).

### Cross-cutting

- New CLI flag `--no-copy` (booleans whitelisted in argv).
- New util `src/cli/util/clipboard.ts` (no new dependencies).
- 13 new tests across `tests/role-cli.test.ts`, `tests/activate.test.ts`,
  `tests/help.test.ts`, `tests/handbook.test.ts`,
  `tests/prompt.test.ts`.

## [2.0.0-alpha.11] — 2026-05-27

### Prompt UX hardening + role delete (PR8d)

- **Runtime body adds an "only-if-activated" gate.** Previous wording
  ("You play one role per window. Your role is bound by ...") assumed
  every agent window that loaded the rule had been claimed for a role.
  In practice users open agent windows for unrelated work too; without
  a gate, those windows would reflexively run `gojaja plan` /
  `claim` against random roles. New leading section limits the
  protocol to windows where either `GOJAJA_SESSION` is exported or the
  user has explicitly told the agent its role. Test in
  [tests/handbook.test.ts](./tests/handbook.test.ts) asserts every
  target body carries the gate.
- **`prompt --write` now prints a window-restart caveat.** Cursor,
  Claude Code, and Codex inject rule files into the agent's system
  prompt only when the agent window opens. Running `prompt --write`
  AFTER opening the window leaves the new rule with no effect there.
  Successful writes now print a clearly-marked IMPORTANT block telling
  the user to restart any open agent windows. JSON output carries the
  same signal as `requiresWindowRestart: true`.
- **"SKIPPED" renamed to "UNCHANGED (already up to date)".** The
  byte-equal short-circuit fired with the message "SKIPPED", which
  reads as "tool refused to do anything" when it actually means "tool
  decided nothing needed to change". Wording is now explicit.
  `writeArtifactFile` returns `"unchanged"` instead of `"skipped"`;
  CLI surface follows.
- **New `--force-rewrite` flag for `prompt --write`.** Bypasses the
  byte-equal short-circuit so the operator can confirm the on-disk
  file came from the current template (useful while debugging install
  drift). Refuses without `--write` to keep semantics narrow.
- **New `gojaja role delete <id>` command.** Removes the role from
  `config.yaml`, deletes `roles/<id>.md`, deletes the live session
  file (so any lingering `GOJAJA_SESSION` fails fast on the next command),
  and emits a `ROLE_DELETED` system event. Open task assignments are
  left in place — recreating the same role id reinherits them.
  Restricted to `SYSTEM` (no `GOJAJA_SESSION` exported); CLI refuses if
  the calling shell has a session exported, with a clear hint to
  `unset GOJAJA_SESSION`. Nine tests in
  [tests/role-delete.test.ts](./tests/role-delete.test.ts) cover
  config / md / session cleanup, ROLE_DELETED audit, orphan-task
  survival, non-SYSTEM rejection, GOJAJA_SESSION fail-fast after delete,
  and concurrent `deleteRole` + `createRfc` under `config-yaml` lock.

### Cross-cutting

- New event type `ROLE_DELETED` (in `EventType` union).
- `Store` interface gains `deleteRole(input)`.
- `writeArtifactFile` accepts `{ force?: boolean }` for the
  force-rewrite path.
- Suite size 169 → 185.

## [2.0.0-alpha.10] — 2026-05-27

### Third correctness + UX pass (PR8c)

Fourteen independent fixes from a third reviewer pass plus a
business-process simulation. Every fix is covered by a regression test
(suite grew from 150 to 169).

#### A. Safety / consistency

- **H1 — mustNotEdit path-normalisation bypass.** `state//architecture.md`
  used to slip past `pathMatches` (string compare against
  `state/architecture.md` failed) yet resolved to the protected path on
  disk via `path.resolve`. `requireOwnership` now refuses any input
  that is not its own POSIX-normalised form, and explicitly refuses
  trailing-slash file targets. Three tests in `tests/ownership.test.ts`.
- **H2 — stale-lock restore could clobber a fresh owner.** `tryBreakStale`
  previously used `rename(2)` to restore the aside record, which
  silently overwrites a destination installed by a racing process.
  Now uses `link(2)` + `unlink`: `link(2)` fails with `EEXIST` on a
  populated target, leaving the new owner intact and the aside file as
  forensic evidence. New regression test in `tests/local-fs-store.test.ts`.
- **H3 — RFC self-heal raced under concurrent readers.** N concurrent
  `readRfc` calls observing the same inconsistent shape used to each
  emit `RFC_REPAIRED` and each rewrite `proposal.yaml`. Self-heal now
  enters the `rfc-${id}` lock and re-verifies inside the lock; only
  one writer commits the repair. New 10-concurrent-reader test in
  `tests/rfc.test.ts`.
- **Step 11 — concurrent `config.yaml` RMW lost writes.** `createRole`
  and `createRfc` both did read-modify-write on the same file under
  *different* resource locks (`roles-create`, `rfcs`); concurrent
  execution dropped writes. New `Store.updateConfig(mutator)` API
  serialises ALL config-yaml mutations under a dedicated
  `config-yaml` lock. Both 50× concurrent `createRfc` and mixed
  role/RFC concurrency tests pass.

#### B. Behaviour changes that fix first-run demo

- **Step 5b — `task new --owner X` defaults to `Ready`, not `Backlog`.**
  Manifest filters `Backlog` out by design, so the README's PM example
  (`task new --owner Backend`) would leave the assignee unable to see
  the task. Tasks created without an owner still default to `Backlog`
  (unassigned product idea pending triage). Two new tests; one
  existing test's `previousStatus` assertion adjusted.
- **Step 6 — Cursor runtime body now recommends `wait --mode exit`.**
  Cursor's chat shell kills long-running tool calls within seconds, so
  the default block-mode `gojaja wait` (10-minute idle) was always
  killed. `runtimeLoopBody` takes a `target` argument; only the Cursor
  artifact swaps to exit mode. Codex / Claude / Generic keep cheaper
  block mode. Two new tests in `tests/prompt.test.ts`.
- **Step 4b — `claim` against a live peer no longer advertises `--force`.**
  Error message used to say "Pass --force to take over", which LLM
  agents immediately did, silently killing peer windows. New message:
  "ask the user — do NOT silently take over a peer." `--force` still
  works for humans who pass it explicitly. New test in
  `tests/claim.test.ts`.

#### C. Safety / consistency P1

- **M1 — Codex `SKILL.md` is now project-agnostic.** The skill installs
  to `~/.codex/skills/gojaja-runtime/`, a user-level singleton,
  so the previous baking of `projectRoot` meant `prompt --write` from
  project B overwrote project A's install. Skill body now says "the
  project where this skill is activated (discovered from cwd at
  runtime)"; one install services every project. Per-project context
  travels via the per-window `activate` snippet. Cross-project
  byte-equality test in `tests/prompt.test.ts`.
- **M2 — RFC deciders gate now raises `ForbiddenError`.** Previously
  raised `UsageError` (exit 2) for permission denial; should always
  have been `FORBIDDEN` (exit 9) so the handbook's escalation rule
  applies. Test assertion updated.
- **M3 — corrupt `heartbeatAt` no longer fails open.** `findSessionById`
  guarded the lease check with `if (Number.isFinite(heartbeatMs) &&
  expired)`, which silently skipped the entire check on a NaN
  heartbeat — sessions with malformed timestamps were perpetually
  valid. Now fails closed: any non-finite heartbeat → `null`. New
  test in `tests/identity.test.ts`.
- **Step 12 — `task new` / `task assign` reject unregistered owners.**
  `--owner Forntend` (typo) used to be accepted; the resulting
  `TASK_ASSIGNED` event went to a role no manifest could route. Now
  `createTask` and `assignTask` check `config.roles[owner]` after
  syntactic validation and throw `UsageError` with a hint. Two new
  tests in `tests/task-board.test.ts`.

#### D. UX

- **Step 10 — `release` reminds you to `unset GOJAJA_SESSION`.** Without
  the hint, the shell still has the stale session id exported and
  every subsequent command fails with "session not found." Output
  now includes the exact shell-runnable line.
- **Step 4a — new `gojaja claim --eval` mode.** Outputs exactly
  `export GOJAJA_SESSION=<ulid>\n` for shell `eval`:
  ```
  eval "$(gojaja claim PM --eval)"
  ```
  Single-step claim+export so weaker LLM agents cannot forget to
  copy the export line manually. Regular text output now also shows
  the `--eval` tip. Strict format test in `tests/claim.test.ts`.
- **Step 7 — handbook gets a `Review handoff` temporary protocol.**
  Role-neutral text that tells agents how to hand a Review task off
  to a task-board-owning role, then wait for that role to mark Done.
  Also adds a hard don't to `Hard "don't"s`: seeing "already claimed
  by a live session ..." means STOP and ask the user, not retry
  with `--force`.
- **Handbook role-neutrality regex.** Existing test only checked five
  hardcoded role ids (`PM`, `TL`, `Backend`, `QA`, `DevOps`); custom
  project roles slipped through. New test scans for the generic
  pattern `<Capital> should|must|will|may|owns|...` and rejects any
  match that isn't an allowlisted grammatical word.

### Cross-cutting

- Suite size 150 → 169.
- Three exit codes get a clearer mapping to agent action in
  the handbook: `USAGE` (fix your call), `FORBIDDEN` (escalate, do
  not retry), `STATE_CORRUPTION` (stop and ask the user).
- `Store` interface gains `updateConfig`; existing `writeConfig`
  is now documented as caller-must-hold-`config-yaml`-lock.

## [2.0.0-alpha.9] — 2026-05-27

### Critical correctness pass (PR8b)

Ten independent fixes from two consolidated reviews (one external
text-based, one canvas-based). Each maps to a regression test.

- **C-03 argv boolean-flag whitelist.** `gojaja plan --json PM` used
  to greedily consume `PM` as the value of `--json`, silently losing
  the role argument. New `BOOLEAN_FLAGS` set in
  [src/cli/argv.ts](./src/cli/argv.ts) keeps known booleans (`--json`,
  `--write`, `--force`, `--no-handbook`, `--no-wait`, `--help`,
  `--version`) from ever consuming the next token. 6 new tests in
  `tests/argv.test.ts`.
- **ULID cross-process race watermark.** Process-local monotonic ULIDs
  do not guarantee global ordering; two writers in the same millisecond
  can produce ids whose lexicographic order is reversed relative to
  write order, which in turn lets the cursor advance past an event no
  one has seen. `LocalFsStore` now defers events newer than
  `safetyMarginMs` (default 200 ms) to the next `plan`, preserving the
  cursor-never-skips invariant. Configurable via the constructor;
  tests pass 0 for deterministic visibility.
- **Stale lock conditional restore.** `tryBreakStale` no longer
  unconditionally unlinks the renamed-aside file. If the record on
  disk has changed under us (a fresh process legitimately took the
  lock after our detect-stale), the function renames the new record
  back in place and leaves any unrecoverable copy on disk as forensic
  evidence — never silently de-locking a live owner.
- **C-01 / lease + auto-heartbeat.** `findSessionById` now refuses
  sessions whose `heartbeatAt + leaseTtlSeconds * 1000` is in the past;
  `resolveIdentity` automatically calls `touchHeartbeat` on every
  successful resolution, so any authenticated command refreshes the
  lease. An active agent no longer gets silently taken over after the
  default 30-minute TTL just because it never explicitly heartbeats.
- **C-02 RFC self-heal on read.** `finaliseRfc` writes `decision.json`
  before updating `proposal.yaml`; a crash between those two writes
  used to leave the proposal `open` with a decision already on disk,
  letting the next `decide` overwrite the prior decision. `readRfc`
  now detects that inconsistent shape, forward-completes the proposal
  status from the decision's outcome, and emits a new `RFC_REPAIRED`
  event for the audit trail.
- **GOJAJA_SESSION strict / `resolveActor` helper.** Replaced the
  `try { resolveIdentity(...) } catch { actor = "SYSTEM" }` pattern in
  `task`, `rfc`, and `write-state` commands with a strict helper:
  `GOJAJA_SESSION` set → must resolve successfully; only unset means
  SYSTEM bypass. A stale or invalid `GOJAJA_SESSION` token no longer
  silently downgrades to SYSTEM, which had been an effective ownership
  bypass.
- **H-01 createRole atomic order + recovery.** Write order is now
  config-first, markdown-second. The "config has, markdown missing"
  shape is no longer permanently wedged — `createRole` detects it and
  finishes writing the markdown (preserving any hand-edited config
  fields). The "markdown without config" shape still refuses (legacy /
  hand-edit case requiring user action).
- **H-04 wait refuses pending manifest.** `wait --mode block` now
  errors out (USAGE) when `cursor.pendingManifest` is non-null. Before
  this the count was computed against the pre-plan cursor, so every
  event already in the pending manifest contributed to `count > 0`,
  producing a permanent false ATTENTION verdict and an agent loop.
- **claim + report registration gate.** `gojaja claim` now refuses
  unknown role ids (typo `claim Forntend` no longer creates a phantom
  session). `Store.publishReport` now refuses an unknown recipient
  role, matching the PROTOCOL.md contract.
- **plan TTY-aware output.** `gojaja plan` defaults to JSON whenever
  `process.stdout.isTTY` is false — agents invoking via shell now get
  the structured manifest the runtime contract promises. The
  human-text rendering additionally prints `Tasks (N)` and
  `RFCs (N)` sections, since the prior text body only showed events.

### Tests

127 → 150 (`tests/argv.test.ts` × 6, `tests/claim.test.ts` × 2, plus
targeted additions across existing files). Several existing tests had
to seed roles or pass `safetyMarginMs: 0` to remain deterministic
under the new gates.

### Docs

- [docs/SCHEMA.md](./docs/SCHEMA.md): new `RFC_REPAIRED` row.
- [docs/DESIGN.md](./docs/DESIGN.md): "Known limitations" gains the
  watermark trade-off note.

### Notes

PR8b is purely correctness; the larger PR8 (installer / upgrade /
reset) is unaffected. PR8c (secondary correctness + polish) is queued.

## [2.0.0-alpha.8] — 2026-05-27

### Changed — BREAKING (prompt / activate split)

`gojaja prompt` was overloaded: it built both the host-shared runtime
artifact (role-free) AND the per-window activation snippet (role-bound).
The role positional made it look as if the persistent file contained
role-specific instructions, which it never did. This release splits the
two responsibilities into separate commands so role identifiers cannot
leak into project-shared files.

- `gojaja prompt` is now strictly role-free:
  - Signature: `prompt --target codex|claude|cursor|generic [--write] [--no-handbook] [--json]`.
  - Refuses any positional argument with a USAGE error pointing at the
    new `activate` command (no silent fallback or back-compat alias —
    we don't want a "two ways to do the same thing" period).
- `gojaja activate <role> --target <host>` (new):
  - Prints the chat-paste snippet that binds `<role>` to one specific
    agent window. Never writes to disk.
  - For codex/claude/cursor, the snippet is short (a few hundred
    bytes); the runtime body lives in the persistent file installed
    by `prompt --write`.
  - For `--target generic`, the snippet bundles the runtime body too,
    since generic has no install location.
  - Validates the role exists in `config.yaml`; refuses unknown roles.
- `src/cli/prompts/*` refactored:
  - `RuntimeArtifact = { body, files }` is role-free.
  - `buildRuntime(target, projectRoot, opts)` builds the artifact.
  - `buildActivation(target, role, projectRoot, opts)` returns the
    per-window snippet as a plain string.
  - Each per-target wrapper exports `build<Target>Runtime` and
    `build<Target>Activation` as two distinct functions.

### Why

Two Cursor chat windows in the same project are two agents. Anything
written to `.cursor/rules/`, `<proj>/CLAUDE.md`, or `~/.codex/skills/`
is shared across windows, so it MUST be role-agnostic. The old
`prompt PM --target cursor --write` accepted a role even though the
file it wrote contained no role information — confusing and inviting
future bugs where a contributor accidentally embeds the role in the
template. Splitting the commands makes the constraint inexpressible at
the CLI surface.

### Tests (121 -> 127)

- New regression in `tests/prompt.test.ts`:
  "every target body contains plan + GOJAJA_SESSION **but never a role id**".
  The test scans the runtime body and every written file against every
  role id in `config.yaml`. Future contributors who accidentally embed
  a role will see CI go red.
- `prompt` rejects positional role argument with USAGE.
- `prompt --target generic --write` rejected (no install location).
- `activate` rejects when role is missing or unknown.
- `activate` for codex/claude/cursor produces short snippets
  (< 800 bytes; no handbook embedded).
- `activate` for generic bundles the full body (with or without the
  handbook depending on `--no-handbook`).
- Codex activation includes the `$gojaja-runtime` skill-trigger
  phrase.

### Migration

For anyone scripting the previous CLI: replace
`gojaja prompt PM --target cursor --write` with the two-step pair:

```bash
gojaja prompt --target cursor --write   # once per host, no role
gojaja activate PM --target cursor      # per agent window, role only
```

The shapes of the on-disk artifacts (Cursor rule, CLAUDE.md block,
Codex skill) are unchanged.

## [2.0.0-alpha.7] — 2026-05-27

### Added (PR8a — collaboration handbook)

Up to PR7 the framework taught agents the **mechanism** (which command,
what events). This release adds the **policy** layer: a compact, role-
neutral handbook that tells the agent **when** to choose which tool.

- New `src/cli/prompts/handbook.ts` exporting `COLLABORATION_HANDBOOK`
  (~7 KB of UTF-8 markdown). Sections:
  - Core stance.
  - Turn shape (the canonical per-turn order).
  - When to write a worklog (do / don't).
  - When to send a report (do / don't).
  - When to open an RFC instead of a report.
  - Disagreement (with assignments, accepted RFCs, other reports).
  - When to push upstream (concrete 2-turn trigger).
  - When to escalate up (by problem nature, not by role name).
  - When to bounce to the user — whitelist of 5 scenarios, plus a
    list of common temptations that are NOT the user's job.
  - Task lifecycle micro-rules (Backlog/InProgress/Done discipline,
    acceptance-ambiguity rule).
  - Idle / lifecycle (wait vs release; stale-manifest re-plan rule).
  - Build / test breakage (halt + report, never push on top).
  - Hard "don't"s.
- Wired into the runtime body so every host artifact carries it by
  default:
  - `gojaja prompt <role> --target codex|claude|cursor|generic`
    output bodies include the handbook.
  - `--write` persists it into `.cursor/rules/gojaja-runtime.mdc`,
    `~/.codex/skills/gojaja-runtime/SKILL.md`, and the marker
    block inside `<project>/CLAUDE.md`.
- New flag `gojaja prompt --no-handbook` for projects with their own
  behavioural standards or unusually tight context budgets. Dropping
  the handbook shrinks each artifact by ~3 KB.
- New `docs/HANDBOOK.md` documenting the policy layer and the
  authoring principles future edits must follow.
- 6 new vitest cases (`tests/handbook.test.ts`); 121/121 total. The
  test suite asserts that key trigger phrases survive future edits
  (`Blocked on T-XXXX (no movement 2t)`, `exit code 9 (FORBIDDEN)`,
  `Do NOT release the role`, `Don't hand-edit anything under
  .gojaja`, ...), that the handbook is role-neutral (no PM / TL /
  Backend / QA / DevOps mentions), and that the total size stays under
  the 8 KB budget.

### Rationale

Without a policy layer, agents tend to (a) over-communicate
(worklog-spam, RFCs for trivial questions) and (b) over-defer to the
human user. The handbook gives the LLM concrete, observable triggers
("blocked for 2 turns", "exit 9 FORBIDDEN", "stale manifest 5+ turns
old") so behaviour stops depending on which model is in the window.

Loaded **once per session** into the host's persistent area, so the
context cost is paid once and survives chat compression — it is never
shipped per turn the way `manifest.roleReminder` is.

## [2.0.0-alpha.6] — 2026-05-27

### Added (PR7 — ownership enforcement)

- `config.yaml:roles[<role>].owns` and `mustNotEdit` are now **runtime
  gates** for state-mutating commands, not just documentation.
- New `ForbiddenError` class (exit code 9), distinct from `UsageError`
  (exit 2), so callers can branch on "you are not allowed" vs "you said
  it wrong".
- New `Store.writeStateFile({ actor, relPath, content })`:
  - `relPath` must live under `state/`.
  - Atomic write (write tmp + rename); reader never sees partial.
  - Gated by `owns` (exact path OR directory-prefix match for entries
    ending in `/`).
  - Refused if the path also appears in `mustNotEdit` (defence in
    depth, even if `owns` also contains it).
  - `actor === "SYSTEM"` bypasses the gate so the human running the
    CLI manually can bootstrap or repair state.
- Task mutations are now gated:
  - `createTask` and `assignTask` require ownership of
    `state/task_board.yaml`.
  - `setTaskStatus` has a **task-owner exception**: a role may always
    update its OWN task's status, even without blanket task-board
    ownership. This lets engineering roles (Backend, QA, ...) report
    progress without being granted PM-level scope.
- New CLI `gojaja write-state --file <state/path> [--content <text>]`:
  - Content comes from `--content` if given, otherwise from stdin.
  - Identity from `GOJAJA_SESSION` (or `"SYSTEM"` if unset).
- 14 new vitest cases (`tests/ownership.test.ts`): writeStateFile
  allow/deny per role, mustNotEdit override, SYSTEM bypass, refusal
  outside `state/`, path-traversal refusal, directory-prefix matching,
  unknown actor refusal, task createTask/assignTask gating, task-owner
  exception, refusal for unrelated roles on status changes.
- 81 -> 115 tests total.

### Hardened

- `withFileLock`'s `detectStale` and `releaseIfOwned` now tolerate
  partial reads of the lock file (the lock is written non-atomically
  via `O_EXCL + write + close`, so a concurrent reader can briefly
  observe an empty/half-written file). Parse failures are treated as
  "record not yet observable" — never a reason to break a lock. Removes
  a latent flake under high test concurrency.

## [2.0.0-alpha.5] — 2026-05-27

### Added (PR6 — RFC state machine)

- Per-RFC directory `.gojaja/rfcs/RFC-NNNN-<slug>/` with
  `proposal.yaml`, `comments/<role>.json`, and `decision.json` (created
  on decide / reject).
- New `gojaja rfc` command group:
  - `rfc new <slug> --title <text> --deciders <r1,...>
      --options <A:summary,B:summary> [--voters <r1,...>] [--deadline <iso>]`
  - `rfc comment <rfc-id> --rationale <text> [--option <opt>]`
  - `rfc decide <rfc-id> --option <opt> --rationale <text>`
  - `rfc reject <rfc-id> --rationale <text>`
  - `rfc list [--status open|accepted|rejected|superseded]`
  - `rfc show <rfc-id>`
- New `Store` methods: `createRfc`, `commentRfc`, `decideRfc`,
  `rejectRfc`, `readRfc`, `listRfcs`.
- New types: `RfcStatus`, `RfcOption`, `RfcProposal`, `RfcComment`,
  `RfcDecision`, `RfcSummary`, plus payload types.
- New event payloads emitted: `RFC_CREATED`, `RFC_COMMENT`,
  `RFC_DECIDED`.
- `ProjectConfig.rfcCounter` persists the auto-id allocator (so
  deleting an RFC dir does not recycle its id).
- Manifest carries a new `rfcs` array (`RfcSummary[]`): open RFCs
  needing this role's action (voter that hasn't commented, or
  decider until close). Fields are minimal (`id`, `title`, `status`,
  `role: "voter" | "decider"`, `commented: boolean`); full proposal +
  comments + decision come from `gojaja rfc show <id>`.
- 20 new vitest cases (`tests/rfc.test.ts`); 81 -> 101 total.

### Design choices for the RFC layer

- **No automatic tally.** The deciders pick. `decide` does not read
  comments and there is no "all voters must comment before decide" gate
  — real teams have a tech lead who can call it whenever they think
  enough input has been gathered.
- **Status machine is small.** `open -> accepted | rejected`. Both
  terminal in v2; `superseded` is reserved for v2.x.
- **Non-voters may comment.** Voter list is advisory, not gated; real
  teams often get useful cross-cutting input from outside the named set.
- **Slug uniqueness enforced** across RFCs (refuses reuse), so any
  later command that takes `<rfc-id-or-slug>` would be unambiguous.

## [2.0.0-alpha.4] — 2026-05-27

### Added (PR5 — task board)

- New on-disk artifact: `.gojaja/state/task_board.yaml`. Schema:
  `schemaVersion`, `nextId` (auto-allocator counter), and a `tasks`
  map keyed by `T-NNNN` id with `title`, `status`, `owner`, `priority`,
  `dependsOn`, `acceptance`, `createdAt`, `updatedAt`. Statuses:
  `Backlog | Ready | InProgress | Blocked | Review | Done`.
- New CLI surface `gojaja task`:
  - `task new --title <text> [--owner <role>] [--priority P0|P1|P2|P3]
    [--depends-on T-NNNN,...] [--acceptance <text>]`.
  - `task assign <task-id> --to <role>`.
  - `task status <task-id> <Backlog|Ready|InProgress|Blocked|Review|Done>`.
  - `task list [--owner <role>] [--status <s>]`.
  - `task show <task-id>`.
- New event types `TASK_CREATED`, `TASK_ASSIGNED`,
  `TASK_STATUS_CHANGED`, all emitted automatically by the
  corresponding command. `from` is the role bound to `GOJAJA_SESSION` when
  available, otherwise `"SYSTEM"`.
- Manifest carries a new `tasks` array (`TaskSummary[]`): tasks where
  `owner == role` AND `status ∈ {Ready, InProgress, Blocked, Review}`.
  Each summary keeps just `id`, `title`, `status`, `priority`, and
  `blockedBy` (the subset of `dependsOn` that is not yet `Done`).
  Full task records are fetched on demand via `gojaja task show <id>`.
- New `Store` methods: `readTaskBoard`, `createTask`, `assignTask`,
  `setTaskStatus`, `readTask`. All mutations go through a `task-board`
  lock; auto-id allocation is monotonic even across crashes.
- 14 new vitest cases covering id allocation, event emission, role-id
  validation, status validation, idempotent no-op assigns, and
  manifest filtering / `blockedBy` derivation.

### Notes

- Task status transitions are unrestricted in v2 by design — any role
  may set any status. A constrained state machine (PR7+) can layer on
  top of this once ownership enforcement lands.
- `gojaja init` now seeds an empty `state/task_board.yaml` alongside
  `VERSION` and `config.yaml`.

## [2.0.0-alpha.3] — 2026-05-27

### Added (PR4 — manifest self-anchoring)

- `Manifest.roleReminder`: a compact identity block embedded in every
  `gojaja plan` output. Carries `id`, `title`, optional `owns`,
  `mustNotEdit`, `reportsTo`, plus a 95-char `protocol` one-liner.
  Empty fields are intentionally omitted to keep agent prompts tight
  (a fully populated reminder serialises to under 300 bytes).
- `PROTOCOL_ONE_LINER` constant in `src/core/types.ts` — the single
  source of truth for the protocol string the reminder embeds.
- Test coverage: reminder presence, content from `config.yaml`,
  empty-field omission, and serialised-size budget.

### Rationale

A context-compressed agent that has lost its role contract can now
recover its identity by running `gojaja plan` once. The reminder
trades ~250 bytes per manifest for an order-of-magnitude reduction
in "agent forgot which role it is" failure modes.

## [2.0.0-alpha.2] — 2026-05-27

### Added (PR3 — role / prompt / wait)

- `gojaja role create <id> [<title>] [--description] [--owns]
  [--reports-to] [--must-not-edit]` provisions a role end-to-end: it
  registers `<id>` in `.gojaja/config.yaml` AND writes the human
  contract under `.gojaja/roles/<id>.md`. Refuses duplicates.
- `gojaja role list` and `gojaja role show <id>`.
- `gojaja prompt <role> --target codex|claude|cursor|generic`
  prints an activation prompt. With `--write`, it also installs the
  host-specific persistent artifact:
  - `codex`: `${CODEX_HOME:-~/.codex}/skills/gojaja-runtime/`
    SKILL.md + agents/openai.yaml.
  - `claude`: a marker-block `<!-- gojaja-runtime:BEGIN..END -->`
    inside `<project>/CLAUDE.md`, preserving surrounding content.
  - `cursor`: `<project>/.cursor/rules/gojaja-runtime.mdc` with
    `alwaysApply: true`.
  - `generic`: prints only.
  The persistent artifacts are role-agnostic (they teach the agent how
  to find its identity via `GOJAJA_SESSION`); a per-window activation
  snippet binds the role.
- `gojaja wait [--idle <min>] [--mode block|exit]` provides the
  cheap-keepalive primitive. `block` does a shell-level sleep, then
  one cursor-free check, exits 0 with `ATTENTION` or `IDLE`. `exit`
  writes a `.wait` sentinel and returns immediately. Never overloads
  exit codes; never mutates the cursor (closes v0.1 wait bugs).
- New Store methods: `createRole`, `readRoleFile`, `readConfig`,
  `writeConfig`, `writeWaitSentinel`.
- New on-disk artifact: `.gojaja/config.yaml` (created by
  `gojaja init`). See [docs/SCHEMA.md → config.yaml](./docs/SCHEMA.md#configyaml).
- New on-disk artifact: `.gojaja/comms/pending/<role>/.wait`
  sentinel (written by `gojaja wait --mode exit`).
- New dependency: `js-yaml` (plus `@types/js-yaml`) for config.yaml
  round-tripping.
- New `src/cli/prompts/` module: `core.ts` (shared body) + per-target
  wrappers (`codex.ts`, `claude.ts`, `cursor.ts`, `generic.ts`) + a
  small write engine that handles atomic replace and marker-block
  upsert with refuse-to-clobber-unrelated-files protection.
- 25 additional vitest cases (`tests/role.test.ts`,
  `tests/prompt.test.ts`, `tests/wait.test.ts`); 64/64 total.

### Changed

- `gojaja init` now also seeds `.gojaja/config.yaml` with the
  current schemaVersion and an empty `roles` map.
- `gojaja help` reorganised around the three real audiences: things
  the user runs once (init / role / prompt), things the user runs once
  per window (claim / release), and things the agent runs on every turn
  (plan / ack / report / worklog / wait).
- ROADMAP re-sequenced. PR4 is now "manifest self-anchoring", PR5 is
  task board, PR6 is RFC, PR7 is ownership enforcement, PR8 is
  installer, PR9 is doctor/history/archival, PR10 is chaos/soak.

## [2.0.0-alpha.1] — 2026-05-27

### Added (PR2 — claim / plan / ack / report / worklog)

- `gojaja claim <role> [--ttl <s>] [--force]` leases a role for the
  current shell and prints the session id.
- `gojaja release [<role>]` ends the current session.
- `gojaja plan [<role>]` produces a JSON `Manifest` of unread events
  scoped to the role, persists it under
  `comms/pending/<role>/<ack-token>.json`, and stamps
  `cursor.pendingManifest`. Idempotent: calling twice in a row returns
  the same manifest with the same `ackToken`.
- `gojaja ack [<role>] --token <t>` advances the cursor exactly to
  the manifest's `advanceCursorTo`. Token mismatch is rejected;
  events that arrived between `plan` and `ack` are preserved unread.
- `gojaja report --to <role> --message <text> [--ref <id>]`
  publishes a REPORT event. `from` is derived from `GOJAJA_SESSION`; the
  agent cannot impersonate another role.
- `gojaja worklog --message <text>` broadcasts a WORKLOG event and
  also writes `worklog/<role>/<id>.md` for git-readable history.
- `GOJAJA_SESSION` environment variable carries identity between commands;
  `src/cli/identity.ts:resolveIdentity` enforces it.
- New `Store` methods: `findSessionById`, `publishReport`,
  `publishWorklog`, `openOrCreatePlan`, `ackManifest`.
- New types: `Manifest`, `ReportPayload`, `WorklogPayload`.
- 20 additional vitest cases (`tests/plan-ack.test.ts`,
  `tests/identity.test.ts`) — 39/39 total. Key regression tests:
  - `does NOT skip events that arrived after plan` — covers the
    v0.1 ack-race bug.
  - `is idempotent across retry` — covers crash-and-restart.
  - `never loses an event across a fast publish/plan/ack loop` —
    30-event property test.
  - `filters events by recipient, excludes self-sent` — sender does
    not re-process its own broadcasts.

### Changed

- Inbox is now a derived view (filter on the event stream by
  `to ∈ {role, "*"} && from !== role`). The `comms/inbox/<role>/`
  directory and the `Paths.inboxDir` constant are gone. See
  [docs/SCHEMA.md → Inbox is a derived view](./docs/SCHEMA.md#inbox-is-a-derived-view-not-files)
  for the rationale.

## [2.0.0-alpha.0] — 2026-05-27

### Added (PR1 — storage core)

- TypeScript-based `gojaja` CLI replacing the v0.1 bash prototype.
- `Store` interface (`src/core/store.ts`) shaped to allow a future HTTP
  transport without command-layer changes.
- `LocalFsStore` (`src/core/local-fs-store.ts`):
  - Atomic write-and-rename for all single-file mutations.
  - Immutable per-record event files in `comms/events/<ulid>.json`.
  - File-based per-resource lock with lease (default 30 s), PID
    liveness, and stale-break with `LOCK_BROKEN` audit event.
  - Cursor read/update under per-role lock; monotonic advancement
    enforced.
  - Session claim/release/heartbeat with `SESSION_CLAIMED`,
    `SESSION_RELEASED`, `SESSION_TAKEOVER` events.
- ULID id generation (monotonic process-local factory).
- Strict path validation: `resolveInside` rejects absolute paths and
  `..` escapes; role-id and lock-key whitelists.
- CLI commands: `gojaja --version`, `gojaja help`, `gojaja init`,
  `gojaja version`. All commands support `--json`.
- Stable error class → exit code map (see [DESIGN](./docs/DESIGN.md#errors-and-exit-codes)).
- Documentation set: `docs/DESIGN.md`, `docs/SCHEMA.md`,
  `docs/PROTOCOL.md`, `docs/ROADMAP.md`, this changelog.
- Vitest test harness with 19 cases covering concurrent appends, cursor
  monotonicity, stale-lock takeover, session lifecycle, and path/role-id
  validation.

### Removed

- The entire v0.1 bash prototype: `templates/multi-agent/` (scripts,
  protocol markdown, role files, RFC templates), `skills/`, the
  `.gojaja → templates/multi-agent` symlink, and the
  `bin/multi-agent.js` installer.
- The AGENTS.md "multi-agent-bridge" block (replaced by repo-level dev
  notes; the new bridge is reintroduced as part of PR6's installer).

### Notes

- This release is an alpha. The wire protocol between CLI and agent is
  still in flux; do not depend on it from production tooling.
- v0.1 is not supported. No migration path is provided. Anyone who used
  v0.1 should start fresh with `gojaja init`.
