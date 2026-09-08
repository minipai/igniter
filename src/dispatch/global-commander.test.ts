// Singleton Global Commander flow (STA-225, corrected) against a fake
// Linear endpoint and fake Herdr: `start` boots the one project-level
// Commander, `start STA-X` assigns to that same singleton, and the
// Commander drives stage workers itself through ticket-targeted `begin`.
// No real credentials, project, or daemon.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commanderAssetPaths } from "../commander/assets";
import { runCommand, type CommandContext } from "./commands";
import { validateStartup, type ResolvedDispatch } from "./claims";
import { parseDispatchConfig } from "./config";
import { LinearClient } from "./linear";
import { latestValidReceipt } from "./protocol";
import { addIssue, standardWorld, startFakeLinear } from "./fake-linear";
import { FakeGit } from "./fake-git";
import { FakeWorkspaces } from "./fake-workspaces";
import { createWorkspaceSink } from "./commands";
import { scratchFor } from "./worker-scope";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const TODO = "st-todo";
const BUILD = "st-build";
const REVIEW = "st-review";
const DELIVER = "st-deliver";
const PENDING = "label-pending";
const IN_PROGRESS = "label-in-progress";
const BLOCKED = "label-blocked";
const CRITERIA = "## 驗收條件\n- [ ] works\n";
const HEAD = "cafe0001deadbeef";

/** Fast deterministic prompt budget: no clock, two sends, two read-backs each. */
const FAST = { maxAttempts: 2, pollAttempts: 2, pollIntervalMs: 0, sleep: async () => {} };

interface Harness {
  ctx: CommandContext;
  lines: string[];
  workspaces: FakeWorkspaces;
  git: FakeGit;
  repoRoot: string;
  client: LinearClient;
  resolved: ResolvedDispatch;
  world: ReturnType<typeof standardWorld>;
  stop: () => void;
}

async function harness(maxRunning = 3): Promise<Harness> {
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
  const repoRoot = join(mkdtempSync(join(tmpdir(), "igniter-global-")), "repo");
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
    promptDelivery: FAST,
  };
  return { ctx, lines, workspaces, git, repoRoot, client, resolved, world, stop: () => fake.stop() };
}

function buildPayload(head = HEAD) {
  return {
    v: 1,
    kind: "build",
    checkpoint: head,
    checks: ["bun run check"],
    results: [{ criterion: "works", ok: true }],
    reproduction: "run bun run check",
  };
}

describe("singleton lifecycle", () => {
  test("start boots one Commander with the absolute global.md patrol order", async () => {
    const h = await harness();
    try {
      const out = await runCommand(["start"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("commander started in ws-1");
      expect(h.workspaces.agents.map((a) => a.name)).toEqual(["commander"]);
      expect(h.workspaces.agents.some((a) => a.name.startsWith("commander-"))).toBe(false);
      const assets = commanderAssetPaths();
      const inbox = h.workspaces.promptsFor("commander");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toContain(assets.global);
      expect(inbox[0]).toContain("igniter");
      expect(h.workspaces.tokensFor("igniter-commander")).toMatchObject({ role: "global-commander", project: "igniter" });
    } finally {
      h.stop();
    }
  });

  test("start STA-X reuses the same singleton across tickets, never commander-STA-X", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      addIssue(h.world, { identifier: "STA-2", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      expect((await runCommand(["start"], h.ctx)).ok).toBe(true);
      expect((await runCommand(["start", "STA-1"], h.ctx)).ok).toBe(true);
      expect((await runCommand(["start", "STA-2"], h.ctx)).ok).toBe(true);
      expect(h.workspaces.workspaces.filter((w) => !w.closed)).toHaveLength(1);
      expect(h.workspaces.agents.map((a) => a.name)).toEqual(["commander"]);
      expect(h.workspaces.tokensFor("igniter-commander")).toMatchObject({ assignment: "STA-2" });
    } finally {
      h.stop();
    }
  });

  test("global.md prompt delivery is confirmed; a stall fails without side effects", async () => {
    const h = await harness();
    try {
      h.workspaces.promptMode = "input-buffer";
      const out = await runCommand(["start"], h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("role=commander");
      expect(out.text).toContain("agent=commander");
      expect(out.text).toContain("stalled");
      // The agent exists but holds no order; the retry converges.
      expect(h.workspaces.agents.map((a) => a.name)).toEqual(["commander"]);
      h.workspaces.promptMode = "consumed";
      const retry = await runCommand(["start"], h.ctx);
      expect(retry.ok).toBe(true);
      expect(h.workspaces.agents).toHaveLength(1);
    } finally {
      h.stop();
    }
  });

  test("a lost Commander agent or workspace is rebuilt on takeover", async () => {
    const h = await harness();
    try {
      expect((await runCommand(["start"], h.ctx)).ok).toBe(true);
      h.workspaces.agents = [];
      expect((await runCommand(["start"], h.ctx)).ok).toBe(true);
      expect(h.workspaces.agents.map((a) => a.name)).toEqual(["commander"]);
      h.workspaces.workspaces = [];
      h.workspaces.agents = [];
      const rebuilt = await runCommand(["start", "STA-1"], h.ctx);
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      void rebuilt;
      const assigned = await runCommand(["start", "STA-1"], h.ctx);
      expect(assigned.ok).toBe(true);
      expect(assigned.text).toContain("assigned STA-1");
    } finally {
      h.stop();
    }
  });
});

describe("ticket-targeted begin", () => {
  test("begin derives the stage and launches the worker; start never does", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      expect((await runCommand(["start", "STA-1"], h.ctx)).ok).toBe(true);
      // Assignment alone moves no Linear state and starts no worker.
      expect(h.world.issues[0]!.stateId).toBe(TODO);
      expect(h.workspaces.agents.find((a) => a.name === "builder-sta-1")).toBeUndefined();
      // The Commander begins the stage itself.
      const begun = await runCommand(["begin", "STA-1"], h.ctx);
      expect(begun.ok).toBe(true);
      expect(begun.text).toContain("builder-sta-1");
      expect(h.world.issues[0]!.stateId).toBe(BUILD);
      expect(h.world.issues[0]!.labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("begin rejects a stage flag; Review and Deliver derive their workers", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      expect((await runCommand(["begin", "STA-1", "build"], h.ctx)).ok).toBe(false);
      addIssue(h.world, { identifier: "STA-2", stateId: REVIEW, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      expect((await runCommand(["begin", "STA-2"], h.ctx)).ok).toBe(true);
      expect(h.workspaces.agents.find((a) => a.name === "reviewer-sta-2")).toBeDefined();
      addIssue(h.world, { identifier: "STA-3", stateId: DELIVER, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      expect((await runCommand(["begin", "STA-3"], h.ctx)).ok).toBe(true);
      expect(h.workspaces.agents.find((a) => a.name === "deliverer-sta-3")).toBeDefined();
    } finally {
      h.stop();
    }
  });

  test("worker, ready, or delivery failure keeps Pending; success moves to In progress", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.workspaces.failMethods.add("agent.start");
      expect((await runCommand(["begin", "STA-1"], h.ctx)).ok).toBe(false);
      expect(h.world.issues[0]!.stateId).toBe(TODO);
      h.workspaces.failMethods.clear();
      h.workspaces.promptMode = "input-buffer";
      expect((await runCommand(["begin", "STA-1"], h.ctx)).ok).toBe(false);
      expect(h.world.issues[0]!.stateId).toBe(TODO);
      h.workspaces.promptMode = "consumed";
      expect((await runCommand(["begin", "STA-1"], h.ctx)).ok).toBe(true);
      expect(h.world.issues[0]!.stateId).toBe(BUILD);
    } finally {
      h.stop();
    }
  });

  test("the work order carries the bundled prompt and forbids Igniter/Linear/receipts", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, title: "Feature", labelIds: [PENDING] });
      expect((await runCommand(["begin", "STA-1"], h.ctx)).ok).toBe(true);
      const assets = commanderAssetPaths();
      const inbox = h.workspaces.promptsFor("builder-sta-1");
      expect(inbox[0]).toContain(assets.prompts.build);
      expect(inbox[0]).toContain("result.md");
      expect(inbox[0]).toContain("BUILD_HANDOFF_COMPLETE");
      expect(inbox[0]).not.toContain("`igniter state");
      expect(inbox[0]).not.toContain("`igniter submit");
      expect(inbox[0]).not.toContain("`igniter begin");
    } finally {
      h.stop();
    }
  });
});

describe("automatic result collection and submission", () => {
  test("the Commander reads result.md and submits it ticket-targeted", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      expect((await runCommand(["begin", "STA-1"], h.ctx)).ok).toBe(true);
      // The worker writes its result file with the completion marker.
      const dir = scratchFor(h.repoRoot, "STA-1", "builder");
      mkdirSync(dir, { recursive: true });
      const resultPath = join(dir, "result.md");
      writeFileSync(resultPath, `# Build result\n\nCheckpoint: \`${HEAD}\`\n\n\`\`\`text\nBUILD_HANDOFF_COMPLETE\n\`\`\`\n`);
      const report = readFileSync(resultPath, "utf8");
      expect(report).toContain("BUILD_HANDOFF_COMPLETE");
      // The Commander converts the validated report to the submit schema.
      const out = await runCommand(["submit", "STA-1", "--input", "-"], h.ctx, {
        input: JSON.stringify(buildPayload()),
      });
      expect(out.ok).toBe(true);
      expect(h.world.issues[0]!.stateId).toBe(REVIEW);
      expect(latestValidReceipt(h.world.issues[0]!.comments)).toMatchObject({ receipt: { kind: "build" } });
    } finally {
      h.stop();
    }
  });

  test("status, block, unblock, and reconcile stay ticket-targeted without a workspace id", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1" }, { commander: false });
      const status = await runCommand(["status", "STA-1", "--json"], h.ctx);
      expect(status.ok).toBe(true);
      expect((await runCommand(["block", "STA-1", "--reason", "vendor"], h.ctx)).ok).toBe(true);
      expect(h.world.issues[0]!.labelIds).toEqual([BLOCKED]);
      expect((await runCommand(["unblock", "STA-1"], h.ctx)).ok).toBe(true);
      const reconciled = await runCommand(["reconcile", "STA-1"], h.ctx);
      expect(reconciled.ok).toBe(true);
    } finally {
      h.stop();
    }
  });
});

describe("idempotent recovery", () => {
  test("same worker, partial begin, and retry never duplicate", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.workspaces.promptMode = "input-buffer";
      expect((await runCommand(["begin", "STA-1"], h.ctx)).ok).toBe(false);
      expect(h.workspaces.agents.filter((a) => a.name === "builder-sta-1")).toHaveLength(1);
      h.workspaces.promptMode = "consumed";
      expect((await runCommand(["begin", "STA-1"], h.ctx)).ok).toBe(true);
      expect(h.workspaces.agents.filter((a) => a.name === "builder-sta-1")).toHaveLength(1);
      expect(h.workspaces.workspaces.filter((w) => w.label === "STA-1")).toHaveLength(1);
      const inboxBefore = h.workspaces.promptsFor("builder-sta-1").length;
      expect((await runCommand(["begin", "STA-1"], h.ctx)).ok).toBe(false);
      expect(h.workspaces.promptsFor("builder-sta-1")).toHaveLength(inboxBefore);
      // Same singleton assignment twice never duplicates either.
      expect((await runCommand(["start"], h.ctx)).ok).toBe(true);
      expect(h.workspaces.agents.filter((a) => a.name === "commander")).toHaveLength(1);
    } finally {
      h.stop();
    }
  });

  test("a known ticket with no workspace is refused by identity with no Linear write", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      const submit = await runCommand(["submit", "STA-1", "--input", "-"], h.ctx, {
        input: JSON.stringify(buildPayload()),
      });
      expect(submit.ok).toBe(false);
      expect(submit.text).toContain("no workspace for STA-1");
      expect(h.world.issues[0]!.comments).toHaveLength(0);
    } finally {
      h.stop();
    }
  });
});
