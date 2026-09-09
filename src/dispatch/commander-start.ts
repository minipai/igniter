// Project-level Global Commander lifecycle (STA-225, corrected).
//
// Igniter owns exactly one Commander per project: a singleton agent named
// `commander` in the `igniter-commander` workspace at the repo root. Never
// `commander-<ticket>`.
//
// - `igniter start` starts or resumes that singleton and hands it the
//   patrol order: absolute bundled global.md plus repository and project
//   context, telling it to patrol the queue and active tickets.
// - `igniter start STA-X` starts or resumes the same singleton and assigns
//   STA-X to it immediately through a confirmed assignment prompt.
// - Repeated calls, and calls for different tickets, always reuse the one
//   workspace and the one agent. A missing agent or workspace is rebuilt
//   (takeover); a live one is reused without resending its order.
//
// The Commander supervises every ticket to completion: it waits for stage
// completion markers, reads and validates each worker `result.md`, then
// performs the ticket-targeted submit. Herdr idle/done is never completion
// evidence. It launches and recovers stage workers itself with ticket-
// targeted `igniter begin STA-X`, whose stage derives from Linear state.
// `start` is Commander lifecycle and assignment; `begin` is stage-worker
// lifecycle, so the two never recurse.
//
// Prompt delivery is always confirmed: Linear is never written here at all,
// and a failed delivery leaves the Commander workspace and agent as they
// were for an identical retry.

import { commanderAssetPaths, type CommanderAssetPaths } from "../commander/assets.ts";
import { foregroundCommandFor, launchFor } from "./agents.ts";
import type { LinearClientLike } from "./linear.ts";
import {
  confirmPromptDelivery,
  workOrderHash,
  type PromptDeliveryPolicy,
} from "./prompt-delivery.ts";
import {
  COMMANDER_WORKSPACE_ROLE,
  commanderWorkspaceFor,
  commanderWorkspaceLabel,
  globalCommanderName,
  type CommandWorkspaces,
  type WorkspaceSnapshot,
} from "./workspaces.ts";
import type { DecisionLog, ResolvedDispatch } from "./claims.ts";
import { WorkspaceSinkError } from "./claims.ts";
import type { DispatchConfig } from "./config.ts";
import type { FullIssue } from "./protocol.ts";

export interface CommanderStartDeps {
  client: LinearClientLike;
  resolved: ResolvedDispatch;
  workspaces: CommandWorkspaces;
  decisions: DecisionLog;
  repoRoot: string;
  config?: DispatchConfig;
  promptDelivery?: PromptDeliveryPolicy;
  assets?: CommanderAssetPaths;
}

export interface CommanderStartResult {
  ok: boolean;
  text: string;
  workspaceId?: string;
  agent?: string;
}

export interface CommanderForegroundLaunch {
  kind: "commander_foreground";
  command: string[];
  cwd: string;
}

export interface CommanderWorkOrderInput {
  project: string;
  team: string;
  repoRoot: string;
  targetBranch: string;
  globalMd: string;
  commanderHarness: string;
  commanderModel: string;
  commanderEffort?: string;
  /** Assigned ticket, when `start` named one. */
  assignment?: { identifier: string; title: string };
}

/**
 * The singleton Commander's order: where global.md lives, which project and
 * repository it serves, and what to do — patrol, or supervise one assigned
 * ticket to completion. The Commander reads global.md itself; this order
 * never inlines it.
 */
export function buildCommanderWorkOrder(input: CommanderWorkOrderInput): string {
  const effort = input.commanderEffort !== undefined ? `; effort \`${input.commanderEffort}\`` : "";
  const head =
    `You are the Global Commander for project ${input.project} (team ${input.team}).\n` +
    `Igniter started (or resumed) you as its single project-level Commander: ` +
    `harness \`${input.commanderHarness}\`; model \`${input.commanderModel}\`${effort}.\n` +
    `There is exactly one of you; ticket work never runs here.\n` +
    `\n` +
    `Read the bundled Global Commander instructions at ${input.globalMd} and run exactly what they say. ` +
    `Do not read stage-worker prompts; each worker reads its own.\n` +
    `\n` +
    `Project workspace: ${input.repoRoot}. Delivery target branch: \`${input.targetBranch}\`; ` +
    `follow the configured project delivery instructions.\n` +
    `Ticket workspaces keep only the worktree, metadata, scratch, and the current stage worker.\n` +
    `Your tools are the ticket-targeted commands from the project workspace: ` +
    `\`igniter status --json\`, \`igniter status <ticket> --json\`, \`igniter begin <ticket>\`, ` +
    `\`igniter submit <ticket> --input -\`, \`igniter block <ticket> --reason\`, ` +
    `\`igniter unblock <ticket>\`, \`igniter reconcile <ticket>\`.\n`;
  if (!input.assignment) {
    return (
      head +
      `\nPatrol now: run \`igniter status --json\`, then read each active ticket with ` +
      `\`igniter status <ticket> --json\` and drive every Pending stage with \`igniter begin <ticket>\`. ` +
      `Supervise each ticket to completion: wait for its stage completion marker, read and validate ` +
      `its worker result file, then submit the validated report. Herdr idle or done is never completion evidence.\n`
    );
  }
  return (
    head +
    `\nAssigned ticket: ${input.assignment.identifier}: "${input.assignment.title}".\n` +
    `Supervise it to completion immediately: read \`igniter status ${input.assignment.identifier} --json\`, ` +
    `launch its current stage worker with \`igniter begin ${input.assignment.identifier}\`, wait for the stage ` +
    `completion marker, read and validate the worker result file, then perform the ticket-targeted submit. ` +
    `Keep patrolling the rest of the queue beside it.\n`
  );
}

/**
 * A small first message for an interactive Commander launched by the CLI.
 * The bundled document owns the full operating instructions; keeping this
 * message to paths and the first command also avoids presenting policy-like
 * meta-instructions as the user's first prompt.
 */
export function buildCommanderLaunchPrompt(input: CommanderWorkOrderInput): string {
  const context =
    `Run the Igniter Global Commander workflow documented at ${input.globalMd}.\n` +
    `Project: ${input.project} (team ${input.team}). Workspace: ${input.repoRoot}. ` +
    `Delivery target branch: \`${input.targetBranch}\`; follow the configured project delivery instructions.\n`;
  if (input.assignment) {
    return (
      context +
      `Assigned ticket: ${input.assignment.identifier}: "${input.assignment.title}". ` +
      `Begin with \`igniter status ${input.assignment.identifier} --json\`.\n`
    );
  }
  return context + `Begin with \`igniter status --json\`.\n`;
}

/** The configured interactive Commander command for the calling terminal. */
export function prepareCommanderForeground(
  deps: CommanderStartDeps,
  assignment?: FullIssue,
): CommanderForegroundLaunch {
  const config = deps.config ?? deps.resolved.config;
  const assets = deps.assets ?? commanderAssetPaths();
  const profile = config.commander.agents.commander;
  const order = buildCommanderLaunchPrompt({
    project: config.project,
    team: config.team ?? "",
    repoRoot: deps.repoRoot,
    targetBranch: config.targetBranch,
    globalMd: assets.global,
    commanderHarness: profile.harness,
    commanderModel: profile.model,
    ...(profile.effort !== undefined ? { commanderEffort: profile.effort } : {}),
    ...(assignment ? { assignment: { identifier: assignment.identifier, title: assignment.title } } : {}),
  });
  return {
    kind: "commander_foreground",
    command: foregroundCommandFor(profile, order),
    cwd: deps.repoRoot,
  };
}

/** A pane in the workspace with no agent on it; null when every pane is busy. */
function freePane(snapshot: WorkspaceSnapshot, workspaceId: string): string | null {
  const busy = new Set(snapshot.agents.map((a) => a.paneId));
  return snapshot.panes.find((p) => p.workspaceId === workspaceId && !busy.has(p.paneId))?.paneId ?? null;
}

/**
 * Ensure the singleton Commander workspace exists (reused by role token,
 * created at the repo root otherwise). Reports role and project identity.
 * Starts no agent and never writes Linear.
 */
export async function ensureCommanderWorkspace(deps: CommanderStartDeps): Promise<string> {
  const project = (deps.config ?? deps.resolved.config).project;
  const snapshot = await deps.workspaces.snapshot();
  const existing = commanderWorkspaceFor(snapshot, project);
  if (existing) return existing.workspaceId;
  const created = await deps.workspaces.create({
    label: commanderWorkspaceLabel(),
    cwd: deps.repoRoot,
    env: {},
  });
  await deps.workspaces.reportMetadata(created.workspaceId, {
    role: COMMANDER_WORKSPACE_ROLE,
    project,
  });
  return created.workspaceId;
}

/**
 * Ensure the singleton agent exists in the Commander workspace. A live
 * `commander` there is reused as is: no second agent, no second order.
 * Otherwise a free pane (or a fresh tab) starts the configured commander
 * profile. The profile validates before anything launches.
 */
export async function ensureCommanderAgent(
  deps: CommanderStartDeps,
  workspaceId: string,
): Promise<{ agent: string; created: boolean }> {
  const config = deps.config ?? deps.resolved.config;
  const profile = config.commander.agents.commander;
  const { kind, args } = launchFor(profile);
  const agent = globalCommanderName();
  const snapshot = await deps.workspaces.snapshot();
  const live = snapshot.agents.find((a) => a.name === agent);
  if (live && live.workspaceId === workspaceId) return { agent, created: false };
  if (live) {
    throw new WorkspaceSinkError(`${agent} is running in workspace ${live.workspaceId}, not ${workspaceId}`);
  }
  let paneId = freePane(snapshot, workspaceId);
  if (!paneId) {
    await deps.workspaces.createTab({ workspaceId, cwd: deps.repoRoot });
    paneId = freePane(await deps.workspaces.snapshot(), workspaceId);
  }
  if (!paneId) throw new WorkspaceSinkError(`workspace ${workspaceId} has no pane available for ${agent}`);
  await deps.workspaces.startAgent({ paneId, kind, name: agent, ...(args.length > 0 ? { args } : {}) });
  return { agent, created: true };
}

/**
 * Start or resume the singleton Commander and hand it its order. Without an
 * assignment the order is the patrol order; with one it names the ticket to
 * supervise immediately. A live Commander holding the identical order is
 * reused without resending: the order hash rides in workspace metadata.
 * Delivery failures leave everything untouched for an identical retry.
 */
export async function startCommanderFlow(
  deps: CommanderStartDeps,
  assignment?: FullIssue,
): Promise<CommanderStartResult> {
  const config = deps.config ?? deps.resolved.config;
  const assets = deps.assets ?? commanderAssetPaths();
  const profile = config.commander.agents.commander;
  const order = buildCommanderWorkOrder({
    project: config.project,
    team: config.team ?? "",
    repoRoot: deps.repoRoot,
    targetBranch: config.targetBranch,
    globalMd: assets.global,
    commanderHarness: profile.harness,
    commanderModel: profile.model,
    ...(profile.effort !== undefined ? { commanderEffort: profile.effort } : {}),
    ...(assignment ? { assignment: { identifier: assignment.identifier, title: assignment.title } } : {}),
  });
  const hash = workOrderHash(order);

  let workspaceId: string;
  try {
    workspaceId = await ensureCommanderWorkspace(deps);
  } catch (error) {
    return { ok: false, text: `start failed: ${(error as Error).message}` };
  }
  let agent: string;
  let created: boolean;
  try {
    ({ agent, created } = await ensureCommanderAgent(deps, workspaceId));
  } catch (error) {
    await deps.decisions.record("commander", `start failed: ${(error as Error).message} (workspace ${workspaceId})`);
    return { ok: false, text: `start failed: ${(error as Error).message} (workspace ${workspaceId})` };
  }

  // Idempotent orders: the same patrol or assignment order is delivered
  // once. A retry after a proven delivery converges here instead of
  // prompting twice.
  try {
    const snapshot = await deps.workspaces.snapshot();
    const tokens = snapshot.workspaces.find((w) => w.workspaceId === workspaceId)?.tokens ?? {};
    if (!created && tokens["work_order"] === hash) {
      const what = assignment ? `assigned ${assignment.identifier}` : "patrolling";
      await deps.decisions.record("commander", `start reused ${agent} in ${workspaceId} (${what}; identical order already delivered)`);
      return { ok: true, text: `commander ${agent} already running in ${workspaceId} (${what}); reused without a second order`, workspaceId, agent };
    }
  } catch {
    // A best-effort dedupe read: failure falls through to delivery.
  }

  try {
    await confirmPromptDelivery(
      deps.workspaces,
      {
        project: config.project,
        ticket: assignment?.identifier ?? null,
        role: "commander",
        stage: "command",
        agent,
        workOrder: hash,
      },
      order,
      deps.promptDelivery,
    );
  } catch (error) {
    await deps.decisions.record("commander", `start failed: ${(error as Error).message} (workspace ${workspaceId})`);
    return { ok: false, text: `start failed: ${(error as Error).message} (workspace ${workspaceId})` };
  }

  try {
    await deps.workspaces.reportMetadata(workspaceId, {
      work_order: hash,
      ...(assignment ? { assignment: assignment.identifier } : { assignment: null }),
    });
  } catch {
    // The delivery already proved consumed; a metadata miss only loses the
    // dedupe marker, never the start.
  }
  if (assignment) {
    await deps.decisions.record("commander", `assigned ${assignment.identifier} to ${agent} in ${workspaceId}`);
    return { ok: true, text: `commander ${agent} in ${workspaceId} assigned ${assignment.identifier}; supervising to completion`, workspaceId, agent };
  }
  await deps.decisions.record("commander", `started ${agent} in ${workspaceId} (patrolling queue and active tickets)`);
  return { ok: true, text: `commander ${agent} started in ${workspaceId}; patrolling queue and active tickets`, workspaceId, agent };
}
