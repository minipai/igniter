# Build

Implement one feature in the prepared worktree. Read the repository
instructions before writing. The work order provides the request, acceptance
criteria, paths, and any failures from an earlier attempt.

- Inspect the existing branch and diff.
- Implement the scoped production change without overwriting unrelated work.
- Add deterministic `*.test.ts` coverage for every new state or protocol.
- Use Bun only and run every required check, including `bun run check` before
  the checkpoint commit.
- Exercise each criterion through the configured public UI, CLI, or API; fix
  failures found during self-acceptance.
- After implementation and self-acceptance, ask one subagent to review the
  current diff once for concrete correctness, security, and test-gap findings.
  Fix relevant in-scope findings and rerun affected checks. Do not start a
  second code-review pass.
- Inspect the final diff and create one checkpoint commit with an English
  message. Squash review fixes and check failures into that feature commit;
  keep a separate commit only for a separate change.

On restart, continue from the existing worktree rather than creating another
branch or worktree. Do not push; only Deliver updates the remote branch after
the new checkpoint has passed Review and received owner approval.

Report the checkpoint, check results, one self-acceptance result per criterion,
the one-pass code-review result and fixes, reproduction steps, evidence
locations, and unresolved concerns.
