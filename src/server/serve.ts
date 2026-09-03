import { createApp } from "./app";
import { API_PORT } from "./ports";

export interface ServeOptions {
  port?: number;
  distDir?: string;
}

export function startServer(options: ServeOptions = {}) {
  const port = options.port ?? API_PORT;
  const distDir = options.distDir ?? "dist";
  const server = Bun.serve({
    port,
    fetch: createApp({ distDir }),
  });
  return server;
}
