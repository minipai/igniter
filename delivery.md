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
- The GitHub `Check` workflow is the authoritative integration check. The
  `Auto Merge` workflow merges only a same-repository `feature/STA-N` pull
  request whose successful Check head and base SHAs are still current.
- Watch the pull request and both workflows until GitHub reports the pull
  request merged. Inspect failed job logs instead of merely reporting a red
  status.
- Retry a confirmed transient or infrastructure failure safely. If fixing a
  failure changes product code or the accepted commit contents, stop: the new
  checkpoint requires Build and Review before this pull request may merge.
- If `main` advances before merge, rebase onto the new `origin/main`, push with
  `--force-with-lease`, and watch the new Check run.

## Merge and Linear handoff

- After merge, verify the remote `main` commit and record the pull request URL,
  successful Check run, accepted checkpoint, and landed commit.
- Report the landed commit to the Global Commander. The Commander publishes
  the delivery receipt, which moves Linear to `Deliver + Complete`.
- The post-merge GitHub job waits for that receipt state, then moves the issue
  to Done while retaining the Complete label. The Commander must read back
  Done and run reconciliation so Igniter verifies the receipt and safely
  removes the local worktree and Progress label.
- If the post-merge Linear job fails, keep monitoring it and provide its run
  URL and exact error. The job is idempotent and may be rerun after correcting
  an external or configuration failure.

Do not deploy unless the owner separately authorizes it.

## Report

Return the accepted checkpoint, rebased checkpoint when different, pull request
URL, Check and Auto Merge run results, landed commit on remote `main`, final
lineage, working-tree state, remaining owner actions, and blockers or `none`.

End the complete report with:

```text
DELIVERY_COMPLETE
```
