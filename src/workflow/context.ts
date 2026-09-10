import type { CommandResult, DecisionLog, ResolvedDispatch } from "./config/claims.ts";
import type { PromptDeliveryPolicy } from "./lifecycle/delivery/prompt-delivery.ts";
import type { LinearClientLike } from "./service/linear/linear.ts";
import type { CommandWorkspaces } from "./service/workspace/workspaces.ts";
import { bunGitRunner, type GitRunner } from "./service/worktree/worktrees.ts";
import { ProtocolError, type FullIssue, type ProtocolDeps } from "./lifecycle/ticket/protocol.ts";

export interface CommandContext {
  client: LinearClientLike;
  resolved: ResolvedDispatch;
  decisions: DecisionLog;
  workspaces: CommandWorkspaces;
  repoRoot: string;
  git?: GitRunner;
  now?: () => number;
  promptDelivery?: PromptDeliveryPolicy;
}

export function commandDeps(ctx: CommandContext): ProtocolDeps {
  return {
    client: ctx.client,
    resolved: ctx.resolved,
    workspaces: ctx.workspaces,
    decisions: ctx.decisions,
    git: ctx.git ?? bunGitRunner(),
    repoRoot: ctx.repoRoot,
  };
}

export function fail(text: string): CommandResult {
  return { ok: false, text };
}

export async function refuse(ctx: CommandContext, ticket: string, error: unknown): Promise<CommandResult> {
  const text = error instanceof Error ? error.message : String(error);
  await ctx.decisions.record(ticket, `refused: ${text}`);
  return { ok: false, text };
}

export async function ticketIssue(ctx: CommandContext, identifier: string): Promise<FullIssue> {
  const full = await ctx.client.fetchIssue(identifier.toUpperCase()) as FullIssue | null;
  if (!full) throw new ProtocolError(`ticket "${identifier}" was not found in Linear`);
  if (full.projectId !== ctx.resolved.projectId) {
    throw new ProtocolError(`ticket "${identifier}" is not in project "${ctx.resolved.config.project}"`);
  }
  return full;
}
