// Foreground Global Commander and explicit ticket commands against in-process
// fake Linear and Herdr. The Commander drives stage workers through
// ticket-targeted `worker start`.
// No real credentials, project, or daemon.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commanderAssetPaths } from "../../../commander/assets";
import { runCommand, type CommandContext } from "../../run";
import { validateStartup, type ResolvedDispatch } from "../../config/claims";
import { loadDispatchConfig, parseDispatchConfig } from "../../config/config";
import { LinearClient } from "../../service/linear/linear";
import { latestValidReceipt } from "../ticket/protocol";
import { addIssue, standardWorld, startFakeLinear } from "../../service/linear/fake-linear";
import { FakeGit } from "../../testing/fake-git";
import { FakeWorkspaces } from "../../testing/fake-workspaces";
import { scratchFor } from "../../service/worktree/worker-scope";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const TODO = "st-todo";
const BUILD = "st-build";
const REVIEW = "st-review";
const DELIVER = "st-deliver";
const PENDING = "label-pending";
const IN_PROGRESS = "label-in-progress";
const COMPLETE = "label-complete";
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
  const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url, fetchImpl: fake.fetchImpl });
  const resolved = await validateStartup(
    client,
    parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: maxRunning }),
  );
  const lines: string[] = [];
  const workspaces = new FakeWorkspaces();
  const git = new FakeGit();
  git.head = HEAD;
  const repoRoot = join(mkdtempSync(join(tmpdir(), "igniter-global-")), "repo");
  const ctx: CommandContext = {
    client,
    resolved,
    decisions: {
      record: async (ticket, message) => {
        lines.push(`${ticket} ${message}`);
      },
    },
    workspaces,
    repoRoot,
    git,
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

describe("foreground lifecycle", () => {
  test("CLI start prepares the configured foreground Commander without touching Herdr layout", async () => {
    const h = await harness();
    try {
      const out = await runCommand({ command: "start" }, h.ctx);

      expect(out.ok).toBe(true);
      expect(out.text).toContain("current terminal");
      const launch = out.data as { kind: string; cwd: string; command: string[] };
      expect(launch.kind).toBe("commander_foreground");
      expect(launch.cwd).toBe(h.repoRoot);
      expect(launch.command.slice(0, 5)).toEqual([
        "codex",
        "-m",
        "gpt-6-astra",
        "-c",
        'model_reasoning_effort="medium"',
      ]);
      expect(launch.command.at(-1)).toContain("Begin with `igniter status --json`");
      expect(launch.command.at(-1)).not.toContain("Assigned ticket");
      expect(launch.command.at(-1)).toContain("not your assignment");
      expect(launch.command.at(-1)).toContain("missing local worker never makes it yours");
      expect(launch.command.at(-1)).toContain(commanderAssetPaths().global);
      expect(launch.command.at(-1)).toContain("follow the configured project delivery instructions");
      expect(launch.command.at(-1)).not.toContain("deliveries land on local");
      expect(launch.command.at(-1)).not.toContain("Do not read any other prompt");
      expect(launch.command.at(-1)).not.toContain("You are the Global Commander");
      expect(h.workspaces.calls).toEqual([]);
      expect(h.workspaces.workspaces).toEqual([]);
    } finally {
      h.stop();
    }
  });
});

describe("ticket-targeted worker start", () => {
  test("worker start confirms the worker before begin records the stage", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      expect((await runCommand({ command: "start" }, h.ctx)).ok).toBe(true);
      // Starting alone moves no Linear state and starts no worker.
      expect(h.world.issues[0]!.stateId).toBe(TODO);
      expect(h.workspaces.agents.find((a) => a.name === "builder-sta-1")).toBeUndefined();
      // The Commander confirms the worker before recording the stage start.
      const begun = await runCommand({ command: "worker.start", ticket: "STA-1" }, h.ctx);
      expect(begun.ok).toBe(true);
      expect(begun.text).toContain("builder-sta-1");
      expect(h.world.issues[0]!.stateId).toBe(TODO);
      expect((await runCommand({ command: "begin", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
      expect(h.world.issues[0]!.stateId).toBe(BUILD);
      expect(h.world.issues[0]!.labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("Review and Deliver derive their workers", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-2", stateId: REVIEW, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      expect((await runCommand({ command: "worker.start", ticket: "STA-2" }, h.ctx)).ok).toBe(true);
      expect(h.workspaces.agents.find((a) => a.name === "reviewer-sta-2")).toBeDefined();
      addIssue(h.world, { identifier: "STA-3", stateId: DELIVER, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      expect((await runCommand({ command: "worker.start", ticket: "STA-3" }, h.ctx)).ok).toBe(true);
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
      expect((await runCommand({ command: "worker.start", ticket: "STA-1" }, h.ctx)).ok).toBe(false);
      expect(h.world.issues[0]!.stateId).toBe(TODO);
      h.workspaces.failMethods.clear();
      h.workspaces.promptMode = "input-buffer";
      expect((await runCommand({ command: "worker.start", ticket: "STA-1" }, h.ctx)).ok).toBe(false);
      expect(h.world.issues[0]!.stateId).toBe(TODO);
      h.workspaces.promptMode = "consumed";
      expect((await runCommand({ command: "worker.start", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
      expect(h.world.issues[0]!.stateId).toBe(TODO);
      expect((await runCommand({ command: "begin", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
      expect(h.world.issues[0]!.stateId).toBe(BUILD);
    } finally {
      h.stop();
    }
  });

  test("the work order carries the bundled prompt and forbids Igniter/Linear/receipts", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, title: "Feature", labelIds: [PENDING] });
      expect((await runCommand({ command: "worker.start", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
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

  test.each([undefined, "CONTRIBUTING.md"])("stage work orders retain configured delivery instructions: %j", async (delivery) => {
    const h = await harness();
    try {
      h.ctx.resolved.config.delivery = delivery;
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      expect((await runCommand({ command: "worker.start", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
      const order = h.workspaces.promptsFor("builder-sta-1")[0]!;
      expect(order).toContain("AGENTS.md");
      if (delivery) {
        expect(order).toContain("read `CONTRIBUTING.md` (relative to the repo root) as the delivery document");
        expect(order).toContain("Do not search for another one");
      } else {
        expect(order).toContain("No delivery document is configured");
        expect(order).toContain("do not invent project settings");
      }
    } finally { h.stop(); }
  });

  test("worker start sends a project stage prompt loaded from .igniter/config.yaml", async () => {
    const h = await harness();
    try {
      const workflow = join(h.repoRoot, ".igniter", "workflow");
      mkdirSync(workflow, { recursive: true });
      writeFileSync(join(h.repoRoot, ".igniter", "config.yaml"), [
        "project: igniter",
        "team: Starcoder",
        "stages:",
        "  build: { prompt: .igniter/workflow/build.md, agent: builder }",
        "  review: { prompt: .igniter/workflow/review.md, agent: reviewer }",
        "  deliver: { prompt: .igniter/workflow/deliver.md, agent: deliverer }",
        "",
      ].join("\n"));
      for (const stage of ["build", "review", "deliver"] as const) {
        writeFileSync(join(workflow, `${stage}.md`), `# project ${stage}\n`);
      }
      h.ctx.resolved.config.commander = (await loadDispatchConfig(h.repoRoot)).commander;

      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      expect((await runCommand({ command: "worker.start", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
      const order = h.workspaces.promptsFor("builder-sta-1")[0]!;
      expect(order).toContain(join(workflow, "build.md"));
      expect(order).not.toContain(commanderAssetPaths().prompts.build);
    } finally {
      h.stop();
    }
  });
});

describe("explicit result collection and submission", () => {
  test("the Commander reviews result.md and submits the sibling JSON artifact", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      expect((await runCommand({ command: "worker.start", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
      expect((await runCommand({ command: "begin", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
      // JSON carries the submit payload; Markdown only adds review findings
      // and the worker's completion signal. Neither file advances the ticket.
      const dir = scratchFor(h.repoRoot, "STA-1", "builder");
      mkdirSync(dir, { recursive: true });
      const resultPath = join(dir, "result.md");
      const artifactPath = join(dir, "submit.json");
      writeFileSync(artifactPath, JSON.stringify(buildPayload(), null, 2));
      writeFileSync(resultPath, "# Build result\n\nCode review: no findings.\nUnresolved concerns: none.\n\nBUILD_HANDOFF_COMPLETE\n");
      const report = readFileSync(resultPath, "utf8");
      expect(report).toContain("BUILD_HANDOFF_COMPLETE");
      expect(h.world.issues[0]!.labelIds).toEqual([IN_PROGRESS]);
      expect(latestValidReceipt(h.world.issues[0]!.comments)).toBeNull();
      // The Commander reviews the files and evidence, then submits the worker's
      // JSON directly. CLI stdin coverage lives in cli-artifacts.e2e.test.ts.
      const payload = JSON.parse(readFileSync(artifactPath, "utf8"));
      const out = await runCommand({ command: "submit", ticket: "STA-1", payload }, h.ctx);
      expect(out.ok).toBe(true);
      // The first Build waits at Build+Complete for owner acceptance;
      // only the owner handoff moves it toward Review.
      expect(h.world.issues[0]!.stateId).toBe(BUILD);
      expect(h.world.issues[0]!.labelIds).toEqual([COMPLETE]);
      expect(latestValidReceipt(h.world.issues[0]!.comments)).toMatchObject({ receipt: { kind: "build" } });
    } finally {
      h.stop();
    }
  });

  test("status, block, unblock, and reconcile stay ticket-targeted without a workspace id", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1" });
      const status = await runCommand({ command: "status", ticket: "STA-1", json: true }, h.ctx);
      expect(status.ok).toBe(true);
      expect((await runCommand({ command: "block", ticket: "STA-1", reason: "vendor" }, h.ctx)).ok).toBe(true);
      expect(h.world.issues[0]!.labelIds).toEqual([BLOCKED]);
      expect((await runCommand({ command: "unblock", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
      const reconciled = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(reconciled.ok).toBe(true);
    } finally {
      h.stop();
    }
  });
});

describe("idempotent recovery", () => {
  test("same worker, partial start, and retry never duplicate", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      h.workspaces.promptMode = "input-buffer";
      expect((await runCommand({ command: "worker.start", ticket: "STA-1" }, h.ctx)).ok).toBe(false);
      expect(h.workspaces.agents.filter((a) => a.name === "builder-sta-1")).toHaveLength(1);
      h.workspaces.promptMode = "consumed";
      expect((await runCommand({ command: "worker.start", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
      expect(h.workspaces.agents.filter((a) => a.name === "builder-sta-1")).toHaveLength(1);
      expect(h.workspaces.workspaces.filter((w) => w.label === "STA-1")).toHaveLength(1);
      const inboxBefore = h.workspaces.promptsFor("builder-sta-1").length;
      expect((await runCommand({ command: "worker.start", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
      expect(h.workspaces.promptsFor("builder-sta-1")).toHaveLength(inboxBefore);

    } finally {
      h.stop();
    }
  });

  test("submit validates a ticket checkpoint without requiring a worker workspace", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      const submit = await runCommand({ command: "submit", ticket: "STA-1", payload: buildPayload() }, h.ctx);
      expect(submit.ok).toBe(true);
      expect(h.workspaces.calls).toHaveLength(0);
      expect(latestValidReceipt(h.world.issues[0]!.comments)).toMatchObject({ receipt: { kind: "build", checkpoint: HEAD } });
    } finally {
      h.stop();
    }
  });
});
