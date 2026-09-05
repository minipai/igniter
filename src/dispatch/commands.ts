// Dispatch commands: the one door into a running igniter.
//
// Both the web page and the CLI go through `POST /api/command` with
// `{ argv }`, and land here. Each command takes argv, does its Linear and
// Herdr work through the injected context, records its activity lines
// through the DecisionLog, and returns `{ ok, text, data? }` — text for an
// agent, data for the web page.
//
// igniter never judges: commands only carry out what Linear and the caller
// say. Judgments belong to the Commander in the Herdr pane, or to whoever
// commands igniter from outside.

import {
  buildClaimBody,
  ensureAcceptanceCriteria,
  freeSlot,
  recordClaim,
  WorkspaceSinkError,
  type ClaimedTicket,
  type ClaimSink,
  type CommandResult,
  type DecisionLog,
  type ResolvedDispatch,
} from "./claims.ts";
import type { DispatchConfig } from "./config.ts";
import { LinearClient } from "./linear.ts";
import {
  commanderName,
  pausedTickets,
  tokensByTicket,
  type CommandWorkspaces,
  type WorkspaceSnapshot,
} from "./workspaces.ts";
import {
  bunGitRunner,
  ensureTicketWorktree,
  ticketWorktree,
  type GitRunner,
} from "./worktrees.ts";

export type { CommandResult };

export const FAILED_MARKER = "<!-- igniter:failed -->";
export const FAILED_LABEL = "agent-failed";

export interface CommandContext {
  client: LinearClient;
  resolved: ResolvedDispatch;
  host: string;
  decisions: DecisionLog;
  workspaces: CommandWorkspaces;
  sink: ClaimSink;
  /** Repo root: the cwd `igniter serve` runs in, used as the workspace cwd. */
  repoRoot: string;
  lastPollAt: () => string | null;
  now?: () => number;
}

const TOP_USAGE =
  "usage: igniter <status|start <ticket>|pause <ticket>|resume <ticket>|fail <ticket> --reason TEXT|restart <ticket> --builder MODEL>";

function usage(command: string): string {
  switch (command) {
    case "status":
      return "usage: igniter status";
    case "start":
      return "usage: igniter start <ticket> [--agent <kind>] [--builder <model>]";
    case "pause":
      return "usage: igniter pause <ticket>";
    case "resume":
      return "usage: igniter resume <ticket>";
    case "fail":
      return "usage: igniter fail <ticket> --reason TEXT";
    case "restart":
      return "usage: igniter restart <ticket> --builder <model>";
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

export function runCommand(argv: string[], ctx: CommandContext): Promise<CommandResult> {
  const [name, ...args] = argv;
  switch (name) {
    case "status":
      if (args.length > 0) return Promise.resolve(fail(usage("status")));
      return statusCommand(ctx);
    case "start":
      return startCommand(args, ctx);
    case "pause":
      return pauseCommand(args, ctx);
    case "resume":
      return resumeCommand(args, ctx);
    case "fail":
      return failCommand(args, ctx);
    case "restart":
      return restartCommand(args, ctx);
    default:
      return Promise.resolve(fail(
        name === undefined ? TOP_USAGE : `unknown command "${name}"; ${TOP_USAGE}`,
      ));
  }
}

/** Whole minutes/hours Durations for agents: 12s, 34m, 2h, 1h12m, 5h02m. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h${String(minutes).padStart(2, "0")}m`;
}

function agoText(at: string | null, now: number): string {
  if (!at) return "never";
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms) || ms < 0) return "never";
  return `${formatDuration(ms)} ago`;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export interface StatusTicketData {
  identifier: string;
  title: string;
  /** Linear state name: building tickets and review tickets both show. */
  state: string;
  hasWorkspace: boolean;
  stage: string | null;
  stageAt: string | null;
  startedAt: string | null;
  elapsedMs: number | null;
  budgetMs: number;
  over: boolean;
  commander: string;
  paused: boolean;
  stalled: boolean;
  overBudget: boolean;
}

export interface StatusData {
  slots: { used: number; max: number };
  lastPollAt: string | null;
  tickets: StatusTicketData[];
}

function findWorkspace(snapshot: WorkspaceSnapshot, identifier: string) {
  return snapshot.workspaces.find(
    (w) => w.label === identifier || w.tokens["ticket"] === identifier,
  );
}

async function statusCommand(ctx: CommandContext): Promise<CommandResult> {
  const { client, resolved } = ctx;
  const now = ctx.now?.() ?? Date.now();
  const max = resolved.config.maxRunning;
  const budgetMs = resolved.config.maxHours * 3600_000;
  const lastPollAt = ctx.lastPollAt();
  const building = await client.listIssuesByState(resolved.projectId, resolved.buildingStateId);
  // Review tickets keep an open workspace while the owner looks at them, so
  // they stay visible here; only building tickets ever hold slots.
  const inReview = await client.listIssuesByState(resolved.projectId, resolved.reviewStateId);
  const listed = [...building, ...inReview];
  const buildingIds = new Set(building.map((t) => t.id));

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

  let pausedCount = 0;
  const tickets: StatusTicketData[] = listed.map((issue) => {
    const workspace = snapshot ? findWorkspace(snapshot, issue.identifier) : undefined;
    const tk = tokens.get(issue.identifier) ?? workspace?.tokens ?? {};
    const paused = tk["paused"] === "1";
    const stalled = tk["stalled"] === "1";
    const overBudget = tk["over_budget"] === "1";
    if (paused && buildingIds.has(issue.id)) pausedCount += 1;
    const stage = tk["stage"] ?? null;
    const stageAt = tk["stage_at"] ?? null;
    const startedAt = tk["started_at"] ?? null;
    const startedMs = startedAt ? Date.parse(startedAt) : NaN;
    const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : null;
    // The budget (STA-163) is workspace alive past max_hours while the stage
    // has not reached acceptance: a ticket waiting on the owner is never over.
    const over = elapsedMs !== null && elapsedMs > budgetMs && stage !== "acceptance" && stage !== "delivered";
    return {
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state.name,
      hasWorkspace: workspace !== undefined,
      stage,
      stageAt,
      startedAt,
      elapsedMs,
      budgetMs,
      over,
      commander: agentStatus(issue.identifier),
      paused,
      stalled,
      overBudget,
    };
  });

  const used = building.length - pausedCount;
  const header = `${used} / ${max} slots · last Linear poll ${agoText(lastPollAt, now)}`;
  const lines = [header];
  if (herdrNote) lines.push(herdrNote);
  for (const ticket of tickets) {
    if (!snapshot) {
      lines.push(`${ticket.identifier}  no workspace info`);
      continue;
    }
    if (!ticket.hasWorkspace) {
      lines.push(`${ticket.identifier}  no workspace`);
      continue;
    }
    const elapsed = ticket.elapsedMs !== null ? formatDuration(ticket.elapsedMs) : "?";
    const stageMs = ticket.stageAt ? Date.parse(ticket.stageAt) : NaN;
    const stageAge = Number.isFinite(stageMs) ? formatDuration(now - stageMs) : "?";
    const flags = [
      ticket.paused ? "paused" : "",
      ticket.stalled ? "stalled" : "",
      ticket.overBudget ? "over_budget" : "",
    ].filter(Boolean).join(" · ");
    const tail = flags ? ` · ${flags}` : "";
    const statePart = ticket.state === resolved.config.states.building ? "" : `  ${ticket.state}`;
    lines.push(
      `${ticket.identifier}${statePart}  ${elapsed} / ${resolved.config.maxHours}h${ticket.over ? " OVER" : ""}` +
      `   stage ${ticket.stage ?? "?"} · ${stageAge}` +
      `   commander ${ticket.commander}${tail}`,
    );
  }
  const data: StatusData = { slots: { used, max }, lastPollAt, tickets };
  return { ok: true, text: lines.join("\n"), data };
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function startCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const { client, resolved, decisions } = ctx;
  const agentFlag = takeFlag(args, "agent");
  const builderFlag = takeFlag(agentFlag.rest, "builder");
  const rest = builderFlag.rest;
  if (rest.length !== 1 || !rest[0] || rest[0].startsWith("--")) {
    return fail(usage("start"));
  }
  if (agentFlag.value !== undefined && agentFlag.value === "") return fail(usage("start"));
  if (builderFlag.value !== undefined && builderFlag.value === "") return fail(usage("start"));
  const identifier = rest[0] as string;

  const full = await client.fetchIssue(identifier);
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

  const kind = agentFlag.value ?? "claude";
  const builder = builderFlag.value ?? resolved.config.models.builder;
  if (agentFlag.value !== undefined) {
    let kinds: string[];
    try {
      kinds = await ctx.workspaces.agentKinds();
    } catch (error) {
      return fail(`herdr unreachable: ${(error as Error).message}`);
    }
    if (!kinds.includes(kind)) {
      await decisions.record(full.identifier, `start refused: unknown agent kind "${kind}"`);
      return fail(`unknown agent kind "${kind}"; known kinds: ${kinds.join(", ")}`);
    }
  }

  let snapshot: WorkspaceSnapshot | null = null;
  try {
    snapshot = await ctx.workspaces.snapshot();
  } catch {
    snapshot = null;
  }
  const paused = snapshot ? pausedTickets(snapshot) : new Set<string>();
  const running = await client.listIssuesByState(resolved.projectId, resolved.buildingStateId);
  const active = running.filter((t) => !paused.has(t.identifier));

  const alreadyBuilding = full.state.id === resolved.buildingStateId;
  if (alreadyBuilding && snapshot && findWorkspace(snapshot, full.identifier)) {
    await decisions.record(full.identifier, "start refused: already running");
    return fail(`${full.identifier} is already running`);
  }
  // The ticket itself never counts against its own adoption.
  const others = active.filter((t) => t.id !== full.id);
  if (others.length >= resolved.config.maxRunning) {
    await decisions.record(
      full.identifier,
      `start refused: at max_running (${resolved.config.maxRunning}); running: ${others.map((t) => t.identifier).join(", ") || "none"}`,
    );
    return fail(
      `at max_running (${resolved.config.maxRunning}); running: ${others.map((t) => t.identifier).join(", ") || "none"}`,
    );
  }
  if (!(await ensureAcceptanceCriteria(client, resolved, full, decisions))) {
    return fail(`ticket "${full.identifier}" has no acceptance-criteria section and was not claimed; a comment was left on the issue`);
  }

  const from = full.state.name;
  let slot: number;
  try {
    if (!alreadyBuilding) {
      await client.setIssueState(full.id, resolved.buildingStateId);
    }
    slot = await freeSlot(client, resolved, ctx.host, running);
    if (!full.comments.some((c) => c.body.includes("<!-- igniter:claim -->"))) {
      await client.addComment(full.id, buildClaimBody(resolved.config.states.building, ctx.host, slot));
    }
  } catch (error) {
    await decisions.record(full.identifier, `claim failed: ${(error as Error).message}`);
    return fail(`claim failed: ${(error as Error).message}`);
  }
  await recordClaim(decisions, full.identifier, from, resolved.config.states.building, slot);

  const ticket: ClaimedTicket = {
    id: full.id,
    identifier: full.identifier,
    title: full.title,
    host: ctx.host,
    slot,
    agent: kind,
    builder,
  };
  let opened;
  try {
    opened = await ctx.sink(ticket);
  } catch (error) {
    const suffix =
      error instanceof WorkspaceSinkError && error.workspaceId
        ? ` (workspace ${error.workspaceId})`
        : "";
    await decisions.record(full.identifier, `handoff failed: ${(error as Error).message}${suffix}`);
    return fail(
      `handoff failed: ${(error as Error).message}${suffix}; ` +
      `the ticket is already in ${resolved.config.states.building}: ` +
      `fix the workspace and run \`igniter resume ${full.identifier}\``,
    );
  }
  if (opened) {
    await decisions.record(
      full.identifier,
      `workspace opened (${opened.workspaceId}) commander=${opened.commander} builder=${opened.builder}`,
    );
    return {
      ok: true,
      text: `claimed ${full.identifier} → ${resolved.config.states.building} (slot ${slot}); workspace ${opened.workspaceId} opened, commander=${opened.commander} builder=${opened.builder}`,
    };
  }
  return { ok: true, text: `claimed ${full.identifier} → ${resolved.config.states.building} (slot ${slot})` };
}

// ---------------------------------------------------------------------------
// pause
// ---------------------------------------------------------------------------

export const PAUSE_PROMPT =
  "igniter: the owner paused this ticket. Finish the current tool call, do not start the next step, and wait for `igniter resume`.";

async function pauseCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const { client, resolved, decisions } = ctx;
  if (args.length !== 1 || !args[0] || args[0].startsWith("--")) return fail(usage("pause"));
  const identifier = args[0] as string;
  const full = await client.fetchIssue(identifier);
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
  try {
    await ctx.workspaces.reportMetadata(workspace.workspaceId, { paused: "1" });
  } catch (error) {
    await decisions.record(full.identifier, `pause failed: ${(error as Error).message}`);
    return fail(`pause failed: ${(error as Error).message}`);
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

function resumePrompt(tokens: Record<string, string>): string {
  const stage = tokens["stage"] ?? "plan";
  const review = tokens["review_count"] ?? "0";
  const verify = tokens["verify_count"] ?? "0";
  return `igniter: resume. Continue from stage ${stage} (review_count ${review}, verify_count ${verify}); do not restart from plan.`;
}

async function resumeCommand(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const { client, resolved, decisions } = ctx;
  if (args.length !== 1 || !args[0] || args[0].startsWith("--")) return fail(usage("resume"));
  const identifier = args[0] as string;
  const full = await client.fetchIssue(identifier);
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
  const paused = pausedTickets(snapshot);
  const running = await client.listIssuesByState(resolved.projectId, resolved.buildingStateId);
  const others = running.filter((t) => t.id !== full.id && !paused.has(t.identifier));
  if (others.length >= resolved.config.maxRunning) {
    await decisions.record(
      full.identifier,
      `resume refused: at max_running (${resolved.config.maxRunning}); running: ${others.map((t) => t.identifier).join(", ") || "none"}`,
    );
    return fail(
      `at max_running (${resolved.config.maxRunning}); running: ${others.map((t) => t.identifier).join(", ") || "none"}`,
    );
  }
  try {
    await ctx.workspaces.reportMetadata(workspace.workspaceId, { paused: null, over_budget: null });
  } catch (error) {
    await decisions.record(full.identifier, `resume failed: ${(error as Error).message}`);
    return fail(`resume failed: ${(error as Error).message}`);
  }
  const tokens = { ...workspace.tokens };
  delete tokens["paused"];
  delete tokens["over_budget"];
  const agent = snapshot.agents.find((a) => a.name === commanderName(full.identifier));
  if (agent) {
    try {
      await ctx.workspaces.prompt(agent.name, resumePrompt(tokens));
    } catch (error) {
      await decisions.record(full.identifier, `resume failed: ${(error as Error).message}`);
      return fail(`resume failed: ${(error as Error).message}`);
    }
    await decisions.record(full.identifier, "resumed by command");
    return { ok: true, text: `resumed ${full.identifier}; commander prompted to continue from stage ${tokens["stage"] ?? "plan"}` };
  }
  const pane = snapshot.panes.find((p) => p.workspaceId === workspace.workspaceId);
  if (!pane) {
    await decisions.record(full.identifier, "resume failed: workspace has no pane");
    return fail(`workspace for ${full.identifier} has no pane to start the commander in`);
  }
  const kind = tokens["commander"] ?? "claude";
  const name = commanderName(full.identifier);
  try {
    await ctx.workspaces.startAgent({ paneId: pane.paneId, kind, name });
    await ctx.workspaces.prompt(name, resumedWorkOrder(ctx, full, tokens));
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

export function buildFailedComment(reason: string, paneTail: string): string {
  const tail = paneTail.trimEnd();
  return tail
    ? `${FAILED_MARKER}\n${reason}\n\n\`\`\`\n${tail}\n\`\`\`\n`
    : `${FAILED_MARKER}\n${reason}\n`;
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

  let snapshot: WorkspaceSnapshot | null = null;
  try {
    snapshot = await ctx.workspaces.snapshot();
  } catch {
    snapshot = null;
  }
  const workspace = snapshot ? findWorkspace(snapshot, full.identifier) : undefined;
  let paneTail = "";
  if (workspace && snapshot) {
    const agent = snapshot.agents.find((a) => a.name === commanderName(full.identifier));
    const pane = agent ?? snapshot.panes.find((p) => p.workspaceId === workspace.workspaceId);
    if (pane) {
      try {
        paneTail = await ctx.workspaces.readPane(pane.paneId, 80);
      } catch {
        paneTail = "";
      }
    }
  }

  try {
    // Label first: a failure here leaves Linear untouched, while anything
    // after the state move would leave the ticket half-failed.
    const failedLabel = (await client.lookupIssueLabel(FAILED_LABEL))
      ?? (await client.createIssueLabel(resolved.teamId, FAILED_LABEL));
    await client.setIssueState(full.id, resolved.failedStateId);
    const existingIds = (full.labels ?? []).map((l) => l.id);
    if (!existingIds.includes(failedLabel.id)) {
      await client.setIssueLabels(full.id, [...existingIds, failedLabel.id]);
    }
    await client.addComment(full.id, buildFailedComment(reason, paneTail));
  } catch (error) {
    await decisions.record(full.identifier, `fail failed: ${(error as Error).message}`);
    return fail(`fail failed: ${(error as Error).message}`);
  }
  await decisions.record(full.identifier, `failed: ${reason}`);
  if (!workspace) {
    return { ok: true, text: `failed ${full.identifier}: ${reason} (no workspace to close)` };
  }
  // The worktree stays: failed work never vanishes, and a later resume or a
  // human picks the checkout up again. Only the Herdr workspace closes.
  try {
    await ctx.workspaces.close(workspace.workspaceId);
  } catch (error) {
    await decisions.record(full.identifier, `workspace close failed: ${(error as Error).message}`);
    return { ok: true, text: `failed ${full.identifier}: ${reason}; workspace close failed: ${(error as Error).message}` };
  }
  await decisions.record(full.identifier, `workspace closed (${workspace.workspaceId})`);
  return { ok: true, text: `failed ${full.identifier}: ${reason}; workspace ${workspace.workspaceId} closed` };
}

// ---------------------------------------------------------------------------
// restart
// ---------------------------------------------------------------------------

export function buildRestartPrompt(model: string): string {
  return (
    `igniter: restart the Builder with model ${model}. ` +
    `Close the current Builder tab and open a new one with this model. ` +
    `The work tree may be half-changed and uncommitted: the new Builder's work order must say so ` +
    `and tell it to read \`git diff\` first (see 'Builder restart' in src/commander/rules.md).`
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
// work order and sink
// ---------------------------------------------------------------------------

export interface WorkOrderInput {
  identifier: string;
  title: string;
  issueUrl: string;
  worktreePath: string;
  branch: string;
  builderModel: string;
  reviewerModel: string;
  escalateModel: string;
}

/** The Commander's first prompt. Tests assert on its contents; keep it whole. */
export function buildWorkOrder(input: WorkOrderInput): string {
  return (
    `You are the Commander for ticket ${input.identifier}: "${input.title}".\n` +
    `Issue: ${input.issueUrl}\n` +
    `Workspace: a git worktree at ${input.worktreePath} on branch ${input.branch} (base main), ` +
    `created by igniter. Work there; do not create another branch. ` +
    `Install dependencies first as the repository instructs (bun install).\n` +
    `\n` +
    `Read the repository's AGENTS.md and follow it. Then read src/commander/rules.md ` +
    `(relative to the repo root) and run this delivery exactly as it says.\n` +
    `\n` +
    `Models for this run:\n` +
    `- Builder: ${input.builderModel}\n` +
    `- Reviewer: ${input.reviewerModel}\n` +
    `- Escalate: ${input.escalateModel}\n` +
    `Start the Builder with the Builder model unless the run rules say otherwise.\n` +
    `\n` +
    `LINEAR_API_KEY is in the environment. Read the ticket through the Linear GraphQL API ` +
    `(https://api.linear.app/graphql); do not use any other ticket source.\n` +
    `\n` +
    `Your first action is \`igniter stage plan\`.\n`
  );
}

export function issueUrl(config: DispatchConfig, identifier: string): string {
  return `https://linear.app/${config.linearOrg}/issue/${identifier}`;
}

function resumedWorkOrder(
  ctx: CommandContext,
  full: { identifier: string; title: string },
  tokens: Record<string, string>,
): string {
  const models = ctx.resolved.config.models;
  const stage = tokens["stage"] ?? "plan";
  const review = tokens["review_count"] ?? "0";
  const verify = tokens["verify_count"] ?? "0";
  const worktree = ticketWorktree(ctx.repoRoot, full.identifier);
  return (
    buildWorkOrder({
      identifier: full.identifier,
      title: full.title,
      issueUrl: issueUrl(ctx.resolved.config, full.identifier),
      worktreePath: worktree.path,
      branch: worktree.branch,
      builderModel: tokens["builder"] ?? models.builder,
      reviewerModel: models.reviewer,
      escalateModel: models.escalate,
    }) +
    `\nThis is a resumed run. Workspace metadata says stage=${stage}, ` +
    `review_count=${review}, verify_count=${verify}. ` +
    `Continue from there; do not restart from plan. Checkpoint commits are on the ticket branch.\n`
  );
}

export interface WorkspaceSinkOptions {
  workspaces: CommandWorkspaces;
  config: DispatchConfig;
  repoRoot: string;
  readApiKey?: () => string | undefined;
  runGit?: GitRunner;
  now?: () => string;
}

/**
 * The real claim sink: prepares the ticket's worktree, opens the workspace
 * on it, and starts the Commander. Both the watch loop's automatic claims
 * and `igniter start` go through it. A failure after the workspace exists
 * throws WorkspaceSinkError carrying the id so a person can clean it up;
 * there is no rollback.
 */
export function createWorkspaceSink(options: WorkspaceSinkOptions): ClaimSink {
  const readApiKey = options.readApiKey ?? (() => process.env["LINEAR_API_KEY"]);
  const runGit = options.runGit ?? bunGitRunner();
  const now = options.now ?? (() => new Date().toISOString());
  return async (claim: ClaimedTicket) => {
    const kind = claim.agent ?? "claude";
    const builder = claim.builder ?? options.config.models.builder;
    const apiKey = readApiKey();
    if (!apiKey) {
      throw new WorkspaceSinkError("LINEAR_API_KEY is not set in the serve process environment");
    }
    let worktree;
    try {
      worktree = await ensureTicketWorktree(runGit, options.repoRoot, claim.identifier);
    } catch (error) {
      if (error instanceof WorkspaceSinkError) throw error;
      throw new WorkspaceSinkError((error as Error).message);
    }
    let workspaceId: string;
    let rootPaneId: string;
    try {
      ({ workspaceId, rootPaneId } = await options.workspaces.create({
        label: claim.identifier,
        cwd: worktree.path,
        env: { LINEAR_API_KEY: apiKey, IGNITER_TICKET: claim.identifier },
      }));
    } catch (error) {
      throw new WorkspaceSinkError((error as Error).message);
    }
    try {
      await options.workspaces.reportMetadata(workspaceId, {
        ticket: claim.identifier,
        commander: kind,
        builder,
        started_at: now(),
      });
      const name = commanderName(claim.identifier);
      await options.workspaces.startAgent({ paneId: rootPaneId, kind, name });
      const models = options.config.models;
      await options.workspaces.prompt(
        name,
        buildWorkOrder({
          identifier: claim.identifier,
          title: claim.title,
          issueUrl: issueUrl(options.config, claim.identifier),
          worktreePath: worktree.path,
          branch: worktree.branch,
          builderModel: builder,
          reviewerModel: models.reviewer,
          escalateModel: models.escalate,
        }),
      );
    } catch (error) {
      throw new WorkspaceSinkError((error as Error).message, workspaceId);
    }
    return { workspaceId, commander: kind, builder };
  };
}
