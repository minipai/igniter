// Dispatch watch loop and claiming logic.
//
// One factory host runs one `igniter serve` process, so there is exactly one
// claimant: the watch loop, plus `igniter start` forwarded through it over
// HTTP and serialized behind the same claim lock. Nothing here arbitrates
// between independent claimants, because there are none.
//
// Two problems remain, and the design answers exactly those:
// - Restart wipes memory. Running state is recovered from outside every
//   poll: Linear says which tickets sit in `building`, and Herdr —
//   local, authoritative about its own workspaces — says which of those are
//   actually running. A building ticket with no workspace gets its claim
//   finished (comment when missing, then the sink). The claim comment is a
//   record for people (host, slot, time), never a lock.
// - `start` racing the watch disappears instead of being managed: the CLI
//   POSTs to the running server, which claims inline under the same lock.
//
// Crash contract for the seam: the claim comment lands before the sink runs.
// A crash in between is resumed on the next poll or after a restart. Across
// crashes the sink is at-least-once per issue id, which holds only through
// the consumer's shared-state check (STA-162 must consult Linear, e.g. the
// claim comment, before opening a workspace) — keying by issue id alone is
// necessary but not sufficient. Supported topology is one dispatch process
// per project.
//
// The claim ends at the ClaimSink seam: STA-162 will turn a claimed ticket
// into a Herdr workspace. This ticket stops at state + comment + sink call;
// it never opens workspaces, starts agents, or touches Herdr.

import { hostname } from "node:os";
import { appendFile } from "node:fs/promises";
import type { DispatchConfig } from "./config.ts";
import { LinearClient, LinearError, type LinearIssue } from "./linear.ts";
import { NoWorkspaces, type RunningWorkspaces } from "./workspaces.ts";

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
}

/** What STA-162 will receive for every claimed ticket. */
export interface ClaimedTicket {
  id: string;
  identifier: string;
  title: string;
  host: string;
  slot: number;
  agent?: string;
  builder?: string;
}

export type ClaimSink = (claim: ClaimedTicket) => Promise<void> | void;

export class RunningFullError extends Error {
  readonly tickets: string[];
  constructor(maxRunning: number, tickets: string[]) {
    super(
      `at max_running (${maxRunning}); running: ${tickets.join(", ") || "none"}`,
    );
    this.name = "RunningFullError";
    this.tickets = tickets;
  }
}

export class MissingCriteriaError extends Error {
  constructor(identifier: string) {
    super(
      `ticket "${identifier}" has no acceptance-criteria section and was not claimed; a comment was left on the issue`,
    );
    this.name = "MissingCriteriaError";
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
  const stateId = (role: string, name: string): string => {
    const state = states.find((s) => s.name === name);
    if (!state) {
      throw new Error(
        `config error: status "${name}" (${role}) does not exist on team "${teamName}" (check .igniter/config.yaml)`,
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
  workspaces?: RunningWorkspaces;
}

export function defaultHost(): string {
  try {
    return hostname();
  } catch {
    return "unknown-host";
  }
}

/** Default sink: log the handoff STA-162 will fill. */
export function logClaim(claim: ClaimedTicket): void {
  console.log(
    `claimed ${claim.identifier} (slot ${claim.slot}) — workspace handoff belongs to STA-162 and is not wired yet`,
  );
}

export class Watcher {
  lastQueue: QueueEntry[] = [];
  lastPollAt: string | null = null;

  private readonly client: LinearClient;
  private readonly resolved: ResolvedDispatch;
  private readonly host: string;
  private readonly sink: ClaimSink;
  private readonly decisions: DecisionLog;
  private readonly workspaces: RunningWorkspaces;
  /** Tickets handed off this run: Herdr has not necessarily caught up yet. */
  private readonly handedOff = new Set<string>();
  private wasFull = false;

  constructor(options: WatcherOptions) {
    this.client = options.client;
    this.resolved = options.resolved;
    this.host = options.host ?? defaultHost();
    this.sink = options.sink ?? logClaim;
    this.decisions = options.decisions ?? stdoutDecisions();
    this.workspaces = options.workspaces ?? NoWorkspaces;
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

    // The page's queue snapshot: pre-claim order with a reason per ticket.
    const candidates = sortCandidates(
      await client.listIssuesByState(resolved.projectId, resolved.queuedStateId),
    );
    let free = resolved.config.maxRunning - running.length;
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

    // Herdr truth for restart recovery. When Herdr is unreadable every
    // ticket counts as present: adoption waits instead of opening
    // workspaces nobody asked for.
    let live: Set<string> | null = null;
    try {
      live = await this.workspaces.runningTickets();
    } catch (error) {
      console.warn(`herdr workspaces unreadable, adoption waiting: ${(error as Error).message}`);
    }

    // Adopt orphans oldest-first: building tickets with no live workspace and
    // no handoff this run. Budget counts adoptions that actually hand
    // onward, so one unadoptable ticket can never starve the rest.
    const orphans = running.filter(
      (issue) => !this.handedOff.has(issue.id) && !(live?.has(issue.identifier) ?? true),
    );
    const budget = Math.max(0, resolved.config.maxRunning - (running.length - orphans.length));
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

    // Fill free slots in priority order.
    free = resolved.config.maxRunning - running.length;
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

    // Slots-full is a transition, not a poll heartbeat: one line when the
    // queue blocks, silence while it stays blocked.
    const claimedIds = new Set(claimed.map((t) => t.id));
    const waiting = candidates.find(
      (c) => !claimedIds.has(c.id) && hasAcceptanceCriteria(c.description),
    );
    const fullNow = running.length >= resolved.config.maxRunning && waiting !== undefined;
    if (fullNow && !this.wasFull) {
      await this.decisions.record(
        waiting.identifier,
        `waiting: slots full (${running.length} running)`,
      );
    }
    this.wasFull = fullNow;

    this.lastPollAt = new Date().toISOString();
    return { claimed, running: running.map((t) => t.identifier) };
  }

  /**
   * `igniter start <ticket>`, executed inside the serve process under the
   * claim lock: the same claim on demand, skipping the queued state. Still
   * needs a free slot.
   */
  async claimDirect(
    identifier: string,
    options: StartClaimOptions = {},
  ): Promise<{ already: boolean; ticket?: ClaimedTicket }> {
    const { resolved, client } = this;
    const full = await client.fetchIssue(identifier);
    if (!full) throw new Error(`ticket "${identifier}" was not found in Linear`);
    if (full.projectId !== resolved.projectId) {
      throw new Error(`ticket "${identifier}" is not in project "${resolved.config.project}"`);
    }
    const running = await this.runningTickets();
    const extras = { agent: options.agent, builder: options.builder };
    if (full.state.id === resolved.buildingStateId) {
      // Handed off this run means claimed — by the watch moments ago, with no
      // workspace in Herdr yet — so asking Herdr would wrongly say otherwise.
      if (this.handedOff.has(full.id)) return { already: true };
      if (await this.hasWorkspace(full.identifier)) return { already: true };
      // The ticket itself must not count against its own adoption.
      const others = running.filter((t) => t.id !== full.id);
      if (others.length >= resolved.config.maxRunning) {
        await this.decisions.record(
          full.identifier,
          `refused: at max_running (${resolved.config.maxRunning}); running: ${others.map((t) => t.identifier).join(", ") || "none"}`,
        );
        throw new RunningFullError(
          resolved.config.maxRunning,
          others.map((t) => t.identifier),
        );
      }
      if (!hasClaimComment(full.comments)) {
        if (!(await this.ensureCriteria(full))) {
          throw new MissingCriteriaError(full.identifier);
        }
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
          ...extras,
        };
        await this.sinkAndMark(ticket, true);
        return { already: false, ticket };
      }
      const slot = claimedSlot(full.comments, this.host, resolved.config.maxRunning)
        ?? (await freeSlot(client, resolved, this.host, running));
      const ticket: ClaimedTicket = {
        id: full.id,
        identifier: full.identifier,
        title: full.title,
        host: this.host,
        slot,
        ...extras,
      };
      await this.sinkAndMark(ticket, true);
      return { already: false, ticket };
    }
    if (running.length >= resolved.config.maxRunning) {
      await this.decisions.record(
        full.identifier,
        `refused: at max_running (${resolved.config.maxRunning}); running: ${running.map((t) => t.identifier).join(", ") || "none"}`,
      );
      throw new RunningFullError(
        resolved.config.maxRunning,
        running.map((t) => t.identifier),
      );
    }
    if (!(await this.ensureCriteria(full))) {
      throw new MissingCriteriaError(full.identifier);
    }
    const from = full.state.name;
    let slot: number;
    try {
      await client.setIssueState(full.id, resolved.buildingStateId);
      slot = await freeSlot(client, resolved, this.host, running);
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
      ...extras,
    };
    await this.sinkAndMark(ticket, false, from);
    return { already: false, ticket };
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
   * poll resumes it.
   */
  private async sinkAndMark(ticket: ClaimedTicket, resumed: boolean, from?: string): Promise<void> {
    try {
      await this.sink(ticket);
    } catch (error) {
      await this.decisions.record(ticket.identifier, `handoff failed: ${(error as Error).message}`);
      throw error;
    }
    this.handedOff.add(ticket.id);
    if (resumed) {
      await this.decisions.record(ticket.identifier, `resumed: no workspace found (slot ${ticket.slot})`);
    } else {
      const building = this.resolved.config.states.building;
      await this.decisions.record(ticket.identifier, `claimed: ${from} → ${building} (slot ${ticket.slot})`);
      await this.decisions.record(ticket.identifier, `state: ${from} → ${building}`);
    }
  }

  /**
   * No criteria, no workspace: leaves the one-time nudge comment plus its
   * activity line, and reports whether the ticket may be claimed.
   */
  private async ensureCriteria(
    full: { id: string; identifier: string; description: string | null; comments: { body: string }[] },
  ): Promise<boolean> {
    if (hasAcceptanceCriteria(full.description)) return true;
    if (!full.comments.some((c) => c.body.includes(MISSING_MARKER))) {
      await this.client.addComment(full.id, buildMissingBody(this.resolved.config.states.queued));
      await this.decisions.record(full.identifier, "skipped: no acceptance criteria");
    }
    return false;
  }

  private async hasWorkspace(identifier: string): Promise<boolean> {
    try {
      return (await this.workspaces.runningTickets()).has(identifier);
    } catch (error) {
      console.warn(`herdr workspaces unreadable, assuming ${identifier} running: ${(error as Error).message}`);
      return true;
    }
  }
}

export interface StartClaimOptions {
  agent?: string;
  builder?: string;
}

/** One claimant: serialize polls and forwarded `start` claims. */
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

export interface ClaimRequest {
  identifier: string;
  agent?: string;
  builder?: string;
}

export interface DispatchApi {
  queue(): { lastPollAt: string | null; order: QueueEntry[] };
  activity(limit: number): Promise<string[]>;
  claim(request: ClaimRequest): Promise<{ already: boolean; ticket?: ClaimedTicket }>;
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
