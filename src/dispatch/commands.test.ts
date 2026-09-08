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

  test("status <ticket> --json on a bare Todo reports an actionable next step without writing", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [] });
      const out = await runCommand(["status", "STA-1", "--json"], h.ctx);
      expect(out.ok).toBe(true);
      const data = out.data as Record<string, unknown>;
      expect(data).toMatchObject({ status: "todo", progress: null, next: ["begin"] });
      expect(String(data["note"])).toContain("bare Todo");
      // Read-only: no labels written, no workspace opened, no decision line.
      expect(h.world.issues[0]!.labelIds).toEqual([]);
      expect(h.world.issues[0]!.comments).toHaveLength(0);
      expect(h.workspaces.workspaces).toHaveLength(0);
      expect(h.lines).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("status <ticket> --json on Todo+Pending offers begin as the next step", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const out = await runCommand(["status", "STA-1", "--json"], h.ctx);
      expect(out.ok).toBe(true);
      const data = out.data as Record<string, unknown>;
      expect(data).toMatchObject({ status: "todo", progress: "pending", next: ["begin"] });
    } finally {
      h.stop();
    }
  });
});

describe("begin", () => {
  test("a Todo ticket opens a workspace and starts the Build worker, moves Linear", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-176", stateId: TODO, priority: 1, description: CRITERIA, title: "Dispatch commands", labelIds: [PENDING] });
      const out = await runCommand(["begin", "STA-176"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("build worker builder-sta-176");
      expect(out.text).toContain("Todo → Build");
      expect(out.text).toContain("result →");
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
        ["rev-parse", "HEAD"],
      ]);
      expect(h.workspaces.tokensFor("STA-176")).toMatchObject({ ticket: "STA-176" });
      // The run freeze compacts to three JSON profile tokens.
      const frozen = h.workspaces.tokensFor("STA-176");
      expect(JSON.parse(frozen["profile_builder"]!)).toMatchObject({ harness: "codex", model: "gpt-5.6-terra" });
      expect(JSON.parse(frozen["profile_reviewer"]!)).toMatchObject({ harness: "codex", model: "gpt-5.6-sol" });
      expect(JSON.parse(frozen["profile_deliverer"]!)).toMatchObject({ harness: "codex", model: "gpt-5.6-luna" });
      // The Build worker runs the unified builder profile, never
      // a resident commander.
      const started = h.workspaces.calls.find((call) => call.method === "agent.start");
      expect(started?.params).toMatchObject({ kind: "codex", name: "builder-sta-176" });
      expect(h.workspaces.agents.find((a) => a.name.startsWith("commander-"))).toBeUndefined();
      const inbox = h.workspaces.promptsFor("builder-sta-176");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toContain("STA-176");
      expect(inbox[0]).toContain("Dispatch commands");
      expect(inbox[0]).toContain(wt.path);
      expect(inbox[0]).toContain("result.md");
      expect(inbox[0]).toContain("Do not run any `igniter` command");
      expect(inbox[0]).toContain("do not call Linear directly or through MCP");
      expect(inbox[0]).toContain("do not publish Linear receipts");
      expect(inbox[0]).not.toContain("LINEAR_API_KEY");
      expect(inbox[0]).not.toContain("GraphQL");
      expect(inbox[0]).not.toContain("`igniter state --json`");
      expect(inbox[0]).not.toContain("`igniter submit");
      expect(h.lines).toEqual([
        "STA-176 started build worker builder-sta-176 in ws-1 (Todo → Build)",
      ]);
    } finally {
      h.stop();
    }
  });

  test("begin takes no stage or builder flag: the stage derives from Linear", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-176", stateId: TODO, priority: 1, description: CRITERIA, title: "Dispatch commands", labelIds: [PENDING] });
      for (const argv of [
        ["begin", "STA-176", "--builder", "custom/builder-x"],
        ["begin", "STA-176", "build"],
        ["begin", "STA-176", "--stage", "build"],
      ]) {
        const out = await runCommand(argv, h.ctx);
        expect(out.ok).toBe(false);
        expect(out.text).toContain("usage: igniter begin");
      }
      expect(h.workspaces.workspaces).toHaveLength(0);
      expect(h.world.issues[0]!.stateId).toBe(TODO);
    } finally {
      h.stop();
    }
  });

  test("refuses done and canceled tickets with one activity line", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-9", stateId: DONE, priority: 1, description: CRITERIA });
      addIssue(h.world, { identifier: "STA-10", stateId: CANCELED, priority: 1, description: CRITERIA });
      const done = await runCommand(["begin", "STA-9"], h.ctx);
      expect(done).toMatchObject({ ok: false });
      expect(done.text).toContain("ticket is Done");
      const canceled = await runCommand(["begin", "STA-10"], h.ctx);
      expect(canceled.text).toContain("ticket is Canceled");
      expect(h.lines).toEqual([
        "STA-9 begin refused: ticket is Done",
        "STA-10 begin refused: ticket is Canceled",
      ]);
      expect(h.workspaces.workspaces).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("the per-ticket --agent override is gone: begin takes no agent flag", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const out = await runCommand(["begin", "STA-1", "--agent", "hal"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("usage: igniter begin");
      expect(h.workspaces.workspaces).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("begin runs the Build worker on the unified builder profile", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const out = await runCommand(["begin", "STA-1"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("builder-sta-1");
      const started = h.workspaces.calls.find((call) => call.method === "agent.start");
      expect(started?.params).toMatchObject({ kind: "codex", name: "builder-sta-1" });
      expect(h.workspaces.agents.find((a) => a.name.startsWith("commander-"))).toBeUndefined();
    } finally {
      h.stop();
    }
  });

  test("a begin refuses an unknown stage harness with the known kinds", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.ctx.resolved.config = parseDispatchConfig({
        project: "igniter",
        team: "Starcoder",
        agents: { builder: { harness: "hal" } },
      });
      const out = await runCommand(["begin", "STA-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain('"hal"');
      expect(h.workspaces.agents).toHaveLength(0);
      expect(h.world.issues[0]!.stateId).toBe(TODO);
    } finally {
      h.stop();
    }
  });

  test("a begin refuses a stage effort its harness cannot express before moving Linear", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.ctx.resolved.config = parseDispatchConfig({
        project: "igniter",
        team: "Starcoder",
        agents: { builder: { harness: "opencode", model: "opencode/model", effort: "high" } },
      });
      const out = await runCommand(["begin", "STA-1"], h.ctx);
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
      const out = await runCommand(["begin", "STA-7"], h.ctx);
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

  test("missing criteria leaves a nudge and refuses", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-3", stateId: TODO, priority: 1, description: "nothing", labelIds: [PENDING] });
      const out = await runCommand(["begin", "STA-3"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("acceptance-criteria");
      expect(h.world.issues[0]!.stateId).toBe(TODO);
      expect(h.world.issues[0]!.comments.some((c) => c.body.includes("<!-- igniter:missing-criteria -->"))).toBe(true);
    } finally {
      h.stop();
    }
  });

  test("an already-running ticket is refused; a Build+Pending one starts its worker", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-4", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      h.workspaces.seedWorkspace("STA-4", { ticket: "STA-4" });
      h.workspaces.seedAgent("STA-4", "builder-sta-4");
      const refused = await runCommand(["begin", "STA-4"], h.ctx);
      expect(refused).toMatchObject({ ok: false });
      expect(refused.text).toContain("already running");
      expect(h.lines).toEqual(["STA-4 begin refused: already running"]);

      addIssue(h.world, { identifier: "STA-5", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const started = await runCommand(["begin", "STA-5"], h.ctx);
      expect(started.ok).toBe(true);
      expect(started.text).toContain("builder-sta-5");
      expect(h.world.issues[1]!.stateId).toBe(BUILD);
      expect(h.world.issues[1]!.labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("a Review+Pending ticket starts the Acceptance worker; Linear moves to In progress", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-6", stateId: REVIEW, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const out = await runCommand(["begin", "STA-6"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("reviewer-sta-6");
      expect(out.text).toContain("review+pending → review+in_progress");
      expect(h.world.issues[0]!.stateId).toBe(REVIEW);
      expect(h.world.issues[0]!.labelIds).toEqual([IN_PROGRESS]);
      const started = h.workspaces.calls.find((c) => c.method === "agent.start");
      expect(started?.params).toMatchObject({ kind: "codex", name: "reviewer-sta-6" });

      // Half-written claim: workspace open, Linear still Todo+Pending.
      addIssue(h.world, { identifier: "STA-7", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.workspaces.seedWorkspace("STA-7", { ticket: "STA-7" }, { commander: false });
      const before = h.workspaces.workspaces.length;
      const finished = await runCommand(["begin", "STA-7"], h.ctx);
      expect(finished.ok).toBe(true);
      expect(finished.text).toContain("builder-sta-7");
      expect(h.workspaces.workspaces.length).toBe(before);
      expect(h.world.issues[1]!.stateId).toBe(BUILD);
      expect(h.world.issues[1]!.labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("begin reuses the existing workspace for a half-written Todo claim", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-7", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.workspaces.seedWorkspace("STA-7", { ticket: "STA-7" }, { commander: false });
      const before = h.workspaces.workspaces.length;
      const out = await runCommand(["begin", "STA-7"], h.ctx);
      expect(out.ok).toBe(true);
      expect(h.workspaces.workspaces.length).toBe(before);
      expect(h.workspaces.promptsFor("builder-sta-7")).toHaveLength(1);
      expect(h.world.issues[0]!.stateId).toBe(BUILD);
      expect(h.world.issues[0]!.labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("a mid-way worker failure reports the workspace id and keeps Pending", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.workspaces.failMethods.add("agent.start");
      const out = await runCommand(["begin", "STA-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("(workspace ws-1)");
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
      const out = await runCommand(["begin", "STA-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("provider/model ids belong to OpenCode");
      expect(h.workspaces.agents).toHaveLength(0);
      expect(h.world.issues[0]!.stateId).toBe(TODO);
    } finally {
      h.stop();
    }
  });

  test("a bare Todo is normalized to Todo+Pending and enters Build+In progress in one begin", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-177", stateId: TODO, priority: 1, description: CRITERIA, title: "Bare", labelIds: [] });
      const out = await runCommand(["begin", "STA-177"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("builder-sta-177");
      expect(out.text).toContain("Todo → Build");
      const issue = h.world.issues[0]!;
      expect(issue.stateId).toBe(BUILD);
      expect(issue.labelIds).toEqual([IN_PROGRESS]);
      expect(h.workspaces.workspaces).toHaveLength(1);
      expect(h.workspaces.agents.filter((a) => a.name === "builder-sta-177")).toHaveLength(1);
      expect(h.lines).toEqual([
        "STA-177 normalized: Todo → Todo+Pending",
        "STA-177 started build worker builder-sta-177 in ws-1 (Todo → Build)",
      ]);
    } finally {
      h.stop();
    }
  });

  test("a bare Todo without acceptance criteria stays bare and is refused with the nudge comment", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-178", stateId: TODO, priority: 1, description: "plans only", labelIds: [] });
      const out = await runCommand(["begin", "STA-178"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("acceptance-criteria");
      const issue = h.world.issues[0]!;
      expect(issue.stateId).toBe(TODO);
      expect(issue.labelIds).toEqual([]);
      expect(issue.comments.some((c) => c.body.includes("<!-- igniter:missing-criteria -->"))).toBe(true);
      expect(h.workspaces.workspaces).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("begin refuses a Todo with several Progress labels without any rewrite or workspace", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-179", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING, BLOCKED] });
      const out = await runCommand(["begin", "STA-179"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("2 Progress labels");
      const issue = h.world.issues[0]!;
      expect(issue.stateId).toBe(TODO);
      expect(issue.labelIds).toEqual([PENDING, BLOCKED]);
      expect(h.workspaces.workspaces).toHaveLength(0);
      expect(h.workspaces.agents).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("begin refuses a non-pending Todo progress without rewriting labels", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-180", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [COMPLETE] });
      const out = await runCommand(["begin", "STA-180"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("begin needs Todo+Pending");
      const issue = h.world.issues[0]!;
      expect(issue.stateId).toBe(TODO);
      expect(issue.labelIds).toEqual([COMPLETE]);
      expect(h.workspaces.workspaces).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("a bare Todo at max_running is normalized to Pending but starts no worker", async () => {
    const h = await harness(1);
    try {
      addIssue(h.world, { identifier: "STA-0", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      addIssue(h.world, { identifier: "STA-181", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [] });
      const out = await runCommand(["begin", "STA-181"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("at max_running (1)");
      const issue = h.world.issues[1]!;
      expect(issue.stateId).toBe(TODO);
      expect(issue.labelIds).toEqual([PENDING]);
      expect(h.workspaces.workspaces).toHaveLength(0);
      expect(h.workspaces.agents).toHaveLength(0);
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

describe("pause and resume", () => {
  test("pause blocks with a reason, records paused, and prompts the stage worker", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      await runCommand(["begin", "STA-1"], h.ctx);
      const out = await runCommand(["pause", "STA-1"], h.ctx);
      expect(out).toMatchObject({ ok: true });
      expect(out.text).toContain("paused STA-1");
      expect(h.world.issues[0]!.labelIds).toEqual([BLOCKED]);
      expect(h.workspaces.tokensFor("STA-1")).toMatchObject({ paused: "1" });
      expect(h.workspaces.promptsFor("builder-sta-1").at(-1)).toContain("the owner paused this ticket");
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

  test("resume clears paused and points at begin for the worker", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      await runCommand(["begin", "STA-1"], h.ctx);
      await runCommand(["pause", "STA-1"], h.ctx);
      const out = await runCommand(["resume", "STA-1"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("resumed STA-1");
      expect(out.text).toContain("igniter begin STA-1");
      expect(h.world.issues[0]!.labelIds).toEqual([PENDING]);
      const tokens = h.workspaces.tokensFor("STA-1");
      expect(tokens).not.toHaveProperty("paused");
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

  test("resume never launches agents, even with a bad commander profile", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, title: "Lost worker", labelIds: [IN_PROGRESS] });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1" }, { commander: false });
      h.ctx.resolved.config = parseDispatchConfig({
        project: "igniter",
        team: "Starcoder",
        agents: { commander: { effort: "turbo" } },
      });
      const out = await runCommand(["resume", "STA-1"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("igniter begin STA-1");
      expect(h.workspaces.calls.filter((c) => c.method === "agent.start")).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("resume on a blocked ticket unblocks and points at begin", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, title: "Blocked", labelIds: [BLOCKED] });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1", paused: "1" }, { commander: false });
      const out = await runCommand(["resume", "STA-1"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("igniter begin STA-1");
      expect(h.world.issues[0]!.labelIds).toEqual([PENDING]);
      expect(h.workspaces.calls.filter((c) => c.method === "agent.start")).toHaveLength(0);
      expect(h.workspaces.calls.filter((c) => c.method === "tab.create")).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("a blocked resume unblocks without opening tabs or agents", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, title: "Blocked orphan", labelIds: [BLOCKED] });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1", paused: "1" }, { commander: false });
      h.workspaces.seedAgent("STA-1", "builder-sta-1");
      const out = await runCommand(["resume", "STA-1"], h.ctx);
      expect(out.ok).toBe(true);
      expect(h.world.issues[0]!.labelIds).toEqual([PENDING]);
      expect(h.workspaces.calls.filter((c) => c.method === "tab.create")).toHaveLength(0);
      expect(h.workspaces.calls.filter((c) => c.method === "agent.start")).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("an active build ticket with a live worker is already running", async () => {
    const h = await harness(1);
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, title: "Live worker", labelIds: [IN_PROGRESS] });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1" }, { commander: false });
      h.workspaces.seedAgent("STA-1", "builder-sta-1");
      const out = await runCommand(["resume", "STA-1"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("already running");
      const issue = h.world.issues[0]!;
      expect(issue.stateId).toBe(BUILD);
      expect(issue.labelIds).toEqual([IN_PROGRESS]);
      expect(issue.comments).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("a review ticket with a live worker is already running", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-2", stateId: REVIEW, priority: 1, description: CRITERIA, title: "Review live", labelIds: [IN_PROGRESS] });
      h.workspaces.seedWorkspace("STA-2", { ticket: "STA-2" }, { commander: false });
      h.workspaces.seedAgent("STA-2", "reviewer-sta-2", "reviewer");
      const out = await runCommand(["resume", "STA-2"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("already running");
      expect(h.world.issues[0]!.labelIds).toEqual([IN_PROGRESS]);
      expect(h.world.issues[0]!.comments).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("a deliver ticket with no worker points at begin", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-3", stateId: "st-deliver", priority: 1, description: CRITERIA, title: "Deliver orphan", labelIds: [PENDING] });
      h.workspaces.seedWorkspace("STA-3", { ticket: "STA-3" }, { commander: false });
      const out = await runCommand(["resume", "STA-3"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("igniter begin STA-3");
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

  test("resume without a workspace points at begin", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      const out = await runCommand(["resume", "STA-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("no workspace for STA-1; use `igniter begin STA-1`");
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
      expect(h.workspaces.workspaces[0]!.closed).toBe(true);
      expect(h.lines).toEqual([
        "STA-1 started build worker builder-sta-1 in ws-1 (Todo → Build)",
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
  test("writes the new builder and prompts the stage worker", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      await runCommand(["begin", "STA-1"], h.ctx);
      const out = await runCommand(["restart", "STA-1", "--builder", "new/model"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("restarted STA-1 with builder new/model");
      expect(h.workspaces.tokensFor("STA-1")).toMatchObject({ builder: "new/model" });
      const inbox = h.workspaces.promptsFor("builder-sta-1");
      expect(inbox.at(-1)).toContain("restart the Builder with model new/model");
      expect(inbox.at(-1)).toContain("read `git diff` first");
      expect(h.lines).toContain("STA-1 restarted with builder new/model by command");
    } finally {
      h.stop();
    }
  });

  test("without a live stage worker says to begin first", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1" }, { commander: false });
      const out = await runCommand(["restart", "STA-1", "--builder", "new/model"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("use `igniter begin STA-1` first");
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
      "gpt-5.6-sol",
      "gpt-5.6-luna",
      "gpt-6-astra",
      "/stages/build.md",
      "/stages/review.md",
      "/stages/deliver.md",
      "harness `codex`",
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

  test("a begin reuses the recorded stage profiles when the configuration drifts", async () => {
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
      const out = await runCommand(["begin", "STA-1"], h.ctx);
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

  test("a worktree failure aborts the begin before any workspace opens", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.git.failOn = ["worktree"];
      h.git.failMessage = "fatal: not a git repository";
      const out = await runCommand(["begin", "STA-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("not a git repository");
      expect(h.workspaces.workspaces).toHaveLength(0);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 begin failed:"));
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

  test("begin creates every worker scratch and records it in workspace metadata", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-8", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const out = await runCommand(["begin", "STA-8"], h.ctx);
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
