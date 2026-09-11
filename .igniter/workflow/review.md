# Review

Independently test one committed feature through its public product surface.
This is black-box acceptance, not code review.

## Inputs

Use only:

- the requirement and observable acceptance criteria;
- the public UI, CLI, or API entry point;
- the acceptance runbook and non-secret test data;
- the exact checkpoint identity;
- repository rules for safe test actions and evidence; and
- criteria to recheck after a previous failure, when applicable.

Do not accept a Build plan, diff, file list, implementation explanation,
Builder conclusion, or source-level hint. Do not inspect source files, git
history, or git diff.

Starting and stopping the tested product's own local service, when the runbook
calls for it, is part of acceptance and not the Igniter control plane: it needs
no separate permission. Never operate Igniter or Linear state, and never
publish outside the product under test.

## Acceptance

Exercise production behavior from the supplied checkpoint. Report exactly one
result for every observable criterion.

A failed result must include:

- the criterion;
- reproduction steps;
- expected behavior;
- actual behavior; and
- captured evidence.

Implementation guesses, architecture advice, file-and-line findings, and
hypothetical failures are not acceptance findings. Report environment or tool
failures separately; they do not fail a product criterion.

Never modify product code, configuration, or history. Every correction,
however small, returns to the original Builder. On a correction attempt,
recheck the failed criteria plus a short smoke test of previously passing
critical behavior; do not reopen passed criteria for exploratory testing.

## Evidence

Unless the project settings skip recording:

- record interactions or state changes and use screenshots for important
  static states;
- keep recording start, acceptance actions, and stop in one continuous run;
- inspect video duration and stream metadata with `ffprobe`;
- visually inspect representative frames and every screenshot; and
- retry unusable captures instead of reporting them as evidence.

Keep validated evidence available for the handoff. If recording is
unavailable, provide validated alternative evidence and explain why.

For CLI or API behavior, report a short, focused command transcript per
criterion: the exact command, integer exit code, and needed stdout and stderr
excerpts. The receipt renders the command inline and verbatim, so use one
short, readable invocation. Prefer a named deterministic test or concise
existing command; do not embed long `if`/`then`/`else` shell control flow or
chained narration merely to manufacture evidence. At least one stdout or
stderr excerpt must be non-empty, and the command, final exit code, and output
must describe the same invocation. Attach or link oversized output rather
than truncating failure details. State PASS or FAIL yourself; no tool derives
the verdict from an exit code.

## Report

Return the checkpoint, environment details, and one PASS or FAIL result per
criterion with expected behavior, actual behavior, reproduction steps, and
evidence locations. Name environment failures separately.
