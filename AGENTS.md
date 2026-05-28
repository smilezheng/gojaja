# AGENTS.md

Working notes for any agent (or human) editing this repository.

This repository **builds** the `gojaja` package; it is
not a project that consumes it. The `.gojaja/` runtime layer is
only created when an end-user runs `gojaja init` inside their own
project. Do not commit a `.gojaja/` directory at the repo root.

## Where to look first

| You want to ... | Read ... |
| --- | --- |
| Understand the architecture | [docs/DESIGN.md](./docs/DESIGN.md) |
| Know what file lives where on disk | [docs/SCHEMA.md](./docs/SCHEMA.md) |
| Implement an agent that talks to the layer | [docs/PROTOCOL.md](./docs/PROTOCOL.md) |
| Pick the next PR to land | [docs/ROADMAP.md](./docs/ROADMAP.md) |
| See what just shipped | [CHANGELOG.md](./CHANGELOG.md) |

## Working rules

- `src/` is authoritative implementation. `tests/` is the regression
  contract; never weaken a test to make code pass.
- All filesystem access in command code must go through the `Store`
  interface (`src/core/store.ts`). Direct `fs.*` usage is allowed only
  inside `src/core/*.ts` adapters and inside tests.
- Path / role-id / slug inputs must be validated by the helpers in
  `src/core/paths.ts` and `src/core/role-id.ts`. No ad-hoc regexes in
  command code.
- The on-disk schema version is `SCHEMA_VERSION` in
  `src/cli/runtime.ts`. Bump it together with any breaking change to
  the layout written by `LocalFsStore.initialise`, and update
  [docs/SCHEMA.md](./docs/SCHEMA.md) in the same PR.
- Every typed error class has a stable exit code (see
  [docs/DESIGN.md → Errors](./docs/DESIGN.md#errors-and-exit-codes)).
  Do not invent new ad-hoc `process.exit(7)` calls; subclass
  `GojajaError` instead.

## Build / test / typecheck

```bash
npm install
npm run typecheck      # tsc --noEmit
npm run build          # emit dist/
npm test               # vitest run
```

## What not to do

- Do not reintroduce v0.1's bash scripts, `templates/multi-agent/`,
  `skills/`, or the `.gojaja → templates/multi-agent` symlink.
  They were removed deliberately in PR1.
- Do not append to a shared log file as an alternative to the
  per-record event scheme; the corruption modes that motivated the
  rewrite live there.
- Do not let user/agent input reach `path.join` without going through
  `resolveInside`. Path-traversal is a silent class of bug.
- Do not add a global mutex back. Per-resource locks are the contract.

## Project conventions

- TypeScript strict mode; `noUnusedLocals`, `noUnusedParameters`,
  `noImplicitReturns` are on.
- No emojis in code or commit messages.
- Commit messages: imperative mood, no Conventional Commits prefixes.
  Reference the PR number in the subject when applicable (e.g.
  `v2 PR2: claim/plan/ack ...`).
- One concern per PR. PR1 is storage core; do not slip CLI command
  surfaces into PRs whose scope is "core".
