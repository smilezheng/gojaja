# v3.0.0 Release Plan

> Status: **In progress** (PR8u, PR9.0, PR9.1 done; A → H pending)
> Last updated: 2026-06-03
> Cross-references: [RFC-0001](./RFC-0001-central-root.md),
> [ROADMAP](./ROADMAP.md), [CHANGELOG](../CHANGELOG.md),
> [postmortem-2026-06-02-shell-eval.md](../postmortem-2026-06-02-shell-eval.md)

This document is the **coarse-grained plan** for cutting `gojaja@3.0.0`.
Detailed per-milestone task lists live in `TodoWrite` (the agent's
in-session todo list) and are injected fresh at the start of each
milestone — that way mid-flight discoveries don't strand stale
sub-tasks. This file only tracks:

- the list of milestones,
- their scope summary,
- which key decisions were made (so contributors don't re-debate
  settled questions),
- the progress log at the bottom (append-only).

## Milestones

Ordering rationale: SYSTEM hardening lands FIRST because it changes
the `actor` contract every downstream PR touches. Doing it last would
mean every PR9.x command re-introduces the implicit-SYSTEM hole that
we'd then have to revisit.

| # | Milestone | Scope summary | LOC + tests | Sessions | Status |
|---|---|---|---|---|---|
| A | **SYSTEM-1: `--as-system` flag** | Reject implicit "GOJAJA_SESSION unset → SYSTEM" actor default. Every command that today calls `resolveActor` requires either a session OR explicit `--as-system`. Cascade update to ~30 test fixtures. | ~150 + 30 fixture diffs | 0.5–1 | **done** |
| B | **SYSTEM-2: forensic metadata** | SYSTEM events gain `pid`, `ppid`, `tty`, `cwd`, `hostname`, `user` fields via `Event.actorMeta?`. Post-hoc audit can identify the originating process. Role events deliberately omit (their trace lives in the session record). | ~80 + tests | 0.3 | **done** |
| C | **SYSTEM-3: role create / delete gate** | `role create` becomes ownership-gated (owner of `config.yaml` OR `--as-system`). `role delete` migrates from "GOJAJA_SESSION must be unset" to "owner of `config.yaml` session". PR8m baked in. | ~100 + tests | 0.5 | pending |
| D | **PR9.2: `gojaja init` writes v3 shape** | Mint ULID; write `<project>/.gojaja/project.json`; create `~/.gojaja/projects/<ulid>/`; construct split-mode `LocalFsStore`; `SCHEMA_VERSION → 3.0.0`. `discoverProjectRoot` reads `project.json` first, falls back to `VERSION` for v2 detection. | ~250 + tests | 1 | pending |
| E | **PR9.3: `gojaja migrate` v2 → v3** | One-shot walker. `--dry-run` (default), `--execute`, `--cleanup`. Idempotent. Preserves event ULIDs. Without `--cleanup`, leaves v2 files in place as a safety net. | ~250 + tests | 1 | pending |
| F | **PR9.6: `gojaja reset` adapts to two trees** | Removes user tree; moves central tree to `~/.gojaja/trash/<id>-<ts>/` (TTL 7d soft-delete). `gojaja reset --purge` skips trash. | ~150 + tests | 0.5 | pending |
| G | **PR9.7: docs sweep** | SCHEMA / DESIGN / AGENTS / README / HANDBOOK / `src/cli/prompts/*` rewritten for v3. CHANGELOG gains migration cookbook. `gojaja help` and per-command `-h` synced. | ~500 docs diff | 1 | pending |
| H | **v3.0.0 cut** | `package.json` 1.x → 3.0.0; `CHANGELOG[3.0.0]` top section; final typecheck/test/lint; `npm publish --dry-run`. | ~50 diff | 0.3 | pending |

**Total**: ~1300 LOC + ~200 tests + ~500 docs ≈ 5–6 sessions to
`v3.0.0-rc`.

## Already done (not in this table)

- **PR8u** — safe multi-line input for body flags (`--message` /
  `--rationale` / `--description`). Closes shell-eval bug class.
- **PR9.0** — RFC-0001 (central root) frozen as canonical design.
- **PR9.1** — split-mode path routing in `LocalFsStore` (`classifyPath`
  + optional `centralRoot`). 32 new vitest cases; suite 444 → 476.

## Out of scope for v3.0.0 (deferred)

These were considered and explicitly postponed to keep the v3.0.0
launch window tight. None block initial release.

- **PR9.4** — `gojaja project show / list / link / unlink / rename`.
  Ergonomic CLI surface; without it users use `ls ~/.gojaja/projects/`
  and edit `project.json` by hand. Scheduled for v3.0.1.
- **PR9.5** — `gojaja backup --out <tarball>` / `restore`. Important
  for disk-loss recovery but not blocking. Scheduled for v3.0.1 /
  v3.1.0.
- **OWNER first-class role**. Replacing SYSTEM with a real "OWNER"
  role that the human user claims is the principled fix to the
  forgery class, but it's a structural rewrite of `resolveActor` and
  all SYSTEM call sites. Scheduled for v3.1.0. v3.0.0 ships with
  SYSTEM kept but locked behind `--as-system` (milestones A–C).
- **PR8k** — org-hierarchy ergonomics (`directReports`,
  multi-target `report`, `decisionScopes`). Polish.
- **PR8v** — host stop-hook integration (`Stop` hook for Cursor /
  Claude / Codex). Soft mitigation, not v3-shaped.

## Key decisions (working assumptions)

These shape the milestones below. Flip any of them by editing this
file + appending to the progress log; downstream milestones will
adjust their sub-todos accordingly.

| # | Decision | Working assumption | Rationale |
|---|---|---|---|
| K1 | SYSTEM gating mechanism | **Explicit `--as-system` flag required.** No TTY-based y/N prompt fallback. | Agent processes are the threat model; agents in interactive contexts can answer TTY prompts too, so y/N is not a real defence. A flag makes intent grep-able in audit history. |
| K2 | OWNER role in v3.0.0 | **No.** Keep SYSTEM concept; add `--as-system` gate. Real OWNER role lands in v3.1.0. | OWNER is a structural change touching ~40 call sites and breaks every existing test fixture. Out of v3.0.0 scope. SYSTEM behind a flag is the pragmatic step-1. |
| K3 | `gojaja migrate` rollback support | **No `--rollback` command.** Without `--cleanup`, v2 in-tree files are left intact and the migration is naturally reversible by deleting `<project>/.gojaja/project.json` + `~/.gojaja/projects/<ulid>/`. | v2 is alpha-stage with no production users; the "don't delete until proven good" workflow is sufficient. Adding a real rollback doubles PR9.3's scope. |
| K4 | Two-tree mkdir behaviour in `init` | **`gojaja init` creates `~/.gojaja/projects/<ulid>/` greedily.** If the path exists with a different schema, refuse with a clear error. | Lazy creation on first central-tree write would surprise users with `ENOENT` errors mid-claim. Greedy creation also gives `gojaja backup` something to point at from day 1. |
| K5 | `discoverProjectRoot` v2/v3 detection | **Prefer `project.json` (v3) marker; fall back to `VERSION` (v2) and surface a migrate hint.** | v3 projects always have both files; v2 projects only have VERSION. The presence of `project.json` is the unambiguous v3 signal. |
| K6 | Migration ULID source | **Fresh ULID generated at migrate time**, not derived from anything in the v2 layout. | Deriving from git remote URL or cwd path couples identity to mutable inputs (RFC-0001 Q1's rejected paths). Fresh ULID matches the K1 of RFC-0001. |

## Workflow

1. Before starting a milestone, the agent reads this file + the
   current state of the codebase, then injects a TodoWrite list
   detailed enough to execute the milestone.
2. While executing, only the TodoWrite list is updated. This file
   stays as-is.
3. On milestone completion, the agent:
   - flips the milestone's `Status` column to `done` in the table
     above,
   - appends an entry to the progress log,
   - if new information requires re-scoping later milestones,
     edits this file (only the relevant rows) BEFORE starting the
     next one.
4. If a milestone is abandoned or split, this file is updated
   (rows reflow); progress log records why.

## Progress log

Append-only. One line per milestone transition.

- 2026-06-03 — Plan v0 drafted. Milestones A–H defined; K1–K6
  recorded with working assumptions. PR8u, PR9.0, PR9.1 already
  shipped.
- 2026-06-03 — Milestone A (SYSTEM-1) done. `resolveActor` now
  requires `{ allowSystemBypass: true }`; 5 CLI commands forward
  the new `--as-system` flag. 12 new gate tests +
  `tests/identity.test.ts` rewritten to the new contract. Three
  pre-existing fixtures (state-edit, next-hint × 2) opted into
  `as-system: true` where they previously relied on implicit
  SYSTEM. 476 → 490 tests, all green; typecheck + lint clean.
  Help / HANDBOOK / CHANGELOG updated. Embedded handbook prompt
  unchanged (budget). Next: B (SYSTEM-2 forensic metadata).
- 2026-06-03 — Milestone B (SYSTEM-2) done. New `SystemActorMeta`
  type + `Event.actorMeta?` field. New `gatherSystemMeta()` helper
  collects pid/ppid/cwd/hostname/user/tty. Store interface +
  `LocalFsStore` impl thread `actorMeta?` through 7 event-emit
  paths (report / task ×3 / rfc ×2 / deleteRole). `attachActorMeta`
  helper guarantees role events never carry the field even if a
  caller passes one. 9 new tests in `tests/system-meta.test.ts`;
  490 → 499. typecheck + lint clean. Next: C (SYSTEM-3 role
  create/delete ownership gate).
