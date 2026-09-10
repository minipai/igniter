import type { CommandResult } from "../../config/claims.ts";
import { STAGE_AGENTS } from "../../config/config.ts";
import type { CommandContext } from "../../context.ts";
import type { ExtractCommand } from "../../lifecycle/stage/worker-target.ts";
import { commanderConfigForRun } from "../../lifecycle/stage/agents.ts";
import { readWorkerView, selectWorker } from "../../lifecycle/stage/worker-target.ts";

export function answerKeysFor(kind: string | undefined, key: string): string[] {
  if ((kind ?? "").toLowerCase() === "claude") return [key === "y" ? "enter" : "esc"];
  return [key];
}

export async function answerWorker(request: ExtractCommand<"worker.answer">, ctx: CommandContext): Promise<CommandResult> {
  const view = await readWorkerView(request.ticket.toUpperCase(), ctx);
  const { stage, worker, agent } = selectWorker(view, request.role);
  if (!agent) throw new Error(`no live ${stage} worker for ${view.ticket}`);
  const config = commanderConfigForRun(ctx.resolved.config.commander, view.workspace?.tokens ?? {});
  const profile = config.agents[STAGE_AGENTS[stage]];
  const before = await ctx.workspaces.readPane(agent.paneId, 80);
  const fresh = (await ctx.workspaces.snapshot()).agents.find((candidate) => candidate.name === worker);
  const after = await ctx.workspaces.readPane(agent.paneId, 80);
  if (fresh?.paneId !== agent.paneId || fresh.session !== agent.session ||
      before.revision !== after.revision || before.text !== after.text) {
    throw new Error("worker permission dialog changed; reread before answering");
  }
  await ctx.workspaces.sendKeys(agent.paneId, answerKeysFor(profile.harness, request.answer));
  return { ok: true, text: `${view.ticket}: answered ${request.answer} for ${worker}` };
}
