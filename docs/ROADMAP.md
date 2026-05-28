# Roadmap

Cross-references: [DESIGN](./DESIGN.md), [PROTOCOL](./PROTOCOL.md),
[SCHEMA](./SCHEMA.md), [CHANGELOG](../CHANGELOG.md).

This roadmap is a rolling artifact. Items move from "planned" to "in
progress" to "done" via PRs that land on `v2`.

## v2.0.0 — minimum viable rewrite

The goal of v2.0.0 is a coordinated-but-not-yet-feature-complete layer
that an agent team can use end-to-end without hitting the v0.1 sharp
edges (cursor races, TSV corruption, global lock, slug traversal).

### Done

- **PR1 — storage core.**
  - `Store` interface; `LocalFsStore` implementation.
  - ULID-named immutable event files; directory-as-queue.
  - Atomic write-and-rename helpers.
  - Per-resource file lock with lease + PID liveness + stale break.
  - `LOCK_BROKEN` audit event on recovery.
  - Cursor read/update with monotonic invariant enforced.
  - Session claim/release/heartbeat with `SESSION_TAKEOVER` events.
  - Strict path / role-id / lock-key validation.
  - CLI skeleton: `agentctl --version | help | init | version`.

- **PR2 — claim / plan / ack / report / worklog.**
  - `agentctl claim <role>` / `agentctl release`.
  - `MA_SESSION` environment-variable identity, resolved via
    `Store.findSessionById`.
  - `agentctl plan [<role>]` with manifest emission,
    `pendingManifest` stamp, idempotent across retry.
  - `agentctl ack [<role>] --token <t>` with bounded cursor advance —
    fixes the v0.1 "ack races concurrent write" loss.
  - `agentctl report --to <role> --message <text> [--ref <id>]`.
  - `agentctl worklog --message <text>` plus a markdown copy under
    `worklog/<role>/<id>.md`.
  - Design simplification: inbox is now a derived filter on the event
    stream, not a separate file tree. See
    [SCHEMA: Inbox is a derived view](./SCHEMA.md#inbox-is-a-derived-view-not-files).
  - 39 vitest cases across storage, plan/ack, and identity resolution.

- **PR3 — role / prompt / wait.**
  - `agentctl role create / list / show` plus a backing `config.yaml`
    that registers each role's title, owns, reportsTo, and mustNotEdit.
  - `agentctl prompt <role> --target codex|claude|cursor|generic`
    [`--write`], producing host-specific persistent artifacts: Codex
    skill, Claude `CLAUDE.md` marker block, Cursor
    `.cursor/rules/multi-agent-runtime.mdc`. Role-agnostic install +
    per-window activation snippet.
  - `agentctl wait` (block + exit modes) with no exit-code overloading
    and no cursor mutation.
  - `js-yaml` dependency added for `config.yaml` round-tripping.
  - 25 new vitest cases (`tests/role.test.ts`, `tests/prompt.test.ts`,
    `tests/wait.test.ts`); 64/64 total.

- **PR4 — manifest self-anchoring.**
  - `agentctl plan` output now embeds a compact `roleReminder`
    (`id`, `title`, optional `owns`/`mustNotEdit`/`reportsTo`, plus a
    95-char protocol one-liner). Empty fields are omitted.
  - Goal: a context-compressed agent recovers full identity by
    running `agentctl plan` once.

- **PR5 — task board.**
  - `state/task_board.yaml` schema with id, status, owner, priority,
    dependsOn, acceptance, createdAt, updatedAt.
  - `agentctl task new / assign / status / list / show`.
  - `plan` manifest now carries a `tasks` array filtered to
    `owner == role && status ∈ {Ready, InProgress, Blocked, Review}`,
    with `blockedBy` derived from dependsOn entries that are not Done.
  - New event types: `TASK_CREATED`, `TASK_ASSIGNED`,
    `TASK_STATUS_CHANGED`.

- **PR6 — RFC state machine.**
  - Per-RFC directory `rfcs/RFC-NNNN-<slug>/` with `proposal.yaml`,
    `comments/<role>.json`, and `decision.json`.
  - `agentctl rfc new / comment / decide / reject / list / show`.
  - Status machine `open -> accepted | rejected`, enforced; no
    automatic tally — a role in the proposal's `deciders` list calls
    `decide` or `reject`.
  - `plan` manifest carries an `rfcs` array of open RFCs needing this
    role's action (voter that has not commented, or decider until the
    RFC closes).
  - Event types: `RFC_CREATED`, `RFC_COMMENT`, `RFC_DECIDED`.

- **PR7 — ownership enforcement.**
  - `config.yaml:roles[<role>].owns` and `mustNotEdit` become runtime
    gates for state writes and task mutations.
  - `agentctl state edit --file <state/path>` (renamed from
    `agentctl write-state` in PR8f-C) writes atomically into the state
    subtree, gated by ownership; `SYSTEM` (no MA_SESSION) bypasses for
    human bootstrap.
  - `agentctl task new` / `task assign` require ownership of
    `state/task_board.yaml`. `task status` has a task-owner exception
    (a role may always update its own task's status).
  - New `ForbiddenError` class with stable exit code 9.

- **PR7a — prompt / activate split.**
  - `agentctl prompt` is now strictly role-free (`--target X [--write]`);
    a new `agentctl activate <role> --target X` prints the per-window
    chat-paste snippet without ever touching disk.
  - Enforces the architectural invariant "role binding lives at the
    window/shell layer, never at the project layer" — two Cursor chats
    in the same project can hold different roles independently.
  - Regression test scans the runtime body and every written file for
    role-id leaks; any future contributor who embeds a role in the
    template gets caught at CI.

- **PR8a — collaboration handbook.**
  - New `src/cli/prompts/handbook.ts` exporting a ~7 KB UTF-8
    `COLLABORATION_HANDBOOK` string. Role-neutral; concrete triggers;
    mostly "don'ts".
  - Default-injected into every `agentctl prompt --target X --write`
    artifact (Cursor rules, Codex skill, Claude CLAUDE.md block, generic
    stdout). `--no-handbook` opts out.
  - Covers: turn shape, worklog rules, report vs RFC, disagreement,
    push-upstream / escalation, user-vs-agent escalation whitelist,
    task lifecycle micro-rules, idle/stale-manifest handling, build/test
    breakage, hard "don't"s. See [HANDBOOK.md](./HANDBOOK.md).

- **PR8b — critical correctness pass.**
  - Ten independent fixes from two consolidated reviews. argv boolean
    flag whitelist, ULID cross-process watermark, stale-lock
    conditional restore, RFC self-heal on inconsistent on-disk shape,
    `MA_SESSION` strict semantics, session lease + auto-heartbeat,
    atomic `createRole`, `wait` refusal with pending manifest,
    `claim` / `publishReport` recipient-role validation, TTY-aware
    `plan` default + tasks/RFCs in text output.

- **PR8c — review correctness + UX.**
  - Fourteen independent fixes from a third reviewer pass plus a
    business-process simulation: path-canonicalisation enforcement,
    `link(2)`-based stale-lock restore, RFC self-heal under lock,
    `Store.updateConfig` for atomic config-yaml RMW, Cursor target
    `wait --mode exit`, `task new` default Ready on owner, `claim`
    error de-advertises `--force`, Codex SKILL.md project-agnostic,
    RFC deciders gate → `FORBIDDEN`, fail-closed corrupt heartbeat,
    `task new` / `task assign` owner registration check, `release`
    `unset MA_SESSION` hint, `claim --eval` mode, handbook review
    handoff + role-neutrality regex guard. Suite 150 → 169.

- **PR8d — prompt UX gate + role delete.**
  - Runtime body opens with an "only when bound to a role" gate so an
    unactivated agent window does not reflexively run agentctl.
  - `prompt --write` prints a "restart any open agent windows" caveat
    on every successful write; JSON adds `requiresWindowRestart`.
  - "SKIPPED" renamed to "UNCHANGED (already up to date)"; new
    `--force-rewrite` flag overrides the byte-equal short-circuit.
  - New `agentctl role delete <id>` (SYSTEM-only): removes config /
    md / live session and emits `ROLE_DELETED`. Open task assignments
    are left in place by design so re-creating the same id reinherits
    them.
  - Suite 169 → 185.

- **PR8e — first-run UX.**
  - README.md / README.zh-CN.md rewritten around the user-vs-agent
    boundary (7 sections), including a "what you still write by
    hand" section and a Common-situations troubleshooting block.
  - SCHEMA.md flagged `state/project_state.md` as not auto-created
    (later flipped to auto-created skeleton in PR8f-B).
  - `role create` nags about TBD sections in the freshly rendered
    role markdown; `role list` annotates TBD rows; `agentctl
    activate` refuses while the role markdown still has TBD.
  - `activate` output rewritten: explicit `═══ BEGIN/END PASTE ═══`
    dividers, second-person `You are the ...` framing, three numbered
    steps (claim via --eval, role show, agentctl -h), auto-copy to
    clipboard via pbcopy / wl-copy / xclip / xsel / clip.exe with
    `--no-copy` escape hatch.
  - `agentctl -h` rewritten: intro paragraph + Quickstart + per-section
    inline tips + exit-codes table + See-also doc links.
  - Handbook gains "Task assignment is push, not pull" + "Multi-role
    task pattern" + hard-don't against `task assign --to <yourself>`.
  - Suite 185 -> 198.

- **PR8f-A — first-run discoverability (docs only).**
  - `--owns` directory-prefix semantics surfaced in help / README /
    SCHEMA (the matcher already supported it; users couldn't find it).
  - `--reports-to` and `--must-not-edit` explained in help, README,
    SCHEMA, and as inline annotations in `role show` output.
  - Handbook explains that RFC `--deciders` is per-RFC ad-hoc with
    no role-level flag; SCHEMA records the absence and points at
    PR8g as the candidate shortlist.
  - README / SCHEMA add the "why no `read-state`" rationale.
  - `roles/<id>.md` template seeds a TBD bullet asking the role to
    document its expected RFC decision scopes.

- **PR8f-B — init skeleton + write-state replace/append.**
  - `agentctl init` seeds a TBD skeleton at `state/project_state.md`
    so the file always exists; the handbook nudges agents to ask the
    user to fill TBD sections before judging Done.
  - `agentctl write-state` (later renamed to `agentctl state edit` in
    PR8f-C) gains `--append` and `--replace`/`--with`/`--batch` modes
    alongside the existing `--content` (overwrite). Default replace
    refuses 0 or N>1 matches; `--batch` allows N>1. All modes still
    flow through ownership / mustNotEdit / path canonical-form gates
    and remain atomic.
  - Suite 198 -> 214.

- **PR8f-C — rename write-state, sync help, roleReminder hint.**
  - `agentctl write-state` renamed to `agentctl state edit` (hard
    cut; alpha-stage, no backward alias). Subcommand-group style now
    consistent with `task / role / rfc`.
  - `agentctl -h` rewrites the state-editing section to list all
    three modes with copy-pasteable invocations.
  - `manifest.roleReminder.protocol` adds a `agentctl role show
    <you>` hint so agents who lose context are routed to recover
    their own contract every turn (within the 300-byte budget).

- **PR8g — RFC v2 (multi-round, threaded, mutable options, related tasks, revise).**
  *(Amended by PR8g.1: pre-decide collapsed back to a comment kind
  with mandatory ACK gate; see PR8g.1 entry below.)*
  - Status machine expands to `{open, pre-decide, revising, accepted,
    rejected, superseded}`. Pre-decide is optional (decider proposes,
    voters consent by silence or object by commenting, which auto-
    reopens the RFC). Revise/edit is a "send back for rewrite" path
    that preserves comments across the cycle.
  - Comments move from per-role JSONs to a single threaded
    `comments.yaml` ledger; each comment is a ULID with a `replyTo`
    chain. Multiple comments per role preserved.
  - 6 new CLI verbs: `add-option`, `pre-decide`, `revise`, `edit`,
    `link-task`, `unlink-task`. New flags on existing: `rfc new
    --description --task`, `rfc comment --reply-to`, `rfc show
    --no-mark-seen`.
  - `relatedTasks` field on `RfcProposal` validated against task board.
  - `manifest.rfcs[*]` gains `unreadComments`, `relatedTasks`,
    `pendingPreDecision`. Per-role-per-RFC read cursor under
    `comms/cursors/<role>/rfc-<id>.json`.
  - 7 new event types: `RFC_OPTION_ADDED`, `RFC_PRE_DECISION`,
    `RFC_PRE_DECISION_OBJECTED`, `RFC_REVISION_REQUESTED`,
    `RFC_REVISED`, `RFC_TASK_LINKED`, `RFC_TASK_UNLINKED`.
  - Breaking on-disk shape change (alpha-only, no users): the
    pre-PR8g `comments/<role>.json` layout is detected on read and
    refused with a clear migration error.
  - Suite 216 -> 247.

- **PR8g.1 — RFC pre-decide reshaped to comment + mandatory ACK gate.**
  - Status `pre-decide` removed; collapses back to 5 states. The
    PR8g auto-reopen mechanic and `RFC_PRE_DECISION` /
    `RFC_PRE_DECISION_OBJECTED` event types are gone.
  - Pre-decide is now a structured comment with `kind: "pre-decision"`.
    Voters / non-pre-decider deciders use new `agentctl rfc ack` /
    `agentctl rfc object` verbs to register positions.
  - `decideRfc` enforces a hard ACK gate: every role in
    `(voters ∪ deciders) − {pre-decider}` must explicitly ack or
    object. Silence does NOT count as consent. No override; the only
    escape from a stalled round is `rfc reject` + open a new RFC.
  - Re-issuing `rfc pre-decide` invalidates all prior ACKs. `add-option`
    while pending silently invalidates the pre-decision.
  - Another alpha-only breaking on-disk shape change: PR8g
    `proposal.yaml` with `status: pre-decide` or a `preDecision: {...}`
    field is detected on read and refused with migration hint.
  - Suite 247 -> 260.

- **PR8i — wait redesigned around deadlines + RESUME + idle broadcast.**
  - Cuts `--mode block | exit`, `--idle <minutes>`, `--idle-seconds`,
    and the `.wait` sentinel. Removed flags raise USAGE pointing at
    the new shape.
  - New flags: `--until <ISO>` / `--in <duration>` /
    `--for <condition>` / `--poll-interval <duration>`.
  - Conditions: `attention` (default), `rfc-decided:<id>`,
    `rfc-acked:<id>`, `task-assigned`, `report-from:<role>`,
    `event-ref:<id>`.
  - Four verdicts: `ATTENTION`, `CONDITION_MET`, `RESUME`, `TIMEOUT`.
    Each prints the next command. RESUME is the chunked-polling
    recovery mechanism that lets a long wait survive any host shell
    timeout.
  - `--for task-assigned` auto-broadcasts a one-shot idle WORKLOG so
    task-board owners can re-assign the role. Dedup-ed across resumes
    via `comms/pending/<role>/wait.json`.
  - Cursor runtime body pins `--poll-interval 30s`; other targets
    leave the default.
  - Schema version bumped to `2.0.0-wait-v2`.
  - Suite 260 -> 270.

- **PR8j — task model expansion: parent / assets / deliverables / assignedBy / tags.**
  - `Task` gains `parent` (decomposition, depth-capped at 5, cycle-checked),
    `assignedBy` (the actor who created the task; audit; not updated by
    `assignTask`), `assets` (info-only pointers; `kind=file | url`),
    `deliverables` (hard outputs; `kind=file | url | manual`), `tags`
    (free-form labels).
  - `setTaskStatus(... Done)` enforces a deliverable gate: any
    `kind: "file"` deliverable whose `ref` is missing on disk refuses
    the transition with `UsageError`. `--force-incomplete` bypasses
    with a `TASK_DELIVERABLE_BYPASSED` audit event emitted BEFORE the
    `TASK_STATUS_CHANGED`.
  - `TaskSummary` (manifest) gains `parent`, `childCounts`,
    `unmetDeliverables`, `tags` so epic owners can see aggregated
    child state and unmet hard outputs at a glance.
  - `task list --tag <label>` (repeatable, OR-match) and `task show`
    rendering with on-disk `[x] / [ ] / [?]` checkboxes.
  - `argv.ts` gains a `multiFlag` helper + `rawArgs` on `ParsedArgs`
    so `--asset` / `--deliverable` / `--tag` can repeat cleanly.
  - Schema version bumped to `2.0.0-task-v2`. Legacy boards backfill
    new fields with safe defaults on read.
  - Suite 270 -> 284.

- **PR8l — brainstorm-mode RFC (empty options).**
  - `createRfc` no longer rejects `options: []`. An RFC created without
    options opens in brainstorm mode: voters comment freely; pre-decide
    is refused (points at `add-option`); `decide` accepts without
    `--option` and records `chosenOption: null` with the rationale
    carrying the takeaway.
  - The moment anyone runs `rfc add-option`, the RFC upgrades to a
    decision flow: `decide` then requires `--option`, pre-decide /
    ACK gate works normally.
  - `Store.decideRfc.chosenOption` widened to `string | null`.
  - `rfc decide --option` becomes conditional in the CLI.
  - Non-breaking: no schema change; constraint relaxation only.
  - Suite 284 -> 294.

### Planned, in priority order

- **PR8k — org-hierarchy ergonomics (planned).**
  - Reverse `directReports` computed field on `roleReminder` so a
    manager role knows "who reports to me" without scanning
    `role list`.
  - `agentctl wait --for task-assigned` retargets the idle worklog
    to `directReports` instead of `*` so the broadcast lands only on
    likely-task-assigners.
  - `agentctl report --to <a>,<b>` multi-target so a manager can
    address a team subset without N separate calls.
  - Role-level `decisionScopes` so RFC `--deciders` can be inferred
    from scope rather than spelled out each time (defended against
    scope-shopping via the audit log).
  - Goal: make 3+ layer organisations (CTO -> PM/TL -> workers)
    pleasant rather than noisy. Built on the PR8j parent + tag
    primitives.

- **PR8h — schema-level deferments.**
  - Task `reviewers` field so a Review handoff can sign off without
    needing task-board ownership.
  - `STATE_UPDATED` event when `state/*` files change.
  - `dependsOn` cycle detection in task board.
  - Schema-version compatibility check on `agentctl plan`.
  - Harden `rfc new --description` from soft-warn (PR8g) to required.
  - Candidate: read-only `agentctl rfc audit <id>` to surface
    "who has ack'd / objected / not responded yet" without the
    agent reading `rfc show`.
  - Candidate: role-level `decisionScopes` so a role becomes a default
    RFC decider for matching scopes (currently `--deciders` is
    per-RFC ad-hoc). Promote if PR8g's handbook nudge proves
    insufficient.

- **PR8 — installer & upgrade.**
  - `agentctl upgrade` driving `src/migrations/<from>-<to>.ts`.
  - `agentctl reset --confirm <project-name>` for destructive nukes.
  - AGENTS.md bridge insertion with versioned marker block, re-written
    on every upgrade.

- **PR9 — operational tooling.**
  - `agentctl doctor`: JSON parse all records, validate cursor reachability,
    detect orphan manifests, surface stale locks.
  - `agentctl history --role <role> [--since <ulid>]`.
  - Event archival (`comms/events/_archive/YYYY-MM-DD/`) with a configurable
    retention floor.

- **PR10 — chaos / soak.**
  - Multi-process integration tests under `vitest`'s pool=forks running
    real concurrent claim/plan/ack cycles.
  - Random-kill harness asserting `agentctl doctor` stays green.

After PR10 we tag `v2.0.0`.

## v2.x — deferred but slot-reserved

- **HTTP transport.** `HttpStore` implementing the same `Store`
  interface; an `agentctl serve` mode that wraps a `LocalFsStore` behind
  a REST API. Authentication, TLS, and account model are out of scope
  for this layer — to be designed by the consuming team.
- **Heartbeat watcher.** `agentctl watch` daemon that downgrades stale
  sessions and emits `attention_required` events when an offline role
  has waiting inbox items.
- **Multi-machine safety review.** Verify rename / lock semantics under
  the storage backends people actually use (local disk, NFSv4, Dropbox,
  iCloud). Mark unsupported configurations explicitly.
- **Windows support.** Test rename-onto-open and PID liveness on
  Windows; gate on green CI before claiming support.
- **Schema migrations engine.** Today's migrations directory is empty;
  add the runner, backup-before-migrate, and dry-run mode.

## Explicit non-goals (for now)

- A built-in LLM call layer.
- A built-in agent-prompt template engine.
- A web UI.
- Replacement for `git` as audit storage; the framework only adds an
  in-tree `audit.log`, not a content-addressable store.

## Sequencing notes

PR1–PR7 + PR8a establish the protocol surface (events, sessions,
plan/ack, tasks, RFCs, ownership, handbook). PR7a / PR8b / PR8c / PR8d /
PR8e / PR8f-A / PR8f-B / PR8f-C are correctness + UX hardening.
PR8g + PR8g.1 rework the RFC mechanism to support real multi-round
decisions: PR8g introduced threading + add-option + pre-decide +
revise/edit; PR8g.1 walked back the pre-decide state-machine to a
comment kind with a hard ACK gate (silence is not consent). PR8i
collapses the `wait --mode block | exit` dichotomy into a single
deadline-driven, chunked, resumable primitive. PR8j expands the task
model with parent/assets/deliverables/assignedBy/tags so 3+ layer
organisations can express decomposition + hard outputs natively.
PR8l relaxes the RFC `--options` requirement so the same primitive
covers wide-open brainstorm sessions (no concrete choices yet).
The "breaking" alpha-stage surface changes are PR8f-C
(`write-state` → `state edit`), PR8g (comments file shape),
PR8g.1 (pre-decide field/status removed), PR8i (wait flags +
`.wait` sentinel removed), and PR8j (task field additions, Done
deliverable gate). PR8l is non-breaking (constraint relaxation only).
PR8h, PR8k, and PR9–PR10 harden the layer for everyday use; PR8h
is the only remaining RFC-affecting PR
before `v2.0.0`. Anything past `v2.0.0` only ships after the chaos
suite (PR10) is green.
