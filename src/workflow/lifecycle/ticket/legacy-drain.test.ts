// Read-only drain of pre-migration HTML lifecycle records (STA-254): an
// in-progress ticket whose history predates the YAML `igniter_event`
// contract must not lose its begin, approval, or recovery boundary. These
// exercise the drain at the function level actually used by the protocol
// (stageStartedAfterReceipt, parseApprovalEvent, parseIncompleteEvent)
// against realistic legacy comment bodies, no network or fixtures on disk.

import { describe, expect, test } from "bun:test";
import { receiptBlock, stageStartedAfterReceipt, type FullIssue } from "./protocol";
import { parseApprovalEvent, parseIncompleteEvent } from "./event";

function issueWith(comments: { id?: string; body: string }[]): FullIssue {
  return { identifier: "STA-1", comments } as FullIssue;
}

const CHECKPOINT = "90bbd4d5b6479619fd689d1eb78af11742f3bbf3";

describe("begin boundary drains legacy history", () => {
  test("a legacy begin marker after the bound receipt still blocks a stale retry", () => {
    const full = issueWith([
      { body: receiptBlock("build", CHECKPOINT, "build-sub") },
      { body: `<!-- igniter:begin ${JSON.stringify({ v: 1, ticket: "STA-1", stage: "review", after: "build-sub" })} -->\nStage started: review; preceding receipt build-sub.` },
    ]);
    expect(stageStartedAfterReceipt(full, "build-sub")).toBe(true);
    expect(stageStartedAfterReceipt(full, "build-sub", "review")).toBe(true);
    expect(stageStartedAfterReceipt(full, "build-sub", "deliver")).toBe(false);
  });

  test("a legacy begin bound to a later receipt does not establish the boundary", () => {
    const full = issueWith([
      { body: `<!-- igniter:begin ${JSON.stringify({ v: 1, ticket: "STA-1", stage: "review", after: "build-sub" })} -->\nStage started: review; preceding receipt build-sub.` },
      { body: receiptBlock("build", CHECKPOINT, "build-sub") },
    ]);
    expect(stageStartedAfterReceipt(full, "build-sub")).toBe(false);
  });

  test("a YAML begin bound to a later receipt does not establish the boundary", () => {
    const full = issueWith([
      { body: "Stage started: review.\n\n```yaml\nigniter_event:\n  version: 1\n  kind: begin\n  ticket: STA-1\n  stage: review\n  after: build-sub\n```" },
      { body: receiptBlock("build", CHECKPOINT, "build-sub") },
    ]);
    expect(stageStartedAfterReceipt(full, "build-sub")).toBe(false);
  });

  test("a garbled legacy begin marker never authorizes the boundary", () => {
    const full = issueWith([
      { body: receiptBlock("build", CHECKPOINT, "build-sub") },
      { body: `<!-- igniter:begin {not json} -->\nprose` },
    ]);
    expect(stageStartedAfterReceipt(full, "build-sub")).toBe(false);
  });

  test("a begin whose after names a different receipt never establishes the boundary, even later in the thread", () => {
    // The begin comment sits after the build-sub receipt in the thread, but
    // its own `after` field names a different submission — position alone
    // must never substitute for the explicit field.
    const full = issueWith([
      { body: receiptBlock("build", CHECKPOINT, "build-sub") },
      { body: `<!-- igniter:begin ${JSON.stringify({ v: 1, ticket: "STA-1", stage: "review", after: "some-other-sub" })} -->\nStage started: review; preceding receipt some-other-sub.` },
    ]);
    expect(stageStartedAfterReceipt(full, "build-sub")).toBe(false);
  });

  test("a YAML begin whose after names a different receipt never establishes the boundary", () => {
    const full = issueWith([
      { body: receiptBlock("build", CHECKPOINT, "build-sub") },
      { body: `Stage started: review.\n\n\`\`\`yaml\nigniter_event:\n  version: 1\n  kind: begin\n  ticket: STA-1\n  stage: review\n  after: some-other-sub\n\`\`\`` },
    ]);
    expect(stageStartedAfterReceipt(full, "build-sub")).toBe(false);
    expect(stageStartedAfterReceipt(full, "build-sub", "review")).toBe(false);
  });

  test("mixed history: a new YAML begin after a legacy-recorded receipt still establishes the boundary", () => {
    const full = issueWith([
      { body: receiptBlock("review-pass", CHECKPOINT, "pass-sub") },
      { body: `Stage started: deliver; preceding receipt pass-sub.\n\n\`\`\`yaml\nigniter_event:\n  version: 1\n  kind: begin\n  ticket: STA-1\n  stage: deliver\n  after: pass-sub\n\`\`\`` },
    ]);
    expect(stageStartedAfterReceipt(full, "pass-sub", "deliver")).toBe(true);
  });
});

describe("approval identity drains legacy history", () => {
  test("a legacy approval marker is found by submission for retry dedupe", () => {
    const legacy = `<!-- igniter:approval ${JSON.stringify({
      v: 1, ticket: "STA-1", receipt: "receipt-1", submission: "build-sub", checkpoint: CHECKPOINT, source: "build", target: "review",
    })} -->\nApproved build+complete → review+pending; receipt receipt-1, checkpoint ${CHECKPOINT}.`;
    const parsed = parseApprovalEvent(legacy);
    expect(parsed).toEqual({
      ticket: "STA-1", receipt: "receipt-1", submission: "build-sub", checkpoint: CHECKPOINT, source: "build", target: "review",
    });
  });

  test("a malformed legacy approval marker never authorizes a match", () => {
    expect(parseApprovalEvent(`<!-- igniter:approval {broken -->\nprose`)).toBeNull();
  });
});

describe("incomplete-state dedupe drains legacy history", () => {
  test("a legacy marker+fingerprint pair matches the same park identity as a fresh YAML event", () => {
    const legacy =
      `<!-- igniter:incomplete-state -->\n<!-- fingerprint: build|none|no-receipt|park:no-receipt -->\n` +
      `Blocked: STA-1 is Build with no Progress label — no receipt.\n`;
    const parsed = parseIncompleteEvent(legacy);
    expect(parsed).toEqual({ ticket: null, stage: "build", progress: "none", receipt: "no-receipt", decision: "park:no-receipt" });
  });

  test("a legacy marker with no fingerprint comment is not mistaken for a match", () => {
    expect(parseIncompleteEvent(`<!-- igniter:incomplete-state -->\nBlocked: STA-1 is Build.\n`)).toBeNull();
  });
});
