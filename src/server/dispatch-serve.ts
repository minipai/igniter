// Command-driven serve startup. Linear is touched only by an explicit HTTP
// request; there is no timer, project scan, automatic claim, or retry loop.

import { assertCommanderAssets } from "../commander/assets.ts";
import {
  createClaimLock,
  createDispatchLog,
  defaultHost,
  readActivityTail,
  readQueue,
  validateStartup,
  type CommandCallOptions,
  type DispatchApi,
  type QueueEntry,
  type ResolvedDispatch,
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

export interface DispatchServeOptions {
  repoRoot: string;
  config: DispatchConfig;
  client: LinearClient;
  workspaces: CommandWorkspaces;
  git?: GitRunner;
  host?: string;
  port?: number;
  logPath?: string;
  print?: (line: string) => void;
  onServer?: (server: ReturnType<typeof startServer>) => void;
  feed?: {
    retryMs?: number;
    sleep?: (ms: number) => Promise<unknown>;
    lookupPath?: () => Promise<string>;
  };
}

export interface DispatchServeHandle {
  server: ReturnType<typeof startServer>;
  resolved: ResolvedDispatch;
  hub: BoardHub;
  logPath: string;
  base: string;
  stop: () => Promise<void>;
}

/**
 * Validate once, then serve ticket-targeted commands. An idle process makes
 * zero Linear requests; failures belong to the command that triggered them.
 */
export async function startDispatchServe(options: DispatchServeOptions): Promise<DispatchServeHandle> {
  await assertCommanderAssets();
  const resolved = await validateStartup(options.client, options.config);
  const root = options.repoRoot;
  const host = options.host ?? defaultHost();
  const logPath = options.logPath ?? `${root.replace(/\/+$/, "")}/.igniter/dispatch.log`;
  const hub = createBoardHub();
  const decisions = withBoardEvents(createDispatchLog(logPath, options.print ?? console.log), hub);
  const outputs = createPaneOutputCache({ workspaces: options.workspaces });
  const claimLock = createClaimLock();
  const sink = createWorkspaceSink({
    workspaces: options.workspaces,
    config: options.config,
    repoRoot: root,
    runGit: options.git,
  });
  let lastRefreshAt: string | null = null;
  let queue: QueueEntry[] = [];

  const commandContext = () => ({
    client: options.client,
    resolved,
    host,
    decisions,
    workspaces: options.workspaces,
    sink,
    repoRoot: root,
    git: options.git,
    lastPollAt: () => lastRefreshAt,
  });
  const markRefresh = (): void => {
    lastRefreshAt = new Date().toISOString();
    hub.emit("refresh", { lastRefreshAt });
  };
  const noteRefresh = (): void => {
    lastRefreshAt = new Date().toISOString();
  };
  const readExplicitQueue = async (): Promise<{ lastRefreshAt: string | null; order: QueueEntry[] }> => {
    queue = await readQueue(options.client, resolved);
    markRefresh();
    return { lastRefreshAt, order: queue };
  };

  const dispatch: DispatchApi = {
    queue: readExplicitQueue,
    activity: (limit) => readActivityTail(logPath, limit),
    command: (argv: string[], commandOptions: CommandCallOptions = {}) => claimLock(async () => {
      const result = await runCommand(argv, commandContext(), commandOptions);
      markRefresh();
      return result;
    }),
  };
  const server = startServer({
    port: options.port,
    hostname: options.config.listenHost,
    dispatch,
    hub,
    board: async (): Promise<BoardSnapshot> => {
      const [collected, order] = await Promise.all([
        collectStatus(commandContext()),
        readQueue(options.client, resolved),
      ]);
      queue = order;
      noteRefresh();
      collected.data.lastPollAt = lastRefreshAt;
      if (collected.snapshot) {
        const live = new Set(
          collected.data.tickets.filter((ticket) => ticket.hasWorkspace).map((ticket) => ticket.identifier.toLowerCase()),
        );
        await Promise.allSettled(
          collected.snapshot.agents
            .filter((agent) => [...live].some((identifier) => agent.name.endsWith(`-${identifier}`)))
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
        queue,
        activity: [...activity].reverse(),
        rules,
        host,
        linearOrg: resolved.config.linearOrg,
        commanderKind: resolved.config.commander.agents.commander.harness,
        outputs: outputs.outputs,
      });
    },
  });
  options.onServer?.(server);
  const feed = startHerdrBoardFeed({
    hub,
    outputs,
    retryMs: options.feed?.retryMs,
    sleep: options.feed?.sleep,
    lookupPath: options.feed?.lookupPath,
  });
  return {
    server,
    resolved,
    hub,
    logPath,
    base: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      feed.stop();
      server.stop();
    },
  };
}
