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
import { recordStageProfiles } from "./agents";
import { LinearClient } from "./linear";
import { addIssue, standardWorld, startFakeLinear } from "./fake-linear";
import { FakeGit } from "./fake-git";
import { FakeWorkspaces } from "./fake-workspaces";

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
  const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url, fetchImpl: fake.fetchImpl });
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
        ["reconcile"], ["pause"], ["resume"], ["fail"], ["restart"],
        ["fail", "STA-1"], ["restart", "STA-1"], ["begin", "--builder", "x"],
        ["begin", "STA-1", "--agent", "hal"],
        ["begin", "STA-1", "build"],
        ["begin", "STA-1", "--builder", "m"],
        ["start", "STA-1", "--bogus"],
        ["start", "STA-1", "STA-2"],
        ["pause", "STA-1", "--bogus"], ["state"], ["state", "x"],
        ["begin"], ["submit"], ["submit", "--input", "file"],
        ["submit", "--input", "-"],
        ["block"], ["block", "--reason", ""], ["block", "--reason", "x"],
        ["unblock"],
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

  test("legacy workspace commands without a workspace id refuse", async () => {
    const h = await harness();
    try {
      const state = await runCommand(["state", "--json"], h.ctx);
      expect(state.ok).toBe(false);
      expect(state.text).toContain("Herdr workspace only");
      const begin = await runCommand(["begin"], h.ctx);
      expect(begin.ok).toBe(false);
      expect(begin.text).toContain("usage: igniter begin");
      // Ticket-targeted commands need no workspace id: they fail on Linear,
      // never on a missing HERDR_WORKSPACE_ID.
      const out = await runCommand(["block", "STA-1", "--reason", "x"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).not.toContain("Herdr workspace only");
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
      await runCommand(["worker", "start", "STA-1"], h.ctx);
      await runCommand(["begin", "STA-1"], h.ctx);
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
        { identifier: "STA-1", progress: "in_progress", hasWorkspace: true },
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

  test("status <ticket> --json on a bare Todo reports an actionable next step without writing", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [] });
      const out = await runCommand(["status", "STA-1", "--json"], h.ctx);
      expect(out.ok).toBe(true);
      const data = out.data as Record<string, unknown>;
      expect(data).toMatchObject({ status: "todo", progress: null, next: ["worker start", "begin"] });
      expect(String(data["note"])).toContain("bare Todo");
      expect(String(data["note"])).toContain("confirm worker start delivery before begin");
      // Read-only: no labels written, no workspace opened, no decision line.
      expect(h.world.issues[0]!.labelIds).toEqual([]);
      expect(h.world.issues[0]!.comments).toHaveLength(0);
      expect(h.workspaces.workspaces).toHaveLength(0);
      expect(h.lines).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("status <ticket> --json on Todo+Pending requires confirmed worker delivery before begin", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const out = await runCommand(["status", "STA-1", "--json"], h.ctx);
      expect(out.ok).toBe(true);
      const data = out.data as Record<string, unknown>;
      expect(data).toMatchObject({ status: "todo", progress: "pending", next: ["worker start", "begin"] });
      expect(data["note"]).toBe("confirm worker start delivery before begin");
    } finally {
      h.stop();
    }
  });
});

describe("finished status actions", () => {
  test("Done offers guarded worker cleanup while Backlog has no pending action", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: DONE, description: CRITERIA, labelIds: [] });
      addIssue(h.world, { identifier: "STA-2", stateId: "st-backlog", description: CRITERIA, labelIds: [] });
      const done = await runCommand(["status", "STA-1", "--json"], h.ctx);
      expect(done.ok).toBe(true);
      expect((done.data as Record<string, unknown>)["note"]).toContain("preserve uncommitted or unmerged work");
      expect(done.data).toMatchObject({ status: "done", next: ["worker stop"], note: expect.stringContaining("guarded cleanup") });
      const backlog = await runCommand(["status", "STA-2", "--json"], h.ctx);
      expect(backlog.ok).toBe(true);
      expect(backlog.data).toMatchObject({ status: "backlog", next: [] });
      expect(h.workspaces.calls.every(call => call.method === "snapshot")).toBe(true);
      expect(h.world.issues.every(issue => issue.comments.length === 0)).toBe(true);
    } finally {
      h.stop();
    }
  });
});

describe("begin", () => {
  test("records a stage start without reading or writing workers", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, description: CRITERIA, labelIds: [PENDING] });
      h.workspaces.failMethods.add("snapshot");
      const out = await runCommand(["begin", "STA-1"], h.ctx);
      expect(out.ok).toBe(true);
      expect(h.world.issues[0]!.stateId).toBe(BUILD);
      expect(h.world.issues[0]!.labelIds).toEqual([IN_PROGRESS]);
      expect(h.workspaces.calls).toHaveLength(0);
      expect(h.git.commands).toHaveLength(0);
      expect((await runCommand(["begin", "STA-1"], h.ctx)).ok).toBe(true);
      expect(h.workspaces.calls).toHaveLength(0);
    } finally { h.stop(); }
  });

  test("validates criteria, progress, and terminal stages without worker effects", async () => {
    const h = await harness();
    try {
      for (const [identifier, stateId, description, labelIds] of [
        ["STA-1", TODO, "no criteria", [PENDING]],
        ["STA-2", TODO, CRITERIA, [PENDING, BLOCKED]],
        ["STA-3", DONE, CRITERIA, []],
        ["STA-4", CANCELED, CRITERIA, []],
        ["STA-5", TODO, CRITERIA, [COMPLETE]],
      ] as const) {
        addIssue(h.world, { identifier, stateId, description, labelIds: [...labelIds] });
        expect((await runCommand(["begin", identifier], h.ctx)).ok).toBe(false);
      }
      expect(h.workspaces.calls).toHaveLength(0);
      expect(h.world.issues.every(issue => issue.comments.length === 0)).toBe(true);
    } finally { h.stop(); }
  });

  test("bare Todo begins with unrelated labels preserved and slot limits enforced", async () => {
    const h = await harness(1);
    try {
      h.world.labels.push({ id: "keep", name: "keep", teamId: "team-1", parentId: null });
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, description: CRITERIA, labelIds: ["keep"] });
      addIssue(h.world, { identifier: "STA-2", stateId: TODO, description: CRITERIA, labelIds: [] });
      expect(await runCommand(["begin", "STA-1"], h.ctx)).toMatchObject({ ok: true });
      expect(new Set(h.world.issues[0]!.labelIds)).toEqual(new Set(["keep", IN_PROGRESS]));
      expect((await runCommand(["begin", "STA-2"], h.ctx)).ok).toBe(false);
      expect(h.world.issues[1]!.labelIds).toEqual([]);
      expect(h.workspaces.calls).toHaveLength(0);
    } finally { h.stop(); }
  });
});

describe("worker start profiles", () => {
  test("worker start runs the Build worker on the unified builder profile", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const out = await runCommand(["worker", "start", "STA-1"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("builder-sta-1");
      const started = h.workspaces.calls.find((call) => call.method === "agent.start");
      expect(started?.params).toMatchObject({ kind: "codex", name: "builder-sta-1" });
      expect(h.workspaces.agents.find((a) => a.name.startsWith("commander-"))).toBeUndefined();
    } finally {
      h.stop();
    }
  });

  test("worker start refuses an unknown stage harness with the known kinds", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.ctx.resolved.config = parseDispatchConfig({
        project: "igniter",
        team: "Starcoder",
        agents: { builder: { harness: "hal" } },
      });
      const out = await runCommand(["worker", "start", "STA-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain('"hal"');
      expect(h.workspaces.agents).toHaveLength(0);
      expect(h.world.issues[0]!.stateId).toBe(TODO);
    } finally {
      h.stop();
    }
  });

  test("worker start refuses a stage effort its harness cannot express before moving Linear", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.ctx.resolved.config = parseDispatchConfig({
        project: "igniter",
        team: "Starcoder",
        agents: { builder: { harness: "opencode", model: "opencode/model", effort: "high" } },
      });
      const out = await runCommand(["worker", "start", "STA-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain('unsupported effort "high" for harness "opencode"');
      expect(h.workspaces.agents).toHaveLength(0);
      expect(h.world.issues[0]!.stateId).toBe(TODO);
      expect(h.world.issues[0]!.labelIds).toEqual([PENDING]);
      expect(h.world.issues[0]!.comments).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("a retry over a live workspace keeps the run's recorded profiles", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-7", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      // The run recorded opencode profiles at claim time; the configuration
      // drifted since. The retry must still launch the recorded profile.
      h.workspaces.seedWorkspace("STA-7", {
        ticket: "STA-7",
        profile_builder: JSON.stringify({ harness: "opencode", model: "opencode/muse-spark-1.3-contributor-free" }),
        profile_reviewer: JSON.stringify({ harness: "claude", model: "claude-sonnet-5", effort: "high" }),
      }, { commander: false });
      h.ctx.resolved.config = parseDispatchConfig({
        project: "igniter",
        team: "Starcoder",
        agents: {
          builder: { harness: "gemini", model: "new/builder", effort: "low" },
          reviewer: { harness: "opencode", model: "new/reviewer" },
        },
      });
      const out = await runCommand(["worker", "start", "STA-7"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("builder-sta-7");
      const started = h.workspaces.calls.find((c) => c.method === "agent.start");
      expect(started?.params).toMatchObject({ kind: "opencode", name: "builder-sta-7" });
      const inbox = h.workspaces.promptsFor("builder-sta-7");
      expect(inbox[0]).toContain("harness `opencode`");
      expect(inbox[0]).not.toContain("new/builder");
    } finally {
      h.stop();
    }
  });

  test("a mid-way worker failure reports the workspace id and keeps Pending", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.workspaces.failMethods.add("agent.start");
      const out = await runCommand(["worker", "start", "STA-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("worker start failed");
      expect(h.workspaces.workspaces[0]!.workspaceId).toBe("ws-1");
      expect(h.world.issues[0]!.stateId).toBe(TODO);
      expect(h.world.issues[0]!.labelIds).toEqual([PENDING]);
    } finally {
      h.stop();
    }
  });

  test("a stage profile mismatch fails before moving Linear", async () => {
    const h = await harness();
    try {
      h.ctx.resolved.config = parseDispatchConfig({
        project: "igniter",
        team: "Starcoder",
        agents: { builder: { harness: "codex", model: "openai/gpt-5.6-sol" } },
      });
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const out = await runCommand(["worker", "start", "STA-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("provider/model ids belong to OpenCode");
      expect(h.workspaces.agents).toHaveLength(0);
      expect(h.world.issues[0]!.stateId).toBe(TODO);
    } finally {
      h.stop();
    }
  });

});

describe("start (singleton Commander)", () => {
  test("start boots the one Commander with the patrol order", async () => {
    const h = await harness();
    try {
      const out = await runCommand(["start"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("commander started in ws-1");
      expect(out.text).toContain("patrolling");
      expect(h.workspaces.agents.map((a) => a.name)).toEqual(["commander"]);
      expect(h.workspaces.agents.find((a) => a.name.startsWith("commander-"))).toBeUndefined();
      const inbox = h.workspaces.promptsFor("commander");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toContain("src/commander/global.md");
      expect(inbox[0]).toContain("igniter");
      expect(inbox[0]).not.toContain("commander-sta-");
      expect(h.workspaces.workspaces).toHaveLength(1);
    } finally {
      h.stop();
    }
  });

  test("start STA-X reuses the singleton and assigns the ticket", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      addIssue(h.world, { identifier: "STA-2", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      expect((await runCommand(["start"], h.ctx)).ok).toBe(true);
      const first = await runCommand(["start", "STA-1"], h.ctx);
      expect(first.ok).toBe(true);
      expect(first.text).toContain("assigned STA-1");
      const second = await runCommand(["start", "STA-2"], h.ctx);
      expect(second.ok).toBe(true);
      expect(second.text).toContain("assigned STA-2");
      // One workspace, one agent, never commander-<ticket>.
      expect(h.workspaces.workspaces.filter((w) => !w.closed)).toHaveLength(1);
      expect(h.workspaces.agents.map((a) => a.name)).toEqual(["commander"]);
      expect(h.world.issues[0]!.stateId).toBe(TODO);
    } finally {
      h.stop();
    }
  });

  test("a repeated identical start reuses without a second order", async () => {
    const h = await harness();
    try {
      expect((await runCommand(["start"], h.ctx)).ok).toBe(true);
      const again = await runCommand(["start"], h.ctx);
      expect(again.ok).toBe(true);
      expect(again.text).toContain("reused without a second order");
      expect(h.workspaces.promptsFor("commander")).toHaveLength(1);
      expect(h.workspaces.agents).toHaveLength(1);
    } finally {
      h.stop();
    }
  });

  test("a lost Commander agent is rebuilt on takeover", async () => {
    const h = await harness();
    try {
      expect((await runCommand(["start"], h.ctx)).ok).toBe(true);
      h.workspaces.agents = [];
      const out = await runCommand(["start"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("commander started in ws-1");
      expect(h.workspaces.agents.map((a) => a.name)).toEqual(["commander"]);
      expect(h.workspaces.promptsFor("commander")).toHaveLength(1);
    } finally {
      h.stop();
    }
  });

  test("start refuses unknown tickets and finished ones", async () => {
    const h = await harness();
    try {
      expect((await runCommand(["start", "STA-404"], h.ctx)).ok).toBe(false);
      addIssue(h.world, { identifier: "STA-9", stateId: DONE, priority: 1, description: CRITERIA });
      const done = await runCommand(["start", "STA-9"], h.ctx);
      expect(done.ok).toBe(false);
      expect(done.text).toContain("ticket is Done");
      expect(h.workspaces.workspaces).toHaveLength(0);
    } finally {
      h.stop();
    }
  });
});

describe("fail", () => {
  test("fails the ticket to Backlog and leaves its worker untouched", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      await runCommand(["worker", "start", "STA-1"], h.ctx);
      await runCommand(["begin", "STA-1"], h.ctx);
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
      expect(h.workspaces.workspaces[0]!.closed).toBe(false);
      expect(h.lines).toContain("STA-1 failed: builder wedged");
      expect(h.workspaces.calls.some(call => call.method === "workspace.close")).toBe(false);
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
      expect(h.workspaces.calls).toHaveLength(0);
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
      "Workspace: a git worktree at /repo/.igniter/runtime/worktrees/sta-176 on branch feature/sta-176 (base main), created by worker start.",
      "do not create another branch",
      "b-model",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
      "gpt-6-astra",
      "/stages/build.md",
      "/stages/review.md",
      "/stages/deliver.md",
      "harness `codex`",
      "/rules.md",
      "AGENTS.md",
      "`igniter status STA-176 --json`",
      "`igniter begin STA-176`",
      "`igniter submit STA-176 --input -`",
      "`igniter block STA-176 --reason",
      "`igniter unblock STA-176`",
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

  test("Deliver uses the explicit deliverer profile and the work order renders effort", () => {
    const commanderConfig = parseDispatchConfig({
      project: "igniter",
      agents: { deliverer: { harness: "claude", model: "d-model", effort: "max" } },
    }).commander;
    const order = buildWorkOrder({
      identifier: "STA-176",
      title: "Dispatch commands",
      issueUrl: "https://linear.app/starcoder/issue/STA-176",
      worktreePath: "/repo/.igniter/runtime/worktrees/sta-176",
      branch: "feature/sta-176",
      commanderConfig,
    });
    // Deliver no longer reuses the Builder profile.
    expect(order).toContain("Deliver: prompt `/");
    expect(order).toContain("/stages/deliver.md`; agent `deliverer`; harness `claude`; model `d-model`; effort `max`");
    // Bundled effort renders on the stages that set it.
    const bundled = buildWorkOrder({
      identifier: "STA-176",
      title: "Dispatch commands",
      issueUrl: "https://linear.app/starcoder/issue/STA-176",
      worktreePath: "/repo/.igniter/runtime/worktrees/sta-176",
      branch: "feature/sta-176",
      commanderConfig: DEFAULT_COMMANDER_CONFIG,
    });
    expect(bundled).toContain("Acceptance: prompt `/");
    expect(bundled).toContain("harness `codex`; model `gpt-5.6-sol`; effort `high`");
    expect(bundled).toContain("Builder fallback: harness `codex`; model `gpt-6-astra`; effort `high`");
  });

  test("a worker start reuses the recorded stage profiles when the configuration drifts", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, title: "Drifted config", labelIds: [PENDING] });
      // The run recorded the bundled profiles at claim time.
      const recorded = recordStageProfiles(h.ctx.resolved.config);
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1", ...recorded }, { commander: false });
      // The configuration drifts mid-run: new harnesses, models, efforts.
      h.ctx.resolved.config = parseDispatchConfig({
        project: "igniter",
        team: "Starcoder",
        agents: {
          builder: { harness: "gemini", model: "new/builder", effort: "low" },
          reviewer: { harness: "opencode", model: "new/reviewer" },
          deliverer: { harness: "claude", model: "new/deliverer", effort: "max" },
        },
      });
      const out = await runCommand(["worker", "start", "STA-1"], h.ctx);
      expect(out.ok).toBe(true);
      // The worker still launches the run's recorded stage profile.
      const started = h.workspaces.calls.find((c) => c.method === "agent.start");
      expect(started?.params).toMatchObject({ kind: "codex", name: "builder-sta-1" });
      const inbox = h.workspaces.promptsFor("builder-sta-1");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toContain("harness `codex`; model `gpt-5.6-terra`");
      expect(inbox[0]).not.toContain("new/builder");
    } finally {
      h.stop();
    }
  });

  test("a worktree failure aborts the worker start before any workspace opens", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.git.failOn = ["worktree"];
      h.git.failMessage = "fatal: not a git repository";
      const out = await runCommand(["worker", "start", "STA-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("not a git repository");
      expect(h.workspaces.workspaces).toHaveLength(0);
      expect(out.text).toContain("worker start failed:");
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
    expect(order).toContain("harness `codex`");
    expect(order).toContain(scratch.builder);
    expect(order).toContain("Do not invent generic permission flags");
    expect(order).not.toContain("--claude-allow-dir");
    expect(order).not.toContain("--codex-allow-path");
    expect(order).not.toContain("--opencode-allow");
    expect(order).not.toContain("--remote-control");
    expect(order).toContain("escalate to the owner");
  });

  test("worker start creates every worker scratch and records it in workspace metadata", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-8", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const out = await runCommand(["worker", "start", "STA-8"], h.ctx);
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
      const inbox = h.workspaces.promptsFor("builder-sta-8");
      expect(inbox[0]).toContain(scratch.builder);
      expect(inbox[0]).toContain("result.md");
    } finally {
      h.stop();
    }
  });
});
