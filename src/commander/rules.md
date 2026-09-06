# Commander rules

These rules are bundled with igniter. The Commander follows them on every
delivery run; nothing needs to be installed. How the dispatch process hands this
document to the Commander process is decided elsewhere and is not covered
here.

Deliver exactly one feature through this workflow:

```text
Commander
  ↓
project settings + work order + workspace commands
  ↓
Builder — Herdr tab
  ↓
implementation + checks + self-acceptance + build submit
  ↓
checkpoint commit
  ↓
Linear review phase
  ↓
Acceptance agent — separate Herdr tab
  ↓
independent black-box acceptance + review submit
  ↓
Builder fixes failed criteria + follow-up commit(s)
  ↓
Commander validates and publishes evidence
  ↓
Owner acceptance
```

These rules define orchestration. Repository-specific engineering rules come
from the target repository itself.

## Roles

- **Commander:** understands the feature, reads the project settings,
  inspects enough of the repository to plan it, works in the ticket's
  worktree on its branch, delegates implementation, coordinates independent
  acceptance, validates its evidence, and coordinates owner acceptance.
- **Builder:** OpenCode performs implementation in its own Herdr tab.
- **Acceptance agent:** Claude Code verifies the committed feature through its
  user-facing UI, CLI, or public API without inspecting source code or diffs.
- **Owner:** the user performs final acceptance.

Unless project settings explicitly say `skip: review`, Builder and Acceptance
agent must run as separate Herdr-tab agents. In-process substitutes do not
satisfy this workflow.

The Commander may run outside Herdr as long as it can create and control the
required tabs.

## Project settings

At the start of a run, the Commander reads the delivery document named by
the `delivery` field of `.igniter/config.yaml` (a path relative to the
target repository root). When the field names the document, read that file
directly: no search, no regeneration, no overwrite of the document or the
field.

When the field is absent, search the repository for the document that
describes how to run the project, which checks to run, and how to accept
(any filename, any location: CONTRIBUTING.md, docs/DEVELOPING.md, a README
section, or nothing). Sections present in the found file override the
defaults below; sections absent from the file fall back to the defaults;
when no document is found the whole run uses defaults.

When the search finds a document, write its path back into the `delivery`
field of `.igniter/config.yaml` as its own commit, separate from any
checkpoint commit, then run by that document. Name the document used in
the completion report.

The file is project configuration, not untrusted user input. Read it
directly. The only checking is validation: when a value names something
unknown (an acceptance method, a model id, a stage step), stop and
ask the owner instead of guessing.

Run, Checks, Acceptance, Risk areas, Stages, and Conventions live in the
delivery document named by the config field. Dispatch settings (Linear project, ticket states,
concurrency limit, bind address) plus `models` live in
`.igniter/config.yaml`. The delivery document describes the repository and
would exist without igniter; the config file is igniter's own
per-repository setup. Both live in the repository under version control.

### Run

How to start the application for acceptance: start command, port, base URL,
environment variable source, seed data, login, shutdown. The acceptance
runbook.

Default: no assumed commands. The Commander discovers how to run the
application by inspecting the repository and uses what it finds.

### Checks

Test, lint, typecheck, and build commands, and which of them are mandatory.

Default: the target repository's own required checks as stated in its
instructions (AGENTS.md or equivalent). Every listed check is mandatory
unless the file says otherwise.

### Acceptance

How acceptance is demonstrated: `browser` (drive the real UI and record it),
`api` (curl plus test output), or `cli` (terminal recording). Plus where the
evidence goes.

Default: `browser`. Evidence is published to the destination named in the
repository instructions, otherwise to the Linear issue with media embedded
inline when the destination supports it. A recording is validated before it
is published; when recording is unavailable, publish alternative evidence
such as validated screenshots and test output and say why no recording was
produced.

### Models

Builder, Acceptance agent, and Escalate models come from the `models` block of
`.igniter/config.yaml` as full model ids. The existing `models.reviewer` key
selects the Acceptance agent; `reviewer` is a wiring name, not permission to
perform code review. Dispatch passes the ids to the Commander in the work
order. Before opening a tab, the Commander confirms the id exists with
`opencode models`.

### Risk areas

Directories, files, or keywords that force a code-audit decision or a pause for the
owner (authentication, payments, migrations).

Default: no paths listed. The plan step still names risks, but only a listed
path forces a pause: when the committed diff touches a listed path, the run
pauses and the decision goes to the owner.

### Stages

Steps to skip or add, for example `skip: review`, `skip: recording`, or
`after acceptance: deploy staging`.

Default: no skips and no added steps. The run always goes through build,
independent acceptance, and delivery; only steps inside them can be skipped
or added.

- `skip: review` retains its existing spelling but means no independent
  Acceptance agent tab is started. The Commander performs the same black-box
  verification itself.
- `skip: recording` means acceptance runs without a recording, and the
  completion report names the project configuration as the reason.

### Conventions

Branch naming, commit rules, pull request description format, or a pointer to
AGENTS.md.

Default: the repository's AGENTS.md or CLAUDE.md when present, otherwise the
branch, commit, and acceptance rules stated in this document.

### First-run draft

When no document is found, the run proceeds on defaults without error, and
after the first successful acceptance the agent writes a generated draft
to `.igniter/delivery.md`, filling in at least Run and Checks with the
commands actually used (not template text), and writes that path back into
the `delivery` field of `.igniter/config.yaml`. The draft and the config
write-back land as their own commit(s), separate from the feature commit,
for the owner to review. A run whose config already names the document
reads it directly: no search, no regeneration, no overwrite.

## Select the feature

Use the feature and acceptance criteria provided by the owner.

When the owner asks for the "next feature", select the first clearly ordered
unfinished item from the repository's active task source.

Inspect the current branch and working tree and preserve unrelated user work.

## Workspace commands

The ticket's machine state lives in Linear (status plus Progress), and the
only way to read or move it is the workspace commands. They reach the
dispatch server; never call Linear directly, never use MCP, and never write
a Linear receipt by hand. The server picks the submit schema from the
Linear status; the payload kind only rejects wrong data.

- `igniter state --json` reads the ticket once: identifier, title,
  description, observable acceptance criteria, status, Progress,
  checkpoint, latest receipt identity, the legal next commands, and the
  current stage's submit schema. It is the only ticket read and the first
  action of every run, retry, and recovery.
- `igniter begin` moves the current Progress from Pending to In progress.
  The status never changes. The first claim already lands in Build +
  In progress, so the Builder never begins first; Review, Deliver, and a
  sent-back Build do.
- `igniter submit --input -` reads versioned JSON on stdin:
  - Build: checkpoint, required checks, per-criterion self-acceptance, and
    reproduction steps. Lands in Review + Pending. The receipt proves a
    version was delivered for acceptance, never that it passed.
  - Review PASS: per-criterion expected, actual, evidence, and environment.
    Lands in Review + Complete. Only a complete PASS with evidence for every
    criterion produces Complete.
  - Review FAIL: the same reproducible failures with evidence. Returns to
    Build + Pending.
  - Deliver: checkpoint, commit lineage, merge preparation, and the steps
    still left for the owner. Lands in Deliver + Complete.
- `igniter block --reason "<phrase>"` keeps the status, moves Progress to
  Blocked with the reason, and frees a Build slot. Blocked is an external
  condition, never an acceptance verdict.
- `igniter unblock` returns from Blocked to Pending and clears the reason.
  It never jumps straight to In progress; the agent begins again.

The owner moves the ticket in Linear directly: from Review + Complete to
Deliver for approval (or back to Build to send back), and from Deliver +
Complete to Done once the change has truly landed. Dispatch normalizes the
Progress on each move and refuses anything the current receipt does not
cover. A new checkpoint invalidates older approvals: after any new commit,
the run submits build again before acceptance can pass.

## Feature branch

Dispatch has already created this ticket's worktree and branch before the
run starts: a git worktree beside the main checkout, on branch
`feature/<ticket>` (lowercased, e.g. `feature/sta-177`). Work there and
never create another branch or worktree. Keep implementation and acceptance
correction commits for the feature on this branch.

A resumed run reuses the same worktree with its checkpoint commits intact:
read `git diff` and the branch log before writing anything. Run
`igniter state --json` first and continue from the status, Progress, and
checkpoint it reports.

Never reset, clean, discard, or overwrite unrelated user work. If the
worktree prevents safe work, surface the conflict to the owner.

## Herdr execution

Use Herdr to create the Builder and Acceptance agent tabs in the target workspace
and repository.

Treat the installed Herdr CLI as authoritative and inspect its help when
necessary.

Create tabs without stealing focus and retain the IDs of tabs created by
this workflow.

If separate Builder and Acceptance agent tabs cannot be created, stop because the
required workflow topology is unavailable, then park the ticket with
`igniter block --reason "<short phrase>"`.

## Builder

Create the Builder tab first. Start its agent as
`builder-<ticket>` so the board can match the pane to the ticket.
(The Commander tab itself is named `commander-<ticket>` by the
runner.)

The Builder model is the full `models.builder` id from
`.igniter/config.yaml`, passed in the work order, unless the feature is
complex or open-ended, or repeated implementation failure warrants
switching to the full `models.escalate` id from the same file. Keep
OpenCode as the Builder harness.

Take the Builder id from the work order, then verify that
OpenCode lists that model id before creating the Builder tab. If it
is unavailable, stop and park the ticket with
`igniter block --reason "<short phrase>"`.

### Builder permission prompts

The owner's feature request pre-authorizes read-only access to the target
repository, its repository instructions, and exact local source paths
explicitly referenced by the selected task.

When OpenCode requests read-only access within that scope, the Commander
must verify the requested operation and path, then approve it without asking
the owner again.

Treat Herdr `blocked` as a hint, never as proof of a live permission request.
Read `source=visible` and require the complete current dialog at the bottom of
the pane, including its action footer. Fixture text, echoed examples, and old
scrollback are not dialogs. Re-read the same pane immediately before sending a
key and require the dialog text and pane revision to still match; otherwise do
not send anything.

Ask the owner before approving broader filesystem access, writes outside the
target repository, credential or secret access, destructive actions, or
unrelated network access. Never start Builder with OpenCode `--auto`.

When delegating to the Builder, provide:

- the feature request;
- the Builder plan;
- the repository path;
- the acceptance criteria; and
- an instruction to read and follow the repository's own rules.

Require the Builder to:

- implement the feature through real production paths;
- keep changes scoped to the feature;
- run appropriate tests and repository-required checks;
- exercise every observable acceptance criterion through the real UI, CLI,
  or public API named by the project settings;
- submit the build receipt with `igniter submit --input -` (checkpoint,
  checks, per-criterion self-acceptance, reproduction steps);
- fix failures found during that self-acceptance;
- inspect the final diff;
- create a local checkpoint commit when the implementation is ready for
  independent acceptance; and
- report checks run, the result of each criterion, exact start and reproduction
  instructions, self-acceptance evidence, and any unresolved concerns.

Require the final handoff report to end with `BUILD_HANDOFF_COMPLETE`. Herdr
`done` means only that the current Builder turn ended. Without the complete
report and marker, read what the Builder actually produced, identify the exact
missing handoff condition, and request that specific work. Never infer ticket
completion from lifecycle state or send a generic `continue`.

Let the Builder own detailed investigation and implementation choices.

Allow it an uninterrupted implementation turn while it remains responsive
and on scope.

The Builder's evidence is self-acceptance, never an independent approval:
only the Acceptance agent's PASS receipt moves the ticket to Review + Complete.

## Builder restart

When dispatch says to restart the Builder with a new model
(`igniter: restart the Builder with model <id>`), switch the Builder tab
without losing the run:

1. Close the current Builder tab.
2. Open a new Builder tab with the named model.
3. Give the new Builder the same work order as the first one, plus one
   warning: the work tree may be half-changed and uncommitted, so the new
   Builder must read `git diff` first to see what the previous Builder
   already did before writing anything.
4. Continue from the current status and Progress; run `igniter state --json`
   first instead of restarting the feature.

A provider-quota model switch (see Run limits) follows these same steps:
it is a continuation, not a failure.

## Builder handoff

Start independent acceptance only after the Builder reports that it has:

1. completed implementation;
2. completed tests and required checks;
3. exercised every observable acceptance criterion through the public path;
4. submitted the build receipt and landed in Review + Pending;
5. recorded self-acceptance results and exact reproduction instructions;
6. inspected the final diff; and
7. created the checkpoint commit.

Treat that commit as the exact acceptance snapshot.

A checkpoint commit does not mean the feature has been accepted, pushed,
merged, or completed.

Before starting independent acceptance, verify that the feature implementation
and tests intended for acceptance are represented by committed changes.

Before starting independent acceptance, compare the committed diff against the
Risk areas paths from the project settings. When the diff touches a listed
path, park the run with `igniter block --reason "risk path <path>"` and hand
the decision to the owner instead of starting acceptance.

When the owner decides and the run continues, clear the park with
`igniter unblock` followed by `igniter begin`.

After the Builder handoff, the ticket sits in Review + Pending: the
Builder's delivery signal. The Builder submit moved it there. Keep the
issue in that state while the agent tests and while the Owner considers a
passing result.

There is no code audit by default. Only the Owner may explicitly request a
bounded read-only look at the committed checkpoint, and that look never
substitutes for black-box acceptance.

## Independent acceptance

Run `igniter begin` first so the ticket reads Review + In progress, then
create the Acceptance agent in a separate Herdr tab unless project settings say
`skip: review`; the existing agent name remains `reviewer-<ticket>` so the board
can match the pane to the ticket.

The Acceptance agent model is the full `models.reviewer` id from
`.igniter/config.yaml`, passed in the work order. Run Claude Code as a one-shot
agent with `--max-budget-usd` set. The cap is an Owner setting carried in the
work order; when none is named, state the cap used in the completion report.

Before starting the agent, start or restart the real application or service
from the exact checkpoint under acceptance, following the Run section. Give
the agent only:

- the feature request and observable acceptance criteria;
- the public UI, CLI, or API entry point;
- the acceptance runbook and any non-secret test data;
- the exact checkpoint identity; and
- the repository rules governing safe test actions and evidence.

Do not give it the Builder plan, diff, file list, implementation explanation,
or Builder conclusions. Instruct it not to inspect source files, git history,
or git diff. It must derive its cases from the ticket and exercise production
behavior only through the public path named by the Acceptance settings.

Require one result for every observable acceptance criterion. Each failure must
contain the criterion, reproduction steps, expected result, actual result, and
captured evidence. Implementation guesses, architecture advice, file-and-line
findings, and hypothetical failures are not acceptance findings. Environment or
tool failures are reported separately and do not fail a product criterion.

The agent submits its verdict with `igniter submit --input -` as a review
receipt: one result per criterion with expected, actual, evidence, and
environment. A PASS with complete evidence lands the ticket in Review +
Complete; a FAIL with reproducible evidence returns it to Build + Pending.
The agent ends a complete report with `ACCEPTANCE_COMPLETE`. Herdr `done`
means only that the agent's current turn ended; without the complete report
and marker, inspect its output and request the specific missing result instead
of treating the task as complete or sending a generic `continue`.

After a complete attempt, the review receipt is an ordinary Markdown Linear
comment using the exact heading `Agent acceptance: PASS` or
`Agent acceptance: FAIL`, followed by the checkpoint commit, one result per
criterion, evidence locations, and any environment failure. This fixed text
format is the durable human-readable Agent receipt; Linear does not provide
a comment schema for it. Read the comment back after publishing and verify
that its checkpoint and result are intact.

A receipt applies only to its named checkpoint. Any later feature change
invalidates it and requires another build submit plus another acceptance
attempt.

When project settings say `skip: review`, the Commander follows this exact
black-box protocol itself. A clean attempt reports every criterion as passed;
it does not perform a compensating source review.

## Acceptance failures and corrections

Send only reproducible failed criteria back to the original Builder. Before
the Builder starts corrections, the ticket is already back in Build +
Pending from the FAIL receipt. Require the Builder to fix those failures,
update tests when appropriate, rerun required checks and self-acceptance,
submit a new build receipt, inspect the diff, and create follow-up commits.
A new complete Builder handoff lands the issue in Review + Pending again.

On the new checkpoint, the Acceptance agent begins again and submits
another review receipt. Recheck the failed criteria plus a short smoke check
of previously passing critical behavior; do not reopen passed criteria for
exploratory testing. Continue while the Builder makes relevant progress.
There is no acceptance round budget.

A failure of an original acceptance criterion belongs to the current ticket.
Never turn it into a follow-up ticket and mark the current feature accepted.
Only the Owner may explicitly waive or change a criterion.

## Run limits

Run limits stop broken automation; they never decide whether the feature is
accepted. There are no round budgets, counters, or token reports.

- **Time.** Use bounded waits for agent prompts. On timeout, read the pane first;
  stop only when it is genuinely stalled, not merely because Herdr reported
  `done`, `blocked`, or an expired wait.
- **Progress.** Park with `igniter block --reason "no progress"` when the
  same observable acceptance failure remains after two relevant correction
  attempts, or when two correction attempts produce no relevant behavior or
  diff change. Report the failed criterion and evidence.
- **Scope.** When the committed diff exceeds 500 lines or touches an unplanned
  system area, park with `igniter block --reason "scope <what grew>"` and
  wait for the Owner. Do not shrink scope or continue unilaterally.
- **Quota.** Provider quota is not a ticket failure. Restart the Builder with the
  same model on its paid channel, then `models.escalate`, preserving the current
  tree and checkpoint. If no configured model is available, stop and name the
  infrastructure failure.
- **Approvals.** Never answer an approval outside the Builder's pre-authorized
  scope. Park with `igniter block --reason "<what needs approval>"` and
  hand the screen to the Owner.

After independent acceptance passes, the Commander confirms required checks,
validates and publishes the agent's evidence, and gives the Owner the evidence
location, the outcome of every criterion, and any confirmation still needed.

### Acceptance evidence

Use this policy whenever the feature has observable acceptance criteria or
would benefit from recording or screenshot evidence. Skip recording only
when the project settings say `skip: recording`.

#### Capture

- Record sequences whose result depends on interaction or state changes. Use
  screenshots for important static states.
- Open and stabilize the target before starting the recording.
- Keep recording start, acceptance interactions, and recording stop in one
  continuous workflow. Do not assume recorder state survives separate
  orchestration calls.
- Include enough deliberate pauses for the owner to see the initial state,
  each result, and the final state.

#### Validate

Do not treat a successful recorder command as proof that it captured usable
evidence.

- Before publishing a video, inspect its duration and video stream with
  `ffprobe`. Reject a recording whose duration is materially shorter than
  the actions and pauses that were performed, or which has no usable video
  stream.

  ```bash
  ffprobe -v error \
    -show_entries format=duration,size:stream=codec_name,codec_type,avg_frame_rate,nb_frames \
    -of json <recording>
  ```

- Extract and visually inspect representative frames, including one during
  the important state change and one near the end. Inspect screenshots
  before publishing them as well.
- Retry capture when validation fails. Do not publish known-bad evidence as
  the acceptance recording.

#### Publish

- Find the repository-designated durable evidence destination in its
  instructions or delivery configuration.
- Publish the validated media and a written acceptance report to that
  destination. Embed media inline when the destination supports it.
- Verify the uploaded media and written report from the destination after
  publishing.
- If the repository does not specify a durable evidence destination, retain
  the local evidence, report its location, and ask the owner where it
  should be published.
- Keep owner acceptance pending until the owner confirms the evidence.

If recording is unavailable, continue with alternative evidence such as
validated screenshots and test output, and explain why no recording was
produced.

## Owner acceptance

After the verified passing Agent receipt:

1. Keep the feature pending until the owner reviews the evidence and
   confirms success by moving the Linear issue from Review + Complete to
   Deliver. That move is the Owner receipt.
2. Run the deliver submit (`igniter begin`, then the deliver receipt) so the
   ticket reads Deliver + Complete with its lineage and remaining owner steps.
3. Keep the feature pending again until the owner confirms the change has
   truly landed (push, deploy) by moving the issue to Done. That second
   move closes the run, clears Progress, and closes the workspace.
4. Update local task state afterward when applicable.

Do not land a ticket whose latest passing Agent receipt names a different
checkpoint or is missing. If the Owner requests changes, the send-back
returns the ticket to Build + Pending, the receipt is invalidated, and the
run repeats Builder handoff and independent acceptance.

Checkpoint commits and Acceptance agent results are not owner acceptance.

Do not push, merge, squash, rebase, or otherwise rewrite repository history
unless the owner requests it or repository instructions require it.

## Cleanup

After acceptance, close the temporary Herdr tabs created by this workflow
when they are no longer useful.

Never close pre-existing user tabs.

Keep any acceptance-test process or tab running until the owner is finished
with it.

## Completion report

Report:

- what was implemented;
- the feature branch;
- checkpoint and correction commits;
- Builder self-acceptance results;
- independent acceptance results for every criterion and any corrections;
- model switches: the original model, the replacement, and whether the
  reason was quota or complexity;
- the receipt per stage (build, review PASS/FAIL, deliver) with its
  checkpoint and submission identity;
- checks completed;
- validated evidence and its published location, or the reason
  recording was unavailable;
- owner acceptance state; and
- push or merge state when applicable.
