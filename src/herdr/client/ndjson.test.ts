import { describe, expect, test } from "bun:test";
import { encodeLine, splitLines } from "./ndjson";

describe("splitLines", () => {
  test("splits several lines in one chunk", () => {
    const result = splitLines('{"a":1}\n{"b":2}\n');
    expect(result.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(result.rest).toBe("");
  });

  test("buffers a half frame until the newline arrives", () => {
    const first = splitLines('{"a":');
    expect(first.lines).toEqual([]);
    expect(first.rest).toBe('{"a":');

    const second = splitLines(`${first.rest}1}\n{"b":`);
    expect(second.lines).toEqual(['{"a":1}']);
    expect(second.rest).toBe('{"b":');
  });

  test("keeps empty input empty", () => {
    expect(splitLines("")).toEqual({ lines: [], rest: "" });
  });

  test("passes empty lines through for the caller to skip", () => {
    const result = splitLines('\n{"a":1}\n');
    expect(result.lines).toEqual(["", '{"a":1}']);
    expect(result.rest).toBe("");
  });
});

describe("encodeLine", () => {
  test("appends a single newline", () => {
    expect(encodeLine({ id: "c1", method: "ping", params: {} })).toBe(
      '{"id":"c1","method":"ping","params":{}}\n',
    );
  });
});
