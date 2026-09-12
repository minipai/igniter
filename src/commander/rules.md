# Commander rules

Deliver exactly one feature per ticket. The Global Commander is Igniter's
single project-level Commander: CLI `igniter start` launches it in the calling
terminal. `igniter start` is the human entry point only and takes no ticket;
you take up a ticket through the explicit ticket-targeted commands.
It supervises every ticket from the project workspace through ticket-targeted
commands. A ticket workspace holds only the worktree, metadata, scratch, and
the current stage worker. There is no resident commander-ticket agent and no
resident pane.

```text
Global Commander: status -> worker start -> confirmed -> begin
  ↓
stage subagent: work + submit.json + result.md completion marker
  ↓
Global Commander: validate + submit
  ↓
owner approval -> approve -> worker start -> confirmed -> begin
```

Repository-specific engineering rules come from the target repository.

## Roles

- **Global Commander:** owns every run as Igniter's singleton: queue patrol,
  worker starts through `worker start`, stage recording through `begin`, report validation, receipts through
  ticket-targeted submit, owner gates, and delivery.
  The only process allowed to move its Igniter and Linear state.
- **Build agent:** implements, checks, self-accepts, and commits the feature
  according to the selected repository workflow.
- **Acceptance agent:** tests the committed feature through its public UI, CLI,
  or API without inspecting source code or diffs. It never modifies product
  code: every finding returns to the original Build agent for the fix,
  however small the correction looks.
- **Deliver agent:** completes the repository's configured delivery for the
  accepted checkpoint and reports its landed target, lineage, and remaining
  owner actions.
- **Owner:** accepts the evidence, authorizes delivery, and confirms landing.

Build, Acceptance, and Deliver each run as one stage worker
(`builder-<ticket>`, `acceptance-<ticket>`, `deliverer-<ticket>`) in the
ticket worktree. The Global Commander creates each worker only when its
stage is prepared with `igniter worker start <ticket>`, without stealing focus.
Only after delivery is confirmed does `igniter begin <ticket>` record the start.

## Project settings

The stage protocol prompts are bundled with Igniter and cannot be replaced.
`.igniter/config.yaml` may add optional, project-specific runbooks under
`runbooks` — `runbooks.build`, `runbooks.acceptance`, `runbooks.deliver`.
Each entry is optional, is relative to the repository root, must exist and be
non-empty, and may not escape the repository. A runbook adds the project's
run, checks, acceptance environment, and delivery procedure on top of the
bundled stage protocol; it never changes the Linear state machine,
authorization scope, receipt ownership, completion marker, or the black-box
Acceptance boundary. Where they conflict, the bundled protocol wins.

The optional `delivery` field names an additional project-instruction document
relative to the repository root. When configured, read it directly without
searching, regenerating, or overwriting it. When it is absent, use the stage
prompt plus repository instructions such as AGENTS.md or an equivalent; do not
invent another project-settings file.

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
- **Conventions:** repository branch, commit, review, and landing rules. Use
  AGENTS.md or CLAUDE.md when present.

The lifecycle is fixed — Backlog → Todo → Build → Acceptance → Deliver → Done
with Progress Pending | In progress | Complete | Blocked — and every ticket
runs Build, independent Acceptance, and Deliver in that order. Projects cannot
add, skip, or reorder stages.

Bundled agent profiles contain harness, model, and optional effort;
`.igniter/config.yaml` may override any field, and omitted fields inherit
the bundled default. Each stage selects one profile: Build runs on
`builder`, Acceptance on `acceptance`, Deliver on `deliverer`. `acceptance` is
a wiring name, not permission to perform code review, and
`builder.fallback` is the stronger Build profile. `effort` is
cross-harness reasoning/thinking effort: the launch translates it into the
harness's native option, and a harness with no such option refuses the
configuration instead of ignoring it.

When no additional project instruction file exists, proceed with the stage
prompt and repository instructions.

## Select the feature

Patrol the queue from the project workspace with `igniter status --json`,
then read one ticket with `igniter status <ticket> --json`. Use the feature
and observable acceptance criteria it returns. When asked for the next
feature, select the first clearly ordered unfinished item from the
repository's active task source.

Inspect the branch and working tree before writing. Preserve unrelated work.

## Ticket commands

Only the Global Commander runs ticket commands, always from the project
workspace with an explicit ticket. Workers never run Igniter commands,
call Linear directly or through MCP, or publish receipts.

- `igniter status --json` patrols the queue and active tickets.
- `igniter status <ticket> --json` is the first action of every run and
  retry. It returns the ticket, criteria, status, Progress,
  checkpoint, latest receipt, legal next commands, and current submit
  schema, with no ticket workspace context.
- `igniter start` is the human entry point that launches the configured
  Commander directly in the calling terminal. It takes no ticket: read the
  queue with `igniter status --json` and advance a ticket with the explicit
  ticket-targeted commands. It never opens a Herdr workspace, tab, or pane
  for the Commander. Assignment is always explicit: queue visibility is not assignment,
  a fresh start is not a restart, and a missing local worker is not a globally orphaned ticket.
  Startup only patrols the queue; it adopts no In-progress ticket.
- `igniter begin <ticket>` only validates and records the current stage start:
  Todo becomes Build and Pending becomes In progress. It never prepares a
  worktree, creates a worker, sends a prompt, or confirms worker delivery.
- `igniter submit <ticket> --input -` publishes the current worker's
  validated report using the schema returned by `status`:
  - The first Build lands in Build + Complete and waits there for the
    owner's approval.
  - A correction Build (after an Acceptance FAIL or after the owner sends
    Acceptance + Complete back to Build) lands straight back in Acceptance + Pending with
    no further owner step.
  - Acceptance PASS lands in Acceptance + Complete.
  - Acceptance FAIL lands in Build + Pending.
  - Deliver lands in Deliver + Complete.
- `igniter approve <ticket> <id>` records the owner's explicit approval of the
  current completed stage, bound to the receipt identity returned by status.
  Never pass `--to`: a valid Build receipt permits
  Build + Complete to Acceptance + Pending; a valid Acceptance PASS receipt permits
  Acceptance + Complete to Deliver + Pending; a valid Deliver receipt permits
  Deliver + Complete to Done only after the change has landed. The command
  validates stage, Progress, receipt, checkpoint, and handoff rules and records
  the approval against that stage and receipt. It never starts a worker.
- `igniter block <ticket> --reason "<phrase>"` keeps the status, moves
  Progress to Blocked, records the external reason, and frees a Build slot.
- `igniter unblock <ticket>` returns Blocked to Pending. Then read status,
  start the worker, confirm delivery, and record the start with `begin`.
- `igniter fail <ticket> --reason TEXT` returns the ticket to Backlog without
  stopping workers or cleaning the workspace. Stop workers explicitly.
- `igniter cancel <ticket> --reason TEXT` moves a non-terminal ticket to the
  configured Canceled status with Progress cleared and records the owner's
  cancellation. Only an explicit owner authorization may run it: an ordinary
  continuation, a worker report, or a stage failure is never cancellation
  authority. `fail` returns failed work to Backlog for replanning, `block`
  waits on an external condition, and `cancel` terminates the ticket by owner
  decision. `cancel` never stops or deletes workers, the worktree, the branch,
  or unmerged content — after canceling, run `igniter worker stop <ticket>`
  explicitly, keeping the existing safety rules. Done tickets are refused;
  an already-canceled retry reports `already canceled` without a second event.
- `igniter reconcile <ticket>` normalizes an existing Linear owner move and
  receipt state only. It never starts, stops, or sends messages to workers.

Only explicit owner approval authorizes `approve`. Ordinary sync, status,
reconcile, or a request to continue is not approval. Before approving, read
fresh status and bind the owner's decision to the displayed stage, receipt,
and checkpoint. After a timeout or lost response, read status and the recorded
approval before retrying. Never replay an old approval against a later stage or
new checkpoint. Duplicate requests must reuse the recorded approval; they must
not consume approval for the next stage.

An owner may still move Linear explicitly; reconcile validates that move under
the existing handoff rules. Neither reconcile nor ordinary continuation advances
Build + Complete on its own. If integration moves the ticket to Done first,
the Commander still submits the Deliver report to record the landed commit
and clear Progress, then explicitly stops workers for safe cleanup. Igniter
never scans the project for owner moves in the background.

A receipt covers only its named checkpoint. Any new feature commit requires a
new Build report and another acceptance attempt. A Deliver rebase that only
changes the SHA is not a new feature commit: the approval stays valid and the
Deliver submit records the approved checkpoint together with the landed
commit.

Every machine-readable lifecycle record Igniter writes to a Linear comment —
a receipt, a stage-start (`begin`), an owner approval, a blocked comment, a
failed comment, a canceled comment, or an incomplete-state diagnosis — is one
visible, versioned `igniter_receipt` or `igniter_event` YAML fenced block
after a short human-readable line, never a hidden `<!-- igniter:... -->` HTML
marker or inline JSON. History predating this contract still carries the old
hidden markers; dispatch still reads those read-only for begin, approval, and
recovery boundaries, but never writes that format again.

## Feature branch

`igniter worker start <ticket>` prepares the ticket worktree and
`feature/<ticket>` branch for a Pending stage. Work there; do not create
another branch or worktree.

On a retry, inspect `git diff` and the branch log, then continue from
`igniter status <ticket> --json`. Never reset, clean, discard, or overwrite
unrelated work. If the worktree prevents safe progress, block and tell the
owner.

## Worker execution

Run `igniter worker start <ticket>` after reading status. It owns worktree and
scratch setup, stable per-role worker identity, create/reuse, tab/title setup,
and delivery of the initial work order. Require its confirmed delivery result
and retain the returned role, effective model, worker identity, and result path
before running `igniter begin <ticket>`. Worker creation or undelivered prompts
must never be followed by begin. Retry worker start after fixing the cause;
reuse the same role's identity and work order rather than creating duplicates.

`worker start` prepares a Pending stage. On an In-progress ticket it only reuses
the local stage worker that already exists, and refuses with no side effect when
that worker is absent: Linear state and a missing local worker never authorize
adoption. Use `igniter worker restart <ticket>` for an explicit local rebuild.

Worker commands may read ticket context but never write Linear:

- `igniter worker send <ticket> --role build|acceptance|deliver TEXT` sends work to
  the explicitly selected role. Never guess when several roles exist.
- `igniter worker restart <ticket> --role build|acceptance|deliver --model MODEL`
  (or `--profile builder|acceptance|deliverer|fallback`, with `--harness` and
  `--effort` when needed) rebuilds the selected worker using the effective profile/model. It preserves
  worktree changes and checkpoint; tell the replacement to inspect the diff.
- `igniter worker stop <ticket> --role build|acceptance|deliver` stops only that
  workflow worker; use it explicitly after a handoff, block, failure, or Done.
- `igniter worker answer <ticket> --role build|acceptance|deliver y|n` answers a
  verified live permission dialog.

Retain the IDs of workflow-created tabs and close only those during cleanup.

Dispatch reads the bundled Commander defaults at the Igniter install
location, applies agent overrides and optional runbooks from
`.igniter/config.yaml`, and puts the effective stage and agent settings in the
work order. Use those effective values. The bundled stage prompt path is
always absolute; a configured runbook path is absolute too, and neither ever
replaces the other.

Pass the worker:

- its absolute bundled stage protocol prompt path (never a repository prompt);
- its optional absolute project runbook path, when the stage configures one,
  clearly marked as secondary to the bundled protocol;
- the inputs that stage prompt allows, supplied by the generated work order;
- the worker's own scratch paths for `submit.json` and `result.md`, and the
  submit shape generated from the same canonical source as status; and
- an instruction to read and follow repository rules.

Each rule has one owner: this document owns roles, handoffs, and the
Commander's approval scope; each bundled stage prompt owns that stage's
protocol, inputs, and procedure; the generated work order supplies the
per-run facts, the runbook path, and the worker's hard boundaries. Keep those
homes consistent.

The Commander does not read stage prompts into its own context. It passes the
absolute bundled prompt path from the work order for the worker to read
directly.

Use `builder-<ticket>` for Build, `acceptance-<ticket>` for Acceptance, and
`deliverer-<ticket>` for Deliver. The Deliver name may remain unassociated on
the current board; that does not prevent the worker from running.

Before opening a worker, verify that the configured harness exists in Herdr and
that its configured model id is available. Use `builder.fallback` for complex
or repeatedly failing Build work.

If a required worker cannot be created or its model is unavailable, block the
ticket with the concrete reason.

### Permission prompts

The feature request pre-authorizes read-only access to the repository, its
instructions, and source paths within the task, plus read/write inside the
ticket worktree and the worker's own igniter scratch (named in the work
order). The Commander assets and the bundled stage prompts and runbooks named
by absolute path in the work order are pre-authorized read-only too.
Launch each worker normally in the ticket worktree. Do not invent or translate
generic permission flags: harnesses do not share one permission UI. Never
start a Claude stage worker with `--remote-control`; Herdr owns its pane and
interaction. Verify and approve in-scope requests from the actual dialog
without asking the owner again.

Treat Herdr `blocked` only as a hint. Read `source=visible`, require a current
dialog and action footer at the bottom of the pane, then reread the same pane
and revision immediately before sending a key. A vanished, changed, or
appended dialog refuses the send, and the keys never fall through to another
pane or agent. A same-text dialog at a new revision is a new dialog.

Ask the owner before approving home configs, credentials, system locations,
remote hosts, broader filesystem access, external writes, destructive actions,
or external network access. The tested product's own local service, started
and stopped by the repository's run or acceptance instructions, is inside the
pre-authorized scope: approve it without a new owner question. Never start
OpenCode with `--auto`.

Stage workers stay inside the ticket worktree, their own scratch, and the
repository's authorized run, check, and acceptance steps, including the tested
product's local service. Ask the owner before any step that crosses those
boundaries, and never let a worker operate Igniter or Linear state or publish
externally outside its configured stage.

## Worker reports

A Herdr lifecycle state is not a result. A handoff requires both files in the
worker's own scratch: `submit.json` contains the directly submittable JSON
payload; `result.md` contains only stage-specific findings or risks that the
payload does not cover, and ends with its completion marker. Do not require a
second full report in Markdown. The work order embeds the submit shape from
the same canonical source as status; workers need no Igniter or Linear access.

- **Build — `BUILD_HANDOFF_COMPLETE`:** checkpoint, required checks,
  per-criterion self-acceptance, reproduction
  steps, and evidence required by the repository workflow in JSON; code-review
  findings and unresolved concerns in `result.md` when not covered by JSON.
- **Acceptance — `ACCEPTANCE_COMPLETE`:** checkpoint and one result per criterion
  with expected, actual, evidence, and environment details in JSON.
- **Deliver — `DELIVERY_COMPLETE`:** checkpoint, landed target-branch commit,
  commit lineage, merge result, and remaining owner steps in JSON's
  `owner_actions`.

Read both files and review the actual checks, per-criterion results, evidence,
findings, and risks against the current checkpoint and submit schema from
`igniter status <ticket> --json`. Valid JSON and schema compliance do not prove
that checks or acceptance passed; the Commander retains that review duty.
Require the stage's marker as the final line of `result.md` before submitting.
For an absent, unfinished, malformed, schema-invalid, or stale artifact, send
the same worker the precise missing field, parse error, or checkpoint mismatch
to correct, then review both files again. Never supply missing results yourself.

After review, submit the existing artifact unchanged with
`igniter submit <ticket> --input - < "/absolute/scratch/submit.json"`, using the
worker's actual path. The existing submit boundary still validates stage,
checkpoint, every criterion, evidence, and receipt retries before Linear
writes; send any refusal back to the worker for correction. Retry the identical
payload after an uncertain response. Never infer success from `done`, send a
generic `continue`, or submit an incomplete report. Worker completion and
submission never replace the owner's approval gates.

## Build

On Todo + Pending or Build + Pending, run status, worker start, confirm initial
work-order delivery, then begin. On a returned Build + Pending, use the original
Build role and the same sequence before continuing its correction.

Before Acceptance, require a committed checkpoint and every check or artifact
named by the repository workflow. Compare its diff with the configured Risk
areas. Block on a listed risk and wait for the owner.

Build evidence is self-acceptance, never approval. After the first Build
submit the ticket rests at Build + Complete: do not create the Acceptance
worker until the owner approves and `igniter approve <ticket> <id>` records the
Build handoff to Acceptance + Pending. A correction Build needs no
owner step and returns straight to Acceptance + Pending. There is no code audit by
default. Only the owner may request a bounded read-only audit, and it never
replaces black-box acceptance.

When a Builder model switch is needed, use `igniter worker restart <ticket>
--role build --model MODEL`. Confirm the returned effective model and real
replacement worker; preserve the worktree and current checkpoint.

## Acceptance

After a correction Build or an owner-approved Build handoff lands in Acceptance +
Pending, run status, `igniter worker start <ticket> --role acceptance`, confirm
delivery, then `igniter begin <ticket>`. Give it no Build plan, diff, file list,
implementation explanation, or Builder conclusion.

The Acceptance agent never modifies product code: it reports findings and
stops. However small a fix looks, send it to the original Build agent with
only the reproducible failed criteria — never fix inside acceptance, never
open a second Builder.

On PASS, validate and publish its evidence, read the destination back, then
submit the Acceptance report. Keep owner acceptance pending.

On FAIL, submit the Acceptance report so the ticket returns to Build + Pending,
stop the Acceptance worker explicitly, then use status, worker start, confirmed
delivery, and begin for Build. Send only reproducible failed criteria to the original
Build agent. The new checkpoint requires another acceptance attempt. Recheck
the failures plus a short smoke test; do not reopen passed criteria for
exploratory testing.

An original failed criterion stays on the current ticket unless the owner
explicitly changes or waives it. Environment or tool failures are reported
separately and do not fail a product criterion.

Ask the owner only from Blocked: run `igniter block <ticket> --reason "<what you need>"`
before putting any question to the owner, so Linear shows Acceptance + Blocked
instead of staying In progress. After the owner answers, run `igniter unblock <ticket>`,
then status, worker start, confirmed delivery, `igniter begin <ticket>`, and continue.

## Deliver

The owner's explicit approval authorizes `igniter approve <ticket> <id>` to move
Acceptance + Complete to Deliver + Pending. Read status, run worker start, confirm
delivery, then begin. Pass the accepted checkpoint and repository landing
instructions to the configured Deliver worker.

The Deliver agent owns the configured landing: it rebases the feature branch
onto the current target branch, runs the repository's required integration
checks, completes any required pull request and merge, and reports both the
approved checkpoint and the landed commit. A rebase that only changes the SHA
never invalidates the approval and never needs re-acceptance; the Deliver
submit records the two identities side by side and requires that the landed
commit read back from the configured target branch. A conflict resolution may
stay in Deliver only when it preserves the accepted behavior while reconciling
the patch with the current target. When landing needs a product-behavior change,
the agent stops reusing the old approval and returns the ticket to acceptance
or the owner for a new decision, starting from a new Build submit. Build and
Acceptance do not push; only a newly approved Deliver updates the remote branch.

Require the Deliver agent to finish the repository's delivery instructions;
preparing a merge, opening a pull request without following its checks, or
returning commands for the owner is incomplete. Validate that the configured
target branch contains the landed commit, its lineage, and remaining owner
steps before submitting the Deliver report. Do not deploy unless the owner
requested it; push only when the repository instructions require it.

This is a process trust boundary, not a proof: the program checks that a valid
Acceptance PASS receipt binds the approved checkpoint, that approval moved the
ticket to Deliver, and that the reported landed commit exists on local `main`.
It performs no patch-id, replay, or content/tree-equivalence comparison and
never claims it can detect unaccepted content on its own.

After a repository-integrated pull request moves Linear to Done, the Deliver
submit records the merged commit and clears Progress. Without that integration,
Deliver + Complete waits for the owner to confirm landing with `approve`.
Then explicitly stop workflow workers and complete safe Done cleanup.

## Run limits

Run limits stop broken automation; they never accept or reject the feature.
There are no round, token, or review budgets.

- **Time:** use bounded waits; inspect the pane before declaring a stall.
- **Progress:** block when the same observable failure survives two relevant
  corrections, or two corrections produce no relevant behavior or diff change.
- **Quota:** restart Build on its paid channel, then `builder.fallback`. Preserve
  the worktree and checkpoint. Block if no configured model is available.
- **Approvals:** never answer outside the pre-authorized scope; block and hand
  the current dialog to the owner.

## Cleanup and completion

Close only workflow-created tabs after they are no longer useful. Keep the
acceptance process and evidence available until the owner finishes. Never close
pre-existing user tabs. Linear commands never hide worker cleanup: after Done,
run `igniter worker stop <ticket>` without `--role` to stop the ticket's workers
and perform guarded checkout cleanup. Preserve dirty, untracked,
or unmerged work; cleanup must retain the workspace if git safety checks fail.

Report the implementation, branch, checkpoint and corrections, each worker's
result, model switches, stage receipts and submission identities, checks,
published evidence, owner state, and push or merge state.
