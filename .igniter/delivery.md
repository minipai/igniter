# igniter delivery record (dogfood)

How this repo ships, for the factory to follow once the runner exists.
Full format arrives with STA-168.

- Branch per ticket: `feature/<ticket>-<slug>`.
- `bun run check` (typecheck + bun test + vitest) is green before review.
- Owner accepts in the web board; Commander sets Linear to Ready to merge.
