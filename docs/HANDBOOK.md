# Collaboration handbook

Cross-references: [DESIGN](./DESIGN.md), [PROTOCOL](./PROTOCOL.md),
[SCHEMA](./SCHEMA.md), [RFC](./RFC.md) (end-to-end walkthrough of the
RFC lifecycle).

[PROTOCOL.md](./PROTOCOL.md) is the **mechanism** layer: it tells the
agent how to talk to `agentctl` (which command, what arguments, what
events that produces). This document is the **policy** layer: it tells
the agent **when** to choose which tool.

The canonical text is exported from
[`src/cli/prompts/handbook.ts`](../src/cli/prompts/handbook.ts) as the
`COLLABORATION_HANDBOOK` constant, and is injected by default into
every host's persistent prompt area (`.cursor/rules/`,
`~/.codex/skills/multi-agent-runtime/SKILL.md`,
`<project>/CLAUDE.md` marker block). Opt out per-call with
`agentctl prompt … --no-handbook`.

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
  `< 18 KB` of UTF-8 (bumped over time as content grew; PR8j set the
  current ceiling after adding the deliverable-gate policy paragraph
  on top of PR8i's wait verdict table).

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
- Wait verdicts (ATTENTION / CONDITION_MET / RESUME / TIMEOUT) and
  when to use `wait --for task-assigned` (the auto-broadcast that
  tells task-board owners "I am free, give me work").
- Deliverables as gates: file-kind deliverables refuse the `Done`
  transition until the path exists on disk. `--force-incomplete` is
  legitimate only when paired with an explicit waiver (worklog or
  report); otherwise produce the file.

Out of scope:

- Project-specific norms (code style, release process). Those live in
  the project's own docs and the role markdown.
- LLM-vendor-specific instructions. Targets get those via their own
  persistent prompt area, not via this layer.
- Per-role behaviour. Generic rules use `reportsTo` and `owns` from
  the role's `config.yaml` entry instead.
