// Watched serve startup: the `igniter serve` assembly without the CLI shell.
//
// This is the same wiring `src/cli.ts` used to inline: the server starts
// before Linear validation finishes (an unreachable Linear retries while
// the web UI stays up), then the watch loop and the commands share the one
// watcher — and the one claim lock — so there is ever exactly one claimant
// in the process. `src/cli.ts` stays a thin shell around it (flags, env,
// signals, exit codes); tests drive it with fake Linear, fake Herdr, fake
// git, and a temporary repo root.

import { assertCommanderAssets } from "../commander/assets.ts";
import {
  createClaimLock,
  createDispatchLog,
  defaultHost,
  readActivityTail,
  startWatch,
  validateStartup,
  validateWithRetry,
  Watcher,
  type CommandCallOptions,
  type DispatchApi,
  type ResolvedDispatch,
  type WatchHandle,
} from "../dispatch/claims.ts";
import { createWorkspaceSink, collectStatus, runCommand } from "../dispatch/commands.ts";
import type { DispatchConfig } from "../dispatch/config.ts";
import type { LinearClient } from "../dispatch/linear.ts";
import type { GitRunner } from "../dispatch/worktrees.ts";
import type { CommandWorkspaces } from "../dispatch/workspaces.ts";
import {
  buildBoardSnapshot,
  createBoardHub,
  createPaneOutputCache,
  readRulesText,
  startHerdrBoardFeed,
  withBoardEvents,
  type BoardHub,
  type BoardSnapshot,
} from "./board.ts";
import { startServer } from "./serve.ts";

export interface WatchedServeRetry {
  maxAttempts?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, error: Error) => void;
}

export interface WatchedServeOptions {
  repoRoot: string;
  config: DispatchConfig;
  client: LinearClient;
  workspaces: CommandWorkspaces;
  git?: GitRunner;
  host?: string;
  port?: number;
  logPath?: string;
  /** Where decision lines print; production logs to stdout. */
  print?: (line: string) => void;
  /** Watch poll interval; production uses the 30s default. */
  intervalMs?: number;
  /** Validation retry; production retries forever with a 5s base delay. */
  retry?: WatchedServeRetry;
  /**
   * Called with the server right after it starts listening, before Linear
   * validation finishes. The CLI shell logs the address and registers
   * signal handlers here so an unreachable-Linear retry stays stoppable.
   */
  onServer?: (server: ReturnType<typeof startServer>) => void;
  /** Herdr board feed; tests point the lookup at nothing with a fast sleep. */
  feed?: {
    retryMs?: number;
    sleep?: (ms: number) => Promise<unknown>;
    lookupPath?: () => Promise<string>;
  };
}

export interface WatchedServeHandle {
  server: ReturnType<typeof startServer>;
  watcher: Watcher;
  hub: BoardHub;
  logPath: string;
  base: string;
  stop: () => Promise<void>;
}

/**
 * Start the watched serve process against the given edges. The server is
 * already listening when the returned promise settles its validation wait:
 * while Linear is unreachable the UI stays up and validation retries.
 * A validation failure that is not transient stops the server and throws;
 * the CLI shell turns that into exit 1. Never touches process signals or
 * exit codes; the caller owns those.
 */
export async function startWatchedServe(options: WatchedServeOptions): Promise<WatchedServeHandle> {
  // Bundled Commander assets fail fast here, before anything serves: a
  // missing rules.md, config.yaml, or stage prompt names itself.
  await assertCommanderAssets();
  const { config } = options;
  const root = options.repoRoot;
  const host = options.host ?? defaultHost();
  const git = options.git;
  const logPath = options.logPath ?? `${root.replace(/\/+$/, "")}/.igniter/dispatch.log`;
  const hub = createBoardHub();
  const decisions = withBoardEvents(createDispatchLog(logPath, options.print ?? console.log), hub);
  const workspaces = options.workspaces;
  const outputs = createPaneOutputCache({ workspaces });
  const claimLock = createClaimLock();

  // The server starts before Linear validation finishes (an unreachable
  // Linear retries while the web UI stays up), so the dispatch behind the
  // routes fills in once validation succeeds.
  const holder: { current?: Watcher } = {};
  const sink = createWorkspaceSink({
    workspaces,
    config,
    repoRoot: root,
    runGit: git,
  });
  const commandContext = (watcher: Watcher) => ({
    client: options.client,
    resolved: watcher.resolved,
    host,
    decisions,
    workspaces,
    sink,
    repoRoot: root,
    git,
    lastPollAt: () => watcher.lastPollAt,
  });
  const dispatch: DispatchApi = {
    queue: () => {
      const watcher = holder.current;
      return watcher ? { lastPollAt: watcher.lastPollAt, order: watcher.lastQueue } : { lastPollAt: null, order: [] };
    },
    activity: (limit) => readActivityTail(logPath, limit),
    command: (argv: string[], commandOptions: CommandCallOptions = {}) => {
      const watcher = holder.current;
      if (!watcher) return Promise.resolve({ ok: false, text: "dispatch still starting; retry shortly" });
      return claimLock(() => runCommand(argv, commandContext(watcher), commandOptions));
    },
  };
  const server = startServer({
    port: options.port,
    hostname: config.listenHost,
    dispatch,
    hub,
    board: async (): Promise<BoardSnapshot | null> => {
      const watcher = holder.current;
      if (!watcher) return null;
      const statusCtx = commandContext(watcher);
      let collected;
      try {
        collected = await collectStatus(statusCtx);
      } catch {
        // Linear or Herdr down: the page still shows queue, activity, and
        // rules with an empty rail instead of a 503.
        collected = {
          data: {
            slots: { used: 0, max: watcher.resolved.config.maxRunning },
            lastPollAt: watcher.lastPollAt,
            tickets: [],
          },
          snapshot: null,
          herdrNote: null,
        };
      }
      if (collected.snapshot) {
        const live = new Set(
          collected.data.tickets.filter((t) => t.hasWorkspace).map((t) => t.identifier.toLowerCase()),
        );
        await Promise.allSettled(
          collected.snapshot.agents
            .filter((agent) => [...live].some((id) => agent.name.endsWith(`-${id}`)))
            .map((agent) => outputs.refresh(agent.paneId)),
        );
      }
      const [activity, rules] = await Promise.all([
        readActivityTail(logPath, 100).catch(() => [] as string[]),
        readRulesText(),
      ]);
      return buildBoardSnapshot({
        status: collected.data,
        snapshot: collected.snapshot,
        queue: watcher.lastQueue,
        // Newest decision first, like the Activity view shows them.
        activity: [...activity].reverse(),
        rules,
        host,
        linearOrg: watcher.resolved.config.linearOrg,
        commanderKind: watcher.resolved.config.commander.agents.commander.harness,
        outputs: outputs.outputs,
      });
    },
  });
  options.onServer?.(server);
  // An unreachable Linear is not a configuration error: the server stays up
  // and validation retries until Linear answers. Unknown statuses, teams,
  // projects, label groups, or labels still throw immediately.
  const retry = options.retry ?? {};
  let resolved: ResolvedDispatch;
  try {
    resolved = await validateWithRetry(() => validateStartup(options.client, config), {
      maxAttempts: retry.maxAttempts ?? Number.POSITIVE_INFINITY,
      baseDelayMs: retry.baseDelayMs ?? 5000,
      onRetry: retry.onRetry ?? ((attempt, error) => {
        console.error(`Linear unreachable (attempt ${attempt}): ${error.message}; retrying — web UI stays up`);
      }),
    });
  } catch (error) {
    server.stop();
    throw error;
  }
  const watcher = new Watcher({
    client: options.client,
    resolved,
    host,
    decisions,
    workspaces,
    sink,
    git,
    repoRoot: root,
  });
  holder.current = watcher;
  // The watch loop and the commands share the watcher — and the lock — so
  // there is ever exactly one claimant in the process.
  const watch: WatchHandle = startWatch({ watcher, lock: claimLock, intervalMs: options.intervalMs });
  // Poll completions reach the page over SSE so its "last Linear poll"
  // seconds reset without polling.
  const pollOnce = watcher.pollOnce.bind(watcher);
  watcher.pollOnce = async () => {
    const result = await pollOnce();
    hub.emit("poll", { lastPollAt: watcher.lastPollAt });
    return result;
  };
  const feed = startHerdrBoardFeed({ hub, outputs, retryMs: options.feed?.retryMs, sleep: options.feed?.sleep, lookupPath: options.feed?.lookupPath });
  return {
    server,
    watcher,
    hub,
    logPath,
    base: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      // Let an in-flight poll settle so shutdown never leaves a claim
      // half-written; request timeouts bound the wait.
      await watch.stop();
      feed.stop();
      server.stop();
    },
  };
}
