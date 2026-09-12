# Workflow operations

[Back to the README](../README.md). These commands are used by the Commander
to advance assigned tickets and supervise their workers.

## Project runbooks

Stage protocol prompts are bundled with Igniter and cannot be replaced. Add
optional project runbooks to `.igniter/config.yaml` for local run commands,
checks, the acceptance environment, and delivery procedures:

```yaml
runbooks:
  build: .igniter/workflow/build.md
  acceptance: .igniter/workflow/acceptance.md
  deliver: .igniter/workflow/deliver.md
```

Each entry is optional. Paths are relative to the repository root, must point
to existing, non-empty files, and may not escape the repository. Runbooks
supplement the bundled protocol; the bundled protocol wins any conflict.

## Checking progress

Read ticket state and reports in Linear, or run these commands from the
project root in a second terminal while the Commander is running:

```bash
igniter status                   # Queue overview
igniter status ENG-123 --json     # Ticket state
```

For interrupted work, see [worker recovery](#worker-operations-and-recovery).

## Starting a stage

Linear transitions and worker execution are separate commands. The Commander
reads `igniter status ENG-123 --json`, runs `igniter worker start ENG-123`,
confirms the initial work order was delivered, then records the stage start
with `igniter begin ENG-123`. Begin only validates and records Linear state;
it never starts a worker or sends a prompt.

## Reports and approval

Workers write `submit.json` in their own scratch using the submit shape embedded
in their work order from the canonical contract. Their sibling `result.md`
contains the completion marker and only additional findings or risks. The
Commander reviews both files, checks the checkpoint and evidence, and submits
the JSON unchanged with
`igniter submit ENG-123 --input - < "/absolute/scratch/submit.json"`.
Missing, unfinished, malformed, or stale artifacts return to the same worker
for correction; a valid schema never substitutes for content review. The first Build
waits at Build + Complete for your approval. Your explicit approval
allows `igniter approve ENG-123 <id>`, using the current receipt ID
from status, to move to Acceptance + Pending. A PASS Acceptance receipt similarly
permits Deliver + Pending; a valid completed Deliver receipt permits Done.
There is no `--to`: the completed stage determines the transition. Retrying
with the same receipt ID cannot approve a later stage. Ordinary sync or
continuation never grants approval. A correction Build returns automatically
to Acceptance + Pending under the existing handoff rules.

## Linear records

Every machine-readable Linear lifecycle record — receipts, stage-start
(`begin`), owner approval, blocked, failed, canceled, and the incomplete-state
diagnosis — is a single visible, versioned `igniter_receipt` or
`igniter_event` YAML fenced block after a short human-readable summary line.
Dispatch never writes a hidden `<!-- igniter:... -->` HTML marker or inline
JSON comment anymore; a strict parser rejects an unknown version, an unknown
or duplicate field, a missing required field, or more than one block per
comment, and a rejection never authorizes a state transition. Comments from
before this contract still carry the old hidden markers; dispatch reads
those read-only so an in-progress ticket never loses its begin, approval, or
recovery boundary, but never writes that format again.

## Worker operations and recovery

After each approved transition, the Commander starts the next worker, confirms
delivery, and records begin. `worker start` owns worktree/scratch setup, stable
per-role identities, tabs, effective profile, and confirmed initial work-order
delivery. It returns the role, selected agent, merged harness/model/effort,
worker identity, and result path. Pass `--agent <name>` to select a named
candidate before the worker starts; without it a new run uses the stage default
and a retry keeps the run's recorded selection. Use
`worker send`, `worker restart --agent NAME` (or `--model MODEL`),
`worker stop`, and `worker answer ... y|n` for worker operations. Use
`--role build|acceptance|deliver` when targeting an earlier role or when several
workers exist. A restart without a new `--agent` keeps the run's recorded
selection.
`worker start` and `worker restart` require the current stage to be Pending or
In progress; a Todo ticket without a Progress label may also start Build.
`worker send`, `worker stop`, and `worker answer` can target an earlier role.
Worker commands may read ticket context but never write Linear.
A restart really replaces the selected worker and preserves existing work.

For an `In progress` ticket, `worker start` only reuses the expected live local
worker. If that worker is missing or ended, or Herdr cannot be reached, it
refuses without creating a workspace or worker. A ticket visible in Linear
may still be running on another machine; queue visibility is not assignment.
Starting a new Commander does not automatically adopt tickets from an earlier
session or another machine.
Use `igniter worker restart ENG-123` to explicitly rebuild a worker in an
existing local ticket workspace. Restart requires that workspace and reachable
Herdr; it does not recover another machine's workspace.

## Linear controls and cleanup

`block`/`unblock`, `fail`, `cancel`, and `reconcile` operate Linear without hidden worker
side effects. The Commander explicitly stops workers after handoffs and Done;
Done cleanup keeps dirty, untracked, or unmerged work and pre-existing user tabs.
An externally integrated Done still requires the Deliver report and explicit
worker cleanup. Receipt/checkpoint validation and Git safety continue to apply
at every handoff.

Only explicit owner authorization permits
`igniter cancel ENG-123 --reason "<reason>"`. It moves a non-terminal ticket
to Canceled, clears Progress labels while keeping unrelated ones, and records
the reason and source state in one versioned YAML cancellation event.
`fail` returns failed work to Backlog for replanning; `block` waits on an
external condition; `cancel` terminates the ticket by owner decision.

Canceling never stops or deletes workers, the worktree, the branch, or unmerged
content. Run `igniter worker stop ENG-123` explicitly afterward. Done tickets
are refused; an already-canceled retry reports `already canceled` without
writing a second event.

## Repository delivery rules

The [bundled Deliver prompt](../src/commander/stages/deliver.md) follows the
repository's configured landing procedure.

This repository configures [Build](../.igniter/workflow/build.md),
[Acceptance](../.igniter/workflow/acceptance.md), and
[Deliver](../.igniter/workflow/deliver.md) runbooks through the `runbooks` map in
[`.igniter/config.yaml`](../.igniter/config.yaml). Its Deliver runbook rebases
onto remote `main`, pushes, opens a pull request, and watches required
checks through GitHub's native auto-merge. A rebase changing only the SHA keeps
the approval; a product change needed to fix CI returns to Build and acceptance.

## Migrating older scripts

| Removed entry | Replacement |
| --- | --- |
| `igniter state --json` | `igniter status <ticket> --json` |
| Bare `begin`, `submit`, `block`, `unblock` with Herdr workspace context | The same command with an explicit `<ticket>`; keep `--input -` or `--reason TEXT` |
| Background Commander start | CLI `igniter start` in the calling terminal |
| `status --json` fields `lastPollAt` and per-ticket `commander` | Commands refresh state on demand; read the current stage `worker` field |
| Automatic owner-move recovery | `igniter reconcile <ticket>`, then explicit worker commands as needed |
