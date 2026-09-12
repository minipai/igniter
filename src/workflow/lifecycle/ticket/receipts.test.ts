// Versioned YAML receipt blocks: publisher shape and strict parser
// rejections. No network, no real credentials, no fixtures on disk.

import { describe, expect, test } from "bun:test";
import {
  buildReceiptBody,
  deliverReceiptBody,
  findReceipt,
  latestReceiptOf,
  latestValidReceipt,
  parseReceiptBlock,
  receiptBlock,
  acceptanceReceiptBody,
  type ReceiptKind,
} from "./protocol";
import { RecordParseError } from "./record";

const CHECKPOINT = "90bbd4d5b6479619fd689d1eb78af11742f3bbf3";
const SUBMISSION = "7c8b1be2d3fe8437";

function buildPayload() {
  return {
    v: 1 as const,
    kind: "build" as const,
    checkpoint: CHECKPOINT,
    checks: ["bun run check"],
    results: [{ criterion: "works", ok: true }],
    reproduction: "run bun run check",
  };
}

function acceptancePayload(verdict: "pass" | "fail") {
  return {
    v: 1 as const,
    kind: "acceptance" as const,
    verdict,
    checkpoint: CHECKPOINT,
    results: [
      {
        criterion: "works",
        expected: "cli prints ok",
        actual: "cli printed ok",
        evidence: "```text\n$ mycli run\nok\nExit code: 0\n```\n\n![shot](https://example.test/shot.png)",
        ok: true,
      },
    ],
    environment: "test lab",
    reproduction: "open the page",
  };
}

function deliverPayload() {
  return {
    v: 1 as const,
    kind: "deliver" as const,
    checkpoint: CHECKPOINT,
    landed: CHECKPOINT,
    lineage: "abc123 deliver work",
    merge_ready: true as const,
    owner_actions: ["push the branch"],
  };
}

describe("receipt publisher", () => {
  test("every receipt carries exactly one parseable block and no HTML marker", () => {
    const bodies: [string, ReceiptKind][] = [
      [buildReceiptBody(buildPayload(), SUBMISSION), "build"],
      [acceptanceReceiptBody(acceptancePayload("pass"), SUBMISSION), "acceptance-pass"],
      [acceptanceReceiptBody(acceptancePayload("fail"), SUBMISSION), "acceptance-fail"],
      [deliverReceiptBody(deliverPayload(), SUBMISSION), "deliver"],
    ];
    for (const [body, kind] of bodies) {
      expect(body).not.toContain("<!-- igniter:");
      expect(body.match(/```yaml/g)).toHaveLength(1);
      expect(parseReceiptBlock(body)).toMatchObject({ kind, checkpoint: CHECKPOINT, submission: SUBMISSION });
    }
  });

  test("receiptBlock round-trips through the parser for every kind", () => {
    for (const kind of ["build", "acceptance-pass", "acceptance-fail", "deliver"] as const) {
      const landed = kind === "deliver" ? CHECKPOINT : undefined;
      expect(parseReceiptBlock(`report\n\n${receiptBlock(kind, CHECKPOINT, SUBMISSION, landed)}\n`)).toEqual({
        kind,
        checkpoint: CHECKPOINT,
        ...(landed ? { landed } : {}),
        submission: SUBMISSION,
      });
    }
  });

  test("deliver receipts round-trip the landed commit and legacy v1 receipts inherit their checkpoint", () => {
    const landed = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(parseReceiptBlock(`report\n\n${receiptBlock("deliver", CHECKPOINT, SUBMISSION, landed)}\n`)).toEqual({
      kind: "deliver",
      checkpoint: CHECKPOINT,
      landed,
      submission: SUBMISSION,
    });
    expect(parseReceiptBlock(deliverReceiptBody(deliverPayload(), SUBMISSION))).toMatchObject({
      kind: "deliver",
      checkpoint: CHECKPOINT,
      landed: CHECKPOINT,
      submission: SUBMISSION,
    });
    const misplaced = receiptBlock("build", CHECKPOINT, SUBMISSION).replace(
      "  submission:",
      `  landed: ${landed}\n  submission:`,
    );
    expect(() => parseReceiptBlock(`x\n\n${misplaced}\n`)).toThrow('only a deliver receipt carries "landed"');
    const legacy = receiptBlock("deliver", CHECKPOINT, SUBMISSION);
    expect(legacy).not.toContain("  landed:");
    expect(parseReceiptBlock(`x\n\n${legacy}\n`)).toEqual({
      kind: "deliver",
      checkpoint: CHECKPOINT,
      landed: CHECKPOINT,
      submission: SUBMISSION,
    });
  });
});

describe("receipt Markdown layout", () => {
  test("an optional Build note sits in its own paragraph under Self-check notes", () => {
    const withNote = buildReceiptBody(
      {
        v: 1,
        kind: "build",
        checkpoint: CHECKPOINT,
        checks: ["bun run check"],
        results: [
          { criterion: "works", ok: true, note: "first line\n\nsecond paragraph" },
          { criterion: "shines", ok: true },
        ],
        reproduction: "run bun run check",
      },
      SUBMISSION,
    );
    expect(withNote).toContain("- [x] works\n\n  **Self-check notes**\n\n  first line\n\n  second paragraph");
    // A result without a note has no empty heading.
    expect(withNote).toContain("- [x] shines");
    expect(withNote.match(/\*\*Self-check notes\*\*/g)).toHaveLength(1);

    const withoutNote = buildReceiptBody(
      {
        v: 1,
        kind: "build",
        checkpoint: CHECKPOINT,
        checks: ["bun run check"],
        results: [{ criterion: "works", ok: true }],
        reproduction: "run bun run check",
      },
      SUBMISSION,
    );
    expect(withoutNote).not.toContain("Self-check notes");
  });

  test("Acceptance renders Expected, Actual and Evidence as separate English headings", () => {
    const body = acceptanceReceiptBody(acceptancePayload("pass"), SUBMISSION);
    for (const heading of ["**Expected**", "**Actual**", "**Evidence**"]) {
      expect(body).toContain(heading);
    }
    expect(body).not.toContain("Command:");
    // The fenced transcript and the image stay inside the criterion's list item.
    expect(body).toContain("  ```text\n  $ mycli run\n  ok\n  Exit code: 0\n  ```");
    expect(body).toContain("  ![shot](https://example.test/shot.png)");
  });
});

describe("receipt parser", () => {
  test("bodies without a block parse to null, never throw", () => {
    expect(parseReceiptBlock("plain comment")).toBeNull();
    expect(parseReceiptBlock("")).toBeNull();
    expect(parseReceiptBlock("```yaml\nkey: value\n```")).toBeNull();
    expect(parseReceiptBlock("igniter_receipt:\n  version: 1\n")).toBeNull(); // unfenced prose
    expect(parseReceiptBlock("```YAML\nigniter_receipt:\n```")).toBeNull(); // writer uses lowercase
  });

  test("unknown versions are refused", () => {
    const body = receiptBlock("build", CHECKPOINT, SUBMISSION).replace("version: 1", "version: 2");
    expect(() => parseReceiptBlock(`x\n\n${body}\n`)).toThrow(RecordParseError);
    expect(() => parseReceiptBlock(`x\n\n${body}\n`)).toThrow("unknown receipt version");
  });

  test("unknown kinds are refused", () => {
    const body = receiptBlock("build", CHECKPOINT, SUBMISSION).replace("kind: build", "kind: approved");
    expect(() => parseReceiptBlock(`x\n\n${body}\n`)).toThrow("unknown receipt kind");
  });

  test("missing, extra, and duplicate fields are refused", () => {
    const block = receiptBlock("build", CHECKPOINT, SUBMISSION);
    const withoutSubmission = block.split("\n").filter((l) => !l.startsWith("  submission:")).join("\n");
    expect(() => parseReceiptBlock(withoutSubmission)).toThrow('misses required field "submission"');
    const withExtra = block.replace("  submission:", "  note: hi\n  submission:");
    expect(() => parseReceiptBlock(withExtra)).toThrow('unknown receipt field "note"');
    const doubled = `${block}\n${block}`;
    expect(() => parseReceiptBlock(doubled)).toThrow("exactly one");
    const dupField = block.replace("  submission:", "  kind: build\n  submission:");
    expect(() => parseReceiptBlock(dupField)).toThrow('duplicate receipt field "kind"');
  });

  test("malformed YAML shapes are refused", () => {
    const badHead = receiptBlock("build", CHECKPOINT, SUBMISSION).replace("igniter_receipt:", "igniter_receipt: x");
    expect(() => parseReceiptBlock(badHead)).toThrow("must start with");
    const badIndent = receiptBlock("build", CHECKPOINT, SUBMISSION).replace("  kind:", "    kind:");
    expect(() => parseReceiptBlock(badIndent)).toThrow("malformed receipt line");
    const tabbed = receiptBlock("build", CHECKPOINT, SUBMISSION).replace("  kind:", "\tkind:");
    expect(() => parseReceiptBlock(tabbed)).toThrow("malformed receipt line");
    const commented = receiptBlock("build", CHECKPOINT, SUBMISSION).replace("  kind:", "  # a note\n  kind:");
    expect(() => parseReceiptBlock(commented)).toThrow("comment line");
    const spaced = receiptBlock("build", CHECKPOINT, SUBMISSION).replace(
      `  checkpoint: ${CHECKPOINT}`,
      "  checkpoint: abc def",
    );
    expect(() => parseReceiptBlock(spaced)).toThrow("malformed receipt line");
    const empty = receiptBlock("build", CHECKPOINT, SUBMISSION).replace(`  kind: build`, "  kind:");
    expect(() => parseReceiptBlock(empty)).toThrow("malformed receipt line");
    const dupHead = receiptBlock("build", CHECKPOINT, SUBMISSION).replace(
      "igniter_receipt:\n",
      "igniter_receipt:\nigniter_receipt:\n",
    );
    expect(() => parseReceiptBlock(dupHead)).toThrow("malformed receipt line");
  });
});

describe("receipt lookup", () => {
  test("latestValidReceipt reads newest first and skips invalid comments", () => {
    const oldValid = { id: "c1", body: `old\n\n${receiptBlock("build", "aaa", "s1")}\n` };
    const broken = { id: "c2", body: `new\n\n${receiptBlock("build", "bbb", "s2")}\n${receiptBlock("build", "bbb", "s2")}\n` };
    const prose = { id: "c3", body: "a human note" };
    expect(latestValidReceipt([oldValid, broken, prose])).toMatchObject({
      id: "c1",
      receipt: { kind: "build", checkpoint: "aaa", submission: "s1" },
    });
    const newer = { id: "c4", body: `newest\n\n${receiptBlock("acceptance-pass", "aaa", "s3")}\n` };
    expect(latestValidReceipt([oldValid, newer])).toMatchObject({
      id: "c4",
      receipt: { kind: "acceptance-pass" },
    });
    expect(latestValidReceipt([prose])).toBeNull();
  });

  test("a legacy v1 Deliver receipt stays newer than its Acceptance PASS", () => {
    const checkpoint = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const comments = [
      {
        id: "acceptance",
        body: `acceptance\n\n${receiptBlock("acceptance-pass", checkpoint, "acceptance-submission")}\n`,
      },
      {
        id: "legacy-deliver",
        body: `deliver\n\n${receiptBlock("deliver", checkpoint, "deliver-submission")}\n`,
      },
    ];

    expect(latestValidReceipt(comments)).toEqual({
      id: "legacy-deliver",
      body: comments[1]!.body,
      receipt: {
        kind: "deliver",
        checkpoint,
        landed: checkpoint,
        submission: "deliver-submission",
      },
    });
    expect(comments[1]!.body).not.toContain("  landed:");
  });

  test("findReceipt dedupes on kind plus submission", () => {
    const comments = [
      { id: "c1", body: `a\n\n${receiptBlock("build", "aaa", "s1")}\n` },
      { id: "c2", body: `b\n\n${receiptBlock("acceptance-pass", "aaa", "s2")}\n` },
    ];
    expect(findReceipt(comments, "build", "s1")?.id).toBe("c1");
    expect(findReceipt(comments, "acceptance-pass", "s2")?.id).toBe("c2");
    expect(findReceipt(comments, "build", "s2")).toBeNull();
    expect(findReceipt(comments, "deliver", "s1")).toBeNull();
  });

  test("latestReceiptOf selects one kind newest first", () => {
    const comments = [
      { id: "c1", body: `a\n\n${receiptBlock("build", "aaa", "s1")}\n` },
      { id: "c2", body: `b\n\n${receiptBlock("build", "bbb", "s2")}\n` },
    ];
    expect(latestReceiptOf(comments, "build")).toMatchObject({ id: "c2", receipt: { checkpoint: "bbb" } });
    expect(latestReceiptOf(comments, "deliver")).toBeNull();
  });
});
