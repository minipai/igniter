#!/usr/bin/env bun
import { loadDispatchConfig } from "./dispatch/config.ts";
import {
  createClaimLock,
  createDispatchLog,
  readActivityTail,
  validateWithRetry,
  validateStartup,
  startWatch,
  defaultHost,
  Watcher,
  type DispatchApi,
  type ResolvedDispatch,
  type WatchHandle,
} from "./dispatch/claims.ts";
import { createWorkspaceSink, runCommand } from "./dispatch/commands.ts";
import { createHerdrWorkspaces } from "./dispatch/workspaces.ts";
import { LinearClient, requireLinearApiKey } from "./dispatch/linear.ts";
import { API_PORT, WEB_PORT } from "./server/ports.ts";
import { startServer } from "./server/serve.ts";
import { runStage } from "./stage/stage.ts";

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const raw = index >= 0 ? process.argv[index + 1] : undefined;
  return raw && !raw.startsWith("--") ? raw : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function resolvePort(configPort: number): number {
  const fromFlag = flagValue("--port");
  const fromEnv = process.env["IGNITER_PORT"];
  const parsed = Number(fromFlag ?? fromEnv ?? configPort);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid port: ${fromFlag ?? fromEnv}`);
  }
  return parsed;
}

function repoRoot(): string {
  return process.cwd();
}

async function serveCommand(): Promise<void> {
  if (hasFlag("--no-watch")) {
    // UI-only mode: still honor the configured bind address, never 0.0.0.0.
    const configPath = `${repoRoot()}/.igniter/config.yaml`;
    const config = (await Bun.file(configPath).exists()) ? await loadDispatchConfig(repoRoot()) : null;
    const host = config?.listenHost ?? "127.0.0.1";
    const port = resolvePort(config?.listenPort ?? API_PORT);
    const server = startServer({ port, hostname: host });
    console.log(`igniter serving on http://${host}:${server.port} (watch disabled)`);
    return;
  }
  // File-level config errors fail fast here, before the server starts.
  const config = await loadDispatchConfig(repoRoot());
  const client = new LinearClient({ apiKey: requireLinearApiKey() });
  const port = resolvePort(config.listenPort);
  const logPath = `${repoRoot().replace(/\/+$/, "")}/.igniter/dispatch.log`;
  const decisions = createDispatchLog(logPath);
  const workspaces = createHerdrWorkspaces();
  const claimLock = createClaimLock();

  // The server starts before Linear validation finishes (an unreachable
  // Linear retries while the web UI stays up), so the dispatch behind the
  // routes fills in once validation succeeds.
  const holder: { current?: Watcher } = {};
  const root = repoRoot();
  const host = defaultHost();
  const sink = createWorkspaceSink({
    workspaces,
    config,
    repoRoot: root,
  });
  const dispatch: DispatchApi = {
    queue: () => {
      const watcher = holder.current;
      return watcher ? { lastPollAt: watcher.lastPollAt, order: watcher.lastQueue } : { lastPollAt: null, order: [] };
    },
    activity: (limit) => readActivityTail(logPath, limit),
    command: (argv: string[]) => {
      const watcher = holder.current;
      if (!watcher) return Promise.resolve({ ok: false, text: "dispatch still starting; retry shortly" });
      const resolved = watcher.resolved;
      return claimLock(() =>
        runCommand(argv, {
          client,
          resolved,
          host,
          decisions,
          workspaces,
          sink,
          repoRoot: root,
          lastPollAt: () => watcher.lastPollAt,
        }),
      );
    },
  };
  const server = startServer({ port, hostname: config.listenHost, dispatch });
  console.log(`igniter serving on http://${config.listenHost}:${server.port} (watching ${config.project})`);
  let watch: WatchHandle | null = null;
  let stopping = false;
  const stop = () => {
    if (stopping) {
      server.stop();
      process.exit(1);
    }
    stopping = true;
    void (async () => {
      try {
        await watch?.stop();
      } finally {
        server.stop();
        process.exit(0);
      }
    })();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // An unreachable Linear is not a configuration error: the server stays up
  // and validation retries until Linear answers. Unknown statuses, teams, or
  // projects still exit 1 immediately.
  let resolved: ResolvedDispatch;
  try {
    resolved = await validateWithRetry(() => validateStartup(client, config), {
      maxAttempts: Number.POSITIVE_INFINITY,
      baseDelayMs: 5000,
      onRetry: (attempt, error) => {
        console.error(`Linear unreachable (attempt ${attempt}): ${error.message}; retrying — web UI stays up`);
      },
    });
  } catch (error) {
    console.error((error as Error).message);
    server.stop();
    process.exit(1);
  }
  const watcher = new Watcher({
    client,
    resolved,
    host,
    decisions,
    workspaces,
    sink,
  });
  holder.current = watcher;
  // The watch loop and the commands share the watcher — and the lock — so
  // there is ever exactly one claimant in the process.
  watch = startWatch({ watcher, lock: claimLock });
  console.log(`watch live: claiming from ${config.states.queued}`);
}

/** Dispatch commands run inside the serve process: forward argv over HTTP. */
async function forwardCommand(argv: string[]): Promise<void> {
  const config = await loadDispatchConfig(repoRoot());
  const base = `http://${config.listenHost}:${config.listenPort}`;
  let res: Response;
  try {
    res = await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ argv }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    console.error(
      `no dispatch server at ${config.listenHost}:${config.listenPort} — start it with \`igniter serve\` first`,
    );
    process.exit(1);
  }
  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    text?: string;
  };
  const ok = res.ok && payload.ok === true;
  const text = payload.text ?? `command failed with HTTP ${res.status}`;
  if (ok) {
    console.log(text);
    return;
  }
  console.error(text);
  process.exit(1);
}

function devCommand(): void {
  const port = resolvePort(API_PORT);
  // UI work must never move real tickets: dev serves the API without the watch.
  const api = Bun.spawn(["bun", "src/cli.ts", "serve", "--no-watch", "--port", String(port)], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  const web = Bun.spawn(["bun", "vite", "--port", String(WEB_PORT), "--strictPort"], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  const stop = () => {
    api.kill();
    web.kill();
  };
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
}

const DISPATCH_COMMANDS = ["status", "start", "pause", "resume", "fail", "restart"];

async function versionCommand(): Promise<void> {
  const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
    version: string;
  };
  console.log(pkg.version);
}

const command = process.argv[2];
try {
  if (command === "--version" || command === "-v") {
    await versionCommand();
  } else if (command === "serve") {
    await serveCommand();
  } else if (command === "dev") {
    devCommand();
  } else if (command !== undefined && DISPATCH_COMMANDS.includes(command)) {
    // Dispatch commands never run locally: they go through the one HTTP
    // door to the serve process. `stage` (with its pause/resume steps)
    // stays local: the Commander runs it inside the Herdr pane.
    await forwardCommand(process.argv.slice(2));
  } else if (command === "stage") {
    process.exit(await runStage(["stage", ...process.argv.slice(3)]));
  } else {
    console.error("usage: igniter <serve|dev|status|start|stage|pause|resume|fail|restart> [--port N]");
    console.error("  serve [--no-watch] [--port N]");
    console.error("  status");
    console.error("  start <ticket> [--agent <kind>] [--builder <model>]");
    console.error("  pause <ticket> | resume <ticket>");
    console.error("  fail <ticket> --reason TEXT");
    console.error("  restart <ticket> --builder <model>");
    console.error("  stage <plan|build|verify|acceptance|failed|pause|resume> [--reason TEXT]");
    console.error("  --version, -v");
    process.exit(1);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
