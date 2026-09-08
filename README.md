# Igniter

Igniter exposes ticket-targeted Linear and Herdr commands through a local Bun
service. A Global Commander chooses each ticket and coordinates its Build,
Review, and Deliver workers; no background loop scans or claims the project.

## Run

Install dependencies with Bun:

```bash
bun install
```

Set `LINEAR_API_KEY` in the environment, then start the Global Commander:

```bash
igniter start
```

`igniter start STA-123` also assigns a ticket. When the command service is not
running, `start` launches it in the background before opening the Commander in
the current terminal. Run `bun run serve` when the service should stay under
separate process supervision.

Linear is the project UI and source of truth. The service validates its Linear
configuration once, then makes no background Linear requests. Commands such as
`igniter status`, `igniter begin STA-123`, and `igniter reconcile STA-123` make
their own explicit requests and return their failures directly.

Igniter has no Web UI, local database, seed data, or login screen. Stop a
foreground service with Ctrl-C or SIGTERM.

## Check

Run typechecking and Bun tests together:

```bash
bun run check
```
