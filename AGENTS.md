## Read before writing Solid

Solid 2.0 differs a lot from 1.x and is not React — writing it from memory will be wrong. Read
`docs/solid-2.0/CHEATSHEET.md` (one-page API cheat sheet) first; for details see the numbered
RFCs in the same folder (01 reactivity / 03 control flow / 04 stores / 05 async / 06 actions).

Those files are official docs pulled from the solid repo's `next` branch — don't edit them from memory.

## Tooling

- Runtime and package manager is Bun only (`bun install`, `bun run`, `bun test`). Never pnpm or npm.
- All versions in `package.json` are locked exactly — never `^` or `~`. Solid 2 is still RC, upgrades are manual.
- Run `bun run check` before committing: typecheck + bun test + vitest.

## Testing

Every feature must expose its state or protocol through a deterministic test:

- server/runner behavior (anything touching Bun APIs) belongs in a `*.test.ts` test run with `bun test`;
- Solid UI and form behavior belongs in a `*.dom.test.tsx` test run with vitest 4 + jsdom, compiled through the `@solidjs/vite-plugin` in `vitest.config.ts`.

Tests must never use real credentials, call a real provider, or modify a real project. `LINEAR_API_KEY` is read from the environment only and never committed.

## Conventions

Use concrete domain vocabulary, not Java-style or design-pattern names. Avoid
`Resolver`, `Manager`, `Handler`, `Helper`, `Util`, `Processor`, `Provider`,
`Coordinator`, `Strategy`, `Factory`, `AbstractFoo`, `FooImpl`, `IFoo` suffixes.
Prefer the concrete action (`lookup`, `fetch`, `check`, `parse`, `send`) over
vague verbs (`resolve`, `process`, `handle`, `perform`, `execute`).

Do only what the ticket requires. Don't add features, surrounding refactors,
one-use helpers, premature abstractions, or hypothetical future support.

Whenever user input triggers an action, use a native `<form onSubmit>`.
Do not implement submission with a button `onClick` or input keyboard handler.

Styling is Tailwind v4 + `basecoat-css` CSS only — never import Basecoat JS.
Theme tokens live in `src/web/theme.css`; project CSS only reads
`var(--color-*)`, `var(--spacing)`, `var(--text-*)`. Dark mode is `html.dark`.

## GitHub

Keep `gh` authenticated as `claudecafe`; check `gh auth status` before writes.
For commands requiring the user's permissions, use `minipai` only for that command:

    GH_TOKEN=$(gh auth token --user minipai) gh ...

Never use `gh auth switch`. Merge with `gh pr merge <n> --rebase`, never `--squash`.

Commit messages are always in English.

## Acceptance evidence

Feature-delivery evidence belongs on the matching Linear issue. Upload the validated recording,
screenshots, and written acceptance report there; embed media inline when Linear supports it. Read
the issue back after publishing to verify the evidence is present, and keep owner acceptance pending
until the owner confirms it.
