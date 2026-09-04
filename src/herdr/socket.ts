import net from "node:net";
import { encodeLine, MAX_LINE_BYTES, splitLines } from "./ndjson.ts";
import type {
  HerdrMethod,
  HerdrMethodTable,
  HerdrParams,
  HerdrResults,
  HerdrStreamEvent,
} from "./herdr-api.js";

// Thin client for the Herdr unix socket. The server answers exactly one
// request per connection, so every `call` dials a fresh connection;
// each `subscribe` holds its own long-lived connection.

export class HerdrRequestError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrRequestError";
    this.code = code;
  }
}

export interface HerdrSocketOptions {
  socketPath: string;
  /** First reconnect delay. Defaults to 100ms. */
  reconnectInitialMs?: number;
  /** Reconnect delay cap. Defaults to 2000ms. */
  reconnectMaxMs?: number;
}

export interface SubscribeCallbacks {
  onEvent: (event: HerdrStreamEvent) => void;
  onResync: (snapshot: HerdrResults.SessionSnapshot["snapshot"]) => void;
}

interface PendingCall {
  id: string;
  line: string;
  /** True once written to a live socket. Written calls are never retried. */
  sent: boolean;
  socket: net.Socket | null;
  timer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface HerdrSocket {
  call<M extends HerdrMethod>(
    method: M,
    params: HerdrMethodTable[M]["params"],
  ): Promise<HerdrMethodTable[M]["result"]>;
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  subscribe(
    subscriptions: HerdrParams.Subscription[],
    callbacks: SubscribeCallbacks,
  ): () => void;
  close(): void;
}

const RECONNECT_INITIAL_MS = 100;
const RECONNECT_MAX_MS = 2000;

function reconnectDelay(attempt: number, initial: number, max: number): number {
  return Math.min(initial * 2 ** attempt, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function createHerdrSocket(options: HerdrSocketOptions): HerdrSocket {
  const socketPath = options.socketPath;
  const reconnectInitialMs = options.reconnectInitialMs ?? RECONNECT_INITIAL_MS;
  const reconnectMaxMs = options.reconnectMaxMs ?? RECONNECT_MAX_MS;

  let idCounter = 0;
  const nextId = (): string => `c${(idCounter += 1)}`;

  let closed = false;
  const pending = new Map<string, PendingCall>();

  const sessions = new Set<SubscribeSession>();

  function closedError(): Error {
    return new Error("herdr socket is closed");
  }

  function disconnectError(): Error {
    return new Error("herdr connection dropped before a response arrived");
  }

  function requestError(message: Record<string, unknown>): HerdrRequestError {
    const body = message["error"] as Record<string, unknown>;
    return new HerdrRequestError(
      String(body["code"] ?? "unknown"),
      String(body["message"] ?? ""),
    );
  }

  function settleCall(entry: PendingCall, message: Record<string, unknown>): void {
    pending.delete(entry.id);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.socket?.destroy();
    entry.socket = null;
    if (isRecord(message["error"])) {
      entry.reject(requestError(message));
    } else if ("result" in message) {
      entry.resolve(message["result"]);
    } else {
      entry.reject(new Error("malformed herdr response (neither result nor error)"));
    }
  }

  function redial(entry: PendingCall): void {
    if (!pending.has(entry.id)) return;
    if (closed) {
      pending.delete(entry.id);
      entry.reject(closedError());
      return;
    }
    const socket = net.createConnection(socketPath);
    entry.socket = socket;
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("connect", () => {
      if (!pending.has(entry.id)) {
        socket.destroy();
        return;
      }
      socket.write(entry.line);
      entry.sent = true;
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) {
        // A peer that never terminates a frame is wedged: fail loudly
        // instead of growing the buffer without bound.
        pending.delete(entry.id);
        entry.socket = null;
        socket.destroy();
        entry.reject(
          new Error(`herdr message exceeded ${MAX_LINE_BYTES} bytes; dropping connection`),
        );
        return;
      }
      const { lines, rest } = splitLines(buffer);
      buffer = rest;
      for (const line of lines) {
        if (!line || !pending.has(entry.id)) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          // One corrupt line must not desynchronize the stream.
          continue;
        }
        if (!isRecord(message)) continue;
        // Each connection carries exactly one call. It is settled by the
        // response echoing its id, or by an error frame with an empty or
        // missing id (the server's answer to unparseable requests).
        const id = message["id"];
        if (id === entry.id || ((id === "" || id === undefined) && isRecord(message["error"]))) {
          settleCall(entry, message);
          return;
        }
        // Anything else (unknown ids, stray event lines) is ignored.
      }
    });
    const fail = (): void => {
      socket.destroy();
      if (!pending.has(entry.id) || entry.timer) return;
      if (entry.sent) {
        // The request may have run server-side, so fail loudly instead of
        // risking a duplicate run on a fresh connection.
        pending.delete(entry.id);
        entry.reject(disconnectError());
      } else if (closed) {
        pending.delete(entry.id);
        entry.reject(closedError());
      } else {
        // Never left this process: wait and redial a fresh connection.
        const delay = reconnectDelay(entry.attempt, reconnectInitialMs, reconnectMaxMs);
        entry.attempt += 1;
        entry.timer = setTimeout(() => {
          entry.timer = null;
          redial(entry);
        }, delay);
      }
    };
    socket.on("error", fail);
    socket.on("close", fail);
  }

  function callImpl(method: string, params: unknown): Promise<unknown> {
    if (closed) return Promise.reject(closedError());
    const id = nextId();
    const line = encodeLine({ id, method, params });
    // One promise per call, returned directly: close() and the redial loop
    // settle exactly this object, so no rejection can escape unhandled.
    const done = new Promise<unknown>((resolve, reject) => {
      const entry: PendingCall = {
        id,
        line,
        sent: false,
        socket: null,
        timer: null,
        attempt: 0,
        resolve,
        reject,
      };
      pending.set(id, entry);
      redial(entry);
    });
    return done;
  }

  function call<M extends HerdrMethod>(
    method: M,
    params: HerdrMethodTable[M]["params"],
  ): Promise<HerdrMethodTable[M]["result"]>;
  function call(method: string, params: Record<string, unknown>): Promise<unknown>;
  function call(method: string, params: unknown): Promise<unknown> {
    return callImpl(method, params);
  }

  function subscribe(
    subscriptions: HerdrParams.Subscription[],
    callbacks: SubscribeCallbacks,
  ): () => void {
    if (closed) throw new Error("herdr socket is closed");
    const session = new SubscribeSession(
      socketPath,
      subscriptions,
      callbacks,
      nextId,
      (method, params) => callImpl(method, params),
      reconnectInitialMs,
      reconnectMaxMs,
    );
    sessions.add(session);
    session.start();
    return () => {
      sessions.delete(session);
      session.stop();
    };
  }

  function close(): void {
    if (closed) return;
    closed = true;
    // Remove first so the sockets torn down below cannot redial or
    // settle through the fail handlers when their close events fire.
    for (const entry of [...pending.values()]) {
      pending.delete(entry.id);
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.socket?.destroy();
      entry.socket = null;
      entry.reject(closedError());
    }
    for (const session of sessions) session.stop();
    sessions.clear();
  }

  return { call, subscribe, close };
}

class SubscribeSession {
  private socket: net.Socket | null = null;
  private buffer = "";
  private stopped = false;
  private subscribeId: string | null = null;
  private acked = false;
  // Generation of the current connect() cycle. The snapshot fetch runs on
  // its own connection, decoupled from the subscription socket, so its
  // continuation must prove it still belongs to this generation before
  // touching the session.
  private cycle = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  constructor(
    private readonly socketPath: string,
    private readonly subscriptions: HerdrParams.Subscription[],
    private readonly callbacks: SubscribeCallbacks,
    private readonly nextId: () => string,
    private readonly snapshot: (method: string, params: unknown) => Promise<unknown>,
    private readonly reconnectInitialMs: number,
    private readonly reconnectMaxMs: number,
  ) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.cycle += 1;
    const cycle = this.cycle;
    const socket = net.createConnection(this.socketPath);
    socket.setEncoding("utf8");
    this.socket = socket;
    this.buffer = "";
    this.acked = false;
    this.subscribeId = this.nextId();
    const subscribeLine = encodeLine({
      id: this.subscribeId,
      method: "events.subscribe",
      params: { subscriptions: this.subscriptions },
    });
    socket.on("connect", () => {
      if (!this.stopped) socket.write(subscribeLine);
    });
    socket.on("data", (chunk: string) => {
      if (cycle !== this.cycle) return;
      this.buffer += chunk;
      if (this.buffer.length > MAX_LINE_BYTES) {
        // Wedged peer: drop the connection and resubscribe fresh rather
        // than growing the buffer without bound.
        this.buffer = "";
        this.drop();
        return;
      }
      const { lines, rest } = splitLines(this.buffer);
      this.buffer = rest;
      for (const line of lines) {
        if (!line) continue;
        try {
          this.routeMessage(JSON.parse(line) as unknown, cycle);
        } catch {
          // One corrupt line must not desynchronize the stream.
        }
      }
    });
    socket.on("error", () => {
      this.drop();
    });
    socket.on("close", () => {
      this.drop();
    });
  }

  private routeMessage(message: unknown, cycle: number): void {
    if (!isRecord(message) || this.stopped || cycle !== this.cycle) return;
    // The subscribe ack carries our id; everything else with an `event`
    // key is a streamed subscription_event or event frame.
    if (typeof message["id"] === "string" && message["id"] === this.subscribeId) {
      if (!this.acked) {
        this.acked = true;
        void this.handleSubscribed(message, cycle);
      }
      return;
    }
    if (typeof message["event"] === "string") {
      this.callbacks.onEvent({ event: message["event"], data: message["data"] });
    }
  }

  private async handleSubscribed(
    message: Record<string, unknown>,
    cycle: number,
  ): Promise<void> {
    const result = message["result"];
    if (!isRecord(result) || result["type"] !== "subscription_started") {
      // Rejected (or malformed): back off and try a fresh connection.
      this.drop();
      return;
    }
    try {
      const envelope = (await this.snapshot("session.snapshot", {})) as Record<string, unknown>;
      // The snapshot ran on its own connection: ignore it unless this
      // cycle is still current, so a stale answer can neither resync
      // twice nor tear down a healthy replacement.
      if (this.stopped || cycle !== this.cycle) return;
      this.reconnectAttempt = 0;
      this.callbacks.onResync(
        (envelope["snapshot"] ?? envelope) as HerdrResults.SessionSnapshot["snapshot"],
      );
    } catch {
      if (!this.stopped && cycle === this.cycle) this.drop();
    }
  }

  private drop(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.subscribeId = null;
    if (this.stopped || this.reconnectTimer) return;
    this.cycle += 1;
    const delay = reconnectDelay(this.reconnectAttempt, this.reconnectInitialMs, this.reconnectMaxMs);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
