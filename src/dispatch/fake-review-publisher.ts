// Deterministic fake of the host-side review publisher: an in-memory
// ledger of landed publications with programmable faults. Tests prove the
// publication gate's consent, refusal, success, and retry-idempotency
// behavior here with no network, no credentials, and no Diffwalk endpoint.

import {
  REVIEW_PUBLICATION_DESTINATION,
  type ReviewPublication,
  type ReviewPublicationInput,
  type ReviewPublisher,
} from "./review-publication.ts";

function keyOf(input: ReviewPublicationInput): string {
  return `${input.ticket}\n${input.checkpoint}\n${input.capture}`;
}

export class FakeReviewPublisher implements ReviewPublisher {
  readonly destination = REVIEW_PUBLICATION_DESTINATION;
  /** Landed publications in publish order. */
  publications: (ReviewPublicationInput & ReviewPublication)[] = [];
  /** Every publish call, including faults and reused readbacks. */
  publishCalls: ReviewPublicationInput[] = [];
  /** Fail the next N publish calls before recording anything. */
  failNext = 0;
  failMessage = "fake publisher exploded";
  /**
   * Record the publication, then throw a transient error: the upload
   * landed but the response was lost, so the retry must read back and
   * reuse instead of publishing again.
   */
  loseNextResponses = 0;

  async published(input: ReviewPublicationInput): Promise<ReviewPublication | null> {
    const landed = this.publications.find(
      (p) => p.ticket === input.ticket && p.checkpoint === input.checkpoint && p.capture === input.capture,
    );
    return landed ? { url: landed.url, publicationId: landed.publicationId } : null;
  }

  async publish(input: ReviewPublicationInput): Promise<ReviewPublication> {
    this.publishCalls.push({ ...input });
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error(this.failMessage);
    }
    const landed = await this.published(input);
    if (landed) return landed;
    const publication = {
      url: `https://review.diffwalk.dev/r/${input.ticket.toLowerCase()}-${this.publications.length + 1}`,
      publicationId: `fake-publication-${this.publications.length + 1}`,
    };
    this.publications.push({ ...input, ...publication });
    if (this.loseNextResponses > 0) {
      this.loseNextResponses -= 1;
      throw new Error(this.failMessage);
    }
    return publication;
  }

  keyOf(input: ReviewPublicationInput): string {
    return keyOf(input);
  }
}
