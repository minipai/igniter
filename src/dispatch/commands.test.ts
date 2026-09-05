// Dispatch commands against a fake Linear endpoint and fake Herdr: every
// command's ok/text/data, refusals, slots, and activity lines. No network,
// no real credentials, no real project, no daemon.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceSink,
  buildWorkOrder,
  runCommand,
  type CommandContext,
} from "./commands";
import { validateStartup, type ResolvedDispatch } from "./claims";
import { parseDispatchConfig } from "./config";
import { LinearClient } from "./linear";
import { addIssue, standardWorld, startFakeLinear } from "./fake-linear";
import { FakeGit } from "./fake-git";
import { FakeWorkspaces } from "./fake-workspaces";
import { ticketWorktree } from "./worktrees";

const BUILDING = "st-building";
const REVIEW = "st-review";
const TODO = "st-todo";
const DONE = "st-done";
const CANCELED = "st-canceled";
const CRITERIA = "## 驗收條件\n- [ ] works\n";
const NOW = Date.parse("2026-09-05T12:00:00.000Z");
const LAST_POLL = "2026-09-05T11:59:48.000Z";

interface Harness {
  ctx: CommandContext;
  lines: string[];
  workspaces: FakeWorkspaces;
  git: FakeGit;
  repoRoot: string;
  lastPoll: string | null;
  stop: () => void;
}

async function harness(maxRunning = 3, maxHours = 4): Promise<Harness & { client: LinearClient; resolved: ResolvedDispatch; world: ReturnType<typeof standardWorld> }> {
  const world = standardWorld("test-key");
  const fake = startFakeLinear(world);
  const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url });
  const resolved = await validateStartup(
    client,
    parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: maxRunning, max_hours: maxHours }),
  );
  const lines: string[] = [];
  const workspaces = new FakeWorkspaces();
  const git = new FakeGit();
  // A real temp dir: the sink creates the worktree parent for real, while
  // git itself stays fake.
  const repoRoot = join(mkdtempSync(join(tmpdir(), "igniter-wt-root-")), "repo");
  const sink = createWorkspaceSink({
    workspaces,
    config: resolved.config,
    repoRoot,
    readApiKey: () => "test-key",
    runGit: git,
    now: () => "2026-09-05T12:00:00.000Z",
  });
  let lastPoll: string | null = LAST_POLL;
  const ctx: CommandContext = {
    client,
    resolved,
    host: "h",
    decisions: {
      record: async (ticket, message) => {
        lines.push(`${ticket} ${message}`);
      },
    },
    workspaces,
    sink,
    repoRoot,
    lastPollAt: () => lastPoll,
    now: () => NOW,
  };
  return {
    ctx,
    lines,
    workspaces,
    git,
    repoRoot,
    client,
    resolved,
    world,
    get lastPoll() {
      return lastPoll;
    },
    set lastPoll(value: string | null) {
      lastPoll = value;
    },
    stop: () => fake.stop(),
  };
}

describe("argv parsing", () => {
  test("unknown command and missing tickets answer ok:false with usage", async () => {
    const h = await harness();
    try {
      expect(await runCommand([], h.ctx)).toEqual({ ok: false, text: expect.stringContaining("usage: igniter") });
      expect(await runCommand(["frobnicate"], h.ctx)).toMatchObject({ ok: false });
      expect((await runCommand(["frobnicate"], h.ctx)).text).toContain("usage: igniter");
      for (const argv of [
        ["start"], ["pause"], ["resume"], ["fail"], ["restart"],
        ["fail", "STA-1"], ["restart", "STA-1"], ["start", "--builder", "x"],
        ["pause", "STA-1", "--bogus"],
      ]) {
        const out = await runCommand(argv, h.ctx);
        expect(out.ok).toBe(false);
        expect(out.text).toContain("usage: igniter");
      }
      expect(h.lines).toEqual([]);
    } finally {
      h.stop();
    }
  });
});

describe("status", () => {
  test("empty building list reports free slots", async () => {
    const h = await harness();
    try {
      const out = await runCommand(["status"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("0 / 3 slots");
      expect(out.text).toContain("last Linear poll 12s ago");
      expect(out.data).toMatchObject({ slots: { used: 0, max: 3 }, lastPollAt: LAST_POLL, tickets: [] });
      expect(h.lines).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("one line per ticket with stage, elapsed, over flag, and commander", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-161", stateId: BUILDING, priority: 1, description: CRITERIA, title: "First" });
      addIssue(h.world, { identifier: "STA-173", stateId: BUILDING, priority: 1, description: CRITERIA, title: "Second" });
      addIssue(h.world, { identifier: "STA-170", stateId: BUILDING, priority: 1, description: CRITERIA, title: "Third" });
      h.workspaces.seedWorkspace("STA-161", {
        ticket: "STA-161",
        stage: "build",
        stage_at: "2026-09-05T11:26:00.000Z",
        started_at: "2026-09-05T10:48:00.000Z",
      });
      h.workspaces.seedWorkspace("STA-173", {
        ticket: "STA-173",
        stage: "acceptance",
        stage_at: "2026-09-05T10:00:00.000Z",
        started_at: "2026-09-05T06:58:00.000Z",
        paused: "1",
      }, { commanderStatus: "idle" });
      const out = await runCommand(["status"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("2 / 3 slots");
      expect(out.text).toContain("STA-161  1h12m / 4h");
      expect(out.text).toContain("stage build · 34m");
      expect(out.text).toContain("commander working");
      expect(out.text).toContain("STA-173  5h02m / 4h   stage acceptance");
      expect(out.text).not.toContain("OVER");
      expect(out.text).toContain("commander idle · paused");
      expect(out.text).toContain("STA-170  no workspace");
      const data = out.data as { slots: { used: number; max: number }; tickets: Record<string, unknown>[] };
      expect(data.slots).toEqual({ used: 2, max: 3 });
      const first = data.tickets[0] as Record<string, unknown>;
      expect(first).toMatchObject({
        identifier: "STA-161",
        title: "First",
        hasWorkspace: true,
        stage: "build",
        startedAt: "2026-09-05T10:48:00.000Z",
        over: false,
        commander: "working",
        paused: false,
      });
      const second = data.tickets[1] as Record<string, unknown>;
      expect(second).toMatchObject({ identifier: "STA-173", over: false, commander: "idle", paused: true });
    } finally {
      h.stop();
    }
  });

  test("over needs elapsed past budget and a stage before acceptance", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-177", stateId: REVIEW, priority: 1, description: CRITERIA });
      h.workspaces.seedWorkspace("STA-177", {
        ticket: "STA-177",
        stage: "acceptance",
        stage_at: "2026-09-05T10:00:00.000Z",
        started_at: "2026-09-05T06:58:00.000Z",
      });
      addIssue(h.world, { identifier: "STA-178", stateId: BUILDING, priority: 1, description: CRITERIA });
      h.workspaces.seedWorkspace("STA-178", {
        ticket: "STA-178",
        stage: "build",
        stage_at: "2026-09-05T10:00:00.000Z",
        started_at: "2026-09-05T06:58:00.000Z",
      });
      const out = await runCommand(["status"], h.ctx);
      expect(out.text).toContain("STA-177  Ready to review  5h02m / 4h   stage acceptance");
      expect(out.text).toContain("STA-178  5h02m / 4h OVER");
      const data = out.data as { tickets: Record<string, unknown>[] };
      expect(data.tickets).toMatchObject([
        { identifier: "STA-178", over: true },
        { identifier: "STA-177", over: false },
      ]);
    } finally {
      h.stop();
    }
  });

  test("stalled and over_budget flags show", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      h.workspaces.seedWorkspace("STA-1", {
        ticket: "STA-1",
        stage: "build",
        stage_at: "2026-09-05T11:00:00.000Z",
        started_at: "2026-09-05T11:00:00.000Z",
        stalled: "1",
        over_budget: "1",
      });
      const out = await runCommand(["status"], h.ctx);
      expect(out.text).toContain("stalled");
      expect(out.text).toContain("over_budget");
      expect((out.data as { tickets: { stalled: boolean; overBudget: boolean }[] }).tickets[0]).toMatchObject({
        stalled: true,
        overBudget: true,
      });
    } finally {
      h.stop();
    }
  });

  test("an over-budget building ticket holds no slot in the header", async () => {
    const h = await harness(1);
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      h.workspaces.seedWorkspace("STA-1", {
        ticket: "STA-1",
        stage: "build",
        stage_at: "2026-09-05T11:00:00.000Z",
        started_at: "2026-09-05T11:00:00.000Z",
        over_budget: "1",
      });
      const out = await runCommand(["status"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("0 / 1 slots");
      expect(out.text).toContain("over_budget");
      expect((out.data as { slots: { used: number; max: number } }).slots).toEqual({ used: 0, max: 1 });
    } finally {
      h.stop();
    }
  });

  test("an unreachable Herdr lists Linear tickets without workspace info", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      h.workspaces.failMethods.add("snapshot");
      const out = await runCommand(["status"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("herdr unreachable: fake herdr exploded");
      expect(out.text).toContain("STA-1  no workspace info");
    } finally {
      h.stop();
    }
  });

  test("a ready-to-merge ticket shows while its workspace is open, and drops off without one", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-180", stateId: "st-merge", priority: 1, description: CRITERIA, title: "Merging" });
      h.workspaces.seedWorkspace("STA-180", {
        ticket: "STA-180",
        stage: "delivered",
        stage_at: "2026-09-05T11:48:00.000Z",
        started_at: "2026-09-05T11:47:00.000Z",
      }, { commanderStatus: "done" });
      addIssue(h.world, { identifier: "STA-181", stateId: "st-merge", priority: 1, description: CRITERIA, title: "Closed" });
      const out = await runCommand(["status"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("0 / 3 slots");
      expect(out.text).toContain("STA-180  Ready to merge  13m / 4h   stage delivered · 12m   commander done");
      expect(out.text).not.toContain("STA-181");
      const data = out.data as { slots: { used: number; max: number }; tickets: Record<string, unknown>[] };
      expect(data.slots).toEqual({ used: 0, max: 3 });
      expect(data.tickets.map((t) => t["identifier"])).toEqual(["STA-180"]);
      expect(data.tickets[0]).toMatchObject({
        identifier: "STA-180",
        title: "Merging",
        state: "Ready to merge",
        hasWorkspace: true,
        stage: "delivered",
        commander: "done",
        over: false,
      });
    } finally {
      h.stop();
    }
  });

  test("a review-state ticket shows with its workspace and takes no slot", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-176", stateId: BUILDING, priority: 1, description: CRITERIA, title: "Building" });
      h.workspaces.seedWorkspace("STA-176", {
        ticket: "STA-176",
        stage: "build",
        stage_at: "2026-09-05T11:26:00.000Z",
        started_at: "2026-09-05T10:48:00.000Z",
      });
      addIssue(h.world, { identifier: "STA-177", stateId: REVIEW, priority: 1, description: CRITERIA, title: "Reviewing" });
      h.workspaces.seedWorkspace("STA-177", {
        ticket: "STA-177",
        stage: "acceptance",
        stage_at: "2026-09-05T11:48:00.000Z",
        started_at: "2026-09-05T11:47:00.000Z",
      }, { commanderStatus: "done" });
      const out = await runCommand(["status"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("1 / 3 slots");
      expect(out.text).toContain(
        "STA-177  Ready to review  13m / 4h   stage acceptance · 12m   commander done",
      );
      const data = out.data as { slots: { used: number; max: number }; tickets: Record<string, unknown>[] };
      expect(data.slots).toEqual({ used: 1, max: 3 });
      expect(data.tickets.map((t) => t["identifier"])).toEqual(["STA-176", "STA-177"]);
      expect(data.tickets[1]).toMatchObject({
        identifier: "STA-177",
        title: "Reviewing",
        state: "Ready to review",
        hasWorkspace: true,
        stage: "acceptance",
        commander: "done",
      });
    } finally {
      h.stop();
    }
  });
});

describe("start", () => {
  test("a Backlog ticket opens a workspace, prompts the commander, moves Linear", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-176", stateId: TODO, priority: 1, description: CRITERIA, title: "Dispatch commands" });
      const out = await runCommand(["start", "STA-176", "--builder", "custom/builder-x"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("claimed STA-176 → Building (slot 0)");
      expect(out.text).toContain("workspace ws-1 opened");      const issue = h.world.issues[0]!;
      expect(issue.stateId).toBe(BUILDING);
      expect(issue.comments.some((c) => c.body.includes("<!-- igniter:claim -->"))).toBe(true);
      const created = h.workspaces.calls.find((c) => c.method === "workspace.create");
      const wt = ticketWorktree(h.repoRoot, "STA-176");
      expect(created?.params).toMatchObject({
        label: "STA-176",
        cwd: wt.path,
        env: { LINEAR_API_KEY: "test-key", IGNITER_TICKET: "STA-176" },
      });
      expect(h.git.commands.map((c) => c.args)).toEqual([
        ["worktree", "list", "--porcelain"],
        ["rev-parse", "--verify", "refs/heads/feature/sta-176"],
        ["worktree", "add", "-b", "feature/sta-176", wt.path, "main"],
      ]);
      expect(h.workspaces.tokensFor("STA-176")).toMatchObject({
        ticket: "STA-176",
        commander: "claude",
        builder: "custom/builder-x",
        started_at: "2026-09-05T12:00:00.000Z",
      });
      expect(h.workspaces.tokensFor("STA-176")).not.toHaveProperty("stage");
      const inbox = h.workspaces.promptsFor("commander-sta-176");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toContain("STA-176");
      expect(inbox[0]).toContain("Dispatch commands");
      expect(inbox[0]).toContain("https://linear.app/starcoder/issue/STA-176");
      expect(inbox[0]).toContain(
        `Workspace: a git worktree at ${ticketWorktree(h.repoRoot, "STA-176").path} on branch feature/sta-176`,
      );
      expect(inbox[0]).toContain("custom/builder-x");
      expect(inbox[0]).toContain("`igniter stage plan`");
      expect(h.lines).toEqual([
        "STA-176 claimed: Todo → Building (slot 0)",
        "STA-176 state: Todo → Building",
        "STA-176 workspace opened (ws-1) commander=claude builder=custom/builder-x",
      ]);
    } finally {
      h.stop();
    }
  });

  test("refuses done and canceled tickets with one activity line", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-9", stateId: DONE, priority: 1, description: CRITERIA });
      addIssue(h.world, { identifier: "STA-10", stateId: CANCELED, priority: 1, description: CRITERIA });
      const done = await runCommand(["start", "STA-9"], h.ctx);
      expect(done).toMatchObject({ ok: false });
      expect(done.text).toContain("ticket is Done");
      const canceled = await runCommand(["start", "STA-10"], h.ctx);
      expect(canceled.text).toContain("ticket is Canceled");
      expect(h.lines).toEqual([
        "STA-9 start refused: ticket is Done",
        "STA-10 start refused: ticket is Canceled",
      ]);
      expect(h.workspaces.workspaces).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("refuses unknown agent kinds with the known list", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA });
      const out = await runCommand(["start", "STA-1", "--agent", "hal"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain('unknown agent kind "hal"');
      expect(out.text).toContain("claude");
      expect(h.lines).toEqual(['STA-1 start refused: unknown agent kind "hal"']);
    } finally {
      h.stop();
    }
  });

  test("refuses at the cap and lists the running tickets", async () => {
    const h = await harness(1);
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      addIssue(h.world, { identifier: "STA-2", stateId: TODO, priority: 1, description: CRITERIA });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1" });
      const out = await runCommand(["start", "STA-2"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("at max_running (1)");
      expect(out.text).toContain("STA-1");
      expect(h.world.issues[1]!.stateId).toBe(TODO);
      expect(h.lines).toEqual(["STA-2 start refused: at max_running (1); running: STA-1"]);
    } finally {
      h.stop();
    }
  });

  test("a paused ticket frees its slot for start", async () => {
    const h = await harness(1);
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      addIssue(h.world, { identifier: "STA-2", stateId: TODO, priority: 1, description: CRITERIA });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1", paused: "1" });
      const out = await runCommand(["start", "STA-2"], h.ctx);
      expect(out.ok).toBe(true);
      expect(h.world.issues[1]!.stateId).toBe(BUILDING);
    } finally {
      h.stop();
    }
  });

  test("an over-budget ticket frees its slot for start", async () => {
    const h = await harness(1);
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      addIssue(h.world, { identifier: "STA-2", stateId: TODO, priority: 1, description: CRITERIA });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1", over_budget: "1" });
      const out = await runCommand(["start", "STA-2"], h.ctx);
      expect(out.ok).toBe(true);
      expect(h.world.issues[1]!.stateId).toBe(BUILDING);
    } finally {
      h.stop();
    }
  });

  test("missing criteria leaves a nudge and refuses", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-3", stateId: TODO, priority: 1, description: "nothing" });
      const out = await runCommand(["start", "STA-3"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("acceptance-criteria");
      expect(h.world.issues[0]!.stateId).toBe(TODO);
      expect(h.world.issues[0]!.comments.some((c) => c.body.includes("<!-- igniter:missing-criteria -->"))).toBe(true);
    } finally {
      h.stop();
    }
  });

  test("an already-running ticket is refused; a building one without workspace is adopted", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-4", stateId: BUILDING, priority: 1, description: CRITERIA });
      h.workspaces.seedWorkspace("STA-4", { ticket: "STA-4" });
      const refused = await runCommand(["start", "STA-4"], h.ctx);
      expect(refused).toMatchObject({ ok: false });
      expect(refused.text).toContain("already running");
      expect(h.lines).toEqual(["STA-4 start refused: already running"]);

      const h2 = await harness();
      try {
        addIssue(h2.world, { identifier: "STA-5", stateId: BUILDING, priority: 1, description: CRITERIA });
        const adopted = await runCommand(["start", "STA-5"], h2.ctx);
        expect(adopted.ok).toBe(true);
        expect(h2.workspaces.tokensFor("STA-5")).toMatchObject({ ticket: "STA-5" });
      } finally {
        h2.stop();
      }
    } finally {
      h.stop();
    }
  });

  test("a mid-way sink failure reports the workspace id", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA });
      h.workspaces.failMethods.add("agent.start");
      const out = await runCommand(["start", "STA-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("(workspace ws-1)");
      expect(out.text).toContain(
        "the ticket is already in Building: fix the workspace and run `igniter resume STA-1`",
      );
      expect(h.lines).toContain("STA-1 handoff failed: fake herdr exploded (workspace ws-1)");
    } finally {
      h.stop();
    }
  });
});

describe("pause and resume", () => {
  test("pause writes paused=1 and prompts the commander", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1", stage: "build" });
      const out = await runCommand(["pause", "STA-1"], h.ctx);
      expect(out).toMatchObject({ ok: true });
      expect(out.text).toContain("paused STA-1");
      expect(h.workspaces.tokensFor("STA-1")).toMatchObject({ paused: "1" });
      expect(h.workspaces.promptsFor("commander-sta-1")).toEqual([
        expect.stringContaining("the owner paused this ticket"),
      ]);
      expect(h.lines).toEqual(["STA-1 paused by command"]);
    } finally {
      h.stop();
    }
  });

  test("pause without a commander still records paused=1", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1" }, { commander: false });
      const out = await runCommand(["pause", "STA-1"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("no commander agent");
      expect(h.workspaces.tokensFor("STA-1")).toMatchObject({ paused: "1" });
    } finally {
      h.stop();
    }
  });

  test("pause without a workspace refuses", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const out = await runCommand(["pause", "STA-1"], h.ctx);
      expect(out).toMatchObject({ ok: false });
      expect(out.text).toContain("no workspace for STA-1");
    } finally {
      h.stop();
    }
  });

  test("pause refuses a ticket from another project", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "OTH-1", stateId: BUILDING, priority: 1, description: CRITERIA, projectId: "proj-2" });
      const out = await runCommand(["pause", "OTH-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain('ticket "OTH-1" is not in project "igniter"');
      expect(h.lines).toEqual(['OTH-1 pause failed: not in project "igniter"']);
    } finally {
      h.stop();
    }
  });

  test("resume clears paused and over_budget and prompts the commander", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      h.workspaces.seedWorkspace("STA-1", {
        ticket: "STA-1",
        stage: "verify",
        review_count: "1",
        verify_count: "2",
        paused: "1",
        over_budget: "1",
      });
      const out = await runCommand(["resume", "STA-1"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("resumed STA-1");
      const tokens = h.workspaces.tokensFor("STA-1");
      expect(tokens).not.toHaveProperty("paused");
      expect(tokens).not.toHaveProperty("over_budget");
      expect(h.workspaces.promptsFor("commander-sta-1")).toEqual([
        "igniter: resume. Continue from stage verify (review_count 1, verify_count 2); do not restart from plan.",
      ]);
      expect(h.lines).toEqual(["STA-1 resumed by command"]);
    } finally {
      h.stop();
    }
  });

  test("resume refuses when every slot is taken by others", async () => {
    const h = await harness(1);
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      addIssue(h.world, { identifier: "STA-2", stateId: BUILDING, priority: 1, description: CRITERIA });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1", paused: "1" });
      h.workspaces.seedWorkspace("STA-2", { ticket: "STA-2" });
      const out = await runCommand(["resume", "STA-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("at max_running (1)");
      expect(out.text).toContain("STA-2");
      expect(h.workspaces.tokensFor("STA-1")).toMatchObject({ paused: "1" });
    } finally {
      h.stop();
    }
  });

  test("an over-budget other frees its slot for resume", async () => {
    const h = await harness(1);
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      addIssue(h.world, { identifier: "STA-2", stateId: BUILDING, priority: 1, description: CRITERIA });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1", stage: "build", paused: "1" });
      h.workspaces.seedWorkspace("STA-2", { ticket: "STA-2", stage: "build", over_budget: "1" });
      const out = await runCommand(["resume", "STA-1"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("resumed STA-1");
    } finally {
      h.stop();
    }
  });

  test("resume without a commander starts a new one that continues from metadata", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA, title: "Gone commander" });
      h.workspaces.seedWorkspace("STA-1", {
        ticket: "STA-1",
        stage: "build",
        review_count: "2",
        verify_count: "1",
        commander: "codex",
        paused: "1",
      }, { commander: false });
      const out = await runCommand(["resume", "STA-1"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("new commander commander-sta-1 started");
      const started = h.workspaces.calls.find((c) => c.method === "agent.start");
      expect(started?.params).toMatchObject({ kind: "codex", name: "commander-sta-1" });
      const inbox = h.workspaces.promptsFor("commander-sta-1");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toContain("This is a resumed run.");
      expect(inbox[0]).toContain("stage=build, review_count=2, verify_count=1");
      expect(inbox[0]).toContain("do not restart from plan");
      expect(inbox[0]).toContain("Checkpoint commits are on the ticket branch.");
    } finally {
      h.stop();
    }
  });

  test("resume without a workspace points at start", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const out = await runCommand(["resume", "STA-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("no workspace for STA-1; use `igniter start STA-1`");
    } finally {
      h.stop();
    }
  });

  test("resume refuses a ticket from another project", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "OTH-1", stateId: BUILDING, priority: 1, description: CRITERIA, projectId: "proj-2" });
      const out = await runCommand(["resume", "OTH-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain('ticket "OTH-1" is not in project "igniter"');
      expect(h.lines).toEqual(['OTH-1 resume failed: not in project "igniter"']);
    } finally {
      h.stop();
    }
  });
});

describe("fail", () => {
  test("fails the ticket with label, comment, pane tail, and a closed workspace", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1", stage: "build" }, { paneText: "panic: boom\nat build.ts:1" });
      const out = await runCommand(["fail", "STA-1", "--reason", "builder wedged"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("failed STA-1: builder wedged");
      const issue = h.world.issues[0]!;
      expect(issue.stateId).toBe("st-todo");
      const failedLabel = h.world.labels.find((l) => l.name === "agent-failed");
      expect(failedLabel).toBeDefined();
      expect(issue.labelIds).toEqual([failedLabel!.id]);
      const comment = issue.comments[issue.comments.length - 1]!;
      expect(comment.body).toContain("<!-- igniter:failed -->");
      expect(comment.body).toContain("builder wedged");
      expect(comment.body).toContain("```\npanic: boom\nat build.ts:1\n```");
      expect(h.workspaces.workspaces[0]!.closed).toBe(true);
      expect(h.lines).toEqual([
        "STA-1 failed: builder wedged",
        "STA-1 workspace closed (ws-1)",
      ]);
    } finally {
      h.stop();
    }
  });

  test("keeps existing labels when adding agent-failed", async () => {
    const h = await harness();
    try {
      h.world.labels.push({ id: "label-9", name: "keep", teamId: "team-1" });
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA, labelIds: ["label-9"] });
      const out = await runCommand(["fail", "STA-1", "--reason", "x"], h.ctx);
      expect(out.ok).toBe(true);
      const issue = h.world.issues[0]!;
      const failedLabel = h.world.labels.find((l) => l.name === "agent-failed")!;
      expect(new Set(issue.labelIds)).toEqual(new Set(["label-9", failedLabel.id]));
    } finally {
      h.stop();
    }
  });

  test("reuses a workspace-wide agent-failed label instead of creating a duplicate", async () => {
    const h = await harness();
    try {
      // No team: the old team-scoped lookup missed exactly this label, and
      // creating a team copy then failed as a duplicate on the real API.
      h.world.labels.push({ id: "label-7", name: "agent-failed", teamId: "" });
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const out = await runCommand(["fail", "STA-1", "--reason", "x"], h.ctx);
      expect(out.ok).toBe(true);
      expect(h.world.issues[0]!.labelIds).toEqual(["label-7"]);
      expect(h.world.labels.filter((l) => l.name === "agent-failed")).toHaveLength(1);
    } finally {
      h.stop();
    }
  });

  test("works without a workspace: no tail, no close", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      const out = await runCommand(["fail", "STA-1", "--reason", "no run"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("no workspace to close");
      const comment = h.world.issues[0]!.comments.at(-1)!;
      expect(comment.body).toContain("<!-- igniter:failed -->");
      expect(comment.body).not.toContain("```");
    } finally {
      h.stop();
    }
  });
});

describe("restart", () => {
  test("writes the new builder and prompts the commander", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1", builder: "old/model" });
      const out = await runCommand(["restart", "STA-1", "--builder", "new/model"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("restarted STA-1 with builder new/model");
      expect(h.workspaces.tokensFor("STA-1")).toMatchObject({ builder: "new/model" });
      const inbox = h.workspaces.promptsFor("commander-sta-1");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toContain("restart the Builder with model new/model");
      expect(inbox[0]).toContain("read `git diff` first");
      expect(h.lines).toEqual(["STA-1 restarted with builder new/model by command"]);
    } finally {
      h.stop();
    }
  });

  test("without a live commander says to resume first", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILDING, priority: 1, description: CRITERIA });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1" }, { commander: false });
      const out = await runCommand(["restart", "STA-1", "--builder", "new/model"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("use `igniter resume STA-1` first");
    } finally {
      h.stop();
    }
  });

  test("restart refuses a ticket from another project", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "OTH-1", stateId: BUILDING, priority: 1, description: CRITERIA, projectId: "proj-2" });
      const out = await runCommand(["restart", "OTH-1", "--builder", "new/model"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain('ticket "OTH-1" is not in project "igniter"');
      expect(h.lines).toEqual(['OTH-1 restart failed: not in project "igniter"']);
    } finally {
      h.stop();
    }
  });
});

describe("work order", () => {
  test("carries every fact the commander needs", () => {
    const order = buildWorkOrder({
      identifier: "STA-176",
      title: "Dispatch commands",
      issueUrl: "https://linear.app/starcoder/issue/STA-176",
      worktreePath: "/repo-wt/sta-176",
      branch: "feature/sta-176",
      builderModel: "b-model",
      reviewerModel: "r-model",
      escalateModel: "e-model",
    });
    for (const needle of [
      "STA-176",
      "Dispatch commands",
      "https://linear.app/starcoder/issue/STA-176",
      "Workspace: a git worktree at /repo-wt/sta-176 on branch feature/sta-176 (base main), created by igniter.",
      "do not create another branch",
      "bun install",
      "b-model",
      "r-model",
      "e-model",
      "src/commander/rules.md",
      "AGENTS.md",
      "LINEAR_API_KEY",
      "Linear GraphQL API",
      "`igniter stage plan`",
    ]) {
      expect(order).toContain(needle);
    }
  });

  test("a worktree failure aborts the start before any workspace opens", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA });
      h.git.failOn = ["worktree"];
      h.git.failMessage = "fatal: not a git repository";
      const out = await runCommand(["start", "STA-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("not a git repository");
      expect(h.workspaces.workspaces).toHaveLength(0);
      expect(h.world.issues[0]!.stateId).toBe(BUILDING);
      expect(h.lines).toContainEqual(
        expect.stringContaining("STA-1 handoff failed:"),
      );
    } finally {
      h.stop();
    }
  });
});
