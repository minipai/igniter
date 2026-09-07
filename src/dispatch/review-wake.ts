// Review wake-up: collect the Acceptance report after the Commander's wait dies.
//
// The Commander waits on its Acceptance worker (`reviewer-<ticket>`) for the
// completion report. When that wait breaks — sleep, memory pressure, a lost
// agent session, a tool error — the worker can still finish, and Linear then
// sits in Review + In progress forever: nothing moves it, because only the
// Commander submits, and the Commander never woke up.
//
// The watch loop therefore watches the Acceptance lifecycle once per poll
// for every Review + In progress ticket with a workspace:
//
// - the worker is `done` (or gone entirely) while the Commander is `idle`
//   or `done`: prompt the Commander once to read and handle the report;
// - the Commander itself is gone: rebuild it through the same recovery path
//   `igniter resume` uses, then hand it the same read-the-report prompt.
//
// The wake-up never judges: it does not read the report, does not decide
// PASS or FAIL, and never submits a Review receipt. A missing worker or a
// report without its completion marker only wakes the Commander to handle
// it. Deduplication is by ticket, stage, worker session, and revision, so
// one completion wakes once no matter how many polls see it, while a new
// worker session wakes again.

import type { LinearIssue } from "./linear.ts";
import { commanderPane, resumedWorkOrder, type RecoveryScope } from "./commands.ts";
import { confirmPromptDelivery, workOrderHash } from "./prompt-delivery.ts";
import { progressOf } from "./protocol.ts";
import {
  commanderName,
  reviewerName,
  workspaceForTicket,
  type WorkspaceSnapshot,
} from "./workspaces.ts";

/** Dedup identity for one worker completion: ticket, stage, session, revision. */
export function reviewWakeKey(ticket: string, session: string | null, revision: number | null): string {
  return `${ticket}|review|${session ?? "absent"}|${revision ?? "none"}`;
}

/** The nudge a live-but-waiting Commander gets when its worker is done. */
export function buildReviewWakePrompt(ticket: string, reviewer: string): string {
  return (
    `igniter: the Acceptance worker ${reviewer} for ${ticket} is done. ` +
    `Its Herdr status is only a lifecycle hint, never the result. ` +
    `Run \`igniter state --json\`, read the worker's report in its pane, and validate it end to end: ` +
    `it must end with ACCEPTANCE_COMPLETE and cover every criterion with expected, actual, evidence, ` +
    `and environment at the current checkpoint. ` +
    `Submit the validated report with \`igniter submit --input -\`; never submit without a complete report. ` +
    `Ask the owner only from Blocked: run \`igniter block --reason "<what you need>"\` before any owner question; ` +
    `after the answer, \`igniter unblock\` and \`igniter begin\`.`
  );
}

/** The nudge a Commander gets when its worker vanished before reporting. */
export function buildReviewerGonePrompt(ticket: string, reviewer: string): string {
  return (
    `igniter: the Acceptance worker ${reviewer} for ${ticket} is gone (no live agent). ` +
    `Run \`igniter state --json\` and inspect the workspace: when no usable report survives, ` +
    `recreate the Acceptance agent for the current checkpoint exactly as the Review section says. ` +
    `Never submit without a complete report ending in ACCEPTANCE_COMPLETE. ` +
    `Ask the owner only from Blocked: run \`igniter block --reason "<what you need>"\` before any owner question; ` +
    `after the answer, \`igniter unblock\` and \`igniter begin\`.`
  );
}

/**
 * Wake every Review + In progress ticket whose Acceptance worker finished
 * while its Commander sleeps. Linear is never written here — no labels, no
 * state, no comments, no receipts — only Herdr prompts and, when the
 * Commander is gone, a rebuild through the resume recovery path. One ticket
 * never stops the rest: failures record a line and the poll moves on.
 * `woken` carries the dedup keys across polls; a key lands only after its
 * wake-up actually went out, so a failed prompt retries on the next poll.
 */
export async function wakeReviewers(
  deps: RecoveryScope,
  snapshot: WorkspaceSnapshot,
  reviewIssues: LinearIssue[],
  woken: Set<string>,
): Promise<void> {
  for (const issue of reviewIssues) {
    // Only the waiting stage wakes: Pending has no worker yet, Complete
    // waits on the owner, Blocked already parked.
    const progresses = (issue.labels ?? [])
      .map((l) => progressOf(deps.resolved, l.id))
      .filter((p) => p !== undefined);
    if (progresses.length !== 1 || progresses[0] !== "in_progress") continue;
    const workspace = workspaceForTicket(snapshot, issue.identifier);
    if (!workspace) continue;
    if (workspace.tokens["paused"] === "1") continue;
    const reviewer = snapshot.agents.find((a) => a.name === reviewerName(issue.identifier));
    const finished = reviewer !== undefined && reviewer.agentStatus === "done";
    const gone = reviewer === undefined;
    if (!finished && !gone) continue;
    const commander = snapshot.agents.find((a) => a.name === commanderName(issue.identifier));
    // A working or blocked Commander still owns its wait; anything else
    // unknown is left alone rather than interrupted.
    if (commander !== undefined && commander.agentStatus !== "idle" && commander.agentStatus !== "done") {
      continue;
    }
    // A gone worker has no session of its own, so its key rides on the
    // Commander instead: prompting the Commander advances its revision, so
    // a later disappearance wakes again while an unchanged one stays deduped.
    const key = reviewer === undefined
      ? reviewWakeKey(issue.identifier, `absent+commander:${commander?.session ?? "none"}`, commander?.revision ?? null)
      : reviewWakeKey(issue.identifier, reviewer.session, reviewer.revision);
    if (woken.has(key)) continue;
    const prompt = finished
      ? buildReviewWakePrompt(issue.identifier, reviewerName(issue.identifier))
      : buildReviewerGonePrompt(issue.identifier, reviewerName(issue.identifier));
    try {
      if (commander !== undefined) {
        await deps.workspaces.prompt(commander.name, prompt);
        await deps.decisions.record(
          issue.identifier,
          `review wake-up: ${reviewerName(issue.identifier)} ${finished ? "done" : "gone"}, commander ${commander.agentStatus} prompted to read the report`,
        );
      } else {
        const kind = workspace.tokens["commander"] ?? "claude";
        const name = commanderName(issue.identifier);
        const paneId = await commanderPane(deps, issue.identifier, workspace.workspaceId, snapshot);
        if (!paneId) {
          await deps.decisions.record(issue.identifier, "review wake-up failed: workspace has no pane");
          continue;
        }
        await deps.workspaces.startAgent({ paneId, kind, name });
        const order = resumedWorkOrder(deps, issue, { ...workspace.tokens, status: "review", progress: "in_progress" });
        // The outer catch records the diagnosis and retries on the next
        // poll; the wake-up key lands only after both prompts went out.
        await confirmPromptDelivery(
          deps.workspaces,
          {
            project: deps.resolved.config.project,
            ticket: issue.identifier,
            role: "commander",
            stage: "command",
            agent: name,
            workOrder: workOrderHash(order),
          },
          order,
          deps.promptDelivery,
        );
        await deps.workspaces.prompt(name, prompt);
        await deps.decisions.record(
          issue.identifier,
          `review wake-up: ${reviewerName(issue.identifier)} ${finished ? "done" : "gone"}, commander rebuilt at review+in_progress and prompted to read the report`,
        );
      }
    } catch (error) {
      await deps.decisions.record(issue.identifier, `review wake-up failed: ${(error as Error).message}`);
      continue;
    }
    woken.add(key);
  }
}
