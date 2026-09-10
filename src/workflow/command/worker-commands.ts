import type { CommandContext, CommandResult } from "./commands.ts";
import type { CommanderAgentConfig, CommanderStage } from "../config/config.ts";
import { STAGE_AGENTS } from "../config/config.ts";
import { commanderConfigForRun, launchFor } from "./stage/agents.ts";
import { bareTodoState, deriveState, latestValidReceipt, statusOf, type FullIssue } from "./ticket/protocol.ts";
import { startStageTicket, stageForStatus, workerAgentName } from "./stage/stage-start.ts";
import { workspaceForTicket } from "../service/workspace/workspaces.ts";
import { bunGitRunner, cleanupTicketCheckout } from "../service/worktree/worktrees.ts";
import type { WorkerRequest } from "./command-request.ts";

/** Run one worker lifecycle operation without changing Linear. */
export async function workerCommand(request: WorkerRequest, ctx: CommandContext): Promise<CommandResult> {
  const action = request.command.slice("worker.".length);
  const ticket = request.ticket.toUpperCase();
  try {
    return await operate(request, ticket, ctx);
  } catch (error) {
    return { ok: false, text: `worker ${action} failed: ${(error as Error).message}; Linear unchanged` };
  }
}

async function operate(request: WorkerRequest, ticket: string, ctx: CommandContext): Promise<CommandResult> {
  const action = request.command.slice("worker.".length);
  const role = request.role;
  const full = await ctx.client.fetchIssue(ticket) as FullIssue | null;
  if (!full) throw new Error(`ticket ${ticket} was not found`);
  if (full.projectId !== ctx.resolved.projectId) throw new Error(`ticket ${ticket} is not in project ${ctx.resolved.config.project}`);
  const status = statusOf(ctx.resolved, full.state.id);
  const snapshot = await ctx.workspaces.snapshot();
  const workspace = workspaceForTicket(snapshot, ticket);
  const live = snapshot.agents.filter((a) => a.workspaceId === workspace?.workspaceId &&
    (["build", "review", "deliver"] as const).some((s) => a.name === workerAgentName(s, ticket)) &&
    !/^(done|ended|exited|failed|gone|stopped)$/i.test(a.agentStatus));

  if (request.command === "worker.start") {
    const state = bareTodoState(ctx.resolved, full) ?? deriveState(ctx.resolved, full);
    const result = await startStageTicket(ctx, full, state, role ? { stage: role as CommanderStage } : {});
    return { ...result, data: result };
  }
  if (request.command === "worker.stop" && status === "done" && !role) {
    deriveState(ctx.resolved, full); // Cleanup requires a fully converged Done.
    const receipt = latestValidReceipt(full.comments);
    if (receipt?.receipt.kind !== "deliver") throw new Error("Done cleanup requires a current valid Deliver receipt");
    const landed = receipt.receipt.landed ?? receipt.receipt.checkpoint;
    if (!/^[0-9a-f]{7,64}$/.test(receipt.receipt.checkpoint) || !/^[0-9a-f]{7,64}$/.test(landed)) {
      throw new Error("Done cleanup receipt must bind Git checkpoint and landed hashes");
    }
    if (workspace) {
      const workers = snapshot.agents.filter((agent) => agent.workspaceId === workspace.workspaceId &&
        (["build", "review", "deliver"] as const).some((stage) => agent.name === workerAgentName(stage, ticket)));
      for (const worker of workers) {
        if (!ctx.workspaces.stopAgent) throw new Error("worker stop is not configured");
        await ctx.workspaces.stopAgent(worker.name);
      }
      // Only the root shell created by worker start belongs to us after the
      // workflow panes close. Never close user panes or delete their cwd.
      const remaining = await ctx.workspaces.snapshot();
      const rootPane = workspace.tokens["worker_root_pane"];
      if (remaining.panes.some((pane) => pane.workspaceId === workspace.workspaceId && pane.paneId !== rootPane) ||
          remaining.agents.some((agent) => agent.workspaceId === workspace.workspaceId)) {
        return { ok: false, text: `${ticket}: workflow workers stopped; non-workflow panes remain, keeping workspace and checkout` };
      }
    }
    const cleanup = await cleanupTicketCheckout(ctx.git ?? bunGitRunner(), ctx.repoRoot, ticket, {
      checkpoint: landed,
      targetBranch: ctx.resolved.config.targetBranch,
    });
    if (cleanup.ok && workspace) await ctx.workspaces.close(workspace.workspaceId);
    return { ok: cleanup.ok, text: `${ticket}: workers stopped; ${cleanup.detail}` };
  }
  if (!role && live.length > 1) throw new Error(`multiple workers for ${ticket}; select --role build|review|deliver`);
  const stage = (role as CommanderStage | undefined) ??
    (["build", "review", "deliver"] as const).find((s) => live[0]?.name === workerAgentName(s, ticket)) ?? (status ? stageForStatus(status) : null);
  if (!stage) throw new Error(`no worker role for ${ticket}; select --role`);
  const worker = workerAgentName(stage, ticket);
  const agent = live.find((a) => a.name === worker);
  if (request.command === "worker.stop") {
    if (agent) {
      if (!ctx.workspaces.stopAgent) throw new Error("worker stop is not configured");
      await ctx.workspaces.stopAgent(worker);
    }
    return { ok: true, text: `${ticket}: ${worker} stopped; checkout preserved` };
  }
  const config = commanderConfigForRun(ctx.resolved.config.commander, workspace?.tokens ?? {});
  let profile: CommanderAgentConfig = config.agents[STAGE_AGENTS[stage]];
  if (request.command === "worker.restart") {
    const state = bareTodoState(ctx.resolved, full) ?? deriveState(ctx.resolved, full);
    if (stage !== stageForStatus(state.status) || !["pending", "in_progress"].includes(state.progress ?? (state.status === "todo" ? "pending" : ""))) {
      throw new Error(`cannot restart ${stage} while ticket is ${state.status}+${state.progress ?? "none"}`);
    }
    if (request.profile) {
      const selected = request.profile;
      if (selected === "fallback") profile = config.agents.builder.fallback;
      else if (["builder", "reviewer", "deliverer"].includes(selected)) profile = config.agents[selected as "builder" | "reviewer" | "deliverer"];
    }
    profile = {
      harness: request.harness ?? profile.harness,
      model: request.model ?? profile.model,
      ...(request.effort ? { effort: request.effort } : request.harness && request.harness !== profile.harness ? {} : profile.effort ? { effort: profile.effort } : {}),
    };
    launchFor(profile); // Validate the effective launch before stopping anything.
    if (!workspace) throw new Error(`no workspace for ${ticket}; use worker start first`);
    if (!ctx.workspaces.stopAgent) throw new Error("worker stop is not configured");
    const restartKey = `restart_${stage}`;
    const restartRequest = JSON.stringify([latestValidReceipt(full.comments)?.receipt.submission ?? "initial", profile]);
    const previous = workspace.tokens[restartKey] ? JSON.parse(workspace.tokens[restartKey]) as { request: string; oldPane?: string } : null;
    const rebuilding = previous?.request === restartRequest;
    const rebuilt = rebuilding && agent && agent.paneId !== previous.oldPane;
    // Persist intent before stop, but keep the current pane's profile until
    // it has stopped. Permission answers must still use the live harness
    // when a stop fails during a cross-harness model switch.
    await ctx.workspaces.reportMetadata(workspace.workspaceId, {
      [restartKey]: JSON.stringify(rebuilding ? previous : { request: restartRequest, oldPane: agent?.paneId }),
    });
    if (agent && !rebuilt) await ctx.workspaces.stopAgent(worker);
    await ctx.workspaces.reportMetadata(workspace.workspaceId, {
      [`profile_${STAGE_AGENTS[stage]}`]: JSON.stringify(stage === "build" ? { ...profile, fallback: config.agents.builder.fallback } : profile),
      ...(stage === "build" ? { builder: null } : {}),
    });
    const result = await startStageTicket(ctx, full, state, { stage });
    return { ...result, data: result };
  }
  if (!agent) throw new Error(`no live ${stage} worker for ${ticket}`);
  if (request.command === "worker.send") {
    await ctx.workspaces.prompt(worker, request.text);
    return { ok: true, text: `${ticket}: sent to ${worker}` };
  }
  if (request.command !== "worker.answer") throw new Error(`unexpected worker action ${action}`);
  // Bind the answer to the exact pane output observed immediately before sending.
  const before = await ctx.workspaces.readPane(agent.paneId, 80);
  const fresh = (await ctx.workspaces.snapshot()).agents.find((a) => a.name === worker);
  const after = await ctx.workspaces.readPane(agent.paneId, 80);
  if (fresh?.paneId !== agent.paneId || fresh.session !== agent.session || before.revision !== after.revision || before.text !== after.text) {
    throw new Error("worker permission dialog changed; reread before answering");
  }
  const key = request.answer;
  await ctx.workspaces.sendKeys(agent.paneId, profile.harness === "claude" ? [key === "y" ? "enter" : "esc"] : [key]);
  return { ok: true, text: `${ticket}: answered ${key} for ${worker}` };
}
