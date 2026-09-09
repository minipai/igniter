# Pull-request delivery

Deliver one owner-approved checkpoint through GitHub. The pull request, GitHub
CI, automatic merge, delivery receipt, and Linear Done transition are one
delivery; do not stop after opening the pull request.

## Before the pull request

- Read `AGENTS.md` and preserve the accepted checkpoint identity.
- Fetch `origin/main`, rebase the ticket branch onto it, and confirm the
  worktree is clean. A rebase-only SHA change keeps acceptance.
- Do not make product changes. If a conflict or failed check needs a code
  change, report the blocker so the ticket returns to Build and Review.
- Push only the ticket branch. Never push directly to `main`.

## Pull request and CI

- Keep `gh` authenticated as `claudecafe`. Use the `minipai` token only for an
  individual command that needs owner permission, exactly as `AGENTS.md`
  specifies.
- Open or update one pull request from `feature/<ticket>` to `main`. Put the
  ticket identifier in its title and describe the accepted user benefit.
- The GitHub `Check` workflow is the authoritative integration check. Enable
  GitHub's native rebase auto-merge with `gh pr merge --auto --rebase`; branch
  protection keeps the merge blocked until Check succeeds.
- Watch the pull request and Check until GitHub reports the pull request
  merged. Inspect failed job logs instead of merely reporting a red status.
- Retry a confirmed transient or infrastructure failure safely. If fixing a
  failure changes product code or the accepted commit contents, stop: the new
  checkpoint requires Build and Review before this pull request may merge.
- If `main` advances before merge, rebase onto the new `origin/main`, push with
  `--force-with-lease`, and watch the new Check run.

## Merge and Linear handoff

- After merge, verify the remote `main` commit and record the pull request URL,
  successful Check run, accepted checkpoint, and landed commit.
- Report the landed commit to the Global Commander. From the clean project
  workspace, the Commander fetches `origin/main` and fast-forwards local
  `main` before publishing the delivery receipt.
- Linear's GitHub integration normally moves the issue to Done when the pull
  request merges. Done + In progress with the matching review-pass receipt is
  still eligible for the Deliver submit: Igniter records the landed commit,
  clears Progress, and closes the workspace.
- If Linear does not move to Done, the Deliver submit lands in Deliver +
  Complete and reports the remaining owner action. GitHub automation never
  holds a Linear token or changes Linear state.

Do not deploy unless the owner separately authorizes it.

## Report

Return the accepted checkpoint, rebased checkpoint when different, pull request
URL, Check and native auto-merge results, landed commit on remote `main`, final
lineage, working-tree state, remaining owner actions, and blockers or `none`.

End the complete report with:

```text
DELIVERY_COMPLETE
```
