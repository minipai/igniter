import type { CommandResult } from "../config/claims.ts";
import { commandDeps, refuse, type CommandContext } from "../context.ts";
import { deriveState, ProtocolError, unblockMutation, type FullIssue } from "../lifecycle/ticket/protocol.ts";

export async function unblockCommand(ticket: string, ctx: CommandContext): Promise<CommandResult> {
  try {
    const identifier = ticket.toUpperCase();
    const full = (await ctx.client.fetchIssue(identifier)) as FullIssue | null;
    if (!full) throw new ProtocolError(`ticket "${identifier}" was not found in Linear`);
    if (full.projectId !== ctx.resolved.projectId) {
      throw new ProtocolError(`ticket "${full.identifier}" is not in project "${ctx.resolved.config.project}"`);
    }
    await unblockMutation(commandDeps(ctx), full, deriveState(ctx.resolved, full));
    return { ok: true, text: `unblocked ${full.identifier}: back to pending; run \`igniter begin ${full.identifier}\`` };
  } catch (error) {
    return refuse(ctx, ticket, error);
  }
}
