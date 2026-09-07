// Dispatch commands: the one door into a running igniter.
//
// Both the web page and the CLI go through `POST /api/command` with
// `{ argv, workspaceId?, input? }`, and land here. Each command takes argv,
// does its Linear and Herdr work through the injected context, records its
// activity lines through the DecisionLog, and returns `{ ok, text, data? }`
// — text for an agent, data for the web page.
//
// Two families share this door and never collide:
// - Dispatch commands (`status`, `start`, `pause`, `resume`, `fail`,
//   `restart`, `answer`) name a ticket and run anywhere; only `serve` holds
//   the Linear key.
// - Workspace commands (`state`, `begin`, `submit`, `block`, `unblock`)
//   name no ticket: the CLI forwards the Herdr workspace id, and the ticket
//   comes from that workspace's igniter metadata only.
//
// igniter never judges: commands only carry out what Linear and the caller
// say. Judgments belong to the Commander in the Herdr pane, or to whoever
// commands igniter from outside.

import {
  ensureAcceptanceCriteria,
  WorkspaceSinkError,
  type ClaimedTicket,
  type ClaimSink,
  type CommandCallOptions,
  type CommandResult,
  type DecisionLog,
  type ResolvedDispatch,
} from "./claims.ts";
import type { CommanderConfig, CommanderStage, DispatchConfig } from "./config.ts";
import { commanderConfigForRun, keptStageProfiles, launchFor, recordStageProfiles } from "./agents.ts";
import { commanderAssetPaths, type CommanderAssetPaths } from "../commander/assets.ts";
import { LinearClient } from "./linear.ts";
import {
  adoptTicket,
  beginMutation,
  blockMutation,
  claimTicket,
  countBuildSlots,
  deriveState,
  describeState,
  finishClaim,
  latestValidReceipt,
  normalizeOwnerMove,
  statusOf,
  submitMutation,
  unblockMutation,
  ProtocolError,
  type FullIssue,
  type ProtocolDeps,
  type ProtocolProgress,
  type ProtocolStatus,
  type WorkspaceMeta,
} from "./protocol.ts";
import {
  failTicket,
  formatDuration,
  type FailureDeps,
} from "./recovery.ts";
import {
  commanderName,
  tokensByTicket,
  workspaceForTicket,
  type CommandWorkspaces,
  type SnapshotWorkspace,
  type WorkspaceSnapshot,
} from "./workspaces.ts";
import {
  confirmPromptDelivery,
  deliveryKey,
  PromptDeliveryError,
  workOrderHash,
  type PromptDeliveryPolicy,
  type PromptRole,
  type PromptStage,
} from "./prompt-delivery.ts";
import {
  bunGitRunner,
  ensureTicketWorktree,
  ticketWorktree,
  type GitRunner,
} from "./worktrees.ts";
import {
  ensureScratchDir,
  scratchFor,
  scratchRootFor,
  type WorkerName,
} from "./worker-scope.ts";

export type { CommandResult };

/** Whole minutes/hours Durations for agents: 12s, 34m, 2h, 1h12m, 5h02m. */
export { formatDuration };

export interface CommandContext {
  client: LinearClient;
  resolved: ResolvedDispatch;
  host: string;
  decisions: DecisionLog;
  workspaces: CommandWorkspaces;
  sink: ClaimSink;
  /** Repo root: the cwd `igniter serve` runs in, used as the workspace cwd. */
  repoRoot: string;
  git?: GitRunner;
  lastPollAt: () => string | null;
  now?: () => number;
  /** Prompt-delivery confirmation budget; tests inject a no-op clock. */
  promptDelivery?: PromptDeliveryPolicy;
}

const TOP_USAGE =
  "usage: igniter <status|start <ticket>|reconcile <ticket>|pause <ticket>|resume <ticket>|fail <ticket> --reason TEXT|restart <ticket> --builder MODEL|answer <ticket> y|n|state --json|begin|submit --input -|block --reason TEXT|unblock>";

function usage(command: string): string {
  switch (command) {
    case "status":
      return "usage: igniter status";
    case "start":
      return "usage: igniter start <ticket> [--builder <model>]";
    case "reconcile":
      return "usage: igniter reconcile <ticket>";
    case "pause":
      return "usage: igniter pause <ticket>";
    case "resume":
      return "usage: igniter resume <ticket>";
    case "fail":
      return "usage: igniter fail <ticket> --reason TEXT";
    case "restart":
      return "usage: igniter restart <ticket> --builder <model>";
    case "answer":
      return "usage: igniter answer <ticket> y|n";
    case "state":
      return "usage: igniter state --json";
    case "begin":
      return "usage: igniter begin";
    case "submit":
      return "usage: igniter submit --input -";
    case "block":
      return "usage: igniter block --reason TEXT";
    case "unblock":
      return "usage: igniter unblock";
    default:
      return TOP_USAGE;
  }
}

function fail(text: string): CommandResult {
  return { ok: false, text };
}

/** Split `--flag value` and `--flag=value` forms out of args; the rest stays. */
function takeFlag(args: string[], name: string): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === `--${name}`) {
      value = args[i + 1];
      i += 1;
    } else if (arg.startsWith(`--${name}=`)) {
      value = arg.slice(name.length + 3);
    } else {
      rest.push(arg);
    }
  }
  return { value, rest };
}

const DISPATCH_COMMANDS = new Set(["status", "start", "reconcile", "pause", "resume", "fail", "restart", "answer"]);
const WORKSPACE_COMMANDS = new Set(["state", "begin", "submit", "block", "unblock"]);

export function runCommand(
  argv: string[],
  ctx: CommandContext,
  options: CommandCallOptions = {},
): Promise<CommandResult> {
  const [name, ...args] = argv;
  if (name === undefined) return Promise.resolve(fail(TOP_USAGE));
  if (DISPATCH_COMMANDS.has(name)) {
    switch (name) {
      case "status":
        if (args.length > 0) return Promise.resolve(fail(usage("status")));
        return statusCommand(ctx);
      case "start":
        return startCommand(args, ctx);
      case "reconcile":
        return reconcileCommand(args, ctx);
      case "pause":
        return pauseCommand(args, ctx);
      case "resume":
        return resumeCommand(args, ctx);
      case "fail":
        return failCommand(args, ctx);
      case "restart":
        return restartCommand(args, ctx);
      case "answer":
        return answerCommand(args, ctx);
    }
  }
  if (WORKSPACE_COMMANDS.has(name)) {
    if (!options.workspaceId) {
      return Promise.resolve(fail(
        `igniter ${name} runs inside a Herdr workspace only; dispatch commands take a ticket instead (${TOP_USAGE})`,
      ));
    }
    switch (name) {
      case "state":
        return stateCommand(args, ctx, options.workspaceId);
      case "begin":
        return beginCommand(args, ctx, options.workspaceId);
      case "submit":
        return submitCommand(args, ctx, options.workspaceId, options.input);
      case "block":
        return blockCommand(args, ctx, options.workspaceId);
      case "unblock":
        return unblockCommand(args, ctx, options.workspaceId);
    }
  }
  return Promise.resolve(fail(`unknown command "${name}"; ${TOP_USAGE}`));
}

function depsOf(ctx: CommandContext): ProtocolDeps & { sink: ClaimSink; host: string } {
  return {
    client: ctx.client,
    resolved: ctx.resolved,
    workspaces: ctx.workspaces,
    decisions: ctx.decisions,
    git: ctx.git ?? bunGitRunner(),
    repoRoot: ctx.repoRoot,
    sink: ctx.sink,
    host: ctx.host,
  };
}

// ---------------------------------------------------------------------------
// workspace resolution (the ticket comes from igniter metadata only)
// ---------------------------------------------------------------------------

export interface ResolvedWorkspace {
  workspace: SnapshotWorkspace;
  full: FullIssue;
  state: { status: ProtocolStatus; progress: ProtocolProgress | null; criteria: string[] };
  meta: WorkspaceMeta;
  snapshot: WorkspaceSnapshot;
}

async function resolveWorkspace(ctx: CommandContext, workspaceId: string): Promise<ResolvedWorkspace> {
  const { client, resolved, decisions } = ctx;
  let snapshot: WorkspaceSnapshot;
  try {
    snapshot = await ctx.workspaces.snapshot();
  } catch (error) {
    await decisions.record(workspaceId, `workspace command failed: herdr unreachable`);
    throw new ProtocolError(`herdr unreachable: ${(error as Error).message}`);
  }
  const workspace = snapshot.workspaces.find((w) => w.workspaceId === workspaceId);
  if (!workspace) {
    throw new ProtocolError(`unknown workspace "${workspaceId}"; run inside the ticket's Herdr workspace`);
  }
  const ticket = workspace.tokens["ticket"];
  if (!ticket) {
    throw new ProtocolError(
      `workspace "${workspaceId}" has no ticket metadata; dispatch writes it at claim time`,
    );
  }
  const full = (await client.fetchIssue(ticket)) as FullIssue | null;
  if (!full) {
    await decisions.record(ticket, `workspace command failed: ticket "${ticket}" was not found in Linear`);
    throw new ProtocolError(`ticket "${ticket}" was not found in Linear`);
  }
  if (full.projectId !== resolved.projectId) {
    await decisions.record(full.identifier, `workspace command failed: not in project "${resolved.config.project}"`);
    throw new ProtocolError(`ticket "${full.identifier}" is not in project "${resolved.config.project}"`);
  }
  // Pure derivation: no writes happen here, so a refusal costs nothing.
  const state = deriveState(resolved, full);
  return { workspace, full, state, meta: { ...workspace.tokens }, snapshot };
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
  commander: string;
  paused: boolean;
  blocked: boolean;
  stalled: boolean;
  overBudget: boolean;
}

export interface StatusData {
  slots: { used: number; max: number };
  lastPollAt: string | null;
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
  const lastPollAt = ctx.lastPollAt();
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
  const agentStatus = (identifier: string): string => {
    if (!snapshot) return "missing";
    const agent = snapshot.agents.find((a) => a.name === commanderName(identifier));
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
      commander: agentStatus(issue.identifier),
      paused: tk["paused"] === "1",
      blocked: progress === "blocked",
      stalled: tk["stalled"] === "1",
      overBudget: false,
    });
  }

  const data: StatusData = { slots: { used, max }, lastPollAt, tickets };
  return { data, snapshot, herdrNote };
}

async function statusCommand(ctx: CommandContext): Promise<CommandResult> {
  const { data, snapshot, herdrNote } = await collectStatus(ctx);
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
      ticket.paused ? "paused" : "",
      ticket.blocked ? "blocked" : "",
    ].filter(Boolean).join(" · ");
    const tail = flags ? ` · ${flags}` : "";
    lines.push(`${ticket.identifier}  ${at}${checkpoint}${receipt}   commander ${ticket.commander}${tail}`);
  }
  return { ok: true, text: lines.join("\n"), data };
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

async function reconcileCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
  if (args.length !== 1 || !args[0] || args[0].startsWith("--")) return fail(usage("reconcile"));
  const identifier = args[0];
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
  if (outcome.result) await ctx.decisions.record(full.identifier, outcome.result.text);
  if (outcome.followUp || outcome.closeDue) {
    const applied = outcome.result?.text ?? `${full.identifier} Linear state converged`;
    return fail(`${applied}; workspace follow-up did not finish — inspect it, then run reconcile again`);
  }
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

async function answerCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const { client, resolved, decisions } = ctx;
  if (args.length !== 2 || !args[0] || args[0].startsWith("--") || (args[1] !== "y" && args[1] !== "n")) {
    return fail(usage("answer"));
  }
  const identifier = args[0] as string;
  const key = args[1] as string;
  const full = await client.fetchIssue(identifier);
  if (!full) {
    await decisions.record(identifier, `answer failed: ticket "${identifier}" was not found in Linear`);
    return fail(`ticket "${identifier}" was not found in Linear`);
  }
  if (full.projectId !== resolved.projectId) {
    await decisions.record(full.identifier, `answer failed: not in project "${resolved.config.project}"`);
    return fail(`ticket "${full.identifier}" is not in project "${resolved.config.project}"`);
  }
  let snapshot: WorkspaceSnapshot;
  try {
    snapshot = await ctx.workspaces.snapshot();
  } catch (error) {
    await decisions.record(full.identifier, "answer failed: herdr unreachable");
    return fail(`herdr unreachable: ${(error as Error).message}`);
  }
  const workspace = findWorkspace(snapshot, full.identifier);
  if (!workspace) {
    await decisions.record(full.identifier, "answer failed: no workspace");
    return fail(`no workspace for ${full.identifier}`);
  }
  const agent = snapshot.agents.find((a) => a.name === commanderName(full.identifier));
  if (!agent) {
    await decisions.record(full.identifier, "answer failed: no live commander");
    return fail(`no live commander for ${full.identifier}`);
  }
  try {
    await ctx.workspaces.sendKeys(agent.paneId, answerKeysFor(ctx.resolved.config.commander.agents.commander.harness, key));
  } catch (error) {
    await decisions.record(full.identifier, `answer failed: ${(error as Error).message}`);
    return fail(`answer failed: ${(error as Error).message}`);
  }
  const verdict = key === "y" ? "allowed once" : "denied";
  const sent = answerKeysFor(ctx.resolved.config.commander.agents.commander.harness, key).join("+");
  await decisions.record(full.identifier, `answered ${key} (${verdict}, sent ${sent})`);
  return { ok: true, text: `answered ${key} for ${full.identifier} (${verdict}, sent ${sent}); commander pane received the key` };
}

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

async function startCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const { client, resolved, decisions } = ctx;
  const builderFlag = takeFlag(args, "builder");
  const rest = builderFlag.rest;
  if (rest.length !== 1 || !rest[0] || rest[0].startsWith("--")) {
    return fail(usage("start"));
  }
  if (builderFlag.value !== undefined && builderFlag.value === "") return fail(usage("start"));
  const identifier = rest[0] as string;

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

  const builder = builderFlag.value ?? resolved.config.commander.agents.builder.model;

  const deps = depsOf(ctx);
  const status = statusOf(resolved, full.state.id);

  let snapshot: WorkspaceSnapshot | null = null;
  try {
    snapshot = await ctx.workspaces.snapshot();
  } catch {
    snapshot = null;
  }
  const open = snapshot ? findWorkspace(snapshot, full.identifier) : undefined;
  const owned = open && open.tokens["ticket"] === full.identifier ? open : undefined;

  // An active ticket with a workspace is already running; one without is
  // adopted through the same path the watcher uses. Adoption keeps the
  // Linear state as is; the receipt history carries the run's identity.
  if (status === "build" || status === "review" || status === "deliver") {
    if (owned) {
      await decisions.record(full.identifier, "start refused: already running");
      return fail(`${full.identifier} is already running`);
    }
    try {
      const at = deriveState(resolved, full);
      const opened = await adoptTicket(deps, full, { builder });
      return { ok: true, text: `adopted ${full.identifier}: workspace ${opened.workspaceId} reopened at ${at.status}+${at.progress ?? "no progress"} (Linear kept)` };
    } catch (error) {
      return refuse(ctx, full.identifier, error);
    }
  }

  if (status !== "todo") {
    await decisions.record(full.identifier, `start refused: ticket is ${full.state.name}; start only claims Todo+Pending`);
    return fail(`start refused: ticket is ${full.state.name}; start only claims Todo+Pending`);
  }
  if (!(await ensureAcceptanceCriteria(client, resolved, full, decisions))) {
    return fail(`ticket "${full.identifier}" has no acceptance-criteria checklist and was not claimed; a comment was left on the issue`);
  }
  // A Todo ticket whose workspace is already open finishes its
  // half-written claim instead of opening a second workspace.
  if (owned) {
    try {
      const used = await countBuildSlots(client, resolved);
      if (used >= resolved.config.maxRunning) {
        await decisions.record(full.identifier, `start refused: at max_running (${resolved.config.maxRunning})`);
        return fail(`at max_running (${resolved.config.maxRunning})`);
      }
      const ticket = await finishClaim(deps, full, owned.workspaceId, owned.tokens, used);
      return {
        ok: true,
        text: `claimed ${full.identifier} → ${resolved.config.states.build}+${resolved.config.progress.in_progress} (slot ${ticket.slot}); finished in existing workspace ${owned.workspaceId}`,
      };
    } catch (error) {
      return refuse(ctx, full.identifier, error);
    }
  }
  try {
    const ticket = await claimTicket(deps, full, { builder });
    return {
      ok: true,
      text: `claimed ${full.identifier} → ${resolved.config.states.build}+${resolved.config.progress.in_progress} (slot ${ticket.slot}); workspace ${ticket.workspaceId} opened, commander=${ticket.commander} builder=${ticket.builder}`,
    };
  } catch (error) {
    if (error instanceof WorkspaceSinkError && error.workspaceId) {
      await decisions.record(full.identifier, `handoff failed: ${error.message} (workspace ${error.workspaceId})`);
      return fail(`handoff failed: ${error.message} (workspace ${error.workspaceId})`);
    }
    return refuse(ctx, full.identifier, error);
  }
}

// ---------------------------------------------------------------------------
// pause
// ---------------------------------------------------------------------------

export const PAUSE_PROMPT =
  "igniter: the owner paused this ticket. Finish the current tool call, do not start the next step, and wait.";

async function pauseCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const { client, resolved, decisions } = ctx;
  if (args.length !== 1 || !args[0] || args[0].startsWith("--")) return fail(usage("pause"));
  const identifier = args[0] as string;
  const full = (await client.fetchIssue(identifier)) as FullIssue | null;
  if (!full) {
    await decisions.record(identifier, `pause failed: ticket "${identifier}" was not found in Linear`);
    return fail(`ticket "${identifier}" was not found in Linear`);
  }
  if (full.projectId !== resolved.projectId) {
    await decisions.record(full.identifier, `pause failed: not in project "${resolved.config.project}"`);
    return fail(`ticket "${full.identifier}" is not in project "${resolved.config.project}"`);
  }
  let snapshot: WorkspaceSnapshot;
  try {
    snapshot = await ctx.workspaces.snapshot();
  } catch (error) {
    await decisions.record(full.identifier, `pause failed: herdr unreachable`);
    return fail(`herdr unreachable: ${(error as Error).message}`);
  }
  const workspace = findWorkspace(snapshot, full.identifier);
  if (!workspace) {
    await decisions.record(full.identifier, "pause failed: no workspace");
    return fail(`no workspace for ${full.identifier}`);
  }
  const deps = depsOf(ctx);
  try {
    // Pause shares the block transition (status kept, Progress Blocked,
    // Build slot freed) and adds the paused token on top.
    const state = deriveState(resolved, full);
    if (state.progress !== "blocked") {
      await blockMutation(deps, workspace.workspaceId, full, state, "owner pause");
    }
    await ctx.workspaces.reportMetadata(workspace.workspaceId, { paused: "1" });
  } catch (error) {
    return refuse(ctx, full.identifier, error);
  }
  await decisions.record(full.identifier, "paused by command");
  const agent = snapshot.agents.find((a) => a.name === commanderName(full.identifier));
  if (!agent) {
    return { ok: true, text: `paused ${full.identifier} (no commander agent; paused=1 recorded)` };
  }
  try {
    await ctx.workspaces.prompt(agent.name, PAUSE_PROMPT);
  } catch (error) {
    return { ok: true, text: `paused ${full.identifier}; commander prompt failed: ${(error as Error).message}` };
  }
  return { ok: true, text: `paused ${full.identifier}; commander prompted to stop` };
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

function resumePrompt(status: ProtocolStatus, progress: ProtocolProgress | null, checkpoint: string | null): string {
  return (
    `igniter: resume. Run \`igniter state --json\` and continue from status ${status} ` +
    `progress ${progress ?? "?"}${checkpoint ? ` checkpoint ${checkpoint}` : ""}; do not restart.`
  );
}

/**
 * The slice of dispatch context the Commander recovery path needs: Herdr,
 * decisions, the repo root, and validated dispatch. Both `igniter resume`
 * and the Review wake-up rebuild through exactly this scope.
 */
export interface RecoveryScope {
  workspaces: CommandWorkspaces;
  decisions: DecisionLog;
  repoRoot: string;
  resolved: ResolvedDispatch;
  /** Prompt-delivery confirmation budget; tests inject a no-op clock. */
  promptDelivery?: PromptDeliveryPolicy;
}

/**
 * Deliver a start prompt and prove the agent consumed it (STA-224). The
 * `agent_prompted` answer alone never counts: confirmation reads the agent
 * lifecycle back and only resolves once status, session, or revision moved.
 * Null on success, otherwise the full diagnosis (project, ticket, role,
 * stage, agent, pane revision, reason) for the caller's decision line.
 */
async function deliverStartPrompt(
  scope: Pick<RecoveryScope, "workspaces" | "promptDelivery">,
  input: {
    project: string;
    ticket: string | null;
    role: PromptRole;
    stage: PromptStage;
    agent: string;
    text: string;
  },
): Promise<string | null> {
  try {
    await confirmPromptDelivery(
      scope.workspaces,
      {
        project: input.project,
        ticket: input.ticket,
        role: input.role,
        stage: input.stage,
        agent: input.agent,
        workOrder: workOrderHash(input.text),
      },
      input.text,
      scope.promptDelivery,
    );
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * A pane the rebuilt Commander can actually start in: one with no agent on
 * it. Stage agents keep their own tabs, so the workspace's first pane is
 * often occupied (Herdr answers `agent.start` there with "not an available
 * shell"). When every pane is busy, open a fresh tab in the ticket worktree
 * and use its pane. Null when even that leaves no free pane.
 */
export async function commanderPane(
  ctx: RecoveryScope,
  ticket: string,
  workspaceId: string,
  snapshot: WorkspaceSnapshot,
): Promise<string | null> {
  const freeIn = (snap: WorkspaceSnapshot): string | null => {
    const busy = new Set(snap.agents.map((a) => a.paneId));
    return snap.panes.find((p) => p.workspaceId === workspaceId && !busy.has(p.paneId))?.paneId ?? null;
  };
  const direct = freeIn(snapshot);
  if (direct) return direct;
  const worktree = ticketWorktree(ctx.repoRoot, ticket);
  const opened = await ctx.workspaces.createTab({ workspaceId, cwd: worktree.path });
  await ctx.decisions.record(ticket, `opened tab ${opened.tabId} for a new commander`);
  return freeIn(await ctx.workspaces.snapshot());
}

/**
 * Start the Commander for a ticket from the resolved `agents.commander`
 * profile: no per-ticket Commander override is stored. The profile's
 * effort becomes native Herdr `agent.start` args; an effort the harness
 * cannot express throws a concrete error before anything launches.
 */
export async function startCommander(
  ctx: RecoveryScope,
  identifier: string,
  paneId: string,
): Promise<string> {
  const profile = ctx.resolved.config.commander.agents.commander;
  const { kind, args } = launchFor(profile);
  const name = commanderName(identifier);
  await ctx.workspaces.startAgent({ paneId, kind, name, ...(args.length > 0 ? { args } : {}) });
  return name;
}

async function resumeCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const { client, resolved, decisions } = ctx;
  if (args.length !== 1 || !args[0] || args[0].startsWith("--")) return fail(usage("resume"));
  const identifier = args[0] as string;
  const full = (await client.fetchIssue(identifier)) as FullIssue | null;
  if (!full) {
    await decisions.record(identifier, `resume failed: ticket "${identifier}" was not found in Linear`);
    return fail(`ticket "${identifier}" was not found in Linear`);
  }
  if (full.projectId !== resolved.projectId) {
    await decisions.record(full.identifier, `resume failed: not in project "${resolved.config.project}"`);
    return fail(`ticket "${full.identifier}" is not in project "${resolved.config.project}"`);
  }
  let snapshot: WorkspaceSnapshot;
  try {
    snapshot = await ctx.workspaces.snapshot();
  } catch (error) {
    await decisions.record(full.identifier, "resume failed: herdr unreachable");
    return fail(`herdr unreachable: ${(error as Error).message}`);
  }
  const workspace = findWorkspace(snapshot, full.identifier);
  if (!workspace) {
    await decisions.record(full.identifier, "resume failed: no workspace");
    return fail(`no workspace for ${full.identifier}; use \`igniter start ${full.identifier}\``);
  }
  const paused = workspace.tokens["paused"] === "1";
  let state;
  try {
    state = deriveState(resolved, full);
  } catch (error) {
    return refuse(ctx, full.identifier, error);
  }
  const agent = snapshot.agents.find((a) => a.name === commanderName(full.identifier));
  const isActiveStage = state.status === "build" || state.status === "review" || state.status === "deliver";
  // An active ticket whose Commander is gone keeps its Linear state: rebuild
  // the Commander from the workspace metadata plus the authoritative Linear
  // state, without touching checkpoint, receipt, or stage.
  if (state.progress !== "blocked" && !paused) {
    if (!isActiveStage) {
      await decisions.record(full.identifier, "resume refused: not paused or blocked");
      return fail(`${full.identifier} is not paused or blocked; nothing to resume`);
    }
    if (agent) {
      await decisions.record(
        full.identifier,
        `resume: commander already running (${state.status}+${state.progress ?? "no progress"}, ${agent.agentStatus}); nothing to rebuild`,
      );
      return {
        ok: true,
        text: `${full.identifier} is already running (${state.status}+${state.progress ?? "no progress"}, commander ${agent.agentStatus}); nothing to rebuild`,
      };
    }
    // Rebuilding reuses the ticket's own Build slot: it never counts
    // against the resume capacity. No Linear write happens on this path.
    if (state.status === "build") {
      const usedOthers = (await countBuildSlots(client, resolved)) - 1;
      if (usedOthers >= resolved.config.maxRunning) {
        await decisions.record(full.identifier, `resume refused: at max_running (${resolved.config.maxRunning})`);
        return fail(`at max_running (${resolved.config.maxRunning})`);
      }
    }
    const name = commanderName(full.identifier);
    const meta = {
      ...workspace.tokens,
      status: state.status,
      ...(state.progress ? { progress: state.progress } : {}),
    };
    try {
      const paneId = await commanderPane(ctx, full.identifier, workspace.workspaceId, snapshot);
      if (!paneId) {
        await decisions.record(full.identifier, "resume failed: workspace has no pane");
        return fail(`workspace for ${full.identifier} has no pane to start the commander in`);
      }
      await startCommander(ctx, full.identifier, paneId);
      const unstated = await deliverStartPrompt(ctx, {
        project: resolved.config.project,
        ticket: full.identifier,
        role: "commander",
        stage: "command",
        agent: name,
        text: resumedWorkOrder(ctx, full, meta),
      });
      if (unstated) throw new Error(unstated);
    } catch (error) {
      await decisions.record(full.identifier, `resume failed: ${(error as Error).message}`);
      return fail(`resume failed: ${(error as Error).message}`);
    }
    await decisions.record(
      full.identifier,
      `resumed by command (commander rebuilt at ${state.status}+${state.progress ?? "no progress"})`,
    );
    return { ok: true, text: `resumed ${full.identifier}; new commander ${name} started from ${state.status}+${state.progress ?? "no progress"}` };
  }
  // Resuming back into Build needs a free slot, like a fresh claim. The
  // ticket itself never counts against its own resume: a Blocked ticket
  // holds no slot, a merely paused one holds one.
  if (state.status === "build") {
    const used = (await countBuildSlots(client, resolved)) - (state.progress === "blocked" ? 0 : 1);
    if (used >= resolved.config.maxRunning) {
      await decisions.record(full.identifier, `resume refused: at max_running (${resolved.config.maxRunning})`);
      return fail(`at max_running (${resolved.config.maxRunning})`);
    }
  }
  const deps = depsOf(ctx);
  try {
    // Resume shares the unblock transition (Blocked back to Pending, never
    // straight to In progress) and clears the paused token on top.
    if (state.progress === "blocked") {
      await unblockMutation(deps, workspace.workspaceId, full, state);
      await ctx.workspaces.reportMetadata(workspace.workspaceId, { paused: null });
    } else {
      await ctx.workspaces.reportMetadata(workspace.workspaceId, { paused: null });
      await decisions.record(full.identifier, "resumed by command");
    }
  } catch (error) {
    return refuse(ctx, full.identifier, error);
  }
  const unblockedMeta = { ...workspace.tokens };
  delete unblockedMeta["paused"];
  const liveAgent = snapshot.agents.find((a) => a.name === commanderName(full.identifier));
  if (liveAgent) {
    try {
      const unstated = await deliverStartPrompt(ctx, {
        project: resolved.config.project,
        ticket: full.identifier,
        role: "commander",
        stage: "command",
        agent: liveAgent.name,
        text: resumePrompt(state.status, state.progress === "blocked" ? "pending" : state.progress, unblockedMeta["checkpoint"] ?? null),
      });
      if (unstated) throw new Error(unstated);
    } catch (error) {
      await decisions.record(full.identifier, `resume failed: ${(error as Error).message}`);
      return fail(`resume failed: ${(error as Error).message}`);
    }
    await decisions.record(full.identifier, "resumed by command");
    return { ok: true, text: `resumed ${full.identifier}; commander prompted to continue` };
  }
  const name = commanderName(full.identifier);
  try {
    const paneId = await commanderPane(ctx, full.identifier, workspace.workspaceId, snapshot);
    if (!paneId) {
      await decisions.record(full.identifier, "resume failed: workspace has no pane");
      return fail(`workspace for ${full.identifier} has no pane to start the commander in`);
    }
    await startCommander(ctx, full.identifier, paneId);
    const unstated = await deliverStartPrompt(ctx, {
      project: resolved.config.project,
      ticket: full.identifier,
      role: "commander",
      stage: "command",
      agent: name,
      text: resumedWorkOrder(ctx, full, unblockedMeta),
    });
    if (unstated) throw new Error(unstated);
  } catch (error) {
    await decisions.record(full.identifier, `resume failed: ${(error as Error).message}`);
    return fail(`resume failed: ${(error as Error).message}`);
  }
  await decisions.record(full.identifier, "resumed by command");
  return { ok: true, text: `resumed ${full.identifier}; new commander ${name} started` };
}

// ---------------------------------------------------------------------------
// fail
// ---------------------------------------------------------------------------

async function failCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const { client, resolved, decisions } = ctx;
  const reasonFlag = takeFlag(args, "reason");
  const rest = reasonFlag.rest;
  if (rest.length !== 1 || !rest[0] || rest[0].startsWith("--")) return fail(usage("fail"));
  const reason = reasonFlag.value?.trim();
  if (!reason) return fail(usage("fail"));
  const identifier = rest[0] as string;
  const full = await client.fetchIssue(identifier);
  if (!full) {
    await decisions.record(identifier, `fail failed: ticket "${identifier}" was not found in Linear`);
    return fail(`ticket "${identifier}" was not found in Linear`);
  }
  if (full.projectId !== resolved.projectId) {
    await decisions.record(full.identifier, `fail failed: not in project "${resolved.config.project}"`);
    return fail(`ticket "${full.identifier}" is not in project "${resolved.config.project}"`);
  }

  let snapshot: WorkspaceSnapshot | null = null;
  try {
    snapshot = await ctx.workspaces.snapshot();
  } catch {
    snapshot = null;
  }
  const deps: FailureDeps = { client, resolved, workspaces: ctx.workspaces, decisions };
  return failTicket(deps, full, reason, snapshot);
}

// ---------------------------------------------------------------------------
// restart
// ---------------------------------------------------------------------------

export function buildRestartPrompt(model: string): string {
  return (
    `igniter: restart the Builder with model ${model}. ` +
    `Close the current Builder tab and open a new one with this model. ` +
    `The work tree may be half-changed and uncommitted: the new Builder's work order must say so ` +
    `and tell it to read \`git diff\` first (see 'Build' in the bundled Commander rules).`
  );
}

async function restartCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const { resolved, decisions } = ctx;
  const builderFlag = takeFlag(args, "builder");
  const rest = builderFlag.rest;
  if (rest.length !== 1 || !rest[0] || rest[0].startsWith("--")) return fail(usage("restart"));
  const model = builderFlag.value?.trim();
  if (!model) return fail(usage("restart"));
  const identifier = rest[0] as string;
  const full = await ctx.client.fetchIssue(identifier);
  if (!full) {
    await decisions.record(identifier, `restart failed: ticket "${identifier}" was not found in Linear`);
    return fail(`ticket "${identifier}" was not found in Linear`);
  }
  if (full.projectId !== resolved.projectId) {
    await decisions.record(full.identifier, `restart failed: not in project "${resolved.config.project}"`);
    return fail(`ticket "${full.identifier}" is not in project "${resolved.config.project}"`);
  }
  let snapshot: WorkspaceSnapshot;
  try {
    snapshot = await ctx.workspaces.snapshot();
  } catch (error) {
    await decisions.record(full.identifier, "restart failed: herdr unreachable");
    return fail(`herdr unreachable: ${(error as Error).message}`);
  }
  const workspace = findWorkspace(snapshot, full.identifier);
  if (!workspace) {
    await decisions.record(full.identifier, "restart failed: no workspace");
    return fail(`no workspace for ${full.identifier}; use \`igniter start ${full.identifier}\``);
  }
  const agent = snapshot.agents.find((a) => a.name === commanderName(full.identifier));
  if (!agent) {
    await decisions.record(full.identifier, "restart failed: no live commander");
    return fail(`no live commander for ${full.identifier}; use \`igniter resume ${full.identifier}\` first`);
  }
  try {
    await ctx.workspaces.reportMetadata(workspace.workspaceId, { builder: model });
    await ctx.workspaces.prompt(agent.name, buildRestartPrompt(model));
  } catch (error) {
    await decisions.record(full.identifier, `restart failed: ${(error as Error).message}`);
    return fail(`restart failed: ${(error as Error).message}`);
  }
  await decisions.record(full.identifier, `restarted with builder ${model} by command`);
  return { ok: true, text: `restarted ${full.identifier} with builder ${model}; commander prompted` };
}

// ---------------------------------------------------------------------------
// workspace commands
// ---------------------------------------------------------------------------

async function stateCommand(args: string[], ctx: CommandContext, workspaceId: string): Promise<CommandResult> {
  if (args.length !== 1 || args[0] !== "--json") return fail(usage("state"));
  let resolved: ResolvedWorkspace;
  try {
    resolved = await resolveWorkspace(ctx, workspaceId);
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
  const data = describeState(resolved.full, resolved.meta, resolved.state);
  return { ok: true, text: JSON.stringify(data, null, 2), data };
}

async function beginCommand(args: string[], ctx: CommandContext, workspaceId: string): Promise<CommandResult> {
  if (args.length > 0) return fail(usage("begin"));
  let resolved: ResolvedWorkspace;
  try {
    resolved = await resolveWorkspace(ctx, workspaceId);
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
  try {
    await beginMutation(depsOf(ctx), resolved.workspace.workspaceId, resolved.full, resolved.state);
    return { ok: true, text: `began ${resolved.full.identifier}: ${resolved.state.status}+in_progress` };
  } catch (error) {
    return refuse(ctx, resolved.full.identifier, error);
  }
}

async function submitCommand(
  args: string[],
  ctx: CommandContext,
  workspaceId: string,
  input: string | undefined,
): Promise<CommandResult> {
  const inputFlag = takeFlag(args, "input");
  if (inputFlag.value !== "-" || inputFlag.rest.length > 0) return fail(usage("submit"));
  if (input === undefined) {
    return fail(`submit needs JSON on stdin; use \`igniter submit --input -\``);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(input);
  } catch {
    return fail(`submit input is not JSON; use \`igniter submit --input -\``);
  }
  let resolved: ResolvedWorkspace;
  try {
    resolved = await resolveWorkspace(ctx, workspaceId);
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
  try {
    const out = await submitMutation(depsOf(ctx), resolved.workspace.workspaceId, resolved.full, resolved.state, payload);
    return { ok: true, text: out };
  } catch (error) {
    return refuse(ctx, resolved.full.identifier, error);
  }
}

async function blockCommand(args: string[], ctx: CommandContext, workspaceId: string): Promise<CommandResult> {
  const reasonFlag = takeFlag(args, "reason");
  if (reasonFlag.rest.length > 0) return fail(usage("block"));
  const reason = reasonFlag.value?.trim();
  if (!reason) return fail(usage("block"));
  let resolved: ResolvedWorkspace;
  try {
    resolved = await resolveWorkspace(ctx, workspaceId);
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
  try {
    await blockMutation(depsOf(ctx), resolved.workspace.workspaceId, resolved.full, resolved.state, reason);
    return { ok: true, text: `blocked ${resolved.full.identifier}: ${reason}` };
  } catch (error) {
    return refuse(ctx, resolved.full.identifier, error);
  }
}

async function unblockCommand(args: string[], ctx: CommandContext, workspaceId: string): Promise<CommandResult> {
  if (args.length > 0) return fail(usage("unblock"));
  let resolved: ResolvedWorkspace;
  try {
    resolved = await resolveWorkspace(ctx, workspaceId);
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
  try {
    await unblockMutation(depsOf(ctx), resolved.workspace.workspaceId, resolved.full, resolved.state);
    return { ok: true, text: `unblocked ${resolved.full.identifier}: back to pending; run \`igniter begin\`` };
  } catch (error) {
    return refuse(ctx, resolved.full.identifier, error);
  }
}

// ---------------------------------------------------------------------------
// work order and sink
// ---------------------------------------------------------------------------

export interface WorkerScratchPaths {
  builder: string;
  reviewer: string;
  deliverer: string;
}

export function scratchPathsFor(repoRoot: string, identifier: string): WorkerScratchPaths {
  return {
    builder: scratchFor(repoRoot, identifier, "builder"),
    reviewer: scratchFor(repoRoot, identifier, "reviewer"),
    deliverer: scratchFor(repoRoot, identifier, "deliverer"),
  };
}

export interface WorkOrderInput {
  identifier: string;
  title: string;
  issueUrl: string;
  worktreePath: string;
  branch: string;
  commanderConfig: CommanderConfig;
  /** A per-run model override from `igniter start --builder` or restart. */
  builderModel?: string;
  /** Delivery document path relative to the repo root. Absent means the
   *  Commander must search the repository for the document itself. */
  delivery?: string;
  /** Bundled Commander asset paths. Defaults to the install location
   *  derived from the running Igniter module, never the target repo. */
  assets?: CommanderAssetPaths;
  /** Per-worker scratch dirs Igniter created; omitted in older callers. */
  scratch?: WorkerScratchPaths;
}

/** Per-worker scratch locations. Harness permission UIs are not interchangeable. */
export function scratchBlock(input: WorkOrderInput): string {
  const scratch = input.scratch;
  if (!scratch || !scratch.builder || !scratch.reviewer || !scratch.deliverer) return "";
  const agents = input.commanderConfig?.agents;
  const builderHarness = agents?.builder?.harness;
  const reviewerHarness = agents?.reviewer?.harness;
  const delivererHarness = agents?.deliverer?.harness;
  const fallbackHarness = agents?.builder?.fallback?.harness;
  if (!builderHarness || !reviewerHarness || !delivererHarness || !fallbackHarness) return "";
  const lines = [
    `Worker scratch (created and cleaned by igniter; use only your own):`,
    `- Build: \`${scratch.builder}\` (harness \`${builderHarness}\`)`,
    `- Acceptance: \`${scratch.reviewer}\` (harness \`${reviewerHarness}\`)`,
    `- Deliver: \`${scratch.deliverer}\` (harness \`${delivererHarness}\`)`,
    `- Builder fallback: harness \`${fallbackHarness}\`; scratch \`${scratch.builder}\``,
    `Pre-authorized scope is the ticket worktree, bundled read-only assets, and your own scratch only. ` +
      `Do not invent generic permission flags; use the configured harness normally and inspect its actual dialogs. ` +
      `Home configs, credentials, system locations, remote hosts, and out-of-scope network always escalate to the owner. ` +
      `Reread the exact pane and revision immediately before answering any permission dialog; a changed dialog refuses the send.`,
  ];
  return `\n${lines.join("\n")}\n`;
}

/** The Commander's first prompt. Tests assert on its contents; keep it whole. */
export function buildWorkOrder(input: WorkOrderInput): string {
  const assets = input.assets ?? commanderAssetPaths();
  const stageName: Record<CommanderStage, string> = {
    build: "Build",
    review: "Acceptance",
    deliver: "Deliver",
  };
  const stageLines = (["build", "review", "deliver"] as const).map((stage) => {
    const stageConfig = input.commanderConfig.stages[stage];
    const agent = input.commanderConfig.agents[stageConfig.agent];
    const model = stageConfig.agent === "builder" && input.builderModel
      ? input.builderModel
      : agent.model;
    const effort = agent.effort !== undefined ? `; effort \`${agent.effort}\`` : "";
    return `- ${stageName[stage]}: prompt \`${assets.prompts[stage]}\`; agent \`${stageConfig.agent}\`; ` +
      `harness \`${agent.harness}\`; model \`${model}\`${effort}`;
  }).join("\n");
  const fallback = input.commanderConfig.agents.builder.fallback;
  const fallbackEffort = fallback.effort !== undefined ? `; effort \`${fallback.effort}\`` : "";
  const scratchSection = input.scratch ? scratchBlock(input) : "";
  const delivery =
    input.delivery !== undefined
      ? `Project settings: read \`${input.delivery}\` (relative to the repo root) as the delivery document. ` +
        `Do not search for another one.\n`
      : `No delivery document is configured in \`.igniter/config.yaml\`. ` +
        `Search the repository for the document that describes how to run the project, ` +
        `which checks to run, and how to accept ` +
        `(any filename, any location, e.g. CONTRIBUTING.md, docs/DEVELOPING.md, a README section). ` +
        `Follow the Project settings section of the Commander rules for what to do next ` +
        `(write the path back / generate a draft), and name the document you used in the completion report.\n`;
  return (
    `You are the Commander for ticket ${input.identifier}: "${input.title}".\n` +
    `Issue: ${input.issueUrl} (for people; machine state comes from \`igniter state --json\`, never from Linear directly).\n` +
    `Workspace: a git worktree at ${input.worktreePath} on branch ${input.branch} (base main), ` +
    `created by igniter. Work there; do not create another branch. ` +
    `Install dependencies first as the repository instructs (bun install).\n` +
    `\n` +
    `Read the repository's AGENTS.md and follow it. Then read the bundled Commander rules at ${assets.rules} ` +
    `and run this delivery exactly as it says.\n` +
    `\n` +
    `Effective stage workers (bundled defaults plus repository overrides):\n` +
    `${stageLines}\n` +
    `- Builder fallback: harness \`${fallback.harness}\`; model \`${fallback.model}\`${fallbackEffort}\n` +
    `Use these prompt and agent values; do not reconstruct them from defaults.\n` +
    scratchSection +
    `\n` +
    delivery +
    `\n` +
    `Your tools for this run are the workspace commands. They reach the dispatch ` +
    `server; never call Linear directly, never use MCP, and never write a Linear receipt by hand:\n` +
    `- \`igniter state --json\`: read the ticket, criteria, status, Progress, checkpoint, receipt, next step, and submit schema.\n` +
    `- \`igniter begin\`: move Pending to In progress (Build, Review, Deliver).\n` +
    `- \`igniter submit --input -\`: submit versioned JSON on stdin; the server picks the schema from the Linear status.\n` +
    `- \`igniter block --reason "<phrase>"\` / \`igniter unblock\`: park on an external condition and resume to Pending.\n` +
    `\n` +
    `Your first action is \`igniter state --json\`.\n`
  );
}

export function issueUrl(config: DispatchConfig, identifier: string): string {
  return `https://linear.app/${config.linearOrg}/issue/${identifier}`;
}

export function resumedWorkOrder(
  ctx: RecoveryScope,
  full: { identifier: string; title: string },
  tokens: Record<string, string>,
): string {
  const status = tokens["status"] ?? "?";
  const progress = tokens["progress"] ?? "?";
  const checkpoint = tokens["checkpoint"] ?? "?";
  const worktree = ticketWorktree(ctx.repoRoot, full.identifier);
  // The run's recorded stage-agent profiles win over the live
  // configuration, so a mid-run config edit cannot drift the retry.
  const commanderConfig = commanderConfigForRun(ctx.resolved.config.commander, tokens);
  return (
    buildWorkOrder({
      identifier: full.identifier,
      title: full.title,
      issueUrl: issueUrl(ctx.resolved.config, full.identifier),
      worktreePath: worktree.path,
      branch: worktree.branch,
      builderModel: tokens["builder"] ?? commanderConfig.agents.builder.model,
      commanderConfig,
      delivery: ctx.resolved.config.delivery,
      scratch: scratchPathsFor(ctx.repoRoot, full.identifier),
    }) +
    `\nThis is a resumed run. Run \`igniter state --json\` first and continue from ` +
    `status ${status} progress ${progress} checkpoint ${checkpoint}; do not restart. ` +
    `Checkpoint commits are on the ticket branch.\n`
  );
}

export interface WorkspaceSinkOptions {
  workspaces: CommandWorkspaces;
  config: DispatchConfig;
  repoRoot: string;
  runGit?: GitRunner;
  /** Prompt-delivery confirmation budget; tests inject a no-op clock. */
  promptDelivery?: PromptDeliveryPolicy;
}

/**
 * The real claim sink: prepares the ticket's worktree, opens the workspace
 * on it, and starts the Commander. Both the watch loop's automatic claims
 * and `igniter start` go through it. The ticket metadata lands before the
 * Commander starts, so the workspace commands can resolve the ticket from
 * it. The workspace carries no secrets: no LINEAR_API_KEY, no ticket guess
 * from the environment. A failure after the workspace exists throws
 * WorkspaceSinkError carrying the id so a person can clean it up; there is
 * no rollback.
 */
export function createWorkspaceSink(options: WorkspaceSinkOptions): ClaimSink {
  const runGit = options.runGit ?? bunGitRunner();
  return async (claim: ClaimedTicket, existing) => {
    // The Commander always runs the resolved `agents.commander` profile:
    // no per-ticket Commander override is stored.
    const profile = options.config.commander.agents.commander;
    const { kind, args } = launchFor(profile);
    const builder = claim.builder ?? options.config.commander.agents.builder.model;
    let worktree;
    try {
      worktree = await ensureTicketWorktree(runGit, options.repoRoot, claim.identifier);
    } catch (error) {
      throw new WorkspaceSinkError((error as Error).message);
    }
    const scratch = scratchPathsFor(options.repoRoot, claim.identifier);
    const scratchRoot = scratchRootFor(options.repoRoot, claim.identifier);
    try {
      const workers: WorkerName[] = ["builder", "reviewer", "deliverer"];
      for (const worker of workers) {
        await ensureScratchDir(scratch[worker], scratchRoot);
      }
    } catch (error) {
      throw new WorkspaceSinkError((error as Error).message);
    }
    let workspaceId: string;
    let rootPaneId: string;
    // A rebuild over a live workspace keeps the run's recorded profiles:
    // fresh defaults from a possibly edited configuration never downgrade
    // the freeze on a second resume.
    let keptProfiles: Record<string, string> = {};
    if (existing) {
      workspaceId = existing.workspaceId;
      try {
        const snapshot = await options.workspaces.snapshot();
        const workspace = snapshot.workspaces.find((item) => item.workspaceId === workspaceId);
        if (!workspace || workspace.tokens["ticket"] !== claim.identifier) {
          throw new Error(`workspace ${workspaceId} is not owned by ${claim.identifier}`);
        }
        keptProfiles = keptStageProfiles(workspace.tokens);
        const name = commanderName(claim.identifier);
        const named = snapshot.agents.find((agent) => agent.name === name);
        if (named) {
          if (named.workspaceId !== workspaceId) {
            throw new Error(`${name} is running in workspace ${named.workspaceId}, not ${workspaceId}`);
          }
          // An idle existing Commander never proved it consumed its start
          // prompt (STA-197/STA-222): finishing the claim would declare a
          // start that never happened. A working, blocked, or done one
          // converged by read-back; anything else refuses with the same
          // full diagnosis a stalled delivery records, so the activity log
          // names project, ticket, role, stage, agent, and pane revision.
          if (named.agentStatus !== "working" && named.agentStatus !== "blocked" && named.agentStatus !== "done") {
            let paneRevision: number | null = null;
            try {
              paneRevision = (await options.workspaces.readPane(named.paneId, 20)).revision;
            } catch {
              paneRevision = null;
            }
            const stalled = {
              project: options.config.project,
              ticket: claim.identifier,
              role: "commander" as const,
              stage: "command" as const,
              agent: name,
              workOrder: "unproven",
            };
            throw new PromptDeliveryError({
              key: deliveryKey(stalled, paneRevision),
              identity: stalled,
              reason: "stalled",
              attempts: 0,
              baseline: {
                status: named.agentStatus,
                session: named.session,
                revision: named.revision,
                paneRevision,
              },
            });
          }
          return { workspaceId, commander: kind, builder };
        }
        const busy = new Set(snapshot.agents.map((agent) => agent.paneId));
        const paneId = snapshot.panes.find(
          (pane) => pane.workspaceId === workspaceId && !busy.has(pane.paneId),
        )?.paneId;
        if (!paneId) throw new Error(`workspace ${workspaceId} has no pane available for ${name}`);
        rootPaneId = paneId;
      } catch (error) {
        throw new WorkspaceSinkError((error as Error).message, workspaceId);
      }
    } else {
      try {
        // No secrets ride into the workspace: the server holds the Linear
        // key and resolves the ticket from metadata below.
        ({ workspaceId, rootPaneId } = await options.workspaces.create({
          label: claim.identifier,
          cwd: worktree.path,
          env: { IGNITER_SCRATCH_ROOT: scratchRoot },
        }));
      } catch (error) {
        throw new WorkspaceSinkError((error as Error).message);
      }
    }
    try {
      await options.workspaces.reportMetadata(workspaceId, {
        ticket: claim.identifier,
        builder,
        slot: String(claim.slot),
        scratch_builder: scratch.builder,
        scratch_reviewer: scratch.reviewer,
        scratch_deliverer: scratch.deliverer,
        ...recordStageProfiles(options.config),
        ...keptProfiles,
      });
      const name = commanderName(claim.identifier);
      await options.workspaces.startAgent({
        paneId: rootPaneId,
        kind,
        name,
        ...(args.length > 0 ? { args } : {}),
      });
      const order = buildWorkOrder({
        identifier: claim.identifier,
        title: claim.title,
        issueUrl: issueUrl(options.config, claim.identifier),
        worktreePath: worktree.path,
        branch: worktree.branch,
        builderModel: builder,
        commanderConfig: options.config.commander,
        delivery: options.config.delivery,
        scratch,
      });
      try {
        await confirmPromptDelivery(
          options.workspaces,
          {
            project: options.config.project,
            ticket: claim.identifier,
            role: "commander",
            stage: "command",
            agent: name,
            workOrder: workOrderHash(order),
          },
          order,
          options.promptDelivery,
        );
      } catch (error) {
        // The prompt never proved consumed, so Linear stays untouched: the
        // claim throws before any status move and the next start safely
        // retries the identical work order in the same workspace.
        throw new WorkspaceSinkError((error as Error).message, workspaceId);
      }
    } catch (error) {
      throw new WorkspaceSinkError((error as Error).message, workspaceId);
    }
    return { workspaceId, commander: kind, builder };
  };
}
