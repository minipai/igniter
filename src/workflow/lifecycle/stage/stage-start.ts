// Worker lifecycle only. Linear stage changes belong to begin/submit/approve.

import { isAbsolute, join } from "node:path";
import { lstat, rename } from "node:fs/promises";
import type { CommanderConfig, CommanderStage, DispatchConfig } from "../../config/config.ts";
import { STAGE_AGENTS } from "../../config/config.ts";
import { commanderAssetPaths, type CommanderAssetPaths } from "../../../commander/assets.ts";
import { launchFor } from "./agents.ts";
import type { LinearClientLike } from "../../service/linear/linear.ts";
import {
  latestReceiptOf,
  latestValidReceipt,
  type AuthoritativeState,
  type FullIssue,
  type ProtocolProgress,
  type ProtocolStatus,
} from "../ticket/protocol.ts";
import {
  confirmPromptDelivery,
  workOrderHash,
  type PromptDeliveryPolicy,
} from "../delivery/prompt-delivery.ts";
import {
  ensureScratchDir,
  scratchFor,
  scratchRootFor,
  type WorkerName,
} from "../../service/worktree/worker-scope.ts";
import {
  stageWorkerName,
  workspaceForTicket,
  type CommandWorkspaces,
  type SnapshotWorkspace,
  type StageWorkerStage,
  type WorkspaceSnapshot,
} from "../../service/workspace/workspaces.ts";
import {
  bunGitRunner,
  ensureTicketWorktree,
  ticketWorktree,
  type GitRunner,
} from "../../service/worktree/worktrees.ts";
import { WorkspaceError, type DecisionLog, type ResolvedDispatch } from "../../config/claims.ts";

export type { StageWorkerStage };

/** Linear status -> stage worker. Todo claims always prepare Build. */
export function stageForStatus(status: ProtocolStatus): CommanderStage | null {
  if (status === "todo" || status === "build") return "build";
  if (status === "review") return "review";
  if (status === "deliver") return "deliver";
  return null;
}

/** Worker scratch dir name per stage: builder/reviewer/deliverer. */
export function workerForStage(stage: CommanderStage): WorkerName {
  if (stage === "build") return "builder";
  if (stage === "review") return "reviewer";
  return "deliverer";
}

/** The stage worker agent name: builder/reviewer/deliverer-<ticket>. */
export function workerAgentName(stage: CommanderStage, identifier: string): string {
  return stageWorkerName(stage, identifier);
}

/** Absolute configured stage prompt, falling back to the bundled asset. */
export function promptPathForStage(
  assets: CommanderAssetPaths,
  stage: CommanderStage,
  commander?: CommanderConfig,
): string {
  const configured = commander?.stages[stage].prompt;
  return configured !== undefined && isAbsolute(configured) ? configured : assets.prompts[stage];
}

/** The worker's result path: its own scratch dir plus `result.md`. */
export function resultPathFor(repoRoot: string, identifier: string, stage: CommanderStage): string {
  return join(scratchFor(repoRoot, identifier, workerForStage(stage)), "result.md");
}

export interface StageWorkOrderInput {
  identifier: string;
  title: string;
  description: string | null;
  criteria: string[];
  worktreePath: string;
  branch: string;
  checkpoint: string;
  resultPath: string;
  stage: CommanderStage;
  promptPath: string;
  harness: string;
  model: string;
  effort?: string;
  /** Delivery document path relative to the repo root, when configured. */
  delivery?: string;
}

const STAGE_LABEL: Record<CommanderStage, string> = {
  build: "Build",
  review: "Acceptance",
  deliver: "Deliver",
};

const STAGE_MARKER: Record<CommanderStage, string> = {
  build: "BUILD_HANDOFF_COMPLETE",
  review: "ACCEPTANCE_COMPLETE",
  deliver: "DELIVERY_COMPLETE",
};

/**
 * The stage worker's initial work order. It names the absolute configured
 * prompt, the stage's allowed inputs, the repository instructions, the
 * checkpoint, and the result path. Build and Deliver receive the full feature
 * request and Git context; Acceptance receives only the requirement,
 * observable criteria, and public runbook, so nothing undermines its
 * black-box contract. Every stage is forbidden Igniter CLI use, Linear calls,
 * receipt submission, and ticket-state operations: the worker reports only
 * to the Global Commander, which submits through ticket-targeted commands.
 */
export function buildStageWorkOrder(input: StageWorkOrderInput): string {
  const effort = input.effort !== undefined ? `; effort \`${input.effort}\`` : "";
  const delivery = input.delivery !== undefined
    ? `Project instructions: read \`${input.delivery}\` (relative to the repo root) as the delivery document. Do not search for another one. Also read the repository's AGENTS.md and follow it.\n`
    : `No delivery document is configured in \`.igniter/config.yaml\`. Read the repository's AGENTS.md (or equivalent) for how to run, check, and accept the project; do not invent project settings.\n`;
  return (
    `You are the ${STAGE_LABEL[input.stage]} worker for ticket ${input.identifier}: "${input.title}".\n` +
    `The Global Commander is preparing your stage for ${input.identifier} and will record begin after delivery is confirmed.\n` +
    `\n` +
    `Read the stage prompt at ${input.promptPath} and run exactly that stage. ` +
    `Do not read any other stage prompt.\n` +
    `\n` +
    `Worktree: ${input.worktreePath} on branch ${input.branch} (base main). ` +
    `${worktreeInstruction(input)}\n` +
    `Agent profile for this stage: harness \`${input.harness}\`; model \`${input.model}\`${effort}.\n` +
    `Your own scratch dir is \`${input.resultPath.replace(/\/result\.md$/, "")}\`; ` +
    `write your stage result to \`${input.resultPath}\` and to nowhere else.\n` +
    `\n` +
    delivery +
    `\n` +
    stageInputBlock(input) +
    `\n` +
    `Checkpoint to work from: \`${input.checkpoint}\`. ${checkpointInstruction(input)}\n` +
    `\n` +
    `Boundaries (hard): report only to the Global Commander. ` +
    `Do not run any \`igniter\` command, do not call Linear directly or through MCP, ` +
    `do not publish Linear receipts or comments, and do not operate ticket state. ` +
    `Do not publish externally on your own; only the configured Deliver stage updates remote branches after owner approval. ` +
    `The tested product's own local services are not the Igniter control plane: ` +
    `start or stop them only as the repository's run or acceptance instructions require. ` +
    `Your only output is the result file at \`${input.resultPath}\` plus your final report.\n` +
    `\n` +
    `Write the stage result as structured Markdown covering exactly what the stage prompt asks for, ` +
    `then end the complete report with:\n` +
    `\n` +
    `\`\`\`text\n` +
    `${STAGE_MARKER[input.stage]}\n` +
    `\`\`\`\n`
  );
}

/**
 * The inputs the stage prompt allows. Acceptance must not receive the raw
 * description, which can carry an implementation plan or Builder conclusion;
 * it gets the requirement (the ticket title) and the observable criteria
 * instead. Build and Deliver get the full request.
 */
function stageInputBlock(input: StageWorkOrderInput): string {
  if (input.stage === "review") {
    return (
      `Requirement: ${input.title}\n` +
      `\n` +
      `Observable acceptance criteria:\n` +
      `${criteriaList(input)}\n` +
      `\n` +
      `Public entry: the repository's run and acceptance instructions, with their runbook and non-secret test data.\n`
    );
  }
  return (
    `Feature request:\n` +
    `${input.description ?? "(no description)"}\n` +
    `\n` +
    `Acceptance criteria:\n` +
    `${criteriaList(input)}\n`
  );
}

function criteriaList(input: StageWorkOrderInput): string {
  if (input.criteria.length > 0) return input.criteria.map((c) => `- [ ] ${c}`).join("\n");
  return input.stage === "review"
    ? "- [ ] (no observable criteria listed; report the missing criteria instead of guessing)"
    : "- [ ] (no criteria listed; read the feature request above)";
}

/** Acceptance stays black-box: it may not read the source, diff, or history. */
function checkpointInstruction(input: StageWorkOrderInput): string {
  return input.stage === "review"
    ? `Do not read source files, git history, or diffs; test the committed checkpoint only through its public surface.`
    : `Inspect the worktree diff and branch log first; never reset, clean, or discard unrelated work.`;
}

/** Acceptance runs from the worktree but never edits it. */
function worktreeInstruction(input: StageWorkOrderInput): string {
  return input.stage === "review"
    ? `Run from there; do not modify the worktree and do not create another branch or worktree.`
    : `Work there; do not create another branch or worktree.`;
}

export interface StageStartDeps {
  client: LinearClientLike;
  resolved: ResolvedDispatch;
  workspaces: CommandWorkspaces;
  decisions: DecisionLog;
  git?: GitRunner;
  repoRoot: string;
  config?: DispatchConfig;
  promptDelivery?: PromptDeliveryPolicy;
  assets?: CommanderAssetPaths;
}

export interface StageStartResult {
  ok: boolean;
  text: string;
  workspaceId?: string;
  worker?: string;
  stage?: CommanderStage;
  role?: CommanderStage;
  model?: string;
  resultPath?: string;
  confirmed?: boolean;
}

/** True when the identifier looks like a ticket (`STA-123`). */
export function isTicketArg(value: string | undefined): boolean {
  return typeof value === "string" && /^[A-Za-z]{2,}-\d+$/.test(value);
}

function stageAgentProfile(config: DispatchConfig, stage: CommanderStage) {
  const agent = STAGE_AGENTS[stage];
  return config.commander.agents[agent];
}

function workerEnded(status: string): boolean {
  return /^(done|ended|exited|failed|gone|stopped)$/i.test(status.trim());
}

/**
 * Ensure the ticket workspace exists (create or reuse by ticket token) with
 * its worktree and scratch dirs. Reports ticket identity plus scratch paths
 * into metadata. Never starts an agent and never writes Linear.
 */
export async function ensureStageWorkspace(
  deps: StageStartDeps,
  identifier: string,
): Promise<{ workspaceId: string; workspace: SnapshotWorkspace | null; worktreePath: string; branch: string }> {
  const git = deps.git ?? bunGitRunner();
  const worktree = await ensureTicketWorktree(git, deps.repoRoot, identifier);
  const scratchRoot = scratchRootFor(deps.repoRoot, identifier);
  for (const worker of ["builder", "reviewer", "deliverer"] as const) {
    await ensureScratchDir(scratchFor(deps.repoRoot, identifier, worker), scratchRoot);
  }
  const snapshot = await deps.workspaces.snapshot();
  const existing = workspaceForTicket(snapshot, identifier);
  const { recordStageProfiles, keptStageProfiles } = await import("./agents.ts");
  const config = deps.config ?? deps.resolved.config;
  const tokens = {
    ticket: identifier,
    scratch_builder: scratchFor(deps.repoRoot, identifier, "builder"),
    scratch_reviewer: scratchFor(deps.repoRoot, identifier, "reviewer"),
    scratch_deliverer: scratchFor(deps.repoRoot, identifier, "deliverer"),
    ...recordStageProfiles(config),
    ...keptStageProfiles(existing?.tokens ?? {}),
  };
  if (existing && (existing.tokens["ticket"] === identifier || !existing.tokens["ticket"])) {
    await deps.workspaces.reportMetadata(existing.workspaceId, tokens);
    return {
      workspaceId: existing.workspaceId,
      workspace: existing,
      worktreePath: worktree.path,
      branch: worktree.branch,
    };
  }
  const created = await deps.workspaces.create({
    label: identifier,
    cwd: worktree.path,
    env: { IGNITER_SCRATCH_ROOT: scratchRoot },
  });
  // New workspaces freeze the run's stage-agent profiles, so a mid-run
  // config edit never drifts a retry or recovery.
  await deps.workspaces.reportMetadata(created.workspaceId, { ...tokens, worker_root_pane: created.rootPaneId });
  return { workspaceId: created.workspaceId, workspace: null, worktreePath: worktree.path, branch: worktree.branch };
}

/**
 * Ensure the stage worker exists in the ticket workspace. A same-named live
 * worker is reused as is. New workers get a dedicated titled tab, retaining
 * the workspace's root shell when a worker is stopped or rebuilt.
 * Returns the worker name and whether it was newly created.
 */
export async function ensureStageWorker(
  deps: StageStartDeps,
  identifier: string,
  stage: CommanderStage,
  workspaceId: string,
  profileOverride?: { harness: string; model: string; effort?: string },
): Promise<{ worker: string; created: boolean }> {
  const worker = workerAgentName(stage, identifier);
  const config = deps.config ?? deps.resolved.config;
  const profile = profileOverride ?? stageAgentProfile(config, stage);
  const { kind, args } = launchFor(profile);
  const snapshot = await deps.workspaces.snapshot();
  const existing = snapshot.agents.find((a) => a.name === worker);
  const workspaceOf = (name: string): string | null =>
    snapshot.agents.find((a) => a.name === name)?.workspaceId ?? null;
  if (existing && !workerEnded(existing.agentStatus) && workspaceOf(worker) === workspaceId) {
    return { worker, created: false };
  }
  if (existing && !workerEnded(existing.agentStatus)) {
    throw new WorkspaceError(`${worker} is running in workspace ${existing.workspaceId}, not ${workspaceId}`);
  }
  if (existing) {
    if (!deps.workspaces.stopAgent) throw new Error("worker stop is not configured");
    await deps.workspaces.stopAgent(worker);
  }
  const paneToken = `worker_pane_${stage}`;
  const recordedPane = snapshot.workspaces.find((w) => w.workspaceId === workspaceId)?.tokens[paneToken];
  let paneId = snapshot.panes.find((p) => p.paneId === recordedPane && p.workspaceId === workspaceId && !snapshot.agents.some((a) => a.paneId === p.paneId))?.paneId;
  if (!paneId) {
    const worktree = ticketWorktree(deps.repoRoot, identifier);
    const before = new Set(snapshot.panes.map((p) => p.paneId));
    await deps.workspaces.createTab({ workspaceId, cwd: worktree.path, title: `${identifier} ${stage}` });
    paneId = (await deps.workspaces.snapshot()).panes.find((p) => p.workspaceId === workspaceId && !before.has(p.paneId))?.paneId;
    if (paneId) await deps.workspaces.reportMetadata(workspaceId, { [paneToken]: paneId });
  }
  if (!paneId) throw new WorkspaceError(`workspace ${workspaceId} has no pane available for ${worker}`);
  await deps.workspaces.startAgent({ paneId, kind, name: worker, ...(args.length > 0 ? { args } : {}) });
  return { worker, created: true };
}

/** Start or reuse one worker without writing Linear. */
export async function startStageTicket(
  deps: StageStartDeps,
  full: FullIssue,
  state: AuthoritativeState,
  options: { stage?: CommanderStage } = {},
): Promise<StageStartResult> {
  const stage = options.stage ?? stageForStatus(state.status);
  if (!stage || (state.progress !== "pending" && state.progress !== "in_progress" && !(state.status === "todo" && state.progress === null))) {
    return { ok: false, text: `worker start refused: ${full.identifier} is ${state.status}+${state.progress ?? "none"}; expected Pending or In progress` };
  }
  if (stage !== stageForStatus(state.status)) {
    return { ok: false, text: `worker start refused: --role ${stage} does not match the current ${state.status} stage` };
  }
  try {
    const ensured = await ensureStageWorkspace(deps, full.identifier);
    const workspaceId = ensured.workspaceId;
    const snapshot = await deps.workspaces.snapshot();
    const tokens = snapshot.workspaces.find((w) => w.workspaceId === workspaceId)?.tokens ?? {};
    const { commanderConfigForRun } = await import("./agents.ts");
    const config = deps.config ?? deps.resolved.config;
    const effective = commanderConfigForRun(config.commander, tokens);
    const profile = effective.agents[STAGE_AGENTS[stage]];
    const worker = workerAgentName(stage, full.identifier);
    const resultPath = resultPathFor(deps.repoRoot, full.identifier, stage);
    const receipt = latestValidReceipt(full.comments);
    const run = `${stage}:${receipt?.receipt.submission ?? "initial"}:${JSON.stringify(profile)}`;
    const recordPath = join(scratchFor(deps.repoRoot, full.identifier, workerForStage(stage)), "work-order.json");
    let saved: { run: string; order: string; confirmedPane?: string; confirmedSession?: string | null } | null = null;
    const recordStat = await lstat(recordPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (recordStat?.isSymbolicLink()) throw new Error("worker work-order record cannot be a symlink");
    const file = Bun.file(recordPath);
    if (await file.exists()) saved = await file.json();
    let order = saved?.run === run ? saved.order : undefined;
    if (order === undefined) {
      const git = deps.git ?? bunGitRunner();
      const head = (await git.run(["rev-parse", "HEAD"], ensured.worktreePath)).stdout.trim().split("\n")[0]?.trim();
      const approved = stage === "deliver" ? latestReceiptOf(full.comments, "review-pass") : null;
      const checkpoint = approved?.receipt.checkpoint ?? head;
      if (!checkpoint) throw new Error("worktree checkpoint is missing");
      order = buildStageWorkOrder({
        identifier: full.identifier, title: full.title, description: full.description,
        criteria: state.criteria, worktreePath: ensured.worktreePath, branch: ensured.branch,
        checkpoint, resultPath, stage,
        promptPath: promptPathForStage(deps.assets ?? commanderAssetPaths(), stage, effective),
        harness: profile.harness, model: profile.model,
        ...(profile.effort !== undefined ? { effort: profile.effort } : {}),
        ...(config.delivery !== undefined ? { delivery: config.delivery } : {}),
      });
      saved = { run, order };
      await saveWorkOrder(recordPath, saved);
    }
    const { created } = await ensureStageWorker(deps, full.identifier, stage, workspaceId, profile);
    const live = (await deps.workspaces.snapshot()).agents.find((a) => a.name === worker && a.workspaceId === workspaceId);
    if (!live) throw new Error(`${worker} was not found after start`);
    if (created || saved?.confirmedPane !== live.paneId || saved?.confirmedSession !== live.session) {
      const delivered = await confirmPromptDelivery(deps.workspaces, {
        project: config.project, ticket: full.identifier, role: workerForStage(stage), stage,
        agent: worker, workOrder: workOrderHash(order),
      }, order, deps.promptDelivery);
      await saveWorkOrder(recordPath, { run, order, confirmedPane: live.paneId, confirmedSession: delivered.observed.session });
    }
    return {
      ok: true, text: `${full.identifier}: ${stage} worker ${worker}; model ${profile.model}; work order confirmed; result → ${resultPath}`,
      workspaceId, worker, stage, role: stage, model: profile.model, resultPath, confirmed: true,
    };
  } catch (error) {
    return { ok: false, text: `worker start failed: ${(error as Error).message}; Linear unchanged` };
  }
}

/** Replace the retry record atomically; an interrupted write preserves the last complete order. */
async function saveWorkOrder(path: string, record: object): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary, JSON.stringify(record));
  await rename(temporary, path);
}

/** Workspace identity for a ticket-targeted mutation: the ticket workspace must exist. */
export async function requireTicketWorkspace(
  workspaces: CommandWorkspaces,
  identifier: string,
): Promise<string> {
  const ticket = identifier.toUpperCase();
  let snapshot: WorkspaceSnapshot;
  try {
    snapshot = await workspaces.snapshot();
  } catch (error) {
    throw new Error(`herdr unreachable: ${(error as Error).message}`);
  }
  const workspace = workspaceForTicket(snapshot, ticket)
    ?? snapshot.workspaces.find((w) => (w.tokens["ticket"] ?? "").toUpperCase() === ticket);
  if (!workspace || (workspace.tokens["ticket"] ?? "").toUpperCase() !== ticket) {
    throw new Error(`no workspace for ${ticket}; run \`igniter worker start ${ticket}\` first`);
  }
  return workspace.workspaceId;
}

export function progressNameOf(config: DispatchConfig, progress: ProtocolProgress): string {
  const names: Record<ProtocolProgress, string> = {
    pending: config.progress.pending,
    in_progress: config.progress.in_progress,
    complete: config.progress.complete,
    blocked: config.progress.blocked,
  };
  return names[progress];
}
