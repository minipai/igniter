// Shared dispatch validation, queue reads, logging, and command API.

import { appendFile } from "node:fs/promises";
import type { DispatchConfig } from "./config.ts";
import { type LinearClientLike, type LinearIssue } from "../service/linear/linear.ts";
import {
  countBuildSlots,
  isTransientLinearError,
  parseAcceptanceCriteria,
  progressOf,
  type ProtocolProgress,
  type ProtocolStatus,
} from "../lifecycle/ticket/protocol.ts";
export type { ProtocolStatus, ProtocolProgress };

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

/** Workspace operations preserve the workspace id when reporting a failure. */
export class WorkspaceError extends Error {
  readonly workspaceId?: string;
  constructor(message: string, workspaceId?: string) {
    super(message);
    this.name = "WorkspaceError";
    this.workspaceId = workspaceId;
  }
}

/** A description has acceptance criteria when it has a non-empty acceptance-criteria checklist. */
export function hasAcceptanceCriteria(description: string | null): boolean {
  return parseAcceptanceCriteria(description).length > 0;
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
  client: LinearClientLike,
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
export async function validateStartup(client: LinearClientLike, config: DispatchConfig): Promise<ResolvedDispatch> {
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
    canceled: "canceled",
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

/** One decision line: `<time> <ticket> <one sentence>`. */
export interface DecisionLog {
  record(ticket: string, message: string): Promise<void>;
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

export interface CommandResult {
  ok: boolean;
  text: string;
  data?: unknown;
}
