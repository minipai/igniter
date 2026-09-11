// Versioned YAML `igniter_event` blocks: shared codec strictness, every
// writer/parser pair's round-trip, cross-kind isolation, legacy HTML
// read-only drain, and malformed-input rejection (STA-254).

import { describe, expect, test } from "bun:test";
import {
  approvalEventBody,
  beginEventBody,
  blockedEventBody,
  canceledEventBody,
  cancelIdentity,
  failedEventBody,
  hasBlockedEvent,
  hasCanceledEvent,
  hasFailedEvent,
  incompleteEventBody,
  parseApprovalEvent,
  parseBeginEvent,
  parseBlockedEvent,
  parseCanceledEvent,
  parseFailedEvent,
  parseIncompleteEvent,
  textFingerprint,
} from "./event";
import { parseReceiptBlock, receiptBlock } from "./protocol";
import { RecordParseError } from "./record";

const TICKET = "STA-249";
const CHECKPOINT = "90bbd4d5b6479619fd689d1eb78af11742f3bbf3";
const SUBMISSION = "7c8b1be2d3fe8437";

describe("event record strictness", () => {
  test("rejects an unknown version", () => {
    const body = "```yaml\nigniter_event:\n  version: 2\n  kind: begin\n  ticket: STA-1\n  stage: build\n  after: null\n```";
    expect(() => parseBeginEvent(body)).toThrow(/unknown event version/);
  });

  test("rejects an unknown kind", () => {
    const body = "```yaml\nigniter_event:\n  version: 1\n  kind: mystery\n  ticket: STA-1\n```";
    expect(() => parseBeginEvent(body)).toThrow(/unknown event kind/);
  });

  test("rejects an unknown field for the kind", () => {
    const body = "```yaml\nigniter_event:\n  version: 1\n  kind: begin\n  ticket: STA-1\n  stage: build\n  after: null\n  extra: nope\n```";
    expect(() => parseBeginEvent(body)).toThrow(/unknown begin event field "extra"/);
  });

  test("rejects a missing required field", () => {
    const body = "```yaml\nigniter_event:\n  version: 1\n  kind: begin\n  ticket: STA-1\n  stage: build\n```";
    expect(() => parseBeginEvent(body)).toThrow(/misses required field "after"/);
  });

  test("rejects a comment mixing an igniter_event block with an igniter_receipt block", () => {
    const mixed =
      `Stage started: build.\n\n${beginEventBody(TICKET, "build", null)}\n\n` +
      `Receipt landed.\n\n${receiptBlock("build", CHECKPOINT, SUBMISSION)}`;
    expect(() => parseBeginEvent(mixed)).toThrow(/holds both an igniter_event and an igniter_receipt block/);
    expect(() => parseReceiptBlock(mixed)).toThrow(/holds both an igniter_receipt and an igniter_event block/);
  });

  test("a lone igniter_receipt block still parses fine through the receipt parser with no event present", () => {
    const body = receiptBlock("build", CHECKPOINT, SUBMISSION);
    expect(parseBeginEvent(body)).toBeNull();
    expect(parseReceiptBlock(body)).not.toBeNull();
  });

  test("writers reject whitespace, empty, and undefined scalar identities", () => {
    for (const ticket of ["STA 1", "", undefined] as unknown as string[]) {
      expect(() => beginEventBody(ticket, "build", null)).toThrow(/whitespace-free scalar token/);
    }
  });

  test("kind-specific parsers return null for a different valid kind", () => {
    const approval = approvalEventBody(TICKET, "receipt-1", SUBMISSION, CHECKPOINT, "build", "review");
    expect(parseBeginEvent(approval)).toBeNull();
    expect(parseBlockedEvent(approval)).toBeNull();
    expect(parseFailedEvent(approval)).toBeNull();
    expect(parseIncompleteEvent(approval)).toBeNull();
  });

  test("throws the shared parse error type", () => {
    expect(() => parseBeginEvent(beginEventBody(TICKET, "build", null).replace("version: 1", "version: 2")))
      .toThrow(RecordParseError);
  });
});

describe("begin event", () => {
  test("beginEventBody round-trips through parseBeginEvent", () => {
    const body = beginEventBody(TICKET, "build", null);
    expect(parseBeginEvent(body)).toEqual({ ticket: TICKET, stage: "build", after: null });
  });

  test("preserves a non-null preceding receipt submission", () => {
    const body = beginEventBody(TICKET, "review", SUBMISSION);
    expect(parseBeginEvent(body)).toEqual({ ticket: TICKET, stage: "review", after: SUBMISSION });
  });

  test("returns null for a body with no event block", () => {
    expect(parseBeginEvent("Stage started: build.")).toBeNull();
  });

  test("rejects a stage outside build/review/deliver", () => {
    const body = "```yaml\nigniter_event:\n  version: 1\n  kind: begin\n  ticket: STA-1\n  stage: backlog\n  after: null\n```";
    expect(() => parseBeginEvent(body)).toThrow(/stage.*build, review, deliver/);
  });

  test("reads the legacy HTML begin marker read-only", () => {
    const legacy = `<!-- igniter:begin ${JSON.stringify({ v: 1, ticket: TICKET, stage: "review", after: SUBMISSION })} -->\nStage started: review; preceding receipt ${SUBMISSION}.`;
    expect(parseBeginEvent(legacy)).toEqual({ ticket: TICKET, stage: "review", after: SUBMISSION });
  });

  test("reads a legacy begin marker with a null preceding receipt", () => {
    const legacy = `<!-- igniter:begin ${JSON.stringify({ v: 1, ticket: TICKET, stage: "build", after: null })} -->\nStage started: build; preceding receipt none.`;
    expect(parseBeginEvent(legacy)).toEqual({ ticket: TICKET, stage: "build", after: null });
  });

  test("ignores a legacy begin marker with an unknown stage", () => {
    const legacy = `<!-- igniter:begin ${JSON.stringify({ v: 1, ticket: TICKET, stage: "backlog", after: null })} -->\nprose`;
    expect(parseBeginEvent(legacy)).toBeNull();
  });

  test("ignores unparseable legacy JSON instead of throwing", () => {
    expect(parseBeginEvent("<!-- igniter:begin {not json} -->\nprose")).toBeNull();
  });

  test("ignores a legacy begin marker embedded after comment prose", () => {
    const marker = `<!-- igniter:begin ${JSON.stringify({ v: 1, ticket: TICKET, stage: "review", after: SUBMISSION })} -->`;
    expect(parseBeginEvent(`quoted evidence\n${marker}\nprose`)).toBeNull();
  });
});

describe("approval event", () => {
  test("approvalEventBody round-trips through parseApprovalEvent", () => {
    const body = approvalEventBody(TICKET, "receipt-1", SUBMISSION, CHECKPOINT, "build", "review");
    expect(parseApprovalEvent(body)).toEqual({
      ticket: TICKET,
      receipt: "receipt-1",
      submission: SUBMISSION,
      checkpoint: CHECKPOINT,
      source: "build",
      target: "review",
    });
  });

  test("rejects an invalid source/target pair", () => {
    const body = "```yaml\nigniter_event:\n  version: 1\n  kind: approval\n  ticket: STA-1\n  receipt: r1\n  submission: s1\n  checkpoint: abc123\n  source: nope\n  target: review\n```";
    expect(() => parseApprovalEvent(body)).toThrow(/source.*build, review, deliver/);
  });

  test("reads the legacy HTML approval marker read-only", () => {
    const legacy =
      `<!-- igniter:approval ${JSON.stringify({ v: 1, ticket: TICKET, receipt: "receipt-1", submission: SUBMISSION, checkpoint: CHECKPOINT, source: "review", target: "deliver" })} -->\n` +
      `Approved review+complete → deliver+pending; receipt receipt-1, checkpoint ${CHECKPOINT}.`;
    expect(parseApprovalEvent(legacy)).toEqual({
      ticket: TICKET,
      receipt: "receipt-1",
      submission: SUBMISSION,
      checkpoint: CHECKPOINT,
      source: "review",
      target: "deliver",
    });
  });

  test("ignores a legacy approval marker with an invalid target", () => {
    const legacy = `<!-- igniter:approval ${JSON.stringify({ v: 1, ticket: TICKET, receipt: "r1", submission: SUBMISSION, checkpoint: CHECKPOINT, source: "build", target: "backlog" })} -->\nprose`;
    expect(parseApprovalEvent(legacy)).toBeNull();
  });

  test("returns null for a body with no event block", () => {
    expect(parseApprovalEvent("plain prose")).toBeNull();
  });

  test("ignores a legacy approval marker embedded after comment prose", () => {
    const marker = `<!-- igniter:approval ${JSON.stringify({
      v: 1, ticket: TICKET, receipt: "receipt-1", submission: SUBMISSION, checkpoint: CHECKPOINT,
      source: "build", target: "review",
    })} -->`;
    expect(parseApprovalEvent(`quoted evidence\n${marker}\nprose`)).toBeNull();
  });
});

describe("blocked event", () => {
  test("blockedEventBody round-trips through parseBlockedEvent", () => {
    const reason = "flaky CI needs a human";
    const body = blockedEventBody(TICKET, "build", reason);
    expect(parseBlockedEvent(body)).toEqual({ ticket: TICKET, stage: "build", reason: textFingerprint(reason) });
  });

  test("keeps the reason prose out of the YAML block, in the prose above it", () => {
    const reason = "flaky CI needs a human";
    const body = `Blocked: ${reason}\n\n${blockedEventBody(TICKET, "review", reason)}`;
    expect(body).toContain(reason);
    expect(body.split("```yaml")[1]).not.toContain(reason);
    expect(parseBlockedEvent(body)).toEqual({ ticket: TICKET, stage: "review", reason: textFingerprint(reason) });
  });

  test("hasBlockedEvent matches same ticket/stage/reason and rejects a different reason", () => {
    const reason = "flaky CI needs a human";
    const body = blockedEventBody(TICKET, "build", reason);
    expect(hasBlockedEvent([{ body }], TICKET, "build", reason)).toBe(true);
    expect(hasBlockedEvent([{ body }], TICKET, "review", reason)).toBe(false);
    expect(hasBlockedEvent([{ body }], TICKET, "build", "a different reason")).toBe(false);
  });

  test("does not recognize the legacy bare HTML marker (no prior state depended on it)", () => {
    expect(parseBlockedEvent("<!-- igniter:blocked -->\nBlocked: some reason\n")).toBeNull();
  });
});

describe("failed event", () => {
  test("failedEventBody round-trips through parseFailedEvent", () => {
    const reason = "worker wedged";
    const body = failedEventBody(TICKET, reason);
    expect(parseFailedEvent(body)).toEqual({ ticket: TICKET, reason: textFingerprint(reason) });
  });

  test("hasFailedEvent matches same ticket/reason and rejects a different reason", () => {
    const reason = "worker wedged";
    const body = failedEventBody(TICKET, reason);
    expect(hasFailedEvent([{ body }], TICKET, reason)).toBe(true);
    expect(hasFailedEvent([{ body }], TICKET, "a different reason")).toBe(false);
  });

  test("does not recognize the legacy bare HTML marker", () => {
    expect(parseFailedEvent("<!-- igniter:failed -->\nsome reason\n")).toBeNull();
  });
});

describe("canceled event", () => {
  test("canceledEventBody round-trips through parseCanceledEvent", () => {
    const identity = cancelIdentity(TICKET, "owner ended the scope", "build", "in_progress");
    const body = canceledEventBody(TICKET, "owner ended the scope", "build", "in_progress", identity);
    expect(parseCanceledEvent(body)).toEqual({
      ticket: TICKET,
      reason: textFingerprint("owner ended the scope"),
      from: "build",
      progress: "in_progress",
      identity,
    });
  });

  test("keeps the reason prose out of the YAML block, in the prose above it", () => {
    const reason = "owner ended the scope";
    const body = `Canceled: ${reason}\n\n${canceledEventBody(TICKET, reason, "review", "none", "id1")}`;
    expect(body).toContain(reason);
    expect(body.split("```yaml")[1]).not.toContain(reason);
    expect(parseCanceledEvent(body)).toMatchObject({ from: "review", progress: "none", identity: "id1" });
  });

  test("records a progress set of several labels", () => {
    const body = canceledEventBody(TICKET, "x", "build", "complete+in_progress", "id2");
    expect(parseCanceledEvent(body)).toMatchObject({ progress: "complete+in_progress", from: "build" });
  });

  test("rejects a from status outside the cancellable set", () => {
    const body = "```yaml\nigniter_event:\n  version: 1\n  kind: canceled\n  ticket: STA-1\n  reason: abc\n  from: done\n  progress: none\n  identity: id\n```";
    expect(() => parseCanceledEvent(body)).toThrow(/from.*backlog, todo, build, review, deliver/);
  });

  test("rejects a body with an identity mismatch in the field set", () => {
    const body = "```yaml\nigniter_event:\n  version: 1\n  kind: canceled\n  ticket: STA-1\n  reason: abc\n  from: build\n  progress: none\n```";
    expect(() => parseCanceledEvent(body)).toThrow(/misses required field "identity"/);
  });

  test("returns null for a body with no event block or a different kind", () => {
    expect(parseCanceledEvent("plain prose")).toBeNull();
    expect(parseCanceledEvent(failedEventBody(TICKET, "x"))).toBeNull();
  });

  test("hasCanceledEvent matches same ticket and identity, not a different reason", () => {
    const body = canceledEventBody(TICKET, "owner ended it", "build", "in_progress", "id3");
    expect(hasCanceledEvent([{ body }], TICKET, "id3")).toBe(true);
    expect(hasCanceledEvent([{ body }], "STA-OTHER", "id3")).toBe(false);
    expect(hasCanceledEvent([{ body }], TICKET, "id4")).toBe(false);
  });

  test("cancelIdentity is stable and reason/status/progress-sensitive", () => {
    const a = cancelIdentity(TICKET, "owner ended it", "build", "in_progress");
    expect(cancelIdentity(TICKET, "owner ended it", "build", "in_progress")).toBe(a);
    expect(cancelIdentity(TICKET, "a different reason", "build", "in_progress")).not.toBe(a);
    expect(cancelIdentity(TICKET, "owner ended it", "review", "in_progress")).not.toBe(a);
    expect(cancelIdentity(TICKET, "owner ended it", "build", "none")).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("incomplete-state event", () => {
  test("incompleteEventBody round-trips through parseIncompleteEvent", () => {
    const body = incompleteEventBody(TICKET, "build", "none", "no-receipt", "park:no-receipt");
    expect(parseIncompleteEvent(body)).toEqual({
      ticket: TICKET,
      stage: "build",
      progress: "none",
      receipt: "no-receipt",
      decision: "park:no-receipt",
    });
  });

  test("distinguishes multi-label progress keys", () => {
    const body = incompleteEventBody(TICKET, "review", "pending+complete", SUBMISSION, "park:kind-mismatch");
    expect(parseIncompleteEvent(body)).toMatchObject({ progress: "pending+complete", receipt: SUBMISSION });
  });

  test("rejects a null ticket in a current YAML event", () => {
    const body = "```yaml\nigniter_event:\n  version: 1\n  kind: incomplete-state\n  ticket: null\n  stage: build\n  progress: none\n  receipt: no-receipt\n  decision: park:no-receipt\n```";
    expect(() => parseIncompleteEvent(body)).toThrow(/non-empty "ticket"/);
  });

  test("reads the legacy marker+fingerprint pair read-only, with a null ticket", () => {
    const legacy =
      `<!-- igniter:incomplete-state -->\n<!-- fingerprint: build|none|no-receipt|park:no-receipt -->\n` +
      `Blocked: STA-1 is Build with no Progress label.\n`;
    expect(parseIncompleteEvent(legacy)).toEqual({
      ticket: null,
      stage: "build",
      progress: "none",
      receipt: "no-receipt",
      decision: "park:no-receipt",
    });
  });

  test("ignores a legacy marker with a malformed fingerprint", () => {
    expect(parseIncompleteEvent("<!-- igniter:incomplete-state -->\n<!-- fingerprint: build|none -->\nprose")).toBeNull();
    expect(parseIncompleteEvent("<!-- igniter:incomplete-state -->\nno fingerprint here")).toBeNull();
  });

  test("ignores a legacy marker pair embedded after comment prose", () => {
    const embedded =
      "quoted evidence\n<!-- igniter:incomplete-state -->\n" +
      "<!-- fingerprint: build|none|no-receipt|park:no-receipt -->\n";
    expect(parseIncompleteEvent(embedded)).toBeNull();
  });

  test("returns null for a body with no marker at all", () => {
    expect(parseIncompleteEvent("plain prose")).toBeNull();
  });
});
