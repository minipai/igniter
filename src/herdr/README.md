# Herdr socket client

Thin TypeScript client for the Herdr unix socket, shared by the igniter
dispatch and the web server. No third-party dependencies.

- `socket.ts` — `createHerdrSocket({ socketPath })` with `call` and `subscribe`.
- `ndjson.ts` — the newline-delimited JSON the socket speaks.
- `socket-path.ts` — `lookupSocketPath()` for finding the socket.
- `herdr-api.d.ts` — generated types (committed). Regenerate with
  `bun src/herdr/generate-types.ts` (`--check` to verify freshness).

## Wire protocol (verified against Herdr 0.8.2, protocol 20)

Framing is newline-delimited JSON in both directions: one JSON value
followed by `\n` per frame. Verified by sending
`{"id":"t1","method":"ping","params":{}}\n` at the raw socket and reading
back one JSON line ending in `\n`.

- Request: `{"id","method","params"}`. The `id` is client-chosen.
- Success: `{"id","result"}` where `result` is a tagged object
  (`{"type":"pong",...}`, `{"type":"session_snapshot",...}`, ...).
- Error: `{"id","error":{"code","message"}}`. Requests the server cannot
  parse (unknown method, missing params) are answered with an **empty**
  `id` (`{"id":"",...}`), so that failure cannot be matched to a request.
  Every call has its own dedicated connection carrying exactly one
  request, so an empty-id error on that connection can only belong to
  that call.
- `events.subscribe` is answered once with
  `{"id","result":{"type":"subscription_started"}}`. Afterwards the
  connection streams `{"event","data"}` frames, e.g.
  `{"event":"pane.agent_status_changed","data":{...}}` after
  `herdr pane report-metadata` on a subscribed pane.
- One subscription per connection: a second `events.subscribe` on the
  same connection is never answered, and further requests (e.g.
  `session.snapshot`) on a subscribed connection are never answered
  either.
- One request per call connection: the server answers the first request
  on a connection and never a second one, even sent after the first
  response arrived (verified: ping then `session.snapshot` on one socket
  leaves the snapshot unanswered). The client therefore dials a fresh
  connection for every `call` and subscribes on a dedicated connection,
  fetching the resync snapshot over the call path.
- Subscribing with an empty list is acknowledged but delivers no events.

## Reconnect policy

- Calls that never left this process (the server is unreachable) are
  retried on fresh connections with backoff until they go through;
  they are never dropped silently.
- Once a request has been written, a dropped connection fails the call
  loudly, because it may or may not have run server-side and resending
  could repeat a non-idempotent method.
- A dropped subscription redials with backoff, subscribes exactly once
  on the fresh connection, then fetches `session.snapshot` and calls
  `onResync` exactly once. Events that happened while disconnected are
  lost by the server and are not replayed.

## Socket path

`HERDR_SOCKET_PATH` when set, otherwise the `server.socket` value from
`herdr status` (on this machine `/Users/art/.config/herdr/herdr.sock`).
