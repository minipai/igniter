import type { CommandResult } from "../config/claims.ts";
import { fail, type CommandContext } from "../context.ts";

export async function startCommand(ctx: CommandContext): Promise<CommandResult> {
  const { prepareCommanderForeground } = await import("../lifecycle/stage/commander-start.ts");
  let launch;
  try {
    launch = prepareCommanderForeground({ resolved: ctx.resolved, repoRoot: ctx.repoRoot });
  } catch (error) {
    await ctx.decisions.record("commander", `start failed: ${(error as Error).message}`);
    return fail(`start failed: ${(error as Error).message}`);
  }
  await ctx.decisions.record("commander", `prepared foreground ${launch.command[0]} Commander (patrolling queue and active tickets)`);
  return {
    ok: true,
    text: `starting Commander with ${launch.command[0]} in the current terminal; patrolling queue and active tickets`,
    data: launch,
  };
}
