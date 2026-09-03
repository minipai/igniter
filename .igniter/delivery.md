# igniter delivery record (dogfood)

How this repo ships, for the factory to follow once the runner exists.
Full format arrives with STA-168.

- Branch per ticket: `feature/<ticket>-<slug>`, one commit per ticket.
- `bun run check` (typecheck + bun test + vitest) is green before review.
- No GitHub PR. Review is a diffwalk walk: `diffwalk inspect` on the ticket
  commit, author the explanations, `diffwalk check`, `diffwalk publish`, and
  put the printed link on the Linear issue.
- Owner accepts in Linear by moving the ticket to Ready to merge; the web page only shows running tickets.
- Landing: rebase the commit onto local `main`. Do not push; the owner pushes.
