# Development

[Back to the README](../README.md).

From an Igniter source checkout:

```bash
bun install
bun run check
```

`bun run check` runs typechecking and Bun tests, including an isolated package
smoke test and the CLI end-to-end suite. Run the black-box suite alone with:

```bash
bun run test:e2e
```

## CLI end-to-end boundaries

The end-to-end suite launches a real CLI subprocess for every command and
drives the production command protocol against a temporary Git repository and
ticket worktrees. The subprocess reaches stateful in-memory Linear and Herdr
fakes through a test-only process boundary. The suite never reads real
credentials, contacts Linear, starts Herdr or an LLM, or changes the source
checkout. Owner status moves are direct fixture mutations only;
`submit` never pretends to merge Git.

The named scenario groups cover:

| Group | Coverage |
| --- | --- |
| Status and begin | Human and JSON status, explicit worker start and Todo stage recording, unique Progress, preserved labels, live worker state, and recognizable CLI failures. |
| Lifecycle and owner gates | Build, Acceptance PASS/FAIL, rebuild after a stale ended worker, Deliver, explicit owner approval/Done reconciliation, receipts, evidence, real Git landing, and safe cleanup. |
| Worker start | Prompt delivery, Pending start recovery, live/missing/ended workers, slot limits, duplicate begin prevention, and ticket isolation. |
| Safe retries | Resubmission, failures before writes, lost write responses, failed post-write reads, attachment readback, and explicit worker cleanup recovery. |
| Control commands | Explicit ticket status, block/unblock, fail, explicit approval, worker start/send/restart/stop, mixed-harness `worker answer y/n`, stdin, missing-ticket refusals, and `start` with a fake foreground Commander. |
| Refusal and Git safety | Malformed payloads, wrong stage, stale/HEAD/rebased checkpoints, owner-gate refusal, dirty/untracked/unmerged checkout retention, scratch symlink escape, and packed failure diagnostics. |

All condition polling has a deadline. On failure, the harness reports recent CLI
stdout/stderr/exit codes, in-memory Linear and Herdr calls, plus Git status,
worktrees, and branches before removing its own resources.
