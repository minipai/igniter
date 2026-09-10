// The one HTTP door against a fake Linear endpoint: /api/command forwards
// argv to the dispatch commands and answers { ok, text, data? }.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDispatchLog,
  validateStartup,
  type CommandCallOptions,
  type CommandResult,
  type DispatchApi,
} from "../dispatch/claims";
import { runCommand } from "../dispatch/commands";
import { parseDispatchConfig } from "../dispatch/config";
import { LinearClient } from "../dispatch/linear";
import { addIssue, standardWorld, startFakeLinear } from "../dispatch/fake-linear";
import { FakeGit } from "../dispatch/fake-git";
import { FakeWorkspaces } from "../dispatch/fake-workspaces";
import { createApp } from "./app";

const TODO = "st-todo";
const BUILD = "st-build";
const PENDING = "label-pending";
const IN_PROGRESS = "label-in-progress";
const CRITERIA = "## 驗收條件\n- [ ] works\n";

interface Served {
  request: ReturnType<typeof createApp>;
  requests: () => number;
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
  const api: DispatchApi = {
    command: (argv: string[], options: CommandCallOptions = {}): Promise<CommandResult> =>
      runCommand(argv, {
        client,
        resolved,
        decisions,
        workspaces,
        repoRoot: dir,
        git,
      }, options),
  };
  return {
    request: createApp({ dispatch: api }),
    requests: () => fake.requests,
    world,
    workspaces,
    stop: () => {
      fake.stop();
    },
  };
}

async function postCommand(
  request: ReturnType<typeof createApp>,
  argv: string[],
  options: CommandCallOptions & { workspaceId?: string } = {},
): Promise<{ status: number; payload: { ok: boolean; text: string; data?: unknown } }> {
  const res = await request(new Request("http://igniter.test/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ argv, ...options }),
  }));
  return { status: res.status, payload: (await res.json()) as { ok: boolean; text: string; data?: unknown } };
}

describe("POST /api/command", () => {
  test("CLI start returns a foreground agent launch without opening Herdr layout", async () => {
    const served = await serve();
    try {
      const started = await postCommand(served.request, ["start"], { directStart: true });

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
      const started = await postCommand(served.request, ["start", "STA-1"], { directStart: true });
      expect(started.status).toBe(200);
      expect(started.payload.ok).toBe(true);
      expect(started.payload.data).toMatchObject({ kind: "commander_foreground" });
      expect(JSON.stringify(started.payload.data)).toContain("Assigned ticket: STA-1");

      const worker = await postCommand(served.request, ["worker", "start", "STA-1"]);
      expect(worker.payload.ok).toBe(true);
      expect(worker.payload.data).toMatchObject({ confirmed: true, worker: "builder-sta-1" });
      const begun = await postCommand(served.request, ["begin", "STA-1"]);
      expect(begun.payload.ok).toBe(true);
      expect(begun.payload.text).toContain("build+in_progress");

      const status = await postCommand(served.request, ["status"]);
      expect(status.payload.ok).toBe(true);
      const data = status.payload.data as { slots: { used: number; max: number }; tickets: { identifier: string }[] };
      expect(data.slots).toEqual({ used: 1, max: 2 });
      expect(data.tickets.map((t) => t.identifier)).toEqual(["STA-1"]);

      const stopped = await postCommand(served.request, ["worker", "stop", "STA-1"]);
      expect(stopped.payload).toMatchObject({ ok: true });
      expect(stopped.payload.text).toContain("stopped; checkout preserved");
    } finally {
      served.stop();
    }
  });

  test("ticket-targeted commands round-trip through HTTP", async () => {
    const served = await serve();
    try {
      addIssue(served.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      await postCommand(served.request, ["worker", "start", "STA-1"]);
      await postCommand(served.request, ["begin", "STA-1"]);
      // Ticket status needs no workspace context.
      const ticket = await postCommand(served.request, ["status", "STA-1", "--json"]);
      expect(ticket.payload.ok).toBe(true);
      expect(ticket.payload.text).toContain('"status": "build"');

      // No ticket and no workspace id: usage, never a dispatch command.
      const naked = await postCommand(served.request, ["begin"]);
      expect(naked.payload.ok).toBe(false);
      expect(naked.payload.text).toContain("usage: igniter begin");

      const blocked = await postCommand(served.request, ["block", "STA-1", "--reason", "waiting"]);
      expect(blocked.payload.ok).toBe(true);
      expect(served.world.issues[0]!.labelIds).toEqual(["label-blocked"]);

      const unblocked = await postCommand(served.request, ["unblock", "STA-1"]);
      expect(unblocked.payload.ok).toBe(true);

      const begun = await postCommand(served.request, ["begin", "STA-1"]);
      expect(begun.payload.ok).toBe(true);
      expect(served.world.issues[0]!.labelIds).toEqual([IN_PROGRESS]);
    } finally {
      served.stop();
    }
  });

  test("refusals answer ok:false with text", async () => {
    const served = await serve();
    try {
      const missing = await postCommand(served.request, ["start", "STA-9"], { directStart: true });
      expect(missing.status).toBe(200);
      expect(missing.payload.ok).toBe(false);
      expect(missing.payload.text).toContain("was not found in Linear");

      const sloppy = await served.request(new Request("http://igniter.test/api/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }));
      expect(sloppy.status).toBe(400);
      expect(((await sloppy.json()) as { ok: boolean }).ok).toBe(false);

      addIssue(served.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      addIssue(served.world, { identifier: "STA-2", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      addIssue(served.world, { identifier: "STA-3", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const full = await postCommand(served.request, ["begin", "STA-3"]);
      expect(full.payload.ok).toBe(false);
      expect(full.payload.text).toContain("max_running");
    } finally {
      served.stop();
    }
  });

  test("missing tickets reject workspace context without reading or writing either system", async () => {
    const served = await serve();
    try {
      served.workspaces.seedWorkspace("STA-1", { ticket: "STA-1" });
      const calls = served.workspaces.calls.length;
      const requests = served.requests();
      const issues = structuredClone(served.world.issues);
      for (const argv of [["begin"], ["submit", "--input", "-"], ["block", "--reason", "waiting"], ["unblock"]]) {
        const out = await postCommand(served.request, argv, { workspaceId: "ws-1", input: "{}" });
        expect(out.status).toBe(200);
        expect(out.payload).toMatchObject({ ok: false, text: expect.stringContaining(`usage: igniter ${argv[0]} <ticket>`) });
      }
      const removed = await postCommand(served.request, ["state", "--json"], { workspaceId: "ws-1" });
      expect(removed.payload).toMatchObject({ ok: false, text: expect.stringContaining("status <ticket> --json") });
      expect(served.requests()).toBe(requests);
      expect(served.world.issues).toEqual(issues);
      expect(served.workspaces.calls).toHaveLength(calls);
    } finally {
      served.stop();
    }
  });

  test("start requires foreground caller intent and never opens a resident Commander", async () => {
    const served = await serve();
    try {
      const requests = served.requests();
      for (const options of [{}, { directStart: false }]) {
        const out = await postCommand(served.request, ["start", "STA-1"], options);
        expect(out.payload).toMatchObject({ ok: false, text: expect.stringContaining("igniter start") });
      }
      expect(served.requests()).toBe(requests);
      expect(served.workspaces.calls).toEqual([]);
    } finally {
      served.stop();
    }
  });

  test("the command route without dispatch answers 503", async () => {
    const out = await postCommand(createApp(), ["status"]);
    expect(out.status).toBe(503);
    expect(out.payload.ok).toBe(false);
  });
});
