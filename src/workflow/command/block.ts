import type { CommandResult } from "../config/claims.ts";
import { commandDeps, fail, refuse, type CommandContext } from "../context.ts";
import { blockMutation, deriveState, ProtocolError, type FullIssue } from "../lifecycle/ticket/protocol.ts";

export async function blockCommand(ticket: string, rawReason: string, ctx: CommandContext): Promise<CommandResult> {
  const reason = rawReason.trim();
  if (!reason) return fail("block reason cannot be blank");
  try {
    const identifier = ticket.toUpperCase();
    const full = (await ctx.client.fetchIssue(identifier)) as FullIssue | null;
    if (!full) throw new ProtocolError(`ticket "${identifier}" was not found in Linear`);
    if (full.projectId !== ctx.resolved.projectId) {
      throw new ProtocolError(`ticket "${full.identifier}" is not in project "${ctx.resolved.config.project}"`);
    }
    await blockMutation(commandDeps(ctx), full, deriveState(ctx.resolved, full), reason);
    return { ok: true, text: `blocked ${full.identifier}: ${reason}` };
  } catch (error) {
    return refuse(ctx, ticket, error);
  }
}
