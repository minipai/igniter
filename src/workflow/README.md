# Workflow

This directory contains the application logic behind the `igniter` CLI. The
CLI translates arguments into a command request; workflow code reads the
ticket, applies its state rules, and talks to Linear, Herdr, and Git.

## Directories

- `command/` contains only command implementations. Each top-level command has
  one matching `.ts` file.
- `command/worker/` follows the public worker subcommand tree with one `.ts`
  file per operation.
- `lifecycle/ticket/` interprets ticket state, Progress labels, receipts, next
  actions, and failure recovery.
- `lifecycle/stage/` selects agent profiles and starts the Commander or a stage
  worker.
- `lifecycle/delivery/` covers stage handoffs, prompt delivery, acceptance, and
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
- `context.ts` defines the dependencies shared by command implementations.
- `request.ts` defines the typed command input accepted from the CLI.
- `run.ts` selects the requested command and reports worker command failures.
- `testing/` contains shared fakes and cross-command integration tests.

The usual call direction is:

```text
cli.ts -> run.ts -> command -> lifecycle -> service
```
