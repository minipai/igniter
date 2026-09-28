import type { CommandResult } from "../../config/claims.ts";
import type { CommandContext } from "../../context.ts";
import type { ExtractCommand } from "../../lifecycle/stage/worker-target.ts";
import { readWorkerView, selectWorker } from "../../lifecycle/stage/worker-target.ts";

export async function answerWorker(request: ExtractCommand<"worker.answer">, ctx: CommandContext): Promise<CommandResult> {
  const view = await readWorkerView(request.ticket.toUpperCase(), ctx);
  const { stage, worker, agent } = selectWorker(view, request.role);
  if (!agent) throw new Error(`no live ${stage} worker for ${view.ticket}`);
  const before = await ctx.workspaces.readPane(agent.paneId, 80);
  const fresh = (await ctx.workspaces.snapshot()).agents.find((candidate) => candidate.name === worker);
  const after = await ctx.workspaces.readPane(agent.paneId, 80);
  if (fresh?.paneId !== agent.paneId || fresh.session !== agent.session ||
      before.revision !== after.revision || before.text !== after.text) {
    throw new Error("worker permission dialog changed; reread before answering");
  }
  await ctx.workspaces.sendAgentKeys(worker, [request.answer]);
  return { ok: true, text: `${view.ticket}: answered ${request.answer} for ${worker}` };
}
