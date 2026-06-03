# Collaboration handbook

Cross-references: [DESIGN](./DESIGN.md), [PROTOCOL](./PROTOCOL.md),
[SCHEMA](./SCHEMA.md), [RFC](./RFC.md) (end-to-end walkthrough of the
RFC lifecycle).

[PROTOCOL.md](./PROTOCOL.md) is the **mechanism** layer: it tells the
agent how to talk to `gojaja` (which command, what arguments, what
events that produces). This document is the **policy** layer: it tells
the agent **when** to choose which tool.

The canonical text is exported from
[`src/cli/prompts/handbook.ts`](../src/cli/prompts/handbook.ts) as the
`COLLABORATION_HANDBOOK` constant, and is injected by default into
every host's persistent prompt area (`.cursor/rules/`,
`~/.codex/skills/gojaja-runtime/SKILL.md`,
`<project>/CLAUDE.md` marker block). Opt out per-call with
`gojaja prompt … --no-handbook`.

Role-neutrality is enforced at CI: `tests/handbook.test.ts` scans the
handbook for any `<Capital> should|must|will|may|...` pattern that
would name a role as actor. Hand edits that re-introduce role-coupled
phrasing fail the build.

## Why it exists

Without this layer, agents tend to default in two failure modes:

1. **Over-communicate.** A worklog after every test run, an RFC for
   every minor question, a report whenever the LLM feels uncertain.
   Channels become noisy, real signal is lost.
2. **Over-defer to humans.** The user becomes the load-bearing
   tiebreaker on every ambiguity. Defeats the point of the layer.

The handbook is mostly a sequence of concrete "do / do not" rules,
each with an observable trigger condition (a turn count, an exit code,
a specific field) so the agent can apply them without judgement calls.

## Authoring principles

When extending the handbook, keep these constraints:

- **Role-neutral.** Refer to `reportsTo`, `deciders`, `owns`, not
  hard-coded role names (PM, TL, ...). Different projects use
  different role taxonomies.
- **Concrete triggers.** "Stale for 3 turns" is better than
  "regularly". Triggers should be values the agent already sees in
  `manifest.roleReminder` / `manifest.tasks` / `manifest.rfcs`.
- **Mostly suppression.** LLMs over-communicate by default; the
  handbook's value is in saying "don't" more than "do".
- **Cite mechanism, never duplicate it.** If the protocol enforces
  something, link to `PROTOCOL.md` rather than restating it.
- **Stay under the size budget.** The handbook ships in every agent
  window's persistent prompt area; the test suite enforces
  `< 20 KB` of UTF-8.

## Scope: what is in vs out

In scope:

- When to worklog / report / open an RFC / decide an RFC.
- When to escalate upstream and to whom.
- When to bounce to the user (whitelist).
- Task lifecycle micro-rules (when to move to InProgress / Done).
- Disagreement handling (with assignments, with accepted RFCs, with
  other agents' reports).
- Crisis paths: build broken, test failure, FORBIDDEN exit code,
  stale manifest, idle.
- Wait verdicts (ATTENTION / CONDITION_MET / TIMEOUT — one blocking
  call, no token cost) and when to use `wait --for task-assigned` (the
  auto-broadcast that tells task-board owners "I am free, give me work").
- Deliverables as gates: file-kind deliverables refuse the `Done`
  transition until the path exists on disk. `--force-incomplete` is
  legitimate only when paired with an explicit waiver (worklog or
  report); otherwise produce the file.
- Brainstorm-mode RFC: open `rfc new` without `--options` for
  wide-open discussion; `rfc add-option` upgrades the RFC into a
  decision flow when the team is ready to pick. `decide` allows
  (and requires) `--option` only after the upgrade.
- Manifest is a per-role projection of the event stream.
  Operational events (sessions, locks, RFC repairs) and irrelevant
  RFC discussion / task transitions are hidden so the agent's
  per-turn attention stays on its own slice. The full audit log is
  always in `.gojaja/comms/events/`.

Out of scope:

- Project-specific norms (code style, release process). Those live in
  the project's own docs and the role markdown.
- LLM-vendor-specific instructions. Targets get those via their own
  persistent prompt area, not via this layer.
- Per-role behaviour. Generic rules use `reportsTo` and `owns` from
  the role's `config.yaml` entry instead.

## Body text safely (long form)

Any flag carrying a multi-line message body — `--message`,
`--rationale`, `--description` — pays the standard CLI shell-quoting
tax. zsh and bash both perform command substitution on backticks and
`$(...)` inside double quotes, so a literal Markdown fenced code
block in a `--message "..."` value executes the embedded commands.
See [postmortem-2026-06-02-shell-eval.md](../postmortem-2026-06-02-shell-eval.md)
for the resulting damage (state file truncation, force-pushed empty
branches, mis-advanced task statuses).

`gojaja` follows the `git commit` shape exactly. Per body flag,
three channels are accepted in this priority order:

1. **Inline** — `--flag <text>` with a literal string. Safe iff the
   string contains no backticks, no `$`, and you used single quotes
   (or escaped every `` ` `` and `$` under double quotes). Best for
   short one-liners.
2. **Explicit stdin** — `--flag -` OR bare `--flag` (boolean parse).
   gojaja reads `process.stdin` to EOF. Combine with a quoted heredoc
   to get full shell-eval immunity:

   ```bash
   gojaja report --to X --message - <<'EOF'
   any backticks ` and $ vars stay literal inside <<'EOF'.
   the closing 'EOF' MUST be single-quoted (or escaped) — bare
   <<EOF still expands ${} (though not backticks/$()).
   EOF
   ```

   Pipes have the same shape: `cat draft.md | gojaja ... --flag -`.
3. **Interactive editor** — flag absent AND stdin is a TTY AND
   `$EDITOR` / `$VISUAL` is set. gojaja writes a seeded temp file
   under `${TMPDIR}/gojaja-edit/`, spawns the editor with `stdio:
   inherit`, then reads the saved buffer back (lines starting with
   `#` are stripped, mirroring git). Save+quit sends; quit-without-
   save aborts with a clean USAGE. The temp file is deleted before
   the call returns.

Channels are **opt-in**, not auto-detected. A common subtle bug in
the older design was: "if `--flag` is absent and stdin is non-TTY,
slurp stdin." That works in heredoc / pipe environments but deadlocks
in CI/test runners that inherit a non-TTY stdin which never closes.
gojaja therefore requires an explicit `-` sentinel, a bare `--flag`,
or a TTY+EDITOR to read stdin. Absent flag in a non-TTY non-EDITOR
environment is a USAGE error pointing at the safe heredoc form.

For OPTIONAL multi-line fields (e.g. `rfc new --description`), the
same opt-in shape applies but absence returns "" (default) instead of
throwing. Never opens `$EDITOR` for optional fields — surprise editor
prompts on omitted optional flags are worse than implicit empties.

## SYSTEM bypass is now explicit (`--as-system`)

Before PR9, commands that accepted a `RoleId | "SYSTEM"` actor
(`report`, `task new` / `task assign`, `rfc new`, `rfc comment`,
`state edit`) defaulted to `actor=SYSTEM` whenever `GOJAJA_SESSION`
was unset. The intent was "the human owner running the CLI directly,
without claiming a role". The bug was: `GOJAJA_SESSION` is just an
environment variable. An agent process can `unset GOJAJA_SESSION` in
one shell line and instantly inherit SYSTEM authority — bypassing
every `owns` / `mustNotEdit` gate, mis-attributing actions as
"from the project owner" in the audit log, and side-stepping the
`role delete` "no session" guard.

PR9 SYSTEM-1 closes this. The new rules:

1. **GOJAJA_SESSION set** → actor = the role on that session.
   A stale/invalid token still throws a hard auth error; never a
   silent fall-through to SYSTEM.
2. **GOJAJA_SESSION unset AND `--as-system` passed** → actor =
   `SYSTEM`. The flag is the explicit human intent signal. The
   command proceeds and writes `from: SYSTEM` to the audit event.
3. **GOJAJA_SESSION unset AND `--as-system` NOT passed** → USAGE
   error with a hint pointing at both legitimate paths
   (`gojaja claim <role>` for agents, `--as-system` for the human).

A live session **always wins**: an agent that includes `--as-system`
"just in case" does NOT escalate past their own role's ownership
gate. The flag is consulted only when no session exists.

The flag is reserved for the human user performing bootstrap or
repair. If you're an agent reading this, you should never type
`--as-system` — claim a role and inherit `owns` from `config.yaml`.

This is **not** a complete fix. An agent that wants to escalate can
still type `--as-system` itself. The gate raises the bar from "any
agent at any time" to "an agent that intentionally types a
privileged flag", which (a) makes accidental escalation by an LLM
generating shell strings much less likely, (b) leaves an explicit
`--as-system` trail in audit history that a grep can find,
(c) catches "I forgot to claim a role" cases that would previously
silently bypass every ownership gate.

A more principled fix — a real `OWNER` first-class role that the
human user claims like any other agent — is on the roadmap for
v3.1.0. Until then, treat `--as-system` events with the same
skepticism you would any other unauthenticated input.
