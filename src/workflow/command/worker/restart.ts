import type { CommandResult } from "../../config/claims.ts";
import { STAGE_AGENTS, type CommanderAgentConfig } from "../../config/config.ts";
import type { CommandContext } from "../../context.ts";
import type { ExtractCommand } from "../../lifecycle/stage/worker-target.ts";
import {
  launchFor,
  selectStageAgent,
  selectedAgentToken,
} from "../../lifecycle/stage/agents.ts";
import { bareTodoState, deriveState, latestValidReceipt } from "../../lifecycle/ticket/protocol.ts";
import { stageForStatus, startStageTicket } from "../../lifecycle/stage/stage-start.ts";
import { readWorkerView, selectWorker } from "../../lifecycle/stage/worker-target.ts";

export async function restartWorker(
  request: ExtractCommand<"worker.restart">,
  ctx: CommandContext,
): Promise<CommandResult> {
  const view = await readWorkerView(request.ticket.toUpperCase(), ctx);
  const { stage, worker, agent } = selectWorker(view, request.role);
  const state = bareTodoState(ctx.resolved, view.full) ?? deriveState(ctx.resolved, view.full);
  if (stage !== stageForStatus(state.status) ||
      !["pending", "in_progress"].includes(state.progress ?? (state.status === "todo" ? "pending" : ""))) {
    throw new Error(`cannot restart ${stage} while ticket is ${state.status}+${state.progress ?? "none"}`);
  }

  // An explicit --agent selects a named candidate; otherwise the run's own
  // recorded selection is reused, never silently reverted to the default.
  const tokens = view.workspace?.tokens ?? {};
  const selected = selectStageAgent(ctx.resolved.config.commander, tokens, stage, request.agent);
  let profile: CommanderAgentConfig = selected.profile;
  profile = {
    harness: request.harness ?? profile.harness,
    model: request.model ?? profile.model,
    ...(request.effort
      ? { effort: request.effort }
      : request.harness && request.harness !== profile.harness
        ? {}
        : profile.effort
          ? { effort: profile.effort }
          : {}),
  };
  launchFor(profile);
  if (!view.workspace) throw new Error(`no workspace for ${view.ticket}; use worker start first`);
  if (!ctx.workspaces.stopAgent) throw new Error("worker stop is not configured");

  const restartKey = `restart_${stage}`;
  const restartRequest = JSON.stringify([latestValidReceipt(view.full.comments)?.receipt.submission ?? "initial", profile]);
  const previous = view.workspace.tokens[restartKey]
    ? JSON.parse(view.workspace.tokens[restartKey]) as { request: string; oldPane?: string }
    : null;
  const rebuilding = previous?.request === restartRequest;
  const rebuilt = rebuilding && agent && agent.paneId !== previous.oldPane;
  await ctx.workspaces.reportMetadata(view.workspace.workspaceId, {
    [restartKey]: JSON.stringify(rebuilding ? previous : { request: restartRequest, oldPane: agent?.paneId }),
  });
  if (agent && !rebuilt) await ctx.workspaces.stopAgent(worker);
  await ctx.workspaces.reportMetadata(view.workspace.workspaceId, {
    [`profile_${STAGE_AGENTS[stage]}`]: JSON.stringify(profile),
    [selectedAgentToken(stage)]: selected.name,
    ...(stage === "build" ? { builder: null } : {}),
  });
  const result = await startStageTicket(ctx, view.full, state, { stage, rebuilding: true });
  return { ...result, data: result };
}
