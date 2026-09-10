import { describe, expect, test } from "bun:test";
import { lookupSocketPath, parseSocketPath } from "./socket-path";

const STATUS_OUTPUT = `client:
  version: 0.8.2
  channel: stable
  protocol: 20

server:
  status: running
  version: 0.8.2
  protocol: 20
  compatible: yes
  socket: /Users/art/.config/herdr/herdr.sock
`;

describe("parseSocketPath", () => {
  test("reads server.socket from herdr status output", () => {
    expect(parseSocketPath(STATUS_OUTPUT)).toBe("/Users/art/.config/herdr/herdr.sock");
  });

  test("returns undefined when no socket line exists", () => {
    expect(parseSocketPath("server:\n  status: stopped\n")).toBeUndefined();
  });

  test("ignores socket lines outside the server block", () => {
    const output = [
      "client:",
      "  socket: /tmp/wrong.sock",
      "",
      "server:",
      "  status: running",
      "  socket: /tmp/right.sock",
      "",
      "update:",
      "  socket: /tmp/other.sock",
    ].join("\n");
    expect(parseSocketPath(output)).toBe("/tmp/right.sock");
  });

  test("returns undefined when only a non-server socket exists", () => {
    expect(parseSocketPath("client:\n  socket: /tmp/wrong.sock\n")).toBeUndefined();
  });
});

describe("lookupSocketPath", () => {
  test("prefers HERDR_SOCKET_PATH over herdr status", async () => {
    const path = await lookupSocketPath({
      env: { HERDR_SOCKET_PATH: "/tmp/custom.sock" },
      runStatus: () => {
        throw new Error("must not run herdr status");
      },
    });
    expect(path).toBe("/tmp/custom.sock");
  });

  test("falls back to herdr status", async () => {
    const path = await lookupSocketPath({
      env: {},
      runStatus: async () => STATUS_OUTPUT,
    });
    expect(path).toBe("/Users/art/.config/herdr/herdr.sock");
  });

  test("throws when herdr status has no socket", async () => {
    await expect(lookupSocketPath({ env: {}, runStatus: async () => "nope\n" })).rejects.toThrow(
      "server.socket",
    );
  });
});
