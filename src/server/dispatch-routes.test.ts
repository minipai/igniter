// The one HTTP door against a fake Linear endpoint: /api/command forwards
// argv to the dispatch commands and answers { ok, text, data? }. Queue and
// activity stay as they were.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Watcher,
  createDispatchLog,
  defaultHost,
  readActivityTail,
  validateStartup,
  type CommandResult,
  type DispatchApi,
} from "../dispatch/claims";
import { createWorkspaceSink, runCommand } from "../dispatch/commands";
import { parseDispatchConfig } from "../dispatch/config";
import { LinearClient } from "../dispatch/linear";
import { addIssue, standardWorld, startFakeLinear } from "../dispatch/fake-linear";
import { FakeGit } from "../dispatch/fake-git";
import { FakeWorkspaces } from "../dispatch/fake-workspaces";
import { startServer } from "./serve";

const READY = "st-ready";
const BUILDING = "st-building";
const TODO = "st-todo";
const CRITERIA = "## 驗收條件\n- [ ] works\n";

interface Served {
  base: string;
  world: ReturnType<typeof standardWorld>;
  stop: () => void;
}

async function serve(): Promise<Served> {
  const world = standardWorld("test-key");
  const fake = startFakeLinear(world);
  const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url });
  const resolved = await validateStartup(
    client,
    parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 2 }),
  );
  const dir = mkdtempSync(join(tmpdir(), "igniter-routes-"));
  const logPath = join(dir, "dispatch.log");
  const decisions = createDispatchLog(logPath, () => {});
  const workspaces = new FakeWorkspaces();
  const sink = createWorkspaceSink({
    workspaces,
    config: resolved.config,
    repoRoot: dir,
    readApiKey: () => "test-key",
    runGit: new FakeGit(),
  });
  const watcher = new Watcher({ client, resolved, host: "h", decisions, workspaces, sink });
  const api: DispatchApi = {
    queue: () => ({ lastPollAt: watcher.lastPollAt, order: watcher.lastQueue }),
    activity: (limit) => readActivityTail(logPath, limit),
    command: (argv: string[]): Promise<CommandResult> =>
      runCommand(argv, {
        client,
        resolved,
        host: defaultHost(),
        decisions,
        workspaces,
        sink,
        repoRoot: dir,
        lastPollAt: () => watcher.lastPollAt,
      }),
  };
  const server = startServer({ port: 0, dispatch: api });
  return {
    base: `http://localhost:${server.port}`,
    world,
    stop: () => {
      server.stop();
      fake.stop();
    },
  };
}

async function postCommand(base: string, argv: string[]): Promise<{ status: number; payload: { ok: boolean; text: string; data?: unknown } }> {
  const res = await fetch(`${base}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ argv }),
  });
  return { status: res.status, payload: (await res.json()) as { ok: boolean; text: string; data?: unknown } };
}

describe("POST /api/command", () => {
  test("status, start, pause, and resume round-trip through HTTP", async () => {
    const served = await serve();
    try {
      addIssue(served.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA });

      const started = await postCommand(served.base, ["start", "STA-1"]);
      expect(started.status).toBe(200);
      expect(started.payload.ok).toBe(true);
      expect(started.payload.text).toContain("claimed STA-1");

      const status = await postCommand(served.base, ["status"]);
      expect(status.payload.ok).toBe(true);
      const data = status.payload.data as { slots: { used: number; max: number }; tickets: { identifier: string }[] };
      expect(data.slots).toEqual({ used: 1, max: 2 });
      expect(data.tickets.map((t) => t.identifier)).toEqual(["STA-1"]);

      const paused = await postCommand(served.base, ["pause", "STA-1"]);
      expect(paused.payload).toMatchObject({ ok: true });
      expect(paused.payload.text).toContain("paused STA-1");

      const resumed = await postCommand(served.base, ["resume", "STA-1"]);
      expect(resumed.payload).toMatchObject({ ok: true });

      const activity = (await (await fetch(`${served.base}/api/activity?limit=10`)).json()) as { lines: string[] };
      expect(activity.lines.join("\n")).toContain("STA-1 paused by command");
    } finally {
      served.stop();
    }
  });

  test("refusals answer ok:false with text", async () => {
    const served = await serve();
    try {
      const missing = await postCommand(served.base, ["start", "STA-9"]);
      expect(missing.status).toBe(200);
      expect(missing.payload.ok).toBe(false);
      expect(missing.payload.text).toContain("was not found in Linear");

      const sloppy = await fetch(`${served.base}/api/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(sloppy.status).toBe(400);
      expect(((await sloppy.json()) as { ok: boolean }).ok).toBe(false);

      addIssue(served.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      addIssue(served.world, { identifier: "STA-2", stateId: BUILDING, priority: 1, description: CRITERIA });
      addIssue(served.world, { identifier: "STA-3", stateId: TODO, priority: 1, description: CRITERIA });
      const full = await postCommand(served.base, ["start", "STA-3"]);
      expect(full.payload.ok).toBe(false);
      expect(full.payload.text).toContain("max_running");
    } finally {
      served.stop();
    }
  });

  test("GET /api/queue and /api/activity still work", async () => {
    const served = await serve();
    try {
      addIssue(served.world, { identifier: "STA-1", stateId: READY, priority: 1, description: CRITERIA });
      const before = (await (await fetch(`${served.base}/api/queue`)).json()) as {
        lastPollAt: null;
        order: unknown[];
      };
      expect(before).toEqual({ lastPollAt: null, order: [] });

      await postCommand(served.base, ["start", "STA-1"]);
      const activity = (await (await fetch(`${served.base}/api/activity?limit=10`)).json()) as { lines: string[] };
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
      const res = await fetch(`${base}/api/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ argv: ["status"] }),
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    } finally {
      server.stop();
    }
  });
});
