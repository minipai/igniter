// Failure handling: what dispatch does when a ticket is failed by hand.
//
// `igniter fail` is the only failure signal — dispatch never judges failure
// by the clock. A failed ticket returns to Backlog with its Progress
// cleared, so it can never be re-claimed on its own: the owner replans it
// to Todo when the work should run again. The `agent-failed` label stays on
// as the visible scar. The Herdr workspace closes; the worktree stays, so
// failed work never vanishes.
//
// This module is a leaf: it takes its Linear client, workspaces, and log as
// arguments, so commands.ts can use it without a cycle.

import type { CommandResult, DecisionLog, ResolvedDispatch } from "./claims.ts";
import type { LinearClient } from "./linear.ts";
import {
  commanderName,
  workspaceForTicket,
  type CommandWorkspaces,
  type WorkspaceSnapshot,
} from "./workspaces.ts";

export const FAILED_MARKER = "<!-- igniter:failed -->";
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

export function buildFailedComment(reason: string, paneTail: string): string {
  const tail = paneTail.trimEnd();
  return tail
    ? `${FAILED_MARKER}\n${reason}\n\n\`\`\`\n${tail}\n\`\`\`\n`
    : `${FAILED_MARKER}\n${reason}\n`;
}

export interface FailureDeps {
  client: LinearClient;
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
 * move the issue to Backlog with Progress cleared, comment the reason with
 * the Commander pane's last 80 lines, and close the Herdr workspace. Every
 * write is idempotent (label add-if-missing, unconditional state write),
 * so a retry after a half-written failure converges instead of
 * duplicating; the bare marker dedupes the comment per ticket.
 */
export async function failTicket(
  deps: FailureDeps,
  issue: FailureIssue,
  reason: string,
  snapshot: WorkspaceSnapshot | null,
): Promise<CommandResult> {
  const { client, resolved, decisions } = deps;
  const workspace = snapshot ? workspaceForTicket(snapshot, issue.identifier) : undefined;
  let paneTail = "";
  if (workspace && snapshot) {
    const agent = snapshot.agents.find((a) => a.name === commanderName(issue.identifier));
    const pane = agent ?? snapshot.panes.find((p) => p.workspaceId === workspace.workspaceId);
    if (pane) {
      try {
        paneTail = (await deps.workspaces.readPane(pane.paneId, 80)).text;
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
    await client.setIssueState(issue.id, resolved.stateIds.backlog);
    const existingIds = (issue.labels ?? []).map((l) => l.id);
    const progressIds = new Set(Object.values(resolved.progress.ids));
    const keep = existingIds.filter((id) => !progressIds.has(id));
    if (!keep.includes(failedLabel.id)) keep.push(failedLabel.id);
    await client.setIssueLabels(issue.id, keep);
    await client.addComment(issue.id, buildFailedComment(reason, paneTail));
  } catch (error) {
    await decisions.record(issue.identifier, `fail failed: ${(error as Error).message}`);
    return { ok: false, text: `fail failed: ${(error as Error).message}` };
  }
  await decisions.record(issue.identifier, `failed: ${reason}`);
  if (!workspace) {
    return { ok: true, text: `failed ${issue.identifier}: ${reason} (no workspace to close)` };
  }
  // Only the Herdr workspace closes; the worktree stays.
  try {
    await deps.workspaces.close(workspace.workspaceId);
  } catch (error) {
    await decisions.record(issue.identifier, `workspace close failed: ${(error as Error).message}`);
    return { ok: true, text: `failed ${issue.identifier}: ${reason}; workspace close failed: ${(error as Error).message}` };
  }
  await decisions.record(issue.identifier, `workspace closed (${workspace.workspaceId})`);
  return { ok: true, text: `failed ${issue.identifier}: ${reason}; workspace ${workspace.workspaceId} closed` };
}
