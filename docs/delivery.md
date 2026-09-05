# igniter delivery settings (dogfood)

Project settings for Commander runs against this repository. Format and
defaults are defined in `src/commander/rules.md`. Sections not listed here fall
back to the defaults there.

## Run

- Start from the repo root: `bun src/cli.ts dev`. It spawns the API server
  and Vite together; both stop on SIGINT/SIGTERM.
- Ports: web `http://localhost:5173`, API `http://localhost:3457`
  (`--port` / `IGNITER_PORT` overrides the API port).
- Base URLs: web UI `http://localhost:5173`, health check
  `http://localhost:3457/api/health`.
- Environment: `LINEAR_API_KEY` is read from the environment only and never
  lands in the repo. No other secrets are needed.
- Seed data: none. The server keeps no database; Linear state is live.
- Login: none locally. The factory host is reached over Tailscale; the app
  itself has no login screen.
- Shutdown: Ctrl-C / SIGTERM the dev command; it stops both processes.

## Checks

- `bun run check` (typecheck plus `bun test src/server` plus vitest).
- All of it is mandatory and green before review.

## Acceptance

- Method: `browser`. Drive the web UI with agent-browser and record the run.
- Evidence goes on the Linear issue, media embedded inline, with a written
  acceptance report covering each acceptance criterion.
- Validate the recording with `ffprobe` and frame inspection before
  publishing, per the Commander rules.

## Risk areas

- Credential and secret handling, notably anything reading `LINEAR_API_KEY`.
- Authentication and session code paths.
- Data-model and migration-style changes to on-disk or stored state.

A diff touching these pauses the run for the owner.

## Stages

No skips, no added steps. Every run goes through full review and a recorded
acceptance.

## Conventions

See AGENTS.md. In short:

- Branch per ticket: `feature/<ticket>-<slug>`, one commit per ticket.
- English commit messages, authored by the maid currently on duty (see
  AGENTS.md), no Co-Authored-By trailer.
- No GitHub pull requests. Review is a diffwalk walk: `diffwalk inspect` on
  the ticket commit, author the explanations, `diffwalk check`,
  `diffwalk publish`, and put the printed link on the Linear issue.
- Landing: rebase the commit onto local `main`. Do not push; the owner
  pushes.
- Owner accepts by moving the ticket to Ready to merge in Linear.
