import type { CommandResult } from "../../config/claims.ts";
import type { CommandContext } from "../../context.ts";
import type { ExtractCommand } from "../../lifecycle/stage/worker-target.ts";
import { readWorkerView, selectWorker } from "../../lifecycle/stage/worker-target.ts";

export async function sendWorker(request: ExtractCommand<"worker.send">, ctx: CommandContext): Promise<CommandResult> {
  const view = await readWorkerView(request.ticket.toUpperCase(), ctx);
  const { stage, worker, agent } = selectWorker(view, request.role);
  if (!agent) throw new Error(`no live ${stage} worker for ${view.ticket}`);
  await ctx.workspaces.prompt(worker, request.text);
  return { ok: true, text: `${view.ticket}: sent to ${worker}` };
}
