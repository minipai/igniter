import { createApp } from "./app";
import type { DispatchApi } from "../dispatch/claims";
import type { BoardHub, BoardSnapshot } from "./board";
import { API_PORT } from "./ports";

/**
 * Bun kills a connection idle longer than this (seconds, max 255). The SSE
 * heartbeat must beat well inside it or /events dies before its first beat
 * (the 10s default did exactly that with a 15s heartbeat).
 */
export const SSE_IDLE_TIMEOUT_S = 60;

export interface ServeOptions {
  port?: number;
  hostname?: string;
  distDir?: string;
  dispatch?: DispatchApi;
  board?: () => Promise<BoardSnapshot | null>;
  hub?: BoardHub;
  /** Heartbeat under test: production uses the 15s default. */
  heartbeatMs?: number;
}

export function startServer(options: ServeOptions = {}) {
  const port = options.port ?? API_PORT;
  const distDir = options.distDir ?? "dist";
  const server = Bun.serve({
    port,
    hostname: options.hostname,
    idleTimeout: SSE_IDLE_TIMEOUT_S,
    fetch: createApp({
      distDir,
      dispatch: options.dispatch,
      board: options.board,
      hub: options.hub,
      heartbeatMs: options.heartbeatMs,
    }),
  });
  return server;
}
