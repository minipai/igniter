// Generated stage work orders: the per-run prompt the Commander delivers to
// each stage worker. These tests exercise the real builder and the real
// `worker start` path, so a contract change cannot pass by editing one
// Markdown file. No credentials, provider, or real project.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStageWorkOrder, type StageWorkOrderInput } from "./stage-start.ts";
import { workerCommand, type CommandContext } from "../../run.ts";
import { validateStartup } from "../../config/claims.ts";
import { parseDispatchConfig } from "../../config/config.ts";
import {
  MemoryLinearClient,
  memoryAddIssue,
  standardMemoryWorld,
} from "../../service/linear/fake-memory-linear.ts";
import { FakeWorkspaces } from "../../testing/fake-workspaces.ts";
import { FakeGit } from "../../testing/fake-git.ts";
import { ticketWorktree } from "../../service/worktree/worktrees.ts";

/** An implementation hint Acceptance must never receive. */
const HINT = "只修改 src/workflow/lifecycle/stage/stage-start.ts 的 buildStageWorkOrder";
const DESCRIPTION = [
  "## 問題",
  "工作單與 prompt 契約互相矛盾。",
  "## 範圍",
  `- ${HINT}`,
  "## Acceptance criteria",
  "- [ ] Acceptance 只收到需求與可觀察條件",
  "- [ ] 本機服務可啟動",
].join("\n");
const CRITERIA = ["Acceptance 只收到需求與可觀察條件", "本機服務可啟動"];

function input(overrides: Partial<StageWorkOrderInput> = {}): StageWorkOrderInput {
  return {
    identifier: "STA-241",
    title: "統一 stage 指令",
    description: DESCRIPTION,
    criteria: CRITERIA,
    worktreePath: "/worktrees/sta-241",
    branch: "feature/sta-241",
    checkpoint: "abc123",
    resultPath: "/scratch/sta-241/builder/result.md",
    stage: "build",
    promptPath: "/igniter/stages/build.md",
    harness: "opencode",
    model: "opencode-go/deepseek-v4-flash",
    ...overrides,
  };
}

describe("generated stage work order inputs", () => {
  test("Build receives the feature request, criteria, and Git context", () => {
    const order = buildStageWorkOrder(input({ stage: "build" }));
    expect(order).toContain("Feature request:");
    expect(order).toContain(HINT);
    expect(order).toContain("Checkpoint to work from: `abc123`");
    expect(order).toContain("Inspect the worktree diff and branch log first");
    expect(order).toContain("BUILD_HANDOFF_COMPLETE");
  });

  test("Deliver receives the feature request, criteria, and Git context", () => {
    const order = buildStageWorkOrder(input({ stage: "deliver", resultPath: "/scratch/sta-241/deliverer/result.md" }));
    expect(order).toContain("Feature request:");
    expect(order).toContain(HINT);
    expect(order).toContain("Checkpoint to work from: `abc123`");
    expect(order).toContain("Inspect the worktree diff and branch log first");
    expect(order).toContain("DELIVERY_COMPLETE");
  });

  test("Acceptance receives only the requirement, observable criteria, runbook, and checkpoint", () => {
    const order = buildStageWorkOrder(input({ stage: "review", resultPath: "/scratch/sta-241/reviewer/result.md" }));
    expect(order).toContain("Requirement: 統一 stage 指令");
    expect(order).toContain("Observable acceptance criteria:");
    expect(order).toContain("Acceptance 只收到需求與可觀察條件");
    expect(order).toContain("本機服務可啟動");
    expect(order).toContain("Public entry: the repository's run and acceptance instructions");
    expect(order).toContain("Checkpoint to work from: `abc123`");
    expect(order).toContain("Do not read source files, git history, or diffs");
    expect(order).toContain("ACCEPTANCE_COMPLETE");
    expect(order).not.toContain(HINT);
    expect(order).not.toContain(DESCRIPTION);
    expect(order).not.toContain("Feature request:");
    expect(order).not.toContain("Acceptance criteria:");
    expect(order).not.toContain("Inspect the worktree diff and branch log first");
  });

  test("Acceptance may start the tested product's local service but not Igniter, Linear, or publication", () => {
    const order = buildStageWorkOrder(input({ stage: "review", resultPath: "/scratch/sta-241/reviewer/result.md" }));
    expect(order).toMatch(/tested product's own local services/i);
    expect(order).toContain("Do not run any `igniter` command");
    expect(order).toContain("do not call Linear");
    expect(order).toContain("do not publish Linear receipts");
    expect(order).toContain("Do not publish externally on your own");
  });
});

/** Run the real `worker start` path and return the delivered work order. */
async function generatedOrder(state: string, identifier = "STA-241"): Promise<string> {
  const world = standardMemoryWorld();
  const issue = memoryAddIssue(world, {
    identifier,
    stateId: state,
    labelIds: ["label-pending"],
    description: DESCRIPTION,
    title: "統一 stage 指令",
  });
  const client = new MemoryLinearClient(world);
  const resolved = await validateStartup(client, parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 3 }));
  const workspaces = new FakeWorkspaces();
  const git = new FakeGit();
  git.head = "abc123";
  const repoRoot = join(mkdtempSync(join(tmpdir(), "igniter-order-")), "repo");
  const worktree = ticketWorktree(repoRoot, issue.identifier);
  git.worktreeList = `worktree ${worktree.path}\nbranch refs/heads/${worktree.branch}\n`;
  const ctx: CommandContext = {
    client,
    resolved,
    workspaces,
    git,
    repoRoot,
    decisions: { record: async () => {} },
    promptDelivery: { maxAttempts: 2, pollAttempts: 1, pollIntervalMs: 0, sleep: async () => {} },
  };
  const out = await workerCommand({ command: "worker.start", ticket: identifier }, ctx);
  if (!out.ok) throw new Error(out.text);
  const role = state === "st-review" ? "reviewer" : state === "st-deliver" ? "deliverer" : "builder";
  return workspaces.promptsFor(`${role}-${identifier.toLowerCase()}`)[0]!;
}

describe("worker start delivers the generated per-stage work order", () => {
  test("Build keeps the request and Git context", async () => {
    const order = await generatedOrder("st-build");
    expect(order).toContain("Feature request:");
    expect(order).toContain(HINT);
    expect(order).toContain("Inspect the worktree diff and branch log first");
  });

  test("Acceptance withholds implementation hints and allows the local product service", async () => {
    const order = await generatedOrder("st-review");
    expect(order).toContain("Requirement: 統一 stage 指令");
    expect(order).toContain("Acceptance 只收到需求與可觀察條件");
    expect(order).toContain("本機服務可啟動");
    expect(order).not.toContain(HINT);
    expect(order).not.toContain(DESCRIPTION);
    expect(order).not.toContain("## 範圍");
    expect(order).not.toContain("Feature request:");
    expect(order).not.toContain("Inspect the worktree diff and branch log first");
    expect(order).toContain("Do not read source files, git history, or diffs");
    expect(order).toMatch(/tested product's own local services/i);
    expect(order).toContain("Do not run any `igniter` command");
  });

  test("Deliver keeps the request and Git context", async () => {
    const order = await generatedOrder("st-deliver");
    expect(order).toContain("Feature request:");
    expect(order).toContain(HINT);
    expect(order).toContain("Inspect the worktree diff and branch log first");
  });
});
