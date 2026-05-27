# AGENTS.md

This repository is the source for the `multi-agent-coordination` package
itself, **not** a project that consumes it. The `.multi-agent/` runtime
layer is only created when an end-user runs `agentctl init` inside their
own project.

When you (Cursor / Codex / Claude Code / another agent) work in this repo:

- Treat `src/` as authoritative implementation.
- Treat `tests/` as the regression contract; never weaken a test to make
  code pass.
- The on-disk schema version lives in `src/cli/runtime.ts` as `SCHEMA_VERSION`.
  Bump it together with any breaking change to the layout written by
  `LocalFsStore.initialise`.
- Do not reintroduce v0.1's bash scripts or `.multi-agent` symlink. They were
  removed deliberately.
