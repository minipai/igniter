import type { CommandResult } from "../../config/claims.ts";
import type { CommandContext } from "../../context.ts";
import type { ExtractCommand } from "../../lifecycle/stage/worker-target.ts";
import { deriveState, latestValidReceipt } from "../../lifecycle/ticket/protocol.ts";
import { workerAgentName } from "../../lifecycle/stage/stage-start.ts";
import { bunGitRunner, cleanupTicketCheckout } from "../../service/worktree/worktrees.ts";
import { readWorkerView, selectWorker } from "../../lifecycle/stage/worker-target.ts";

export async function stopWorker(request: ExtractCommand<"worker.stop">, ctx: CommandContext): Promise<CommandResult> {
  const view = await readWorkerView(request.ticket.toUpperCase(), ctx);
  if (view.status === "done" && !request.role) return cleanupDone(view, ctx);

  const { worker, agent } = selectWorker(view, request.role);
  if (agent) {
    if (!ctx.workspaces.stopAgent) throw new Error("worker stop is not configured");
    await ctx.workspaces.stopAgent(worker);
  }
  return { ok: true, text: `${view.ticket}: ${worker} stopped; checkout preserved` };
}

async function cleanupDone(
  view: Awaited<ReturnType<typeof readWorkerView>>,
  ctx: CommandContext,
): Promise<CommandResult> {
  deriveState(ctx.resolved, view.full);
  const receipt = latestValidReceipt(view.full.comments);
  if (receipt?.receipt.kind !== "deliver") throw new Error("Done cleanup requires a current valid Deliver receipt");
  const landed = receipt.receipt.landed ?? receipt.receipt.checkpoint;
  if (!/^[0-9a-f]{7,64}$/.test(receipt.receipt.checkpoint) || !/^[0-9a-f]{7,64}$/.test(landed)) {
    throw new Error("Done cleanup receipt must bind Git checkpoint and landed hashes");
  }
  if (view.workspace) {
    const workers = view.snapshot.agents.filter((agent) => agent.workspaceId === view.workspace?.workspaceId &&
      (["build", "acceptance", "deliver"] as const).some((stage) =>
        agent.name === workerAgentName(stage, view.ticket)));
    for (const worker of workers) {
      if (!ctx.workspaces.stopAgent) throw new Error("worker stop is not configured");
      await ctx.workspaces.stopAgent(worker.name);
    }
    const remaining = await ctx.workspaces.snapshot();
    const rootPane = view.workspace.tokens["worker_root_pane"];
    if (remaining.panes.some((pane) => pane.workspaceId === view.workspace?.workspaceId && pane.paneId !== rootPane) ||
        remaining.agents.some((agent) => agent.workspaceId === view.workspace?.workspaceId)) {
      return { ok: false, text: `${view.ticket}: workflow workers stopped; non-workflow panes remain, keeping workspace and checkout` };
    }
  }
  const cleanup = await cleanupTicketCheckout(ctx.git ?? bunGitRunner(), ctx.repoRoot, view.ticket, {
    checkpoint: landed,
    targetBranch: ctx.resolved.config.targetBranch,
  });
  if (cleanup.ok && view.workspace) await ctx.workspaces.close(view.workspace.workspaceId);
  return { ok: cleanup.ok, text: `${view.ticket}: workers stopped; ${cleanup.detail}` };
}
