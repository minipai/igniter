import type { CommandResult } from "../config/claims.ts";
import { commandDeps, refuse, ticketIssue, type CommandContext } from "../context.ts";

export async function approveCommand(ticket: string, receipt: string, ctx: CommandContext): Promise<CommandResult> {
  try {
    const { approveTicket } = await import("../lifecycle/delivery/approval.ts");
    return await approveTicket(commandDeps(ctx), await ticketIssue(ctx, ticket), receipt);
  } catch (error) {
    return refuse(ctx, ticket, error);
  }
}
