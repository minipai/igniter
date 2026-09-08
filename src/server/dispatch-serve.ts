// Command-driven serve startup. Linear is touched only by an explicit HTTP
// request; there is no timer, project scan, automatic claim, or retry loop.

import { assertCommanderAssets } from "../commander/assets.ts";
import {
  createClaimLock,
  createDispatchLog,
  defaultHost,
  validateStartup,
  type CommandCallOptions,
  type DispatchApi,
  type ResolvedDispatch,
} from "../dispatch/claims.ts";
import { createWorkspaceSink, runCommand } from "../dispatch/commands.ts";
import type { DispatchConfig } from "../dispatch/config.ts";
import type { LinearClientLike } from "../dispatch/linear.ts";
import type { GitRunner } from "../dispatch/worktrees.ts";
import type { CommandWorkspaces } from "../dispatch/workspaces.ts";
import type { PromptDeliveryPolicy } from "../dispatch/prompt-delivery.ts";
import { startServer } from "./serve.ts";

export interface DispatchServeOptions {
  repoRoot: string;
  config: DispatchConfig;
  client: LinearClientLike;
  workspaces: CommandWorkspaces;
  git?: GitRunner;
  host?: string;
  port?: number;
  logPath?: string;
  print?: (line: string) => void;
  onServer?: (server: ReturnType<typeof startServer>) => void;
  /** Prompt-delivery confirmation budget; tests inject a fast clock. */
  promptDelivery?: PromptDeliveryPolicy;
}

export interface DispatchServeHandle {
  server: ReturnType<typeof startServer>;
  resolved: ResolvedDispatch;
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
  const decisions = createDispatchLog(logPath, options.print ?? console.log);
  const claimLock = createClaimLock();
  const sink = createWorkspaceSink({
    workspaces: options.workspaces,
    config: options.config,
    repoRoot: root,
    runGit: options.git,
  });
  let lastRefreshAt: string | null = null;
  const reconcilePending = new Map<string, {
    followUp: import("../dispatch/protocol.ts").OwnerMoveFollowUp | null;
    closeDue: { workspaceId: string | null; checkpoint: string } | null;
  }>();

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
    promptDelivery: options.promptDelivery,
    reconcilePending,
  });
  const markRefresh = (): void => {
    lastRefreshAt = new Date().toISOString();
  };

  const dispatch: DispatchApi = {
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
  });
  options.onServer?.(server);
  return {
    server,
    resolved,
    logPath,
    base: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      server.stop();
    },
  };
}
