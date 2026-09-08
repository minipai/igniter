// Review publication: one owner grant per ticket lifecycle, host-side publish.
//
// Stage workers never publish: they produce a local Diffwalk capture, author
// explanations, run `diffwalk check`, and record the artifact identity
// (capture id plus check result) in their result. The command service —
// running on the host with the owner's one-time `--publish-review` consent —
// verifies the artifact and publishes it to the fixed review destination,
// then records the review URL in the Build receipt.
//
// Consent carries four scopes and all four must match at submit time:
// - ticket: the Linear identifier the owner named on `start`
// - repository: the repo root the service runs in (never repository config)
// - destination: always REVIEW_PUBLICATION_DESTINATION
// - lifecycle: a grant epoch stamped into the ticket workspace by `begin`;
//   a recreated workspace or a newer grant invalidates the old stamp.
//
// Publication retries are idempotent: an unknown outcome reads back the
// Linear receipt and the publisher ledger first, so the same ticket plus
// checkpoint plus capture never creates a second review or receipt.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { findReceipt } from "./protocol.ts";
import { ProtocolError } from "./protocol.ts";
import { ticketWorktree } from "./worktrees.ts";

/** The only review destination Igniter ever publishes to. */
export const REVIEW_PUBLICATION_DESTINATION = "review.diffwalk.dev";

/** Service origin behind the fixed destination. */
export const REVIEW_PUBLICATION_SERVICE_URL = "https://review.diffwalk.dev";

/** Workspace metadata keys carrying the publication lifecycle stamp. */
export const PUBLISH_LIFECYCLE_TOKEN = "publish_lifecycle";
export const PUBLISH_DESTINATION_TOKEN = "publish_destination";

export interface PublicationConsent {
  ticket: string;
  repository: string;
  destination: string;
  lifecycle: string;
  grantedAt: string;
}

export interface PublicationConsentStore {
  grant(consent: PublicationConsent): void;
  consentFor(ticket: string, repository: string): PublicationConsent | null;
}

function consentKey(ticket: string, repository: string): string {
  return `${ticket.toUpperCase()}\n${repository.replace(/\/+$/, "")}`;
}

/** In-memory consent ledger owned by the serve process. */
export class MemoryPublicationConsents implements PublicationConsentStore {
  private readonly consents = new Map<string, PublicationConsent>();

  grant(consent: PublicationConsent): void {
    this.consents.set(consentKey(consent.ticket, consent.repository), { ...consent });
  }

  consentFor(ticket: string, repository: string): PublicationConsent | null {
    return this.consents.get(consentKey(ticket, repository)) ?? null;
  }
}

/** Grant order within this process: a later grant always wins a new lifecycle. */
let grantSequence = 0;

/**
 * Record the owner's one-time publication grant for a ticket lifecycle.
 * The lifecycle binds this exact grant event: a later grant replaces it,
 * and `begin` stamps it into the ticket workspace for submit to verify.
 */
export function grantPublicationConsent(
  store: PublicationConsentStore,
  input: { ticket: string; repository: string; now?: () => number },
): PublicationConsent {
  const ticket = input.ticket.toUpperCase();
  const grantedAt = new Date((input.now ?? Date.now)()).toISOString();
  grantSequence += 1;
  const lifecycle = createHash("sha256")
    .update(`${ticket}\n${input.repository}\n${grantedAt}\n${grantSequence}`)
    .digest("hex")
    .slice(0, 16);
  const consent: PublicationConsent = {
    ticket,
    repository: input.repository,
    destination: REVIEW_PUBLICATION_DESTINATION,
    lifecycle,
    grantedAt,
  };
  store.grant(consent);
  return consent;
}

/** Workspace metadata stamp `begin` writes so submit can verify the lifecycle. */
export function stampPublicationTokens(consent: PublicationConsent): Record<string, string> {
  return {
    [PUBLISH_LIFECYCLE_TOKEN]: consent.lifecycle,
    [PUBLISH_DESTINATION_TOKEN]: consent.destination,
  };
}

export interface ReviewPublicationInput {
  ticket: string;
  checkpoint: string;
  capture: string;
}

export interface ReviewPublication {
  url: string;
  publicationId: string;
}

export interface ReviewPublisher {
  readonly destination: string;
  /** Read back a publication that already landed (retry first, publish second). */
  published(input: ReviewPublicationInput): Promise<ReviewPublication | null>;
  /** Idempotent publish: a landed publication for the same input is reused. */
  publish(input: ReviewPublicationInput): Promise<ReviewPublication>;
}

function publicationKey(input: ReviewPublicationInput): string {
  return `${input.ticket}\n${input.checkpoint}\n${input.capture}`;
}

/**
 * Capture id of the worktree's current Diffwalk walk, or null when no
 * walk is selected or readable. Reads only the machine-owned files the
 * worker's `diffwalk inspect` wrote; never executes anything.
 */
export async function readCurrentCaptureId(worktreePath: string): Promise<string | null> {
  try {
    const current = (await Bun.file(join(worktreePath, ".diffwalk", "current")).text()).trim().split("\n")[0]?.trim();
    if (!current) return null;
    if (current.startsWith("-") || current.includes("..")) return null;
    const capture = await Bun.file(join(worktreePath, ".diffwalk", current, "capture.json")).json();
    const id = (capture as { captureId?: unknown }).captureId;
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}

/**
 * Extract the review link from `diffwalk publish` output. Only a link on
 * the fixed destination counts: anything else (a shimmed binary, a
 * drifted service flag) refuses instead of landing in a receipt.
 */
export function reviewLinkOfPublishOutput(stdout: string): string {
  const url = stdout.match(/https?:\/\/\S+/)?.[0]?.replace(/[),."']+$/, "");
  if (!url || !url.startsWith(`${REVIEW_PUBLICATION_SERVICE_URL}/`)) {
    throw new Error(
      `diffwalk publish printed an unexpected link (expected ${REVIEW_PUBLICATION_SERVICE_URL}/...): ${stdout.trim().slice(0, 200)}`,
    );
  }
  return url;
}

interface LedgerEntry extends ReviewPublication, ReviewPublicationInput {}

/**
 * Host-side publisher that shells out to the installed `diffwalk` CLI in
 * the ticket worktree. No account or publish credential is required; only
 * the host runs this — workers never see it.
 *
 * Before uploading, the publisher verifies the worktree's current walk
 * still carries the submitted capture id, so a rotated walk cannot swap
 * the artifact under a verified submit. The ledger persists under the
 * repo-local runtime dir, so a retry after a restart reuses the landed
 * publication instead of uploading a second review.
 */
export class DiffwalkReviewPublisher implements ReviewPublisher {
  readonly destination = REVIEW_PUBLICATION_DESTINATION;
  private readonly ledger = new Map<string, LedgerEntry>();
  private loadedFrom: string | null = null;

  constructor(
    private readonly repoRoot: string,
    private readonly ledgerPath?: string,
    private readonly diffwalkBin: string = "diffwalk",
  ) {}

  private ledgerFile(): string {
    return this.ledgerPath ?? join(this.repoRoot, ".igniter", "runtime", "review-publications.json");
  }

  private async ensureLoaded(): Promise<void> {
    const file = this.ledgerFile();
    if (this.loadedFrom === file) return;
    this.loadedFrom = file;
    try {
      const raw: unknown = await Bun.file(file).json();
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (
            typeof entry === "object" && entry !== null &&
            typeof (entry as LedgerEntry).url === "string" &&
            typeof (entry as LedgerEntry).publicationId === "string" &&
            typeof (entry as LedgerEntry).ticket === "string" &&
            typeof (entry as LedgerEntry).checkpoint === "string" &&
            typeof (entry as LedgerEntry).capture === "string"
          ) {
            const full = entry as LedgerEntry;
            this.ledger.set(publicationKey(full), full);
          }
        }
      }
    } catch {
      // Missing or corrupt starts empty; the next publish recreates it.
    }
  }

  private async persist(): Promise<void> {
    await Bun.write(this.ledgerFile(), `${JSON.stringify([...this.ledger.values()], null, 2)}\n`);
  }

  async published(input: ReviewPublicationInput): Promise<ReviewPublication | null> {
    await this.ensureLoaded();
    const landed = this.ledger.get(publicationKey(input));
    return landed ? { url: landed.url, publicationId: landed.publicationId } : null;
  }

  async publish(input: ReviewPublicationInput): Promise<ReviewPublication> {
    await this.ensureLoaded();
    const landed = this.ledger.get(publicationKey(input));
    if (landed) return { url: landed.url, publicationId: landed.publicationId };
    const worktree = ticketWorktree(this.repoRoot, input.ticket);
    const current = await readCurrentCaptureId(worktree.path);
    if (current !== input.capture) {
      throw new Error(
        `diffwalk current walk carries capture ${current ?? "none"} but the submit names ${input.capture}; ` +
          `re-run \`diffwalk inspect\` and \`diffwalk check\` on the submitted checkpoint, then resubmit`,
      );
    }
    const proc = Bun.spawn(
      [this.diffwalkBin, "publish", "--service", REVIEW_PUBLICATION_SERVICE_URL],
      { cwd: worktree.path, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new Error(`diffwalk publish exited with ${code}: ${stderr.trim().slice(0, 300) || stdout.trim().slice(0, 300)}`);
    }
    const publication = { url: reviewLinkOfPublishOutput(stdout), publicationId: `diffwalk-${this.ledger.size + 1}` };
    this.ledger.set(publicationKey(input), { ...input, ...publication });
    await this.persist();
    return publication;
  }
}

export interface BuildPublicationRequest extends ReviewPublicationInput {
  /** Destination the submitted artifact claims; must equal the fixed one. */
  destination: string;
  /** Worktree HEAD the service read; the checkpoint must equal it. */
  head: string;
  /** Current ticket workspace tokens carrying the lifecycle stamp. */
  workspaceTokens: Record<string, string>;
  /** Fresh Linear comments for receipt readback before publishing. */
  comments: { id?: string; body: string }[];
  /** Submission identity of the build receipt being published with. */
  submission: string;
}

/** Structural gate the protocol calls; created per command from service state. */
export interface BuildPublicationGate {
  publish(request: BuildPublicationRequest): Promise<{ url: string; reused: boolean }>;
}

/** Extract the published review URL from a build receipt body. */
export function reviewUrlOfReceipt(body: string): string | null {
  const match = body.match(/^Review: (\S+)\s*$/m);
  return match?.[1] ?? null;
}

/**
 * Publish one verified Diffwalk review for a build submit, or reuse the one
 * that already landed. Refusals name the scope that drifted and the exact
 * owner command that restores it; nothing is published and no receipt is
 * created on any refusal.
 */
export function createBuildPublicationGate(input: {
  consents: PublicationConsentStore;
  publisher: ReviewPublisher;
  repoRoot: string;
}): BuildPublicationGate {
  return {
    publish: async (request: BuildPublicationRequest) => {
      if (input.publisher.destination !== REVIEW_PUBLICATION_DESTINATION) {
        throw new ProtocolError(
          `refused: review publisher targets ${JSON.stringify(input.publisher.destination)} ` +
            `but the fixed destination is ${REVIEW_PUBLICATION_DESTINATION}; ` +
            `publication is miswired on the host — inspect the dispatch service, nothing was published`,
        );
      }
      const consent = input.consents.consentFor(request.ticket, input.repoRoot);
      if (!consent) {
        throw new ProtocolError(
          `refused: ${request.ticket} has no review publication consent; ` +
            `the owner grants it once with \`igniter start ${request.ticket} --publish-review\`. ` +
            `The build is checked locally but no review was published and no receipt was recorded`,
        );
      }
      if (request.destination !== REVIEW_PUBLICATION_DESTINATION) {
        throw new ProtocolError(
          `refused: review destination drift for ${request.ticket} (got ${JSON.stringify(request.destination)}, ` +
            `fixed destination is ${REVIEW_PUBLICATION_DESTINATION}); ` +
            `the worker must capture for the fixed destination — inspect the artifact and resubmit`,
        );
      }
      if (
        request.workspaceTokens[PUBLISH_LIFECYCLE_TOKEN] !== consent.lifecycle ||
        request.workspaceTokens[PUBLISH_DESTINATION_TOKEN] !== REVIEW_PUBLICATION_DESTINATION
      ) {
        throw new ProtocolError(
          `refused: publication lifecycle changed for ${request.ticket}; ` +
            `run \`igniter start ${request.ticket} --publish-review\` then \`igniter begin ${request.ticket}\` ` +
            `to stamp the current lifecycle before submitting`,
        );
      }
      if (request.checkpoint !== request.head) {
        throw new ProtocolError(
          `refused: submit names checkpoint ${request.checkpoint} but the worktree HEAD is ${request.head}; ` +
            `a new checkpoint needs a new checked capture first`,
        );
      }
      // Receipt readback first: a lost response after the receipt landed
      // reuses the published URL without touching the publisher. A receipt
      // line pointing off-destination is never trusted: fall through and
      // republish the verified artifact instead.
      const receipt = findReceipt(request.comments, "build", request.submission);
      if (receipt) {
        const url = reviewUrlOfReceipt(receipt.body);
        if (url && url.startsWith(`${REVIEW_PUBLICATION_SERVICE_URL}/`)) {
          return { url, reused: true };
        }
      }
      const landed = await input.publisher.published({
        ticket: request.ticket,
        checkpoint: request.checkpoint,
        capture: request.capture,
      });
      if (landed) return { url: landed.url, reused: true };
      let publication: ReviewPublication;
      try {
        publication = await input.publisher.publish({
          ticket: request.ticket,
          checkpoint: request.checkpoint,
          capture: request.capture,
        });
      } catch (error) {
        // Unknown outcome: the upload may have landed before the error.
        // Read back before failing so the retry reuses instead of duplicating.
        const reread = await input.publisher.published({
          ticket: request.ticket,
          checkpoint: request.checkpoint,
          capture: request.capture,
        });
        if (reread) return { url: reread.url, reused: true };
        throw new ProtocolError(
          `publish failed for ${request.ticket}: ${(error as Error).message}; ` +
            `retry the identical submit — the retry reuses the publication when one landed`,
        );
      }
      return { url: publication.url, reused: false };
    },
  };
}
