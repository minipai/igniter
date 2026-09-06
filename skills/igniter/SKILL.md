---
name: igniter
description: Bootstrap for Igniter-managed repositories (they contain `.igniter/config.yaml`). Enter through the Igniter CLI, then let the Commander work order and bundled rules take over. Never use the legacy feature-delivery workflow here.
---

# Igniter

An Igniter-managed repository contains `.igniter/config.yaml` at its root.
There, Igniter owns the delivery workflow. This skill only opens the door;
it defines no stage protocol.

Do not use the legacy `feature-delivery` skill (or any manual
plan/branch/build/review flow) in an Igniter-managed repository. Igniter
replaces that workflow rather than running inside it.

## Enter

From the repository root:

- `igniter serve` starts the dispatch (Linear watch plus web UI).
- `igniter status` shows running tickets and free Build slots.
- `igniter start <ticket>` claims a Todo ticket and starts its Commander.

Workspace commands (`state`, `begin`, `submit`, `block`, `unblock`) run
inside the ticket's Herdr workspace only, and only the Commander runs them.
`igniter state --json` is always the first action of a run.

## Owner gates

- The owner moves Review + Complete to Deliver to approve delivery, or back
  to Build to request changes.
- The owner moves Deliver + Complete to Done only after the change has landed.

## Boundaries

After `igniter start`, the Commander work order and the bundled Commander
rules take over. The Commander owns the state machine, the worktree, the
stage workers, and every workspace command. Stage workers never run Igniter
commands, never call Linear directly or through MCP, and report only to the
Commander. Anything beyond this entry — stage order, reports, receipts,
evidence — comes from the work order, not from this skill.
