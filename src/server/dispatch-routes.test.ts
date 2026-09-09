// The one HTTP door against a fake Linear endpoint: /api/command forwards
// argv to the dispatch commands and answers { ok, text, data? }.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDispatchLog,
  defaultHost,
  validateStartup,
  type CommandCallOptions,
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

const TODO = "st-todo";
const BUILD = "st-build";
const PENDING = "label-pending";
const IN_PROGRESS = "label-in-progress";
const CRITERIA = "## 驗收條件\n- [ ] works\n";

interface Served {
  base: string;
  world: ReturnType<typeof standardWorld>;
  workspaces: FakeWorkspaces;
  stop: () => void;
}

async function serve(): Promise<Served> {
  const world = standardWorld("test-key");
  const fake = startFakeLinear(world);
  const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url, fetchImpl: fake.fetchImpl });
  const resolved = await validateStartup(
    client,
    parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 2 }),
  );
  const dir = mkdtempSync(join(tmpdir(), "igniter-routes-"));
  const logPath = join(dir, "dispatch.log");
  const decisions = createDispatchLog(logPath, () => {});
  const workspaces = new FakeWorkspaces();
  const git = new FakeGit();
  const sink = createWorkspaceSink({ workspaces, config: resolved.config, repoRoot: dir, runGit: git });
  const api: DispatchApi = {
    command: (argv: string[], options: CommandCallOptions = {}): Promise<CommandResult> =>
      runCommand(argv, {
        client,
        resolved,
        host: defaultHost(),
        decisions,
        workspaces,
        sink,
        repoRoot: dir,
        git,
        lastPollAt: () => null,
      }, options),
  };
  const server = startServer({ port: 0, dispatch: api });
  return {
    base: `http://localhost:${server.port}`,
    world,
    workspaces,
    stop: () => {
      server.stop();
      fake.stop();
    },
  };
}

async function postCommand(
  base: string,
  argv: string[],
  options: CommandCallOptions = {},
): Promise<{ status: number; payload: { ok: boolean; text: string; data?: unknown } }> {
  const res = await fetch(`${base}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ argv, ...options }),
  });
  return { status: res.status, payload: (await res.json()) as { ok: boolean; text: string; data?: unknown } };
}

describe("POST /api/command", () => {
  test("CLI start returns a foreground agent launch without opening Herdr layout", async () => {
    const served = await serve();
    try {
      const started = await postCommand(served.base, ["start"], { directStart: true });

      expect(started.status).toBe(200);
      expect(started.payload.ok).toBe(true);
      expect(started.payload.data).toMatchObject({
        kind: "commander_foreground",
        cwd: expect.any(String),
      });
      expect(served.workspaces.calls).toEqual([]);
      expect(served.workspaces.workspaces).toEqual([]);
    } finally {
      served.stop();
    }
  });

  test("status, worker start, begin, and worker stop round-trip through HTTP", async () => {
    const served = await serve();
    try {
      addIssue(served.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const started = await postCommand(served.base, ["start", "STA-1"]);
      expect(started.status).toBe(200);
      expect(started.payload.ok).toBe(true);
      expect(started.payload.text).toContain("assigned STA-1");

      const worker = await postCommand(served.base, ["worker", "start", "STA-1"]);
      expect(worker.payload.ok).toBe(true);
      expect(worker.payload.data).toMatchObject({ confirmed: true, worker: "builder-sta-1" });
      const begun = await postCommand(served.base, ["begin", "STA-1"]);
      expect(begun.payload.ok).toBe(true);
      expect(begun.payload.text).toContain("build+in_progress");

      const status = await postCommand(served.base, ["status"]);
      expect(status.payload.ok).toBe(true);
      const data = status.payload.data as { slots: { used: number; max: number }; tickets: { identifier: string }[] };
      expect(data.slots).toEqual({ used: 1, max: 2 });
      expect(data.tickets.map((t) => t.identifier)).toEqual(["STA-1"]);

      const stopped = await postCommand(served.base, ["worker", "stop", "STA-1"]);
      expect(stopped.payload).toMatchObject({ ok: true });
      expect(stopped.payload.text).toContain("stopped; checkout preserved");
    } finally {
      served.stop();
    }
  });

  test("ticket-targeted and workspace commands round-trip through HTTP", async () => {
    const served = await serve();
    try {
      addIssue(served.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      await postCommand(served.base, ["worker", "start", "STA-1"]);
      await postCommand(served.base, ["begin", "STA-1"]);
      const ticketWs = served.workspaces.workspaces.find((w) => w.label === "STA-1")!;
      const wsId = ticketWs.workspaceId;

      const state = await postCommand(served.base, ["state", "--json"], { workspaceId: wsId });
      expect(state.payload.ok).toBe(true);
      expect(state.payload.text).toContain('"status": "build"');

      // Ticket status needs no workspace context.
      const ticket = await postCommand(served.base, ["status", "STA-1", "--json"]);
      expect(ticket.payload.ok).toBe(true);
      expect(ticket.payload.text).toContain('"status": "build"');

      // No ticket and no workspace id: usage, never a dispatch command.
      const naked = await postCommand(served.base, ["begin"]);
      expect(naked.payload.ok).toBe(false);
      expect(naked.payload.text).toContain("usage: igniter begin");

      const blocked = await postCommand(served.base, ["block", "STA-1", "--reason", "waiting"]);
      expect(blocked.payload.ok).toBe(true);
      expect(served.world.issues[0]!.labelIds).toEqual(["label-blocked"]);

      const unblocked = await postCommand(served.base, ["unblock", "STA-1"]);
      expect(unblocked.payload.ok).toBe(true);

      const begun = await postCommand(served.base, ["begin"], { workspaceId: wsId });
      expect(begun.payload.ok).toBe(true);
      expect(served.world.issues[0]!.labelIds).toEqual([IN_PROGRESS]);
      void BUILD;
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

      addIssue(served.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      addIssue(served.world, { identifier: "STA-2", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      addIssue(served.world, { identifier: "STA-3", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const full = await postCommand(served.base, ["begin", "STA-3"]);
      expect(full.payload.ok).toBe(false);
      expect(full.payload.text).toContain("max_running");
    } finally {
      served.stop();
    }
  });

  test("the command route without dispatch answers 503", async () => {
    const server = startServer({ port: 0 });
    try {
      const base = `http://localhost:${server.port}`;
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
