# Igniter

Igniter watches Linear tickets, opens isolated Herdr workspaces, and coordinates
Build, Review, and Deliver workers through a local Bun service.

## Run

Install dependencies with Bun:

```bash
bun install
```

Set `LINEAR_API_KEY` in the environment, then start the API and web UI together:

```bash
bun run dev
```

The web UI runs at `http://localhost:5173` and the API at
`http://localhost:3457`. `--port` or `IGNITER_PORT` overrides the API port.

For the dispatch service without the development web server:

```bash
bun run serve
```

Igniter has no local database, seed data, or login screen. Stop it with
Ctrl-C or SIGTERM.

## Check

Run typechecking, Bun tests, and UI tests together:

```bash
bun run check
```
