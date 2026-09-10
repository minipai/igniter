import type { CommandResult } from "../config/claims.ts";
import { fail, type CommandContext } from "../context.ts";
import { failTicket, type FailureDeps } from "../lifecycle/ticket/recovery.ts";

export async function failCommand(identifier: string, rawReason: string, ctx: CommandContext): Promise<CommandResult> {
  const { client, resolved, decisions } = ctx;
  const reason = rawReason.trim();
  if (!reason) return fail("failure reason cannot be blank");
  const full = await client.fetchIssue(identifier);
  if (!full) {
    await decisions.record(identifier, `fail failed: ticket "${identifier}" was not found in Linear`);
    return fail(`ticket "${identifier}" was not found in Linear`);
  }
  if (full.projectId !== resolved.projectId) {
    await decisions.record(full.identifier, `fail failed: not in project "${resolved.config.project}"`);
    return fail(`ticket "${full.identifier}" is not in project "${resolved.config.project}"`);
  }
  const deps: FailureDeps = { client, resolved, workspaces: ctx.workspaces, decisions };
  return failTicket(deps, full, reason, null);
}
