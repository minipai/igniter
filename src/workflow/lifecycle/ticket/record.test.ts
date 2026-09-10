import { describe, expect, test } from "bun:test";
import { parseRecord, recordBlock, RecordParseError, strictFields } from "./record";

const roots: ("igniter_receipt" | "igniter_event")[] = ["igniter_receipt", "igniter_event"];

describe("fenced record codec", () => {
  test.each(roots)("writes and parses one visible, versioned %s block", (root) => {
    const block = recordBlock(root, [["kind", "begin"], ["after", null]]);
    expect(block).toBe(`\`\`\`yaml\n${root}:\n  version: 1\n  kind: begin\n  after: null\n\`\`\``);
    expect(parseRecord(block, root)).toEqual(new Map([["kind", "begin"], ["after", "null"]]));
  });

  test.each(roots)("returns null without a fenced %s record", (root) => {
    expect(parseRecord("plain prose", root)).toBeNull();
    expect(parseRecord("```yaml\nother: 1\n```", root)).toBeNull();
    expect(parseRecord(`${root}:\n  version: 1`, root)).toBeNull();
    expect(parseRecord(`\`\`\`YAML\n${root}:\n\`\`\``, root)).toBeNull();
  });

  test.each(roots)("rejects duplicate %s blocks", (root) => {
    const block = recordBlock(root, [["kind", "begin"]]);
    expect(() => parseRecord(`${block}\n${block}`, root)).toThrow(/exactly one/);
  });

  test("rejects mixed receipt and event blocks from either parser", () => {
    const receipt = recordBlock("igniter_receipt", [["kind", "build"]]);
    const event = recordBlock("igniter_event", [["kind", "begin"]]);
    expect(() => parseRecord(`${receipt}\n${event}`, "igniter_receipt")).toThrow(/holds both/);
    expect(() => parseRecord(`${receipt}\n${event}`, "igniter_event")).toThrow(/holds both/);
  });

  test("allows an unrelated YAML fence beside a record", () => {
    const event = recordBlock("igniter_event", [["kind", "begin"]]);
    expect(parseRecord(`\`\`\`yaml\nother: 1\n\`\`\`\n${event}`, "igniter_event")?.get("kind")).toBe("begin");
  });

  test.each([
    ["unknown version", "igniter_event:\n  version: 2", /unknown event version/],
    ["missing version", "igniter_event:", /misses "version"/],
    ["indented head", "  igniter_event:\n  version: 1", /must start with/],
    ["tabbed field", "igniter_event:\n  version: 1\n\tkind: begin", /malformed event line/],
    ["comment", "igniter_event:\n  version: 1\n  # note", /comment line/],
    ["spaced scalar", "igniter_event:\n  version: 1\n  kind: begin now", /malformed event line/],
    ["empty scalar", "igniter_event:\n  version: 1\n  kind:", /malformed event line/],
    ["duplicate field", "igniter_event:\n  version: 1\n  kind: begin\n  kind: failed", /duplicate event field/],
  ])("rejects %s", (_name, content, message) => {
    expect(() => parseRecord(`\`\`\`yaml\n${content}\n\`\`\``, "igniter_event")).toThrow(message as RegExp);
  });

  test("enforces exact required and allowed fields", () => {
    expect(() => strictFields(new Map([["kind", "begin"], ["extra", "x"]]), ["kind"], ["kind"], "event"))
      .toThrow(/unknown event field "extra"/);
    expect(() => strictFields(new Map([["kind", "begin"]]), ["kind", "ticket"], ["kind", "ticket"], "event"))
      .toThrow(/misses required field "ticket"/);
  });

  test("writer rejects malformed values and duplicate fields", () => {
    expect(() => recordBlock("igniter_event", [["ticket", "STA 1"]])).toThrow(/whitespace-free scalar/);
    expect(() => recordBlock("igniter_event", [["ticket", ""]])).toThrow(/whitespace-free scalar/);
    expect(() => recordBlock("igniter_event", [["ticket", undefined as unknown as string]])).toThrow(/whitespace-free scalar/);
    expect(() => recordBlock("igniter_event", [["ticket", "STA-1"], ["ticket", "STA-2"]])).toThrow(/duplicate/);
  });

  test("uses one shared parse error type", () => {
    const bad = "```yaml\nigniter_receipt:\n  version: 2\n```";
    expect(() => parseRecord(bad, "igniter_receipt")).toThrow(RecordParseError);
  });
});
