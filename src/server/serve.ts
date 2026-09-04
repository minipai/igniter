import { createApp } from "./app";
import type { DispatchApi } from "../dispatch/claims";
import { API_PORT } from "./ports";

export interface ServeOptions {
  port?: number;
  hostname?: string;
  distDir?: string;
  dispatch?: DispatchApi;
}

export function startServer(options: ServeOptions = {}) {
  const port = options.port ?? API_PORT;
  const distDir = options.distDir ?? "dist";
  const server = Bun.serve({
    port,
    hostname: options.hostname,
    fetch: createApp({ distDir, dispatch: options.dispatch }),
  });
  return server;
}
