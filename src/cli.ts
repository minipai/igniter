#!/usr/bin/env bun
import { loadDispatchConfig } from "./dispatch/config.ts";
import {
  type CommandCallOptions,
} from "./dispatch/claims.ts";
import { LinearClient, requireLinearApiKey } from "./dispatch/linear.ts";
import { bunGitRunner } from "./dispatch/worktrees.ts";
import { createHerdrWorkspaces } from "./dispatch/workspaces.ts";
import { API_PORT, WEB_PORT } from "./server/ports.ts";
import { startServer } from "./server/serve.ts";
import { startDispatchServe } from "./server/dispatch-serve.ts";

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
    throw new Error("`igniter serve --no-watch` was removed; `igniter serve` never starts a Linear watch");
  }
  const config = await loadDispatchConfig(repoRoot());
  const client = new LinearClient({ apiKey: requireLinearApiKey() });
  const root = repoRoot();
  const port = resolvePort(config.listenPort);
  let handle: Awaited<ReturnType<typeof startDispatchServe>> | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let stopping = false;
  const stop = () => {
    if (stopping) {
      server?.stop();
      process.exit(1);
    }
    stopping = true;
    void (async () => {
      try {
        if (handle) await handle.stop();
        else server?.stop();
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    handle = await startDispatchServe({
      repoRoot: root,
      config,
      client,
      workspaces: createHerdrWorkspaces(),
      git: bunGitRunner(),
      port,
      onServer: (started) => {
        server = started;
        console.log(`igniter serving on http://${config.listenHost}:${started.port} (commands only; no Linear watch)`);
      },
    });
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

/**
 * Dispatch commands run inside the serve process: forward argv over HTTP.
 * Workspace commands additionally forward the Herdr workspace id (never a
 * ticket: the server resolves it from igniter metadata) and the stdin
 * payload for `submit --input -`.
 */
async function forwardCommand(argv: string[], options: CommandCallOptions = {}): Promise<void> {
  const config = await loadDispatchConfig(repoRoot());
  const base = `http://${config.listenHost}:${config.listenPort}`;
  let res: Response;
  try {
    res = await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ argv, ...options }),
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

async function readStdin(): Promise<string> {
  return new Response(Bun.stdin.stream()).text();
}

function devCommand(): void {
  const port = resolvePort(API_PORT);
  // UI work must never read or mutate real tickets.
  const api = startServer({ port, hostname: "127.0.0.1" });
  const web = Bun.spawn(["bun", "vite", "--port", String(WEB_PORT), "--strictPort"], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  const stop = () => {
    api.stop();
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

const DISPATCH_COMMANDS = ["status", "start", "reconcile", "pause", "resume", "fail", "restart", "answer"];
const WORKSPACE_COMMANDS = ["state", "begin", "submit", "block", "unblock"];

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
    // door to the serve process.
    await forwardCommand(process.argv.slice(2));
  } else if (command !== undefined && WORKSPACE_COMMANDS.includes(command)) {
    // Workspace commands are thin clients: the Herdr workspace id (never
    // a ticket, never a key) rides along, and `submit --input -` carries
    // its JSON on stdin.
    if (process.env["HERDR_ENV"] !== "1" || !process.env["HERDR_WORKSPACE_ID"]) {
      console.error(`igniter ${command} runs inside a Herdr workspace only (HERDR_ENV=1, HERDR_WORKSPACE_ID set)`);
      process.exit(1);
    }
    const options: CommandCallOptions = { workspaceId: process.env["HERDR_WORKSPACE_ID"] };
    if (command === "submit") {
      options.input = await readStdin();
    }
    await forwardCommand(process.argv.slice(2), options);
  } else {
    console.error("usage: igniter <serve|dev|status|start|reconcile|pause|resume|fail|restart|answer|state|begin|submit|block|unblock> [--port N]");
    console.error("  serve [--port N]");
    console.error("  status");
    console.error("  start <ticket> [--builder <model>]");
    console.error("  reconcile <ticket>");
    console.error("  pause <ticket> | resume <ticket>");
    console.error("  fail <ticket> --reason TEXT");
    console.error("  restart <ticket> --builder <model>");
    console.error("  answer <ticket> y|n");
    console.error("  state --json");
    console.error("  begin");
    console.error("  submit --input -");
    console.error("  block --reason TEXT | unblock");
    console.error("  --version, -v");
    process.exit(1);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
