# RFC-0001 — Central root for runtime state

> Status: Draft (PR9.0)
> Author: CTO (gojaja maintainers)
> Trigger: internal 2026-06-02 shell-eval incident (state-file
>   merge clobbers, multi-worktree git interference; details in
>   maintainers' private postmortem)
> Targets: `gojaja` v3.0.0 (`schema: 3.0.0`)

Cross-references: [DESIGN](./DESIGN.md), [SCHEMA](./SCHEMA.md),
[ROADMAP](./ROADMAP.md), [HANDBOOK](./HANDBOOK.md).

This RFC proposes splitting the on-disk layout into **two trees**:

- a small, slow-changing, **git-tracked** layer at
  `<project>/.gojaja/` containing only the contracts a fresh clone
  needs (project id, role briefs, role-level ownership config,
  human-authored project state);
- a larger, machine-mutated, **per-user / per-machine** layer at
  `~/.gojaja/projects/<project-id>/` containing all the runtime
  artifacts that today live in-tree (task board, event stream,
  sessions, RFC threads, worklog, locks).

The split is a one-time breaking on-disk change (alpha-stage, no
external users) tracked in PR9.0 → PR9.7. It does not introduce new
features; it relocates existing ones to defeat a class of corruption
fundamentally caused by mixing mutable coordination state with
immutable version control.

## 1. Problem

The current layout writes everything to `<project>/.gojaja/` and
expects users to commit it. The postmortem documents five categories
of damage all rooted in this choice:

| Postmortem section | Failure |
|---|---|
| §8.2 | `git cherry-pick` with stale base silently rolls back unrelated work in `.gojaja/state/` |
| §8.3 | Multi-agent share-one-worktree pattern: `git checkout` is a global action that disrupts every other agent's view |
| §8.7 | `git merge` reports "Already up to date" while another agent's commit just moved main HEAD elsewhere |
| §8.10b | `.gojaja/state/task_board.yaml` repeatedly clobbered by stale-base merges; happened **3 times** in one sprint |
| §4 | (unrelated — shell-eval; fixed in PR8u) |

The common shape is: gojaja state is **multi-writer mutable runtime
data**, but git is **single-writer immutable version control**. Mixing
them means every `git merge` is a chance to silently overwrite live
state with a snapshot from minutes earlier. "Last merge wins" is not
the same as "latest reality wins", and the gap is where data dies.

Rule-based mitigation (postmortem §8.10b's "never `git add -A` when
state changes are present") is **strictly insufficient** — it relies
on every contributor remembering the rule, every time, including
under time pressure. The class needs a structural fix.

## 2. Proposal

### 2.1 Two-tree split

```
<project>/.gojaja/                            # git tracked, slow-changing
├── project.json                              # {"id":"<ulid>","name":"<slug>","schema":"3.0.0"}
├── config.yaml                               # roles + owns + mustNotEdit
├── roles/<role-id>.md                        # role briefs (human-authored)
└── state/
    └── project_state.md                      # project overview (human-authored)

~/.gojaja/                                    # per-user, per-machine, never in git
├── config.json                               # global gojaja preferences
├── projects/<project-id>/                    # one subdir per known project
│   ├── meta.json                             # link back to project root abspath, mtimes
│   ├── state/
│   │   └── task_board.yaml                   # MUTABLE runtime
│   ├── comms/
│   │   ├── events/<ulid>.json                # append-only event stream
│   │   ├── sessions/<sid>.json               # active session leases
│   │   ├── cursors/<role>/<resource>.json    # per-role read cursors
│   │   └── pending/<role>/wait.json          # wait resume tokens
│   ├── rfcs/
│   │   └── RFC-NNNN-<slug>/
│   │       ├── proposal.yaml
│   │       ├── comments.yaml
│   │       └── decision.json
│   ├── worklog/<role>/<ulid>.md
│   └── locks/<resource>.lock
└── trash/                                    # gojaja reset soft-delete TTL 7d
```

The split-line rule: **does a freshly-cloned project need this file
to function correctly, BEFORE the agent team starts running?**

- Yes → `<project>/.gojaja/` (in git).
  - `project.json` (else gojaja can't resolve project id from cwd).
  - `config.yaml` (else ownership gates can't be enforced).
  - `roles/<id>.md` (else `gojaja role show` is empty; agents lose
    their contract).
  - `state/project_state.md` (else "what is this project" is gone).
- No → `~/.gojaja/projects/<id>/` (never in git).

### 2.2 Project identification

A new file `<project>/.gojaja/project.json` carries a single ULID:

```json
{
  "id": "01JZ9X7T8K3MAB2N3P4Q5R6S",
  "name": "skills-host",
  "schema": "3.0.0"
}
```

The ULID is generated once at `gojaja init` time and never mutates
(except via an explicit `gojaja project rename` command, which
rewrites the same field). It travels with the source code (git
tracked) so every git worktree of the same repo maps to the same
`~/.gojaja/projects/<id>/`.

### 2.3 Multi-worktree behaviour

A direct consequence of (2.2): N git worktrees of the same project
**share one** `~/.gojaja/projects/<id>/`. This is the structural fix
to postmortem §8.3. Each worktree's `gojaja claim` consults the same
task board and event stream because they all resolve to the same id.
`git checkout` becomes per-worktree (which it always was at the git
layer) without affecting any other agent's view of the coordination
state.

The previously-discussed "ergonomic" PR8w (gojaja-tracked worktree
metadata, `gojaja worktree create`) is **no longer required** —
worktree isolation falls out of the central root automatically. PR8w
is descoped to optional polish (a hint in `roleReminder` saying
"this worktree is at `<path>`").

### 2.4 Multi-machine collaboration

**Out of scope for this RFC.** `~/.gojaja/projects/<id>/` is
per-machine. Two developers on two machines have two independent
event streams, two independent task boards. The historical promise
"task board is git-synced" is explicitly revoked.

Long-term, the deferred `HttpStore` / `gojaja serve` (v2.x roadmap)
provides multi-machine sync via a remote `Store` backend. That work
is unchanged and out of this RFC's scope.

Short-term mitigation for the "I changed machines, lost my task
board" risk: `gojaja backup --out <tarball>` / `gojaja restore` (see
2.7).

### 2.5 RFC archival

RFCs live entirely in `~/.gojaja/projects/<id>/rfcs/`. Decisions are
not auto-archived back into git. Trade-off accepted explicitly in
this RFC (Q4 in the design conversation): the operational simplicity
of a single source of truth outweighs the loss of "git log can show
me past decisions". Recovery routes:

- `gojaja backup` covers the catastrophic case (disk loss).
- Optional future: `gojaja rfc archive <id>` to manually copy a
  decided RFC's markdown summary into
  `<project>/.gojaja/rfcs-archive/RFC-NNNN-<slug>.md`. ~50 LOC if
  proven useful; left out of v3.0.0 to keep migration scope tight.

### 2.6 `Store` interface impact

The `Store` interface gains two helpers:

- `Store.userTreePath(rel)` — resolves to `<project>/.gojaja/<rel>`.
- `Store.centralPath(rel)` — resolves to `~/.gojaja/projects/<id>/<rel>`.

`LocalFsStore` is renamed (or wrapped) as `SplitStore` with:

- `userRoot`: absolute path to `<project>/.gojaja/`.
- `centralRoot`: absolute path to `~/.gojaja/projects/<id>/`.

Each existing `Store` method picks the right root by what it writes:

| Method | Root |
|---|---|
| `initialise` | both |
| `createRole`, `deleteRole`, `updateConfig` | user (writes `config.yaml` + `roles/<id>.md`) |
| `writeStateFile` (path `state/project_state.md`) | user |
| `writeStateFile` (path `state/task_board.yaml`) | central |
| `createTask`, `assignTask`, `setTaskStatus`, etc. | central |
| `createRfc`, `commentRfc`, `decideRfc`, etc. | central |
| `publishReport`, `publishWorklog` | central |
| `claimSession`, `releaseSession`, `heartbeat` | central |
| `appendEvent`, `readEventsAfter`, cursors | central |
| `withFileLock` | central (`locks/`) |

Path validation (`resolveInside`) gains a second root and refuses
paths that traverse outside either anchor.

### 2.7 New CLI surface

PR9 ships these new commands:

```
gojaja project show                   # current project id + paths
gojaja project list                   # all projects under ~/.gojaja/projects/
gojaja project link <id>              # bind cwd to an existing central-root project
gojaja project unlink                 # delete <project>/.gojaja/project.json (keeps central data)
gojaja project rename <new-name>      # only rewrites name; id is immutable

gojaja backup --out <tarball>         # snapshot ~/.gojaja/projects/<id>/
gojaja restore --in <tarball>         # inverse; refuses if id already exists
gojaja migrate                        # one-shot v2 → v3 layout walker
```

`gojaja reset` semantics change:

- Removes `<project>/.gojaja/` (4-5 files only — much smaller blast).
- Moves `~/.gojaja/projects/<id>/` into `~/.gojaja/trash/<id>-<ts>/`
  (TTL 7d soft-delete; `gojaja reset --purge` to bypass the trash).
- Codex / Cursor / Claude artifacts handling unchanged from PR8o.

### 2.8 Migration

`gojaja migrate` reads an existing `<project>/.gojaja/` (v2.x
layout), mints a new ULID, creates
`~/.gojaja/projects/<new-id>/` and walks every file into the right
target tree. Original `<project>/.gojaja/` is left intact until the
user opts to delete (`gojaja migrate --cleanup` removes the old
in-tree files that have been promoted to central). Idempotent.

Schema version: `SCHEMA_VERSION` bumps `2.0.0-* → 3.0.0`. The v2
`LocalFsStore` continues to work on existing on-disk layouts but
emits a deprecation warning pointing at `gojaja migrate`.

## 3. Trade-offs and explicit non-goals

### 3.1 Audit trail

**Loss**: `git log .gojaja/state/task_board.yaml` no longer shows
historical state changes. Past task status transitions are only
visible via `gojaja history` (PR9 / planned in PR9.5) reading
`comms/events/*.json` directly.

**Mitigation**: events are ULID-named, append-only, immutable files —
they are themselves an audit log, more rigorous than git's "diff of
mutating YAML" view. `gojaja history --role X --since <ulid>` is the
canonical replay primitive (planned PR9.5).

### 3.2 Cross-machine sync

**Loss**: developers on two machines get two independent task boards.
Was never really working in practice — postmortem §8.10b documents
how the "git-sync the state file" model failed — but explicit revocation
deserves a note.

**Mitigation**: `gojaja backup / restore` for opportunistic share,
`HttpStore` for the proper solution (v2.x deferred, unchanged scope).

### 3.3 Disk catastrophe

**Loss**: `rm -rf ~/.gojaja/projects/<id>/` is unrecoverable from the
project repo alone.

**Mitigation**: documented; `gojaja backup` is part of v3.0.0; future
`gojaja audit-snapshot` (off-roadmap candidate) could maintain a
detached `git` repo inside `~/.gojaja/projects/<id>/.audit/` as a
local-only redundancy.

## 4. Sequencing (PR9.0 → PR9.7)

| PR | Scope | LOC estimate |
|---|---|---|
| **PR9.0** | This RFC; ROADMAP entry; no code | docs only |
| **PR9.1** | `SplitStore` skeleton; `Store.userTreePath` / `centralPath` plumbing; routing per §2.6. Existing `LocalFsStore` retained alongside, gated on `schema: 2.0.0-*` for backward compatibility. | ~300 |
| **PR9.2** | `gojaja init` writes the new shape; `SCHEMA_VERSION` → `3.0.0`. New projects get the split; v2 projects refuse with migration hint. | ~200 |
| **PR9.3** | `gojaja migrate` one-shot walker. Idempotent; preserves event ULIDs. | ~250 |
| **PR9.4** | `gojaja project show / list / link / unlink / rename` subcommand group. | ~150 |
| **PR9.5** | `gojaja backup / restore` (tarball + json manifest with id binding); `gojaja history --since <ulid>` if not already shipped via PR9. | ~200 |
| **PR9.6** | `gojaja reset` updated for the two-tree shape (incl. `~/.gojaja/trash/` soft-delete). | ~120 |
| **PR9.7** | SCHEMA.md / DESIGN.md / AGENTS.md / README / HANDBOOK / prompts rewrite for v3 layout. Migration cookbook in CHANGELOG. | docs only |

PR9.0 lands first as a freeze of the design. PR9.1 → PR9.3 are the
critical path (everything depends on the routing being right). PR9.4
→ PR9.6 are CLI surfaces that can land in parallel after PR9.3.
PR9.7 (docs sweep) lands last as part of v3.0.0 cut.

## 5. Risks

- **`~/.gojaja/` collision with another tool.** Low — the name is
  unique-ish (the rename to `gojaja` in PR8p picked precisely so this
  would be safe). Out of scope to defend further.
- **macOS sandboxed `$HOME`.** Codex / Claude run with sandboxed
  filesystem in some configs; need to verify `os.homedir()` resolves
  to a writable path. Tested via existing CI fixtures + a Codex-on-
  macOS smoke run during PR9.2.
- **`migrate` data loss in the middle.** Mitigated by leaving the v2
  in-tree files in place until `--cleanup`; user can always re-run.
  Migration walker writes to a staging dir, atomically renames at
  the end.
- **Two projects mapped to the same id by accident.** `project.json`
  conflict at merge time. Documented escape: `gojaja project rename`
  + `git merge` resolution by picking one; `--force-rebind` on
  `gojaja project link` if the central tree needs to be reused.

## 6. Open questions

- **Q1 — RFC archival route**: this RFC defers it. Re-open if the
  "lost decision history" pain shows up in practice.
- **Q2 — `~/.gojaja/config.json` shape**: ship this as part of PR9.2
  with just `{schemaVersion: "3.0.0", defaults: {...}}`; flesh out as
  prefs accumulate.
- **Q3 — Test runner integration**: tests currently pass `--root
  <tmpdir>` to point at an isolated `.gojaja/`. With two trees, tests
  need `--user-root <tmpdir-a> --central-root <tmpdir-b>` or a
  single `--project-id <tmpdir>` that internally splits. PR9.1
  decides.

## 7. Approval gate

Per AGENTS.md, this RFC needs sign-off from:

- CTO (architecture invariant: ownership / atomicity / per-resource
  locks all preserved).
- gojaja maintainer (one-concern-per-PR scope discipline: PR9.0 is
  pure design freeze; PR9.1 onwards do the actual work).

Once accepted, PR9.1 begins immediately. v3.0.0 cuts after PR9.7
green on CI + a soak run.
