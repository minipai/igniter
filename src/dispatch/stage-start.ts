// Ticket-targeted stage worker start (STA-225).
//
// The Global Commander runs outside Igniter from the project workspace and
// starts one stage worker per ticket with `igniter begin <ticket>`. Igniter
// derives the stage from Linear protocol state alone; the caller never names
// a stage, so a repeated `begin` converges instead of forking a second run.
// `igniter start` is Commander lifecycle and assignment; `igniter begin` is
// stage-worker lifecycle, so the two never recurse.
//
// Flow per ticket:
//   Todo+Pending      -> create or reuse the ticket workspace, prepare Build
//   Build+Pending     -> prepare the Build worker
//   Review+Pending    -> prepare the Acceptance worker
//   Deliver+Pending   -> prepare the Deliver worker
//
// The worker is `builder-<ticket>`, `reviewer-<ticket>`, or
// `deliverer-<ticket>` running the unified agent profile for its stage
// (harness, model, effort) in the ticket worktree with its own scratch dir.
// The bundled stage prompt path is absolute (install location, never the
// target repo). The work order carries the feature request, criteria,
// repository instructions, checkpoint, and the worker's result path — and
// nothing else: no Igniter CLI, no Linear mutation, no receipt publication,
// no ticket-state operation.
//
// Linear moves only after the worker is ready and its prompt delivery is
// confirmed: Todo becomes Build, Pending becomes In progress. A worker
// creation, readiness, or delivery failure leaves the ticket in Pending.
// Retries resend the byte-identical work order to the same-named worker and
// never create a second worker, work order, or receipt.

import { join } from "node:path";
import type { CommanderStage, DispatchConfig } from "./config.ts";
import { STAGE_AGENTS } from "./config.ts";
import { commanderAssetPaths, type CommanderAssetPaths } from "../commander/assets.ts";
import { launchFor } from "./agents.ts";
import type { LinearClientLike } from "./linear.ts";
import {
  deriveState,
  latestReceiptOf,
  latestValidReceipt,
  moveStatus,
  setProgress,
  statusOf,
  type AuthoritativeState,
  type FullIssue,
  type ProtocolDeps,
  type ProtocolProgress,
  type ProtocolStatus,
} from "./protocol.ts";
import {
  confirmPromptDelivery,
  workOrderHash,
  type PromptDeliveryPolicy,
} from "./prompt-delivery.ts";
import {
  ensureScratchDir,
  scratchFor,
  scratchRootFor,
  type WorkerName,
} from "./worker-scope.ts";
import {
  stageWorkerName,
  workspaceForTicket,
  type CommandWorkspaces,
  type SnapshotWorkspace,
  type StageWorkerStage,
  type WorkspaceSnapshot,
} from "./workspaces.ts";
import {
  bunGitRunner,
  ensureTicketWorktree,
  ticketWorktree,
  type GitRunner,
} from "./worktrees.ts";
import { WorkspaceSinkError, type DecisionLog, type ResolvedDispatch } from "./claims.ts";
import { stampPublicationTokens, type PublicationConsentStore } from "./review-publication.ts";

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

/** Absolute bundled stage prompt path for one stage. */
export function promptPathForStage(assets: CommanderAssetPaths, stage: CommanderStage): string {
  return assets.prompts[stage];
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
 * The stage worker's first and only prompt. It names the absolute bundled
 * prompt, the feature request and criteria, the repository instructions, the
 * checkpoint, and the result path. It forbids Igniter CLI use, Linear calls,
 * receipt publication, and ticket-state operations: the worker reports only
 * to the Global Commander, which submits through ticket-targeted commands.
 */
export function buildStageWorkOrder(input: StageWorkOrderInput): string {
  const effort = input.effort !== undefined ? `; effort \`${input.effort}\`` : "";
  const criteria = input.criteria.length > 0
    ? input.criteria.map((c) => `- [ ] ${c}`).join("\n")
    : "- [ ] (no criteria listed; read the feature request below)";
  const delivery = input.delivery !== undefined
    ? `Project instructions: read \`${input.delivery}\` (relative to the repo root) as the delivery document. Do not search for another one. Also read the repository's AGENTS.md and follow it.\n`
    : `No delivery document is configured in \`.igniter/config.yaml\`. Read the repository's AGENTS.md (or equivalent) for how to run, check, and accept the project; do not invent project settings.\n`;
  return (
    `You are the ${STAGE_LABEL[input.stage]} worker for ticket ${input.identifier}: "${input.title}".\n` +
    `The Global Commander began your stage for ${input.identifier} and will collect your report.\n` +
    `\n` +
    `Read the bundled stage prompt at ${input.promptPath} and run exactly that stage. ` +
    `Do not read any other stage prompt.\n` +
    `\n` +
    `Worktree: ${input.worktreePath} on branch ${input.branch} (base main). ` +
    `Work there; do not create another branch or worktree.\n` +
    `Agent profile for this stage: harness \`${input.harness}\`; model \`${input.model}\`${effort}.\n` +
    `Your own scratch dir is \`${input.resultPath.replace(/\/result\.md$/, "")}\`; ` +
    `write your stage result to \`${input.resultPath}\` and to nowhere else.\n` +
    `\n` +
    delivery +
    `\n` +
    `Feature request:\n` +
    `${input.description ?? "(no description)"}\n` +
    `\n` +
    `Acceptance criteria:\n` +
    `${criteria}\n` +
    `\n` +
    `Checkpoint to work from: \`${input.checkpoint}\`. ` +
    `Inspect the worktree diff and branch log first; never reset, clean, or discard unrelated work.\n` +
    `\n` +
    `Boundaries (hard): report only to the Global Commander. ` +
    `Do not run any \`igniter\` command, do not call Linear directly or through MCP, ` +
    `do not publish Linear receipts or comments, and do not operate ticket state. ` +
    `Do not run \`diffwalk publish\` and do not contact the host dispatch server, localhost, or any credential: ` +
    `publication happens on the host after the owner's one-time consent, never from this worker. ` +
    `Your only output is the result file at \`${input.resultPath}\` plus your final report.\n` +
    `\n` +
    `Write the stage result as structured Markdown covering exactly what the bundled prompt asks for, ` +
    `then end the complete report with:\n` +
    `\n` +
    `\`\`\`text\n` +
    `${STAGE_MARKER[input.stage]}\n` +
    `\`\`\`\n`
  );
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
  /**
   * Owner publication consents. `begin` stamps the current consent's
   * lifecycle into the ticket workspace so the build submit can verify
   * it; without a grant nothing is stamped and the worker stays local.
   */
  publication?: { consents: PublicationConsentStore };
}

export interface StageStartResult {
  ok: boolean;
  text: string;
  workspaceId?: string;
  worker?: string;
  stage?: CommanderStage;
}

/** True when the identifier looks like a ticket (`STA-123`). */
export function isTicketArg(value: string | undefined): boolean {
  return typeof value === "string" && /^[A-Za-z]{2,}-\d+$/.test(value);
}

function stageAgentProfile(config: DispatchConfig, stage: CommanderStage) {
  const agent = STAGE_AGENTS[stage];
  return config.commander.agents[agent];
}

/** A pane in the workspace with no agent on it; null when every pane is busy. */
function freePane(snapshot: WorkspaceSnapshot, workspaceId: string): string | null {
  const busy = new Set(snapshot.agents.map((a) => a.paneId));
  return snapshot.panes.find((p) => p.workspaceId === workspaceId && !busy.has(p.paneId))?.paneId ?? null;
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
  if (existing && existing.tokens["ticket"] === identifier) {
    await stampPublicationConsent(deps, identifier, existing.workspaceId);
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
  const scratch = {
    scratch_builder: scratchFor(deps.repoRoot, identifier, "builder"),
    scratch_reviewer: scratchFor(deps.repoRoot, identifier, "reviewer"),
    scratch_deliverer: scratchFor(deps.repoRoot, identifier, "deliverer"),
  };
  const { recordStageProfiles } = await import("./agents.ts");
  const config = deps.config ?? deps.resolved.config;
  // New workspaces freeze the run's stage-agent profiles, so a mid-run
  // config edit never drifts a retry or recovery.
  await deps.workspaces.reportMetadata(created.workspaceId, {
    ticket: identifier,
    ...scratch,
    ...recordStageProfiles(config),
    ...stampFor(deps, identifier),
  });
  return { workspaceId: created.workspaceId, workspace: null, worktreePath: worktree.path, branch: worktree.branch };
}

/** Lifecycle stamp for the current publication consent, if the owner granted one. */
function stampFor(deps: StageStartDeps, identifier: string): Record<string, string> {
  const consent = deps.publication?.consents.consentFor(identifier, deps.repoRoot);
  return consent ? stampPublicationTokens(consent) : {};
}

/** Stamp a reused workspace with the current consent before the worker starts. */
async function stampPublicationConsent(deps: StageStartDeps, identifier: string, workspaceId: string): Promise<void> {
  const stamp = stampFor(deps, identifier);
  if (Object.keys(stamp).length > 0) {
    await deps.workspaces.reportMetadata(workspaceId, stamp);
  }
}

/**
 * Ensure the stage worker exists in the ticket workspace. A same-named live
 * worker is reused as is: no second worker is ever created. The caller
 * always (re)delivers the current work order to the returned worker with
 * confirmation, so a reused worker from an earlier round still receives the
 * new checkpoint. Otherwise
 * a free pane (or a fresh tab) starts the configured harness/model/effort.
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
    throw new WorkspaceSinkError(`${worker} is running in workspace ${existing.workspaceId}, not ${workspaceId}`);
  }
  let paneId = freePane(snapshot, workspaceId);
  if (!paneId) {
    const worktree = ticketWorktree(deps.repoRoot, identifier);
    await deps.workspaces.createTab({ workspaceId, cwd: worktree.path });
    paneId = freePane(await deps.workspaces.snapshot(), workspaceId);
  }
  if (!paneId) throw new WorkspaceSinkError(`workspace ${workspaceId} has no pane available for ${worker}`);
  await deps.workspaces.startAgent({ paneId, kind, name: worker, ...(args.length > 0 ? { args } : {}) });
  return { worker, created: true };
}

/**
 * Start the current stage worker for a ticket. Derives the stage from Linear
 * alone (Todo/Build -> Build, Review -> Acceptance, Deliver -> Deliver) and
 * refuses anything else, including an explicit stage argument.
 *
 * - Pending stages launch their worker; Linear moves only after the worker
 *   is ready and its prompt delivery confirms (Todo -> Build, Pending -> In
 *   progress). Any worker or delivery failure leaves Linear in Pending.
 * - In progress with a live same-named worker reports already-running
 *   without duplicating. In progress with no live worker rebuilds the
 *   same-named worker (Global Commander takeover) with no Linear write.
 */
export async function startStageTicket(
  deps: StageStartDeps,
  full: FullIssue,
  state: AuthoritativeState,
): Promise<StageStartResult> {
  const liveConfig = deps.config ?? deps.resolved.config;
  const assets = deps.assets ?? commanderAssetPaths();
  if (state.progress !== "pending" && state.progress !== "in_progress") {
    return { ok: false, text: `begin refused: ${full.identifier} is ${state.status}+${state.progress ?? "no progress"}; begin only launches Pending stages` };
  }
  const stage = stageForStatus(state.status);
  if (!stage) {
    return { ok: false, text: `begin refused: ticket is ${full.state.name}; begin only claims Todo+Pending and launches Build/Review/Deliver+Pending` };
  }
  // In progress recovery: a live same-named worker means already running;
  // a missing one is rebuilt with no Linear write (receipt history carries
  // the run's identity). This is how a rebuilt Global Commander session
  // re-takes active tickets from Linear state plus workspace metadata. A
  // lost workspace is recreated first; Linear still never moves here.
  if (state.progress === "in_progress") {
    let workspaceId: string | null = null;
    try {
      const snapshot = await deps.workspaces.snapshot();
      workspaceId = workspaceForTicket(snapshot, full.identifier)?.workspaceId ?? null;
    } catch (error) {
      return { ok: false, text: `begin failed: herdr unreachable: ${(error as Error).message}` };
    }
    if (!workspaceId) {
      try {
        workspaceId = (await ensureStageWorkspace(deps, full.identifier)).workspaceId;
      } catch (error) {
        return { ok: false, text: `begin failed: ${(error as Error).message}` };
      }
    } else {
      const snapshot = await deps.workspaces.snapshot().catch(() => null);
      const worker = workerAgentName(stage, full.identifier);
      const live = snapshot?.agents.find((a) => a.name === worker);
      if (live && !workerEnded(live.agentStatus) && live.workspaceId === workspaceId) {
        return { ok: false, text: `${full.identifier} is already running (${stage} worker ${worker})` };
      }
    }
    const recovered = await recoverStageWorker(deps, liveConfig, assets, full, state, stage, workspaceId);
    return recovered;
  }
  const worktree = ticketWorktree(deps.repoRoot, full.identifier);
  const resultPath = resultPathFor(deps.repoRoot, full.identifier, stage);

  let workspaceId: string;
  let existingTokens: Record<string, string> = {};
  try {
    const ensured = await ensureStageWorkspace(deps, full.identifier);
    workspaceId = ensured.workspaceId;
    existingTokens = ensured.workspace?.tokens ?? {};
  } catch (error) {
    return { ok: false, text: `begin failed: ${(error as Error).message}` };
  }

  // The checkpoint reads after the workspace exists: a fresh claim has no
  // worktree until ensureStageWorkspace creates it above.
  const git = deps.git ?? bunGitRunner();
  let head: string;
  try {
    head = (await git.run(["rev-parse", "HEAD"], worktree.path)).stdout.trim().split("\n")[0]?.trim() ?? "";
  } catch {
    head = "";
  }
  const linear = latestValidReceipt(full.comments);
  const approved = stage === "deliver" ? latestReceiptOf(full.comments, "review-pass") : null;
  const checkpoint = approved?.receipt.checkpoint ?? (head !== "" ? head : (linear?.receipt.checkpoint ?? "unborn"));

  // The run's recorded profiles win over live config, so a mid-run config
  // edit never drifts a retry or recovery.
  const { commanderConfigForRun } = await import("./agents.ts");
  const effective = commanderConfigForRun(liveConfig.commander, existingTokens);
  const effectiveConfig = { ...liveConfig, commander: effective };
  const profile = stageAgentProfile(effectiveConfig, stage);
  const promptPath = promptPathForStage(assets, stage);

  // Idempotent worker: a same-named live worker is reused, never
  // duplicated. The current work order is always (re)delivered with
  // confirmation below — a reused worker from an earlier round (a builder
  // that already ended, a stalled first attempt) must still receive the new
  // checkpoint before Linear converges.
  let worker: string;
  let created: boolean;
  try {
    ({ worker, created } = await ensureStageWorker(deps, full.identifier, stage, workspaceId, profile));
  } catch (error) {
    await deps.decisions.record(full.identifier, `begin failed: ${(error as Error).message} (workspace ${workspaceId})`);
    return { ok: false, text: `begin failed: ${(error as Error).message} (workspace ${workspaceId})` };
  }

  const order = buildStageWorkOrder({
    identifier: full.identifier,
    title: full.title,
    description: full.description,
    criteria: state.criteria,
    worktreePath: worktree.path,
    branch: worktree.branch,
    checkpoint,
    resultPath,
    stage,
    promptPath,
    harness: profile.harness,
    model: profile.model,
    ...(profile.effort !== undefined ? { effort: profile.effort } : {}),
    ...(effectiveConfig.delivery !== undefined ? { delivery: effectiveConfig.delivery } : {}),
  });
  const role = stage === "build" ? "builder" : stage === "review" ? "reviewer" : "deliverer";
  try {
    await confirmPromptDelivery(
      deps.workspaces,
      {
        project: effectiveConfig.project,
        ticket: full.identifier,
        role,
        stage,
        agent: worker,
        workOrder: workOrderHash(order),
      },
      order,
      deps.promptDelivery,
    );
  } catch (error) {
    await deps.decisions.record(full.identifier, `begin failed: ${(error as Error).message} (workspace ${workspaceId})`);
    return { ok: false, text: `start failed: ${(error as Error).message} (workspace ${workspaceId}); ticket stays ${state.status}+pending` };
  }

  if (!created) {
    try {
      await convergePending(deps, full, state);
    } catch (error) {
      return { ok: false, text: (error as Error).message };
    }
    await deps.decisions.record(full.identifier, `begin reused ${worker} in ${workspaceId} with a redelivered work order; Linear converged without a second worker`);
    return { ok: true, text: `${full.identifier} already has ${stage} worker ${worker} in ${workspaceId}; work order redelivered`, workspaceId, worker, stage };
  }

  try {
    await convergePending(deps, full, state);
  } catch (error) {
    return { ok: false, text: (error as Error).message };
  }
  const from = state.status === "todo" ? `Todo → Build` : `${state.status}+pending → ${state.status}+in_progress`;
  await deps.decisions.record(full.identifier, `started ${stage} worker ${worker} in ${workspaceId} (${from})`);
  return { ok: true, text: `started ${full.identifier}: ${stage} worker ${worker} in workspace ${workspaceId} (${from}); result → ${resultPath}`, workspaceId, worker, stage };
}

/**
 * Rebuild a missing stage worker for an In progress ticket with no Linear
 * write: the receipt history already carries the run's identity. Linear
 * stays exactly where it is; only the worker and its confirmed work order
 * are restored. A delivery failure leaves everything untouched for retry.
 */
async function recoverStageWorker(
  deps: StageStartDeps,
  liveConfig: DispatchConfig,
  assets: CommanderAssetPaths,
  full: FullIssue,
  state: AuthoritativeState,
  stage: CommanderStage,
  workspaceId: string,
): Promise<StageStartResult> {
  let tokens: Record<string, string> = {};
  try {
    const snapshot = await deps.workspaces.snapshot();
    tokens = workspaceForTicket(snapshot, full.identifier)?.tokens ?? {};
  } catch {
    tokens = {};
  }
  const { commanderConfigForRun } = await import("./agents.ts");
  const effective = commanderConfigForRun(liveConfig.commander, tokens);
  const effectiveConfig = { ...liveConfig, commander: effective };
  const profile = stageAgentProfile(effectiveConfig, stage);
  let worker: string;
  try {
    ({ worker } = await ensureStageWorker(deps, full.identifier, stage, workspaceId, profile));
  } catch (error) {
    await deps.decisions.record(full.identifier, `begin failed: ${(error as Error).message} (workspace ${workspaceId})`);
    return { ok: false, text: `start failed: ${(error as Error).message} (workspace ${workspaceId}); Linear kept at ${state.status}+in_progress` };
  }
  const worktree = ticketWorktree(deps.repoRoot, full.identifier);
  const linear = latestValidReceipt(full.comments);
  const approved = stage === "deliver" ? latestReceiptOf(full.comments, "review-pass") : null;
  const git = deps.git ?? bunGitRunner();
  let head = "";
  try {
    head = (await git.run(["rev-parse", "HEAD"], worktree.path)).stdout.trim().split("\n")[0]?.trim() ?? "";
  } catch {
    head = "";
  }
  const order = buildStageWorkOrder({
    identifier: full.identifier,
    title: full.title,
    description: full.description,
    criteria: state.criteria,
    worktreePath: worktree.path,
    branch: worktree.branch,
    checkpoint: approved?.receipt.checkpoint ?? (head !== "" ? head : (linear?.receipt.checkpoint ?? "unborn")),
    resultPath: resultPathFor(deps.repoRoot, full.identifier, stage),
    stage,
    promptPath: promptPathForStage(assets, stage),
    harness: profile.harness,
    model: profile.model,
    ...(profile.effort !== undefined ? { effort: profile.effort } : {}),
    ...(effectiveConfig.delivery !== undefined ? { delivery: effectiveConfig.delivery } : {}),
  });
  const role = stage === "build" ? "builder" : stage === "review" ? "reviewer" : "deliverer";
  try {
    await confirmPromptDelivery(
      deps.workspaces,
      {
        project: effectiveConfig.project,
        ticket: full.identifier,
        role,
        stage,
        agent: worker,
        workOrder: workOrderHash(order),
      },
      order,
      deps.promptDelivery,
    );
  } catch (error) {
    await deps.decisions.record(full.identifier, `begin failed: ${(error as Error).message} (workspace ${workspaceId})`);
    return { ok: false, text: `start failed: ${(error as Error).message} (workspace ${workspaceId}); Linear kept at ${state.status}+in_progress` };
  }
  await deps.decisions.record(full.identifier, `recovered ${stage} worker ${worker} in ${workspaceId} at ${state.status}+in_progress (Linear kept)`);
  return { ok: true, text: `recovered ${full.identifier}: ${stage} worker ${worker} in workspace ${workspaceId} at ${state.status}+in_progress (Linear kept)`, workspaceId, worker, stage };
}

async function convergePending(deps: StageStartDeps, full: FullIssue, state: AuthoritativeState): Promise<void> {  const protocolDeps: ProtocolDeps = {
    client: deps.client,
    resolved: deps.resolved,
    workspaces: deps.workspaces,
    decisions: deps.decisions,
    git: deps.git ?? bunGitRunner(),
    repoRoot: deps.repoRoot,
  };
  if (state.status === "todo") {
    const status = statusOf(deps.resolved, full.state.id);
    if (status !== "todo") throw new Error(`begin failed: ${full.identifier} left Todo while beginning; retry`);
    await moveStatus(protocolDeps, full, "build", "in_progress");
    return;
  }
  await setProgress(protocolDeps, full, "in_progress");
  const reread = await deps.client.fetchIssue(full.id);
  if (!reread) throw new Error(`begin failed: Linear lost ${full.identifier} mid-begin; retry`);
  const restate = deriveState(deps.resolved, reread as FullIssue);
  if (restate.status !== state.status || restate.progress !== "in_progress") {
    throw new Error(`begin failed: Linear did not converge on ${state.status}+in_progress; retry`);
  }
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
    throw new Error(`no workspace for ${ticket}; run \`igniter begin ${ticket}\` first`);
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
