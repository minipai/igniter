import { describe, expect, test } from "bun:test";
import { autoStartServe, type AutoStartDeps } from "./auto-start";

function harness(health: Array<"offline" | number>) {
  let now = 0;
  let unref = 0;
  const spawns: Array<{ command: string[]; options: object }> = [];
  const urls: string[] = [];
  const deps: AutoStartDeps = {
    spawn: (command, options) => {
      spawns.push({ command, options });
      return { exited: new Promise<number>(() => {}), unref: () => { unref += 1; } };
    },
    fetch: async (url) => {
      urls.push(url);
      const next = health.shift() ?? 200;
      if (next === "offline") throw new Error("connection refused");
      return new Response(null, { status: next });
    },
    sleep: async (ms) => { now += ms; },
    now: () => now,
  };
  return { deps, spawns, urls, unref: () => unref };
}

describe("automatic dispatch startup", () => {
  test("starts serve detached and waits for health", async () => {
    const h = harness(["offline", 503, 200]);

    await autoStartServe(
      {
        base: "http://127.0.0.1:3457",
        repoRoot: "/repo",
        bunPath: "/bun",
        cliPath: "/repo/src/cli.ts",
        timeoutMs: 1_000,
        pollMs: 10,
      },
      h.deps,
    );

    expect(h.spawns).toEqual([{
      command: ["/bun", "/repo/src/cli.ts", "serve"],
      options: {
        cwd: "/repo",
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    }]);
    expect(h.unref()).toBe(1);
    expect(h.urls).toEqual([
      "http://127.0.0.1:3457/api/health",
      "http://127.0.0.1:3457/api/health",
      "http://127.0.0.1:3457/api/health",
    ]);
  });

  test("fails clearly when serve never becomes ready", async () => {
    const h = harness(["offline", "offline", "offline"]);

    await expect(autoStartServe(
      {
        base: "http://127.0.0.1:3457",
        repoRoot: "/repo",
        bunPath: "/bun",
        cliPath: "/repo/src/cli.ts",
        timeoutMs: 20,
        pollMs: 10,
      },
      h.deps,
    )).rejects.toThrow("did not become ready after automatic `igniter serve` startup");
  });

  test("reports a serve process that exits during startup", async () => {
    const h = harness(["offline"]);
    h.deps.spawn = (command, options) => {
      h.spawns.push({ command, options });
      return { exited: Promise.resolve(1), unref: () => {} };
    };

    await expect(autoStartServe(
      {
        base: "http://127.0.0.1:3457",
        repoRoot: "/repo",
        bunPath: "/bun",
        cliPath: "/repo/src/cli.ts",
        timeoutMs: 20,
        pollMs: 10,
      },
      h.deps,
    )).rejects.toThrow("automatic `igniter serve` exited with code 1");
  });
});
