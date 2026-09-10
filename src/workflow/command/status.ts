import type { CommandResult } from "../config/claims.ts";
import { fail, type CommandContext } from "../context.ts";
import {
  bareTodoState,
  countBuildSlots,
  deriveState,
  describeState,
  incompleteStatusText,
  latestValidReceipt,
  mergedDeliveryState,
  statusOf,
  type FullIssue,
  type WorkspaceMeta,
} from "../lifecycle/ticket/protocol.ts";
import {
  stageWorkerName,
  tokensByTicket,
  workspaceForTicket,
  type WorkspaceSnapshot,
} from "../service/workspace/workspaces.ts";

export interface StatusTicketData {
  identifier: string;
  title: string;
  state: string;
  progress: string | null;
  checkpoint: string | null;
  receipt: string | null;
  hasWorkspace: boolean;
  stage: string | null;
  stageAt: string | null;
  startedAt: string | null;
  elapsedMs: number | null;
  budgetMs: number;
  over: boolean;
  worker: string;
  blocked: boolean;
  stalled: boolean;
  overBudget: boolean;
}

export interface StatusData {
  slots: { used: number; max: number };
  tickets: StatusTicketData[];
}

export interface StatusCollection {
  data: StatusData;
  snapshot: WorkspaceSnapshot | null;
  herdrNote: string | null;
}

export async function collectStatus(ctx: CommandContext): Promise<StatusCollection> {
  const { client, resolved } = ctx;
  const max = resolved.config.maxRunning;
  const inBuild = await client.listIssuesByState(resolved.projectId, resolved.stateIds.build);
  const inReview = await client.listIssuesByState(resolved.projectId, resolved.stateIds.review);
  const inDeliver = await client.listIssuesByState(resolved.projectId, resolved.stateIds.deliver);
  const listed = [...inBuild, ...inReview, ...inDeliver];

  let snapshot: WorkspaceSnapshot | null = null;
  let herdrNote: string | null = null;
  try {
    snapshot = await ctx.workspaces.snapshot();
  } catch (error) {
    herdrNote = `herdr unreachable: ${(error as Error).message}`;
  }
  const tokens = snapshot ? tokensByTicket(snapshot) : new Map<string, Record<string, string>>();
  const workerStatus = (identifier: string, stage: string | null): string => {
    if (!snapshot) return "missing";
    if (stage !== "build" && stage !== "review" && stage !== "deliver") return "missing";
    const agent = snapshot.agents.find((candidate) => candidate.name === stageWorkerName(stage, identifier));
    return agent?.agentStatus ?? "missing";
  };

  const used = await countBuildSlots(client, resolved);
  const tickets: StatusTicketData[] = [];
  for (const issue of listed) {
    const workspace = snapshot ? workspaceForTicket(snapshot, issue.identifier) : undefined;
    const tk = tokens.get(issue.identifier) ?? workspace?.tokens ?? {};
    const status = statusOf(resolved, issue.state.id);
    let progress: string | null = null;
    try {
      progress = deriveState(resolved, { ...issue, comments: [], labels: issue.labels ?? [] } as FullIssue).progress;
    } catch {
      progress = null;
    }
    let receiptKind = tk["receipt_kind"];
    let receiptId = tk["receipt_id"];
    let checkpoint = tk["checkpoint"] ?? null;
    try {
      const full = await client.fetchIssue(issue.id);
      const linear = full ? latestValidReceipt(full.comments) : null;
      if (linear) {
        receiptKind = linear.receipt.kind;
        receiptId = linear.id ?? undefined;
        checkpoint = linear.receipt.checkpoint;
      }
    } catch {
      // Keep cached workspace tokens when Linear receipt lookup fails.
    }
    tickets.push({
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state.name,
      progress,
      checkpoint,
      receipt: receiptKind && receiptId ? `${receiptKind}:${receiptId}` : null,
      hasWorkspace: workspace !== undefined,
      stage: status,
      stageAt: null,
      startedAt: null,
      elapsedMs: null,
      budgetMs: 0,
      over: false,
      worker: workerStatus(issue.identifier, status),
      blocked: progress === "blocked",
      stalled: tk["stalled"] === "1",
      overBudget: false,
    });
  }

  return { data: { slots: { used, max }, tickets }, snapshot, herdrNote };
}

export async function statusCommand(
  ticket: string | undefined,
  json: boolean,
  ctx: CommandContext,
): Promise<CommandResult> {
  if (!ticket) {
    const { data, snapshot, herdrNote } = await collectStatus(ctx);
    if (json) {
      const payload = {
        slots: data.slots,
        queue: data.tickets.map((item) => ({
          identifier: item.identifier,
          title: item.title,
          state: item.state,
          progress: item.progress,
          checkpoint: item.checkpoint,
          receipt: item.receipt,
          hasWorkspace: item.hasWorkspace,
          stage: item.stage,
          worker: item.worker,
          blocked: item.blocked,
        })),
        ...(herdrNote ? { herdrNote } : {}),
      };
      return { ok: true, text: JSON.stringify(payload, null, 2), data: payload };
    }
    const lines = [`${data.slots.used} / ${data.slots.max} slots`];
    if (herdrNote) lines.push(herdrNote);
    for (const item of data.tickets) {
      if (!snapshot) {
        lines.push(`${item.identifier}  no workspace info`);
        continue;
      }
      if (!item.hasWorkspace) {
        lines.push(`${item.identifier}  no workspace`);
        continue;
      }
      const at = item.progress ? `${item.state}/${progressName(ctx, item.progress)}` : item.state;
      const checkpoint = item.checkpoint ? ` checkpoint ${item.checkpoint.slice(0, 12)}` : "";
      const receipt = item.receipt ? ` receipt ${item.receipt}` : "";
      const tail = item.blocked ? " · blocked" : "";
      lines.push(`${item.identifier}  ${at}${checkpoint}${receipt}   worker ${item.worker}${tail}`);
    }
    return { ok: true, text: lines.join("\n"), data };
  }
  if (json) return ticketStatus(ticket, ctx);
  return fail("ticket status requires --json");
}

async function ticketStatus(identifier: string, ctx: CommandContext): Promise<CommandResult> {
  const ticket = identifier.toUpperCase();
  const full = (await ctx.client.fetchIssue(ticket)) as FullIssue | null;
  if (!full) {
    await ctx.decisions.record(ticket, `status failed: ticket "${ticket}" was not found in Linear`);
    return fail(`ticket "${ticket}" was not found in Linear`);
  }
  if (full.projectId !== ctx.resolved.projectId) {
    await ctx.decisions.record(full.identifier, `status failed: not in project "${ctx.resolved.config.project}"`);
    return fail(`ticket "${full.identifier}" is not in project "${ctx.resolved.config.project}"`);
  }
  let meta: WorkspaceMeta = {};
  try {
    const snapshot = await ctx.workspaces.snapshot();
    meta = workspaceForTicket(snapshot, full.identifier)?.tokens ?? {};
  } catch {
    meta = {};
  }
  let state;
  try {
    state = deriveState(ctx.resolved, full);
  } catch (error) {
    const bare = bareTodoState(ctx.resolved, full);
    if (bare) {
      state = bare;
    } else {
      const merged = mergedDeliveryState(ctx.resolved, full);
      if (merged) return stateResult(full, meta, merged);
      const incomplete = incompleteStatusText(ctx.resolved, full);
      if (incomplete) return fail(incomplete);
      return fail((error as Error).message);
    }
  }
  return stateResult(full, meta, state);
}

function stateResult(full: FullIssue, meta: WorkspaceMeta, state: ReturnType<typeof deriveState>): CommandResult {
  const data = describeState(full, meta, state);
  return { ok: true, text: JSON.stringify(data, null, 2), data };
}

function progressName(ctx: CommandContext, progress: string): string {
  const names: Record<string, string> = {
    pending: ctx.resolved.config.progress.pending,
    in_progress: ctx.resolved.config.progress.in_progress,
    complete: ctx.resolved.config.progress.complete,
    blocked: ctx.resolved.config.progress.blocked,
  };
  return names[progress] ?? progress;
}
