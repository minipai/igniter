import type { CommandResult } from "../config/claims.ts";
import { fail, type CommandContext } from "../context.ts";
import type { FullIssue } from "../lifecycle/ticket/protocol.ts";

export async function startCommand(ticket: string | undefined, ctx: CommandContext): Promise<CommandResult> {
  const { client, resolved, decisions } = ctx;
  let assignment: FullIssue | undefined;
  if (ticket) {
    const identifier = ticket.toUpperCase();
    const full = (await client.fetchIssue(identifier)) as FullIssue | null;
    if (!full) {
      await decisions.record(identifier, `start failed: ticket "${identifier}" was not found in Linear`);
      return fail(`ticket "${identifier}" was not found in Linear`);
    }
    if (full.projectId !== resolved.projectId) {
      await decisions.record(full.identifier, `start failed: not in project "${resolved.config.project}"`);
      return fail(`ticket "${full.identifier}" is not in project "${resolved.config.project}"`);
    }
    if (full.state.type === "completed" || full.state.type === "canceled") {
      await decisions.record(full.identifier, `start refused: ticket is ${full.state.name}`);
      return fail(`start refused: ticket is ${full.state.name}`);
    }
    assignment = full;
  }
  const { prepareCommanderForeground } = await import("../lifecycle/stage/commander-start.ts");
  let launch;
  try {
    launch = prepareCommanderForeground({ resolved, repoRoot: ctx.repoRoot }, assignment);
  } catch (error) {
    await decisions.record("commander", `start failed: ${(error as Error).message}`);
    return fail(`start failed: ${(error as Error).message}`);
  }
  const what = assignment ? `assigned ${assignment.identifier}` : "patrolling queue and active tickets";
  await decisions.record("commander", `prepared foreground ${launch.command[0]} Commander (${what})`);
  return {
    ok: true,
    text: `starting Commander with ${launch.command[0]} in the current terminal; ${what}`,
    data: launch,
  };
}
