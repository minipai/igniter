// Shared prompt-delivery confirmation (STA-224).
//
// Herdr `agent.prompt` answering `agent_prompted` only proves the text
// reached Herdr, not that the agent consumed it: STA-197 and STA-222 both
// saw the prompt sit in the interactive input box while Igniter declared
// the start a success and the target agent stayed idle with context 0.
//
// Nothing here declares success on `agent_prompted` alone. The caller sends
// one work order through `confirmPromptDelivery`, which reads the agent's
// lifecycle back and only resolves once the prompt was observably consumed:
// the agent status, session, agent revision, or pane revision moved past
// the pre-send baseline. A prompt that leaves every signal untouched is
// `stalled` (text in the input box, lifecycle unchanged), never success.
//
// The same entry covers every stage worker start:
// the delivery identity binds project, ticket (when there is one), role,
// stage, agent, baseline pane revision, and the work order hash, so a retry
// resends the identical work order to the same agent and never builds a
// second agent, pane, or run. When a send throws but the read-back already
// shows a lifecycle change, the delivery converges without resending.

import { createHash } from "node:crypto";
import type { CommandWorkspaces } from "../../service/workspace/workspaces.ts";

/** Who the prompt is for: one of the three stage workers. */
export type PromptRole = "builder" | "acceptance" | "deliverer";

/** Which stage the prompt belongs to. */
export type PromptStage = "build" | "acceptance" | "deliver";

/**
 * Delivery identity: everything a retry must keep identical. `ticket` is
 * null only for prompts that belong to no ticket; `workOrder` is the
 * `workOrderHash` of the exact text being delivered.
 */
export interface PromptDeliveryIdentity {
  project: string;
  ticket: string | null;
  role: PromptRole;
  stage: PromptStage;
  agent: string;
  workOrder: string;
}

export interface PromptDeliveryPolicy {
  /** Prompt sends before giving up. Default 3. */
  maxAttempts?: number;
  /** Lifecycle read-backs per send. Default 10. */
  pollAttempts?: number;
  /** Pause between read-backs. Default 400ms. */
  pollIntervalMs?: number;
  /** Injectable clock; defaults to Bun.sleep. Tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

/** The lifecycle signals behind one agent at one moment. */
export interface PromptLifecycle {
  status: string;
  session: string | null;
  revision: number | null;
  paneRevision: number | null;
}

/** Proof a prompt was consumed: what moved past the pre-send baseline. */
export interface PromptDelivered {
  /** Canonical delivery key; stable across retries of the same delivery. */
  key: string;
  /** Prompt sends performed (1 when the first send consumed). */
  attempts: number;
  /** Lifecycle read-backs performed, baseline included. */
  reads: number;
  /** The lifecycle that proved consumption. */
  observed: PromptLifecycle;
  /** True when the send threw but the read-back already showed the change. */
  lostResponse: boolean;
}

export type PromptDeliveryReason =
  /** Sent, but status/session/revision never moved: text in the input box. */
  | "stalled"
  /** The send threw and the read-back shows no lifecycle change either. */
  | "prompt-send-failed"
  /** Herdr could not be read, so no baseline exists to converge on. */
  | "herdr-unreachable"
  /** No live agent under the delivery name; the caller rebuilds, never this. */
  | "no-agent";

/** A delivery that never proved consumption. The message is the diagnosis:
 *  project, ticket, role, stage, agent, pane revision, and reason. */
export class PromptDeliveryError extends Error {
  readonly key: string;
  readonly identity: PromptDeliveryIdentity;
  readonly reason: PromptDeliveryReason;
  readonly attempts: number;
  readonly baseline: PromptLifecycle | null;

  constructor(input: {
    key: string;
    identity: PromptDeliveryIdentity;
    reason: PromptDeliveryReason;
    attempts: number;
    baseline: PromptLifecycle | null;
  }) {
    super(formatPromptDiagnosis(input));
    this.name = "PromptDeliveryError";
    this.key = input.key;
    this.identity = input.identity;
    this.reason = input.reason;
    this.attempts = input.attempts;
    this.baseline = input.baseline;
  }
}

/** Identity of one work order text: retries resend byte-identical text. */
export function workOrderHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Canonical delivery key: project, ticket, role, stage, agent, baseline
 * pane revision, and work order hash. One key means one run of one work
 * order; a retry reuses it instead of starting a second run.
 */
export function deliveryKey(identity: PromptDeliveryIdentity, paneRevision: number | null): string {
  return [
    identity.project,
    identity.ticket ?? "no-ticket",
    identity.role,
    identity.stage,
    identity.agent,
    paneRevision ?? "norev",
    identity.workOrder,
  ].join("|");
}

function formatPromptDiagnosis(input: {
  key: string;
  identity: PromptDeliveryIdentity;
  reason: PromptDeliveryReason;
  attempts: number;
  baseline: PromptLifecycle | null;
}): string {
  const { identity, baseline } = input;
  const ticket = identity.ticket ?? "no-ticket";
  const revision = baseline
    ? `agent=${baseline.status} session=${baseline.session ?? "absent"} revision=${baseline.revision ?? "none"} pane=${baseline.paneRevision ?? "none"}`
    : "agent lifecycle unreadable";
  return (
    `prompt delivery ${input.reason} after ${input.attempts} send(s) ` +
    `(project=${identity.project} ticket=${ticket} role=${identity.role} stage=${identity.stage} ` +
    `agent=${identity.agent} baseline ${revision} work-order=${identity.workOrder} key=${input.key})`
  );
}

const MAX_ATTEMPTS = 3;
const POLL_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 400;

function sleepDefault(ms: number): Promise<void> {
  return Bun.sleep(ms);
}

/** True once any lifecycle signal moved past the pre-send baseline. Any
 *  movement counts, including a signal that raced the baseline read: the
 *  fail-safe direction is to credit activity rather than stall a live
 *  agent. Delivery is lifecycle evidence, not proof of exact causality. */
export function promptConsumed(baseline: PromptLifecycle, current: PromptLifecycle): boolean {
  return (
    current.status !== baseline.status ||
    current.session !== baseline.session ||
    current.revision !== baseline.revision ||
    current.paneRevision !== baseline.paneRevision
  );
}

interface AgentReadback {
  found: boolean;
  lifecycle: PromptLifecycle;
}

/** One lifecycle read-back: the agent row plus its pane revision. A pane
 *  that cannot be read contributes null instead of failing the delivery. */
async function readAgent(workspaces: CommandWorkspaces, agent: string): Promise<AgentReadback> {
  const snapshot = await workspaces.snapshot();
  const row = snapshot.agents.find((a) => a.name === agent);
  if (!row) {
    return {
      found: false,
      lifecycle: { status: "missing", session: null, revision: null, paneRevision: null },
    };
  }
  let paneRevision: number | null = null;
  try {
    paneRevision = (await workspaces.readPane(row.paneId, 20)).revision;
  } catch {
    paneRevision = null;
  }
  return {
    found: true,
    lifecycle: { status: row.agentStatus, session: row.session, revision: row.revision, paneRevision },
  };
}

/**
 * Deliver one prompt and prove the agent consumed it. Resolves with the
 * observed lifecycle change; throws PromptDeliveryError (message carries
 * the full diagnosis) when the prompt stalls, the send fails without a
 * converging read-back, Herdr cannot be read, or the agent is gone.
 *
 * This never creates an agent, pane, or workspace: the caller starts the
 * agent first, and retries resend the identical text to the same agent.
 */
export async function confirmPromptDelivery(
  workspaces: CommandWorkspaces,
  identity: PromptDeliveryIdentity,
  text: string,
  policy: PromptDeliveryPolicy = {},
): Promise<PromptDelivered> {
  const maxAttempts = policy.maxAttempts ?? MAX_ATTEMPTS;
  const pollAttempts = policy.pollAttempts ?? POLL_ATTEMPTS;
  const pollIntervalMs = policy.pollIntervalMs ?? POLL_INTERVAL_MS;
  const sleep = policy.sleep ?? sleepDefault;

  let baseline: PromptLifecycle;
  let key: string;
  let reads = 0;
  try {
    const read = await readAgent(workspaces, identity.agent);
    reads += 1;
    if (!read.found) {
      throw new PromptDeliveryError({
        key: deliveryKey(identity, null),
        identity,
        reason: "no-agent",
        attempts: 0,
        baseline: null,
      });
    }
    baseline = read.lifecycle;
    key = deliveryKey(identity, baseline.paneRevision ?? baseline.revision);
  } catch (error) {
    if (error instanceof PromptDeliveryError) throw error;
    throw new PromptDeliveryError({
      key: deliveryKey(identity, null),
      identity,
      reason: "herdr-unreachable",
      attempts: 0,
      baseline: null,
    });
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // A retry first re-reads: a lifecycle change observed since the
    // baseline (e.g. a lost response that did land) converges here
    // without sending the prompt a second time.
    if (attempt > 1) {
      try {
        const reread = await readAgent(workspaces, identity.agent);
        reads += 1;
        if (reread.found && promptConsumed(baseline, reread.lifecycle)) {
          return { key, attempts: attempt - 1, reads, observed: reread.lifecycle, lostResponse: true };
        }
      } catch {
        // The pre-resend read is best effort; the resend below retries.
      }
    }
    let sendError: unknown = null;
    try {
      await workspaces.prompt(identity.agent, text);
    } catch (error) {
      sendError = error;
    }
    if (sendError !== null) {
      // The send may have run server-side while the response was lost:
      // read back before counting this as a failure. A vanished agent is
      // no-agent, never a stall: the caller rebuilds instead of resending
      // into a pane nobody owns.
      let reread: AgentReadback | null = null;
      try {
        reread = await readAgent(workspaces, identity.agent);
        reads += 1;
      } catch {
        // Unreadable here counts as unconverged, like an unchanged read.
      }
      if (reread && !reread.found) {
        throw new PromptDeliveryError({ key, identity, reason: "no-agent", attempts: attempt, baseline });
      }
      if (reread && promptConsumed(baseline, reread.lifecycle)) {
        return { key, attempts: attempt, reads, observed: reread.lifecycle, lostResponse: true };
      }
      if (attempt >= maxAttempts) {
        throw new PromptDeliveryError({
          key,
          identity,
          reason: "prompt-send-failed",
          attempts: attempt,
          baseline,
        });
      }
      await sleep(pollIntervalMs);
      continue;
    }
    for (let poll = 0; poll < pollAttempts; poll += 1) {
      let reread: AgentReadback;
      try {
        reread = await readAgent(workspaces, identity.agent);
      } catch {
        throw new PromptDeliveryError({
          key,
          identity,
          reason: "herdr-unreachable",
          attempts: attempt,
          baseline,
        });
      }
      reads += 1;
      if (!reread.found) {
        throw new PromptDeliveryError({ key, identity, reason: "no-agent", attempts: attempt, baseline });
      }
      if (promptConsumed(baseline, reread.lifecycle)) {
        return { key, attempts: attempt, reads, observed: reread.lifecycle, lostResponse: false };
      }
      if (poll + 1 < pollAttempts) await sleep(pollIntervalMs);
    }
    if (attempt >= maxAttempts) {
      throw new PromptDeliveryError({
        key,
        identity,
        reason: "stalled",
        attempts: attempt,
        baseline,
      });
    }
    await sleep(pollIntervalMs);
  }
  throw new PromptDeliveryError({ key, identity, reason: "stalled", attempts: maxAttempts, baseline });
}
