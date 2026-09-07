# Igniter

Igniter exposes ticket-targeted Linear and Herdr commands through a local Bun
service. A Global Commander chooses each ticket and coordinates its Build,
Review, and Deliver workers; no background loop scans or claims the project.

## Run

Install dependencies with Bun:

```bash
bun install
```

Start the development web UI and its credential-free API together:

```bash
bun run dev
```

The web UI runs at `http://localhost:5173` and the UI API at
`http://localhost:3457`. Development mode never reads or changes Linear.

For the command service, set `LINEAR_API_KEY` in the environment and run:

```bash
bun run serve
```

The service validates its Linear configuration once, then makes no background
Linear requests. Commands such as `igniter status`, `igniter start STA-123`,
and `igniter reconcile STA-123` make their own explicit requests and return
their failures directly.

Igniter has no local database, seed data, or login screen. Stop it with
Ctrl-C or SIGTERM.

## Check

Run typechecking, Bun tests, and UI tests together:

```bash
bun run check
```
