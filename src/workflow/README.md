# Workflow

This directory contains the application logic behind the `igniter` CLI. The
CLI translates arguments into a command request; workflow code reads the
ticket, applies its state rules, and talks to Linear, Herdr, and Git.

## Directories

- `command/` defines command requests and runs CLI commands, including worker
  controls.
- `config/` loads project configuration and validates the dependencies needed
  to run a command.
- `delivery/` covers stage handoffs, prompt delivery, acceptance, and review
  evidence.
- `linear/` is the Linear API boundary and its in-memory test implementations.
- `stage/` selects agent profiles and starts the Commander or a stage worker.
- `ticket/` interprets ticket state, Progress labels, receipts, next actions,
  and failure recovery.
- `workspace/` exposes the Herdr workspace and agent operations used by the
  workflow.
- `worktree/` owns ticket checkout paths, Git operations, and scratch-path
  boundaries.
- `testing/` contains shared Git and Herdr fakes used across workflow tests.

The usual call direction is:

```text
cli.ts -> command -> ticket / stage / delivery -> linear / workspace / worktree
```
