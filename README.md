# multi-agent-coordination

> File-system coordination layer for collaborating LLM-agent windows
> (Codex / Claude Code / Cursor / generic shells).

**Status: v2.0.0-alpha.** This is the v2 rewrite branch. v0.1 was a bash
prototype that has been removed; there is no migration path. See
[CHANGELOG](./CHANGELOG.md) for what landed and
[docs/ROADMAP](./docs/ROADMAP.md) for what is coming.

## Why this exists

Multiple LLM-agent windows acting as different roles in the same project
need to share state — events, inboxes, decisions, RFCs — without a
central server. Doing that purely through a project-local directory is
attractive (git-diffable, works with any agent that can run a shell) but
has subtle traps: torn reads, lost messages, fake locks, log corruption.

This package provides one binary, `agentctl`, that mediates all access to
that shared directory and turns the traps into ordinary errors with
stable exit codes.

## Quick start (alpha)

```bash
npm install
npm run build
npm test                              # 19 vitest cases, ~1.3 s

./bin/agentctl --version
./bin/agentctl init --root /tmp/my-project
./bin/agentctl version --root /tmp/my-project --json
```

The full agent loop (`claim` → `plan` / process / `ack` → `wait` /
`release`) is not yet exposed by the CLI; only the storage primitives are
implemented. See [docs/ROADMAP](./docs/ROADMAP.md#planned-in-priority-order)
for the PR sequence.

## Documentation

| Document | Purpose |
| --- | --- |
| [docs/DESIGN.md](./docs/DESIGN.md) | Architecture, design rationale, error map, known limits. |
| [docs/SCHEMA.md](./docs/SCHEMA.md) | On-disk layout for the `.multi-agent/` directory. Source of truth for the schema version. |
| [docs/PROTOCOL.md](./docs/PROTOCOL.md) | The contract an agent sees: identities, plan/ack loop, RFCs, wait. |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | What is done, what is planned for v2.0.0 and v2.x. |
| [CHANGELOG.md](./CHANGELOG.md) | Release notes. |
| [AGENTS.md](./AGENTS.md) | Working notes for any agent (or human) editing this repository. |

## How it differs from the v0.1 prototype

If you are coming from the bash prototype, three changes matter most:

1. **Events are immutable per-record JSON files**, not a shared TSV.
   Multi-line and tab-bearing payloads round-trip losslessly; concurrent
   writers do not contend; there is no global `mkdir` lock.
2. **`ack` cannot skip past events that `plan` did not show you.** The
   manifest carries an explicit token; `ack --token` advances the cursor
   exactly to the manifest's snapshot point.
3. **Path inputs are whitelisted at the framework boundary.** Slugs and
   role ids cannot traverse out of the layer; `sed`-style substitution is
   gone.

See [docs/DESIGN.md](./docs/DESIGN.md) for the full reasoning.

## License

MIT.
