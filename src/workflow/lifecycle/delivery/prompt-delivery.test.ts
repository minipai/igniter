// Prompt-delivery confirmation against a deterministic fake Herdr: the
// shared start gate behind the Global Commander and every stage agent.
// No network, no daemon, no real project.
//
// The regression core is the STA-197/STA-222 input-buffer failure: Herdr
// answers `agent_prompted` while the text only sits in the interactive
// input box and the agent lifecycle never moves. Success must wait for an
// observed lifecycle change; anything else keeps protocol state and
// retries the identical work order.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confirmPromptDelivery,
  deliveryKey,
  promptConsumed,
  PromptDeliveryError,
  workOrderHash,
  type PromptDeliveryIdentity,
  type PromptDeliveryPolicy,
} from "./prompt-delivery";
import { validateStartup, type ResolvedDispatch } from "../../config/claims";
import { runCommand, type CommandContext } from "../../run";
import { parseDispatchConfig } from "../../config/config";
import { LinearClient } from "../../service/linear/linear";
import { addIssue, standardWorld, startFakeLinear } from "../../service/linear/fake-linear";
import { FakeGit } from "../../testing/fake-git";
import { FakeWorkspaces } from "../../testing/fake-workspaces";

const TODO = "st-todo";
const BUILD = "st-build";
const PENDING = "label-pending";
const IN_PROGRESS = "label-in-progress";
const CRITERIA = "## 驗收條件\n- [ ] works\n";
const HEAD = "cafe0001deadbeef";

/** Fast deterministic budget: no clock, two sends, two read-backs each. */
const FAST: PromptDeliveryPolicy = {
  maxAttempts: 2,
  pollAttempts: 2,
  pollIntervalMs: 0,
  sleep: async () => {},
};

function identity(over: Partial<PromptDeliveryIdentity> = {}): PromptDeliveryIdentity {
  return {
    project: "igniter",
    ticket: "STA-1",
    role: "builder",
    stage: "build",
    agent: "builder-sta-1",
    workOrder: workOrderHash("work order text"),
    ...over,
  };
}

/** One live workspace with one running agent, the way a start leaves it. */
async function liveAgent(fake: FakeWorkspaces, name: string): Promise<{ workspaceId: string; paneId: string }> {
  const { workspaceId, rootPaneId } = await fake.create({ label: "STA-1", cwd: "/tmp/sta-1", env: {} });
  await fake.startAgent({ paneId: rootPaneId, kind: "claude", name });
  return { workspaceId, paneId: rootPaneId };
}

describe("delivery identity", () => {
  test("work orders hash stably and distinctly", () => {
    expect(workOrderHash("same")).toBe(workOrderHash("same"));
    expect(workOrderHash("same")).not.toBe(workOrderHash("other"));
  });

  test("the key binds project, ticket, role, stage, agent, revision, and work order", () => {
    const base = identity();
    const key = deliveryKey(base, 3);
    expect(key).toContain("igniter|STA-1|builder|build|builder-sta-1|3|");
    for (const over of [
      { project: "other" },
      { ticket: "STA-2" },
      { ticket: null },
      { role: "reviewer" as const },
      { stage: "review" as const },
      { agent: "builder-sta-2" },
      { workOrder: "deadbeef" },
    ]) {
      expect(deliveryKey(identity(over), 3)).not.toBe(key);
    }
    expect(deliveryKey(base, 4)).not.toBe(key);
  });

  test("consumption means any lifecycle signal moved past baseline", () => {
    const baseline = { status: "idle", session: null, revision: null, paneRevision: 0 };
    expect(promptConsumed(baseline, baseline)).toBe(false);
    expect(promptConsumed(baseline, { ...baseline, status: "working" })).toBe(true);
    expect(promptConsumed(baseline, { ...baseline, session: "sess-1" })).toBe(true);
    expect(promptConsumed(baseline, { ...baseline, revision: 1 })).toBe(true);
    expect(promptConsumed(baseline, { ...baseline, paneRevision: 1 })).toBe(true);
  });
});

describe("confirmPromptDelivery", () => {
  async function capture(promise: Promise<unknown>): Promise<PromptDeliveryError> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof PromptDeliveryError) return error;
      throw error;
    }
    throw new Error("expected prompt delivery to fail");
  }

  test("a consumed prompt resolves with the observed lifecycle change", async () => {
    const fake = new FakeWorkspaces();
    await liveAgent(fake, "builder-sta-1");
    const out = await confirmPromptDelivery(fake, identity(), "work order text", FAST);
    expect(out.attempts).toBe(1);
    expect(out.lostResponse).toBe(false);
    expect(out.observed.paneRevision).toBe(1);
    expect(fake.calls.filter((c) => c.method === "agent.prompt")).toHaveLength(1);
  });

  test("STA-197/STA-222 input-buffer failure: agent_prompted without a lifecycle change never counts", async () => {
    const fake = new FakeWorkspaces();
    fake.promptMode = "input-buffer";
    await liveAgent(fake, "builder-sta-1");
    const error = await capture(confirmPromptDelivery(fake, identity(), "work order text", FAST));
    expect(error.reason).toBe("stalled");
    expect(error.attempts).toBe(2);
    // The diagnosis names project, ticket, role, stage, agent, and reason.
    for (const part of ["project=igniter", "ticket=STA-1", "role=builder", "stage=build", "agent=builder-sta-1", "stalled"]) {
      expect(error.message).toContain(part);
    }
    // Retry resends the identical work order to the same agent: no second
    // agent, no second pane, no second run.
    expect(fake.agents.filter((a) => a.name === "builder-sta-1")).toHaveLength(1);
    expect(fake.workspaces.filter((w) => !w.closed)).toHaveLength(1);
    const inbox = fake.promptsFor("builder-sta-1");
    expect(inbox).toHaveLength(2);
    expect(inbox[0]).toBe(inbox[1]);
    expect(error.key).toBe(deliveryKey(identity(), 0));
  });

  test("a lost response converges by read-back without resending", async () => {
    const fake = new FakeWorkspaces();
    fake.promptMode = "lost-response";
    await liveAgent(fake, "builder-sta-1");
    const out = await confirmPromptDelivery(fake, identity(), "work order text", FAST);
    expect(out.lostResponse).toBe(true);
    expect(out.attempts).toBe(1);
    expect(fake.calls.filter((c) => c.method === "agent.prompt")).toHaveLength(1);
    expect(fake.promptsFor("builder-sta-1")).toHaveLength(1);
  });

  test("an unreachable Herdr names the delivery instead of hanging", async () => {
    const fake = new FakeWorkspaces();
    await liveAgent(fake, "builder-sta-1");
    fake.failMethods.add("snapshot");
    const error = await capture(confirmPromptDelivery(fake, identity(), "work order text", FAST));
    expect(error.reason).toBe("herdr-unreachable");
    expect(error.attempts).toBe(0);
    expect(error.message).toContain("ticket=STA-1");
  });

  test("a missing agent refuses with no send", async () => {
    const fake = new FakeWorkspaces();
    const error = await capture(confirmPromptDelivery(fake, identity(), "work order text", FAST));
    expect(error.reason).toBe("no-agent");
    expect(error.attempts).toBe(0);
    expect(fake.calls.filter((c) => c.method === "agent.prompt")).toHaveLength(0);
  });

  test("a vanished agent reports no-agent instead of a stall", async () => {
    const fake = new FakeWorkspaces();
    await liveAgent(fake, "builder-sta-1");
    fake.agents = [];
    const error = await capture(confirmPromptDelivery(fake, identity(), "work order text", FAST));
    expect(error.reason).toBe("no-agent");
    expect(error.message).toContain("agent=builder-sta-1");
  });

  test("consumed advances only the pane revision; input-buffer moves nothing", async () => {
    const fake = new FakeWorkspaces();
    const { paneId } = await liveAgent(fake, "builder-sta-1");
    await fake.prompt("builder-sta-1", "hi");
    const agent = fake.agents.find((a) => a.name === "builder-sta-1")!;
    // The agent row is untouched, so wake-up dedup keys (session+revision)
    // stay stable; only the pane shows new output.
    expect(agent.agentStatus).toBe("working");
    expect(agent.session).toBeNull();
    expect(agent.revision).toBeNull();
    expect(fake.paneRevision[paneId]).toBe(1);
    fake.promptMode = "input-buffer";
    await fake.prompt("builder-sta-1", "hi again");
    expect(fake.paneRevision[paneId]).toBe(1);
    expect(fake.promptsFor("builder-sta-1")).toEqual(["hi", "hi again"]);
  });
});

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

async function harness(): Promise<Harness> {
  const world = standardWorld("test-key");
  const fake = startFakeLinear(world);
  const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url, fetchImpl: fake.fetchImpl });
  const resolved = await validateStartup(
    client,
    parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 3 }),
  );
  const lines: string[] = [];
  const workspaces = new FakeWorkspaces();
  const git = new FakeGit();
  git.head = HEAD;
  const repoRoot = join(mkdtempSync(join(tmpdir(), "igniter-delivery-")), "repo");
  const ctx: CommandContext = {
    client,
    resolved,
    decisions: {
      record: async (ticket, message) => {
        lines.push(`${ticket} ${message}`);
        // Mirror the production dispatch log (stdout plus dispatch.log):
        // a stalled or timed-out delivery must be observable outside the
        // test's own assertions.
        if (message.includes("prompt delivery")) console.log(`${ticket} ${message}`);
      },
    },
    workspaces,
    repoRoot,
    git,
    promptDelivery: FAST,
  };
  return { ctx, lines, workspaces, git, repoRoot, client, resolved, world, stop: () => fake.stop() };
}

describe("stage start", () => {
  test("an input-buffer prompt fails the start and keeps Todo+Pending", async () => {
    const h = await harness();
    try {
      h.workspaces.promptMode = "input-buffer";
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const out = await runCommand({ command: "worker.start", ticket: "STA-1" }, h.ctx);
      expect(out.ok).toBe(false);
      // The command returns project, ticket, role, stage, agent, and failure reason.
      const diagnosis = ["project=igniter", "ticket=STA-1", "role=builder", "stage=build", "agent=builder-sta-1", "stalled"];
      for (const part of diagnosis) {
        expect(out.text).toContain(part);
      }
      // Protocol state is untouched: Linear keeps Todo+Pending.
      expect(h.world.issues[0]!.stateId).toBe(TODO);
      expect(h.world.issues[0]!.labelIds).toEqual([PENDING]);
      expect(h.lines).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("a stalled retry creates nothing twice; a nudged worker finishes the start", async () => {
    const h = await harness();
    try {
      h.workspaces.promptMode = "input-buffer";
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      expect((await runCommand({ command: "worker.start", ticket: "STA-1" }, h.ctx)).ok).toBe(false);
      // The STA-197 observation: the agent sits idle with an empty context.
      h.workspaces.agents.find((a) => a.name === "builder-sta-1")!.agentStatus = "idle";
      // The nudge lands the prompt: the retry redelivers the byte-identical
      // work order to the same worker. Only the subsequent begin writes Linear.
      h.workspaces.promptMode = "consumed";
      const retry = await runCommand({ command: "worker.start", ticket: "STA-1" }, h.ctx);
      expect(retry.ok).toBe(true);
      expect(retry.text).toContain("work order confirmed");
      expect(h.workspaces.workspaces.filter((w) => !w.closed)).toHaveLength(1);
      expect(h.workspaces.agents.filter((a) => a.name === "builder-sta-1")).toHaveLength(1);
      const inbox = h.workspaces.promptsFor("builder-sta-1");
      // Two sends from the stalled first attempt plus one from the retry:
      // every send carries the byte-identical work order to the same worker.
      expect(inbox).toHaveLength(3);
      expect(new Set(inbox).size).toBe(1);
      expect(h.world.issues[0]!.stateId).toBe(TODO);
      expect((await runCommand({ command: "begin", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
      expect(h.world.issues[0]!.stateId).toBe(BUILD);
      expect(h.world.issues[0]!.labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("a consumed prompt confirms delivery before begin moves Linear", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const out = await runCommand({ command: "worker.start", ticket: "STA-1" }, h.ctx);
      expect(out.ok).toBe(true);
      expect(h.world.issues[0]!.stateId).toBe(TODO);
      expect((await runCommand({ command: "begin", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
      expect(h.world.issues[0]!.stateId).toBe(BUILD);
      expect(h.world.issues[0]!.labelIds).toEqual([IN_PROGRESS]);
      // The pane moved past the pre-send baseline: the prompt landed.
      const agent = h.workspaces.agents.find((a) => a.name === "builder-sta-1")!;
      expect(h.workspaces.paneRevision[agent.paneId]).toBe(1);
    } finally {
      h.stop();
    }
  });
});

describe("in-progress recovery", () => {
  function seedActive(h: Harness): void {
    addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
    h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1" });
  }

  test("an input-buffer recovery prompt fails without touching Linear", async () => {
    const h = await harness();
    try {
      seedActive(h);
      h.workspaces.promptMode = "input-buffer";
      const out = await runCommand({ command: "worker.start", ticket: "STA-1" }, h.ctx);
      expect(out.ok).toBe(false);
      for (const part of ["project=igniter", "ticket=STA-1", "role=builder", "stage=build", "agent=builder-sta-1", "stalled"]) {
        expect(out.text).toContain(part);
      }
      expect(h.world.issues[0]!.stateId).toBe(BUILD);
      expect(h.world.issues[0]!.labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("a consumed recovery rebuilds the worker with Linear kept", async () => {
    const h = await harness();
    try {
      seedActive(h);
      const out = await runCommand({ command: "worker.start", ticket: "STA-1" }, h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("confirmed");
      expect(h.workspaces.agents.find((a) => a.name === "builder-sta-1")).toBeDefined();
      expect(h.world.issues[0]!.stateId).toBe(BUILD);
      expect(h.world.issues[0]!.labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });
});

describe("stage start gate (the contract STA-225 reuses)", () => {
  /** The stage pattern: confirm first, enter In progress only after proof. */
  async function startStage(h: Harness, agent: string): Promise<boolean> {
    const order = "build work order for STA-2";
    try {
      await confirmPromptDelivery(
        h.workspaces,
        {
          project: "igniter",
          ticket: "STA-2",
          role: "builder",
          stage: "build",
          agent,
          workOrder: workOrderHash(order),
        },
        order,
        FAST,
      );
    } catch {
      return false;
    }
    expect((await runCommand({ command: "begin", ticket: "STA-2" }, h.ctx)).ok).toBe(true);
    return true;
  }

  function seedStage(h: Harness): void {
    addIssue(h.world, { identifier: "STA-2", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [PENDING] });
    h.workspaces.seedWorkspace("STA-2", { ticket: "STA-2", status: "build", progress: "pending" });
    const workspace = h.workspaces.workspaces.find((w) => w.label === "STA-2")!;
    const paneId = workspace.panes[0]!;
    h.workspaces.agents.push({
      name: "builder-sta-2",
      kind: "builder",
      agentStatus: "idle",
      workspaceId: workspace.workspaceId,
      paneId,
      session: null,
      revision: null,
      inbox: [],
    });
  }

  test("an input-buffer stage prompt keeps the ticket Pending", async () => {
    const h = await harness();
    try {
      seedStage(h);
      h.workspaces.promptMode = "input-buffer";
      expect(await startStage(h, "builder-sta-2")).toBe(false);
      expect(h.world.issues.find((i) => i.identifier === "STA-2")!.labelIds).toEqual([PENDING]);
    } finally {
      h.stop();
    }
  });

  test("a consumed stage prompt enters In progress exactly once", async () => {
    const h = await harness();
    try {
      seedStage(h);
      expect(await startStage(h, "builder-sta-2")).toBe(true);
      expect(h.world.issues.find((i) => i.identifier === "STA-2")!.labelIds).toEqual([IN_PROGRESS]);
      expect(h.workspaces.agents.filter((a) => a.name === "builder-sta-2")).toHaveLength(1);
    } finally {
      h.stop();
    }
  });
});
