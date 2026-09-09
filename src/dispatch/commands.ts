// Dispatch commands: the one door into a running igniter.
//
// Both the web page and the CLI go through `POST /api/command` with
// `{ argv, workspaceId?, input? }`, and land here. Each command takes argv,
// does its permitted Linear or worker work through the injected context, records its
// activity lines through the DecisionLog, and returns `{ ok, text, data? }`
// — text for an agent, data for the web page.
//
// Linear and worker commands share this door with explicit boundaries:
// - `status`, `begin`, `submit`, `approve`, `block`, `unblock`, `fail`, and
//   `reconcile` operate ticket protocol state without worker lifecycle effects.
// - `worker start|send|restart|stop|answer` may read ticket context but never
//   write Linear. `start` remains Global Commander lifecycle and assignment.
// The Global Commander invokes them from the project workspace; only `serve`
// holds the Linear key.
// - Legacy workspace commands (`state`, plus bare `begin` with no ticket)
//   name no ticket: the CLI forwards the Herdr workspace id, and the ticket
//   comes from that workspace's igniter metadata only.
//
// igniter never judges: commands only carry out what Linear and the caller
// say. Judgments belong to the Global Commander outside Igniter.

import { isAbsolute } from "node:path";
import {
  createClaimLock,
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
  stageWorkerName,
  tokensByTicket,
  workspaceForTicket,
  type CommandWorkspaces,
  type SnapshotWorkspace,
  type WorkspaceSnapshot,
} from "./workspaces.ts";
import {
  type PromptDeliveryPolicy,
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
import {
  createBuildPublicationGate,
  grantPublicationConsent,
  stampPublicationTokens,
  type PublicationConsentStore,
  type ReviewPublisher,
} from "./review-publication.ts";

export type { CommandResult };

/** Whole minutes/hours Durations for agents: 12s, 34m, 2h, 1h12m, 5h02m. */
export { formatDuration };

export interface CommandContext {
  client: LinearClientLike;
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
  /**
   * Host-side review publication state: the owner consent ledger plus the
   * publisher that uploads to the fixed destination. Present only in the
   * command service; stage workers never receive credentials, the ledger,
   * or host network access.
   */
  publication?: {
    consents: PublicationConsentStore;
    publisher: ReviewPublisher;
  };
}

const TOP_USAGE =
  "usage: igniter <status|start|begin|submit|approve|block|unblock|fail|reconcile|worker <start|send|restart|stop|answer>|state>";

function usage(command: string): string {
  switch (command) {
    case "status":
      return "usage: igniter status [--json|<ticket> --json]";
    case "start":
      return "usage: igniter start [<ticket> [--publish-review]]";
    case "reconcile":
      return "usage: igniter reconcile <ticket>";
    case "approve":
      return "usage: igniter approve <ticket> --receipt <id>";
    case "fail":
      return "usage: igniter fail <ticket> --reason TEXT";
    case "state":
      return "usage: igniter state --json";
    case "begin":
      return "usage: igniter begin <ticket>";
    case "submit":
      return "usage: igniter submit <ticket> --input -";
    case "block":
      return "usage: igniter block <ticket> --reason TEXT";
    case "unblock":
      return "usage: igniter unblock <ticket>";
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

const DISPATCH_COMMANDS = new Set(["status", "start", "begin", "reconcile", "fail", "submit", "approve", "worker", "block", "unblock"]);
const WORKSPACE_COMMANDS = new Set(["state"]);

// All callers, including in-process clients, share the same mutation lock.
// The service owns one Linear client; locks never depend on a transient ctx.
const commandLocks = new WeakMap<LinearClientLike, ReturnType<typeof createClaimLock>>();

export function runCommand(
  argv: string[],
  ctx: CommandContext,
  options: CommandCallOptions = {},
): Promise<CommandResult> {
  let lock = commandLocks.get(ctx.client);
  if (!lock) {
    lock = createClaimLock();
    commandLocks.set(ctx.client, lock);
  }
  return lock(() => dispatchCommand(argv, ctx, options));
}

function dispatchCommand(
  argv: string[],
  ctx: CommandContext,
  options: CommandCallOptions = {},
): Promise<CommandResult> {
  const [name, ...args] = argv;
  if (name === undefined) return Promise.resolve(fail(TOP_USAGE));
  if (DISPATCH_COMMANDS.has(name)) {
    switch (name) {
      case "status":
        return statusCommand(args, ctx);
      case "start":
        return startCommand(args, ctx, options.directStart === true);
      case "begin":
        return beginCommand(args, ctx, options.workspaceId);
      case "reconcile":
        return reconcileCommand(args, ctx);
      case "fail":
        return failCommand(args, ctx);
      case "worker":
        return import("./worker-commands.ts").then(({ workerCommand }) => workerCommand(args, ctx));
      case "approve":
        return approveCommand(args, ctx);
      case "submit":
        return submitCommand(args, ctx, options.workspaceId, options.input);
      case "block":
        return blockCommand(args, ctx, options.workspaceId);
      case "unblock":
        return unblockCommand(args, ctx, options.workspaceId);
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
    }
  }
  return Promise.resolve(fail(`unknown command "${name}"; ${TOP_USAGE}`));
}

function depsOf(ctx: CommandContext): ProtocolDeps & { sink: ClaimSink; host: string } {
  return {
    linearOnly: true,
    client: ctx.client,
    resolved: ctx.resolved,
    workspaces: ctx.workspaces,
    decisions: ctx.decisions,
    git: ctx.git ?? bunGitRunner(),
    repoRoot: ctx.repoRoot,
    sink: ctx.sink,
    host: ctx.host,
    ...(ctx.publication
      ? {
        publication: createBuildPublicationGate({
          consents: ctx.publication.consents,
          publisher: ctx.publication.publisher,
          repoRoot: ctx.repoRoot,
        }),
      }
      : {}),
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
  const state = mergedDeliveryState(resolved, full) ?? deriveState(resolved, full);
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
  /** Legacy Commander agent status; kept for the board while workers take over. */
  commander: string;
  /** Current stage worker (`builder|reviewer|deliverer-<ticket>`) status, or missing. */
  worker: string;
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
      commander: agentStatus(issue.identifier),
      worker: workerStatus(issue.identifier, status),
      blocked: progress === "blocked",
      stalled: tk["stalled"] === "1",
      overBudget: false,
    });
  }

  const data: StatusData = { slots: { used, max }, lastPollAt, tickets };
  return { data, snapshot, herdrNote };
}

async function statusCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const jsonFlag = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  if (rest.length === 0) {
    const { data, snapshot, herdrNote } = await collectStatus(ctx);
    if (jsonFlag) {
      const payload = {
        slots: data.slots,
        lastPollAt: data.lastPollAt,
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
  if (rest.length === 1 && jsonFlag && rest[0] && !rest[0].startsWith("--")) {
    return ticketStatusCommand(rest[0] as string, ctx);
  }
  return fail(usage("status"));
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
  const outcome = await normalizeOwnerMove({ ...depsOf(ctx), linearOnly: true }, full);
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

/**
 * `igniter start` starts or resumes the one project-level Global Commander
 * and hands it the patrol order. `igniter start STA-X` starts or resumes
 * that same singleton and assigns STA-X to it immediately. Repeated calls,
 * and calls for different tickets, always reuse the one Commander: never
 * `commander-<ticket>`. `start` is Commander lifecycle and assignment; the
 * Commander launches workers with `worker start`, confirms delivery, and
 * records each stage start separately with ticket-targeted `begin`.
 */
async function startCommand(
  args: string[],
  ctx: CommandContext,
  directStart: boolean,
): Promise<CommandResult> {
  const { client, resolved, decisions } = ctx;
  // `--publish-review` is an explicit owner act on the CLI, never a
  // repository setting: it grants this ticket's current lifecycle a
  // one-time review publication to the fixed destination.
  const publishReview = args.includes("--publish-review");
  const rest = args.filter((a) => a !== "--publish-review");
  if (rest.length > 1 || (rest.length === 1 && (!rest[0] || rest[0].startsWith("-")))) {
    return fail(usage("start"));
  }
  if (publishReview && rest.length === 0) {
    return fail("`--publish-review` needs a ticket: `igniter start <ticket> --publish-review`");
  }
  const raw = rest.length === 1 ? (rest[0] as string) : undefined;
  let assignment: FullIssue | undefined;
  if (raw) {
    const identifier = raw.toUpperCase();
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
  if (publishReview && assignment) {
    if (!ctx.publication) {
      await decisions.record(assignment.identifier, `start failed: publication consent store is not configured in this dispatch`);
      return fail(`start failed: publication consent store is not configured in this dispatch`);
    }
    const consent = grantPublicationConsent(ctx.publication.consents, {
      ticket: assignment.identifier,
      repository: ctx.repoRoot,
      ...(ctx.now ? { now: ctx.now } : {}),
    });
    // Stamp a live workspace at once; `worker start` stamps the workspace it
    // ensures, so a grant before any workspace still lands on submit.
    try {
      const snapshot = await ctx.workspaces.snapshot();
      const open = snapshot.workspaces.find((w) => w.tokens["ticket"] === assignment.identifier);
      if (open) await ctx.workspaces.reportMetadata(open.workspaceId, stampPublicationTokens(consent));
    } catch {
      // Stamping is best-effort here: `worker start` stamps before submit.
    }
    await decisions.record(
      assignment.identifier,
      `recorded review publication consent for ${assignment.identifier} → ${consent.destination} (lifecycle ${consent.lifecycle})`,
    );
  }
  const consentNote =
    publishReview && assignment
      ? `; review publication consented for ${assignment.identifier} → review.diffwalk.dev (this lifecycle only)`
      : "";
  const { prepareCommanderForeground, startCommanderFlow } = await import("./commander-start.ts");
  if (directStart) {
    let launch;
    try {
      launch = prepareCommanderForeground(
        {
          client,
          resolved,
          workspaces: ctx.workspaces,
          decisions,
          repoRoot: ctx.repoRoot,
        },
        assignment,
      );
    } catch (error) {
      await decisions.record("commander", `start failed: ${(error as Error).message}`);
      return fail(`start failed: ${(error as Error).message}`);
    }
    const what = assignment ? `assigned ${assignment.identifier}` : "patrolling queue and active tickets";
    await decisions.record("commander", `prepared foreground ${launch.command[0]} Commander (${what})`);
    return {
      ok: true,
      text: `starting Commander with ${launch.command[0]} in the current terminal; ${what}${consentNote}`,
      data: launch,
    };
  }
  const out = await startCommanderFlow(
    {
      client,
      resolved,
      workspaces: ctx.workspaces,
      decisions,
      repoRoot: ctx.repoRoot,
      promptDelivery: ctx.promptDelivery,
    },
    assignment,
  );
  if (!out.ok) return fail(out.text);
  return { ok: true, text: `${out.text}${consentNote}` };
}

/**
 * `igniter begin STA-X` validates and records the ticket's current stage
 * start, derived from Linear state. It never prepares worktrees, launches
 * workers, or sends prompts; the Commander confirms `worker start` first.
 * The legacy bare
 * `begin` inside a ticket workspace keeps the Pending to In progress
 * transition for compatibility.
 */
async function beginCommand(
  args: string[],
  ctx: CommandContext,
  workspaceId: string | undefined,
): Promise<CommandResult> {
  const ticketArg = args.length === 1 ? args[0] : undefined;
  if (args.length > 1 || (ticketArg !== undefined && (ticketArg.startsWith("--") || ticketArg.startsWith("-") || ticketArg === ""))) {
    return fail(usage("begin"));
  }
  if (ticketArg) return beginTicket(ctx, ticketArg.toUpperCase());
  if (!workspaceId) return fail(usage("begin"));
  let resolved: ResolvedWorkspace;
  try {
    resolved = await resolveWorkspace(ctx, workspaceId);
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
  try {
    return await beginTicket(ctx, resolved.full.identifier);
  } catch (error) {
    return refuse(ctx, resolved.full.identifier, error);
  }
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

async function approveCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const receipt = takeFlag(args, "receipt");
  if (receipt.rest.length !== 1 || !receipt.rest[0] || receipt.rest[0].startsWith("-") || !receipt.value?.trim()) {
    return fail(`${usage("approve")}; bind the receipt.id from status so a stale retry cannot approve another stage`);
  }
  try {
    const { approveTicket } = await import("./approval.ts");
    return await approveTicket(depsOf(ctx), await ticketIssue(ctx, receipt.rest[0]), receipt.value);
  } catch (error) { return refuse(ctx, receipt.rest[0], error); }
}

// ---------------------------------------------------------------------------
// legacy workspace identity
// ---------------------------------------------------------------------------

export function stageWorkerForTicket(snapshot: WorkspaceSnapshot, identifier: string): string | null {
  const lowered = identifier.toLowerCase();
  const found = snapshot.agents.find((a) =>
    a.name === `builder-${lowered}` || a.name === `reviewer-${lowered}` || a.name === `deliverer-${lowered}`
  );
  return found?.name ?? null;
}

// ---------------------------------------------------------------------------
// legacy Commander recovery
// ---------------------------------------------------------------------------

/**
 * The slice of dispatch context the recovery path needs: Herdr,
 * decisions, the repo root, and validated dispatch. Stage workers start
 * through `igniter worker start <ticket>`.
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
 * A pane a rebuilt agent can actually start in: one with no agent on
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

  const deps: FailureDeps = { client, resolved, workspaces: ctx.workspaces, decisions };
  return failTicket(deps, full, reason, null);
}

// ---------------------------------------------------------------------------
// restart
// ---------------------------------------------------------------------------

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

async function submitCommand(
  args: string[],
  ctx: CommandContext,
  workspaceId: string | undefined,
  input: string | undefined,
): Promise<CommandResult> {
  const inputFlag = takeFlag(args, "input");
  if (inputFlag.value !== "-") return fail(usage("submit"));
  // Ticket-targeted: `submit <ticket> --input -` from the project workspace.
  // Legacy workspace form (`submit --input -` inside the ticket workspace)
  // still resolves the ticket from metadata for compatibility.
  const ticketArg = inputFlag.rest.length === 1 ? inputFlag.rest[0] : undefined;
  if (inputFlag.rest.length > 1 || (inputFlag.rest.length === 1 && (ticketArg?.startsWith("--") || ticketArg?.startsWith("-")))) {
    return fail(usage("submit"));
  }
  if (!ticketArg && !workspaceId) return fail(usage("submit"));
  if (input === undefined) {
    return fail(`submit needs JSON on stdin; use \`igniter submit <ticket> --input -\``);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(input);
  } catch {
    return fail(`submit input is not JSON; use \`igniter submit <ticket> --input -\``);
  }
  try {
    if (ticketArg) {
      const out = await submitForTicket(ctx, ticketArg, payload);
      return { ok: true, text: out };
    }
    if (!workspaceId) return fail(usage("submit"));
    let resolved: ResolvedWorkspace;
    try {
      resolved = await resolveWorkspace(ctx, workspaceId);
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) };
    }
    const out = await submitMutation(depsOf(ctx), resolved.workspace.workspaceId, resolved.full, resolved.state, payload);
    return { ok: true, text: out };
  } catch (error) {
    const ticket = ticketArg ?? workspaceId ?? "ticket";
    return refuse(ctx, ticket, error);
  }
}

/**
 * Ticket-targeted submit: Linear is the authority, workspace metadata never
 * authorizes the transition. The ticket workspace must exist (identity), but
 * the state, criteria, and checkpoint come from the freshly fetched issue.
 */
async function submitForTicket(ctx: CommandContext, identifier: string, payload: unknown): Promise<string> {
  const ticket = identifier.toUpperCase();
  const full = (await ctx.client.fetchIssue(ticket)) as FullIssue | null;
  if (!full) throw new ProtocolError(`ticket "${ticket}" was not found in Linear`);
  if (full.projectId !== ctx.resolved.projectId) {
    throw new ProtocolError(`ticket "${full.identifier}" is not in project "${ctx.resolved.config.project}"`);
  }
  const state = mergedDeliveryState(ctx.resolved, full) ?? deriveState(ctx.resolved, full);
  return submitMutation(depsOf(ctx), "", full, state, payload);
}

async function blockCommand(args: string[], ctx: CommandContext, workspaceId: string | undefined): Promise<CommandResult> {
  const reasonFlag = takeFlag(args, "reason");
  const reason = reasonFlag.value?.trim();
  if (!reason) return fail(usage("block"));
  const ticketArg = reasonFlag.rest.length === 1 ? reasonFlag.rest[0] : undefined;
  if (reasonFlag.rest.length > 1 || (ticketArg !== undefined && (ticketArg.startsWith("--") || ticketArg.startsWith("-") || ticketArg === ""))) {
    return fail(usage("block"));
  }
  try {
    if (ticketArg) {
      const out = await blockForTicket(ctx, ticketArg, reason);
      return { ok: true, text: out };
    }
    if (!workspaceId) return fail(usage("block"));
    let resolved: ResolvedWorkspace;
    try {
      resolved = await resolveWorkspace(ctx, workspaceId);
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) };
    }
    await blockMutation(depsOf(ctx), resolved.workspace.workspaceId, resolved.full, resolved.state, reason);
    return { ok: true, text: `blocked ${resolved.full.identifier}: ${reason}` };
  } catch (error) {
    const ticket = ticketArg ?? workspaceId ?? "ticket";
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
  await blockMutation(depsOf(ctx), "", full, state, reason);
  return `blocked ${full.identifier}: ${reason}`;
}

async function unblockCommand(args: string[], ctx: CommandContext, workspaceId: string | undefined): Promise<CommandResult> {
  // Ticket-targeted: `unblock <ticket>`; legacy workspace form: `unblock`.
  const ticketArg = args.length === 1 ? args[0] : undefined;
  if (args.length > 1 || (ticketArg !== undefined && (ticketArg.startsWith("--") || ticketArg.startsWith("-") || ticketArg === ""))) {
    return fail(usage("unblock"));
  }
  try {
    if (ticketArg) {
      const out = await unblockForTicket(ctx, ticketArg);
      return { ok: true, text: out };
    }
    if (!workspaceId) return fail(usage("unblock"));
    let resolved: ResolvedWorkspace;
    try {
      resolved = await resolveWorkspace(ctx, workspaceId);
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) };
    }
    await unblockMutation(depsOf(ctx), resolved.workspace.workspaceId, resolved.full, resolved.state);
    return { ok: true, text: `unblocked ${resolved.full.identifier}: back to pending; run \`igniter begin ${resolved.full.identifier}\`` };
  } catch (error) {
    const ticket = ticketArg ?? workspaceId ?? "ticket";
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
  await unblockMutation(depsOf(ctx), "", full, state);
  return `unblocked ${full.identifier}: back to pending; run \`igniter begin ${full.identifier}\``;
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
  /** Recorded Build model used by a resumed Commander work order. */
  builderModel?: string;
  /** Optional delivery document path relative to the repo root. */
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
    `Pre-authorized scope is the ticket worktree, configured read-only prompts, and your own scratch only. ` +
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
    const prompt = isAbsolute(stageConfig.prompt) ? stageConfig.prompt : assets.prompts[stage];
    const model = stageConfig.agent === "builder" && input.builderModel
      ? input.builderModel
      : agent.model;
    const effort = agent.effort !== undefined ? `; effort \`${agent.effort}\`` : "";
    return `- ${stageName[stage]}: prompt \`${prompt}\`; agent \`${stageConfig.agent}\`; ` +
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
        `Use the configured stage prompts and repository instructions such as AGENTS.md; ` +
        `do not invent another project-settings file.\n`;
  return (
    `You are the Global Commander supervising ticket ${input.identifier}: "${input.title}".\n` +
    `Issue: ${input.issueUrl} (for people; machine state comes from \`igniter status ${input.identifier} --json\`, never from Linear directly).\n` +
    `Workspace: a git worktree at ${input.worktreePath} on branch ${input.branch} (base main), ` +
    `created by worker start. Stage workers work there; do not create another branch. ` +
    `Supervise from the project workspace and preserve all existing work.\n` +
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
    `Your tools for this run are explicit ticket commands from the project workspace. They reach the dispatch ` +
    `server; never call Linear directly, never use MCP, and never write a Linear receipt by hand:\n` +
    `- \`igniter status ${input.identifier} --json\`: read criteria, status, Progress, checkpoint, receipt identity, next step, and submit schema.\n` +
    `- \`igniter worker start ${input.identifier}\`: prepare or reuse the role's worktree, scratch, worker, and initial work order. Require confirmed delivery.\n` +
    `- \`igniter begin ${input.identifier}\`: only validate and record Pending to In progress; never launch workers or send prompts.\n` +
    `- \`igniter submit ${input.identifier} --input -\`: submit versioned JSON only after validating the worker's complete report and checkpoint.\n` +
    `- \`igniter approve ${input.identifier} --receipt <id>\`: record explicit owner approval of the named current receipt; Build Complete to Review Pending, Review PASS Complete to Deliver Pending, Deliver Complete to Done. No --to; ordinary continue is not approval.\n` +
    `- \`igniter block ${input.identifier} --reason "<phrase>"\` / \`igniter unblock ${input.identifier}\`: record an external blocker or return to Pending without worker effects.\n` +
    `- \`igniter fail ${input.identifier} --reason TEXT\` / \`igniter reconcile ${input.identifier}\`: update Linear protocol state only; never stop or rebuild workers.\n` +
    `- \`igniter worker send|restart|stop|answer ${input.identifier}\`: operate workers only, never write Linear. Target an explicit --role when several roles exist; restart with an effective --model or --profile while preserving work.\n` +
    `Use status -> worker start -> confirmed delivery -> begin. After owner approval: approve -> worker start -> confirmed delivery -> begin. ` +
    `After a worker report: validate -> submit. Correction Build returns automatically to Review Pending. ` +
    `Retry uncertain approval only with its original receipt identity, never a later stage's receipt. ` +
    `Stop obsolete workers explicitly, and after Done use worker stop for guarded cleanup without discarding work. ` +
    `Preserve publication consent, checkpoint/receipt validation, and repository Git safety rules.\n` +
    `\n` +
    `Your first action is \`igniter status ${input.identifier} --json\`.\n`
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
    `\nThis is a resumed run. Run \`igniter status ${full.identifier} --json\` first and continue from ` +
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
 * The claim sink: prepares the ticket's worktree, opens or reuses the
 * ticket workspace, and records identity plus scratch paths. It starts no
 * agent and sends no prompt: the Global Commander launches each stage
 * worker itself with `igniter worker start <ticket>`, and Igniter never maintains
 * a resident commander-ticket agent. A failure after the workspace exists
 * throws WorkspaceSinkError carrying the id so a person can clean it up;
 * there is no rollback.
 */
export function createWorkspaceSink(options: WorkspaceSinkOptions): ClaimSink {
  const runGit = options.runGit ?? bunGitRunner();
  return async (claim: ClaimedTicket, existing) => {
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
      } catch (error) {
        throw new WorkspaceSinkError((error as Error).message, workspaceId);
      }
    } else {
      try {
        // No secrets ride into the workspace: the server holds the Linear
        // key and resolves the ticket from metadata below.
        ({ workspaceId } = await options.workspaces.create({
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
    } catch (error) {
      throw new WorkspaceSinkError((error as Error).message, workspaceId);
    }
    return { workspaceId, commander: options.config.commander.agents.commander.harness, builder };
  };
}
