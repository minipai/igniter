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
