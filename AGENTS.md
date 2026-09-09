## Tooling

- Runtime and package manager is Bun only (`bun install`, `bun run`, `bun test`). Never pnpm or npm.
- All versions in `package.json` are locked exactly — never `^` or `~`.
- Run `bun run check` before committing: typecheck + bun test.

## Testing

Every feature must expose its state or protocol through a deterministic `*.test.ts` test run with `bun test`.

Tests must never use real credentials, call a real provider, or modify a real project. `LINEAR_API_KEY` is read from the environment only and never committed.

## Conventions

Use concrete domain vocabulary, not Java-style or design-pattern names. Avoid
`Resolver`, `Manager`, `Handler`, `Helper`, `Util`, `Processor`, `Provider`,
`Coordinator`, `Strategy`, `Factory`, `AbstractFoo`, `FooImpl`, `IFoo` suffixes.
Prefer the concrete action (`lookup`, `fetch`, `check`, `parse`, `send`) over
vague verbs (`resolve`, `process`, `handle`, `perform`, `execute`).

Do only what the ticket requires. Don't add features, surrounding refactors,
one-use helpers, premature abstractions, or hypothetical future support.

## GitHub

Keep `gh` authenticated as `claudecafe`; check `gh auth status` before writes.
For commands requiring the user's permissions, use `minipai` only for that command:

    GH_TOKEN=$(gh auth token --user minipai) gh ...

Never use `gh auth switch`.

Commit messages are always in English.

One ticket lands as one commit. Fixes made while building the ticket — review
findings, failing checks, convention slips like a button onClick that should
have been a form — are squashed into the feature commit before review, not
left as follow-up commits on top of it. A separate commit is for a separate
change.

Deliveries use pull requests. Once the owner moves the ticket to Deliver,
follow `delivery.md`: rebase onto the current remote `main`, push the ticket
branch, open or update its pull request, and monitor CI and automatic merge
until the pull request is merged or a concrete blocker is reported. Never push
directly to `main`. A CI failure that needs a code change returns to Build and
Review; do not reuse the old acceptance. `.diffwalk/` stays out of git.

## Acceptance evidence

Feature-delivery evidence belongs on the matching Linear issue. Upload the validated recording,
screenshots, and written acceptance report there; embed media inline when Linear supports it. Read
the issue back after publishing to verify the evidence is present, and keep owner acceptance pending
until the owner confirms it.
