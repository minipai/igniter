// Dispatch HTTP surface against a fake Linear endpoint: queue, activity,
// and forwarded claims through one ephemeral server per test.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Watcher,
  createDispatchLog,
  readActivityTail,
  validateStartup,
  type DispatchApi,
} from "../dispatch/claims";
import { parseDispatchConfig } from "../dispatch/config";
import { LinearClient } from "../dispatch/linear";
import { addIssue, standardWorld, startFakeLinear } from "../dispatch/fake-linear";
import { startServer } from "./serve";

const READY = "st-ready";
const BUILDING = "st-building";
const TODO = "st-todo";
const CRITERIA = "## 驗收條件\n- [ ] works\n";

interface Served {
  base: string;
  stop: () => void;
}

async function serve(): Promise<Served & { api: DispatchApi; logPath: string; world: ReturnType<typeof standardWorld> }> {
  const world = standardWorld("test-key");
  const fake = startFakeLinear(world);
  const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url });
  const resolved = await validateStartup(
    client,
    parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 2 }),
  );
  const dir = mkdtempSync(join(tmpdir(), "igniter-routes-"));
  const logPath = join(dir, "dispatch.log");
  const watcher = new Watcher({
    client,
    resolved,
    host: "h",
    decisions: createDispatchLog(logPath, () => {}),
    workspaces: { runningTickets: async () => new Set<string>() },
  });
  const api: DispatchApi = {
    queue: () => ({ lastPollAt: watcher.lastPollAt, order: watcher.lastQueue }),
    activity: (limit) => readActivityTail(logPath, limit),
    claim: (request) => watcher.claimDirect(request.identifier, request),
  };
  const server = startServer({ port: 0, dispatch: api });
  return {
    base: `http://localhost:${server.port}`,
    api,
    logPath,
    world,
    stop: () => {
      server.stop();
      fake.stop();
    },
  };
}

describe("dispatch routes", () => {
  test("POST /api/claims claims, reports already, and refuses at cap", async () => {
    const served = await serve();
    try {
      addIssue(served.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA });
      addIssue(served.world, { identifier: "STA-2", stateId: BUILDING, priority: 1, description: CRITERIA });

      const claimed = await fetch(`${served.base}/api/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: "STA-1", agent: "builder" }),
      });
      expect(claimed.status).toBe(200);
      expect(await claimed.json()).toMatchObject({ status: "claimed", identifier: "STA-1", slot: 0 });

      const missing = await fetch(`${served.base}/api/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: "STA-9" }),
      });
      expect(missing.status).toBe(404);

      const sloppy = await fetch(`${served.base}/api/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(sloppy.status).toBe(400);

      // max_running is 2 and both tickets run now: the next claim refuses.
      addIssue(served.world, { identifier: "STA-3", stateId: TODO, priority: 1, description: CRITERIA });
      const full = await fetch(`${served.base}/api/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: "STA-3" }),
      });
      expect(full.status).toBe(409);
      const refused = (await full.json()) as { error: string; running: string[] };
      expect(refused.running).toEqual(["STA-1", "STA-2"]);
      expect(refused.error).toContain("max_running");
    } finally {
      served.stop();
    }
  });

  test("GET /api/queue and /api/activity reflect polls and survive reads", async () => {
    const served = await serve();
    try {
      addIssue(served.world, { identifier: "STA-1", stateId: READY, priority: 1, description: CRITERIA });
      const before = (await (await fetch(`${served.base}/api/queue`)).json()) as {
        lastPollAt: null;
        order: unknown[];
      };
      expect(before).toEqual({ lastPollAt: null, order: [] });

      await fetch(`${served.base}/api/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: "STA-1" }),
      });
      const activity = (await (await fetch(`${served.base}/api/activity?limit=10`)).json()) as { lines: string[] };
      expect(activity.lines).toHaveLength(2);
      expect(activity.lines[0]).toMatch(/STA-1 claimed: Ready to build → Building \(slot 0\)/);
    } finally {
      served.stop();
    }
  });

  test("routes without dispatch answer 503", async () => {
    const server = startServer({ port: 0 });
    try {
      const base = `http://localhost:${server.port}`;
      expect((await fetch(`${base}/api/queue`)).status).toBe(503);
      expect((await fetch(`${base}/api/activity`)).status).toBe(503);
      expect(
        (
          await fetch(`${base}/api/claims`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ identifier: "STA-1" }),
          })
        ).status,
      ).toBe(503);
    } finally {
      server.stop();
    }
  });
});
