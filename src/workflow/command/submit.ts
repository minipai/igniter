import type { CommandResult } from "../config/claims.ts";
import { commandDeps, refuse, type CommandContext } from "../context.ts";
import { deriveState, mergedDeliveryState, ProtocolError, submitMutation, type FullIssue } from "../lifecycle/ticket/protocol.ts";

export async function submitCommand(ticket: string, payload: unknown, ctx: CommandContext): Promise<CommandResult> {
  try {
    const identifier = ticket.toUpperCase();
    const full = (await ctx.client.fetchIssue(identifier)) as FullIssue | null;
    if (!full) throw new ProtocolError(`ticket "${identifier}" was not found in Linear`);
    if (full.projectId !== ctx.resolved.projectId) {
      throw new ProtocolError(`ticket "${full.identifier}" is not in project "${ctx.resolved.config.project}"`);
    }
    const state = mergedDeliveryState(ctx.resolved, full) ?? deriveState(ctx.resolved, full);
    return { ok: true, text: await submitMutation(commandDeps(ctx), full, state, payload) };
  } catch (error) {
    return refuse(ctx, ticket, error);
  }
}
