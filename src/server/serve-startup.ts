// Test seam for `igniter serve` startup: config load, API key load, port
// resolution, client construction, and handoff to the command-service
// starter. Production `serveCommand` (cli.ts) calls this with the real
// starter; tests inject fakes. No behavior lives here that the CLI did not
// already have: the failure order (config, key, client, port, starter) and the port
// priority (--port, IGNITER_PORT, config) match cli.ts exactly.

import { loadDispatchConfig, type DispatchConfig } from "../dispatch/config.ts";
import { LinearClient, requireLinearApiKey } from "../dispatch/linear.ts";

export interface ServeStartupRequest {
  repoRoot: string;
  /** Raw `--port` flag value; undefined when the flag is absent. */
  flagPort?: string;
  /** Raw `IGNITER_PORT` value; undefined when unset. */
  envPort?: string;
}

/** Flag beats environment beats config, exactly like the CLI before. */
export function resolveServePort(
  flagPort: string | undefined,
  envPort: string | undefined,
  configPort: number,
): number {
  const parsed = Number(flagPort ?? envPort ?? configPort);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid port: ${flagPort ?? envPort}`);
  }
  return parsed;
}

export interface ServeStarterArgs {
  repoRoot: string;
  config: DispatchConfig;
  client: LinearClient;
  port: number;
}

export interface ServeStartupDeps {
  loadConfig?: (repoRoot: string) => Promise<DispatchConfig>;
  loadKey?: () => string;
  makeClient?: (apiKey: string) => LinearClient;
}

export interface ServeShutdownState {
  handle?: { stop: () => Promise<void> };
  server?: { stop: () => void };
}

/** Install the shutdown path used by the foreground `igniter serve` process. */
export function installServeShutdown(state: ServeShutdownState): void {
  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      state.server?.stop();
      process.exit(1);
    }
    stopping = true;
    void (async () => {
      try {
        if (state.handle) await state.handle.stop();
        else state.server?.stop();
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

export async function prepareServe<H>(
  request: ServeStartupRequest,
  deps: ServeStartupDeps & { starter: (args: ServeStarterArgs) => Promise<H> },
): Promise<{ config: DispatchConfig; client: LinearClient; port: number; handle: H }> {
  const loadConfig = deps.loadConfig ?? loadDispatchConfig;
  const loadKey = deps.loadKey ?? (() => requireLinearApiKey());
  const makeClient = deps.makeClient ?? ((apiKey: string) => new LinearClient({ apiKey }));
  const config = await loadConfig(request.repoRoot);
  const apiKey = loadKey();
  const client = makeClient(apiKey);
  const port = resolveServePort(request.flagPort, request.envPort, config.listenPort);
  const handle = await deps.starter({ repoRoot: request.repoRoot, config, client, port });
  return { config, client, port, handle };
}
