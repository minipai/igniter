// Recovery reactions: what dispatch does when a ticket goes wrong.
//
// Both `igniter fail` and the watch loop's `stage=failed` reaction run one
// code path here (`failTicket`). Dispatch never judges failure by the
// clock: the only failure signals are `stage=failed` and `igniter fail`.
// Blocked and over-budget are not failures — they comment and set a token,
// leaving the Linear state and the workspace alone.
//
// This module is a leaf: it takes its Linear client, workspaces, and log as
// arguments, so both commands.ts and claims.ts can use it without a cycle.

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
export const STALLED_MARKER = "<!-- igniter:stalled -->";
export const OVER_BUDGET_MARKER = "<!-- igniter:over-budget -->";

/** Reason used when a Commander reports `stage=failed` with no `reason`. */
export const FALLBACK_FAIL_REASON = "Commander reported stage=failed with no reason";

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

/**
 * The failure marker, keyed by episode when the caller knows it. The watch
 * loop passes the workspace's `stage_at` token, so a ticket that fails,
 * returns to the queue, and fails again with the same reason still gets a
 * fresh reaction per episode. `igniter fail` has no episode and keeps the
 * bare marker.
 */
export function failedMarker(stageAt?: string | null): string {
  return stageAt ? `<!-- igniter:failed ${stageAt} -->` : FAILED_MARKER;
}

export function buildFailedComment(reason: string, paneTail: string, stageAt?: string | null): string {
  const tail = paneTail.trimEnd();
  const marker = failedMarker(stageAt);
  return tail
    ? `${marker}\n${reason}\n\n\`\`\`\n${tail}\n\`\`\`\n`
    : `${marker}\n${reason}\n`;
}

export function buildStalledComment(
  agentName: string,
  stage: string | null,
  blockedFor: string,
  paneTail: string,
): string {
  const tail = paneTail.trimEnd();
  const head =
    `${STALLED_MARKER}\n` +
    `Commander ${agentName} is blocked at stage ${stage ?? "?"} (${blockedFor}). ` +
    `The ticket stays where it is; answer the Commander to clear this.`;
  return tail ? `${head}\n\n\`\`\`\n${tail}\n\`\`\`\n` : `${head}\n`;
}

export function buildOverBudgetComment(elapsed: string, maxHours: number, stage: string | null): string {
  return (
    `${OVER_BUDGET_MARKER}\n` +
    `Running ${elapsed} past the ${maxHours}h budget at stage ${stage ?? "?"}: ` +
    `the ticket no longer counts toward max_running, so another ticket may claim its slot. ` +
    `Linear state and workspace unchanged; \`igniter resume\` clears this once the run continues.`
  );
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
 * The failure actions, shared by `igniter fail` and the watch loop's
 * `stage=failed` reaction: ensure the `agent-failed` label, move the issue
 * to `states.failed`, comment the reason with the Commander pane's last 80
 * lines, and close the Herdr workspace. The worktree stays: failed work
 * never vanishes, and a later start or a human picks the checkout up again.
 * Every write is idempotent (label add-if-missing, unconditional state
 * write), so a retry after a half-written failure converges instead of
 * duplicating; the caller guards the comment with the episode marker.
 */
export async function failTicket(
  deps: FailureDeps,
  issue: FailureIssue,
  reason: string,
  snapshot: WorkspaceSnapshot | null,
  stageAt?: string | null,
): Promise<CommandResult> {
  const { client, resolved, decisions } = deps;
  const workspace = snapshot ? workspaceForTicket(snapshot, issue.identifier) : undefined;
  let paneTail = "";
  if (workspace && snapshot) {
    const agent = snapshot.agents.find((a) => a.name === commanderName(issue.identifier));
    const pane = agent ?? snapshot.panes.find((p) => p.workspaceId === workspace.workspaceId);
    if (pane) {
      try {
        paneTail = await deps.workspaces.readPane(pane.paneId, 80);
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
    await client.setIssueState(issue.id, resolved.failedStateId);
    const existingIds = (issue.labels ?? []).map((l) => l.id);
    if (!existingIds.includes(failedLabel.id)) {
      await client.setIssueLabels(issue.id, [...existingIds, failedLabel.id]);
    }
    await client.addComment(issue.id, buildFailedComment(reason, paneTail, stageAt));
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
