// Dispatch watch loop and claiming logic.
//
// One factory host runs one `igniter serve` process, so there is exactly one
// claimant: the watch loop, plus dispatch commands run inline under the same
// claim lock through `POST /api/command`. Nothing here arbitrates
// between independent claimants, because there are none.
//
// Linear status and Progress are authoritative; Herdr workspace metadata
// only mirrors them (see protocol.ts). The watch loop therefore does three
// Linear-first jobs per poll: normalize Todo tickets to Todo+Pending, claim
// claimable ones through the shared claim path, and normalize owner moves in
// Linear (Review+Complete approval/send-back, Deliver+Complete completion).
//
// Crash contract for the seam: the workspace and its ticket metadata land
// before the Commander starts. A crash in between is resumed on the next
// poll or after a restart. Supported topology is one dispatch process per
// project.
//
// The claim ends at the ClaimSink seam: the real sink opens the Herdr
// workspace and starts the Commander (see commands.ts).

import { hostname } from "node:os";
import { appendFile } from "node:fs/promises";
import type { DispatchConfig } from "./config.ts";
import { LinearClient, LinearError, type LinearIssue } from "./linear.ts";
import {
  adoptTicket,
  claimTicket,
  countBuildSlots,
  finishClaim,
  isTransientLinearError,
  normalizeOwnerMove,
  parseAcceptanceCriteria,
  progressOf,
  statusOf,
  type ProtocolDeps,
  type ProtocolProgress,
  type ProtocolStatus,
} from "./protocol.ts";
import {
  NoWorkspaces,
  commanderName,
  extractRunningTickets,
  workspaceForTicket,
  type CommandWorkspaces,
  type WorkspaceSnapshot,
} from "./workspaces.ts";
import { wakeReviewers } from "./review-wake.ts";
import { bunGitRunner, type GitRunner } from "./worktrees.ts";

export type { ProtocolStatus, ProtocolProgress };

export const POLL_INTERVAL_MS = 30_000;

/** Marker embedded in missing-criteria comments so we only nudge once. */
export const MISSING_MARKER = "<!-- igniter:missing-criteria -->";

export interface ResolvedDispatch {
  config: DispatchConfig;
  projectId: string;
  teamId: string;
  teamName: string;
  stateIds: Record<ProtocolStatus, string>;
  progress: {
    groupId: string;
    ids: Record<ProtocolProgress, string>;
  };
}

/** What the commands and the watch hand to the sink for every claimed ticket. */
export interface ClaimedTicket {
  id: string;
  identifier: string;
  title: string;
  host: string;
  slot: number;
  builder?: string;
}

export interface ExistingClaim {
  workspaceId: string;
}

export type ClaimSink = (
  claim: ClaimedTicket,
  existing?: ExistingClaim,
) => Promise<SinkOpened | void> | SinkOpened | void;

/** What the real sink hands back after opening the workspace. */
export interface SinkOpened {
  workspaceId: string;
  commander: string;
  builder: string;
}

/** A sink failure after the workspace exists carries its id for cleanup. */
export class WorkspaceSinkError extends Error {
  readonly workspaceId?: string;
  constructor(message: string, workspaceId?: string) {
    super(message);
    this.name = "WorkspaceSinkError";
    this.workspaceId = workspaceId;
  }
}

/** A description is claimable when it has a non-empty acceptance-criteria checklist. */
export function hasAcceptanceCriteria(description: string | null): boolean {
  return parseAcceptanceCriteria(description).length > 0;
}

export function buildMissingBody(todoStatus: string): string {
  return (
    `${MISSING_MARKER}\n` +
    `Cannot claim this ticket: it has no acceptance-criteria checklist. ` +
    `Add a \`## 驗收條件\` (or \`## Acceptance criteria\`) section with checklist items to the description; ` +
    `run \`igniter start <ticket>\` again after adding the criteria while it sits in ${todoStatus}.`
  );
}

/** Linear priority first (1 Urgent … 4 Low, 0 None last), then longest waiting. */
export function sortCandidates(issues: LinearIssue[]): LinearIssue[] {
  const rank = (priority: number): number => (priority === 0 ? 5 : priority);
  return [...issues].sort((a, b) => {
    if (rank(a.priority) !== rank(b.priority)) return rank(a.priority) - rank(b.priority);
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
    return a.identifier < b.identifier ? -1 : 1;
  });
}

/** Read the Todo queue once without normalizing, claiming, or opening workspaces. */
export async function readQueue(
  client: LinearClient,
  resolved: ResolvedDispatch,
): Promise<QueueEntry[]> {
  const candidates = sortCandidates(
    await client.listIssuesByState(resolved.projectId, resolved.stateIds.todo),
  );
  let free = resolved.config.maxRunning - (await countBuildSlots(client, resolved));
  return candidates.map((candidate) => {
    const entry = {
      identifier: candidate.identifier,
      title: candidate.title,
      priority: candidate.priority,
    };
    if (!hasAcceptanceCriteria(candidate.description)) {
      return { ...entry, reason: "skipped: no acceptance criteria" as QueueReason };
    }
    const progresses = (candidate.labels ?? [])
      .map((label) => progressOf(resolved, label.id))
      .filter((progress) => progress !== undefined);
    if (progresses.length === 1 && progresses[0] === "blocked") {
      return { ...entry, reason: "parked: blocked" as QueueReason };
    }
    if (free > 0) {
      free -= 1;
      return { ...entry, reason: "next" as QueueReason };
    }
    return { ...entry, reason: "waiting, slots full" as QueueReason };
  });
}

/**
 * Validate the whole configuration once at startup and fail fast with a
 * clear message: unknown project, unknown team, any status name missing on
 * the team, a status on the wrong workflow type, or the Progress group and
 * its four labels missing or mis-grouped. An old config (queued, building,
 * review, failed, merge) fails here at parse time with unknown roles.
 */
export async function validateStartup(client: LinearClient, config: DispatchConfig): Promise<ResolvedDispatch> {
  const projects = await client.listProjects();
  const project = projects.find((p) => p.name === config.project || p.slugId === config.project);
  if (!project) {
    throw new Error(
      `config error: project "${config.project}" was not found in Linear (check "project" in .igniter/config.yaml)`,
    );
  }
  const teams = await client.listTeams();
  let teamId: string;
  let teamName: string;
  if (config.team) {
    const team = teams.find((t) => t.name === config.team || t.key === config.team);
    if (!team) {
      throw new Error(`config error: team "${config.team}" was not found in Linear (check "team" in .igniter/config.yaml)`);
    }
    if (!project.teamIds.includes(team.id)) {
      throw new Error(`config error: project "${config.project}" is not in team "${config.team}"`);
    }
    teamId = team.id;
    teamName = team.name;
  } else {
    if (project.teamIds.length !== 1) {
      throw new Error(
        `config error: project "${config.project}" spans ${project.teamIds.length} teams; set "team" in .igniter/config.yaml to pick one`,
      );
    }
    const team = teams.find((t) => t.id === project.teamIds[0]);
    if (!team) {
      throw new Error(`config error: the team behind project "${config.project}" was not found in Linear`);
    }
    teamId = team.id;
    teamName = team.name;
  }
  const states = await client.teamStates(teamId);
  const expectedType: Record<ProtocolStatus, string> = {
    backlog: "backlog",
    todo: "unstarted",
    build: "started",
    review: "started",
    deliver: "started",
    done: "completed",
  };
  const stateIds = {} as Record<ProtocolStatus, string>;
  for (const role of Object.keys(expectedType) as ProtocolStatus[]) {
    const name = config.states[role];
    const state = states.find((s) => s.name === name);
    if (!state) {
      throw new Error(
        `config error: status "${name}" (states.${role}) does not exist on team "${teamName}" (check .igniter/config.yaml)`,
      );
    }
    if (state.type !== expectedType[role]) {
      throw new Error(
        `config error: status "${name}" (states.${role}) must be a ${expectedType[role]}-type state on team "${teamName}" (got "${state.type}")`,
      );
    }
    stateIds[role] = state.id;
  }
  const labels = await client.teamLabels(teamId);
  const group = labels.find((l) => l.name === config.progress.group);
  if (!group) {
    throw new Error(
      `config error: label group "${config.progress.group}" (progress.group) was not found on team "${teamName}" (check .igniter/config.yaml)`,
    );
  }
  const ids = {} as Record<ProtocolProgress, string>;
  for (const role of ["pending", "in_progress", "complete", "blocked"] as const) {
    const name = config.progress[role];
    const label = labels.find((l) => l.name === name && l.parent?.id === group.id);
    if (!label) {
      throw new Error(
        `config error: label "${name}" (progress.${role}) is not in label group "${config.progress.group}" on team "${teamName}" (check .igniter/config.yaml)`,
      );
    }
    ids[role] = label.id;
  }
  return { config, projectId: project.id, teamId, teamName, stateIds, progress: { groupId: group.id, ids } };
}

export { isTransientLinearError };
export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  onRetry?: (attempt: number, error: Error) => void;
}

/**
 * Retry Linear until it answers. Transport outages and rate limits wait;
 * anything else (bad credentials, and every configuration error, which
 * arrives as a plain Error) still throws immediately.
 */
export async function validateWithRetry(
  run: () => Promise<ResolvedDispatch>,
  options: RetryOptions,
): Promise<ResolvedDispatch> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await run();
    } catch (error) {
      if (!isTransientLinearError(error) || attempt >= options.maxAttempts) throw error;
      options.onRetry?.(attempt, error as Error);
      await Bun.sleep(Math.min(options.baseDelayMs * attempt, 30_000));
    }
  }
}

/** One decision line: `<time> <ticket> <one sentence>`. Polls never log. */
export interface DecisionLog {
  record(ticket: string, message: string): Promise<void>;
}

function stdoutDecisions(): DecisionLog {
  return {
    record: async (ticket, message) => {
      console.log(`${new Date().toISOString()} ${ticket} ${message}`);
    },
  };
}

/** Decisions print to stdout and append to `.igniter/dispatch.log`. */
export function createDispatchLog(logPath: string, print: (line: string) => void = console.log): DecisionLog {
  return {
    record: async (ticket, message) => {
      const line = `${new Date().toISOString()} ${ticket} ${message}`;
      print(line);
      await appendFile(logPath, `${line}\n`);
    },
  };
}

export type QueueReason = "next" | "waiting, slots full" | "skipped: no acceptance criteria" | "parked: blocked";

export interface QueueEntry {
  identifier: string;
  title: string;
  priority: number;
  reason: QueueReason;
}

export interface PollResult {
  claimed: ClaimedTicket[];
  running: string[];
}

export interface WatcherOptions {
  client: LinearClient;
  resolved: ResolvedDispatch;
  host?: string;
  sink?: ClaimSink;
  decisions?: DecisionLog;
  workspaces?: CommandWorkspaces;
  git?: GitRunner;
  repoRoot?: string;
}

export function defaultHost(): string {
  try {
    return hostname();
  } catch {
    return "unknown-host";
  }
}

/** Default sink: log the handoff when no workspace opener is wired. */
export function logClaim(claim: ClaimedTicket): void {
  console.log(
    `claimed ${claim.identifier} (slot ${claim.slot}) — no workspace sink wired`,
  );
}

export class Watcher {
  lastQueue: QueueEntry[] = [];
  lastPollAt: string | null = null;

  private readonly client: LinearClient;
  /** Validated dispatch, shared with commands running beside the watch loop. */
  readonly resolved: ResolvedDispatch;
  private readonly host: string;
  private readonly sink: ClaimSink;
  private readonly decisions: DecisionLog;
  private readonly workspaces: CommandWorkspaces;
  private readonly git: GitRunner;
  private readonly repoRoot: string;
  /** Tickets handed off this run: Herdr has not necessarily caught up yet. */
  private readonly handedOff = new Set<string>();
  /** Review completions already woken: ticket, stage, worker session, revision. */
  private readonly reviewWoken = new Set<string>();
  /** Mirror/wake follow-ups a later poll retries after a failed best-effort. */
  private readonly followUps = new Map<string, { workspaceId: string | null; tokens: Record<string, string | null>; wakeText: string }>();
  /** Done workspace closes a later poll retries after a failed best-effort. */
  private readonly closeDues = new Map<string, { workspaceId: string | null; checkpoint: string }>();
  /** Last refusal line per ticket: identical refusals stay silent after the first. */
  private readonly lastRefusal = new Map<string, string>();
  private wasFull = false;

  constructor(options: WatcherOptions) {
    this.client = options.client;
    this.resolved = options.resolved;
    this.host = options.host ?? defaultHost();
    this.sink = options.sink ?? logClaim;
    this.decisions = options.decisions ?? stdoutDecisions();
    this.workspaces = options.workspaces ?? NoWorkspaces;
    this.git = options.git ?? bunGitRunner();
    this.repoRoot = options.repoRoot ?? process.cwd();
  }

  async runningTickets(): Promise<LinearIssue[]> {
    return this.client.listIssuesByState(this.resolved.projectId, this.resolved.stateIds.build);
  }

  /**
   * One poll: normalize Todo tickets, adopt orphans, claim into free slots,
   * then normalize owner moves in Linear. Linear is read fresh on every
   * poll, never from memory, so a restarted dispatch sees the same world
   * as the one it replaced.
   */
  async pollOnce(): Promise<PollResult> {
    const { resolved, client } = this;
    const running = await this.runningTickets();
    const runningIds = new Set(running.map((t) => t.id));
    for (const id of [...this.handedOff]) {
      if (!runningIds.has(id)) this.handedOff.delete(id);
    }
    const claimed: ClaimedTicket[] = [];

    let snapshot: WorkspaceSnapshot | null = null;
    try {
      snapshot = await this.workspaces.snapshot();
    } catch (error) {
      console.warn(`herdr workspaces unreadable, claims waiting: ${(error as Error).message}`);
    }

    // Todo normalization is Linear-only, so it runs even while Herdr is
    // down: Todo tickets gain Pending, criteria-less ones get one nudge.
    const candidates = sortCandidates(
      await client.listIssuesByState(resolved.projectId, resolved.stateIds.todo),
    );
    const ready: typeof candidates = [];
    for (const candidate of candidates) {
      const full = await client.fetchIssue(candidate.id);
      // A concurrent human move wins over us: leave it alone, silently.
      if (!full || full.state.id !== resolved.stateIds.todo) continue;
      const progresses = (full.labels ?? [])
        .map((l) => progressOf(resolved, l.id))
        .filter((p) => p !== undefined);
      if (progresses.length > 1) {
        await this.decisions.record(
          full.identifier,
          `normalize refused: ${progresses.length} Progress labels; an owner must leave exactly one`,
        );
        continue;
      }
      if (progresses.length === 0) {
        const keep = (full.labels ?? []).map((l) => l.id);
        await client.setIssueLabels(full.id, [...keep, resolved.progress.ids.pending]);
        await this.decisions.record(
          full.identifier,
          `normalized: Todo → Todo+${resolved.config.progress.pending}`,
        );
      }
      if (!(await this.ensureCriteria(full))) continue;
      // Only Todo+Pending may enter the claim queue. A bare Todo gains
      // Pending above and enters; anything already parked (Blocked) stays
      // parked quietly: no claim attempt, no repeated line, no queue slot.
      const effective = progresses.length === 0 ? "pending" : (progresses[0] ?? "pending");
      if (effective !== "pending") continue;
      ready.push(candidate);
    }

    // Slot count is recovered from Linear on every poll: Build tickets
    // without Blocked hold slots; Blocked ones keep their workspace free.
    let free = resolved.config.maxRunning - (await countBuildSlots(client, resolved));

    // The page's queue snapshot: pre-claim order with a reason per ticket.
    // Parked tickets never consume a next slot.
    this.lastQueue = candidates.map((candidate) => {
      const entry = {
        identifier: candidate.identifier,
        title: candidate.title,
        priority: candidate.priority,
      };
      if (!hasAcceptanceCriteria(candidate.description)) {
        return { ...entry, reason: "skipped: no acceptance criteria" as QueueReason };
      }
      const progresses = (candidate.labels ?? [])
        .map((l) => progressOf(resolved, l.id))
        .filter((p) => p !== undefined);
      if (progresses.length === 1 && progresses[0] === "blocked") {
        return { ...entry, reason: "parked: blocked" as QueueReason };
      }
      if (free > 0) {
        free -= 1;
        return { ...entry, reason: "next" as QueueReason };
      }
      return { ...entry, reason: "waiting, slots full" as QueueReason };
    });

    if (snapshot) {
      // Adopt orphans oldest-first: active tickets with no live workspace
      // and no handoff this run. Blocked tickets keep their workspace when
      // it exists; a lost one is adopted like any other.
      const live = extractRunningTickets(snapshot);
      const inReview = await client.listIssuesByState(resolved.projectId, resolved.stateIds.review);
      const inDeliver = await client.listIssuesByState(resolved.projectId, resolved.stateIds.deliver);
      const active = [...running, ...inReview, ...inDeliver];
      const orphans = active.filter(
        (issue) => !this.handedOff.has(issue.id) && !live.has(issue.identifier),
      );
      const oldestFirst = [...orphans].sort((a, b) =>
        a.updatedAt !== b.updatedAt
          ? a.updatedAt < b.updatedAt ? -1 : 1
          : a.identifier < b.identifier ? -1 : 1,
      );
      for (const issue of oldestFirst) {
        const full = await client.fetchIssue(issue.id);
        if (!full) continue;
        await this.adopt(full as Parameters<Watcher["adopt"]>[0]);
      }

      // Fill free slots in priority order through the shared claim path. A
      // Todo ticket whose workspace is already open finishes its
      // half-written claim instead of opening a second workspace.
      free = resolved.config.maxRunning - (await countBuildSlots(client, resolved));
      for (const candidate of ready) {
        if (free <= 0) break;
        const full = await client.fetchIssue(candidate.id);
        if (!full || full.state.id !== resolved.stateIds.todo) continue;
        try {
          const deps = this.protocolDeps();
          const open = workspaceForTicket(snapshot, full.identifier);
          if (open && open.tokens["ticket"] === full.identifier) {
            const ticket = await finishClaim(deps, full as Parameters<typeof finishClaim>[1], open.workspaceId, open.tokens, free);
            this.handedOff.add(ticket.id);
            claimed.push(ticket);
          } else {
            const ticket = await claimTicket(deps, full as Parameters<typeof claimTicket>[1], {});
            this.handedOff.add(ticket.id);
            claimed.push(ticket);
          }
          free -= 1;
          running.push(candidate);
        } catch (error) {
          await this.decisions.record(candidate.identifier, `claim failed: ${(error as Error).message}`);
        }
      }

      // Review wake-up: a finished Acceptance worker whose Commander's wait
      // died gets one read-the-report prompt (or a rebuilt Commander).
      // Linear is never written here, and one ticket never stops the rest.
      try {
        await wakeReviewers(
          {
            resolved: this.resolved,
            workspaces: this.workspaces,
            decisions: this.decisions,
            repoRoot: this.repoRoot,
          },
          snapshot,
          inReview,
          this.reviewWoken,
        );
      } catch (error) {
        console.warn(`review wake-up skipped: ${(error as Error).message}`);
      }
    }

    // Owner moves in Linear, normalized from the Linear state plus the
    // newest valid receipt alone: approval, send-back, and completion.
    // Workspace metadata never authorizes these, so they run outside the
    // snapshot gate — a missing workspace never blocks protocol convergence.
    try {
      await this.normalizeOwnerMoves();
    } catch (error) {
      console.warn(`owner-move normalization skipped: ${(error as Error).message}`);
    }

    // Deferred mirror/wake/close follow-ups from earlier transitions.
    try {
      await this.retryFollowUps();
    } catch (error) {
      console.warn(`follow-up retry skipped: ${(error as Error).message}`);
    }

    // Slots-full is a transition, not a poll heartbeat: one line when the
    // queue blocks, silence while it stays blocked.
    const claimedIds = new Set(claimed.map((t) => t.id));
    const waiting = ready.find((c) => !claimedIds.has(c.id));
    const fullNow = free <= 0 && waiting !== undefined;
    if (fullNow && !this.wasFull && waiting) {
      await this.decisions.record(
        waiting.identifier,
        `waiting: slots full (${resolved.config.maxRunning} running)`,
      );
    }
    this.wasFull = fullNow;

    this.lastPollAt = new Date().toISOString();
    return { claimed, running: running.map((t) => t.identifier) };
  }

  /**
   * Adopt an active ticket found with no live workspace through the shared
   * adoption path. Records its own lines and never throws, so one
   * unadoptable ticket can never starve the rest of the poll.
   */
  private async adopt(
    full: { id: string; identifier: string; title: string },
  ): Promise<void> {
    const rich = await this.client.fetchIssue(full.id);
    if (!rich) return;
    try {
      const opened = await adoptTicket(
        this.protocolDeps(),
        rich as Parameters<typeof adoptTicket>[1],
        {},
      );
      this.handedOff.add(rich.id);
      void opened;
    } catch (error) {
      const suffix =
        error instanceof WorkspaceSinkError && error.workspaceId
          ? ` (workspace ${error.workspaceId})`
          : "";
      await this.decisions.record(full.identifier, `adopt failed: ${(error as Error).message}${suffix}`);
    }
  }

  /**
   * Normalize owner moves from Linear alone: every Build, Review, Deliver,
   * and Done ticket is re-read and converged from its current status plus
   * Progress plus the newest valid receipt. Quiet states return nothing and
   * stay silent; transitions and refusals record one line. Follow-ups a
   * transition defers (mirror, wake-up, close) are kept for later polls.
   */
  private async normalizeOwnerMoves(): Promise<void> {
    const deps = this.protocolDeps();
    for (const status of ["build", "review", "deliver", "done"] as const) {
      let issues;
      try {
        issues = await this.client.listIssuesByState(this.resolved.projectId, this.resolved.stateIds[status]);
      } catch (error) {
        console.warn(`owner-move scan skipped for ${status}: ${(error as Error).message}`);
        continue;
      }
      for (const issue of issues) {
        const full = await this.client.fetchIssue(issue.id);
        if (!full) continue;
        if (full.projectId !== this.resolved.projectId) continue;
        let outcome;
        try {
          outcome = await normalizeOwnerMove(deps, full as Parameters<typeof normalizeOwnerMove>[1]);
        } catch (error) {
          await this.decisions.record(full.identifier, `owner move failed: ${(error as Error).message}`);
          continue;
        }
        if (outcome.followUp) this.followUps.set(full.identifier, outcome.followUp);
        else if (outcome.result?.ok) this.followUps.delete(full.identifier);
        if (outcome.closeDue) this.closeDues.set(full.identifier, outcome.closeDue);
        if (outcome.result) {
          // Refusals repeat while the state stands: record the diagnosis
          // once, then stay silent until it changes or converges.
          if (!outcome.result.ok) {
            if (this.lastRefusal.get(full.identifier) === outcome.result.text) continue;
            this.lastRefusal.set(full.identifier, outcome.result.text);
          } else {
            this.lastRefusal.delete(full.identifier);
          }
          await this.decisions.record(full.identifier, outcome.result.text);
        } else {
          this.lastRefusal.delete(full.identifier);
        }
      }
    }
  }

  /**
   * Retry deferred post-transition work. A follow-up whose Linear state
   * moved on is dropped instead of mirrored; a close whose ticket left
   * Done never touches the workspace. Anything else that still fails
   * stays queued silently, so a dead Herdr never spams Activity.
   */
  private async retryFollowUps(): Promise<void> {
    for (const [ticket, due] of [...this.followUps]) {
      try {
        const full = await this.client.fetchIssue(ticket);
        const linearStatus = full ? statusOf(this.resolved, full.state.id) : null;
        const linearProgress = full
          ? (full.labels ?? []).map((l) => progressOf(this.resolved, l.id)).find((p) => p !== undefined) ?? null
          : null;
        if (!full || linearStatus !== due.tokens["status"] || linearProgress !== due.tokens["progress"]) {
          this.followUps.delete(ticket);
          await this.decisions.record(ticket, `follow-up dropped: Linear moved on`);
          continue;
        }
        const snapshot = await this.workspaces.snapshot();
        const workspace = due.workspaceId
          ? snapshot.workspaces.find((w) => w.workspaceId === due.workspaceId)
          : snapshot.workspaces.find((w) => w.tokens["ticket"] === ticket);
        if (!workspace || workspace.tokens["ticket"] !== ticket) {
          this.followUps.delete(ticket);
          await this.decisions.record(ticket, `follow-up dropped: no workspace for ${ticket}`);
          continue;
        }
        await this.workspaces.reportMetadata(workspace.workspaceId, due.tokens);
        const commander = snapshot.agents.find((a) => a.name === commanderName(ticket));
        if (!commander) {
          // No resident commander (STA-225): the mirror above is the whole
          // convergence, and the external Global Commander observes it.
          this.followUps.delete(ticket);
          await this.decisions.record(ticket, `workspace mirror caught up after ${due.tokens["status"]}+${due.tokens["progress"]}; no commander to wake`);
          continue;
        }
        await this.workspaces.prompt(commander.name, due.wakeText);
        this.followUps.delete(ticket);
        await this.decisions.record(ticket, `workspace mirror caught up after ${due.tokens["status"]}+${due.tokens["progress"]}`);
      } catch {
        // Keep the follow-up; the next poll retries.
      }
    }
    for (const [ticket, due] of [...this.closeDues]) {
      try {
        const full = await this.client.fetchIssue(ticket);
        const linearStatus = full ? statusOf(this.resolved, full.state.id) : null;
        if (!full || linearStatus !== "done") {
          this.closeDues.delete(ticket);
          await this.decisions.record(ticket, `close retry dropped: Linear moved on`);
          continue;
        }
        const snapshot = await this.workspaces.snapshot();
        const workspace = due.workspaceId
          ? snapshot.workspaces.find((w) => w.workspaceId === due.workspaceId)
          : snapshot.workspaces.find((w) => w.tokens["ticket"] === ticket);
        if (!workspace || workspace.tokens["ticket"] !== ticket) {
          this.closeDues.delete(ticket);
          await this.decisions.record(ticket, `close retry dropped: no workspace for ${ticket}`);
          continue;
        }
        await this.workspaces.close(workspace.workspaceId);
        this.closeDues.delete(ticket);
        await this.decisions.record(ticket, `workspace closed on retry (${workspace.workspaceId})`);
      } catch {
        // Keep the close-due; the next poll retries.
      }
    }
  }

  private protocolDeps(): ProtocolDeps & { sink: ClaimSink; host: string } {
    return {
      client: this.client,
      resolved: this.resolved,
      workspaces: this.workspaces,
      decisions: this.decisions,
      git: this.git,
      repoRoot: this.repoRoot,
      sink: this.sink,
      host: this.host,
    };
  }

  /**
   * No criteria, no claim: leaves the one-time nudge comment plus its
   * activity line, and reports whether the ticket may be claimed. Shared by
   * the watch loop and `igniter start`.
   */
  private async ensureCriteria(
    full: { id: string; identifier: string; description: string | null; comments: { body: string }[] },
  ): Promise<boolean> {
    return ensureAcceptanceCriteria(this.client, this.resolved, full, this.decisions);
  }
}

/**
 * No criteria, no claim: leaves the one-time nudge comment plus its
 * activity line, and reports whether the ticket may be claimed. Shared by
 * the watch loop and `igniter start`.
 */
export async function ensureAcceptanceCriteria(
  client: LinearClient,
  resolved: ResolvedDispatch,
  full: { id: string; identifier: string; description: string | null; comments: { body: string }[] },
  decisions: DecisionLog,
): Promise<boolean> {
  if (hasAcceptanceCriteria(full.description)) return true;
  if (!full.comments.some((c) => c.body.includes(MISSING_MARKER))) {
    await client.addComment(full.id, buildMissingBody(resolved.config.states.todo));
    await decisions.record(full.identifier, "skipped: no acceptance criteria");
  }
  return false;
}

/** One claimant: serialize polls and commands running under the same lock. */
export function createClaimLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

export interface CommandResult {
  ok: boolean;
  text: string;
  data?: unknown;
}

export interface CommandCallOptions {
  workspaceId?: string;
  /** CLI `start` asks dispatch for a foreground Commander launch. */
  directStart?: boolean;
  /** Raw stdin payload for `submit --input -`. */
  input?: string;
}

export interface DispatchApi {
  command(argv: string[], options?: CommandCallOptions): Promise<CommandResult>;
}

export interface WatchHandle {
  watcher: Watcher;
  stop: () => Promise<void>;
}

export interface WatchLoopOptions {
  watcher: Watcher;
  intervalMs?: number;
  onError?: (error: Error) => void;
  rateLimitCooldownMs?: number;
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export function startWatch(options: WatchLoopOptions): WatchHandle {
  const { watcher } = options;
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const cooldownBaseMs = options.rateLimitCooldownMs ?? 60_000;
  const lock = options.lock ?? ((fn) => fn());
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let cooldownUntil = 0;
  let consecutiveRateLimited = 0;
  const tick = (): void => {
    // Never stack overlapping polls when a poll is slow, and stay quiet
    // while a rate-limit cooldown is running.
    if (stopped || inFlight || Date.now() < cooldownUntil) return;
    inFlight = (async (): Promise<void> => {
      try {
        await lock(() => watcher.pollOnce());
        consecutiveRateLimited = 0;
      } catch (error) {
        if (error instanceof LinearError && error.status === 429) {
          consecutiveRateLimited += 1;
          const cooldownMs = Math.min(cooldownBaseMs * 2 ** (consecutiveRateLimited - 1), 300_000);
          cooldownUntil = Date.now() + cooldownMs;
          const cooled = new LinearError(429, `Linear rate limited; cooling down for ${cooldownMs}ms`);
          if (options.onError) options.onError(cooled);
          else console.error(`watch poll failed: ${cooled.message}`);
        } else {
          consecutiveRateLimited = 0;
          // Network failure is expected, not fatal: log and wait for next tick.
          if (options.onError) options.onError(error as Error);
          else console.error(`watch poll failed: ${(error as Error).message}`);
        }
      } finally {
        inFlight = null;
      }
    })();
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  return {
    watcher,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      // Let an in-flight poll settle so shutdown never leaves a claim
      // half-written; request timeouts bound the wait.
      const pending = inFlight;
      if (pending) await Promise.race([pending, Bun.sleep(30_000)]);
    },
  };
}
