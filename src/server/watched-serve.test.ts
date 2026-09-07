// The production serve assembly against fake edges: fake Linear, fake
// Herdr, fake git, and a temporary repo root. No real credentials, no
// daemon, no real project. The temporary root mirrors production layout
// (`.igniter/dispatch.log` lives under it), and LINEAR_API_KEY is never
// read — the client is built with a test key like every dispatch test.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActivityTail } from "../dispatch/claims";
import { parseDispatchConfig } from "../dispatch/config";
import { LinearClient } from "../dispatch/linear";
import { addIssue, standardWorld, startFakeLinear, type FakeLinearWorld } from "../dispatch/fake-linear";
import { FakeGit } from "../dispatch/fake-git";
import { FakeWorkspaces } from "../dispatch/fake-workspaces";
import { startWatchedServe, type WatchedServeHandle } from "./watched-serve";

const BUILD = "st-build";
const TODO = "st-todo";
const PENDING = "label-pending";
const IN_PROGRESS = "label-in-progress";
const CRITERIA = "## 驗收條件\n- [ ] works\n";

interface Assembly {
  handle: WatchedServeHandle;
  world: FakeLinearWorld;
  workspaces: FakeWorkspaces;
  stopFakeLinear: () => void;
}

async function assemble(options: {
  seed?: (world: FakeLinearWorld) => void;
  failFirst?: number;
  delayMs?: number;
  maxRunning?: number;
  port?: number;
  intervalMs?: number;
  retries?: { attempt: number; message: string }[];
  feedLookups?: { count: number };
}): Promise<Assembly> {
  const world = standardWorld("test-key");
  if (options.failFirst !== undefined) world.failFirst = options.failFirst;
  if (options.delayMs !== undefined) world.delayMs = options.delayMs;
  options.seed?.(world);
  const fake = startFakeLinear(world);
  const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url });
  const config = parseDispatchConfig({
    project: "igniter",
    team: "Starcoder",
    max_running: options.maxRunning ?? 2,
  });
  // Production layout: decisions append under <repoRoot>/.igniter/.
  const repoRoot = mkdtempSync(join(tmpdir(), "igniter-watched-"));
  mkdirSync(join(repoRoot, ".igniter"), { recursive: true });
  const workspaces = new FakeWorkspaces();
  const lookups = options.feedLookups;
  const handle = await startWatchedServe({
    repoRoot,
    config,
    client,
    workspaces,
    git: new FakeGit(),
    port: options.port ?? 0,
    intervalMs: options.intervalMs ?? 60_000,
    retry: {
      maxAttempts: 30,
      baseDelayMs: 5,
      onRetry: (attempt, error) => {
        options.retries?.push({ attempt, message: error.message });
      },
    },
    feed: {
      retryMs: 1,
      sleep: () => Bun.sleep(1),
      lookupPath: async () => {
        if (lookups) lookups.count += 1;
        throw new Error("no herdr daemon in tests");
      },
    },
    print: () => {},
  });
  return { handle, world, workspaces, stopFakeLinear: () => fake.stop() };
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const port = probe.port;
  probe.stop();
  if (port === undefined) throw new Error("probe has no port");
  return port;
}

async function waitFor(label: string, cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

/**
 * The watch loop polls once immediately at startup, so a ticket seeded
 * before assembly belongs to the loop. Command tests instead wait out that
 * first poll on an empty world then add their ticket: with a long interval
 * no second poll can steal it before the POST lands.
 */
async function waitForFirstPoll(handle: WatchedServeHandle): Promise<void> {
  await waitFor("first poll", () => handle.watcher.lastPollAt !== null);
}

/**
 * Decision lines are recorded after the Linear writes they describe, so a
 * log line proves the whole transition settled: workspace, labels, and all.
 * Waiting on the workspace or the Linear state instead would race the lines
 * asserted below.
 */
async function waitForLog(handle: WatchedServeHandle, needle: string): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const lines = await readActivityTail(handle.logPath, 100);
    if (lines.some((line) => line.includes(needle))) return lines;
    if (Date.now() > deadline) throw new Error(`timed out waiting for log line ${needle}`);
    await Bun.sleep(10);
  }
}

async function postCommand(
  base: string,
  argv: string[],
): Promise<{ status: number; payload: { ok: boolean; text: string } }> {
  const res = await fetch(`${base}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ argv }),
  });
  return { status: res.status, payload: (await res.json()) as { ok: boolean; text: string } };
}

describe("watched serve startup", () => {
  test("the UI stays up while Linear is unreachable, then validation retries into a live board", async () => {
    const world = standardWorld("test-key");
    world.failFirst = 2;
    world.delayMs = 50;
    const fake = startFakeLinear(world);
    try {
      const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url });
      const config = parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 2 });
      const repoRoot = mkdtempSync(join(tmpdir(), "igniter-watched-"));
      mkdirSync(join(repoRoot, ".igniter"), { recursive: true });
      const port = freePort();
      const retries: number[] = [];
      let servingPort: number | undefined;
      const pending = startWatchedServe({
        repoRoot,
        config,
        client,
        workspaces: new FakeWorkspaces(),
        git: new FakeGit(),
        port,
        intervalMs: 60_000,
        retry: { maxAttempts: 30, baseDelayMs: 5, onRetry: (attempt) => retries.push(attempt) },
        feed: {
          retryMs: 1,
          sleep: () => Bun.sleep(1),
          lookupPath: async () => {
            throw new Error("no herdr daemon in tests");
          },
        },
        onServer: (server) => {
          servingPort = server.port;
        },
        print: () => {},
      });
      // The server answers before validation finishes: health is already
      // up while the board still reports dispatch starting.
      const settledFirst = await Promise.race([
        pending.then(() => "ready" as const),
        (async () => {
          const deadline = Date.now() + 10_000;
          for (;;) {
            try {
              const res = await fetch(`http://127.0.0.1:${port}/api/health`);
              if (res.status === 200) return "health" as const;
            } catch {
              // Not listening yet.
            }
            if (Date.now() > deadline) throw new Error("health never came up during retry");
            await Bun.sleep(10);
          }
        })(),
      ]);
      expect(settledFirst).toBe("health");
      // The shell's onServer fired before validation finished: the address
      // log and the signal handlers exist while Linear is still down.
      expect(servingPort).toBe(port);
      expect((await fetch(`http://127.0.0.1:${port}/api/board`)).status).toBe(503);
      const early = await postCommand(`http://127.0.0.1:${port}`, ["status"]);
      expect(early.status).toBe(200);
      expect(early.payload).toMatchObject({ ok: false, text: "dispatch still starting; retry shortly" });
      const handle = await pending;
      try {
        expect(retries).toEqual([1, 2]);
        const board = await fetch(`${handle.base}/api/board`);
        expect(board.status).toBe(200);
        expect(((await board.json()) as { tickets: unknown[] }).tickets).toEqual([]);
      } finally {
        await handle.stop();
      }
    } finally {
      fake.stop();
    }
  });

  test("a configuration error stops the server and throws", async () => {
    const world = standardWorld("test-key");
    const fake = startFakeLinear(world);
    try {
      const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url });
      const config = parseDispatchConfig({ project: "nope", team: "Starcoder" });
      const repoRoot = mkdtempSync(join(tmpdir(), "igniter-watched-"));
      mkdirSync(join(repoRoot, ".igniter"), { recursive: true });
      const port = freePort();
      await expect(
        startWatchedServe({
          repoRoot,
          config,
          client,
          workspaces: new FakeWorkspaces(),
          git: new FakeGit(),
          port,
          retry: { maxAttempts: 3, baseDelayMs: 1 },
          feed: {
            lookupPath: async () => {
              throw new Error("no herdr daemon in tests");
            },
          },
          print: () => {},
        }),
      ).rejects.toThrow('project "nope" was not found');
      await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
    } finally {
      fake.stop();
    }
  });
});

describe("watched serve dispatch", () => {
  test("a restart adopts the orphan the crash left behind", async () => {
    const { handle, world, workspaces, stopFakeLinear } = await assemble({
      seed: (w) => {
        addIssue(w, { identifier: "STA-9", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      },
      intervalMs: 10,
    });
    try {
      // The watch loop adopts the Build ticket that has no workspace.
      // Adoption never writes Linear: the Progress label stays exactly as
      // the ticket carries it, and the workspace mirrors that same state.
      await waitForLog(handle, "STA-9 adopted:");
      expect(world.issues[0]!.stateId).toBe(BUILD);
      expect(world.issues[0]!.labelIds).toEqual([IN_PROGRESS]);
      expect(workspaces.tokensFor("STA-9")).toMatchObject({
        ticket: "STA-9",
        status: "build",
        progress: "in_progress",
      });
      const activity = (await (await fetch(`${handle.base}/api/activity?limit=20`)).json()) as {
        lines: string[];
      };
      expect(activity.lines.join("\n")).toContain(
        "STA-9 adopted: no workspace found, reopened (ws-1) at build+in_progress (Linear kept)",
      );
    } finally {
      await handle.stop();
      stopFakeLinear();
    }
  });

  test("two concurrent starts claim once; the loser is refused, never duplicated", async () => {
    const { handle, world, workspaces, stopFakeLinear } = await assemble({});
    try {
      await waitForFirstPoll(handle);
      addIssue(world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const [first, second] = await Promise.all([
        postCommand(handle.base, ["start", "STA-1"]),
        postCommand(handle.base, ["start", "STA-1"]),
      ]);
      const won = [first, second].filter((r) => r.payload.ok);
      const lost = [first, second].filter((r) => !r.payload.ok);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(won).toHaveLength(1);
      expect(won[0]!.payload.text).toContain("claimed STA-1");
      expect(lost).toHaveLength(1);
      expect(lost[0]!.payload.text).toContain("already running");
      // The shared claim lock held: exactly one workspace, one commander.
      expect(workspaces.workspaces.filter((w) => !w.closed)).toHaveLength(1);
      expect(workspaces.calls.filter((c) => c.method === "agent.start")).toHaveLength(1);
    } finally {
      await handle.stop();
      stopFakeLinear();
    }
  });

  test("the watch loop and a command share the one claim lock", async () => {
    const { handle, world, workspaces, stopFakeLinear } = await assemble({ intervalMs: 10 });
    try {
      await waitForFirstPoll(handle);
      addIssue(world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      // The loop ticks every 10ms while this command runs: the shared lock
      // serializes them, so one claimant wins and the other stands down.
      const cmd = await postCommand(handle.base, ["start", "STA-1"]);
      expect(cmd.status).toBe(200);
      // One claimant: the loop or the command won, never both.
      const lines = await waitForLog(handle, "claimed: Todo → Build");
      expect(workspaces.workspaces.filter((w) => !w.closed)).toHaveLength(1);
      expect(lines.filter((l) => l.includes("claimed: Todo → Build"))).toHaveLength(1);
      if (cmd.payload.ok) expect(cmd.payload.text).toContain("claimed STA-1");
      else expect(cmd.payload.text).toContain("already running");
    } finally {
      await handle.stop();
      stopFakeLinear();
    }
  });

  test("decisions and polls reach SSE subscribers", async () => {
    const { handle, world, stopFakeLinear } = await assemble({});
    const controller = new AbortController();
    try {
      await waitForFirstPoll(handle);
      addIssue(world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const res = await fetch(`${handle.base}/events`, { signal: controller.signal });
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      const readUntil = async (needle: string, timeoutMs = 10_000): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        let text = "";
        for (;;) {
          const next = await reader?.read();
          if (!next || next.done) throw new Error(`stream ended before ${needle}`);
          text += decoder.decode(next.value);
          if (text.includes(needle)) return;
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}`);
        }
      };
      await readUntil("event: ready");
      // A command records decisions: they re-broadcast as decision events.
      const started = await postCommand(handle.base, ["start", "STA-1"]);
      expect(started.payload.ok).toBe(true);
      await readUntil('event: decision\ndata: {"ticket":"STA-1"');
      // A poll completion re-broadcasts its timestamp as a poll event.
      await handle.watcher.pollOnce();
      await readUntil("event: poll");
      await reader?.cancel();
    } finally {
      controller.abort();
      await handle.stop();
      stopFakeLinear();
    }
  });

  test("stop closes the server, the watch loop, and the feed; the log survives", async () => {
    const feedLookups = { count: 0 };
    // Criteria-less: the loop alone records decision lines, so no command
    // races the background polls for this ticket.
    const { handle, workspaces, stopFakeLinear } = await assemble({
      seed: (w) => {
        addIssue(w, { identifier: "STA-1", stateId: TODO, priority: 1, description: "plans", labelIds: [PENDING] });
      },
      intervalMs: 10,
      feedLookups,
    });
    await waitFor("background polls", () => workspaces.snapshotCalls >= 3);
    await waitFor("feed retries", () => feedLookups.count >= 1);
    await waitForLog(handle, "STA-1 skipped: no acceptance criteria");
    await handle.stop();
    // After stop settles no poll is in flight and the timer is clear, so
    // two settled readings must agree.
    await Bun.sleep(120);
    const settledPolls = workspaces.snapshotCalls;
    const settledLookups = feedLookups.count;
    await Bun.sleep(120);
    expect(workspaces.snapshotCalls).toBe(settledPolls);
    expect(feedLookups.count).toBe(settledLookups);
    await expect(fetch(`${handle.base}/api/health`)).rejects.toThrow();
    // Decisions outlive the process in the repo-root log.
    expect(await readActivityTail(handle.logPath, 100)).toContainEqual(
      expect.stringContaining("STA-1 skipped: no acceptance criteria"),
    );
    stopFakeLinear();
  });
});
