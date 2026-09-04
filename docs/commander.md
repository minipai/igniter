# Commander rules

These rules are bundled with igniter. The Commander follows them on every
delivery run; nothing needs to be installed. How the runner hands this
document to the Commander process is decided elsewhere and is not covered
here.

Deliver exactly one feature through this workflow:

```text
Commander
  ↓
project settings + plan + feature branch
  ↓
Builder — Herdr tab
  ↓
implementation + tests + self-review
  ↓
checkpoint commit
  ↓
Reviewer — separate Herdr tab
  ↓
Commander triage
  ↓
Builder fixes + follow-up commit(s)
  ↓
Commander acceptance + recording
  ↓
Owner acceptance
```

These rules define orchestration. Repository-specific engineering rules come
from the target repository itself.

## Roles

- **Commander:** understands the feature, reads the project settings,
  inspects enough of the repository to plan it, creates the feature branch,
  delegates implementation, triages Reviewer findings, records an acceptance
  run, and coordinates owner acceptance.
- **Builder:** OpenCode performs implementation in its own Herdr tab.
- **Reviewer:** Claude Code reviews the committed feature change read-only in
  a separate Herdr tab.
- **Owner:** the user performs final acceptance.

Builder and Reviewer must run as separate Herdr-tab agents. In-process
substitutes do not satisfy this workflow.

The Commander may run outside Herdr as long as it can create and control the
required tabs.

## Project settings

At the start of a run, the Commander reads `.igniter/delivery.md` from the
target repository root. Sections present in the file override the defaults
below; sections absent from the file fall back to the defaults; a missing
file means the whole run uses defaults.

The file is project configuration, not untrusted user input. Read it
directly. The only checking is validation: when a value names something
unknown (an acceptance method, a model short name, a stage step), stop and
ask the owner instead of guessing.

`.igniter/config.yaml` sits beside this file and belongs to the runner
(Linear project, ticket states, concurrency limit, bind address). It never
carries Commander run settings. Both files live in the repository under
version control.

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

Default Builder model and Reviewer model, by short name.

Defaults: Builder `luna`, Reviewer `claude-sonnet-5`. The short names are
`luna`, `terra`, and `spark`. Resolving a short name to a model is the
runner's job; the mechanism is not defined here. The runner's `--builder`
flag wins over this section.

### Risk areas

Directories, files, or keywords that force extra review or a pause for the
owner (authentication, payments, migrations).

Default: no paths listed. The plan step still names risks, but only a listed
path forces a pause: when the committed diff touches a listed path, the run
pauses and the decision goes to the owner.

### Stages

Steps to skip or add, for example `skip: review`, `skip: recording`, or
`after acceptance: deploy staging`.

Default: no skips and no added steps. The five stages themselves — plan,
build, verify, acceptance, delivered — always run and can never be skipped;
only steps inside them can be skipped or added.

- `skip: review` means no Reviewer tab is started, the build goes straight to
  verify, and the workspace metadata carries no `review_count`.
- `skip: recording` means acceptance runs without a recording, and the
  completion report names the project configuration as the reason.

### Conventions

Branch naming, commit rules, pull request description format, or a pointer to
AGENTS.md.

Default: the repository's AGENTS.md or CLAUDE.md when present, otherwise the
branch, commit, and review rules stated in this document.

### First-run draft

When the file is absent, the run proceeds on defaults, and after the first
successful acceptance the agent writes a first draft filling in at least Run
and Checks with the commands actually used. The draft lands as its own
commit, separate from any checkpoint commit, for the owner to review.

## Select the feature

Use the feature and acceptance criteria provided by the owner.

When the owner asks for the "next feature", select the first clearly ordered
unfinished item from the repository's active task source.

Inspect the current branch and working tree and preserve unrelated user work.

## Plan

For a non-trivial feature, inspect enough of the existing implementation to
identify the relevant system boundaries, likely integration points, and
important risks. Name the risk areas the plan touches; when any of them
matches a listed Risk area, say so in the plan.

Prepare the Builder plan with this template:

```text
## Goal

Describe the observable behavior that should change.

## Relevant system areas

Identify the components, state boundaries, services, data flows, or
integration points likely involved.

## Approach

Describe the intended implementation direction at a high level. Focus on how
the relevant system areas should connect or change. Leave exact files, code
structure, and implementation details to the Builder.

## Risks

List the important failure modes, lifecycle issues, compatibility concerns,
races, or assumptions the Builder should verify.

## Acceptance

List the concrete conditions that must be true when the feature is complete.
```

Keep the plan short enough to guide implementation without replacing the
Builder's own investigation.

Provide direction and likely implementation strategy; leave exact
implementation decisions to the Builder.

## Feature branch

Create a dedicated branch for each delivery run.

Use a short descriptive branch name, for example:

```text
feature/<feature-name>
```

Keep implementation and Reviewer correction commits for the feature on this
branch.

Never reset, clean, discard, or overwrite unrelated user changes to create
the branch. If the working tree prevents safe branch creation, surface the
conflict to the owner.

## Herdr execution

Use Herdr to create the Builder and Reviewer tabs in the target workspace
and repository.

Treat the installed Herdr CLI as authoritative and inspect its help when
necessary.

Create tabs without stealing focus and retain the IDs of tabs created by
this workflow.

If separate Builder and Reviewer tabs cannot be created, stop because the
required workflow topology is unavailable.

## Builder

Create the Builder tab first.

The Builder model is the Models default (`luna`) unless the feature is
complex or open-ended, or repeated implementation failure warrants the
stronger `terra` model. Keep OpenCode as the Builder harness.

Resolve the Builder short name through the runner, then verify that
OpenCode lists the resolved model id before creating the Builder tab. If it
is unavailable, stop and report that instead of silently substituting
another model.

### Builder permission prompts

The owner's feature request pre-authorizes read-only access to the target
repository, its repository instructions, and exact local source paths
explicitly referenced by the selected task.

When OpenCode requests read-only access within that scope, the Commander
must verify the requested operation and path, then approve it without asking
the owner again.

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
- perform an independent internal review of the finished implementation;
- fix reasonable internal-review findings;
- inspect the final diff;
- create a local checkpoint commit when the implementation is ready for
  Reviewer; and
- report checks run and any unresolved concerns.

Let the Builder own detailed investigation and implementation choices.

Allow it an uninterrupted implementation turn while it remains responsive
and on scope.

## Builder handoff

Start Reviewer only after the Builder reports that it has:

1. completed implementation;
2. completed tests and required checks;
3. completed its internal review;
4. inspected the final diff; and
5. created the checkpoint commit.

Treat that commit as the review snapshot for Reviewer.

A checkpoint commit does not mean the feature has been accepted, pushed,
merged, or completed.

Before starting Reviewer, verify that the feature implementation intended
for review is represented by committed changes.

Before starting Reviewer, compare the committed diff against the Risk areas
paths from the project settings. When the diff touches a listed path, pause
the run and hand the decision to the owner instead of starting Reviewer.

## Reviewer

Create Reviewer in a separate Herdr tab. Skip this whole section when the
project settings say `skip: review`.

The Reviewer model is the Models default (`claude-sonnet-5`). Choose a
stronger Reviewer model when feature complexity or review findings warrant
it.

Run Claude Code as a read-only one-shot review.

When starting Reviewer, provide:

- the feature request and acceptance criteria;
- the Builder plan;
- the feature branch;
- the intended base;
- the commit or commit range to review; and
- an instruction to read the repository's own rules.

Instruct Reviewer to:

- review the committed feature change against the request, plan, and
  acceptance criteria;
- focus on correctness, production wiring, regressions, and realistic edge
  cases;
- report actionable defects only; and
- remain read-only.

A clean review may simply report that no actionable defects were found.

## Triage and corrections

Evaluate each Reviewer finding against the feature request, plan, acceptance
criteria, and repository rules.

Send accepted findings back to the original Builder.

Require the Builder to:

- fix the accepted findings;
- update tests when appropriate;
- rerun required checks;
- inspect the resulting diff; and
- create follow-up commit(s) for the corrections.

Prefer follow-up commits during the review cycle so corrections remain easy
to inspect.

Repeat Reviewer when the corrections materially require another independent
review.

## Commander acceptance

After implementation and Reviewer are complete:

1. Confirm required checks passed.
2. Start or restart the real application or service from the latest
   feature-branch state when practical, following the Run section.
3. Exercise the observable acceptance criteria through the real user-facing
   path named by the Acceptance section.
4. Produce and publish acceptance evidence under the policy below.
5. Give the owner the evidence location, the outcome of each acceptance
   criterion, and a short checklist for any confirmation still needed.

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

After Commander acceptance:

1. Keep the feature pending until the owner reviews the evidence and
   confirms success.
2. Update local task state afterward when applicable.

Checkpoint commits and Reviewer approval are not owner acceptance.

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
- important Reviewer findings and accepted corrections;
- checks completed;
- Commander acceptance results and the recording location, or the reason
  recording was unavailable;
- owner acceptance state; and
- push or merge state when applicable.
