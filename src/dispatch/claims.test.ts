// Dispatch watch loop against a fake Linear endpoint: no network, no real
// credentials, no real project. One process, one claimant: Herdr answers
// "is it running" through a fake workspace set.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MISSING_MARKER,
  createClaimLock,
  createDispatchLog,
  hasAcceptanceCriteria,
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
import { receiptBlock } from "./protocol";
import type { CommandWorkspaces } from "./workspaces";

const BACKLOG = "st-backlog";
const TODO = "st-todo";
const BUILD = "st-build";
const REVIEW = "st-review";
const DELIVER = "st-deliver";
const DONE = "st-done";
const PENDING = "label-pending";
const IN_PROGRESS = "label-in-progress";
const COMPLETE = "label-complete";
const BLOCKED = "label-blocked";
const CRITERIA = "## 驗收條件\n- [ ] works\n";

interface Setup {
  fake: FakeLinearHandle;
  client: LinearClient;
  resolved: ResolvedDispatch;
}

async function setup(maxRunning = 3): Promise<Setup> {
  const world = standardWorld("test-key");
  const fake = startFakeLinear(world);
  const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url, fetchImpl: fake.fetchImpl });
  const resolved = await validateStartup(
    client,
    parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: maxRunning }),
  );
  return { fake, client, resolved };
}

interface Watched {
  watcher: Watcher;
  seen: string[];
  lines: string[];
  git: FakeGit;
}

function watch(
  client: LinearClient,
  resolved: ResolvedDispatch,
  opts: { host?: string; workspaces?: CommandWorkspaces; decisions?: DecisionLog; lines?: string[]; sink?: (identifier: string) => void } = {},
): Watched {
  const seen: string[] = [];
  const lines = opts.lines ?? [];
  const dir = mkdtempSync(join(tmpdir(), "igniter-watch-"));
  const workspaces = opts.workspaces ?? new FakeWorkspaces();
  const git = new FakeGit();
  const sink = createWorkspaceSink({
    workspaces,
    config: resolved.config,
    repoRoot: dir,
    runGit: git,
  });
  const watcher = new Watcher({
    client,
    resolved,
    host: opts.host ?? "h",
    sink: async (t, existing) => {
      seen.push(t.identifier);
      opts.sink?.(t.identifier);
      return sink(t, existing);
    },
    decisions: opts.decisions ?? {
      record: async (ticket, message) => {
        lines.push(`${ticket} ${message}`);
      },
    },
    workspaces,
    git,
    repoRoot: dir,
  });
  return { watcher, seen, lines, git };
}

describe("validateStartup", () => {
  test("maps configured names to Linear state ids", async () => {
    const { fake, resolved } = await setup();
    try {
      expect(resolved.projectId).toBe("proj-1");
      expect(resolved.teamName).toBe("Starcoder");
      expect(resolved.stateIds).toMatchObject({ todo: TODO, build: BUILD, review: REVIEW, deliver: DELIVER, done: DONE, backlog: BACKLOG });
      expect(resolved.progress.ids).toMatchObject({
        pending: PENDING,
        in_progress: IN_PROGRESS,
        complete: COMPLETE,
        blocked: BLOCKED,
      });
    } finally {
      fake.stop();
    }
  });

  test("unknown status name fails startup with the team in the message", async () => {
    const { fake, client } = await setup();
    try {
      await expect(
        validateStartup(client, parseDispatchConfig({ project: "igniter", team: "Starcoder", states: { todo: "Nope" } })),
      ).rejects.toThrow('status "Nope" (states.todo) does not exist on team "Starcoder"');
    } finally {
      fake.stop();
    }
  });

  test("a status on the wrong workflow type fails startup", async () => {
    const { fake, client } = await setup();
    try {
      await expect(
        validateStartup(client, parseDispatchConfig({
          project: "igniter",
          team: "Starcoder",
          states: { backlog: "Backlog", todo: "Build", build: "Todo", review: "Review", deliver: "Deliver", done: "Done" },
        })),
      ).rejects.toThrow("(states.todo) must be a unstarted-type state");
    } finally {
      fake.stop();
    }
  });

  test("a missing Progress group or label fails startup", async () => {
    const { fake, client } = await setup();
    try {
      await expect(
        validateStartup(client, parseDispatchConfig({ project: "igniter", team: "Starcoder", progress: { group: "Nope" } })),
      ).rejects.toThrow('label group "Nope" (progress.group) was not found');
      fake.world.labels.push({ id: "label-stray", name: "Stray", teamId: "team-1", parentId: null });
      await expect(
        validateStartup(client, parseDispatchConfig({ project: "igniter", team: "Starcoder", progress: { complete: "Stray" } })),
      ).rejects.toThrow('label "Stray" (progress.complete) is not in label group "Progress"');
    } finally {
      fake.stop();
    }
  });

  test("missing project fails startup", async () => {
    const { fake, client } = await setup();
    try {
      await expect(
        validateStartup(client, parseDispatchConfig({ project: "nope", team: "Starcoder" })),
      ).rejects.toThrow('project "nope" was not found');
    } finally {
      fake.stop();
    }
  });

  test("transient errors retry, config errors throw at once", async () => {
    const world = standardWorld("test-key");
    world.failFirst = 2;
    const fake = startFakeLinear(world);
    try {
      const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url, fetchImpl: fake.fetchImpl });
      const config = parseDispatchConfig({ project: "igniter", team: "Starcoder" });
      let retries = 0;
      const resolved = await validateWithRetry(() => validateStartup(client, config), {
        maxAttempts: 5,
        baseDelayMs: 1,
        onRetry: () => {
          retries += 1;
        },
      });
      expect(resolved.projectId).toBe("proj-1");
      expect(retries).toBe(2);
      await expect(
        validateWithRetry(() => validateStartup(client, parseDispatchConfig({ project: "nope" })), {
          maxAttempts: 3,
          baseDelayMs: 1,
        }),
      ).rejects.toThrow('project "nope" was not found');
    } finally {
      fake.stop();
    }
  });
});

describe("candidate helpers", () => {
  test("hasAcceptanceCriteria needs a checklist under the heading", () => {
    expect(hasAcceptanceCriteria(null)).toBe(false);
    expect(hasAcceptanceCriteria("plans")).toBe(false);
    expect(hasAcceptanceCriteria("## 驗收條件\nnothing")).toBe(false);
    expect(hasAcceptanceCriteria(CRITERIA)).toBe(true);
    expect(hasAcceptanceCriteria("## Acceptance criteria\n- [ ] x\n")).toBe(true);
  });

  test("sortCandidates prefers priority, then waiting time", () => {
    const issue = (identifier: string, priority: number, updatedAt: string): LinearIssue => ({
      id: identifier,
      identifier,
      title: identifier,
      description: null,
      priority,
      updatedAt,
      state: { id: TODO, name: "Todo" },
    });
    const sorted = sortCandidates([
      issue("STA-3", 0, "2026-09-04T00:00:01.000Z"),
      issue("STA-1", 2, "2026-09-04T00:00:03.000Z"),
      issue("STA-2", 1, "2026-09-04T00:00:02.000Z"),
    ]);
    expect(sorted.map((i) => i.identifier)).toEqual(["STA-2", "STA-1", "STA-3"]);
  });

  test("the claim lock serializes polls and commands", async () => {
    const lock = createClaimLock();
    const order: string[] = [];
    await Promise.all([
      lock(async () => {
        await Bun.sleep(10);
        order.push("first");
      }),
      lock(async () => {
        order.push("second");
      }),
    ]);
    expect(order).toEqual(["first", "second"]);
  });
});

describe("pollOnce", () => {
  test("claims Todo+Pending tickets into Build+In progress", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const { watcher, seen, lines } = watch(client, resolved);
      const result = await watcher.pollOnce();
      expect(result.claimed.map((c) => c.identifier)).toEqual(["STA-1"]);
      expect(seen).toEqual(["STA-1"]);
      const issue = fake.world.issues[0]!;
      expect(issue.stateId).toBe(BUILD);
      expect(issue.labelIds).toEqual([IN_PROGRESS]);
      expect(lines).toContainEqual(expect.stringContaining("STA-1 claimed: Todo → Build (slot 0)"));
    } finally {
      fake.stop();
    }
  });

  test("a bare Todo gains Pending without a claim", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: "plans" });
      const { watcher, seen, lines } = watch(client, resolved);
      await watcher.pollOnce();
      expect(seen).toEqual([]);
      expect(fake.world.issues[0]!.labelIds).toEqual([PENDING]);
      expect(fake.world.issues[0]!.stateId).toBe(TODO);
      expect(lines).toContainEqual(expect.stringContaining("normalized: Todo → Todo+Pending"));
      expect(lines).toContain("STA-1 skipped: no acceptance criteria");
    } finally {
      fake.stop();
    }
  });

  test("criteria-less tickets get one nudge and no workspace", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: "plans", labelIds: [PENDING] });
      const { watcher, seen } = watch(client, resolved);
      await watcher.pollOnce();
      await watcher.pollOnce();
      expect(seen).toEqual([]);
      const comments = fake.world.issues[0]!.comments.filter((c) => c.body.includes(MISSING_MARKER));
      expect(comments).toHaveLength(1);
      expect(watcher.lastQueue).toMatchObject([{ identifier: "STA-1", reason: "skipped: no acceptance criteria" }]);
    } finally {
      fake.stop();
    }
  });

  test("a Todo+Blocked ticket parks quietly and never consumes a queue slot", async () => {
    const { fake, client, resolved } = await setup(1);
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [BLOCKED] });
      addIssue(fake.world, { identifier: "STA-2", stateId: TODO, priority: 2, description: CRITERIA, labelIds: [PENDING] });
      const { watcher, seen, lines } = watch(client, resolved);
      await watcher.pollOnce();
      // The pending ticket claims into the one free slot; the blocked one
      // is never attempted, never altered, and never logged.
      expect(seen).toEqual(["STA-2"]);
      const parked = fake.world.issues.find((i) => i.identifier === "STA-1")!;
      expect(parked.stateId).toBe(TODO);
      expect(parked.labelIds).toEqual([BLOCKED]);
      expect(parked.comments).toEqual([]);
      expect(lines.filter((l) => l.startsWith("STA-1"))).toEqual([]);
      expect(lines.filter((l) => l.includes("claim failed"))).toEqual([]);
      expect(watcher.lastQueue).toMatchObject([
        { identifier: "STA-1", reason: "parked: blocked" },
        { identifier: "STA-2", reason: "next" },
      ]);
      // A second poll stays quiet for the parked ticket.
      const at = lines.length;
      await watcher.pollOnce();
      expect(lines.slice(at).filter((l) => l.startsWith("STA-1"))).toEqual([]);
    } finally {
      fake.stop();
    }
  });

  test("slots fill in priority order, then wait", async () => {
    const { fake, client, resolved } = await setup(1);
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: TODO, priority: 2, description: CRITERIA, labelIds: [PENDING] });
      addIssue(fake.world, { identifier: "STA-2", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const { watcher, seen, lines } = watch(client, resolved);
      await watcher.pollOnce();
      expect(seen).toEqual(["STA-2"]);
      expect(watcher.lastQueue).toMatchObject([
        { identifier: "STA-2", reason: "next" },
        { identifier: "STA-1", reason: "waiting, slots full" },
      ]);
      expect(lines).toContainEqual(expect.stringContaining("STA-1 waiting: slots full"));
      const at = lines.length;
      await watcher.pollOnce();
      expect(lines.slice(at).filter((l) => l.includes("slots full"))).toEqual([]);
    } finally {
      fake.stop();
    }
  });

  test("a blocked Build ticket frees its slot for the queue", async () => {
    const { fake, client, resolved } = await setup(1);
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [BLOCKED] });
      addIssue(fake.world, { identifier: "STA-2", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", { ticket: "STA-1", status: "build", progress: "blocked" });
      const { watcher, seen } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      expect(seen).toContain("STA-2");
      expect(fake.world.issues.find((i) => i.identifier === "STA-2")!.stateId).toBe(BUILD);
    } finally {
      fake.stop();
    }
  });

  test("a Build ticket with no workspace is adopted, not re-claimed", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      const { watcher, seen, lines } = watch(client, resolved);
      await watcher.pollOnce();
      expect(seen).toEqual(["STA-1"]);
      // Adoption keeps the Linear state: no reset to Pending anymore.
      expect(fake.world.issues[0]!.stateId).toBe(BUILD);
      expect(fake.world.issues[0]!.labelIds).toEqual([IN_PROGRESS]);
      expect(lines).toContainEqual(expect.stringContaining("STA-1 adopted: no workspace found, reopened (ws-1)"));
    } finally {
      fake.stop();
    }
  });

  test("a legacy Deliver completion is adopted without reopening it as Pending", async () => {
    const { fake, client, resolved } = await setup();
    try {
      const checkpoint = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      addIssue(fake.world, {
        identifier: "STA-1",
        stateId: DELIVER,
        priority: 1,
        description: CRITERIA,
        labelIds: [COMPLETE],
      });
      fake.world.issues[0]!.comments.push(
        {
          id: "review-pass",
          body: `review\n\n${receiptBlock("review-pass", checkpoint, "review-submission")}\n`,
          createdAt: "2026-09-04T00:00:00.000001Z",
        },
        {
          id: "legacy-deliver",
          body: `deliver\n\n${receiptBlock("deliver", checkpoint, "deliver-submission")}\n`,
          createdAt: "2026-09-04T00:00:00.000002Z",
        },
      );
      const comments = fake.world.issues[0]!.comments.map((comment) => ({ ...comment }));
      const workspaces = new FakeWorkspaces();
      const { watcher, seen, lines } = watch(client, resolved, { workspaces });

      await watcher.pollOnce();

      expect(seen).toEqual(["STA-1"]);
      expect(fake.world.issues[0]!.stateId).toBe(DELIVER);
      expect(fake.world.issues[0]!.labelIds).toEqual([COMPLETE]);
      expect(fake.world.issues[0]!.comments).toEqual(comments);
      expect(workspaces.tokensFor("STA-1")).toMatchObject({
        status: "deliver",
        progress: "complete",
        checkpoint,
        landed: checkpoint,
        receipt_kind: "deliver",
        receipt_id: "legacy-deliver",
        submission: "deliver-submission",
      });
      expect(lines).toContainEqual(expect.stringContaining("STA-1 adopted: no workspace found, reopened"));
      expect(lines.some((line) => line.includes("approved: Review+Complete"))).toBe(false);
    } finally {
      fake.stop();
    }
  });

  test("a half-written Todo claim finishes in its workspace without a second one", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", { ticket: "STA-1", commander: "claude", builder: "b" });
      const { watcher, seen, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      expect(seen).toEqual(["STA-1"]);
      expect(workspaces.workspaces.filter((w) => !w.closed)).toHaveLength(1);
      expect(workspaces.promptsFor("commander-sta-1")).toEqual([]);
      expect(fake.world.issues[0]!.stateId).toBe(BUILD);
      expect(fake.world.issues[0]!.labelIds).toEqual([IN_PROGRESS]);
      expect(lines).toContainEqual(expect.stringContaining("STA-1 claim finished in existing workspace"));
    } finally {
      fake.stop();
    }
  });

  test("a half-written Todo claim finishes in its workspace without starting agents", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", { ticket: "STA-1" }, { commander: false });
      const { watcher } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      expect(workspaces.workspaces.filter((w) => !w.closed)).toHaveLength(1);
      // Igniter starts no agents: the singleton Commander launches stage
      // workers itself with ticket-targeted `igniter begin`.
      expect(workspaces.calls.filter((c) => c.method === "agent.start")).toHaveLength(0);
      expect(workspaces.agents).toHaveLength(0);
      expect(fake.world.issues[0]!.stateId).toBe(BUILD);
      expect(fake.world.issues[0]!.labelIds).toEqual([IN_PROGRESS]);
    } finally {
      fake.stop();
    }
  });

  test("a failed workspace write leaves a half-written claim at Todo+Pending", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", { ticket: "STA-1" }, { commander: false });
      workspaces.failMethods.add("workspace.report_metadata");
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      expect(fake.world.issues[0]!.stateId).toBe(TODO);
      expect(fake.world.issues[0]!.labelIds).toEqual([PENDING]);
      expect(lines).toContainEqual(expect.stringContaining("STA-1 claim failed: fake herdr exploded"));
    } finally {
      fake.stop();
    }
  });

  test("owner approval normalizes Review+Complete to Deliver+Pending", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: REVIEW, priority: 1, description: CRITERIA, labelIds: [COMPLETE] });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", {
        ticket: "STA-1",
        status: "review",
        progress: "complete",
        checkpoint: "head-1",
        receipt_kind: "review-pass",
        receipt_id: "comment-1",
        submission: "sub-1",
      });
      fake.world.issues[0]!.comments.push({
        id: "comment-1",
        body: `Agent acceptance: PASS\n\n${receiptBlock("review-pass", "head-1", "sub-1")}\n`,
        createdAt: "2026-09-04T00:00:00.000001Z",
      });
      // Owner approves in Linear: status moves, the Complete label rides along.
      fake.world.issues[0]!.stateId = DELIVER;
      const { watcher, lines, git } = watch(client, resolved, { workspaces });
      git.ancestors.add("head-1 feature/sta-1");
      await watcher.pollOnce();
      expect(fake.world.issues[0]!.labelIds).toEqual([PENDING]);
      expect(workspaces.tokensFor("STA-1")).toMatchObject({ status: "deliver", progress: "pending" });
      expect(lines).toContainEqual(expect.stringContaining("STA-1 approved: Review+Complete → Deliver+Pending"));
    } finally {
      fake.stop();
    }
  });

  test("an unvalidated owner move is refused and left alone", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: DELIVER, priority: 1, description: CRITERIA, labelIds: [COMPLETE] });
      const workspaces = new FakeWorkspaces();
      workspaces.seedWorkspace("STA-1", { ticket: "STA-1", status: "review", progress: "complete" });
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      expect(fake.world.issues[0]!.stateId).toBe(DELIVER);
      expect(fake.world.issues[0]!.labelIds).toEqual([COMPLETE]);
      expect(lines).toContainEqual(expect.stringContaining("refusing"));
    } finally {
      fake.stop();
    }
  });

  test("completion clears Progress and closes the workspace", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: DONE, priority: 1, description: CRITERIA, labelIds: [COMPLETE] });
      const workspaces = new FakeWorkspaces();
      const ws = workspaces.seedWorkspace("STA-1", {
        ticket: "STA-1",
        status: "deliver",
        progress: "complete",
        checkpoint: "head-1",
        receipt_kind: "deliver",
        receipt_id: "comment-2",
        submission: "sub-2",
      });
      fake.world.issues[0]!.comments.push({
        id: "comment-2",
        body: `# Deliver receipt\n\n${receiptBlock("deliver", "head-1", "sub-2", "head-1")}\n`,
        createdAt: "2026-09-04T00:00:00.000001Z",
      });
      const { watcher, lines } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      expect(fake.world.issues[0]!.labelIds).toEqual([]);
      expect(ws.closed).toBe(true);
      expect(lines).toContainEqual(expect.stringContaining("STA-1 done: Deliver+Complete → Done"));
    } finally {
      fake.stop();
    }
  });

  test("a concurrent human move out of Todo wins silently", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      let first = true;
      const realFetch = client.fetchIssue.bind(client);
      client.fetchIssue = (async (id: string) => {
        const full = await realFetch(id);
        if (first && full && full.identifier === "STA-1") {
          first = false;
          full.state = { id: BUILD, name: "Build" };
        }
        return full;
      }) as typeof client.fetchIssue;
      const { watcher, seen, lines } = watch(client, resolved);
      await watcher.pollOnce();
      expect(seen).toEqual([]);
      expect(lines.filter((l) => l.startsWith("STA-1"))).toEqual([]);
    } finally {
      fake.stop();
    }
  });

  test("an unreadable Herdr waits instead of claiming", async () => {
    const { fake, client, resolved } = await setup();
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const workspaces = new FakeWorkspaces();
      workspaces.failMethods.add("snapshot");
      const { watcher, seen } = watch(client, resolved, { workspaces });
      await watcher.pollOnce();
      expect(seen).toEqual([]);
      expect(fake.world.issues[0]!.stateId).toBe(TODO);
    } finally {
      fake.stop();
    }
  });
});

describe("dispatch log", () => {
  test("decisions print and append", async () => {
    const dir = mkdtempSync(join(tmpdir(), "igniter-log-"));
    const logPath = join(dir, "dispatch.log");
    const printed: string[] = [];
    const log = createDispatchLog(logPath, (line) => printed.push(line));
    await log.record("STA-1", "claimed: Todo → Build (slot 0)");
    await log.record("STA-2", "waiting: slots full (1 running)");
    expect(printed).toHaveLength(2);
    expect((await Bun.file(logPath).text()).trim().split("\n")).toHaveLength(2);
  });
});

describe("watch loop", () => {
  test("rate limits cool down instead of crashing", async () => {
    const { fake, client, resolved } = await setup();
    try {
      fake.world.failRateLimitFirst = 1;
      const { watcher } = watch(client, resolved);
      const errors: Error[] = [];
      const handle = startWatch({ watcher, intervalMs: 5, rateLimitCooldownMs: 30, onError: (e) => errors.push(e) });
      await Bun.sleep(120);
      await handle.stop();
      expect(errors.some((e) => e instanceof LinearError && e.status === 429)).toBe(true);
    } finally {
      fake.stop();
    }
  });
});

test("requireLinearApiKey reads the environment only", () => {
  expect(() => requireLinearApiKey({})).toThrow("LINEAR_API_KEY is not set");
  expect(requireLinearApiKey({ LINEAR_API_KEY: "k" })).toBe("k");
});
