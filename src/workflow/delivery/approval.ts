import type { CommandResult } from "../config/claims.ts";
import {
  checkpointInLineage,
  deriveState,
  isTransientLinearError,
  latestReceiptOf,
  latestValidReceipt,
  moveStatus,
  progressOf,
  ProtocolError,
  statusOf,
  stageStartedAfterReceipt,
  type FullIssue,
  type ProtocolDeps,
  type ProtocolStatus,
} from "../ticket/protocol.ts";

function approvalState(deps: ProtocolDeps, full: FullIssue) {
  const progress = full.labels.map((label) => progressOf(deps.resolved, label.id)).filter(Boolean);
  // Done inherits Complete when the status write lands but label clearing
  // fails. Only a matching approval intent below may finish this pair.
  if (statusOf(deps.resolved, full.state.id) === "done" && progress.length === 1 && progress[0] === "complete") {
    return { status: "done", progress: "complete" } as const;
  }
  return deriveState(deps.resolved, full);
}

/** The receipt ID is the approval's retry identity, including across stages. */
export async function approveTicket(
  deps: ProtocolDeps,
  full: FullIssue,
  receiptId: string,
): Promise<CommandResult> {
  const latest = latestValidReceipt(full.comments);
  if (!latest?.id || latest.id !== receiptId) {
    throw new ProtocolError("stale approval: read status and use its current receipt.id; no stage was approved");
  }
  const { kind, checkpoint, submission } = latest.receipt;
  const source = kind === "build" ? "build" : kind === "review-pass" ? "review" : kind === "deliver" ? "deliver" : null;
  if (!source) throw new ProtocolError("approve requires a Build, Review PASS, or Deliver receipt");
  const target: ProtocolStatus = source === "build" ? "review" : source === "review" ? "deliver" : "done";
  const state = approvalState(deps, full);
  // The durable intent is written before either status or Progress. It is
  // also the audit record: a retry uses exactly this receipt and transition.
  // A bare ticket argument cannot distinguish a late retry from approval of
  // the next completed stage, so the public command requires --receipt.
  const body = `<!-- igniter:approval ${JSON.stringify({ v: 1, ticket: full.identifier, receipt: receiptId, submission, checkpoint, source, target })} -->\n` +
    `Approved ${source}+complete → ${target}${target === "done" ? "" : "+pending"}; receipt ${receiptId}, checkpoint ${checkpoint}.`;
  const recorded = full.comments.some((comment) => comment.body === body);
  if (recorded && state.status === target && state.progress !== "complete") {
    return { ok: true, text: `already approved ${full.identifier}: receipt ${receiptId}; current ${state.status}+${state.progress ?? "none"}` };
  }
  if (recorded && stageStartedAfterReceipt(full, submission)) {
    throw new ProtocolError("stale approval: a later stage has begun; the old approval cannot rewind or approve it");
  }
  if (!(state.status === source && state.progress === "complete") &&
      !(recorded && state.status === target && state.progress === "complete")) {
    throw new ProtocolError(`approve needs ${source}+complete for receipt ${receiptId}; current ${state.status}+${state.progress ?? "none"}`);
  }
  if (!/^[0-9a-f]{7,64}$/.test(checkpoint)) throw new ProtocolError("approval receipt checkpoint must be a Git hash");
  if (kind === "deliver") {
    const review = latestReceiptOf(full.comments, "review-pass");
    if (!review || review.receipt.checkpoint !== checkpoint) throw new ProtocolError("delivery receipt does not bind the passing review checkpoint");
    const landed = latest.receipt.landed!;
    if (!/^[0-9a-f]{7,64}$/.test(landed)) throw new ProtocolError("delivery receipt landed commit must be a Git hash");
    try {
      await deps.git.run(["merge-base", "--is-ancestor", landed, deps.resolved.config.targetBranch], deps.repoRoot);
    } catch {
      throw new ProtocolError("delivery receipt landed commit is not on the target branch");
    }
  } else {
    if (!(await checkpointInLineage(deps, full.identifier, checkpoint))) {
      throw new ProtocolError("approval receipt checkpoint is not in the ticket branch lineage");
    }
    if (kind === "review-pass") {
      const build = latestReceiptOf(full.comments, "build");
      if (!build || build.receipt.checkpoint !== checkpoint) throw new ProtocolError("passing review does not bind the latest Build checkpoint");
    }
  }
  if (!recorded) {
    try {
      await deps.client.addComment(full.id, body);
    } catch (error) {
      if (!isTransientLinearError(error)) throw error;
      const read = await deps.client.fetchIssue(full.id);
      if (!read?.comments.some((comment) => comment.body === body)) throw error;
    }
  }
  // Re-read after the intent: a failed write or a concurrent external move
  // must not cause an old snapshot to rewind a different stage or receipt.
  const fresh = await deps.client.fetchIssue(full.id) as FullIssue | null;
  if (!fresh || !fresh.comments.some((comment) => comment.body === body)) throw new ProtocolError("approval record readback failed; retry the same receipt");
  const current = approvalState(deps, fresh);
  if (latestValidReceipt(fresh.comments)?.id !== receiptId ||
      !((current.status === source || current.status === target) && current.progress === "complete")) {
    throw new ProtocolError("approval state changed during validation; retry the same receipt after inspecting status");
  }
  await moveStatus(deps, fresh, target, target === "done" ? null : "pending");
  const text = `approved ${full.identifier}: ${source}+complete → ${target}${target === "done" ? "" : "+pending"} (receipt ${receiptId}; checkpoint ${checkpoint})`;
  // Linear's durable record is authoritative even if local logging fails.
  await deps.decisions.record(full.identifier, text).catch(() => {});
  return { ok: true, text };
}
