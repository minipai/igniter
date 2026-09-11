# Workflow operations

[Back to the README](../README.md). These commands are used by the Commander
to advance assigned tickets and supervise their workers.

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
allows `igniter approve ENG-123 --receipt <id>`, using the current receipt ID
from status, to move to Review + Pending. A PASS Review receipt similarly
permits Deliver + Pending; a valid completed Deliver receipt permits Done.
There is no `--to`: the completed stage determines the transition. Retrying
with the same receipt ID cannot approve a later stage. Ordinary sync or
continuation never grants approval. A correction Build returns automatically
to Review + Pending under the existing handoff rules.

## Linear records

Every machine-readable Linear lifecycle record — receipts, stage-start
(`begin`), owner approval, blocked, failed, and the incomplete-state
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
per-role identities, tabs, effective model, and confirmed initial work-order
delivery. It returns the role, model, worker identity, and result path. Use
`worker send`, `worker restart --model MODEL` (or `--profile fallback`),
`worker stop`, and `worker answer ... y|n` for worker operations. Use
`--role build|review|deliver` to select a worker when several roles exist.
`worker start` and `worker restart` require the current stage to be Pending or
In progress; a Todo ticket without a Progress label may also start Build.
`worker send`, `worker stop`, and `worker answer` can target an earlier role.
Worker commands may read ticket context but never write Linear.
A restart really replaces the selected worker and preserves existing work.

For an `In progress` ticket, `worker start` only reuses the expected live local
worker. If that worker is missing or ended, or Herdr cannot be reached, it
refuses without creating a workspace or worker. A ticket visible in Linear
may still be running on another machine; queue visibility is not assignment.
Use `igniter worker restart ENG-123` to explicitly rebuild a worker in an
existing local ticket workspace. Restart requires that workspace and reachable
Herdr; it does not recover another machine's workspace.

## Linear controls and cleanup

`block`/`unblock`, `fail`, and `reconcile` operate Linear without hidden worker
side effects. The Commander explicitly stops workers after handoffs and Done;
Done cleanup keeps dirty, untracked, or unmerged work and pre-existing user tabs.
An externally integrated Done still requires the Deliver report and explicit
worker cleanup. Receipt/checkpoint validation and Git safety continue to apply
at every handoff.

## Repository delivery rules

The [bundled Deliver prompt](../src/commander/stages/deliver.md) follows the
repository's configured landing procedure.

This repository's [Deliver prompt](../.igniter/workflow/deliver.md)
rebases onto remote `main`, pushes, opens a pull request, and watches required
checks through GitHub's native auto-merge. A rebase changing only the SHA keeps
the approval; a product change needed to fix CI returns to Build and acceptance.
