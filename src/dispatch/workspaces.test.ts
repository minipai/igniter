import { describe, expect, test } from "bun:test";
import { createSocketPathCache, extractRunningTickets } from "./workspaces";

describe("extractRunningTickets", () => {
  test("agent names and token values map to tickets; everything else is ignored", () => {
    expect(
      extractRunningTickets({
        agents: [
          { name: "commander-STA-1" },
          { name: "builder-STA-2" },
          { name: "reviewer-STA-3" },
          { name: "bash" },
          { name: null },
          {},
        ],
        workspaces: [
          { tokens: { source: "igniter", ticket: "STA-4" } },
          { tokens: { source: "other" } },
          {},
        ],
      }),
    ).toEqual(new Set(["STA-1", "STA-2", "STA-3", "STA-4"]));
  });

  test("empty snapshots yield no tickets", () => {
    expect(extractRunningTickets({})).toEqual(new Set());
    expect(extractRunningTickets({ agents: [], workspaces: [] })).toEqual(new Set());
  });
});

describe("createSocketPathCache", () => {
  test("resolves once and reuses the answer", async () => {
    let calls = 0;
    const path = createSocketPathCache({
      timeoutMs: 100,
      env: {},
      runStatus: async () => {
        calls += 1;
        return "server:\n  socket: /tmp/herdr.sock\n";
      },
    });
    expect(await path()).toBe("/tmp/herdr.sock");
    expect(await path()).toBe("/tmp/herdr.sock");
    expect(calls).toBe(1);
  });

  test("an explicit path never shells out", async () => {
    let calls = 0;
    const path = createSocketPathCache({
      socketPath: "/tmp/herdr.sock",
      timeoutMs: 100,
      runStatus: async () => {
        calls += 1;
        return "";
      },
    });
    expect(await path()).toBe("/tmp/herdr.sock");
    expect(await path()).toBe("/tmp/herdr.sock");
    expect(calls).toBe(0);
  });

  test("a wedged lookup times out instead of holding the event loop", async () => {
    let calls = 0;
    const path = createSocketPathCache({
      timeoutMs: 50,
      env: {},
      runStatus: () => {
        calls += 1;
        return new Promise<string>(() => {});
      },
    });
    const started = Date.now();
    await expect(path()).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(2000);
    // Failures are not cached: the next poll retries.
    await expect(path()).rejects.toThrow("timed out");
    expect(calls).toBe(2);
  });
});
