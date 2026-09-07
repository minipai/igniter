// Dispatch commands against a fake Linear endpoint and fake Herdr: every
// command's ok/text/data, refusals, slots, and activity lines. No network,
// no real credentials, no real project, no daemon.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { commanderAssetPaths } from "../commander/assets";
import {
  createWorkspaceSink,
  buildWorkOrder,
  runCommand,
  scratchPathsFor,
  type CommandContext,
} from "./commands";
import { validateStartup, type ResolvedDispatch } from "./claims";
import { DEFAULT_COMMANDER_CONFIG, parseDispatchConfig } from "./config";
import { LinearClient } from "./linear";
import { addIssue, standardWorld, startFakeLinear } from "./fake-linear";
import { FakeGit } from "./fake-git";
import { FakeWorkspaces } from "./fake-workspaces";
import { ticketWorktree } from "./worktrees";

const BUILD = "st-build";
const REVIEW = "st-review";
const TODO = "st-todo";
const DONE = "st-done";
const CANCELED = "st-canceled";
const PENDING = "label-pending";
const IN_PROGRESS = "label-in-progress";
const COMPLETE = "label-complete";
const BLOCKED = "label-blocked";
const CRITERIA = "## 驗收條件\n- [ ] works\n";
const HEAD = "cafe0001deadbeef";

interface Harness {
  ctx: CommandContext;
  lines: string[];
  workspaces: FakeWorkspaces;
  git: FakeGit;
  repoRoot: string;
  stop: () => void;
}

async function harness(maxRunning = 3): Promise<Harness & { client: LinearClient; resolved: ResolvedDispatch; world: ReturnType<typeof standardWorld> }> {
  const world = standardWorld("test-key");
  const fake = startFakeLinear(world);
  const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url });
  const resolved = await validateStartup(
    client,
    parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: maxRunning }),
  );
  const lines: string[] = [];
  const workspaces = new FakeWorkspaces();
  const git = new FakeGit();
  git.head = HEAD;
  const repoRoot = join(mkdtempSync(join(tmpdir(), "igniter-runtime-root-")), "repo");
  const sink = createWorkspaceSink({ workspaces, config: resolved.config, repoRoot, runGit: git });
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
    git,
    lastPollAt: () => null,
  };
  return { ctx, lines, workspaces, git, repoRoot, client, resolved, world, stop: () => fake.stop() };
}

describe("argv parsing", () => {
  test("unknown command and bad argv answer ok:false with usage", async () => {
    const h = await harness();
    try {
      expect(await runCommand([], h.ctx)).toEqual({ ok: false, text: expect.stringContaining("usage: igniter") });
      expect(await runCommand(["frobnicate"], h.ctx)).toMatchObject({ ok: false });
      expect((await runCommand(["frobnicate"], h.ctx)).text).toContain("usage: igniter");
      for (const argv of [
        ["start"], ["pause"], ["resume"], ["fail"], ["restart"],
        ["fail", "STA-1"], ["restart", "STA-1"], ["start", "--builder", "x"],
        ["pause", "STA-1", "--bogus"], ["state"], ["state", "x"],
        ["begin", "STA-1"], ["submit"], ["submit", "--input", "file"],
        ["block"], ["block", "--reason", ""], ["unblock", "x"],
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

  test("workspace commands without a workspace id refuse", async () => {
    const h = await harness();
    try {
      for (const argv of [["state", "--json"], ["begin"], ["block", "--reason", "x"], ["unblock"]]) {
        const out = await runCommand(argv, h.ctx);
        expect(out.ok).toBe(false);
        expect(out.text).toContain("Herdr workspace only");
      }
    } finally {
      h.stop();
    }
  });
});

describe("status", () => {
  test("empty run reports free slots", async () => {
    const h = await harness();
    try {
      const out = await runCommand(["status"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("0 / 3 slots");
      expect(out.data).toMatchObject({ slots: { used: 0, max: 3 }, tickets: [] });
      expect(h.lines).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("one line per ticket with status, progress, checkpoint, and receipt", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      await runCommand(["start", "STA-1"], h.ctx);
      addIssue(h.world, { identifier: "STA-2", stateId: REVIEW, priority: 1, description: CRITERIA, title: "Second", labelIds: [COMPLETE] });
      h.workspaces.seedWorkspace("STA-2", {
        ticket: "STA-2",
        status: "review",
        progress: "complete",
        checkpoint: "abc",
        receipt_kind: "review-pass",
        receipt_id: "comment-9",
      }, { commanderStatus: "idle" });
      const out = await runCommand(["status"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("1 / 3 slots");
      expect(out.text).toContain("STA-1  Build/In progress");
      expect(out.text).toContain("STA-2  Review/Complete");
      expect(out.text).toContain("receipt review-pass:comment-9");
      const data = out.data as { slots: { used: number; max: number }; tickets: Record<string, unknown>[] };
      expect(data.slots).toEqual({ used: 1, max: 3 });
      expect(data.tickets).toMatchObject([
        { identifier: "STA-1", progress: "in_progress", hasWorkspace: true, paused: false },
        { identifier: "STA-2", progress: "complete", commander: "idle" },
      ]);
    } finally {
      h.stop();
    }
  });

  test("a blocked build ticket holds no slot", async () => {
    const h = await harness(1);
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [BLOCKED] });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1", status: "build", progress: "blocked", block_reason: "x" });
      const out = await runCommand(["status"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("0 / 1 slots");
      expect(out.text).toContain("blocked");
      expect((out.data as { slots: { used: number; max: number } }).slots).toEqual({ used: 0, max: 1 });
    } finally {
      h.stop();
    }
  });

  test("an unreachable Herdr lists Linear tickets without workspace info", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      h.workspaces.failMethods.add("snapshot");
      const out = await runCommand(["status"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("herdr unreachable: fake herdr exploded");
      expect(out.text).toContain("STA-1  no workspace info");
    } finally {
      h.stop();
    }
  });
});

describe("start", () => {
  test("a Todo ticket opens a workspace with no secrets, moves Linear", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-176", stateId: TODO, priority: 1, description: CRITERIA, title: "Dispatch commands", labelIds: [PENDING] });
      const out = await runCommand(["start", "STA-176", "--builder", "custom/builder-x"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("claimed STA-176 → Build+In progress (slot 0)");
      expect(out.text).toContain("workspace ws-1 opened");
      const issue = h.world.issues[0]!;
      expect(issue.stateId).toBe(BUILD);
      expect(issue.labelIds).toEqual([IN_PROGRESS]);
      const created = h.workspaces.calls.find((c) => c.method === "workspace.create");
      const wt = ticketWorktree(h.repoRoot, "STA-176");
      expect(created?.params).toMatchObject({ label: "STA-176", cwd: wt.path, env: {} });
      expect(h.git.commands.map((c) => c.args)).toEqual([
        ["worktree", "list", "--porcelain"],
        ["rev-parse", "--verify", "refs/heads/feature/sta-176"],
        ["worktree", "add", "-b", "feature/sta-176", wt.path, "main"],
      ]);
      expect(h.workspaces.tokensFor("STA-176")).toMatchObject({
        ticket: "STA-176",
        commander: "claude",
        builder: "custom/builder-x",
        status: "build",
        progress: "in_progress",
      });
      const started = h.workspaces.calls.find((call) => call.method === "agent.start");
      expect(started?.params).toMatchObject({ kind: "claude", name: "commander-sta-176" });
      expect(started?.params).not.toHaveProperty("args");
      const inbox = h.workspaces.promptsFor("commander-sta-176");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toContain("STA-176");
      expect(inbox[0]).toContain("Dispatch commands");
      expect(inbox[0]).toContain("https://linear.app/starcoder/issue/STA-176");
      expect(inbox[0]).toContain(
        `Workspace: a git worktree at ${ticketWorktree(h.repoRoot, "STA-176").path} on branch feature/sta-176`,
      );
      expect(inbox[0]).toContain("custom/builder-x");
      expect(inbox[0]).toContain("`igniter state --json`");
      expect(inbox[0]).not.toContain("LINEAR_API_KEY");
      expect(inbox[0]).not.toContain("GraphQL");
      expect(h.lines).toEqual([
        "STA-176 claimed: Todo → Build (slot 0)",
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
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const out = await runCommand(["start", "STA-1", "--agent", "hal"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain('unknown agent kind "hal"');
      expect(out.text).toContain("claude");
    } finally {
      h.stop();
    }
  });

  test("missing criteria leaves a nudge and refuses", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-3", stateId: TODO, priority: 1, description: "nothing", labelIds: [PENDING] });
      const out = await runCommand(["start", "STA-3"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("acceptance-criteria");
      expect(h.world.issues[0]!.stateId).toBe(TODO);
      expect(h.world.issues[0]!.comments.some((c) => c.body.includes("<!-- igniter:missing-criteria -->"))).toBe(true);
    } finally {
      h.stop();
    }
  });

  test("an already-running ticket is refused; a Build one without workspace is adopted", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-4", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      h.workspaces.seedWorkspace("STA-4", { ticket: "STA-4", status: "build", progress: "in_progress" });
      const refused = await runCommand(["start", "STA-4"], h.ctx);
      expect(refused).toMatchObject({ ok: false });
      expect(refused.text).toContain("already running");
      expect(h.lines).toEqual(["STA-4 start refused: already running"]);

      addIssue(h.world, { identifier: "STA-5", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const adopted = await runCommand(["start", "STA-5"], h.ctx);
      expect(adopted.ok).toBe(true);
      expect(adopted.text).toContain("adopted STA-5");
      expect(h.workspaces.tokensFor("STA-5")).toMatchObject({ ticket: "STA-5", status: "build", progress: "pending" });
    } finally {
      h.stop();
    }
  });

  test("a Review orphan is adopted back to Pending; a half-written Todo claim is finished", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-6", stateId: REVIEW, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      const adopted = await runCommand(["start", "STA-6"], h.ctx);
      expect(adopted.ok).toBe(true);
      expect(adopted.text).toContain("at review+pending");
      expect(h.world.issues[0]!.stateId).toBe(REVIEW);
      expect(h.world.issues[0]!.labelIds).toEqual([PENDING]);

      // Half-written claim: workspace open, Linear still Todo+Pending.
      addIssue(h.world, { identifier: "STA-7", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.workspaces.seedWorkspace("STA-7", { ticket: "STA-7", commander: "claude", builder: "b" });
      const before = h.workspaces.workspaces.length;
      const finished = await runCommand(["start", "STA-7"], h.ctx);
      expect(finished.ok).toBe(true);
      expect(finished.text).toContain("finished in existing workspace");
      expect(h.workspaces.workspaces.length).toBe(before);
      expect(h.world.issues[1]!.stateId).toBe(BUILD);
      expect(h.world.issues[1]!.labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("start rebuilds a missing Commander before finishing a half-written Todo claim", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-7", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.workspaces.seedWorkspace(
        "STA-7",
        { ticket: "STA-7", commander: "claude", builder: "b" },
        { commander: false },
      );
      const before = h.workspaces.workspaces.length;
      const out = await runCommand(["start", "STA-7"], h.ctx);
      expect(out.ok).toBe(true);
      expect(h.workspaces.workspaces.length).toBe(before);
      expect(h.workspaces.promptsFor("commander-sta-7")).toHaveLength(1);
      expect(h.world.issues[0]!.stateId).toBe(BUILD);
      expect(h.world.issues[0]!.labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("a mid-way sink failure reports the workspace id", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.workspaces.failMethods.add("agent.start");
      const out = await runCommand(["start", "STA-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("(workspace ws-1)");
      expect(h.lines).toContain("STA-1 handoff failed: fake herdr exploded (workspace ws-1)");
    } finally {
      h.stop();
    }
  });
});

describe("pause and resume", () => {
  test("pause blocks with a reason, records paused, and prompts the commander", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      await runCommand(["start", "STA-1"], h.ctx);
      const out = await runCommand(["pause", "STA-1"], h.ctx);
      expect(out).toMatchObject({ ok: true });
      expect(out.text).toContain("paused STA-1");
      expect(h.world.issues[0]!.labelIds).toEqual([BLOCKED]);
      expect(h.workspaces.tokensFor("STA-1")).toMatchObject({ paused: "1" });
      expect(h.workspaces.promptsFor("commander-sta-1").at(-1)).toContain("the owner paused this ticket");
      expect(h.lines).toContain("STA-1 paused by command");
    } finally {
      h.stop();
    }
  });

  test("pause without a workspace refuses", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      const out = await runCommand(["pause", "STA-1"], h.ctx);
      expect(out).toMatchObject({ ok: false });
      expect(out.text).toContain("no workspace for STA-1");
    } finally {
      h.stop();
    }
  });

  test("resume clears paused and prompts the commander to continue", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      await runCommand(["start", "STA-1"], h.ctx);
      await runCommand(["pause", "STA-1"], h.ctx);
      const out = await runCommand(["resume", "STA-1"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("resumed STA-1");
      expect(h.world.issues[0]!.labelIds).toEqual([PENDING]);
      const tokens = h.workspaces.tokensFor("STA-1");
      expect(tokens).not.toHaveProperty("paused");
      expect(h.workspaces.promptsFor("commander-sta-1").at(-1)).toContain("igniter state --json");
      expect(h.lines).toContain("STA-1 resumed by command");
    } finally {
      h.stop();
    }
  });

  test("resume refuses when every slot is taken by others", async () => {
    const h = await harness(1);
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [BLOCKED] });
      addIssue(h.world, { identifier: "STA-2", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1", paused: "1", status: "build", progress: "blocked" });
      h.workspaces.seedWorkspace("STA-2", { ticket: "STA-2", status: "build", progress: "in_progress" });
      const out = await runCommand(["resume", "STA-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("at max_running (1)");
      expect(h.world.issues[0]!.labelIds).toEqual([BLOCKED]);
    } finally {
      h.stop();
    }
  });

  test("resume without a commander starts a new one that continues from metadata", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, title: "Gone commander", labelIds: [BLOCKED] });
      h.workspaces.seedWorkspace("STA-1", {
        ticket: "STA-1",
        status: "build",
        progress: "blocked",
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
      expect(inbox[0]).toContain("do not restart");
    } finally {
      h.stop();
    }
  });

  test("a blocked resume unblocks, then opens a fresh tab when every pane is busy", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, title: "Blocked orphan", labelIds: [BLOCKED] });
      h.workspaces.seedWorkspace("STA-1", {
        ticket: "STA-1",
        status: "build",
        progress: "blocked",
        commander: "codex",
        paused: "1",
      }, { commander: false });
      h.workspaces.seedAgent("STA-1", "builder-sta-1");
      const out = await runCommand(["resume", "STA-1"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("new commander commander-sta-1 started");
      expect(h.world.issues[0]!.labelIds).toEqual([PENDING]);
      expect(h.workspaces.calls.filter((c) => c.method === "tab.create")).toHaveLength(1);
      const starts = h.workspaces.calls.filter((c) => c.method === "agent.start");
      expect(starts).toHaveLength(1);
      expect(starts[0]!.params).toMatchObject({ kind: "codex", name: "commander-sta-1" });
      expect(h.workspaces.promptsFor("commander-sta-1")).toHaveLength(1);
    } finally {
      h.stop();
    }
  });

  test("an active build ticket with a lost commander resumes even when slots look full", async () => {
    const h = await harness(1);
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, title: "Lost commander", labelIds: [IN_PROGRESS] });
      h.workspaces.seedWorkspace("STA-1", {
        ticket: "STA-1",
        status: "build",
        progress: "in_progress",
        commander: "claude",
        checkpoint: HEAD,
      }, { commander: false });
      // The live shape: the Commander tab is closed but the Builder tab still
      // occupies the workspace's only pane.
      h.workspaces.seedAgent("STA-1", "builder-sta-1");
      const out = await runCommand(["resume", "STA-1"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("new commander commander-sta-1 started");
      // The ticket's own slot never counts against its resume: max 1 with
      // only this ticket holding a slot still succeeds.
      const issue = h.world.issues[0]!;
      expect(issue.stateId).toBe(BUILD);
      expect(issue.labelIds).toEqual([IN_PROGRESS]);
      expect(issue.comments).toHaveLength(0);
      expect(h.workspaces.tokensFor("STA-1")).toMatchObject({ checkpoint: HEAD });
      expect(h.workspaces.calls.filter((c) => c.method === "workspace.report_metadata")).toHaveLength(0);
      // The occupied pane is unusable, so resume opens a fresh tab and starts
      // the Commander on its pane instead of failing like a duplicate claim.
      expect(h.workspaces.calls.filter((c) => c.method === "tab.create")).toHaveLength(1);
      const starts = h.workspaces.calls.filter((c) => c.method === "agent.start");
      expect(starts).toHaveLength(1);
      const builderPane = h.workspaces.agents.find((a) => a.name === "builder-sta-1")!.paneId;
      expect((starts[0]!.params as Record<string, unknown>)["paneId"]).not.toBe(builderPane);
      const inbox = h.workspaces.promptsFor("commander-sta-1");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toContain("This is a resumed run.");
      expect(inbox[0]).toContain("`igniter state --json`");
      expect(inbox[0]).toContain("do not restart");
    } finally {
      h.stop();
    }
  });

  test("a review ticket with a lost commander resumes from its current state", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-2", stateId: REVIEW, priority: 1, description: CRITERIA, title: "Review orphan", labelIds: [IN_PROGRESS] });
      h.workspaces.seedWorkspace("STA-2", {
        ticket: "STA-2",
        status: "review",
        progress: "in_progress",
        commander: "claude",
        checkpoint: HEAD,
        receipt_kind: "build",
        receipt_id: "comment-1",
        submission: "sub-1",
      }, { commander: false });
      // The Reviewer tab still occupies the only pane, as on a live ticket.
      h.workspaces.seedAgent("STA-2", "reviewer-sta-2", "reviewer");
      const out = await runCommand(["resume", "STA-2"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("new commander commander-sta-2 started");
      expect(out.text).toContain("review+in_progress");
      const issue = h.world.issues[0]!;
      expect(issue.stateId).toBe(REVIEW);
      expect(issue.labelIds).toEqual([IN_PROGRESS]);
      expect(issue.comments).toHaveLength(0);
      expect(h.workspaces.tokensFor("STA-2")).toMatchObject({ checkpoint: HEAD, receipt_kind: "build" });
      expect(h.workspaces.calls.filter((c) => c.method === "workspace.report_metadata")).toHaveLength(0);
      expect(h.workspaces.calls.filter((c) => c.method === "tab.create")).toHaveLength(1);
      const inbox = h.workspaces.promptsFor("commander-sta-2");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toContain("continue from status review progress in_progress");
    } finally {
      h.stop();
    }
  });

  test("a deliver ticket with a lost commander resumes from its current state", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-3", stateId: "st-deliver", priority: 1, description: CRITERIA, title: "Deliver orphan", labelIds: [PENDING] });
      h.workspaces.seedWorkspace("STA-3", {
        ticket: "STA-3",
        status: "deliver",
        progress: "pending",
        commander: "codex",
      }, { commander: false });
      const out = await runCommand(["resume", "STA-3"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("new commander commander-sta-3 started");
      expect(out.text).toContain("deliver+pending");
      const issue = h.world.issues[0]!;
      expect(issue.stateId).toBe("st-deliver");
      expect(issue.labelIds).toEqual([PENDING]);
      expect(issue.comments).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("an active ticket with a live commander is not duplicated", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, title: "Busy", labelIds: [IN_PROGRESS] });
      h.workspaces.seedWorkspace("STA-1", {
        ticket: "STA-1",
        status: "build",
        progress: "in_progress",
      });
      const out = await runCommand(["resume", "STA-1"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("already running");
      expect(h.workspaces.calls.filter((c) => c.method === "agent.start")).toHaveLength(0);
      expect(h.workspaces.promptsFor("commander-sta-1")).toHaveLength(0);
      expect(h.world.issues[0]!.labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("a todo ticket that is neither paused nor blocked has nothing to resume", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1" }, { commander: false });
      const out = await runCommand(["resume", "STA-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("not paused or blocked");
      expect(h.workspaces.calls.filter((c) => c.method === "agent.start")).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("resume without a workspace points at start", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
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
      addIssue(h.world, { identifier: "OTH-1", stateId: BUILD, priority: 1, description: CRITERIA, projectId: "proj-2", labelIds: [IN_PROGRESS] });
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
  test("fails the ticket to Backlog with the label, comment, and a closed workspace", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      await runCommand(["start", "STA-1"], h.ctx);
      const out = await runCommand(["fail", "STA-1", "--reason", "builder wedged"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("failed STA-1: builder wedged");
      const issue = h.world.issues[0]!;
      expect(issue.stateId).toBe("st-backlog");
      expect(issue.labelIds).toHaveLength(1);
      const failedLabel = h.world.labels.find((l) => l.name === "agent-failed");
      expect(failedLabel).toBeDefined();
      expect(issue.labelIds).toEqual([failedLabel!.id]);
      const comment = issue.comments[issue.comments.length - 1]!;
      expect(comment.body).toContain("<!-- igniter:failed -->");
      expect(comment.body).toContain("builder wedged");
      expect(h.workspaces.workspaces[0]!.closed).toBe(true);
      expect(h.lines).toEqual([
        "STA-1 claimed: Todo → Build (slot 0)",
        "STA-1 workspace opened (ws-1) commander=claude builder=opencode/muse-spark-1.3-contributor-free",
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
      h.world.labels.push({ id: "label-9", name: "keep", teamId: "team-1", parentId: null });
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: ["label-9", IN_PROGRESS] });
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
      h.world.labels.push({ id: "label-7", name: "agent-failed", teamId: "", parentId: null });
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      const out = await runCommand(["fail", "STA-1", "--reason", "x"], h.ctx);
      expect(out.ok).toBe(true);
      expect(h.world.issues[0]!.labelIds).toEqual(["label-7"]);
      expect(h.world.labels.filter((l) => l.name === "agent-failed")).toHaveLength(1);
    } finally {
      h.stop();
    }
  });

  test("works without a workspace: no close", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      const out = await runCommand(["fail", "STA-1", "--reason", "no run"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("no workspace to close");
    } finally {
      h.stop();
    }
  });
});

describe("restart", () => {
  test("writes the new builder and prompts the commander", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      await runCommand(["start", "STA-1"], h.ctx);
      const out = await runCommand(["restart", "STA-1", "--builder", "new/model"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("restarted STA-1 with builder new/model");
      expect(h.workspaces.tokensFor("STA-1")).toMatchObject({ builder: "new/model" });
      const inbox = h.workspaces.promptsFor("commander-sta-1");
      expect(inbox.at(-1)).toContain("restart the Builder with model new/model");
      expect(inbox.at(-1)).toContain("read `git diff` first");
      expect(h.lines).toContain("STA-1 restarted with builder new/model by command");
    } finally {
      h.stop();
    }
  });

  test("without a live commander says to resume first", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1" }, { commander: false });
      const out = await runCommand(["restart", "STA-1", "--builder", "new/model"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("use `igniter resume STA-1` first");
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
      worktreePath: "/repo/.igniter/runtime/worktrees/sta-176",
      branch: "feature/sta-176",
      builderModel: "b-model",
      commanderConfig: DEFAULT_COMMANDER_CONFIG,
    });
    for (const needle of [
      "STA-176",
      "Dispatch commands",
      "https://linear.app/starcoder/issue/STA-176",
      "Workspace: a git worktree at /repo/.igniter/runtime/worktrees/sta-176 on branch feature/sta-176 (base main), created by igniter.",
      "do not create another branch",
      "bun install",
      "b-model",
      "claude-sonnet-5",
      "openai/gpt-5.6-terra",
      "/stages/build.md",
      "/stages/review.md",
      "/stages/deliver.md",
      "harness `opencode`",
      "harness `claude`",
      "/rules.md",
      "AGENTS.md",
      "`igniter state --json`",
      "`igniter begin`",
      "`igniter submit --input -`",
      "`igniter block --reason",
      "`igniter unblock`",
    ]) {
      expect(order).toContain(needle);
    }
    expect(order).not.toContain("LINEAR_API_KEY");
    expect(order).not.toContain("GraphQL");
    expect(order).not.toContain("igniter stage");
    expect(order).not.toContain("`src/commander/");
  });

  test("carries a repository harness override into the Commander work order", () => {
    const commanderConfig = parseDispatchConfig({
      project: "igniter",
      agents: { reviewer: { harness: "codex", model: "r-model" } },
    }).commander;
    const order = buildWorkOrder({
      identifier: "STA-176",
      title: "Dispatch commands",
      issueUrl: "https://linear.app/starcoder/issue/STA-176",
      worktreePath: "/repo/.igniter/runtime/worktrees/sta-176",
      branch: "feature/sta-176",
      commanderConfig,
    });

    expect(order).toContain("Acceptance: prompt `/");
    expect(order).toContain("/stages/review.md`; agent `reviewer`; harness `codex`; model `r-model`");
  });

  test("work order carries bundled absolute paths that exist outside the target repo", async () => {
    // A target repo with no src/commander/ at all.
    const repoRoot = mkdtempSync(join(tmpdir(), "igniter-target-"));
    const assets = commanderAssetPaths();
    const order = buildWorkOrder({
      identifier: "STA-176",
      title: "Dispatch commands",
      issueUrl: "https://linear.app/starcoder/issue/STA-176",
      worktreePath: "/repo/.igniter/runtime/worktrees/sta-176",
      branch: "feature/sta-176",
      commanderConfig: DEFAULT_COMMANDER_CONFIG,
      assets,
    });
    expect(order).toContain(assets.rules);
    for (const stage of ["build", "review", "deliver"] as const) {
      const prompt = assets.prompts[stage];
      expect(order).toContain(prompt);
      expect(isAbsolute(prompt)).toBe(true);
      expect(prompt.startsWith(repoRoot)).toBe(false);
      expect(await Bun.file(prompt).exists()).toBe(true);
      expect((await Bun.file(prompt).text()).length).toBeGreaterThan(0);
    }
    expect(isAbsolute(assets.rules)).toBe(true);
    expect(await Bun.file(assets.rules).exists()).toBe(true);
  });

  test("agent overrides merge while bundled prompt paths stay fixed", async () => {
    const assets = commanderAssetPaths();
    const commanderConfig = parseDispatchConfig({
      project: "igniter",
      agents: { builder: { model: "custom/builder" } },
    }).commander;
    const order = buildWorkOrder({
      identifier: "STA-176",
      title: "Dispatch commands",
      issueUrl: "https://linear.app/starcoder/issue/STA-176",
      worktreePath: "/repo/.igniter/runtime/worktrees/sta-176",
      branch: "feature/sta-176",
      commanderConfig,
      assets,
    });
    expect(order).toContain("model `custom/builder`");
    for (const stage of ["build", "review", "deliver"] as const) {
      expect(order).toContain(assets.prompts[stage]);
    }
  });

  test("a worktree failure aborts the start before any workspace opens", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.git.failOn = ["worktree"];
      h.git.failMessage = "fatal: not a git repository";
      const out = await runCommand(["start", "STA-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("not a git repository");
      expect(h.workspaces.workspaces).toHaveLength(0);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 refused:"));
    } finally {
      h.stop();
    }
  });

  test("a configured delivery document tells the commander to read it, not search", () => {
    const order = buildWorkOrder({
      identifier: "STA-176",
      title: "Dispatch commands",
      issueUrl: "https://linear.app/starcoder/issue/STA-176",
      worktreePath: "/repo/.igniter/runtime/worktrees/sta-176",
      branch: "feature/sta-176",
      builderModel: "b-model",
      commanderConfig: DEFAULT_COMMANDER_CONFIG,
      delivery: "CONTRIBUTING.md",
    });
    expect(order).toContain("Project settings: read `CONTRIBUTING.md` (relative to the repo root)");
    expect(order).toContain("Do not search for another one.");
    expect(order).not.toContain("No delivery document is configured");
  });
});

describe("worker scratch", () => {
  test("the work order names each worker scratch without invented harness flags", () => {
    const scratch = scratchPathsFor("/repo", "STA-176");
    const order = buildWorkOrder({
      identifier: "STA-176",
      title: "Dispatch commands",
      issueUrl: "https://linear.app/starcoder/issue/STA-176",
      worktreePath: "/repo/.igniter/runtime/worktrees/sta-176",
      branch: "feature/sta-176",
      commanderConfig: DEFAULT_COMMANDER_CONFIG,
      scratch,
    });
    expect(order).toContain(scratch.builder);
    expect(order).toContain(scratch.reviewer);
    expect(order).toContain(scratch.deliverer);
    expect(order).toContain("harness `opencode`");
    expect(order).toContain("harness `codex`");
    expect(order).toContain(scratch.builder);
    expect(order).toContain("Do not invent generic permission flags");
    expect(order).not.toContain("--claude-allow-dir");
    expect(order).not.toContain("--codex-allow-path");
    expect(order).not.toContain("--opencode-allow");
    expect(order).not.toContain("--remote-control");
    expect(order).toContain("escalate to the owner");
  });

  test("claim creates every worker scratch and records it in workspace metadata", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-8", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const out = await runCommand(["start", "STA-8"], h.ctx);
      expect(out.ok).toBe(true);
      const scratch = scratchPathsFor(h.repoRoot, "STA-8");
      const { existsSync } = await import("node:fs");
      expect(existsSync(scratch.builder)).toBe(true);
      expect(existsSync(scratch.reviewer)).toBe(true);
      expect(existsSync(scratch.deliverer)).toBe(true);
      expect(h.workspaces.tokensFor("STA-8")).toMatchObject({
        scratch_builder: scratch.builder,
        scratch_reviewer: scratch.reviewer,
        scratch_deliverer: scratch.deliverer,
      });
      const inbox = h.workspaces.promptsFor("commander-sta-8");
      expect(inbox[0]).toContain(scratch.builder);
    } finally {
      h.stop();
    }
  });
});
