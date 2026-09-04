// Dispatch acceptance against a fake Linear endpoint: no network, no real
// credentials, no real project. One process, one claimant: Herdr answers
// "is it running" through a fake workspace set.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAIM_MARKER,
  MISSING_MARKER,
  MissingCriteriaError,
  RunningFullError,
  createClaimLock,
  createDispatchLog,
  hasAcceptanceCriteria,
  readActivityTail,
  sortCandidates,
  startWatch,
  validateStartup,
  validateWithRetry,
  Watcher,
  type DecisionLog,
  type ResolvedDispatch,
} from "./claims";
import { parseDispatchConfig } from "./config";
import { LinearClient, LinearError, requireLinearApiKey } from "./linear";
import { addIssue, standardWorld, startFakeLinear, type FakeLinearHandle } from "./fake-linear";
import type { RunningWorkspaces } from "./workspaces";

const READY = "st-ready";
const BUILDING = "st-building";
const TODO = "st-todo";
const DONE = "st-done";
const CRITERIA = "## 驗收條件\n- [ ] works\n";

interface Setup {
  fake: FakeLinearHandle;
  client: LinearClient;
  resolved: ResolvedDispatch;
}

async function setup(maxRunning = 3): Promise<Setup> {
  const world = standardWorld("test-key");
  const fake = startFakeLinear(world);
  const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url });
  const resolved = await validateStartup(
    client,
    parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: maxRunning }),
  );
  return { fake, client, resolved };
}

function workspacesWith(...identifiers: string[]): RunningWorkspaces {
  return { runningTickets: async () => new Set(identifiers) };
}

interface Watched {
  watcher: Watcher;
  seen: string[];
  lines: string[];
}

function watch(
  client: LinearClient,
  resolved: ResolvedDispatch,
  opts: { host?: string; workspaces?: RunningWorkspaces; decisions?: DecisionLog; lines?: string[] } = {},
): Watched {
  const seen: string[] = [];
  const lines = opts.lines ?? [];
  const watcher = new Watcher({
    client,
    resolved,
    host: opts.host ?? "h",
    sink: (t) => {
      seen.push(t.identifier);
    },
    decisions: opts.decisions ?? {
      record: async (ticket, message) => {
        lines.push(`${ticket} ${message}`);
      },
    },
    workspaces: opts.workspaces ?? workspacesWith(),
  });
  return { watcher, seen, lines };
}

describe("validateStartup", () => {
  test("maps configured names to Linear state ids", async () => {
    const { fake, resolved } = await setup();
    try {
      expect(resolved.projectId).toBe("proj-1");
      expect(resolved.teamName).toBe("Starcoder");
      expect(resolved.queuedStateId).toBe(READY);
      expect(resolved.buildingStateId).toBe(BUILDING);
    } finally {
      fake.stop();
    }
  });

  test("unknown status name fails startup with the team in the message", async () => {
    const { fake, client } = await setup();
    try {
      await expect(
        validateStartup(client, parseDispatchConfig({ project: "igniter", team: "Starcoder", states: { queued: "Nope" } })),
      ).rejects.toThrow('status "Nope" (states.queued) does not exist on team "Starcoder"');
    } finally {
      fake.stop();
    }
  });

  test("missing project fails startup", async () => {
    const { fake, client } = await setup();
    try {
      await expect(
        validateStartup(client, parseDispatchConfig({ project: "nope", team: "Starcoder" })),
      ).rejects.toThrow('project "nope" was not found in Linear');
    } finally {
      fake.stop();
    }
  });

  test("missing team fails startup", async () => {
    const { fake, client } = await setup();
    try {
      await expect(
        validateStartup(client, parseDispatchConfig({ project: "igniter", team: "Nope" })),
      ).rejects.toThrow('team "Nope" was not found in Linear');
    } finally {
      fake.stop();
    }
  });

  test("multi-team project without a team fails startup", async () => {
    const world = standardWorld("test-key");
    world.teams.push({ id: "team-2", name: "Other", key: "OTH" });
    world.projects[0]!.teamIds.push("team-2");
    const fake = startFakeLinear(world);
    try {
      const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url });
      await expect(
        validateStartup(client, parseDispatchConfig({ project: "igniter" })),
      ).rejects.toThrow('spans 2 teams; set "team"');
    } finally {
      fake.stop();
    }
  });

  test("missing LINEAR_API_KEY fails before any network use", () => {
    const saved = process.env["LINEAR_API_KEY"];
    delete process.env["LINEAR_API_KEY"];
    try {
      expect(() => requireLinearApiKey()).toThrow("LINEAR_API_KEY is not set");
    } finally {
      if (saved !== undefined) process.env["LINEAR_API_KEY"] = saved;
    }
  });
});

describe("hasAcceptanceCriteria", () => {
  test("detects Chinese and English sections, rejects the rest", () => {
    expect(hasAcceptanceCriteria("## 驗收條件\n- [ ] x")).toBe(true);
    expect(hasAcceptanceCriteria("## Acceptance criteria\n- [ ] x")).toBe(true);
    expect(hasAcceptanceCriteria("### Acceptance criterion\n- [ ] x")).toBe(true);
    expect(hasAcceptanceCriteria(null)).toBe(false);
    expect(hasAcceptanceCriteria("## 驗收\n- [ ] x")).toBe(false);
    expect(hasAcceptanceCriteria("no sections here")).toBe(false);
  });
});

describe("sortCandidates", () => {
  test("urgent first, no-priority last, oldest waiting breaks ties", () => {
    const base = {
      id: "x", title: "t", description: null, projectId: "proj-1",
      state: { id: READY, name: "Ready to build" },
    };
    const issues = [
      { ...base, id: "a", identifier: "STA-1", priority: 3, updatedAt: "2026-09-04T00:00:01.000Z" },
      { ...base, id: "b", identifier: "STA-2", priority: 1, updatedAt: "2026-09-04T00:00:03.000Z" },
      { ...base, id: "c", identifier: "STA-3", priority: 0, updatedAt: "2026-09-04T00:00:01.000Z" },
      { ...base, id: "d", identifier: "STA-4", priority: 2, updatedAt: "2026-09-04T00:00:05.000Z" },
      { ...base, id: "e", identifier: "STA-5", priority: 2, updatedAt: "2026-09-04T00:00:02.000Z" },
    ];
    expect(sortCandidates(issues).map((i) => i.identifier)).toEqual(
      ["STA-2", "STA-5", "STA-4", "STA-1", "STA-3"],
    );
  });
});

describe("watch claiming", () => {
  test("a ready ticket with criteria is claimed within one poll", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: READY, priority: 2, description: CRITERIA });
      const { watcher, seen, lines } = watch(client, resolved, { host: "test-host" });
      const result = await watcher.pollOnce();
      expect(result.claimed.map((t) => t.identifier)).toEqual(["STA-1"]);
      expect(result.claimed[0]).toMatchObject({ host: "test-host", slot: 0 });
      expect(seen).toEqual(["STA-1"]);
      const issue = fake.world.issues[0]!;
      expect(issue.stateId).toBe(BUILDING);
      const claims = issue.comments.filter((c) => c.body.includes(CLAIM_MARKER));
      expect(claims).toHaveLength(1);
      expect(claims[0]!.body).toContain("host=test-host slot=0 at ");
      expect(lines).toEqual([
        "STA-1 claimed: Ready to build → Building (slot 0)",
        "STA-1 state: Ready to build → Building",
      ]);
      expect(watcher.lastPollAt).not.toBeNull();
      expect(watcher.lastQueue).toEqual([
        { identifier: "STA-1", title: "STA-1", priority: 2, reason: "next" },
      ]);
      expect(result.running).toEqual(["STA-1"]);
    } finally {
      fake.stop();
    }
  });

  test("claims follow priority order in a single poll", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: READY, priority: 3, description: CRITERIA });
      addIssue(fake.world, { identifier: "STA-2", stateId: READY, priority: 1, description: CRITERIA });
      addIssue(fake.world, { identifier: "STA-3", stateId: READY, priority: 2, description: CRITERIA });
      const { watcher } = watch(client, resolved);
      const result = await watcher.pollOnce();
      expect(result.claimed.map((t) => t.identifier)).toEqual(["STA-2", "STA-3", "STA-1"]);
      expect(result.claimed.map((t) => t.slot)).toEqual([0, 1, 2]);
    } finally {
      fake.stop();
    }
  });

  test("full queue waits; the next ticket is claimed after one finishes", async () => {
    const { fake, client, resolved } = await setup(1);
    try {
      const first = addIssue(fake.world, { identifier: "STA-1", stateId: READY, priority: 2, description: CRITERIA });
      addIssue(fake.world, { identifier: "STA-2", stateId: READY, priority: 2, description: CRITERIA });
      const { watcher, lines } = watch(client, resolved, { workspaces: workspacesWith("STA-1") });
      expect((await watcher.pollOnce()).claimed.map((t) => t.identifier)).toEqual(["STA-1"]);
      // The claiming poll also records the queue blocking behind it.
      expect(lines).toEqual([
        "STA-1 claimed: Ready to build → Building (slot 0)",
        "STA-1 state: Ready to build → Building",
        "STA-2 waiting: slots full (1 running)",
      ]);
      // A fresh watcher recovers the cap from Linear; the queue blocks with
      // one transition line, then consecutive polls stay silent.
      const blocked = watch(client, resolved, { workspaces: workspacesWith("STA-1") });
      expect((await blocked.watcher.pollOnce()).claimed).toEqual([]);
      expect(blocked.lines).toEqual(["STA-2 waiting: slots full (1 running)"]);
      expect((await blocked.watcher.pollOnce()).claimed).toEqual([]);
      expect(blocked.lines).toHaveLength(1);
      await client.setIssueState(first.id, DONE);
      const recovered = watch(client, resolved);
      expect((await recovered.watcher.pollOnce()).claimed.map((t) => t.identifier)).toEqual(["STA-2"]);
    } finally {
      fake.stop();
    }
  });

  test("a ticket without criteria is not claimed and gets one nudge comment", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-9", stateId: READY, priority: 1, description: "no sections" });
      const { watcher, lines } = watch(client, resolved);
      expect((await watcher.pollOnce()).claimed).toEqual([]);
      const issue = fake.world.issues[0]!;
      expect(issue.stateId).toBe(READY);
      expect(issue.comments.filter((c) => c.body.includes(MISSING_MARKER))).toHaveLength(1);
      expect(lines).toEqual(["STA-9 skipped: no acceptance criteria"]);
      expect((await watcher.pollOnce()).claimed).toEqual([]);
      expect(issue.comments.filter((c) => c.body.includes(MISSING_MARKER))).toHaveLength(1);
      expect(lines).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });

  test("the queue snapshot carries a reason per ticket", async () => {
    const { fake, client, resolved } = await setup(2);
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: READY, priority: 3, description: CRITERIA });
      addIssue(fake.world, { identifier: "STA-2", stateId: READY, priority: 1, description: "no sections" });
      addIssue(fake.world, { identifier: "STA-3", stateId: READY, priority: 2, description: CRITERIA });
      addIssue(fake.world, { identifier: "STA-4", stateId: READY, priority: 4, description: CRITERIA });
      const { watcher } = watch(client, resolved);
      const result = await watcher.pollOnce();
      expect(result.claimed.map((t) => t.identifier)).toEqual(["STA-3", "STA-1"]);
      expect(watcher.lastQueue.map((e) => [e.identifier, e.reason])).toEqual([
        ["STA-2", "skipped: no acceptance criteria"],
        ["STA-3", "next"],
        ["STA-1", "next"],
        ["STA-4", "waiting, slots full"],
      ]);
    } finally {
      fake.stop();
    }
  });
});

describe("restart recovery", () => {
  test("a running ticket is left alone: no sink, no lines, no comments", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, {
        identifier: "STA-1",
        stateId: BUILDING,
        priority: 1,
        description: CRITERIA,
        comments: [{ id: "c-claim", body: `${CLAIM_MARKER}\nClaimed by host=h slot=0 at 2026-09-04T00:00:01.000Z.` }],
      });
      const { watcher, seen, lines } = watch(client, resolved, { workspaces: workspacesWith("STA-1") });
      const result = await watcher.pollOnce();
      expect(result.claimed).toEqual([]);
      expect(seen).toEqual([]);
      expect(lines).toEqual([]);
      expect(result.running).toEqual(["STA-1"]);
      expect(fake.world.issues[0]!.comments).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });

  test("a half-claimed ticket with no comment is finished, not re-queued", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const { watcher, seen, lines } = watch(client, resolved);
      const result = await watcher.pollOnce();
      expect(result.claimed.map((t) => t.identifier)).toEqual(["STA-1"]);
      expect(seen).toEqual(["STA-1"]);
      expect(lines).toEqual(["STA-1 resumed: no workspace found (slot 0)"]);
      expect(fake.world.issues[0]!.comments.filter((c) => c.body.includes(CLAIM_MARKER))).toHaveLength(1);
      // The handoff is remembered this run: the next poll stays quiet.
      expect((await watcher.pollOnce()).claimed).toEqual([]);
      expect(seen).toEqual(["STA-1"]);
      expect(lines).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });

  test("a comment without a workspace hands off again, without a duplicate comment", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, {
        identifier: "STA-1",
        stateId: BUILDING,
        priority: 1,
        description: CRITERIA,
        comments: [{ id: "c-claim", body: `${CLAIM_MARKER}\nClaimed by host=h slot=0 at 2026-09-04T00:00:01.000Z.` }],
      });
      const { watcher, seen, lines } = watch(client, resolved);
      const result = await watcher.pollOnce();
      expect(result.claimed.map((t) => t.identifier)).toEqual(["STA-1"]);
      expect(seen).toEqual(["STA-1"]);
      expect(lines).toEqual(["STA-1 resumed: no workspace found (slot 0)"]);
      expect(fake.world.issues[0]!.comments.filter((c) => c.body.includes(CLAIM_MARKER))).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });
});

describe("claimDirect (forwarded start)", () => {
  test("claims directly from any state, skipping the queue", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-7", stateId: TODO, priority: 4, description: CRITERIA });
      const { watcher, seen, lines } = watch(client, resolved);
      const out = await watcher.claimDirect("STA-7", {
        agent: "builder",
        builder: "opencode/muse-spark-1.3-contributor-free",
      });
      expect(out.already).toBe(false);
      expect(out.ticket).toMatchObject({ identifier: "STA-7", slot: 0, agent: "builder" });
      expect(seen).toEqual(["STA-7"]);
      expect(fake.world.issues[0]!.stateId).toBe(BUILDING);
      expect(lines).toEqual([
        "STA-7 claimed: Todo → Building (slot 0)",
        "STA-7 state: Todo → Building",
      ]);
    } finally {
      fake.stop();
    }
  });

  test("refuses with the running list when the queue is full", async () => {
    const { fake, client, resolved } = await setup(1);
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      addIssue(fake.world, { identifier: "STA-2", stateId: READY, priority: 1, description: CRITERIA });
      const { watcher, lines } = watch(client, resolved, { workspaces: workspacesWith("STA-1") });
      const error = await watcher.claimDirect("STA-2", {}).catch((e) => e);
      expect(error).toBeInstanceOf(RunningFullError);
      expect((error as RunningFullError).tickets).toEqual(["STA-1"]);
      expect(fake.world.issues[1]!.stateId).toBe(READY);
      expect(lines).toEqual(["STA-2 refused: at max_running (1); running: STA-1"]);
    } finally {
      fake.stop();
    }
  });

  test("missing criteria is refused with a nudge comment", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-3", stateId: TODO, priority: 1, description: "nothing" });
      const { watcher } = watch(client, resolved);
      await expect(watcher.claimDirect("STA-3", {})).rejects.toBeInstanceOf(MissingCriteriaError);
      const issue = fake.world.issues[0]!;
      expect(issue.stateId).toBe(TODO);
      expect(issue.comments.some((c) => c.body.includes(MISSING_MARKER))).toBe(true);
    } finally {
      fake.stop();
    }
  });

  test("a running ticket reports already, an abandoned one is adopted", async () => {
    const { fake, client, resolved } = await setup(1);
    try {
      addIssue(fake.world, {
        identifier: "STA-4",
        stateId: BUILDING,
        priority: 1,
        description: CRITERIA,
        comments: [{ id: "c-claim", body: `${CLAIM_MARKER}\nClaimed by host=h slot=0 at 2026-09-04T00:00:01.000Z.` }],
      });
      const running = watch(client, resolved, { workspaces: workspacesWith("STA-4") });
      expect((await running.watcher.claimDirect("STA-4", {})).already).toBe(true);
      expect(running.seen).toEqual([]);

      const abandoned = watch(client, resolved);
      const out = await abandoned.watcher.claimDirect("STA-4", {});
      expect(out.already).toBe(false);
      expect(out.ticket).toMatchObject({ identifier: "STA-4", slot: 0 });
      expect(abandoned.seen).toEqual(["STA-4"]);
    } finally {
      fake.stop();
    }
  });
});

describe("decision log", () => {
  test("decisions append to the file and print; polls stay silent; restarts keep history", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: READY, priority: 1, description: CRITERIA });
      const dir = mkdtempSync(join(tmpdir(), "igniter-log-"));
      const logPath = join(dir, "dispatch.log");
      const printed: string[] = [];
      const { watcher } = watch(client, resolved, {
        decisions: createDispatchLog(logPath, (line) => {
          printed.push(line);
        }),
      });
      await watcher.pollOnce();
      const file = Bun.file(logPath);
      expect(await file.exists()).toBe(true);
      const logged = (await file.text()).split("\n").filter(Boolean);
      expect(logged).toHaveLength(2);
      expect(printed).toHaveLength(2);
      expect(logged).toEqual(printed);
      expect(logged[0]).toMatch(/^\S+ STA-1 claimed: Ready to build → Building \(slot 0\)$/);
      await watcher.pollOnce();
      await watcher.pollOnce();
      expect((await file.text()).split("\n").filter(Boolean)).toHaveLength(2);
      expect(printed).toHaveLength(2);
      // A restart reads the same file: history survives.
      expect(await readActivityTail(logPath, 100)).toEqual(logged);
      expect(await readActivityTail(logPath, 1)).toEqual(logged.slice(-1));
      expect(await readActivityTail(join(dir, "missing.log"), 100)).toEqual([]);
    } finally {
      fake.stop();
    }
  });

  test("a failing claim logs once and aborts the poll", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: READY, priority: 1, description: CRITERIA });
      fake.world.failNextComment = true;
      const { watcher, lines } = watch(client, resolved);
      await expect(watcher.pollOnce()).rejects.toThrow("rate limited");
      expect(lines).toEqual(["STA-1 claim failed: Linear GraphQL error: rate limited"]);
      // Recovery next poll hands off with a resumed line, exactly once.
      const result = await watcher.pollOnce();
      expect(result.claimed.map((t) => t.identifier)).toEqual(["STA-1"]);
      expect(lines).toEqual([
        "STA-1 claim failed: Linear GraphQL error: rate limited",
        "STA-1 resumed: no workspace found (slot 0)",
      ]);
    } finally {
      fake.stop();
    }
  });
});

describe("createClaimLock", () => {
  test("concurrent claims serialize instead of overlapping", async () => {
    const lock = createClaimLock();
    let concurrent = 0;
    let maxSeen = 0;
    const job = () =>
      lock(async () => {
        concurrent += 1;
        maxSeen = Math.max(maxSeen, concurrent);
        await Bun.sleep(20);
        concurrent -= 1;
      });
    await Promise.all([job(), job(), job()]);
    expect(maxSeen).toBe(1);
    expect(concurrent).toBe(0);
  });
});

describe("secret handling", () => {
  test("the key travels in the header only and never leaks into errors", async () => {
    const { fake } = await setup();
    try {
      const bad = new LinearClient({ apiKey: "super-secret-xyz", endpoint: fake.url });
      let failure: Error | null = null;
      try {
        await bad.listTeams();
      } catch (e) {
        failure = e as Error;
      }
      expect(failure).not.toBeNull();
      expect((failure as Error).message).not.toContain("super-secret-xyz");

      const good = new LinearClient({ apiKey: "test-key", endpoint: fake.url });
      await good.listTeams();
      expect(fake.sawKeyOutsideHeader).toBe(false);
    } finally {
      fake.stop();
    }
  });
});

describe("startWatch", () => {
  test("stop waits for an in-flight poll to settle", async () => {
    const world = standardWorld("test-key");
    world.delayMs = 30;
    const fake = startFakeLinear(world);
    try {
      addIssue(world, { identifier: "STA-1", stateId: READY, priority: 1, description: CRITERIA });
      const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url });
      const resolved = await validateStartup(
        client,
        parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 1 }),
      );
      const { watcher, seen } = watch(client, resolved);
      const handle = startWatch({ watcher, intervalMs: 5 });
      await Bun.sleep(60);
      await handle.stop();
      expect(seen).toEqual(["STA-1"]);
    } finally {
      fake.stop();
    }
  });

  test("polls never overlap and network failure is not fatal", async () => {
    const world = standardWorld("test-key");
    world.delayMs = 40;
    const fake = startFakeLinear(world);
    try {
      addIssue(world, { identifier: "STA-1", stateId: READY, priority: 1, description: CRITERIA });
      const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url });
      const resolved = await validateStartup(
        client,
        parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 1 }),
      );
      const claimed: string[] = [];
      const watcher = new Watcher({
        client,
        resolved,
        host: "h",
        sink: (t) => {
          claimed.push(t.identifier);
        },
      });
      const handle = startWatch({ watcher, intervalMs: 5 });
      await Bun.sleep(350);
      await handle.stop();
      expect(claimed).toEqual(["STA-1"]);
      expect(fake.maxConcurrent).toBe(1);

      const failing = new LinearClient({ apiKey: "k", endpoint: "http://127.0.0.1:1/graphql" });
      const errors: string[] = [];
      const badWatcher = new Watcher({ client: failing, resolved, host: "h" });
      const bad = startWatch({
        watcher: badWatcher,
        intervalMs: 10,
        onError: (e) => {
          errors.push(e.message);
        },
      });
      await Bun.sleep(80);
      await bad.stop();
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      fake.stop();
    }
  });

  test("rate limits cool the loop down instead of hammering", async () => {
    const world = standardWorld("test-key");
    const fake = startFakeLinear(world);
    try {
      const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url });
      const resolved = await validateStartup(
        client,
        parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 1 }),
      );
      world.failRateLimitFirst = 1000;
      const errors: string[] = [];
      const { watcher } = watch(client, resolved);
      const handle = startWatch({
        watcher,
        intervalMs: 10,
        rateLimitCooldownMs: 200,
        onError: (e) => {
          errors.push(e.message);
        },
      });
      await Bun.sleep(450);
      await handle.stop();
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((e) => e.includes("cooling down"))).toBe(true);
      expect(fake.requests).toBeLessThan(10);
    } finally {
      fake.stop();
    }
  });
});

describe("hung Linear", () => {
  function resolvedStub(): ResolvedDispatch {
    return {
      config: parseDispatchConfig({ project: "igniter", team: "Starcoder" }),
      projectId: "proj-1",
      teamId: "team-1",
      teamName: "Starcoder",
      queuedStateId: "st-ready",
      buildingStateId: "st-building",
      reviewStateId: "st-review",
      failedStateId: "st-todo",
    };
  }

  test("a hung connection settles the poll instead of parking the watch", async () => {
    const hanging = () => new Promise<Response>(() => {});
    const client = new LinearClient({ apiKey: "k", endpoint: "http://127.0.0.1:1/graphql", fetchImpl: hanging, timeoutMs: 50 });
    const { watcher } = watch(client, resolvedStub());
    await expect(watcher.pollOnce()).rejects.toThrow("timed out");
    await expect(watcher.pollOnce()).rejects.toThrow("timed out");
  });

  test("the interval keeps ticking through hung polls", async () => {
    const hanging = () => new Promise<Response>(() => {});
    const client = new LinearClient({ apiKey: "k", endpoint: "http://127.0.0.1:1/graphql", fetchImpl: hanging, timeoutMs: 30 });
    const errors: string[] = [];
    const { watcher } = watch(client, resolvedStub());
    const handle = startWatch({
      watcher,
      intervalMs: 10,
      onError: (e) => {
        errors.push(e.message);
      },
    });
    await Bun.sleep(150);
    await handle.stop();
    expect(errors.length).toBeGreaterThan(1);
    expect(errors.every((e) => e.includes("timed out"))).toBe(true);
  });
});

describe("fake variable validation", () => {
  test("filter variables declared as String! are rejected before execution", async () => {
    const { fake } = await setup();
    try {
      const res = await fetch(fake.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "test-key" },
        body: JSON.stringify({
          query: "query($projectId: String!, $stateId: String!, $first: Int!) { issues(filter: {}) { nodes { id } } }",
          variables: {},
        }),
      });
      const payload = (await res.json()) as { errors?: { message: string }[] };
      expect(payload.errors?.[0]?.message).toContain("expecting type ID!");
    } finally {
      fake.stop();
    }
  });
});

describe("validateWithRetry", () => {
  test("waits out transient outages and still fails fast on config errors", async () => {
    const resolved = {} as ResolvedDispatch;
    let calls = 0;
    const retries: number[] = [];
    const out = await validateWithRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new LinearError(0, "down");
        return resolved;
      },
      { maxAttempts: 5, baseDelayMs: 1, onRetry: (n) => { retries.push(n); } },
    );
    expect(out).toBe(resolved);
    expect(retries).toEqual([1, 2]);
    const history: number[] = [];
    await expect(
      validateWithRetry(
        async () => { throw new Error("config error: nope"); },
        { maxAttempts: 5, baseDelayMs: 1, onRetry: (n) => { history.push(n); } },
      ),
    ).rejects.toThrow("config error: nope");
    expect(history).toEqual([]);
  });

  test("gives up after maxAttempts", async () => {
    await expect(
      validateWithRetry(
        async () => { throw new LinearError(500, "boom"); },
        { maxAttempts: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("boom");
  });

  test("a flapping Linear endpoint still validates once it answers", async () => {
    const world = standardWorld("test-key");
    world.failFirst = 2;
    const fake = startFakeLinear(world);
    try {
      const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url });
      const resolved = await validateWithRetry(
        () => validateStartup(client, parseDispatchConfig({ project: "igniter", team: "Starcoder" })),
        { maxAttempts: 5, baseDelayMs: 1 },
      );
      expect(resolved.projectId).toBe("proj-1");
    } finally {
      fake.stop();
    }
  });
});

describe("stalled body", () => {
  test("a body that never ends still settles", async () => {
    const world = standardWorld("test-key");
    world.stallBodyFirst = 1;
    const fake = startFakeLinear(world);
    try {
      const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url, timeoutMs: 100 });
      const started = Date.now();
      await expect(client.listTeams()).rejects.toThrow("timed out");
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      fake.stop();
    }
  });
});

describe("comment pagination", () => {
  test("comment checks see past the first page", async () => {
    const { fake, client, resolved } = await setup();
    try {
      const noise = Array.from({ length: 119 }, (_, i) => ({
        id: `noise-${i}`,
        body: `review note ${i}`,
      }));
      const issue = addIssue(fake.world, {
        identifier: "STA-1",
        stateId: BUILDING,
        priority: 1,
        description: CRITERIA,
        comments: [
          ...noise,
          { id: "comment-buried", body: `${CLAIM_MARKER}\nClaimed by host=h slot=0 at 2026-09-04T00:00:01.000Z.` },
        ],
      });
      const full = await client.fetchIssue(issue.id);
      expect(full?.comments).toHaveLength(120);
      // The buried claim comment still counts: no duplicate is written.
      const { watcher, seen } = watch(client, resolved, { workspaces: workspacesWith("STA-1") });
      expect((await watcher.pollOnce()).claimed).toEqual([]);
      expect(seen).toEqual([]);
      expect(fake.world.issues[0]!.comments).toHaveLength(120);
    } finally {
      fake.stop();
    }
  });
});

describe("start after watch", () => {
  test("a ticket the watch just claimed is already, not sunk twice", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: READY, priority: 1, description: CRITERIA });
      const { watcher, seen, lines } = watch(client, resolved);
      expect((await watcher.pollOnce()).claimed.map((t) => t.identifier)).toEqual(["STA-1"]);
      // No workspace in Herdr yet, but the in-run handoff mark answers.
      const out = await watcher.claimDirect("STA-1", { builder: "example/model" });
      expect(out.already).toBe(true);
      expect(seen).toEqual(["STA-1"]);
      expect(fake.world.issues[0]!.comments.filter((c) => c.body.includes(CLAIM_MARKER))).toHaveLength(1);
      expect(lines).toEqual([
        "STA-1 claimed: Ready to build → Building (slot 0)",
        "STA-1 state: Ready to build → Building",
      ]);
    } finally {
      fake.stop();
    }
  });
});
