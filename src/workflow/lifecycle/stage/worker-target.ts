import type { CommanderStage } from "../../config/config.ts";
import type { CommandContext } from "../../context.ts";
import { statusOf, type FullIssue } from "../ticket/protocol.ts";
import { stageForStatus, workerAgentName } from "./stage-start.ts";
import { workspaceForTicket, type SnapshotAgent, type SnapshotWorkspace, type WorkspaceSnapshot } from "../../service/workspace/workspaces.ts";
import type { WorkerRole } from "../../request.ts";
import type { CommandRequest } from "../../request.ts";

export type ExtractCommand<Name extends CommandRequest["command"]> = Extract<CommandRequest, { command: Name }>;

export interface WorkerView {
  ticket: string;
  full: FullIssue;
  status: ReturnType<typeof statusOf>;
  snapshot: WorkspaceSnapshot;
  workspace: SnapshotWorkspace | undefined;
  live: SnapshotAgent[];
}

export async function readWorkerView(ticket: string, ctx: CommandContext): Promise<WorkerView> {
  const full = await ctx.client.fetchIssue(ticket) as FullIssue | null;
  if (!full) throw new Error(`ticket ${ticket} was not found`);
  if (full.projectId !== ctx.resolved.projectId) {
    throw new Error(`ticket ${ticket} is not in project ${ctx.resolved.config.project}`);
  }
  const status = statusOf(ctx.resolved, full.state.id);
  const snapshot = await ctx.workspaces.snapshot();
  const workspace = workspaceForTicket(snapshot, ticket);
  const live = snapshot.agents.filter((agent) => agent.workspaceId === workspace?.workspaceId &&
    (["build", "acceptance", "deliver"] as const).some((stage) => agent.name === workerAgentName(stage, ticket)) &&
    !/^(done|ended|exited|failed|gone|stopped)$/i.test(agent.agentStatus));
  return { ticket, full, status, snapshot, workspace, live };
}

export function selectWorker(view: WorkerView, role?: WorkerRole): {
  stage: CommanderStage;
  worker: string;
  agent: SnapshotAgent | undefined;
} {
  if (!role && view.live.length > 1) {
    throw new Error(`multiple workers for ${view.ticket}; select --role build|acceptance|deliver`);
  }
  const stage = role ??
    (["build", "acceptance", "deliver"] as const).find((candidate) =>
      view.live[0]?.name === workerAgentName(candidate, view.ticket)) ??
    (view.status ? stageForStatus(view.status) : null);
  if (!stage) throw new Error(`no worker role for ${view.ticket}; select --role`);
  const worker = workerAgentName(stage, view.ticket);
  return { stage, worker, agent: view.live.find((candidate) => candidate.name === worker) };
}
