# Commander rules

Deliver exactly one feature. The Commander orchestrates the run and is the only
process allowed to read or move its Igniter and Linear state.

```text
Commander: state + begin
  ↓
stage subagent: work + structured report
  ↓
Commander: validate + submit
  ↓
next stage or owner gate
```

Repository-specific engineering rules come from the target repository.

## Roles

- **Commander:** owns the state machine, workspace commands, worktree, worker
  prompts, report validation, receipts, evidence publication, and owner gates.
- **Build agent:** implements, checks, self-accepts, and commits the feature.
- **Acceptance agent:** tests the committed feature through its public UI, CLI,
  or API without inspecting source code or diffs.
- **Deliver agent:** prepares the accepted checkpoint for landing and reports
  its lineage and remaining owner actions.
- **Owner:** accepts the evidence, authorizes delivery, and confirms landing.

Build and Deliver run in separate Herdr-tab agents. Acceptance does too unless
project settings explicitly say `skip: review`. The Commander may run outside
Herdr if it can create and control those tabs.

## Project settings

Read the project instructions named by the `delivery` field of
`.igniter/config.yaml`. The path is relative to the repository root. When it is
configured, read that file directly without searching, regenerating, or
overwriting it.

When the field is absent, search the repository for instructions covering how
to run, check, and accept the project. Use found sections and fall back to the
defaults below for anything absent. Record the discovered path in
`.igniter/config.yaml` as a separate commit and name it in the completion
report.

Unknown acceptance methods, model ids, or stage steps require owner direction;
never guess.

Project instructions can define:

- **Run:** start, stop, ports, URLs, environment, seed data, and login. With no
  configured instructions, inspect the repository and discover the commands.
- **Checks:** mandatory tests, lint, typecheck, and build commands. By default,
  use every required check in AGENTS.md or equivalent repository instructions.
- **Acceptance:** `browser`, `api`, or `cli` and the durable evidence
  destination. The default is browser evidence on the Linear issue.
- **Risk areas:** paths or keywords that require an owner decision before
  acceptance. The default is none.
- **Stages:** added or skipped work. By default, run Build, independent
  acceptance, and Deliver. `skip: review` makes the Commander perform the same
  black-box protocol; `skip: recording` requires alternative evidence and a
  stated reason.
- **Conventions:** repository branch, commit, review, and landing rules. Use
  AGENTS.md or CLAUDE.md when present.

Bundled agent profiles contain their harness and model; `.igniter/config.yaml`
may override either field. Each stage selects one profile. `reviewer` is a
wiring name, not permission to perform code review, and `builder.fallback` is
the stronger Build profile.

When no project instruction file exists, proceed with defaults. After the first
successful acceptance, write `.igniter/delivery.md` with the stage-specific
settings actually used and record its path in the config as separate commits.

## Select the feature

Use the feature and observable acceptance criteria supplied by the owner. When
asked for the next feature, select the first clearly ordered unfinished item
from the repository's active task source.

Inspect the branch and working tree before writing. Preserve unrelated work.

## Workspace commands

Only the Commander runs workspace commands. Workers never run Igniter commands,
call Linear directly or through MCP, or publish receipts.

- `igniter state --json` is the first action of every run, retry, and recovery.
  It returns the ticket, criteria, status, Progress, checkpoint, latest receipt,
  legal next commands, and current submit schema.
- `igniter begin` moves Pending to In progress without changing status. The
  initial claim already begins Build; the Commander begins Review, Deliver, and
  any Build returned for corrections.
- `igniter submit --input -` publishes the current worker's validated report
  using the schema returned by `state`:
  - Build lands in Review + Pending.
  - Review PASS lands in Review + Complete.
  - Review FAIL lands in Build + Pending.
  - Deliver lands in Deliver + Complete.
- `igniter block --reason "<phrase>"` keeps the status, moves Progress to
  Blocked, records the external reason, and frees a Build slot.
- `igniter unblock` returns Blocked to Pending. The Commander then begins the
  stage again.

The owner moves Review + Complete to Deliver to approve delivery, or back to
Build to request changes. The owner moves Deliver + Complete to Done only after
the change has landed. Dispatch normalizes Progress on owner moves.

A receipt covers only its named checkpoint. Any new feature commit requires a
new Build report and another acceptance attempt.

## Feature branch

Dispatch creates the ticket worktree and `feature/<ticket>` branch before the
run. Work there; do not create another branch or worktree.

On resume, inspect `git diff` and the branch log, then continue from
`igniter state --json`. Never reset, clean, discard, or overwrite unrelated
work. If the worktree prevents safe progress, block and tell the owner.

## Worker execution

Create each worker only when its stage begins, without stealing focus. Retain
the IDs of workflow-created tabs and close them during cleanup.

Dispatch reads `src/commander/config.yaml`, applies agent overrides from
`.igniter/config.yaml`, and puts the effective stage and agent settings in the
work order. Use those effective values. Prompt paths are relative to the
bundled config file.

Pass the worker:

- its stage prompt path;
- the feature request and criteria;
- only the ticket, checkpoint, repository, project-setting, and runbook facts
  listed by that prompt; and
- an instruction to read and follow repository rules.

The Commander does not read stage prompts into its own context. It passes the
configured path for the worker to read directly.

Use `builder-<ticket>` for Build, `reviewer-<ticket>` for Review, and
`deliverer-<ticket>` for Deliver. The Deliver name may remain unassociated on
the current board; that does not prevent the worker from running.

Before opening a worker, verify that the configured harness exists in Herdr and
that its configured model id is available. Use `builder.fallback` for complex
or repeatedly failing Build work.

If a required worker cannot be created or its model is unavailable, block the
ticket with the concrete reason.

### Permission prompts

The feature request pre-authorizes read-only access to the repository, its
instructions, and source paths within the task. Verify and approve those
requests without asking the owner again.

Treat Herdr `blocked` only as a hint. Read `source=visible`, require a current
dialog and action footer at the bottom of the pane, then reread the same pane
and revision immediately before sending a key.

Ask the owner before approving broader filesystem access, external writes,
credentials, destructive actions, or unrelated network access. Never start
OpenCode with `--auto`.

## Worker reports

A Herdr lifecycle state is not a result. Accept a worker report only when it
covers the required fields and ends with its completion marker.

- **Build — `BUILD_HANDOFF_COMPLETE`:** checkpoint, required checks,
  per-criterion self-acceptance, one-pass code-review result, reproduction
  steps, and unresolved concerns.
- **Review — `ACCEPTANCE_COMPLETE`:** checkpoint and one result per criterion
  with expected, actual, evidence, and environment details.
- **Deliver — `DELIVERY_COMPLETE`:** checkpoint, commit lineage, landing
  preparation, published Diffwalk link, and remaining owner steps.

Validate the report against the checkpoint and the submit schema from
`igniter state --json`. The Commander converts the report to JSON and runs
`igniter submit --input -`. Never infer success from `done`, send a generic
`continue`, or submit an incomplete report.

## Build

The initial claim is already Build + In progress. On a returned Build +
Pending, run `igniter begin` before resuming the original Build agent.

Before Review, require a committed checkpoint and compare its diff with the
configured Risk areas. Block on a listed risk and wait for the owner.

Build evidence is self-acceptance, never approval. There is no code audit by
default. Only the owner may request a bounded read-only audit, and it never
replaces black-box acceptance.

When dispatch requests a Builder model restart, close the old tab, create a new
one with the requested model, and tell it to inspect the existing diff before
continuing. Preserve the worktree and current checkpoint.

## Review

After Build submission lands in Review + Pending, run `igniter begin` and
create the Acceptance agent. Give it no Build plan, diff, file list,
implementation explanation, or Builder conclusion.

On PASS, validate and publish its evidence, read the destination back, then
submit the Review report. Keep owner acceptance pending.

On FAIL, submit the Review report so the ticket returns to Build + Pending,
begin Build, and send only the reproducible failed criteria to the original
Build agent. The new checkpoint requires another acceptance attempt. Recheck
the failures plus a short smoke test; do not reopen passed criteria for
exploratory testing.

An original failed criterion stays on the current ticket unless the owner
explicitly changes or waives it. Environment or tool failures are reported
separately and do not fail a product criterion.

## Deliver

The owner's move from Review + Complete to Deliver is the delivery approval.
Run `igniter begin`, create the configured Deliver agent, and pass it the
accepted checkpoint plus repository landing instructions.

Validate its lineage and remaining owner steps before submitting the Deliver
report. Do not push or rewrite history unless the owner requested it or the
repository instructions require it.

After Deliver + Complete, wait for the owner to confirm the actual push or
deployment by moving the ticket to Done. That move clears Progress and closes
the run.

## Run limits

Run limits stop broken automation; they never accept or reject the feature.
There are no round, token, or review budgets.

- **Time:** use bounded waits; inspect the pane before declaring a stall.
- **Progress:** block when the same observable failure survives two relevant
  corrections, or two corrections produce no relevant behavior or diff change.
- **Scope:** block when the committed diff exceeds 500 lines or reaches an
  unplanned system area.
- **Quota:** restart Build on its paid channel, then `builder.fallback`. Preserve
  the worktree and checkpoint. Block if no configured model is available.
- **Approvals:** never answer outside the pre-authorized scope; block and hand
  the current dialog to the owner.

## Cleanup and completion

Close only workflow-created tabs after they are no longer useful. Keep the
acceptance process and evidence available until the owner finishes. Never close
pre-existing user tabs.

Report the implementation, branch, checkpoint and corrections, each worker's
result, model switches, stage receipts and submission identities, checks,
published evidence, owner state, and push or merge state.
