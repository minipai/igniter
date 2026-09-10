import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, unlinkSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_LINE_BYTES } from "./ndjson";
import { createHerdrSocket, HerdrRequestError, type HerdrSocket } from "./socket";

interface FakeRequest {
  id: string;
  method: string;
  params: unknown;
}

interface FakeServer {
  path: string;
  requests: FakeRequest[];
  sockets: Set<net.Socket>;
  stop: () => Promise<void>;
}

function freshSocketPath(): string {
  return join(mkdtempSync(join(tmpdir(), "herdr-test-")), "herdr.sock");
}

async function startFakeServer(
  onRequest: (req: FakeRequest, send: (message: unknown) => void, socket: net.Socket) => void,
  path = freshSocketPath(),
): Promise<FakeServer> {
  try {
    unlinkSync(path);
  } catch {
    // No stale socket; listen directly.
  }
  const requests: FakeRequest[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const req = JSON.parse(line) as FakeRequest;
        requests.push(req);
        onRequest(
          req,
          (message) => {
            socket.write(`${JSON.stringify(message)}\n`);
          },
          socket,
        );
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(path, resolve);
  });
  return {
    path,
    requests,
    sockets,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          try {
            unlinkSync(path);
          } catch {
            // Already gone.
          }
          resolve();
        });
      }),
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const fastReconnect = { reconnectInitialMs: 10, reconnectMaxMs: 50 };

const clients: HerdrSocket[] = [];
const servers: FakeServer[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.stop();
});

function trackClient(client: HerdrSocket): HerdrSocket {
  clients.push(client);
  return client;
}

async function trackServer(server: Promise<FakeServer>): Promise<FakeServer> {
  const started = await server;
  servers.push(started);
  return started;
}

function untrackServer(server: FakeServer): void {
  servers.splice(servers.indexOf(server), 1);
}

describe("call", () => {
  test("routes concurrent calls by id even when responses arrive out of order", async () => {
    const senders = new Map<string, (message: unknown) => void>();
    const server = await trackServer(
      startFakeServer((req, send) => {
        senders.set(req.id, send);
        if (senders.size === 2) {
          const ids = [...senders.keys()];
          const first = ids[0] as string;
          const second = ids[1] as string;
          senders.get(second)?.({ id: second, result: { type: "second" } });
          setTimeout(() => senders.get(first)?.({ id: first, result: { type: "first" } }), 20);
        }
      }),
    );
    const client = trackClient(createHerdrSocket({ socketPath: server.path }));
    const [first, second] = await Promise.all([
      client.call("custom.first", {}),
      client.call("custom.second", {}),
    ]);
    expect(first).toEqual({ type: "first" });
    expect(second).toEqual({ type: "second" });
  });

  test("throws HerdrRequestError on the error response shape", async () => {
    const server = await trackServer(
      startFakeServer((req, send) => {
        send({ id: req.id, error: { code: "agent_not_ready", message: "not ready" } });
      }),
    );
    const client = trackClient(createHerdrSocket({ socketPath: server.path }));
    const error = await client.call("agent.prompt", {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HerdrRequestError);
    expect((error as HerdrRequestError).code).toBe("agent_not_ready");
    expect((error as HerdrRequestError).message).toBe("not ready");
  });

  test("attributes empty-id errors to the call on that connection", async () => {
    const socketsByMethod = new Map<string, net.Socket>();
    const senders = new Map<string, (message: unknown) => void>();
    const server = await trackServer(
      startFakeServer((req, send, socket) => {
        socketsByMethod.set(req.method, socket);
        senders.set(req.method, send);
      }),
    );
    const client = trackClient(createHerdrSocket({ socketPath: server.path }));
    const first = client.call("custom.first", {});
    const second = client.call("custom.second", {});
    await waitFor(() => senders.size === 2);
    // Unparseable requests are answered with an empty id. Each connection
    // carries exactly one call, so the failure belongs to that call while
    // the other one is unaffected.
    socketsByMethod
      .get("custom.first")
      ?.write('{"id":"","error":{"code":"bad","message":"bad"}}\n');
    await expect(first).rejects.toBeInstanceOf(HerdrRequestError);
    const secondId = server.requests.find((req) => req.method === "custom.second")?.id;
    senders.get("custom.second")?.({ id: secondId, result: { type: "ok-second" } });
    await expect(second).resolves.toEqual({ type: "ok-second" });
  });

  test("reassembles a response split across socket reads", async () => {
    const server = await trackServer(startFakeServer(() => {}));
    const client = trackClient(createHerdrSocket({ socketPath: server.path }));
    const pending = client.call("ping", {});
    await waitFor(() => server.requests.length === 1);
    const payload = JSON.stringify({
      id: server.requests[0]?.id,
      result: { type: "pong", version: "x", protocol: 1 },
    });
    const [socket] = server.sockets;
    (socket as net.Socket).write(payload.slice(0, 10));
    await new Promise((resolve) => setTimeout(resolve, 20));
    (socket as net.Socket).write(`${payload.slice(10)}\n`);
    await expect(pending).resolves.toEqual({ type: "pong", version: "x", protocol: 1 });
  });

  test("opens a fresh connection per call", async () => {
    let connections = 0;
    const server = await trackServer(
      startFakeServer((req, send) => {
        connections += 1;
        send({ id: req.id, result: { type: "pong", version: "x", protocol: 1 } });
      }),
    );
    const client = trackClient(createHerdrSocket({ socketPath: server.path }));
    // The server answers exactly one request per connection, so sequential
    // calls must redial instead of reusing the first socket.
    await expect(client.call("ping", {})).resolves.toEqual({
      type: "pong",
      version: "x",
      protocol: 1,
    });
    await expect(client.call("ping", {})).resolves.toEqual({
      type: "pong",
      version: "x",
      protocol: 1,
    });
    expect(connections).toBe(2);
    expect(server.requests.map((req) => req.method)).toEqual(["ping", "ping"]);
  });

  test("ignores stray lines around the response", async () => {
    const server = await trackServer(startFakeServer(() => {}));
    const client = trackClient(createHerdrSocket({ socketPath: server.path }));
    const pending = client.call("ping", {});
    await waitFor(() => server.requests.length === 1);
    const id = server.requests[0]?.id;
    const [socket] = server.sockets;
    (socket as net.Socket).write(
      '\n{"event":"pane.agent_status_changed","data":{}}\n' +
        `${JSON.stringify({ id, result: { type: "pong", version: "x", protocol: 1 } })}\n`,
    );
    await expect(pending).resolves.toEqual({ type: "pong", version: "x", protocol: 1 });
  });

  test("rejects in-flight calls when the connection drops", async () => {
    const server = await trackServer(startFakeServer(() => {}));
    const client = trackClient(createHerdrSocket({ socketPath: server.path, ...fastReconnect }));
    const pending = client.call("ping", {});
    await waitFor(() => server.requests.length === 1);
    await server.stop();
    untrackServer(server);
    await expect(pending).rejects.toThrow("dropped");
  });

  test("queues calls made while disconnected and sends them after reconnect", async () => {
    const path = freshSocketPath();
    const client = trackClient(createHerdrSocket({ socketPath: path, ...fastReconnect }));
    const pending = client.call("ping", {});
    // No server listens yet, so the call waits for a connection.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const server = await trackServer(
      startFakeServer((req, send) => {
        send({ id: req.id, result: { type: "pong", version: "live", protocol: 1 } });
      }, path),
    );
    await expect(pending).resolves.toEqual({ type: "pong", version: "live", protocol: 1 });
    expect(server.requests.map((req) => req.method)).toEqual(["ping"]);
  });

  test("rejects the call when a frame never terminates", async () => {
    const server = await trackServer(startFakeServer(() => {}));
    const client = trackClient(createHerdrSocket({ socketPath: server.path }));
    const pending = client.call("ping", {});
    await waitFor(() => server.requests.length === 1);
    const [socket] = server.sockets;
    (socket as net.Socket).write(`{"id":"x","result":${"x".repeat(MAX_LINE_BYTES)}`);
    await expect(pending).rejects.toThrow("exceeded");
  });

  test("close rejects queued calls and stops reconnecting", async () => {
    const path = freshSocketPath();
    const client = createHerdrSocket({ socketPath: path, ...fastReconnect });
    clients.push(client);
    const pending = client.call("ping", {});
    client.close();
    await expect(pending).rejects.toThrow("closed");
    let connections = 0;
    const probe = net.createServer(() => {
      connections += 1;
    });
    await new Promise<void>((resolve) => probe.listen(path, resolve));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
    expect(connections).toBe(0);
  });
});

describe("subscribe", () => {
  test("streams events, then resubscribes and resyncs exactly once after reconnect", async () => {
    const path = freshSocketPath();
    let subscribes = 0;
    const behavior = (marker: string) => (req: FakeRequest, send: (message: unknown) => void) => {
      if (req.method === "events.subscribe") {
        subscribes += 1;
        send({ id: req.id, result: { type: "subscription_started" } });
      } else if (req.method === "session.snapshot") {
        send({ id: req.id, result: { type: "session_snapshot", snapshot: { marker } } });
      }
    };
    const first = await trackServer(startFakeServer(behavior("snap-1"), path));
    const client = trackClient(createHerdrSocket({ socketPath: path, ...fastReconnect }));
    const events: unknown[] = [];
    const resyncs: unknown[] = [];
    const unsubscribe = client.subscribe(
      [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }],
      {
        onEvent: (event) => {
          events.push(event);
        },
        onResync: (snapshot) => {
          resyncs.push(snapshot);
        },
      },
    );

    await waitFor(() => resyncs.length === 1);
    expect(resyncs[0]).toEqual({ marker: "snap-1" });
    expect(subscribes).toBe(1);

    const [firstSubSocket] = first.sockets;
    (firstSubSocket as net.Socket).write(
      '{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1"}}\n',
    );
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({
      event: "pane.agent_status_changed",
      data: { pane_id: "w1:p1" },
    });

    // Kill the server. The client must redial the same path, subscribe
    // exactly once more, and hand over a fresh snapshot exactly once.
    await first.stop();
    untrackServer(first);
    const second = await trackServer(startFakeServer(behavior("snap-2"), path));
    await waitFor(() => subscribes === 2);
    await waitFor(() => resyncs.length === 2);
    expect(resyncs[1]).toEqual({ marker: "snap-2" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(subscribes).toBe(2);
    expect(resyncs.length).toBe(2);

    const [secondSubSocket] = second.sockets;
    (secondSubSocket as net.Socket).write('{"event":"layout.updated","data":{}}\n');
    await waitFor(() => events.length === 2);
    expect(events[1]).toEqual({ event: "layout.updated", data: {} });
    unsubscribe();
  });

  test("unsubscribe stops reconnect attempts", async () => {
    const path = freshSocketPath();
    const first = await trackServer(
      startFakeServer((req, send) => {
        if (req.method === "events.subscribe") {
          send({ id: req.id, result: { type: "subscription_started" } });
        } else if (req.method === "session.snapshot") {
          send({ id: req.id, result: { type: "session_snapshot", snapshot: {} } });
        }
      }, path),
    );
    const client = trackClient(createHerdrSocket({ socketPath: path, ...fastReconnect }));
    let resyncs = 0;
    const unsubscribe = client.subscribe([{ type: "layout.updated" }], {
      onEvent: () => {},
      onResync: () => {
        resyncs += 1;
      },
    });
    await waitFor(() => resyncs === 1);
    unsubscribe();
    await first.stop();
    untrackServer(first);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(resyncs).toBe(1);
  });

  // A server that holds the first snapshot answer so the subscription
  // connection can be dropped while it is still in flight.
  async function startHoldingServer(path: string) {
    const state = {
      subscribes: 0,
      snapshots: 0,
      subSockets: [] as net.Socket[],
      held: [] as { send: (message: unknown) => void; id: string; socket: net.Socket }[],
    };
    const server = await trackServer(
      startFakeServer((req, send, socket) => {
        if (req.method === "events.subscribe") {
          state.subscribes += 1;
          state.subSockets.push(socket);
          send({ id: req.id, result: { type: "subscription_started" } });
        } else if (req.method === "session.snapshot") {
          state.snapshots += 1;
          if (state.snapshots === 1) {
            state.held.push({ send, id: req.id, socket });
          } else {
            send({ id: req.id, result: { type: "session_snapshot", snapshot: { marker: "fresh" } } });
          }
        }
      }, path),
    );
    return { server, state };
  }

  function trackSubscription(path: string) {
    const client = trackClient(createHerdrSocket({ socketPath: path, ...fastReconnect }));
    const events: unknown[] = [];
    const resyncs: unknown[] = [];
    const unsubscribe = client.subscribe([{ type: "layout.updated" }], {
      onEvent: (event) => {
        events.push(event);
      },
      onResync: (snapshot) => {
        resyncs.push(snapshot);
      },
    });
    return { unsubscribe, events, resyncs };
  }

  test("a stale snapshot answer does not resync a second time", async () => {
    const path = freshSocketPath();
    const { state } = await startHoldingServer(path);
    const { unsubscribe, resyncs } = trackSubscription(path);
    await waitFor(() => state.snapshots === 1);
    // Drop only the subscription connection while its snapshot is held.
    state.subSockets[0]?.destroy();
    // The replacement cycle subscribes and resyncs with fresh data.
    await waitFor(() => resyncs.length === 1);
    expect(resyncs[0]).toEqual({ marker: "fresh" });
    expect(state.subscribes).toBe(2);
    // The held answer finally arrives with pre-reconnect data: ignored.
    state.held[0]?.send({
      id: state.held[0]?.id,
      result: { type: "session_snapshot", snapshot: { marker: "stale" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(resyncs.length).toBe(1);
    expect(resyncs[0]).toEqual({ marker: "fresh" });
    expect(state.subscribes).toBe(2);
    unsubscribe();
  });

  test("a stale snapshot failure does not tear down the new connection", async () => {
    const path = freshSocketPath();
    const { state } = await startHoldingServer(path);
    const { unsubscribe, resyncs } = trackSubscription(path);
    await waitFor(() => state.snapshots === 1);
    state.subSockets[0]?.destroy();
    await waitFor(() => resyncs.length === 1);
    expect(state.subscribes).toBe(2);
    // The held call fails after the replacement already resynced: it must
    // not drop the healthy connection into a third cycle.
    const held = state.held[0];
    held?.socket.write(
      `${JSON.stringify({ id: held.id, error: { code: "gone", message: "gone" } })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(state.subscribes).toBe(2);
    expect(resyncs.length).toBe(1);
    unsubscribe();
  });

  test("an unterminated frame on the subscription drops and resubscribes", async () => {
    const path = freshSocketPath();
    let subscribes = 0;
    const subSockets: net.Socket[] = [];
    await trackServer(
      startFakeServer((req, send, socket) => {
        if (req.method === "events.subscribe") {
          subscribes += 1;
          subSockets.push(socket);
          send({ id: req.id, result: { type: "subscription_started" } });
        } else if (req.method === "session.snapshot") {
          send({ id: req.id, result: { type: "session_snapshot", snapshot: { marker: "ok" } } });
        }
      }, path),
    );
    const { unsubscribe, resyncs } = trackSubscription(path);
    await waitFor(() => resyncs.length === 1);
    expect(subscribes).toBe(1);
    // Flood the subscription without ever terminating the frame: the
    // client drops the wedged connection and resubscribes fresh.
    subSockets[0]?.write(`{"event":"x","data":${"y".repeat(MAX_LINE_BYTES)}`);
    await waitFor(() => subscribes === 2);
    await waitFor(() => resyncs.length === 2);
    expect(resyncs[1]).toEqual({ marker: "ok" });
    unsubscribe();
  });
});
