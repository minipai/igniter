import type { CommandResult } from "../config/claims.ts";
import { commandDeps, fail, refuse, ticketIssue, type CommandContext } from "../context.ts";
import { cancelMutation } from "../lifecycle/ticket/protocol.ts";

export async function cancelCommand(ticket: string, rawReason: string, ctx: CommandContext): Promise<CommandResult> {
  const reason = rawReason.trim();
  if (!reason) return fail("cancel reason cannot be blank");
  // The reason rides above the one YAML event block; a fenced block inside it
  // would make the record ambiguous and break the retry identity.
  if (/^```(?:yaml|yml)/m.test(reason)) {
    return fail("cancel reason cannot contain a YAML code fence");
  }
  try {
    const full = await ticketIssue(ctx, ticket);
    const result = await cancelMutation(commandDeps(ctx), full, reason);
    return result;
  } catch (error) {
    return refuse(ctx, ticket, error);
  }
}