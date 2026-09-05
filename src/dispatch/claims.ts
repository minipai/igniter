// Dispatch watch loop and claiming logic.
//
// One factory host runs one `igniter serve` process, so there is exactly one
// claimant: the watch loop, plus dispatch commands run inline under the same
// claim lock through `POST /api/command`. Nothing here arbitrates
// between independent claimants, because there are none.
//
// Two problems remain, and the design answers exactly those:
// - Restart wipes memory. Running state is recovered from outside every
//   poll: Linear says which tickets sit in `building`, and Herdr —
//   local, authoritative about its own workspaces — says which of those are
//   actually running. A building ticket with no workspace gets its claim
//   finished (comment when missing, then the sink). The claim comment is a
//   record for people (host, slot, time), never a lock.
// - A command racing the watch disappears instead of being managed: the CLI
//   POSTs to the running server, which runs it inline under the same lock.
//
// Crash contract for the seam: the claim comment lands before the sink runs.
// A crash in between is resumed on the next poll or after a restart. Across
// crashes the sink is at-least-once per issue id, which holds only through
// the consumer's shared-state check (the sink consults Linear, e.g. the
// claim comment, before opening a workspace) — keying by issue id alone is
// necessary but not sufficient. Supported topology is one dispatch process
// per project.
//
// The claim ends at the ClaimSink seam: the real sink opens the Herdr
// workspace and starts the Commander (see commands.ts).

import { hostname } from "node:os";
import { appendFile } from "node:fs/promises";
import type { DispatchConfig } from "./config.ts";
import { LinearClient, LinearError, type LinearIssue } from "./linear.ts";
import {
  buildOverBudgetComment,
  buildStalledComment,
  FAILED_LABEL,
  FAILED_MARKER,
  failedMarker,
  FALLBACK_FAIL_REASON,
  failTicket,
  formatDuration,
} from "./recovery.ts";
import {
  NoWorkspaces,
  commanderName,
  extractRunningTickets,
  overBudgetTickets,
  pausedTickets,
  ticketFromAgentName,
  tokensByTicket,
  workspaceForTicket,
  type CommandWorkspaces,
  type WorkspaceSnapshot,
} from "./workspaces.ts";

export const POLL_INTERVAL_MS = 30_000;

/** Marker embedded in claim comments: a human record, never a lock. */
export const CLAIM_MARKER = "<!-- igniter:claim -->";
/** Marker embedded in missing-criteria comments so we only nudge once. */
export const MISSING_MARKER = "<!-- igniter:missing-criteria -->";

export interface ResolvedDispatch {
  config: DispatchConfig;
  projectId: string;
  teamId: string;
  teamName: string;
  queuedStateId: string;
  buildingStateId: string;
  reviewStateId: string;
  failedStateId: string;
  mergeStateId: string;
}

/** What the commands and the watch hand to the sink for every claimed ticket. */
export interface ClaimedTicket {
  id: string;
  identifier: string;
  title: string;
  host: string;
  slot: number;
  agent?: string;
  builder?: string;
}

export type ClaimSink = (claim: ClaimedTicket) => Promise<SinkOpened | void> | SinkOpened | void;

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

/** A description is claimable when it has an acceptance-criteria section. */
export function hasAcceptanceCriteria(description: string | null): boolean {
  if (!description) return false;
  return /^#{1,6}\s+.*(驗收條件|acceptance\s+criteri(a|on))/im.test(description);
}

export function buildClaimBody(buildingStatus: string, host: string, slot: number): string {
  return `${CLAIM_MARKER}\nClaimed by host=${host} slot=${slot} at ${new Date().toISOString()}: moved to ${buildingStatus}.`;
}

export function parseClaimComment(body: string): { host: string; slot: number } | null {
  if (!body.includes(CLAIM_MARKER)) return null;
  const match = /host=(\S+)\s+slot=(\d+)/.exec(body);
  if (!match) return null;
  return { host: match[1] as string, slot: Number(match[2]) };
}

export function buildMissingBody(queuedStatus: string): string {
  return (
    `${MISSING_MARKER}\n` +
    `Cannot claim this ticket: it has no acceptance-criteria section. ` +
    `Add a \`## 驗收條件\` (or \`## Acceptance criteria\`) section to the description; ` +
    `dispatch re-checks every poll while it sits in ${queuedStatus}.`
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

/**
 * Validate the whole configuration once at startup and fail fast with a
 * clear message: unknown project, unknown team, any status name missing on
 * the team, or an ambiguous team scope.
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
  const stateId = (role: string, name: string, type?: string): string => {
    const state = states.find((s) => s.name === name);
    if (!state) {
      throw new Error(
        `config error: status "${name}" (${role}) does not exist on team "${teamName}" (check .igniter/config.yaml)`,
      );
    }
    if (type !== undefined && state.type !== type) {
      throw new Error(
        `config error: status "${name}" (${role}) must be a ${type}-type state on team "${teamName}" (got "${state.type}")`,
      );
    }
    return state.id;
  };
  return {
    config,
    projectId: project.id,
    teamId,
    teamName,
    queuedStateId: stateId("states.queued", config.states.queued),
    buildingStateId: stateId("states.building", config.states.building),
    reviewStateId: stateId("states.review", config.states.review),
    failedStateId: stateId("states.failed", config.states.failed),
    // Ready to merge is owner acceptance, not active work: it must sit on a
    // started-type workflow state, so dispatch never mistakes a done ticket
    // for one awaiting merge.
    mergeStateId: stateId("states.merge", config.states.merge, "started"),
  };
}

export function isTransientLinearError(error: unknown): boolean {
  return (
    error instanceof LinearError && (error.status === 0 || error.status === 429 || error.status >= 500)
  );
}

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

/** Lowest slot index in [0, maxRunning) this host has not already claimed. */
export async function freeSlot(
  client: LinearClient,
  resolved: ResolvedDispatch,
  host: string,
  running: LinearIssue[],
): Promise<number> {
  const taken = new Set<number>();
  for (const issue of running) {
    const full = await client.fetchIssue(issue.id);
    for (const comment of full?.comments ?? []) {
      const claim = parseClaimComment(comment.body);
      if (claim && claim.host === host && claim.slot >= 0 && claim.slot < resolved.config.maxRunning) {
        taken.add(claim.slot);
      }
    }
  }
  for (let slot = 0; slot < resolved.config.maxRunning; slot++) {
    if (!taken.has(slot)) return slot;
  }
  // Unreachable while callers honor the cap; 0 keeps the label in range.
  return 0;
}

/** This host's slot from its own claim comment, when it names one in range. */
function claimedSlot(comments: { body: string }[], host: string, maxRunning: number): number | null {
  for (const comment of comments) {
    const claim = parseClaimComment(comment.body);
    if (claim && claim.host === host && claim.slot >= 0 && claim.slot < maxRunning) return claim.slot;
  }
  return null;
}

function hasClaimComment(comments: { body: string }[]): boolean {
  return comments.some((c) => c.body.includes(CLAIM_MARKER));
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

/** The web page reads the tail so Activity survives a restart. */
export async function readActivityTail(logPath: string, limit: number): Promise<string[]> {
  const file = Bun.file(logPath);
  if (!(await file.exists())) return [];
  const lines = (await file.text()).split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.slice(-Math.max(1, Math.min(limit, 1000)));
}

export type QueueReason = "next" | "waiting, slots full" | "skipped: no acceptance criteria";

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
  now?: () => number;
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

/** Workspace id behind a ticket, with the same precedence as tokensByTicket. */
function findWorkspaceId(snapshot: WorkspaceSnapshot, identifier: string): string | null {
  for (const workspace of snapshot.workspaces) {
    if (workspace.tokens["ticket"] === identifier) return workspace.workspaceId;
  }
  for (const workspace of snapshot.workspaces) {
    if (workspace.label === identifier) return workspace.workspaceId;
  }
  const agent = snapshot.agents.find((a) => ticketFromAgentName(a.name) === identifier);
  return agent?.workspaceId ?? null;
}

/** A Linear issue with its comments, as the recovery reactions read it. */
type FullIssue = LinearIssue & { comments: { body: string }[] };

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
  private readonly now: () => number;
  /** Tickets handed off this run: Herdr has not necessarily caught up yet. */
  private readonly handedOff = new Set<string>();
  private wasFull = false;
  /**
   * Last stage seen per ticket, in process memory only. Seeded silently on
   * first sight so a restart never replays history as new transitions;
   * entries for vanished workspaces are dropped so a later rerun starts
   * fresh instead of diffing against a stale stage.
   */
  private readonly lastSeenStage = new Map<string, string>();
  /**
   * When each Commander agent was first seen `blocked`, in process memory
   * only. Seeded silently on first sight like `lastSeenStage`: a restart
   * starts the stall clock again instead of replaying history, while the
   * `stalled` token keeps the one-comment-per-episode promise durable.
   */
  private readonly blockedSince = new Map<string, number>();
  /**
   * Comments built and tokened but not yet posted, with their log line.
   * The token always goes out first — it frees the slot and is the
   * duplicate guard — so when the comment write fails the next poll posts
   * the stored text verbatim instead of building a duplicate. Process
   * memory only; a restart in that window loses at most one comment.
   */
  private readonly pendingStallComment = new Map<string, { comment: string; line: string }>();
  private readonly pendingBudgetComment = new Map<string, { comment: string; line: string }>();

  constructor(options: WatcherOptions) {
    this.client = options.client;
    this.resolved = options.resolved;
    this.host = options.host ?? defaultHost();
    this.sink = options.sink ?? logClaim;
    this.decisions = options.decisions ?? stdoutDecisions();
    this.workspaces = options.workspaces ?? NoWorkspaces;
    this.now = options.now ?? Date.now;
  }

  async runningTickets(): Promise<LinearIssue[]> {
    return this.client.listIssuesByState(this.resolved.projectId, this.resolved.buildingStateId);
  }

  /** One poll: adopt orphans, then fill free slots from the queued state. */
  async pollOnce(): Promise<PollResult> {
    const { resolved, client } = this;
    // Slot count is recovered from Linear on every poll, never from memory,
    // so a restarted dispatch sees the same cap as the one it replaced.
    const running = await this.runningTickets();
    const runningIds = new Set(running.map((t) => t.id));
    for (const id of [...this.handedOff]) {
      if (!runningIds.has(id)) this.handedOff.delete(id);
    }
    const claimed: ClaimedTicket[] = [];

    // Herdr truth for restart recovery and pause detection: one snapshot
    // per poll feeds both, never a second socket round trip. When Herdr is
    // unreadable every ticket counts as present: adoption waits instead of
    // opening workspaces nobody asked for.
    let live: Set<string> | null = null;
    let paused = new Set<string>();
    let overBudget = new Set<string>();
    let snapshot: WorkspaceSnapshot | null = null;
    try {
      snapshot = await this.workspaces.snapshot();
      live = extractRunningTickets(snapshot);
      paused = pausedTickets(snapshot);
      overBudget = overBudgetTickets(snapshot);
    } catch (error) {
      console.warn(`herdr workspaces unreadable, adoption waiting: ${(error as Error).message}`);
    }
    // A paused or over-budget ticket keeps its workspace but frees its slot.
    const holdsSlot = (ticket: LinearIssue): boolean =>
      !paused.has(ticket.identifier) && !overBudget.has(ticket.identifier);
    const activeCount = (tickets: LinearIssue[]): number =>
      tickets.filter(holdsSlot).length;

    // The page's queue snapshot: pre-claim order with a reason per ticket.
    const candidates = sortCandidates(
      await client.listIssuesByState(resolved.projectId, resolved.queuedStateId),
    );
    let free = resolved.config.maxRunning - activeCount(running);
    this.lastQueue = candidates.map((candidate) => {
      const entry = {
        identifier: candidate.identifier,
        title: candidate.title,
        priority: candidate.priority,
      };
      if (!hasAcceptanceCriteria(candidate.description)) {
        return { ...entry, reason: "skipped: no acceptance criteria" as QueueReason };
      }
      if (free > 0) {
        free -= 1;
        return { ...entry, reason: "next" as QueueReason };
      }
      return { ...entry, reason: "waiting, slots full" as QueueReason };
    });

    // Adopt orphans oldest-first: building tickets with no live workspace and
    // no handoff this run. Paused and over-budget tickets keep their
    // workspace and are never orphans. Budget counts adoptions that actually
    // hand onward, so one unadoptable ticket can never starve the rest.
    const orphans = running.filter(
      (issue) =>
        holdsSlot(issue) &&
        !this.handedOff.has(issue.id) &&
        !(live?.has(issue.identifier) ?? true),
    );
    const budget = Math.max(0, resolved.config.maxRunning - (activeCount(running) - orphans.length));
    const oldestFirst = [...orphans].sort((a, b) =>
      a.updatedAt !== b.updatedAt
        ? a.updatedAt < b.updatedAt ? -1 : 1
        : a.identifier < b.identifier ? -1 : 1,
    );
    let remaining = budget;
    for (const issue of oldestFirst) {
      if (remaining <= 0) break;
      const full = await client.fetchIssue(issue.id);
      if (!full) continue;
      if (hasClaimComment(full.comments)) {
        const slot = claimedSlot(full.comments, this.host, resolved.config.maxRunning)
          ?? (await freeSlot(client, resolved, this.host, running));
        const ticket: ClaimedTicket = {
          id: full.id,
          identifier: full.identifier,
          title: full.title,
          host: this.host,
          slot,
        };
        await this.sinkAndMark(ticket, true);
        claimed.push(ticket);
        remaining -= 1;
      } else if (await this.ensureCriteria(full)) {
        const ticket = await this.freshAdopt(full, running);
        if (ticket) {
          claimed.push(ticket);
          remaining -= 1;
        }
      }
    }

    // Fill free slots in priority order; paused and over-budget tickets hold
    // no slot. Orphan adoptions above never changed membership, so the
    // active count still stands.
    free = resolved.config.maxRunning - activeCount(running);
    for (const candidate of candidates) {
      if (free <= 0) break;
      const full = await client.fetchIssue(candidate.id);
      // A concurrent human move wins over us: leave it alone, silently.
      if (!full || full.state.id !== resolved.queuedStateId) continue;
      if (!(await this.ensureCriteria(full))) continue;
      const from = full.state.name;
      try {
        await client.setIssueState(full.id, resolved.buildingStateId);
        const slot = await freeSlot(client, resolved, this.host, running);
        await client.addComment(full.id, buildClaimBody(resolved.config.states.building, this.host, slot));
        const ticket: ClaimedTicket = {
          id: full.id,
          identifier: full.identifier,
          title: full.title,
          host: this.host,
          slot,
        };
        await this.sinkAndMark(ticket, false, from);
        claimed.push(ticket);
        free -= 1;
        running.push({ ...candidate, state: { id: resolved.buildingStateId, name: resolved.config.states.building } });
      } catch (error) {
        await this.decisions.record(full.identifier, `claim failed: ${(error as Error).message}`);
        throw error;
      }
    }

    // Tracking mirrors Commander stage reports into Linear (building →
    // review, review → building, Ready to merge → stage delivered). It runs
    // after claiming on the same single snapshot, and its failures never
    // break claiming: the next poll retries.
    if (snapshot) {
      try {
        await this.trackStages(snapshot, running);
      } catch (error) {
        console.warn(`stage tracking skipped: ${(error as Error).message}`);
      }
    }

    // Slots-full is a transition, not a poll heartbeat: one line when the
    // queue blocks, silence while it stays blocked.
    const claimedIds = new Set(claimed.map((t) => t.id));
    const waiting = candidates.find(
      (c) => !claimedIds.has(c.id) && hasAcceptanceCriteria(c.description),
    );
    const fullNow = activeCount(running) >= resolved.config.maxRunning && waiting !== undefined;
    if (fullNow && !this.wasFull) {
      await this.decisions.record(
        waiting.identifier,
        `waiting: slots full (${activeCount(running)} running)`,
      );
    }
    this.wasFull = fullNow;

    this.lastPollAt = new Date().toISOString();
    return { claimed, running: running.map((t) => t.identifier) };
  }

  /**
   * Mirror Commander stage reports into Linear, using the poll's single
   * snapshot. Only tickets with a workspace are ever touched.
   *
   * - Building + stage acceptance + owner pending → review.
   * - Review + stage back to build/verify (owner sent it back in the pane)
   *   → building. Review tickets at acceptance or delivered stay put.
   * - Ready to merge + open workspace + stage not delivered → stamp stage
   *   delivered (dispatch is the only writer of it) and clear owner_pending.
   * - Every other stage change logs one `stage: old → new` line, except
   *   `failed`, which the failure reaction below owns (label, state move,
   *   comment, workspace close) instead of a stage line.
   *
   * Then the recovery reactions, all judgment-free: they never decide a
   * ticket failed, stalled, or over budget by the clock — they react to the
   * Commander's own tokens (`stage=failed`, a `blocked` agent status, a
   * `started_at` older than `max_hours`) and to the Linear state type.
   */
  private async trackStages(snapshot: WorkspaceSnapshot, running: LinearIssue[]): Promise<void> {
    const { resolved, client } = this;
    const states = resolved.config.states;
    const byTicket = tokensByTicket(snapshot);

    for (const [ticket, tokens] of byTicket) {
      const stage = tokens["stage"];
      if (stage === undefined) continue;
      const previous = this.lastSeenStage.get(ticket);
      if (previous === undefined) {
        this.lastSeenStage.set(ticket, stage);
      } else if (previous !== stage) {
        this.lastSeenStage.set(ticket, stage);
        // The failure reaction below owns failed handling; keep the map
        // current without a stage line.
        if (stage === "failed") continue;
        try {
          await this.decisions.record(ticket, `stage: ${previous} → ${stage}`);
        } catch (error) {
          console.warn(`stage tracking skipped for ${ticket}: ${(error as Error).message}`);
        }
      }
    }
    for (const ticket of [...this.lastSeenStage.keys()]) {
      if (!byTicket.has(ticket)) this.lastSeenStage.delete(ticket);
    }

    for (const issue of running) {
      if (issue.state.id !== resolved.buildingStateId) continue;
      const tokens = byTicket.get(issue.identifier);
      if (!tokens) continue;
      if (tokens["stage"] !== "acceptance" || tokens["owner_pending"] !== "1") continue;
      try {
        await client.setIssueState(issue.id, resolved.reviewStateId);
        await this.decisions.record(
          issue.identifier,
          `state: ${states.building} → ${states.review} (stage acceptance, owner pending)`,
        );
      } catch (error) {
        console.warn(`stage tracking skipped for ${issue.identifier}: ${(error as Error).message}`);
      }
    }

    // The review and merge lists feed both the moves below and the
    // lifecycle reaction after them, so each is read once per poll. A list
    // that fails skips its moves; claiming already went through.
    let inReview: LinearIssue[] = [];
    try {
      inReview = await client.listIssuesByState(resolved.projectId, resolved.reviewStateId);
    } catch (error) {
      console.warn(`stage tracking skipped for review tickets: ${(error as Error).message}`);
    }
    for (const issue of inReview) {
      const tokens = byTicket.get(issue.identifier);
      if (!tokens) continue;
      const stage = tokens["stage"];
      if (stage !== "build" && stage !== "verify") continue;
      try {
        await client.setIssueState(issue.id, resolved.buildingStateId);
        await this.decisions.record(
          issue.identifier,
          `state: ${states.review} → ${states.building} (stage back to ${stage})`,
        );
      } catch (error) {
        console.warn(`stage tracking skipped for ${issue.identifier}: ${(error as Error).message}`);
      }
    }

    let inMerge: LinearIssue[] = [];
    try {
      inMerge = await client.listIssuesByState(resolved.projectId, resolved.mergeStateId);
    } catch (error) {
      console.warn(`stage tracking skipped for merge tickets: ${(error as Error).message}`);
    }
    for (const issue of inMerge) {
      const tokens = byTicket.get(issue.identifier);
      if (!tokens) continue;
      if (tokens["stage"] === "delivered") continue;
      const workspaceId = findWorkspaceId(snapshot, issue.identifier);
      if (!workspaceId) continue;
      try {
        await this.workspaces.reportMetadata(workspaceId, {
          stage: "delivered",
          stage_at: new Date().toISOString(),
          owner_pending: null,
        });
        // The snapshot above still says acceptance: remember the stamp so
        // the next poll does not replay it as a stage transition.
        this.lastSeenStage.set(issue.identifier, "delivered");
        await this.decisions.record(issue.identifier, `delivered: ${states.merge} → stage delivered`);
      } catch (error) {
        console.warn(`stage tracking skipped for ${issue.identifier}: ${(error as Error).message}`);
      }
    }

    // Recovery reactions on the same snapshot. One Linear read per ticket
    // per poll at most: full issues are fetched through this cache.
    const fetched = new Map<string, FullIssue | null>();
    const fetchFull = async (ticket: string): Promise<FullIssue | null> => {
      if (!fetched.has(ticket)) {
        try {
          fetched.set(ticket, await client.fetchIssue(ticket));
        } catch (error) {
          console.warn(`recovery read skipped for ${ticket}: ${(error as Error).message}`);
          fetched.set(ticket, null);
        }
      }
      return fetched.get(ticket) ?? null;
    };
    // Tickets already settled this poll (failed, workspace closed) are left
    // alone by the later reactions.
    const settled = new Set<string>();
    try {
      for (const ticket of await this.reactFailures(snapshot, byTicket, fetchFull)) settled.add(ticket);
    } catch (error) {
      console.warn(`failure reaction skipped: ${(error as Error).message}`);
    }
    try {
      const known = new Set([
        ...running.map((t) => t.identifier),
        ...inReview.map((t) => t.identifier),
        ...inMerge.map((t) => t.identifier),
      ]);
      await this.reactLifecycle(snapshot, byTicket, known, settled, fetchFull);
    } catch (error) {
      console.warn(`lifecycle reaction skipped: ${(error as Error).message}`);
    }
    try {
      await this.reactStalled(snapshot, byTicket, settled, fetchFull);
    } catch (error) {
      console.warn(`stall reaction skipped: ${(error as Error).message}`);
    }
    try {
      await this.reactOverBudget(snapshot, byTicket, settled, fetchFull);
    } catch (error) {
      console.warn(`budget reaction skipped: ${(error as Error).message}`);
    }
    try {
      await this.reactAcceptanceLabels(byTicket, settled, fetchFull);
    } catch (error) {
      console.warn(`label reaction skipped: ${(error as Error).message}`);
    }
  }

  /**
   * `stage=failed` runs the same failure actions as `igniter fail`, with the
   * reason from workspace metadata. Only a ticket still in active work (a
   * started-type Linear state) is failed; anything else already moved on.
   * Returns the tickets it acted on, so later reactions leave them alone.
   *
   * Nothing here is atomic, so the dedupe key is durable and per episode:
   * the workspace's `stage_at` token, written together with `stage=failed`
   * and stamped into the comment marker. A ticket that fails, returns to
   * the queue, and fails again with the same reason is a new episode and
   * reacts again. A half-written failure (label and state landed, comment
   * lost) is admitted back even though the issue already sits in the
   * failed state, as long as its workspace is still open and this
   * episode's comment never landed; the label and state writes are
   * idempotent, so the retry converges.
   */
  private async reactFailures(
    snapshot: WorkspaceSnapshot,
    byTicket: Map<string, Record<string, string>>,
    fetchFull: (ticket: string) => Promise<FullIssue | null>,
  ): Promise<Set<string>> {
    const { resolved, client } = this;
    const acted = new Set<string>();
    for (const [ticket, tokens] of byTicket) {
      if (tokens["stage"] !== "failed") continue;
      const reason = tokens["reason"]?.trim() ? (tokens["reason"] as string).trim() : FALLBACK_FAIL_REASON;
      const stageAt = tokens["stage_at"]?.trim() ? (tokens["stage_at"] as string).trim() : null;
      const episodeMarker = failedMarker(stageAt);
      try {
        const full = await fetchFull(ticket);
        if (!full) continue;
        const reactedThisEpisode = stageAt
          ? full.comments.some((c) => c.body.includes(episodeMarker))
          : full.comments.some((c) => c.body.includes(FAILED_MARKER) && c.body.includes(reason));
        if (reactedThisEpisode) continue;
        const retryingHalfWritten =
          full.state.id === resolved.failedStateId && workspaceForTicket(snapshot, ticket) !== undefined;
        if (full.state.type !== "started" && !retryingHalfWritten) continue;
        await failTicket(
          { client, resolved, workspaces: this.workspaces, decisions: this.decisions },
          full,
          reason,
          snapshot,
          stageAt,
        );
        acted.add(ticket);
      } catch (error) {
        console.warn(`failure reaction skipped for ${ticket}: ${(error as Error).message}`);
      }
    }
    return acted;
  }

  /**
   * The workspace follows the Linear state type: a ticket with an open
   * workspace whose state is anything but `started` (completed, canceled,
   * duplicate, unstarted, backlog, triage) gets its workspace closed. The
   * worktree stays. Started tickets keep their workspace, and so does every
   * ticket in the building/review/merge lists, which are active by shape.
   */
  private async reactLifecycle(
    snapshot: WorkspaceSnapshot,
    byTicket: Map<string, Record<string, string>>,
    known: Set<string>,
    settled: Set<string>,
    fetchFull: (ticket: string) => Promise<FullIssue | null>,
  ): Promise<void> {
    for (const ticket of byTicket.keys()) {
      if (known.has(ticket) || settled.has(ticket)) continue;
      try {
        const full = await fetchFull(ticket);
        if (!full) continue;
        if (full.state.type === undefined || full.state.type === "started") continue;
        const workspace = workspaceForTicket(snapshot, ticket);
        if (!workspace) continue;
        await this.workspaces.close(workspace.workspaceId);
        settled.add(ticket);
        await this.decisions.record(ticket, `workspace closed (${workspace.workspaceId})`);
      } catch (error) {
        console.warn(`lifecycle reaction skipped for ${ticket}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Post a comment stored when its token went out but the comment write
   * failed. The entry is only valid while its token still reads '1' in
   * this poll's snapshot: when the token was cleared meanwhile (`igniter
   * resume` clears over_budget), the episode is over, so drop the stale
   * comment instead of undoing the clear — no token write, no comment, no
   * line. Otherwise re-assert the token (idempotent), post the stored text
   * verbatim, then log the stored line: exactly one comment and one line
   * per episode. Throws on any failure; the caller keeps the entry and
   * retries next poll.
   */
  private async postPendingComment(
    snapshot: WorkspaceSnapshot,
    ticket: string,
    tokenKey: string,
    pending: Map<string, { comment: string; line: string }>,
    tokens: Record<string, string>,
    fetchFull: (ticket: string) => Promise<FullIssue | null>,
  ): Promise<void> {
    const entry = pending.get(ticket);
    if (entry === undefined) return;
    if (tokens[tokenKey] !== "1") {
      pending.delete(ticket);
      return;
    }
    const full = await fetchFull(ticket);
    if (!full) throw new Error(`issue ${ticket} unreadable`);
    const workspace = workspaceForTicket(snapshot, ticket);
    if (workspace) {
      await this.workspaces.reportMetadata(workspace.workspaceId, { [tokenKey]: "1" });
    }
    await this.client.addComment(full.id, entry.comment);
    pending.delete(ticket);
    await this.decisions.record(ticket, entry.line);
  }

  /**
   * A Commander agent continuously `blocked` past `blocked_minutes` gets one
   * issue comment (where it is stuck plus the pane's last 20 lines) and
   * `stalled=1`. Leaving `blocked` clears `stalled` back to null. One
   * comment per blocked episode: the token is the durable guard and goes
   * out before the comment, so a new episode after a recovery comments
   * again. Linear state and workspace never change here.
   */
  private async reactStalled(
    snapshot: WorkspaceSnapshot,
    byTicket: Map<string, Record<string, string>>,
    settled: Set<string>,
    fetchFull: (ticket: string) => Promise<FullIssue | null>,
  ): Promise<void> {
    const { resolved, client } = this;
    const thresholdMs = resolved.config.blockedMinutes * 60_000;
    const now = this.now();
    for (const [ticket, tokens] of byTicket) {
      if (settled.has(ticket)) continue;
      try {
        const agent = snapshot.agents.find((a) => a.name === commanderName(ticket));
        if (agent?.agentStatus === "blocked") {
          const since = this.blockedSince.get(ticket) ?? now;
          this.blockedSince.set(ticket, since);
          if (now - since > thresholdMs) {
            if (this.pendingStallComment.has(ticket)) {
              try {
                await this.postPendingComment(snapshot, ticket, "stalled", this.pendingStallComment, tokens, fetchFull);
              } catch (error) {
                console.warn(`stall comment retry skipped for ${ticket}: ${(error as Error).message}`);
              }
              continue;
            }
            if (tokens["stalled"] !== "1") {
              const workspace = workspaceForTicket(snapshot, ticket)
                ?? snapshot.workspaces.find((w) => w.workspaceId === agent.workspaceId);
              if (!workspace) continue;
              // Token first: it is the duplicate guard, so it must land
              // before the comment is attempted.
              try {
                await this.workspaces.reportMetadata(workspace.workspaceId, { stalled: "1" });
              } catch (error) {
                console.warn(`stall token skipped for ${ticket}: ${(error as Error).message}`);
                continue;
              }
              const full = await fetchFull(ticket);
              if (!full) continue;
              let paneTail = "";
              try {
                paneTail = (await this.workspaces.readPane(agent.paneId, 20)).text;
              } catch {
                paneTail = "";
              }
              const blockedFor = formatDuration(now - since);
              const line = `stalled: commander blocked for ${blockedFor} at stage ${tokens["stage"] ?? "?"}`;
              const comment = buildStalledComment(agent.name, tokens["stage"] ?? null, blockedFor, paneTail);
              try {
                await client.addComment(full.id, comment);
              } catch (error) {
                // The token is set; remember the text and post it next
                // poll verbatim instead of building a duplicate.
                this.pendingStallComment.set(ticket, { comment, line });
                console.warn(`stall comment skipped for ${ticket}: ${(error as Error).message}`);
                continue;
              }
              await this.decisions.record(ticket, line);
            }
          }
        } else {
          this.blockedSince.delete(ticket);
          this.pendingStallComment.delete(ticket);
          if (tokens["stalled"] === "1") {
            const workspace = workspaceForTicket(snapshot, ticket);
            if (!workspace) continue;
            await this.workspaces.reportMetadata(workspace.workspaceId, { stalled: null });
            await this.decisions.record(ticket, "stalled cleared");
          }
        }
      } catch (error) {
        console.warn(`stall reaction skipped for ${ticket}: ${(error as Error).message}`);
      }
    }
    for (const ticket of [...this.blockedSince.keys()]) {
      if (!byTicket.has(ticket)) this.blockedSince.delete(ticket);
    }
    for (const ticket of [...this.pendingStallComment.keys()]) {
      if (!byTicket.has(ticket)) this.pendingStallComment.delete(ticket);
    }
  }

  /**
   * A workspace alive past `max_hours` (from `started_at`) whose stage has
   * not reached acceptance gets one issue comment and `over_budget=1`, and
   * stops counting against `max_running` — the same mechanism `paused=1`
   * uses. The token goes out before the comment: it frees the slot and is
   * the duplicate guard, so a lost comment is posted next poll verbatim.
   * Blocked and over-budget are not failures: Linear state and workspace
   * never change here, and `igniter resume` clears the token.
   */
  private async reactOverBudget(
    snapshot: WorkspaceSnapshot,
    byTicket: Map<string, Record<string, string>>,
    settled: Set<string>,
    fetchFull: (ticket: string) => Promise<FullIssue | null>,
  ): Promise<void> {
    const { resolved, client } = this;
    const budgetMs = resolved.config.maxHours * 3600_000;
    const now = this.now();
    for (const [ticket, tokens] of byTicket) {
      if (settled.has(ticket)) continue;
      if (this.pendingBudgetComment.has(ticket)) {
        try {
          await this.postPendingComment(snapshot, ticket, "over_budget", this.pendingBudgetComment, tokens, fetchFull);
        } catch (error) {
          console.warn(`budget comment retry skipped for ${ticket}: ${(error as Error).message}`);
        }
        continue;
      }
      if (tokens["over_budget"] === "1") continue;
      const stage = tokens["stage"];
      // A ticket waiting on the owner (or delivered) is never over budget —
      // the same predicate the status page shows as OVER.
      if (stage === "acceptance" || stage === "delivered") continue;
      const startedMs = tokens["started_at"] ? Date.parse(tokens["started_at"]) : NaN;
      if (!Number.isFinite(startedMs)) continue;
      const elapsedMs = now - startedMs;
      if (!(elapsedMs > budgetMs)) continue;
      try {
        const full = await fetchFull(ticket);
        if (!full || full.state.type !== "started") continue;
        const workspace = workspaceForTicket(snapshot, ticket);
        if (workspace) {
          try {
            await this.workspaces.reportMetadata(workspace.workspaceId, { over_budget: "1" });
          } catch (error) {
            console.warn(`budget token skipped for ${ticket}: ${(error as Error).message}`);
            continue;
          }
        }
        const elapsed = formatDuration(elapsedMs);
        const line = `over budget: ${elapsed} past ${resolved.config.maxHours}h at stage ${stage ?? "?"}`;
        const comment = buildOverBudgetComment(elapsed, resolved.config.maxHours, stage ?? null);
        try {
          await client.addComment(full.id, comment);
        } catch (error) {
          // The token is set; remember the text and post it next poll
          // verbatim instead of building a duplicate.
          this.pendingBudgetComment.set(ticket, { comment, line });
          console.warn(`budget comment skipped for ${ticket}: ${(error as Error).message}`);
          continue;
        }
        await this.decisions.record(ticket, line);
      } catch (error) {
        console.warn(`budget reaction skipped for ${ticket}: ${(error as Error).message}`);
      }
    }
    for (const ticket of [...this.pendingBudgetComment.keys()]) {
      if (!byTicket.has(ticket)) this.pendingBudgetComment.delete(ticket);
    }
  }

  /**
   * A previously failed ticket reaching `stage=acceptance` loses the
   * `agent-failed` label. Label presence is the record: no label, no read
   * beyond the one fetch, no line.
   */
  private async reactAcceptanceLabels(
    byTicket: Map<string, Record<string, string>>,
    settled: Set<string>,
    fetchFull: (ticket: string) => Promise<FullIssue | null>,
  ): Promise<void> {
    for (const [ticket, tokens] of byTicket) {
      if (settled.has(ticket) || tokens["stage"] !== "acceptance") continue;
      try {
        const full = await fetchFull(ticket);
        if (!full) continue;
        const labels = full.labels ?? [];
        const failedId = labels.find((l) => l.name === FAILED_LABEL)?.id;
        if (!failedId) continue;
        await this.client.setIssueLabels(
          full.id,
          labels.map((l) => l.id).filter((id) => id !== failedId),
        );
        await this.decisions.record(ticket, "agent-failed label removed");
      } catch (error) {
        console.warn(`label reaction skipped for ${ticket}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Adopt a comment-less building ticket found during a poll: record the
   * claim and hand it off.
   */
  private async freshAdopt(full: LinearIssue & { comments: { body: string }[] }, running: LinearIssue[]): Promise<ClaimedTicket> {
    const { resolved, client } = this;
    const slot = await freeSlot(client, resolved, this.host, running);
    try {
      await client.addComment(full.id, buildClaimBody(resolved.config.states.building, this.host, slot));
    } catch (error) {
      await this.decisions.record(full.identifier, `claim failed: ${(error as Error).message}`);
      throw error;
    }
    const ticket: ClaimedTicket = {
      id: full.id,
      identifier: full.identifier,
      title: full.title,
      host: this.host,
      slot,
    };
    await this.sinkAndMark(ticket, true);
    return ticket;
  }

  /**
   * Run the sink, remember the handoff for this run, and log what happened.
   * A throwing sink aborts the poll: the ticket stays unmarked, so the next
   * poll resumes it. A mid-way sink failure names the workspace so a person
   * can clean it up; there is no rollback.
   */
  private async sinkAndMark(ticket: ClaimedTicket, resumed: boolean, from?: string): Promise<void> {
    let opened: SinkOpened | void;
    try {
      opened = await this.sink(ticket);
    } catch (error) {
      const suffix =
        error instanceof WorkspaceSinkError && error.workspaceId
          ? ` (workspace ${error.workspaceId})`
          : "";
      await this.decisions.record(ticket.identifier, `handoff failed: ${(error as Error).message}${suffix}`);
      throw error;
    }
    this.handedOff.add(ticket.id);
    if (resumed) {
      await this.decisions.record(ticket.identifier, `resumed: no workspace found (slot ${ticket.slot})`);
    } else {
      await recordClaim(this.decisions, ticket.identifier, from ?? "?", this.resolved.config.states.building, ticket.slot);
    }
    if (opened) {
      await this.decisions.record(
        ticket.identifier,
        `workspace opened (${opened.workspaceId}) commander=${opened.commander} builder=${opened.builder}`,
      );
    }
  }

  /**
   * No criteria, no workspace: leaves the one-time nudge comment plus its
   * activity line, and reports whether the ticket may be claimed.
   */
  private async ensureCriteria(
    full: { id: string; identifier: string; description: string | null; comments: { body: string }[] },
  ): Promise<boolean> {
    return ensureAcceptanceCriteria(this.client, this.resolved, full, this.decisions);
  }
}

/**
 * The two claim lines, shared by the watch loop and `igniter start`: the
 * human record of the state move.
 */
export async function recordClaim(
  decisions: DecisionLog,
  identifier: string,
  from: string,
  building: string,
  slot: number,
): Promise<void> {
  await decisions.record(identifier, `claimed: ${from} → ${building} (slot ${slot})`);
  await decisions.record(identifier, `state: ${from} → ${building}`);
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
    await client.addComment(full.id, buildMissingBody(resolved.config.states.queued));
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

export interface DispatchApi {
  queue(): { lastPollAt: string | null; order: QueueEntry[] };
  activity(limit: number): Promise<string[]>;
  command(argv: string[]): Promise<CommandResult>;
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
