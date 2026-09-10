# Workflow

This directory contains the application logic behind the `igniter` CLI. The
CLI translates arguments into a command request; workflow code reads the
ticket, applies its state rules, and talks to Linear, Herdr, and Git.

## Directories

- `command/` defines command requests and runs CLI commands, including worker
  controls. Its subdirectories contain the ticket rules, stage launches, and
  delivery handoffs used to fulfill those commands.
- `command/ticket/` interprets ticket state, Progress labels, receipts, next
  actions, and failure recovery.
- `command/stage/` selects agent profiles and starts the Commander or a stage
  worker.
- `command/delivery/` covers stage handoffs, prompt delivery, acceptance, and
  review evidence.
- `service/` contains the Linear, Herdr workspace, and Git worktree operations
  that commands use to affect external state.
- `service/linear/` is the Linear API boundary and its in-memory test
  implementations.
- `service/workspace/` exposes the Herdr workspace and agent operations used by
  the workflow.
- `service/worktree/` owns ticket checkout paths, Git operations, and
  scratch-path boundaries.
- `config/` loads project configuration and validates the dependencies needed
  to run a command.
- `testing/` contains shared Git and Herdr fakes used across workflow tests.

The usual call direction is:

```text
cli.ts -> command -> ticket / stage / delivery -> service
```
