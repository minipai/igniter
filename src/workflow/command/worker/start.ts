import type { CommandResult } from "../../config/claims.ts";
import type { CommanderStage } from "../../config/config.ts";
import type { ExtractCommand } from "../../lifecycle/stage/worker-target.ts";
import type { CommandContext } from "../../context.ts";
import { bareTodoState, deriveState, type FullIssue } from "../../lifecycle/ticket/protocol.ts";
import { startStageTicket } from "../../lifecycle/stage/stage-start.ts";

export async function startWorker(request: ExtractCommand<"worker.start">, ctx: CommandContext): Promise<CommandResult> {
  const ticket = request.ticket.toUpperCase();
  const full = await ctx.client.fetchIssue(ticket) as FullIssue | null;
  if (!full) throw new Error(`ticket ${ticket} was not found`);
  if (full.projectId !== ctx.resolved.projectId) {
    throw new Error(`ticket ${ticket} is not in project ${ctx.resolved.config.project}`);
  }
  const state = bareTodoState(ctx.resolved, full) ?? deriveState(ctx.resolved, full);
  const result = await startStageTicket(ctx, full, state, request.role ? { stage: request.role as CommanderStage } : {});
  return { ...result, data: result };
}
