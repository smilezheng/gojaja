# multi-agent-coordination (v2.0 — work in progress)

Agent-agnostic file-system coordination layer for multi-LLM-agent collaboration.

This is the **v2 rewrite branch**. v0.1 (a bash-script prototype) has been
removed; nothing on this branch is backwards-compatible with it.

## Status

v2.0.0-alpha. Storage layer, locking, event stream, cursor, and session
primitives are implemented. The user-facing coordination commands (`claim`,
`plan`, `ack`, `report`, `worklog`, `rfc *`, `wait`, ...) land in upcoming PRs.

## Try the alpha locally

```bash
npm install
npm run build
npm test
./bin/agentctl --version
./bin/agentctl init --root /tmp/some-project
./bin/agentctl version --root /tmp/some-project --json
```

## Design

See `docs/DESIGN.md` (TBD) for the architectural notes. In short:

- One Node CLI talks to a `Store` abstraction; v1 implements it on the local
  filesystem, v2 will swap in an HTTP transport without command-layer changes.
- Events and inbox messages live as immutable per-record files named by ULID,
  not as appended TSV/JSONL — no escaping pitfalls, no torn reads.
- Per-resource file locks (with lease + PID liveness) replace the v0.1
  global `mkdir` lock.
- Cursor advancement requires an explicit ack token issued by `plan`, so an
  ack cannot accidentally skip past unseen events.
- RFCs collect opinions; a designated leader role writes the decision.
  There is no automatic tally.
- Lifecycle "wait" preserves the v0.1 idea of cheap token-free idle blocking
  but keeps it out of the ack/exit-code path.

## License

MIT.
