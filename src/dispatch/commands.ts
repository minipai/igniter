// Dispatch commands: the one door into a running igniter.
//
// Both the web page and the CLI go through `POST /api/command` with
// `{ argv, directStart?, input? }`, and land here. Each command takes argv,
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
//
// igniter never judges: commands only carry out what Linear and the caller
// say. Judgments belong to the Global Commander outside Igniter.

import {
  createCommandLock,
  type CommandCallOptions,
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
  decisions: DecisionLog;
  workspaces: CommandWorkspaces;
  /** Repo root: the cwd `igniter serve` runs in, used as the workspace cwd. */
  repoRoot: string;
  git?: GitRunner;
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
  "usage: igniter <status|start|begin|submit|approve|block|unblock|fail|reconcile|worker <start|send|restart|stop|answer>>";

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

// All callers, including in-process clients, share the same mutation lock.
// The service owns one Linear client; locks never depend on a transient ctx.
const commandLocks = new WeakMap<LinearClientLike, ReturnType<typeof createCommandLock>>();

export function runCommand(
  argv: string[],
  ctx: CommandContext,
  options: CommandCallOptions = {},
): Promise<CommandResult> {
  let lock = commandLocks.get(ctx.client);
  if (!lock) {
    lock = createCommandLock();
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
        return beginCommand(args, ctx);
      case "reconcile":
        return reconcileCommand(args, ctx);
      case "fail":
        return failCommand(args, ctx);
      case "worker":
        return import("./worker-commands.ts").then(({ workerCommand }) => workerCommand(args, ctx));
      case "approve":
        return approveCommand(args, ctx);
      case "submit":
        return submitCommand(args, ctx, options.input);
      case "block":
        return blockCommand(args, ctx);
      case "unblock":
        return unblockCommand(args, ctx);
    }
  }
  if (name === "state") {
    return Promise.resolve(fail("`igniter state` was removed; use `igniter status <ticket> --json`"));
  }
  return Promise.resolve(fail(`unknown command "${name}"; ${TOP_USAGE}`));
}

function depsOf(ctx: CommandContext): ProtocolDeps {
  return {
    client: ctx.client,
    resolved: ctx.resolved,
    workspaces: ctx.workspaces,
    decisions: ctx.decisions,
    git: ctx.git ?? bunGitRunner(),
    repoRoot: ctx.repoRoot,
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

async function statusCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const jsonFlag = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  if (rest.length === 0) {
    const { data, snapshot, herdrNote } = await collectStatus(ctx);
    if (jsonFlag) {
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
  args: string[],
  ctx: CommandContext,
  directStart: boolean,
): Promise<CommandResult> {
  if (!directStart) return fail("background Commander start was removed; use CLI `igniter start [<ticket>]`");
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
    text: `starting Commander with ${launch.command[0]} in the current terminal; ${what}${consentNote}`,
    data: launch,
  };
}

/**
 * `igniter begin STA-X` validates and records the ticket's current stage
 * start, derived from Linear state. It never prepares worktrees, launches
 * workers, or sends prompts; the Commander confirms `worker start` first.
 */
async function beginCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const ticket = args[0];
  if (args.length !== 1 || !ticket || ticket.startsWith("-")) return fail(usage("begin"));
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

async function submitCommand(
  args: string[],
  ctx: CommandContext,
  input: string | undefined,
): Promise<CommandResult> {
  const inputFlag = takeFlag(args, "input");
  if (inputFlag.value !== "-") return fail(usage("submit"));
  const ticketArg = inputFlag.rest[0];
  if (inputFlag.rest.length !== 1 || !ticketArg || ticketArg.startsWith("-")) return fail(usage("submit"));
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
    return { ok: true, text: await submitForTicket(ctx, ticketArg, payload) };
  } catch (error) {
    return refuse(ctx, ticketArg, error);
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

async function blockCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const reasonFlag = takeFlag(args, "reason");
  const reason = reasonFlag.value?.trim();
  const ticket = reasonFlag.rest[0];
  if (!reason || reasonFlag.rest.length !== 1 || !ticket || ticket.startsWith("-")) return fail(usage("block"));
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

async function unblockCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const ticket = args[0];
  if (args.length !== 1 || !ticket || ticket.startsWith("-")) return fail(usage("unblock"));
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
