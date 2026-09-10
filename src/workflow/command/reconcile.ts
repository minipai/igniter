import type { CommandResult } from "../config/claims.ts";
import { commandDeps, fail, type CommandContext } from "../context.ts";
import { deriveState, normalizeOwnerMove, type FullIssue } from "../lifecycle/ticket/protocol.ts";

export async function reconcileCommand(identifier: string, ctx: CommandContext): Promise<CommandResult> {
  const full = (await ctx.client.fetchIssue(identifier)) as FullIssue | null;
  if (!full) {
    await ctx.decisions.record(identifier, `reconcile failed: ticket "${identifier}" was not found in Linear`);
    return fail(`ticket "${identifier}" was not found in Linear`);
  }
  if (full.projectId !== ctx.resolved.projectId) {
    await ctx.decisions.record(full.identifier, `reconcile failed: not in project "${ctx.resolved.config.project}"`);
    return fail(`ticket "${full.identifier}" is not in project "${ctx.resolved.config.project}"`);
  }
  const outcome = await normalizeOwnerMove(commandDeps(ctx), full);
  if (outcome.result) return outcome.result;
  const state = deriveState(ctx.resolved, full);
  return {
    ok: true,
    text: `${full.identifier}: no owner transition to reconcile (${state.status}+${state.progress ?? "none"})`,
  };
}
