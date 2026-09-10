// Failure handling: what dispatch does when a ticket is failed by hand.
//
// `igniter fail` is the only failure signal — dispatch never judges failure
// by the clock. A failed ticket returns to Backlog with its Progress
// cleared, so it can never be re-claimed on its own: the owner replans it
// to Todo when the work should run again. The `agent-failed` label stays on
// as the visible scar. Stopping the worker is an explicit Worker command;
// this Linear operation never closes a pane or changes the checkout.
//
// This module is a leaf: it takes its Linear client, workspaces, and log as
// arguments, so commands.ts can use it without a cycle.

import type { CommandResult, DecisionLog, ResolvedDispatch } from "../../config/claims.ts";
import type { LinearClientLike } from "../../service/linear/linear.ts";
import {
  type CommandWorkspaces,
  type WorkspaceSnapshot,
} from "../../service/workspace/workspaces.ts";
import { failedEventBody, hasFailedEvent } from "./event.ts";
import { isTransientLinearError } from "./protocol.ts";

export const FAILED_LABEL = "agent-failed";

/** Reason used when a failure arrives with no reason. */
export const FALLBACK_FAIL_REASON = "dispatch failed the ticket with no reason";

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

export function buildFailedComment(ticket: string, reason: string, paneTail: string): string {
  const tail = paneTail.trimEnd();
  const prose = tail ? `${reason}\n\n\`\`\`\n${tail}\n\`\`\`` : reason;
  return `${prose}\n\n${failedEventBody(ticket, reason)}\n`;
}

export interface FailureDeps {
  client: LinearClientLike;
  resolved: ResolvedDispatch;
  workspaces: CommandWorkspaces;
  decisions: DecisionLog;
}

export interface FailureIssue {
  id: string;
  identifier: string;
  labels?: { id: string; name: string }[];
}

/**
 * The failure actions for `igniter fail`: ensure the `agent-failed` label,
 * move the issue to Backlog with Progress cleared, and comment the reason.
 * Label add-if-missing and the state write are naturally idempotent. Every
 * call posts a fresh comment — the same reason recurring on a later,
 * separate failure is a new event, not a duplicate of an earlier one — but
 * a lost write result reads back before deciding whether to retry it:
 * `hasFailedEvent` is checked only against comments not already present
 * before this write, never against the ticket's whole history, so an old
 * failure with an identical reason can never suppress today's comment or
 * be mistaken for today's landed write.
 */
export async function failTicket(
  deps: FailureDeps,
  issue: FailureIssue,
  reason: string,
  _snapshot: WorkspaceSnapshot | null,
): Promise<CommandResult> {
  const { client, resolved, decisions } = deps;
  const paneTail = "";

  try {
    // Label first: a failure here leaves Linear untouched, while anything
    // after the state move would leave the ticket half-failed.
    const failedLabel = (await client.lookupIssueLabel(FAILED_LABEL))
      ?? (await client.createIssueLabel(resolved.teamId, FAILED_LABEL));
    await client.setIssueState(issue.id, resolved.stateIds.backlog);
    const existingIds = (issue.labels ?? []).map((l) => l.id);
    const progressIds = new Set(Object.values(resolved.progress.ids));
    const keep = existingIds.filter((id) => !progressIds.has(id));
    if (!keep.includes(failedLabel.id)) keep.push(failedLabel.id);
    await client.setIssueLabels(issue.id, keep);
    const before = await client.fetchIssue(issue.id);
    const beforeIds = new Set((before?.comments ?? []).map((c) => c.id).filter((id): id is string => !!id));
    const body = buildFailedComment(issue.identifier, reason, paneTail);
    try {
      await client.addComment(issue.id, body);
    } catch (error) {
      if (!isTransientLinearError(error)) throw error;
      const read = await client.fetchIssue(issue.id);
      const landed = (read?.comments ?? []).filter((c) => !c.id || !beforeIds.has(c.id));
      if (!hasFailedEvent(landed, issue.identifier, reason)) throw error;
    }
  } catch (error) {
    await decisions.record(issue.identifier, `fail failed: ${(error as Error).message}`);
    return { ok: false, text: `fail failed: ${(error as Error).message}` };
  }
  await decisions.record(issue.identifier, `failed: ${reason}`);
  return { ok: true, text: `failed ${issue.identifier}: ${reason}; worker stop is a separate command` };
}
