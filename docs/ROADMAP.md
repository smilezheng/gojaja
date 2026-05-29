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
  - CLI skeleton: `gojaja --version | help | init | version`.

- **PR2 — claim / plan / ack / report / worklog.**
  - `gojaja claim <role>` / `gojaja release`.
  - `GOJAJA_SESSION` environment-variable identity, resolved via
    `Store.findSessionById`.
  - `gojaja plan [<role>]` with manifest emission,
    `pendingManifest` stamp, idempotent across retry.
  - `gojaja ack [<role>] --token <t>` with bounded cursor advance —
    fixes the v0.1 "ack races concurrent write" loss.
  - `gojaja report --to <role> --message <text> [--ref <id>]`.
  - `gojaja worklog --message <text>` plus a markdown copy under
    `worklog/<role>/<id>.md`.
  - Design simplification: inbox is now a derived filter on the event
    stream, not a separate file tree. See
    [SCHEMA: Inbox is a derived view](./SCHEMA.md#inbox-is-a-derived-view-not-files).
  - 39 vitest cases across storage, plan/ack, and identity resolution.

- **PR3 — role / prompt / wait.**
  - `gojaja role create / list / show` plus a backing `config.yaml`
    that registers each role's title, owns, reportsTo, and mustNotEdit.
  - `gojaja prompt <role> --target codex|claude|cursor|generic`
    [`--write`], producing host-specific persistent artifacts: Codex
    skill, Claude `CLAUDE.md` marker block, Cursor
    `.cursor/rules/gojaja-runtime.mdc`. Role-agnostic install +
    per-window activation snippet.
  - `gojaja wait` (block + exit modes) with no exit-code overloading
    and no cursor mutation.
  - `js-yaml` dependency added for `config.yaml` round-tripping.
  - 25 new vitest cases (`tests/role.test.ts`, `tests/prompt.test.ts`,
    `tests/wait.test.ts`); 64/64 total.

- **PR4 — manifest self-anchoring.**
  - `gojaja plan` output now embeds a compact `roleReminder`
    (`id`, `title`, optional `owns`/`mustNotEdit`/`reportsTo`, plus a
    95-char protocol one-liner). Empty fields are omitted.
  - Goal: a context-compressed agent recovers full identity by
    running `gojaja plan` once.

- **PR5 — task board.**
  - `state/task_board.yaml` schema with id, status, owner, priority,
    dependsOn, acceptance, createdAt, updatedAt.
  - `gojaja task new / assign / status / list / show`.
  - `plan` manifest now carries a `tasks` array filtered to
    `owner == role && status ∈ {Ready, InProgress, Blocked, Review}`,
    with `blockedBy` derived from dependsOn entries that are not Done.
  - New event types: `TASK_CREATED`, `TASK_ASSIGNED`,
    `TASK_STATUS_CHANGED`.

- **PR6 — RFC state machine.**
  - Per-RFC directory `rfcs/RFC-NNNN-<slug>/` with `proposal.yaml`,
    `comments/<role>.json`, and `decision.json`.
  - `gojaja rfc new / comment / decide / reject / list / show`.
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
  - `gojaja state edit --file <state/path>` (renamed from
    `gojaja write-state` in PR8f-C) writes atomically into the state
    subtree, gated by ownership; `SYSTEM` (no GOJAJA_SESSION) bypasses for
    human bootstrap.
  - `gojaja task new` / `task assign` require ownership of
    `state/task_board.yaml`. `task status` has a task-owner exception
    (a role may always update its own task's status).
  - New `ForbiddenError` class with stable exit code 9.

- **PR7a — prompt / activate split.**
  - `gojaja prompt` is now strictly role-free (`--target X [--write]`);
    a new `gojaja activate <role> --target X` prints the per-window
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
  - Default-injected into every `gojaja prompt --target X --write`
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
    `GOJAJA_SESSION` strict semantics, session lease + auto-heartbeat,
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
    `unset GOJAJA_SESSION` hint, `claim --eval` mode, handbook review
    handoff + role-neutrality regex guard. Suite 150 → 169.

- **PR8d — prompt UX gate + role delete.**
  - Runtime body opens with an "only when bound to a role" gate so an
    unactivated agent window does not reflexively run gojaja.
  - `prompt --write` prints a "restart any open agent windows" caveat
    on every successful write; JSON adds `requiresWindowRestart`.
  - "SKIPPED" renamed to "UNCHANGED (already up to date)"; new
    `--force-rewrite` flag overrides the byte-equal short-circuit.
  - New `gojaja role delete <id>` (SYSTEM-only): removes config /
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
    role markdown; `role list` annotates TBD rows; `gojaja
    activate` refuses while the role markdown still has TBD.
  - `activate` output rewritten: explicit `═══ BEGIN/END PASTE ═══`
    dividers, second-person `You are the ...` framing, three numbered
    steps (claim via --eval, role show, gojaja -h), auto-copy to
    clipboard via pbcopy / wl-copy / xclip / xsel / clip.exe with
    `--no-copy` escape hatch.
  - `gojaja -h` rewritten: intro paragraph + Quickstart + per-section
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
  - `gojaja init` seeds a TBD skeleton at `state/project_state.md`
    so the file always exists; the handbook nudges agents to ask the
    user to fill TBD sections before judging Done.
  - `gojaja write-state` (later renamed to `gojaja state edit` in
    PR8f-C) gains `--append` and `--replace`/`--with`/`--batch` modes
    alongside the existing `--content` (overwrite). Default replace
    refuses 0 or N>1 matches; `--batch` allows N>1. All modes still
    flow through ownership / mustNotEdit / path canonical-form gates
    and remain atomic.
  - Suite 198 -> 214.

- **PR8f-C — rename write-state, sync help, roleReminder hint.**
  - `gojaja write-state` renamed to `gojaja state edit` (hard
    cut; alpha-stage, no backward alias). Subcommand-group style now
    consistent with `task / role / rfc`.
  - `gojaja -h` rewrites the state-editing section to list all
    three modes with copy-pasteable invocations.
  - `manifest.roleReminder.protocol` adds a `gojaja role show
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
    Voters / non-pre-decider deciders use new `gojaja rfc ack` /
    `gojaja rfc object` verbs to register positions.
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

- **PR8q + PR8r — prompt artifact compression + path portability.**
  - PR8q: `runtimeLoopBody` and `COLLABORATION_HANDBOOK` rewritten
    for density. Cursor rule / CLAUDE.md marker block 520 → ~295
    lines (~44%). Tables collapse the three "when to use X"
    (worklog / report / RFC) parallel sections into one and the
    three escalation paths into one. All `(PR8x)` version markers
    removed. Rationale paragraphs moved to docs/HANDBOOK.md; the
    prompt cites the long-form doc. Handbook size budget tightened
    20 KB → 12 KB.
  - PR8r: removed the absolute project-root path from the committed
    artifacts (`.cursor/rules/gojaja-runtime.mdc`, CLAUDE.md marker
    block). The path was baked in, which broke checkouts on a
    second machine or after moving the project. `runtimeLoopBody`
    now always renders the cwd-discovery message that Codex skill
    already used. Activation snippets keep the path — they're
    pasted per-window into chat and never committed.

- **PR8p — rename to gojaja (过家家).**
  - Project name: `multi-agent-coordination` → `gojaja`.
  - CLI binary `agentctl` → `gojaja`.
  - Layer directory `.multi-agent/` → `.gojaja/`.
  - Env vars `MA_SESSION` / `MA_PROJECT_ROOT` →
    `GOJAJA_SESSION` / `GOJAJA_PROJECT_ROOT`.
  - Runtime artifact names (Cursor rule file, Codex skill name,
    Claude marker block) → `gojaja-runtime`.
  - Error base class `AgentctlError` → `GojajaError`.
  - 过家家 is a Chinese phrase for kids' role-play family games;
    fits the multi-agent role-binding metaphor exactly.
  - BREAKING — every existing project must re-init. Alpha-stage, no
    users, hard cut. ~1150 token edits across 59 files; no semantic
    code changes.

- **PR8o — `gojaja reset` (project uninstall).**
  - Removes everything this tool wrote into a project: the
    `.gojaja/` layer, `.cursor/rules/gojaja-runtime.mdc`
    (plus empty parent dirs), and the
    `<!-- gojaja-runtime:BEGIN/END -->` block inside
    `<project>/CLAUDE.md` (preserves the rest; deletes CLAUDE.md only
    if the marker block was its only content).
  - `--purge-codex-skill` optionally removes
    `${CODEX_HOME:-~/.codex}/skills/gojaja-runtime/` (off by
    default; user-level skill is shared across projects).
  - Default invocation prints a preview; `--confirm <basename>` is
    required to actually delete (token = project root basename).
    `--dry-run` forces preview mode even with `--confirm` present.
    `GOJAJA_SESSION` must be unset (same posture as `role delete`).
  - Part of the original PR8 (installer & upgrade) bucket; the
    `gojaja upgrade` half stays planned.
  - Suite 302 -> 316.

- **PR8n — manifest event filter (token / attention budget).**
  - The events stream stayed broadcast-by-default but was firing every
    broadcast event into every agent's manifest. In a 6-role project
    that meant ~70 broadcast events / role / day, each one an LLM
    "should I react" turn. Broadcast-as-default was the wrong model.
  - `openOrCreatePlan` now projects the global event stream onto a
    per-role slice. Operational events (SESSION_*, LOCK_BROKEN,
    RFC_REPAIRED, ROLE_DELETED) never land in any manifest; RFC
    discussion events go only to participants; task-* events go only
    to stakeholders (owner, parent owner, dependants, task-board
    owners for `TASK_CREATED`); WORKLOG and RFC_DECIDED stay broadcast.
  - The cursor still advances past hidden events, so they do not
    re-appear on subsequent `plan` calls. The events themselves live
    forever in `comms/events/` for audit + `gojaja doctor` (PR9).
  - `gojaja wait --for attention` uses the same projection so wait
    only fires on events the manifest would carry.
  - `Store.filterVisibleEventsForRole` exposed on the interface for
    `wait` to reuse without duplicating logic.
  - Schema bumped to `2.0.0-manifest-filter`. Non-breaking in the
    on-disk sense (no shape change); manifest visibility narrows —
    agents see less, which is the entire point.
  - PR8k's "retarget `wait --for task-assigned` idle broadcast to
    `directReports`" is subsumed by this: when PR8k lands
    `directReports`, the idle worklog can be marked with a payload
    flag and the per-type filter will route it to that set instead
    of broadcasting.
  - Suite 294 -> 302.

### Planned, in priority order

- **PR8k — org-hierarchy ergonomics (planned).**
  - Reverse `directReports` computed field on `roleReminder` so a
    manager role knows "who reports to me" without scanning
    `role list`.
  - `gojaja wait --for task-assigned` retargets the idle worklog
    to `directReports` instead of `*` so the broadcast lands only on
    likely-task-assigners.
  - `gojaja report --to <a>,<b>` multi-target so a manager can
    address a team subset without N separate calls.
  - Role-level `decisionScopes` so RFC `--deciders` can be inferred
    from scope rather than spelled out each time (defended against
    scope-shopping via the audit log).
  - Goal: make 3+ layer organisations (CTO -> PM/TL -> workers)
    pleasant rather than noisy. Built on the PR8j parent + tag
    primitives.

- **PR8m — agent-delegated role creation (planned).**
  - Today `gojaja role create` has no ownership gate at all: any
    agent in any session can mint new roles with arbitrary `owns` /
    `mustNotEdit`. That bypasses the ownership model `requireOwnership`
    enforces elsewhere — `config.yaml` is unprotected on the create
    path even though every other write to it is gated.
  - Fix: thread an `actor: RoleId | "SYSTEM"` parameter through
    `Store.createRole` and the CLI's `runRoleCreate` (via
    `resolveActor`); refuse with `ForbiddenError` (exit 9) when the
    actor is a non-SYSTEM role without `config.yaml` in its `owns`.
  - Default behaviour unchanged: at init time no agent role owns
    `config.yaml`, so a user running `role create` in a shell with
    no `GOJAJA_SESSION` keeps minting roles via the SYSTEM bypass.
  - Delegation: a project that wants an HR / Admin agent to create
    roles grants that role `--owns 'config.yaml'`. The classic flow
    becomes:
      1. TL opens an RFC describing the gap + JD; deciders=[CTO].
      2. CTO accepts; opens a task assigned to HR with the JD as an
         asset and the new role id as a deliverable.
      3. HR runs `gojaja role create <id> ...` (allowed because HR
         owns `config.yaml`); reports the new role id back to TL.
      4. TL `gojaja task assign T-NNNN --to <new-role>`.
  - Asymmetric with `role delete` (which stays SYSTEM-only) by design:
    create is additive and recoverable, delete is destructive and
    one-way.
  - Surface: `createRole` interface gains `actor`; CLI passes it via
    `resolveActor`; ROADMAP / HANDBOOK / RFC.md gain the delegated-
    creation walkthrough. Non-breaking — only adds a gate, doesn't
    move any defaults.
  - Estimate: ~25 LOC code + ~80 LOC tests + ~120 LOC docs. Tracked
    separately from PR8k because it is a security model fix rather
    than ergonomic polish.

- **PR8h — schema-level deferments.**
  - Task `reviewers` field so a Review handoff can sign off without
    needing task-board ownership.
  - `STATE_UPDATED` event when `state/*` files change.
  - `dependsOn` cycle detection in task board.
  - Schema-version compatibility check on `gojaja plan`.
  - Harden `rfc new --description` from soft-warn (PR8g) to required.
  - Candidate: read-only `gojaja rfc audit <id>` to surface
    "who has ack'd / objected / not responded yet" without the
    agent reading `rfc show`.
  - Candidate: role-level `decisionScopes` so a role becomes a default
    RFC decider for matching scopes (currently `--deciders` is
    per-RFC ad-hoc). Promote if PR8g's handbook nudge proves
    insufficient.

- **PR8 — installer & upgrade.**
  - `gojaja upgrade` driving `src/migrations/<from>-<to>.ts`.
  - ~~`gojaja reset --confirm <project-name>` for destructive
    nukes.~~ Done in PR8o.
  - AGENTS.md bridge insertion with versioned marker block, re-written
    on every upgrade.

- **PR9 — operational tooling.**
  - `gojaja doctor`: JSON parse all records, validate cursor reachability,
    detect orphan manifests, surface stale locks.
  - `gojaja history --role <role> [--since <ulid>]`.
  - Event archival (`comms/events/_archive/YYYY-MM-DD/`) with a configurable
    retention floor.

- **PR10 — chaos / soak.**
  - Multi-process integration tests under `vitest`'s pool=forks running
    real concurrent claim/plan/ack cycles.
  - Random-kill harness asserting `gojaja doctor` stays green.

After PR10 we tag `v2.0.0`.

## v2.x — deferred but slot-reserved

- **HTTP transport.** `HttpStore` implementing the same `Store`
  interface; an `gojaja serve` mode that wraps a `LocalFsStore` behind
  a REST API. Authentication, TLS, and account model are out of scope
  for this layer — to be designed by the consuming team.
- **Heartbeat watcher.** `gojaja watch` daemon that downgrades stale
  sessions and emits `attention_required` events when an offline role
  has waiting inbox items.
- **Multi-machine safety review.** Verify rename / lock semantics under
  the storage backends people actually use (local disk, NFSv4, Dropbox,
  iCloud). Mark unsupported configurations explicitly.
- **Windows support.** Not an architectural change — the `Store`
  abstraction and one-file-per-record design are already
  Windows-friendly. This is an adapt-and-verify effort, not a rewrite.
  The bounded work is small; the time sink is shaking the test suite
  out on a real Windows CI.

  **Step 0 (do this before writing any code):** run the existing suite
  on a Windows runner as-is and catalogue what actually fails. Several
  items below may already pass; don't fix what isn't broken.

  Code changes, roughly in priority order:
  - [ ] **Atomic write robustness** (`src/core/atomic.ts`) — the
    load-bearing item. `write-tmp + rename` can hit intermittent
    `EPERM` / `EBUSY` on Windows when the destination is briefly held
    open by another process (antivirus, a concurrent reader). Add a
    short bounded retry-with-backoff around `fsp.rename` for those
    codes. (~½–1 day.)
  - [ ] **`claim --eval` shell variants** (`src/cli/commands/claim.ts`)
    — it currently emits bash `export GOJAJA_SESSION=...`, and the
    activation snippet uses `eval "$(...)"`; neither is valid in
    PowerShell or cmd. Offer per-shell output (PowerShell
    `$env:GOJAJA_SESSION=...`, cmd `set ...`). Largely de-risked already
    by the `--session <id>` flag, so this is UX polish, not a blocker.
    (~½ day.)
  - [ ] **File-lock verification** (`src/core/file-lock.ts`) — O_EXCL,
    the `link(2)` conditional takeover, and `process.kill(pid, 0)`
    liveness should all work on NTFS, but confirm behaviour (especially
    the rename-aside / link-back dance) on Windows. Likely zero code
    change; mostly a test pass.
  - [ ] **Path handling sweep** — relative paths are stored POSIX
    (forward slash) and absolute paths use platform `path`; Node accepts
    `/` on Windows and `resolveInside`'s `..` guard still holds. Audit
    for any place that compares or splits on `/` assuming it equals the
    OS separator.
  - [ ] **Already handled, just confirm:** clipboard (`clip.exe`),
    `gojaja watch` browser open (`cmd /c start`), the `init` git probe
    (`execFile("git", ...)`), and the npm-generated `gojaja.cmd` bin
    shim.

  Gating:
  - [ ] **Windows CI green.** Add a Windows job to CI and get all tests
    passing there. This is where the unknowns live (temp-dir / newline /
    file-occupancy timing assumptions); budget ~2–4 days of shakeout.
  - [ ] Docs: drop the "macOS / Linux only" caveats in README (EN +
    zh-CN) and DESIGN once CI is green; add any Windows-specific notes.

  Rough total once Step 0 is done: ~1 week for a tested port, the CI
  shakeout being the main variable. A "works on my machine, no
  guarantees" local run is mostly possible today; the only real risk
  there is the unretried `rename` above.
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
covers wide-open brainstorm sessions (no concrete choices yet). PR8n
splits "audit log" and "agent manifest" so broadcast events no longer
flood every role's per-turn attention.
The "breaking" alpha-stage surface changes are PR8f-C
(`write-state` → `state edit`), PR8g (comments file shape),
PR8g.1 (pre-decide field/status removed), PR8i (wait flags +
`.wait` sentinel removed), and PR8j (task field additions, Done
deliverable gate). PR8l and PR8n are non-breaking on-disk (PR8n
narrows manifest visibility but does not change file shapes).
PR8o adds the user-facing "uninstall" / `gojaja reset` command that
removes everything this tool wrote into a project (the `.gojaja/`
layer + the Cursor rule + the Claude marker block, with an opt-in to
also purge the Codex user-level skill).
PR8h, PR8k, PR8m, and PR9–PR10 harden the layer for everyday use; PR8h
is the only remaining RFC-affecting PR
before `v2.0.0`. Anything past `v2.0.0` only ships after the chaos
suite (PR10) is green.
