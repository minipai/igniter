# Deliver

Deliver one owner-approved checkpoint through GitHub. The pull request,
required Check, native auto-merge, and landed commit form one delivery; do not
stop after opening the pull request.

## Before the pull request

- Read `AGENTS.md` and preserve the accepted checkpoint identity.
- Fetch `origin/main`, rebase the ticket branch onto it, run `bun run check`,
  and confirm the worktree is clean. A rebase-only SHA change keeps acceptance.
- Resolve a rebase conflict here only when the resolution preserves the
  accepted behavior while reconciling it with current `main`, then rerun the
  checks. If a conflict or failed check needs a product-behavior change,
  report the blocker so the ticket returns to Build and Acceptance.
- Push only the ticket branch. Never push directly to `main`.

## Pull request and CI

- Run `gh auth status` before GitHub writes and keep `gh` authenticated as
  `claudecafe`. For one command that needs owner permission, use
  `GH_TOKEN=$(gh auth token --user minipai) gh ...`. Never use
  `gh auth switch`.
- Open or update one pull request from `feature/<ticket>` to `main`. Put the
  ticket identifier in its title and describe the accepted user benefit.
- Read the pull request's required checks. If requirements are still pending,
  queue native rebase auto-merge with `gh pr merge --auto --rebase`; if they
  are already satisfied, merge directly with `gh pr merge --rebase`.
- Watch the pull request and Check until GitHub reports it merged. Inspect
  failed job logs instead of merely reporting a red status.
- Retry a confirmed transient or infrastructure failure safely. If fixing a
  failure changes product behavior, stop: the new checkpoint must complete
  Build and Acceptance before Deliver pushes it to the pull request.
- If `main` advances before merge, rebase onto the new `origin/main`, push with
  `--force-with-lease`, and watch the replacement Check.

## Merge and Linear handoff

- After merge, verify remote `main` and record the pull request URL, successful
  Check run, accepted checkpoint, and landed commit.
- Linear's GitHub integration normally moves the issue to Done. If it does
  not, report the remaining owner action; GitHub automation never holds a
  Linear token or changes Linear state.

Do not deploy unless the owner separately authorizes it.

## Report

Return the accepted checkpoint, rebased checkpoint when different, pull
request URL, Check and native auto-merge results, landed commit on remote
`main`, final lineage, working-tree state, remaining owner actions, and
blockers or `none`.
