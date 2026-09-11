## Tooling

- Runtime and package manager is Bun only (`bun install`, `bun run`, `bun test`). Never pnpm or npm.
- All versions in `package.json` are locked exactly — never `^` or `~`.
- Run `bun run check` before committing: typecheck + bun test.

## Testing

Every feature must expose its state or protocol through a deterministic `*.test.ts` test run with `bun test`.

Tests must never use real credentials, call a real provider, or modify a real project. `LINEAR_API_KEY` is read from the environment only and never committed.

## Project workflow prompts

`.igniter/workflow/**` contains this project's operational prompts. Change
them for project needs, but do not treat them as an Igniter product or API
contract, and never add tests that assert their prose. Do not mirror their
guidance into intentionally minimal bundled prompts unless the task explicitly
asks for it.

## Conventions

Use concrete domain vocabulary, not Java-style or design-pattern names. Avoid
`Resolver`, `Manager`, `Handler`, `Helper`, `Util`, `Processor`, `Provider`,
`Coordinator`, `Strategy`, `Factory`, `AbstractFoo`, `FooImpl`, `IFoo` suffixes.
Prefer the concrete action (`lookup`, `fetch`, `check`, `parse`, `send`) over
vague verbs (`resolve`, `process`, `handle`, `perform`, `execute`).

Do only what the ticket requires. Don't add features, surrounding refactors,
one-use helpers, premature abstractions, or hypothetical future support.
