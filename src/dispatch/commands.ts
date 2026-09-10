// Dispatch commands: the typed boundary behind the Igniter CLI.
//
// Each command does its permitted Linear or worker work through the injected
// context, records its
// activity lines through the DecisionLog, and returns `{ ok, text, data? }`
// — text for the terminal, structured data for callers that need it.
//
// Linear and worker commands share this door with explicit boundaries:
// - `status`, `begin`, `submit`, `approve`, `block`, `unblock`, `fail`, and
//   `reconcile` operate ticket protocol state without worker lifecycle effects.
// - `worker start|send|restart|stop|answer` may read ticket context but never
//   write Linear. `start` remains Global Commander lifecycle and assignment.
// The Global Commander invokes them from the project workspace.
//
// igniter never judges: commands only carry out what Linear and the caller
// say. Judgments belong to the Global Commander outside Igniter.

import {
  type CommandResult,
  type DecisionLog,
  type ResolvedDispatch,
} from "./claims.ts";
import type { LinearClientLike } from "./linear.ts";
import {
  bareTodoState,
  moveStatus,
  blockMutation,
  countBuildSlots,
  deriveState,
  describeState,
  incompleteStatusText,
  latestValidReceipt,
  mergedDeliveryState,
  normalizeOwnerMove,
  normalizeBareTodo,
  statusOf,
  submitMutation,
  unblockMutation,
  ProtocolError,
  type FullIssue,
  type ProtocolDeps,
  type WorkspaceMeta,
} from "./protocol.ts";
import {
  failTicket,
  formatDuration,
  type FailureDeps,
} from "./recovery.ts";
import {
  stageWorkerName,
  tokensByTicket,
  workspaceForTicket,
  type CommandWorkspaces,
  type WorkspaceSnapshot,
} from "./workspaces.ts";
import {
  type PromptDeliveryPolicy,
} from "./prompt-delivery.ts";
import { bunGitRunner, type GitRunner } from "./worktrees.ts";
import type { CommandRequest } from "./command-request.ts";

export type { CommandResult };

/** Whole minutes/hours Durations for agents: 12s, 34m, 2h, 1h12m, 5h02m. */
export { formatDuration };

export interface CommandContext {
  client: LinearClientLike;
  resolved: ResolvedDispatch;
  decisions: DecisionLog;
  workspaces: CommandWorkspaces;
  /** Repo root used as the workspace cwd. */
  repoRoot: string;
  git?: GitRunner;
  now?: () => number;
  /** Prompt-delivery confirmation budget; tests inject a no-op clock. */
  promptDelivery?: PromptDeliveryPolicy;
}

function fail(text: string): CommandResult {
  return { ok: false, text };
}

export function runCommand(
  command: CommandRequest,
  ctx: CommandContext,
): Promise<CommandResult> {
  return dispatchCommand(command, ctx);
}

function dispatchCommand(
  command: CommandRequest,
  ctx: CommandContext,
): Promise<CommandResult> {
  switch (command.command) {
    case "status":
      return statusCommand(command.ticket, command.json === true, ctx);
    case "start":
      return startCommand(command.ticket, ctx);
    case "begin":
      return beginCommand(command.ticket, ctx);
    case "reconcile":
      return reconcileCommand(command.ticket, ctx);
    case "approve":
      return approveCommand(command.ticket, command.receipt, ctx);
    case "fail":
      return failCommand(command.ticket, command.reason, ctx);
    case "submit":
      return submitCommand(command.ticket, command.payload, ctx);
    case "block":
      return blockCommand(command.ticket, command.reason, ctx);
    case "unblock":
      return unblockCommand(command.ticket, ctx);
    default:
      return import("./worker-commands.ts").then(({ workerCommand }) => workerCommand(command, ctx));
  }
}

function depsOf(ctx: CommandContext): ProtocolDeps {
  return {
    client: ctx.client,
    resolved: ctx.resolved,
    workspaces: ctx.workspaces,
    decisions: ctx.decisions,
    git: ctx.git ?? bunGitRunner(),
    repoRoot: ctx.repoRoot,
  };
}

async function refuse(ctx: CommandContext, ticket: string, error: unknown): Promise<CommandResult> {
  const text = error instanceof Error ? error.message : String(error);
  await ctx.decisions.record(ticket, `refused: ${text}`);
  return { ok: false, text };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export interface StatusTicketData {
  identifier: string;
  title: string;
  /** Linear status name, e.g. Build. */
  state: string;
  /** Progress name, e.g. In progress; null on backlog/done rows. */
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
  /** Current stage worker (`builder|reviewer|deliverer-<ticket>`) status, or missing. */
  worker: string;
  blocked: boolean;
  stalled: boolean;
  overBudget: boolean;
}

export interface StatusData {
  slots: { used: number; max: number };
  tickets: StatusTicketData[];
}

function findWorkspace(snapshot: WorkspaceSnapshot, identifier: string) {
  return workspaceForTicket(snapshot, identifier);
}

export interface StatusCollection {
  data: StatusData;
  /** Null when Herdr is unreachable: tickets carry no workspace info. */
  snapshot: WorkspaceSnapshot | null;
  herdrNote: string | null;
}

/** Shared collection behind `igniter status` and the board snapshot: Linear
 *  says which tickets are in play, one Herdr snapshot says which of those
 *  are actually running. */
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
    const agent = snapshot.agents.find((a) => a.name === stageWorkerName(stage, identifier));
    return agent?.agentStatus ?? "missing";
  };

  const used = await countBuildSlots(client, resolved);
  const tickets: StatusTicketData[] = [];
  for (const issue of listed) {
    const workspace = snapshot ? findWorkspace(snapshot, issue.identifier) : undefined;
    const tk = tokens.get(issue.identifier) ?? workspace?.tokens ?? {};
    const status = statusOf(resolved, issue.state.id);
    let progress: string | null = null;
    try {
      const derived = deriveState(resolved, { ...issue, comments: [], labels: issue.labels ?? [] } as FullIssue);
      progress = derived.progress;
    } catch {
      progress = null;
    }
    // The Linear receipt is the protocol truth; workspace tokens only fill
    // the display cache when the fetch or the receipt is missing.
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
      // Keep the cached tokens; the row still lists the ticket.
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

  const data: StatusData = { slots: { used, max }, tickets };
  return { data, snapshot, herdrNote };
}

async function statusCommand(ticket: string | undefined, json: boolean, ctx: CommandContext): Promise<CommandResult> {
  if (!ticket) {
    const { data, snapshot, herdrNote } = await collectStatus(ctx);
    if (json) {
      const payload = {
        slots: data.slots,
        queue: data.tickets.map((t) => ({
          identifier: t.identifier,
          title: t.title,
          state: t.state,
          progress: t.progress,
          checkpoint: t.checkpoint,
          receipt: t.receipt,
          hasWorkspace: t.hasWorkspace,
          stage: t.stage,
          worker: t.worker,
          blocked: t.blocked,
        })),
        ...(herdrNote ? { herdrNote } : {}),
      };
      return { ok: true, text: JSON.stringify(payload, null, 2), data: payload };
    }
    const header = `${data.slots.used} / ${data.slots.max} slots`;
    const lines = [header];
    if (herdrNote) lines.push(herdrNote);
    for (const ticket of data.tickets) {
      if (!snapshot) {
        lines.push(`${ticket.identifier}  no workspace info`);
        continue;
      }
      if (!ticket.hasWorkspace) {
        lines.push(`${ticket.identifier}  no workspace`);
        continue;
      }
      const at = ticket.progress ? `${ticket.state}/${progressName(ctx, ticket.progress)}` : ticket.state;
      const checkpoint = ticket.checkpoint ? ` checkpoint ${ticket.checkpoint.slice(0, 12)}` : "";
      const receipt = ticket.receipt ? ` receipt ${ticket.receipt}` : "";
      const flags = [
        ticket.blocked ? "blocked" : "",
      ].filter(Boolean).join(" · ");
      const tail = flags ? ` · ${flags}` : "";
      lines.push(`${ticket.identifier}  ${at}${checkpoint}${receipt}   worker ${ticket.worker}${tail}`);
    }
    return { ok: true, text: lines.join("\n"), data };
  }
  if (json) return ticketStatusCommand(ticket, ctx);
  return fail("ticket status requires --json");
}

/**
 * `igniter status <ticket> --json`: the Global Commander's per-ticket read.
 * Needs no ticket workspace context: Linear is the truth, workspace tokens
 * only fill the display cache. Returns criteria, status, progress,
 * checkpoint, receipt, legal next steps, and the submit schema.
 */
async function ticketStatusCommand(identifier: string, ctx: CommandContext): Promise<CommandResult> {
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
    // A bare Todo is the one incomplete state this read reports instead of
    // refusing: the JSON names it and offers the actionable next step
    // (`worker start`, then `begin`), with no background dispatch reference. Incomplete active
    // stages fail closed without writes: the text names the pair and points
    // at `reconcile`. Other tickets are unaffected — this command names
    // exactly one ticket.
    const bare = bareTodoState(ctx.resolved, full);
    if (bare) {
      state = bare;
    } else {
      const merged = mergedDeliveryState(ctx.resolved, full);
      if (merged) {
        state = merged;
        const data = describeState(full, meta, state);
        return { ok: true, text: JSON.stringify(data, null, 2), data };
      }
      const incomplete = incompleteStatusText(ctx.resolved, full);
      if (incomplete) return fail(incomplete);
      return fail((error as Error).message);
    }
  }
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

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

async function reconcileCommand(identifier: string, ctx: CommandContext): Promise<CommandResult> {
  const full = (await ctx.client.fetchIssue(identifier)) as FullIssue | null;
  if (!full) {
    await ctx.decisions.record(identifier, `reconcile failed: ticket "${identifier}" was not found in Linear`);
    return fail(`ticket "${identifier}" was not found in Linear`);
  }
  if (full.projectId !== ctx.resolved.projectId) {
    await ctx.decisions.record(full.identifier, `reconcile failed: not in project "${ctx.resolved.config.project}"`);
    return fail(`ticket "${full.identifier}" is not in project "${ctx.resolved.config.project}"`);
  }
  const outcome = await normalizeOwnerMove(depsOf(ctx), full);
  if (outcome.result) return outcome.result;
  const state = deriveState(ctx.resolved, full);
  return {
    ok: true,
    text: `${full.identifier}: no owner transition to reconcile (${state.status}+${state.progress ?? "none"})`,
  };
}

// ---------------------------------------------------------------------------
// answer
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

/**
 * The keys an answer sends, by the Commander harness from the resolved
 * configuration. Claude Code answers its numbered permission dialog
 * with enter/esc; every other kind gets the literal y/n key.
 */
export function answerKeysFor(kind: string | undefined, key: string): string[] {
  if ((kind ?? "").toLowerCase() === "claude") {
    return [key === "y" ? "enter" : "esc"];
  }
  return [key];
}

/** Prepare the configured Global Commander for the calling terminal. */
async function startCommand(
  ticket: string | undefined,
  ctx: CommandContext,
): Promise<CommandResult> {
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
  const { prepareCommanderForeground } = await import("./commander-start.ts");
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

/**
 * `igniter begin STA-X` validates and records the ticket's current stage
 * start, derived from Linear state. It never prepares worktrees, launches
 * workers, or sends prompts; the Commander confirms `worker start` first.
 */
async function beginCommand(ticket: string, ctx: CommandContext): Promise<CommandResult> {
  return beginTicket(ctx, ticket.toUpperCase());
}

async function beginTicket(ctx: CommandContext, identifier: string): Promise<CommandResult> {
  try {
    let full = await ticketIssue(ctx, identifier);
    const deps = depsOf(ctx);
    const bare = bareTodoState(ctx.resolved, full);
    const state = bare ?? deriveState(ctx.resolved, full);
    if (state.progress === "in_progress" && state.status !== "todo") {
      return { ok: true, text: `already began ${full.identifier}: ${state.status}+in_progress` };
    }
    if (!["todo", "build", "review", "deliver"].includes(state.status) || (!bare && state.progress !== "pending")) {
      throw new ProtocolError(`begin needs Todo, Build, Review, or Deliver + Pending; ${state.status}+${state.progress}`);
    }
    if (state.criteria.length === 0) throw new ProtocolError("begin requires acceptance criteria");
    if (state.status === "todo") {
      if (await countBuildSlots(ctx.client, ctx.resolved) >= ctx.resolved.config.maxRunning) {
        throw new ProtocolError(`at max_running (${ctx.resolved.config.maxRunning})`);
      }
    }
    if (bare) full = await normalizeBareTodo(deps, full);
    const target = state.status === "todo" ? "build" : state.status;
    const { recordStageStart } = await import("./protocol.ts");
    full = await recordStageStart(deps, full, target);
    await moveStatus(deps, full, target, "in_progress");
    await ctx.decisions.record(full.identifier, `begin: ${state.status}+pending → ${target}+in_progress`);
    return { ok: true, text: `began ${full.identifier}: ${target}+in_progress` };
  } catch (error) { return refuse(ctx, identifier, error); }
}

async function ticketIssue(ctx: CommandContext, identifier: string): Promise<FullIssue> {
  const full = await ctx.client.fetchIssue(identifier.toUpperCase()) as FullIssue | null;
  if (!full) throw new ProtocolError(`ticket "${identifier}" was not found in Linear`);
  if (full.projectId !== ctx.resolved.projectId) throw new ProtocolError(`ticket "${identifier}" is not in project "${ctx.resolved.config.project}"`);
  return full;
}

async function approveCommand(ticket: string, receipt: string, ctx: CommandContext): Promise<CommandResult> {
  try {
    const { approveTicket } = await import("./approval.ts");
    return await approveTicket(depsOf(ctx), await ticketIssue(ctx, ticket), receipt);
  } catch (error) { return refuse(ctx, ticket, error); }
}

async function failCommand(identifier: string, rawReason: string, ctx: CommandContext): Promise<CommandResult> {
  const { client, resolved, decisions } = ctx;
  const reason = rawReason.trim();
  if (!reason) return fail("failure reason cannot be blank");
  const full = await client.fetchIssue(identifier);
  if (!full) {
    await decisions.record(identifier, `fail failed: ticket "${identifier}" was not found in Linear`);
    return fail(`ticket "${identifier}" was not found in Linear`);
  }
  if (full.projectId !== resolved.projectId) {
    await decisions.record(full.identifier, `fail failed: not in project "${resolved.config.project}"`);
    return fail(`ticket "${full.identifier}" is not in project "${resolved.config.project}"`);
  }

  const deps: FailureDeps = { client, resolved, workspaces: ctx.workspaces, decisions };
  return failTicket(deps, full, reason, null);
}

async function submitCommand(
  ticket: string,
  payload: unknown,
  ctx: CommandContext,
): Promise<CommandResult> {
  try {
    return { ok: true, text: await submitForTicket(ctx, ticket, payload) };
  } catch (error) {
    return refuse(ctx, ticket, error);
  }
}

/**
 * Ticket-targeted submit: Linear is the authority, workspace metadata never
 * authorizes the transition. State, criteria, and checkpoint come from the
 * freshly fetched issue.
 */
async function submitForTicket(ctx: CommandContext, identifier: string, payload: unknown): Promise<string> {
  const ticket = identifier.toUpperCase();
  const full = (await ctx.client.fetchIssue(ticket)) as FullIssue | null;
  if (!full) throw new ProtocolError(`ticket "${ticket}" was not found in Linear`);
  if (full.projectId !== ctx.resolved.projectId) {
    throw new ProtocolError(`ticket "${full.identifier}" is not in project "${ctx.resolved.config.project}"`);
  }
  const state = mergedDeliveryState(ctx.resolved, full) ?? deriveState(ctx.resolved, full);
  return submitMutation(depsOf(ctx), full, state, payload);
}

async function blockCommand(ticket: string, rawReason: string, ctx: CommandContext): Promise<CommandResult> {
  const reason = rawReason.trim();
  if (!reason) return fail("block reason cannot be blank");
  try {
    return { ok: true, text: await blockForTicket(ctx, ticket, reason) };
  } catch (error) {
    return refuse(ctx, ticket, error);
  }
}

async function blockForTicket(ctx: CommandContext, identifier: string, reason: string): Promise<string> {
  const ticket = identifier.toUpperCase();
  const full = (await ctx.client.fetchIssue(ticket)) as FullIssue | null;
  if (!full) throw new ProtocolError(`ticket "${ticket}" was not found in Linear`);
  if (full.projectId !== ctx.resolved.projectId) {
    throw new ProtocolError(`ticket "${full.identifier}" is not in project "${ctx.resolved.config.project}"`);
  }
  const state = deriveState(ctx.resolved, full);
  await blockMutation(depsOf(ctx), full, state, reason);
  return `blocked ${full.identifier}: ${reason}`;
}

async function unblockCommand(ticket: string, ctx: CommandContext): Promise<CommandResult> {
  try {
    return { ok: true, text: await unblockForTicket(ctx, ticket) };
  } catch (error) {
    return refuse(ctx, ticket, error);
  }
}

async function unblockForTicket(ctx: CommandContext, identifier: string): Promise<string> {
  const ticket = identifier.toUpperCase();
  const full = (await ctx.client.fetchIssue(ticket)) as FullIssue | null;
  if (!full) throw new ProtocolError(`ticket "${ticket}" was not found in Linear`);
  if (full.projectId !== ctx.resolved.projectId) {
    throw new ProtocolError(`ticket "${full.identifier}" is not in project "${ctx.resolved.config.project}"`);
  }
  const state = deriveState(ctx.resolved, full);
  await unblockMutation(depsOf(ctx), full, state);
  return `unblocked ${full.identifier}: back to pending; run \`igniter begin ${full.identifier}\``;
}
