#!/usr/bin/env bun
import { findProjectRoot, loadDispatchConfig } from "./dispatch/config.ts";
import {
  type CommandCallOptions,
} from "./dispatch/claims.ts";
import { LinearClient, requireLinearApiKey } from "./dispatch/linear.ts";
import { bunGitRunner } from "./dispatch/worktrees.ts";
import { createHerdrWorkspaces } from "./dispatch/workspaces.ts";
import { startDispatchServe } from "./server/dispatch-serve.ts";
import { installServeShutdown, prepareServe, type ServeShutdownState } from "./server/serve-startup.ts";
import { autoStartServe } from "./server/auto-start.ts";

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const raw = index >= 0 ? process.argv[index + 1] : undefined;
  return raw && !raw.startsWith("--") ? raw : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function repoRoot(): string {
  return process.cwd();
}

/**
 * Project root for `igniter start`: the nearest ancestor of the calling
 * directory holding `.igniter/config.yaml`. Every other dispatch command
 * keeps the historical cwd behavior; only `start` searches upward, so a
 * subdirectory launch serves the enclosing project. Throws a clear error
 * (no serve, no agent) when no ancestor holds a config.
 */
async function startProjectRoot(): Promise<string> {
  return findProjectRoot(process.cwd());
}

interface CommanderForegroundLaunch {
  kind: "commander_foreground";
  command: string[];
  cwd: string;
}

function commanderForeground(data: unknown): CommanderForegroundLaunch | null {
  if (typeof data !== "object" || data === null) return null;
  const launch = data as Partial<CommanderForegroundLaunch>;
  if (
    launch.kind !== "commander_foreground" ||
    !Array.isArray(launch.command) ||
    launch.command.length === 0 ||
    !launch.command.every((part) => typeof part === "string") ||
    typeof launch.cwd !== "string"
  ) return null;
  return launch as CommanderForegroundLaunch;
}

async function serveCommand(): Promise<void> {
  if (hasFlag("--no-watch")) {
    throw new Error("`igniter serve --no-watch` was removed; `igniter serve` never starts a Linear watch");
  }
  const root = repoRoot();
  const shutdown: ServeShutdownState = {};
  installServeShutdown(shutdown);
  try {
    const started = await prepareServe(
      { repoRoot: root, flagPort: flagValue("--port"), envPort: process.env["IGNITER_PORT"] },
      {
        loadConfig: loadDispatchConfig,
        loadKey: () => requireLinearApiKey(),
        makeClient: (apiKey) => new LinearClient({ apiKey }),
        starter: ({ repoRoot, config, client, port }) => startDispatchServe({
          repoRoot,
          config,
          client,
          workspaces: createHerdrWorkspaces(),
          git: bunGitRunner(),
          port,
          onServer: (startedServer) => {
            shutdown.server = startedServer;
            console.log(`igniter serving on http://${config.listenHost}:${startedServer.port} (commands only; no Linear watch)`);
          },
        }),
      },
    );
    shutdown.handle = started.handle;
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

/**
 * Dispatch commands run inside the serve process: forward argv over HTTP.
 * Ticket commands always carry an explicit ticket and never forward Herdr
 * workspace metadata. `start` requests a foreground launch; `submit`
 * forwards its stdin payload.
 */
async function forwardCommand(argv: string[], options: CommandCallOptions = {}): Promise<void> {
  const root = argv[0] === "start" ? await startProjectRoot() : repoRoot();
  const config = await loadDispatchConfig(root);
  const base = `http://${config.listenHost}:${config.listenPort}`;
  const post = () => fetch(`${base}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ argv, ...options }),
    signal: AbortSignal.timeout(30_000),
  });
  let res: Response;
  try {
    res = await post();
  } catch {
    if (argv[0] !== "start") {
      console.error(
        `no dispatch server at ${config.listenHost}:${config.listenPort} — start it with \`igniter serve\` first`,
      );
      process.exit(1);
    }
    try {
      await autoStartServe({
        base,
        repoRoot: root,
        bunPath: process.execPath,
        cliPath: import.meta.path,
      });
      res = await post();
    } catch (error) {
      console.error((error as Error).message);
      process.exit(1);
    }
  }
  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    text?: string;
    data?: unknown;
  };
  const ok = res.ok && payload.ok === true;
  const text = payload.text ?? `command failed with HTTP ${res.status}`;
  if (ok) {
    const launch = commanderForeground(payload.data);
    if (argv[0] === "start" && options.directStart === true && !launch) {
      console.error("dispatch did not return a valid foreground Commander launch");
      process.exit(1);
    }
    console.log(text);
    if (launch) {
      const agent = Bun.spawn(launch.command, {
        cwd: launch.cwd,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      const code = await agent.exited;
      if (code !== 0) process.exit(code);
    }
    return;
  }
  console.error(text);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  return new Response(Bun.stdin.stream()).text();
}

const DISPATCH_COMMANDS = ["status", "start", "begin", "reconcile", "approve", "fail", "worker", "submit", "block", "unblock"];

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
  } else if (command !== undefined && DISPATCH_COMMANDS.includes(command)) {
    // Validate missing ticket forms before loading config or reading stdin.
    const args = process.argv.slice(3);
    const required = { begin: "<ticket>", submit: "<ticket> --input -", block: "<ticket> --reason TEXT", unblock: "<ticket>" };
    const flag = command === "submit" ? "--input" : command === "block" ? "--reason" : undefined;
    const ticketArgs: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      if (flag && arg === flag) i += 1;
      else if (!flag || !arg.startsWith(`${flag}=`)) ticketArgs.push(arg);
    }
    if (command in required && (!ticketArgs[0] || ticketArgs[0].startsWith("-"))) {
      throw new Error(`usage: igniter ${command} ${required[command as keyof typeof required]}`);
    }
    const options: CommandCallOptions = {};
    if (command === "submit") {
      options.input = await readStdin();
    }
    if (command === "start") options.directStart = true;
    await forwardCommand(process.argv.slice(2), options);
  } else if (command === "state") {
    throw new Error("`igniter state` was removed; use `igniter status <ticket> --json`");
  } else {
    console.error("usage: igniter <serve|status|start|begin|reconcile|approve|fail|worker|submit|block|unblock> [--port N]");
    console.error("  serve [--port N]");
    console.error("  status [--json|<ticket> --json]");
    console.error("  start [<ticket> [--publish-review]]");
    console.error("  begin <ticket>");
    console.error("  reconcile <ticket>");
    console.error("  approve <ticket> --receipt <id>");
    console.error("  fail <ticket> --reason TEXT");
    console.error("  worker start <ticket> [--role build|review|deliver]");
    console.error("  worker send <ticket> [--role build|review|deliver] TEXT");
    console.error("  worker restart <ticket> [--role build|review|deliver] --model MODEL");
    console.error("    restart also accepts --profile builder|reviewer|deliverer|fallback, --harness HARNESS, --effort EFFORT");
    console.error("  worker stop <ticket> [--role build|review|deliver]");
    console.error("  worker answer <ticket> [--role build|review|deliver] y|n");
    console.error("  submit <ticket> --input -");
    console.error("  block <ticket> --reason TEXT | unblock <ticket>");
    console.error("  --version, -v");
    process.exit(1);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
