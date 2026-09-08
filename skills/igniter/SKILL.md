---
name: igniter
description: Bootstrap for Igniter-managed repositories (they contain `.igniter/config.yaml`). Enter through the Igniter CLI to start the singleton Global Commander, then let the stage work orders and bundled rules take over. Never use the legacy feature-delivery workflow here.
---

# Igniter

An Igniter-managed repository contains `.igniter/config.yaml` at its root.
There, Igniter serves ticket-targeted commands to its single project-level
Global Commander. This skill only opens the door; it defines no stage
protocol.

Do not use the legacy `feature-delivery` skill (or any manual
plan/branch/build/review flow) in an Igniter-managed repository. Igniter
replaces that workflow rather than running inside it.

## Enter

From the project workspace (never inside a ticket workspace):

- `igniter serve` starts the command service (no Linear watch).
- `igniter start` starts or resumes the one Global Commander singleton.
- `igniter start <ticket>` assigns a ticket to that same singleton;
  repeated calls and different tickets always reuse the one Commander.
- `igniter status --json` patrols the queue and active tickets.
- `igniter status <ticket> --json` reads one ticket: criteria, status,
  Progress, checkpoint, receipt, legal next steps, submit schema.
- `igniter begin <ticket>` launches the ticket's current stage worker
  (Build, Acceptance, or Deliver, derived from Linear).
- `igniter submit <ticket> --input -`, `igniter block <ticket> --reason`,
  `igniter unblock <ticket>`, and `igniter reconcile <ticket>` move the
  ticket. All take an explicit ticket; none needs a Herdr workspace id.

`igniter start` is Commander lifecycle and assignment; `igniter begin`
is stage-worker lifecycle. `igniter status <ticket> --json` is always the
Commander's first action on a ticket.

## Owner gates

- The owner moves Review + Complete to Deliver to approve delivery, or back
  to Build to request changes.
- The owner moves Deliver + Complete to Done only after the change has landed.

## Boundaries

After `igniter start`, the singleton Commander's work order and the bundled
Commander rules take over. The Global Commander owns every run, the
worktrees, the stage workers, and every ticket command. Stage workers never
run Igniter commands, never call Linear directly or through MCP, never
publish receipts, and report only to the Global Commander. Anything beyond
this entry — stage order, reports, receipts, evidence — comes from the work
order and the bundled Global Commander instructions, not from this skill.
