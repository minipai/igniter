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
import { LinearClient, LinearError, requireLinearApiKey, type LinearIssue } from "./linear";
import { addIssue, standardWorld, startFakeLinear, type FakeLinearHandle } from "./fake-linear";
import { createWorkspaceSink } from "./commands";
import { FakeGit } from "./fake-git";
import { FakeWorkspaces } from "./fake-workspaces";
import type { CommandWorkspaces } from "./workspaces";

const READY = "st-ready";
const BUILDING = "st-building";
const REVIEW = "st-review";
const MERGE = "st-merge";
const DONE = "st-done";
const CANCELED = "st-canceled";
const CRITERIA = "## 驗收條件\n- [ ] works\n";

interface Setup {
  fake: FakeLinearHandle;
  client: LinearClient;
  resolved: ResolvedDispatch;
}

async function setup(maxRunning = 3, extra: Record<string, unknown> = {}): Promise<Setup> {
  const world = standardWorld("test-key");
  const fake = startFakeLinear(world);
  const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url });
  const resolved = await validateStartup(
    client,
    parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: maxRunning, ...extra }),
  );
  return { fake, client, resolved };
}

function workspacesWith(...identifiers: string[]): FakeWorkspaces {
  const fake = new FakeWorkspaces();
  for (const identifier of identifiers) fake.seedWorkspace(identifier);
  return fake;
}

interface Watched {
  watcher: Watcher;
  seen: string[];
  lines: string[];
}

function watch(
  client: LinearClient,
  resolved: ResolvedDispatch,
  opts: { host?: string; workspaces?: CommandWorkspaces; decisions?: DecisionLog; lines?: string[]; now?: () => number } = {},
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
    workspaces: opts.workspaces ?? new FakeWorkspaces(),
    ...(opts.now ? { now: opts.now } : {}),
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

  test("a merge state of the wrong workflow type fails startup", async () => {
    const world = standardWorld("test-key");
    world.statesByTeam["team-1"] = world.statesByTeam["team-1"]!.map((s) =>
      s.id === "st-merge" ? { ...s, type: "completed" } : s,
    );
    const fake = startFakeLinear(world);
    try {
      const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url });
      await expect(
        validateStartup(client, parseDispatchConfig({ project: "igniter", team: "Starcoder" })),
      ).rejects.toThrow('status "Ready to merge" (states.merge) must be a started-type state on team "Starcoder"');
    } finally {
      fake.stop();
    }
  });

  test("an unknown merge state name fails startup", async () => {
    const { fake, client } = await setup();
    try {
      await expect(
        validateStartup(client, parseDispatchConfig({ project: "igniter", team: "Starcoder", states: { merge: "Nope" } })),
      ).rejects.toThrow('status "Nope" (states.merge) does not exist on team "Starcoder"');
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

describe("paused tickets and slots", () => {
  test("a paused building ticket frees its slot for the next candidate", async () => {
    const { fake, client, resolved } = await setup(1);
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      addIssue(fake.world, { identifier: "STA-2", stateId: READY, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", { ticket: "STA-1", paused: "1" });
      const { watcher, seen } = watch(client, resolved, { workspaces });
      const result = await watcher.pollOnce();
      expect(result.claimed.map((t) => t.identifier)).toEqual(["STA-2"]);
      expect(seen).toEqual(["STA-2"]);
      // One snapshot per poll feeds both adoption and pause detection.
      expect(workspaces.snapshotCalls).toBe(1);
    } finally {
      fake.stop();
    }
  });

  test("without the pause the same poll would block", async () => {
    const { fake, client, resolved } = await setup(1);
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      addIssue(fake.world, { identifier: "STA-2", stateId: READY, priority: 1, description: CRITERIA });
      const { watcher, lines } = watch(client, resolved, { workspaces: workspacesWith("STA-1") });
      expect((await watcher.pollOnce()).claimed).toEqual([]);
      expect(lines).toEqual(["STA-2 waiting: slots full (1 running)"]);
    } finally {
      fake.stop();
    }
  });

  test("a paused ticket is never adopted as an orphan", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      // Paused but the workspace lookup misses it by label: tokens still win.
      workspaces.seedWorkspace("other-label", { ticket: "STA-1", paused: "1" }, { commander: false });
      const { watcher, seen, lines } = watch(client, resolved, { workspaces });
      // An unpaused ticket with no live workspace would be adopted here.
      expect((await watcher.pollOnce()).claimed).toEqual([]);
      expect(seen).toEqual([]);
      expect(lines).toEqual([]);
    } finally {
      fake.stop();
    }
  });
});

describe("stage tracking", () => {
  test("building + acceptance/owner pending moves to review with one line, then stays quiet", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", {
        ticket: "STA-1",
        stage: "acceptance",
        stage_at: "2026-09-05T11:48:00.000Z",
        owner_pending: "1",
      });
      const { watcher, seen, lines } = watch(client, resolved, { workspaces });
      const result = await watcher.pollOnce();
      expect(result.claimed).toEqual([]);
      expect(seen).toEqual([]);
      expect(fake.world.issues[0]!.stateId).toBe(REVIEW);
      expect(lines).toEqual(["STA-1 state: Building → Ready to review (stage acceptance, owner pending)"]);
      expect(workspaces.snapshotCalls).toBe(1);
      await watcher.pollOnce();
      expect(fake.world.issues[0]!.stateId).toBe(REVIEW);
      expect(lines).toHaveLength(1);
      expect(workspaces.snapshotCalls).toBe(2);
    } finally {
      fake.stop();
    }
  });

  test("building at acceptance without owner pending stays put", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", { ticket: "STA-1", stage: "acceptance" });
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      expect(fake.world.issues[0]!.stateId).toBe(BUILDING);
      expect(lines).toEqual([]);
    } finally {
      fake.stop();
    }
  });

  test("review + stage back to build moves to building with one line", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: REVIEW, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", { ticket: "STA-1", stage: "build", review_count: "1" });
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      expect(fake.world.issues[0]!.stateId).toBe(BUILDING);
      expect(lines).toEqual(["STA-1 state: Ready to review → Building (stage back to build)"]);
      await watcher.pollOnce();
      expect(fake.world.issues[0]!.stateId).toBe(BUILDING);
      expect(lines).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });

  test("review + stage back to verify moves to building", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: REVIEW, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", { ticket: "STA-1", stage: "verify", verify_count: "1" });
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      expect(fake.world.issues[0]!.stateId).toBe(BUILDING);
      expect(lines).toEqual(["STA-1 state: Ready to review → Building (stage back to verify)"]);
    } finally {
      fake.stop();
    }
  });

  test("review + stage acceptance stays in review", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: REVIEW, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", { ticket: "STA-1", stage: "acceptance", owner_pending: "1" });
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      expect(fake.world.issues[0]!.stateId).toBe(REVIEW);
      expect(lines).toEqual([]);
    } finally {
      fake.stop();
    }
  });

  test("ready to merge + open workspace stamps delivered once and clears owner pending", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: MERGE, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      const seeded = workspaces.seedWorkspace("STA-1", {
        ticket: "STA-1",
        stage: "acceptance",
        stage_at: "2026-09-05T10:00:00.000Z",
        owner_pending: "1",
      });
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      const tokens = workspaces.tokensFor("STA-1");
      expect(tokens["stage"]).toBe("delivered");
      expect(tokens).not.toHaveProperty("owner_pending");
      expect(tokens["stage_at"]).toBeDefined();
      expect(tokens["stage_at"]).not.toBe("2026-09-05T10:00:00.000Z");
      expect(lines).toEqual(["STA-1 delivered: Ready to merge → stage delivered"]);
      expect(fake.world.issues[0]!.stateId).toBe(MERGE);
      const reports = () => workspaces.calls.filter((c) => c.method === "workspace.report_metadata");
      expect(reports()).toHaveLength(1);
      expect(reports()[0]!.params).toMatchObject({
        workspace_id: seeded.workspaceId,
        tokens: { stage: "delivered", owner_pending: null },
      });
      // Idempotent: the next poll writes no metadata and logs nothing more.
      await watcher.pollOnce();
      expect(reports()).toHaveLength(1);
      expect(lines).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });

  test("a stage change between polls logs exactly one stage line; first sight is silent", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", { ticket: "STA-1", stage: "build" });
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      expect(lines).toEqual([]);
      const workspaceId = workspaces.workspaces[0]!.workspaceId;
      await workspaces.reportMetadata(workspaceId, { stage: "verify" });
      await watcher.pollOnce();
      expect(lines).toEqual(["STA-1 stage: build → verify"]);
      await watcher.pollOnce();
      expect(lines).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });

  test("tickets with no workspace are never moved and never get metadata", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      addIssue(fake.world, { identifier: "STA-2", stateId: REVIEW, priority: 1, description: CRITERIA });
      addIssue(fake.world, { identifier: "STA-3", stateId: MERGE, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      expect(fake.world.issues.map((i) => [i.identifier, i.stateId])).toEqual([
        ["STA-1", BUILDING],
        ["STA-2", REVIEW],
        ["STA-3", MERGE],
      ]);
      expect(workspaces.calls).toEqual([]);
      expect(lines.filter((l) => /state:|delivered:|stage:/.test(l))).toEqual([]);
    } finally {
      fake.stop();
    }
  });

  test("an unreadable Herdr skips tracking while claiming goes on", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: READY, priority: 1, description: CRITERIA });
      addIssue(fake.world, {
        identifier: "STA-2",
        stateId: BUILDING,
        priority: 1,
        description: CRITERIA,
        comments: [{ id: "c-claim", body: `${CLAIM_MARKER}\nClaimed by host=h slot=0 at 2026-09-04T00:00:01.000Z.` }],
      });
      const workspaces = new FakeWorkspaces();
      workspaces.failMethods.add("snapshot");
      const { watcher, seen, lines } = watch(client, resolved, { workspaces });
      const result = await watcher.pollOnce();
      expect(result.claimed.map((t) => t.identifier)).toEqual(["STA-1"]);
      expect(seen).toEqual(["STA-1"]);
      // STA-2 counts as present while Herdr is unreadable: no adoption.
      expect(result.running).toContain("STA-2");
      expect(lines).toEqual([
        "STA-1 claimed: Ready to build → Building (slot 1)",
        "STA-1 state: Ready to build → Building",
      ]);
      expect(workspaces.snapshotCalls).toBe(1);
    } finally {
      fake.stop();
    }
  });

  test("review + stage delivered stays in review with no lines", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: REVIEW, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", {
        ticket: "STA-1",
        stage: "delivered",
        stage_at: "2026-09-05T11:48:00.000Z",
      });
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      expect(fake.world.issues[0]!.stateId).toBe(REVIEW);
      expect(lines).toEqual([]);
      await watcher.pollOnce();
      expect(fake.world.issues[0]!.stateId).toBe(REVIEW);
      expect(lines).toEqual([]);
    } finally {
      fake.stop();
    }
  });

  test("a Linear failure inside tracking does not break claiming; the next poll tracks", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-9", stateId: READY, priority: 1, description: CRITERIA });
      addIssue(fake.world, { identifier: "STA-1", stateId: REVIEW, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", { ticket: "STA-1", stage: "build", review_count: "1" });
      // Only the tracking lists fail: building/queued reads stay healthy so
      // claiming in the same poll must go through.
      const healthy = client.listIssuesByState.bind(client);
      let failTracking = true;
      client.listIssuesByState = async (
        projectId: string,
        stateId: string,
        first?: number,
      ): Promise<LinearIssue[]> => {
        if (failTracking && (stateId === resolved.reviewStateId || stateId === resolved.mergeStateId)) {
          throw new LinearError(500, "tracking list failed");
        }
        return healthy(projectId, stateId, first);
      };
      const { watcher, seen, lines } = watch(client, resolved, { workspaces });
      const result = await watcher.pollOnce();
      expect(result.claimed.map((t) => t.identifier)).toEqual(["STA-9"]);
      expect(seen).toEqual(["STA-9"]);
      expect(fake.world.issues.find((i) => i.identifier === "STA-9")!.stateId).toBe(BUILDING);
      // Tracking never ran its moves: STA-1 is still in review, untouched.
      expect(fake.world.issues.find((i) => i.identifier === "STA-1")!.stateId).toBe(REVIEW);
      expect(lines).toEqual([
        "STA-9 claimed: Ready to build → Building (slot 0)",
        "STA-9 state: Ready to build → Building",
      ]);
      expect(workspaces.snapshotCalls).toBe(1);
      // Healthy again: the next poll tracks normally.
      failTracking = false;
      await watcher.pollOnce();
      expect(fake.world.issues.find((i) => i.identifier === "STA-1")!.stateId).toBe(BUILDING);
      expect(lines).toContain("STA-1 state: Ready to review → Building (stage back to build)");
      expect(workspaces.snapshotCalls).toBe(2);
    } finally {
      fake.stop();
    }
  });

  test("a failed stage gets no generic stage line; the failure reaction owns it", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", { ticket: "STA-1", stage: "build" });
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      const workspaceId = workspaces.workspaces[0]!.workspaceId;
      await workspaces.reportMetadata(workspaceId, { stage: "failed", reason: "builder wedged" });
      await watcher.pollOnce();
      expect(lines).toEqual([
        "STA-1 failed: builder wedged",
        "STA-1 workspace closed (ws-1)",
      ]);
      expect(lines.some((l) => l.includes("stage:"))).toBe(false);
      expect(fake.world.issues[0]!.stateId).toBe("st-todo");
    } finally {
      fake.stop();
    }
  });
});

describe("failure recovery", () => {
  test("stage=failed runs the same failure actions as igniter fail", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace(
        "STA-1",
        { ticket: "STA-1", stage: "failed", reason: "builder wedged" },
        { paneText: "panic: boom\nat build.ts:1" },
      );
      const { watcher, seen, lines } = watch(client, resolved, { workspaces });
      const result = await watcher.pollOnce();
      expect(result.claimed).toEqual([]);
      expect(seen).toEqual([]);
      const issue = fake.world.issues[0]!;
      expect(issue.stateId).toBe(resolved.failedStateId);
      const failedLabel = fake.world.labels.find((l) => l.name === "agent-failed");
      expect(failedLabel).toBeDefined();
      expect(issue.labelIds).toEqual([failedLabel!.id]);
      expect(issue.comments).toHaveLength(1);
      const comment = issue.comments[0]!.body;
      expect(comment).toContain("<!-- igniter:failed -->");
      expect(comment).toContain("builder wedged");
      expect(comment).toContain("```\npanic: boom\nat build.ts:1\n```");
      expect(workspaces.workspaces[0]!.closed).toBe(true);
      expect(lines).toEqual([
        "STA-1 failed: builder wedged",
        "STA-1 workspace closed (ws-1)",
      ]);
      // The workspace is gone, so the next poll stays quiet: no repeat.
      await watcher.pollOnce();
      expect(lines).toHaveLength(2);
      expect(issue.comments).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });

  test("stage=failed without a reason uses the fallback phrase", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", { ticket: "STA-1", stage: "failed" });
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      const comment = fake.world.issues[0]!.comments[0]!.body;
      expect(comment).toContain("<!-- igniter:failed -->");
      expect(comment).toContain("Commander reported stage=failed with no reason");
      expect(comment).not.toContain("```");
      expect(lines).toEqual([
        "STA-1 failed: Commander reported stage=failed with no reason",
        "STA-1 workspace closed (ws-1)",
      ]);
    } finally {
      fake.stop();
    }
  });

  test("a failed close never repeats the failure", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", { ticket: "STA-1", stage: "failed", reason: "x" });
      workspaces.failMethods.add("workspace.close");
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      const issue = fake.world.issues[0]!;
      expect(issue.stateId).toBe(resolved.failedStateId);
      expect(lines).toEqual([
        "STA-1 failed: x",
        "STA-1 workspace close failed: fake herdr exploded",
      ]);
      // The issue already left its started state with the reason's comment
      // on it: the next poll retries the lifecycle close (still failing)
      // but posts nothing more.
      await watcher.pollOnce();
      expect(lines).toHaveLength(2);
      expect(issue.comments).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });

  test("a ticket with stage=failed outside started work is left to the lifecycle", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: DONE, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", { ticket: "STA-1", stage: "failed", reason: "x" });
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      // No failure lines and no comment: only the lifecycle closes the
      // leftover workspace.
      expect(lines).toEqual(["STA-1 workspace closed (ws-1)"]);
      expect(fake.world.issues[0]!.stateId).toBe(DONE);
      expect(fake.world.issues[0]!.comments).toHaveLength(0);
      expect(workspaces.workspaces[0]!.closed).toBe(true);
    } finally {
      fake.stop();
    }
  });

  test("a previously failed ticket is claimed normally once it is ready again", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, {
        identifier: "STA-1",
        stateId: READY,
        priority: 1,
        description: CRITERIA,
        comments: [{ id: "c-failed", body: "<!-- igniter:failed -->\nbuilder wedged\n" }],
      });
      const { watcher, seen, lines } = watch(client, resolved);
      const result = await watcher.pollOnce();
      expect(result.claimed.map((t) => t.identifier)).toEqual(["STA-1"]);
      expect(seen).toEqual(["STA-1"]);
      expect(fake.world.issues[0]!.stateId).toBe(BUILDING);
      expect(lines).toEqual([
        "STA-1 claimed: Ready to build → Building (slot 0)",
        "STA-1 state: Ready to build → Building",
      ]);
    } finally {
      fake.stop();
    }
  });

  test("the same reason in a later episode fails again with its own comment", async () => {
    const { fake, client, resolved } = await setup();
    try {
      const issue = addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      const firstAt = "2026-09-05T12:00:00.000Z";
      workspaces.seedWorkspace(
        "STA-1",
        { ticket: "STA-1", stage: "failed", stage_at: firstAt, reason: "builder wedged" },
        { paneText: "first tail" },
      );
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      expect(fake.world.issues[0]!.stateId).toBe(resolved.failedStateId);
      expect(lines).toEqual([
        "STA-1 failed: builder wedged",
        "STA-1 workspace closed (ws-1)",
      ]);
      // Dragged back to work and failing again with the same reason: a new
      // stage_at makes it a new episode, so the reaction runs again in full
      // instead of matching the old comment.
      await client.setIssueState(issue.id, resolved.buildingStateId);
      const secondAt = "2026-09-05T13:00:00.000Z";
      workspaces.seedWorkspace(
        "STA-1",
        { ticket: "STA-1", stage: "failed", stage_at: secondAt, reason: "builder wedged" },
        { paneText: "second tail" },
      );
      await watcher.pollOnce();
      const comments = fake.world.issues[0]!.comments;
      expect(comments).toHaveLength(2);
      expect(comments[0]!.body).toContain(`<!-- igniter:failed ${firstAt} -->`);
      expect(comments[1]!.body).toContain(`<!-- igniter:failed ${secondAt} -->`);
      expect(comments[1]!.body).toContain("second tail");
      expect(workspaces.workspaces[1]!.closed).toBe(true);
      expect(fake.world.issues[0]!.stateId).toBe(resolved.failedStateId);
      expect(lines).toEqual([
        "STA-1 failed: builder wedged",
        "STA-1 workspace closed (ws-1)",
        "STA-1 failed: builder wedged",
        "STA-1 workspace closed (ws-2)",
      ]);
    } finally {
      fake.stop();
    }
  });

  test("a comment lost mid-failure lands exactly once on the next poll", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      const failedAt = "2026-09-05T12:00:00.000Z";
      workspaces.seedWorkspace(
        "STA-1",
        { ticket: "STA-1", stage: "failed", stage_at: failedAt, reason: "builder wedged" },
        { paneText: "panic: boom" },
      );
      fake.world.failNextComment = true;
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      // Label and state landed, the comment did not: the issue sits in the
      // failed state with the workspace still open and no trace of why.
      const issue = fake.world.issues[0]!;
      expect(issue.stateId).toBe(resolved.failedStateId);
      expect(issue.comments).toHaveLength(0);
      expect(workspaces.workspaces[0]!.closed).toBe(false);
      expect(lines).toEqual(["STA-1 fail failed: Linear GraphQL error: rate limited"]);
      // The retry gate admits it back: same idempotent label and state, one
      // comment, then the close.
      await watcher.pollOnce();
      expect(issue.comments).toHaveLength(1);
      const comment = issue.comments[0]!.body;
      expect(comment).toContain(`<!-- igniter:failed ${failedAt} -->`);
      expect(comment).toContain("builder wedged");
      expect(workspaces.workspaces[0]!.closed).toBe(true);
      expect(lines).toEqual([
        "STA-1 fail failed: Linear GraphQL error: rate limited",
        "STA-1 failed: builder wedged",
        "STA-1 workspace closed (ws-1)",
      ]);
      // Settled: the next poll stays quiet.
      await watcher.pollOnce();
      expect(lines).toHaveLength(3);
      expect(issue.comments).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });
});

describe("stalled commanders", () => {
  test("blocked past blocked_minutes comments once and sets stalled=1", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace(
        "STA-1",
        { ticket: "STA-1", stage: "build", started_at: "2026-09-05T11:00:00.000Z" },
        { commanderStatus: "blocked", paneText: "waiting for approval: proceed? (y/n)" },
      );
      let now = Date.parse("2026-09-05T12:00:00.000Z");
      const { watcher, lines } = watch(client, resolved, { workspaces, now: () => now });
      await watcher.pollOnce();
      expect(lines).toEqual([]);
      // Exactly at the threshold is not past it.
      now += 20 * 60_000;
      await watcher.pollOnce();
      expect(lines).toEqual([]);
      expect(workspaces.tokensFor("STA-1")).not.toHaveProperty("stalled");
      now += 60_000;
      await watcher.pollOnce();
      const issue = fake.world.issues[0]!;
      expect(issue.comments).toHaveLength(1);
      const comment = issue.comments[0]!.body;
      expect(comment).toContain("<!-- igniter:stalled -->");
      expect(comment).toContain("commander-sta-1");
      expect(comment).toContain("blocked");
      expect(comment).toContain("```\nwaiting for approval: proceed? (y/n)\n```");
      expect(workspaces.tokensFor("STA-1")).toMatchObject({ stalled: "1" });
      expect(lines).toEqual(["STA-1 stalled: commander blocked for 21m at stage build"]);
      // Linear state and workspace unchanged.
      expect(issue.stateId).toBe(BUILDING);
      expect(workspaces.workspaces[0]!.closed).toBe(false);
      // Still blocked: no second comment, no second line.
      await watcher.pollOnce();
      expect(lines).toHaveLength(1);
      expect(issue.comments).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });

  test("leaving blocked clears stalled with one more line; a new episode comments again", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace(
        "STA-1",
        { ticket: "STA-1", stage: "build", stalled: "1" },
        { commanderStatus: "working" },
      );
      let now = Date.parse("2026-09-05T12:00:00.000Z");
      const { watcher, lines } = watch(client, resolved, { workspaces, now: () => now });
      await watcher.pollOnce();
      expect(workspaces.tokensFor("STA-1")).not.toHaveProperty("stalled");
      expect(lines).toEqual(["STA-1 stalled cleared"]);
      expect(fake.world.issues[0]!.stateId).toBe(BUILDING);
      expect(fake.world.issues[0]!.comments).toHaveLength(0);
      // A new blocked episode after the recovery comments again.
      workspaces.agents[0]!.agentStatus = "blocked";
      await watcher.pollOnce();
      expect(lines).toHaveLength(1);
      now += 21 * 60_000;
      await watcher.pollOnce();
      expect(fake.world.issues[0]!.comments).toHaveLength(1);
      expect(workspaces.tokensFor("STA-1")).toMatchObject({ stalled: "1" });
      expect(lines).toEqual([
        "STA-1 stalled cleared",
        "STA-1 stalled: commander blocked for 21m at stage build",
      ]);
    } finally {
      fake.stop();
    }
  });

  test("a lost stalled token retries without duplicating the comment", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace(
        "STA-1",
        { ticket: "STA-1", stage: "build", started_at: "2026-09-05T11:00:00.000Z" },
        { commanderStatus: "blocked", paneText: "waiting for approval: proceed? (y/n)" },
      );
      let now = Date.parse("2026-09-05T12:00:00.000Z");
      const { watcher, lines } = watch(client, resolved, { workspaces, now: () => now });
      await watcher.pollOnce();
      now += 21 * 60_000;
      // The token write fails, so the comment is never attempted: nothing
      // is half-done and the next poll starts clean.
      workspaces.failMethods.add("workspace.report_metadata");
      await watcher.pollOnce();
      expect(lines).toEqual([]);
      expect(fake.world.issues[0]!.comments).toHaveLength(0);
      expect(workspaces.tokensFor("STA-1")).not.toHaveProperty("stalled");
      workspaces.failMethods.delete("workspace.report_metadata");
      await watcher.pollOnce();
      expect(fake.world.issues[0]!.comments).toHaveLength(1);
      expect(workspaces.tokensFor("STA-1")).toMatchObject({ stalled: "1" });
      expect(lines).toEqual(["STA-1 stalled: commander blocked for 21m at stage build"]);
      await watcher.pollOnce();
      expect(lines).toHaveLength(1);
      expect(fake.world.issues[0]!.comments).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });

  test("a lost stalled comment is posted verbatim on the next poll", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace(
        "STA-1",
        { ticket: "STA-1", stage: "build", started_at: "2026-09-05T11:00:00.000Z" },
        { commanderStatus: "blocked", paneText: "waiting for approval: proceed? (y/n)" },
      );
      let now = Date.parse("2026-09-05T12:00:00.000Z");
      const { watcher, lines } = watch(client, resolved, { workspaces, now: () => now });
      await watcher.pollOnce();
      now += 21 * 60_000;
      // Token first, so it lands; the comment fails and is remembered.
      fake.world.failNextComment = true;
      await watcher.pollOnce();
      expect(workspaces.tokensFor("STA-1")).toMatchObject({ stalled: "1" });
      expect(fake.world.issues[0]!.comments).toHaveLength(0);
      expect(lines).toEqual([]);
      // Next poll posts the stored text exactly once, with its line.
      await watcher.pollOnce();
      const issue = fake.world.issues[0]!;
      expect(issue.comments).toHaveLength(1);
      expect(issue.comments[0]!.body).toContain("<!-- igniter:stalled -->");
      expect(issue.comments[0]!.body).toContain("waiting for approval: proceed? (y/n)");
      expect(lines).toEqual(["STA-1 stalled: commander blocked for 21m at stage build"]);
      await watcher.pollOnce();
      expect(lines).toHaveLength(1);
      expect(issue.comments).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });

  test("a cleared stalled token drops the pending comment instead of undoing the clear", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      const seeded = workspaces.seedWorkspace(
        "STA-1",
        { ticket: "STA-1", stage: "build", started_at: "2026-09-05T11:00:00.000Z" },
        { commanderStatus: "blocked", paneText: "waiting for approval: proceed? (y/n)" },
      );
      let now = Date.parse("2026-09-05T12:00:00.000Z");
      const { watcher, lines } = watch(client, resolved, { workspaces, now: () => now });
      await watcher.pollOnce();
      now += 21 * 60_000;
      fake.world.failNextComment = true;
      await watcher.pollOnce();
      expect(workspaces.tokensFor("STA-1")).toMatchObject({ stalled: "1" });
      expect(fake.world.issues[0]!.comments).toHaveLength(0);
      // The token is cleared out-of-band before the next poll. The retry
      // must not write it back, post the stale comment, or log.
      await workspaces.reportMetadata(seeded.workspaceId, { stalled: null });
      await watcher.pollOnce();
      expect(workspaces.tokensFor("STA-1")).not.toHaveProperty("stalled");
      expect(fake.world.issues[0]!.comments).toHaveLength(0);
      expect(lines).toEqual([]);
    } finally {
      fake.stop();
    }
  });
});

describe("over-budget tickets", () => {
  test("past max_hours before acceptance comments once and frees the slot", async () => {
    const { fake, client, resolved } = await setup(1, { max_hours: 4 });
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", {
        ticket: "STA-1",
        stage: "build",
        stage_at: "2026-09-05T10:00:00.000Z",
        started_at: "2026-09-05T06:58:00.000Z",
      });
      addIssue(fake.world, { identifier: "STA-2", stateId: READY, priority: 1, description: CRITERIA });
      const now = Date.parse("2026-09-05T12:00:00.000Z");
      const { watcher, seen, lines } = watch(client, resolved, { workspaces, now: () => now });
      expect((await watcher.pollOnce()).claimed).toEqual([]);
      // The first poll flags the ticket: one comment, one token, one line.
      // The slot is still held this poll, so the next ticket waits.
      const over = fake.world.issues[0]!;
      expect(over.comments).toHaveLength(1);
      const comment = over.comments[0]!.body;
      expect(comment).toContain("<!-- igniter:over-budget -->");
      expect(comment).toContain("5h02m");
      expect(comment).toContain("4h");
      expect(workspaces.tokensFor("STA-1")).toMatchObject({ over_budget: "1" });
      expect(lines).toEqual([
        "STA-1 over budget: 5h02m past 4h at stage build",
        "STA-2 waiting: slots full (1 running)",
      ]);
      // Linear state and workspace unchanged.
      expect(over.stateId).toBe(BUILDING);
      expect(workspaces.workspaces[0]!.closed).toBe(false);
      // Flagged already: the next poll posts nothing more, and the freed
      // slot lets the next ticket claim.
      const second = await watcher.pollOnce();
      expect(second.claimed.map((t) => t.identifier)).toEqual(["STA-2"]);
      expect(seen).toEqual(["STA-2"]);
      expect(lines).toEqual([
        "STA-1 over budget: 5h02m past 4h at stage build",
        "STA-2 waiting: slots full (1 running)",
        "STA-2 claimed: Ready to build → Building (slot 0)",
        "STA-2 state: Ready to build → Building",
      ]);
      expect(over.comments).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });

  test("a lost budget token retries without duplicating the comment", async () => {
    const { fake, client, resolved } = await setup(3, { max_hours: 4 });
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", {
        ticket: "STA-1",
        stage: "build",
        stage_at: "2026-09-05T10:00:00.000Z",
        started_at: "2026-09-05T06:58:00.000Z",
      });
      const now = Date.parse("2026-09-05T12:00:00.000Z");
      const { watcher, lines } = watch(client, resolved, { workspaces, now: () => now });
      // The token write fails, so the comment is never attempted.
      workspaces.failMethods.add("workspace.report_metadata");
      await watcher.pollOnce();
      expect(lines).toEqual([]);
      expect(fake.world.issues[0]!.comments).toHaveLength(0);
      expect(workspaces.tokensFor("STA-1")).not.toHaveProperty("over_budget");
      workspaces.failMethods.delete("workspace.report_metadata");
      await watcher.pollOnce();
      expect(fake.world.issues[0]!.comments).toHaveLength(1);
      expect(workspaces.tokensFor("STA-1")).toMatchObject({ over_budget: "1" });
      expect(lines).toEqual(["STA-1 over budget: 5h02m past 4h at stage build"]);
      await watcher.pollOnce();
      expect(lines).toHaveLength(1);
      expect(fake.world.issues[0]!.comments).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });

  test("a lost budget comment is posted verbatim on the next poll", async () => {
    const { fake, client, resolved } = await setup(3, { max_hours: 4 });
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", {
        ticket: "STA-1",
        stage: "build",
        stage_at: "2026-09-05T10:00:00.000Z",
        started_at: "2026-09-05T06:58:00.000Z",
      });
      const now = Date.parse("2026-09-05T12:00:00.000Z");
      const { watcher, lines } = watch(client, resolved, { workspaces, now: () => now });
      // Token first, so it lands and frees the slot; the comment fails and
      // is remembered.
      fake.world.failNextComment = true;
      await watcher.pollOnce();
      expect(workspaces.tokensFor("STA-1")).toMatchObject({ over_budget: "1" });
      expect(fake.world.issues[0]!.comments).toHaveLength(0);
      expect(lines).toEqual([]);
      await watcher.pollOnce();
      const issue = fake.world.issues[0]!;
      expect(issue.comments).toHaveLength(1);
      expect(issue.comments[0]!.body).toContain("<!-- igniter:over-budget -->");
      expect(lines).toEqual(["STA-1 over budget: 5h02m past 4h at stage build"]);
      await watcher.pollOnce();
      expect(lines).toHaveLength(1);
      expect(issue.comments).toHaveLength(1);
    } finally {
      fake.stop();
    }
  });

  test("a cleared over_budget token drops the pending comment instead of undoing the clear", async () => {
    const { fake, client, resolved } = await setup(3, { max_hours: 4 });
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      const seeded = workspaces.seedWorkspace("STA-1", {
        ticket: "STA-1",
        stage: "build",
        stage_at: "2026-09-05T10:00:00.000Z",
        started_at: "2026-09-05T06:58:00.000Z",
      });
      const now = Date.parse("2026-09-05T12:00:00.000Z");
      const { watcher, lines } = watch(client, resolved, { workspaces, now: () => now });
      fake.world.failNextComment = true;
      await watcher.pollOnce();
      expect(workspaces.tokensFor("STA-1")).toMatchObject({ over_budget: "1" });
      expect(fake.world.issues[0]!.comments).toHaveLength(0);
      // The owner resumes out-of-band, clearing the token. The retry must
      // not write it back (re-holding the slot), post the stale comment,
      // or log a contradictory line.
      await workspaces.reportMetadata(seeded.workspaceId, { over_budget: null });
      await watcher.pollOnce();
      expect(workspaces.tokensFor("STA-1")).not.toHaveProperty("over_budget");
      expect(fake.world.issues[0]!.comments).toHaveLength(0);
      expect(lines).toEqual([]);
    } finally {
      fake.stop();
    }
  });
});

  test("acceptance and delivered stages are never over budget", async () => {
    const { fake, client, resolved } = await setup(3, { max_hours: 4 });
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      addIssue(fake.world, { identifier: "STA-2", stateId: REVIEW, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", {
        ticket: "STA-1",
        stage: "acceptance",
        stage_at: "2026-09-05T10:00:00.000Z",
        started_at: "2026-09-05T06:58:00.000Z",
      });
      workspaces.seedWorkspace("STA-2", {
        ticket: "STA-2",
        stage: "delivered",
        stage_at: "2026-09-05T10:00:00.000Z",
        started_at: "2026-09-05T06:58:00.000Z",
      });
      const now = Date.parse("2026-09-05T12:00:00.000Z");
      const { watcher, lines } = watch(client, resolved, { workspaces, now: () => now });
      await watcher.pollOnce();
      expect(lines).toEqual([]);
      expect(workspaces.tokensFor("STA-1")).not.toHaveProperty("over_budget");
      expect(workspaces.tokensFor("STA-2")).not.toHaveProperty("over_budget");
      expect(fake.world.issues[0]!.comments).toHaveLength(0);
      expect(fake.world.issues[1]!.comments).toHaveLength(0);
    } finally {
      fake.stop();
    }
  });

describe("workspace lifecycle", () => {
  test("a non-started state closes the workspace within one poll", async () => {
    const { fake, client, resolved } = await setup();
    try {
      const states: [string, string][] = [
        ["STA-1", DONE],
        ["STA-2", CANCELED],
        ["STA-3", "st-todo"],
        ["STA-4", READY],
        ["STA-5", "st-backlog"],
      ];
      for (const [identifier, stateId] of states) {
        addIssue(fake.world, { identifier, stateId, priority: 1, description: "no sections" });
      }
      const workspaces = new FakeWorkspaces();
      for (const [identifier] of states) workspaces.seedWorkspace(identifier);
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      expect(workspaces.workspaces.every((w) => w.closed)).toBe(true);
      // Claiming runs before the lifecycle: the Ready ticket without
      // criteria gets its one-time nudge first.
      expect(lines).toEqual([
        "STA-4 skipped: no acceptance criteria",
        "STA-1 workspace closed (ws-1)",
        "STA-2 workspace closed (ws-2)",
        "STA-3 workspace closed (ws-3)",
        "STA-4 workspace closed (ws-4)",
        "STA-5 workspace closed (ws-5)",
      ]);
      for (const [identifier, stateId] of states) {
        const issue = fake.world.issues.find((i) => i.identifier === identifier)!;
        expect(issue.stateId).toBe(stateId);
      }
      for (const identifier of ["STA-1", "STA-2", "STA-3", "STA-5"]) {
        expect(fake.world.issues.find((i) => i.identifier === identifier)!.comments).toHaveLength(0);
      }
    } finally {
      fake.stop();
    }
  });

  test("a started ticket keeps its workspace", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", { ticket: "STA-1", stage: "build" });
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      expect(workspaces.workspaces[0]!.closed).toBe(false);
      expect(lines).toEqual([]);
    } finally {
      fake.stop();
    }
  });
});

describe("acceptance labels", () => {
  test("reaching acceptance removes agent-failed and keeps other labels", async () => {
    const { fake, client, resolved } = await setup();
    try {
      fake.world.labels.push({ id: "label-7", name: "agent-failed", teamId: "team-1" });
      fake.world.labels.push({ id: "label-9", name: "keep", teamId: "team-1" });
      addIssue(fake.world, {
        identifier: "STA-1",
        stateId: BUILDING,
        priority: 1,
        description: CRITERIA,
        labelIds: ["label-7", "label-9"],
      });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", {
        ticket: "STA-1",
        stage: "acceptance",
        stage_at: "2026-09-05T11:48:00.000Z",
        started_at: "2026-09-05T11:47:00.000Z",
      });
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      expect(fake.world.issues[0]!.labelIds).toEqual(["label-9"]);
      expect(lines).toEqual(["STA-1 agent-failed label removed"]);
      // Removed already: the next poll stays quiet.
      await watcher.pollOnce();
      expect(lines).toHaveLength(1);
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
      mergeStateId: "st-merge",
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

describe("sink results", () => {
  test("a sink that opens a workspace adds the opened line after the claim", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: READY, priority: 1, description: CRITERIA });
      const lines: string[] = [];
      const workspaces = new FakeWorkspaces();
      const opening = new Watcher({
        client,
        resolved,
        host: "h",
        sink: createWorkspaceSink({
          workspaces,
          config: resolved.config,
          repoRoot: join(mkdtempSync(join(tmpdir(), "igniter-wt-root-")), "repo"),
          readApiKey: () => "test-key",
          runGit: new FakeGit(),
          now: () => "2026-09-05T00:00:00.000Z",
        }),
        decisions: {
          record: async (ticket, message) => {
            lines.push(`${ticket} ${message}`);
          },
        },
        workspaces,
      });
      expect((await opening.pollOnce()).claimed.map((t) => t.identifier)).toEqual(["STA-1"]);
      expect(lines).toEqual([
        "STA-1 claimed: Ready to build → Building (slot 0)",
        "STA-1 state: Ready to build → Building",
        "STA-1 workspace opened (ws-1) commander=claude builder=opencode/muse-spark-1.3-contributor-free",
      ]);
      expect(workspaces.tokensFor("STA-1")).toMatchObject({
        ticket: "STA-1",
        commander: "claude",
        builder: "opencode/muse-spark-1.3-contributor-free",
        started_at: "2026-09-05T00:00:00.000Z",
      });
    } finally {
      fake.stop();
    }
  });

  test("a mid-way sink failure names the workspace and aborts the poll", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: READY, priority: 1, description: CRITERIA });
      const workspaces = new FakeWorkspaces();
      workspaces.failMethods.add("agent.start");
      const lines: string[] = [];
      const opening = new Watcher({
        client,
        resolved,
        host: "h",
        sink: createWorkspaceSink({
          workspaces,
          config: resolved.config,
          repoRoot: join(mkdtempSync(join(tmpdir(), "igniter-wt-root-")), "repo"),
          readApiKey: () => "test-key",
          runGit: new FakeGit(),
        }),
        decisions: {
          record: async (ticket, message) => {
            lines.push(`${ticket} ${message}`);
          },
        },
        workspaces,
      });
      await expect(opening.pollOnce()).rejects.toThrow("fake herdr exploded");
      expect(lines).toEqual([
        "STA-1 handoff failed: fake herdr exploded (workspace ws-1)",
        "STA-1 claim failed: fake herdr exploded",
      ]);
    } finally {
      fake.stop();
    }
  });
});
