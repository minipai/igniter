import { describe, expect, test } from "bun:test";
import { memoryAddIssue } from "../dispatch/fake-memory-linear.ts";
import { parseReceiptBlock } from "../dispatch/protocol.ts";
import {
  E2E,
  CRITERIA,
  buildPayload,
  commitWorktreeFile,
  expectFail,
  expectOk,
} from "./fake-harness.ts";

async function withE2E(options: Parameters<typeof E2E.boot>[0], fn: (e2e: E2E) => Promise<void>): Promise<void> {
  const e2e = await E2E.boot(options);
  try {
    await fn(e2e);
  } finally {
    await e2e.close();
  }
}

function addTodo(e2e: E2E, identifier: string): void {
  memoryAddIssue(e2e.world, {
    identifier,
    stateId: "st-todo",
    description: CRITERIA,
    labelIds: ["label-pending"],
  });
}

describe("e2e begin worker recovery", () => {
  test("a Pending agent-start failure leaves Linear untouched and the next begin recovers", async () => {
    await withE2E({}, async (e2e) => {
      addTodo(e2e, "STA-30");
      e2e.workspaces.failNext("agent.start");
      expectFail(await e2e.cli(["begin", "STA-30"]), "begin failed");
      let issue = e2e.world.issues.find((candidate) => candidate.identifier === "STA-30")!;
      expect(issue.stateId).toBe("st-todo");
      expect(issue.labelIds).toEqual(["label-pending"]);
      expect(e2e.workspaces.workspaces.filter((workspace) => !workspace.closed)).toHaveLength(1);
      expect(e2e.workspaces.agents).toHaveLength(0);

      expectOk(await e2e.cli(["begin", "STA-30"]));
      issue = e2e.world.issues.find((candidate) => candidate.identifier === "STA-30")!;
      expect(issue.stateId).toBe("st-build");
      expect(issue.labelIds).toEqual(["label-in-progress"]);
      expect(e2e.workspaces.agents.filter((agent) => agent.name === "builder-sta-30")).toHaveLength(1);
    });
  });

  test("a prompt left in the input buffer stays Pending; an idle worker consumes the redelivery", async () => {
    await withE2E({}, async (e2e) => {
      addTodo(e2e, "STA-31");
      e2e.workspaces.promptMode = "input-buffer";
      expectFail(await e2e.cli(["begin", "STA-31"]), "prompt delivery stalled");
      const worker = e2e.workspaces.agents.find((agent) => agent.name === "builder-sta-31")!;
      worker.agentStatus = "idle";
      e2e.workspaces.promptMode = "consumed";
      const recovered = expectOk(await e2e.cli(["begin", "STA-31"]));
      expect(recovered.stdout).toContain("work order redelivered");
      expect(e2e.workspaces.promptsFor("builder-sta-31")).toHaveLength(2);
      expect(new Set(e2e.workspaces.promptsFor("builder-sta-31")).size).toBe(1);
      expect(e2e.workspaces.agents.filter((agent) => agent.name === "builder-sta-31")).toHaveLength(1);
      const issue = e2e.world.issues.find((candidate) => candidate.identifier === "STA-31")!;
      expect(issue.stateId).toBe("st-build");
      expect(issue.labelIds).toEqual(["label-in-progress"]);
    });
  });

  test("a live In-progress worker is not duplicated; a missing worker is rebuilt with the current order", async () => {
    await withE2E({}, async (e2e) => {
      addTodo(e2e, "STA-32");
      expectOk(await e2e.cli(["begin", "STA-32"]));
      expectFail(await e2e.cli(["begin", "STA-32"]), "already running");
      expect(e2e.workspaces.agents.filter((agent) => agent.name === "builder-sta-32")).toHaveLength(1);

      const at = e2e.workspaces.agents.findIndex((agent) => agent.name === "builder-sta-32");
      e2e.workspaces.agents.splice(at, 1);
      const recovered = expectOk(await e2e.cli(["begin", "STA-32"]));
      expect(recovered.stdout).toContain("recovered");
      expect(e2e.workspaces.agents.filter((agent) => agent.name === "builder-sta-32")).toHaveLength(1);
      expect(e2e.workspaces.promptsFor("builder-sta-32")[0]).toContain("STA-32");
      const issue = e2e.world.issues.find((candidate) => candidate.identifier === "STA-32")!;
      expect(issue.stateId).toBe("st-build");
      expect(issue.labelIds).toEqual(["label-in-progress"]);
    });
  });
});

describe("e2e serialized concurrent CLI", () => {
  test("parallel begins never exceed max_running or pollute the other ticket", async () => {
    await withE2E({ maxRunning: 1 }, async (e2e) => {
      addTodo(e2e, "STA-33");
      addTodo(e2e, "STA-34");
      const one = e2e.spawnCli(["begin", "STA-33"]);
      const two = e2e.spawnCli(["begin", "STA-34"]);
      const results = await Promise.all([one.done, two.done]);
      expect(results.filter((result) => result.code === 0)).toHaveLength(1);
      expect(results.filter((result) => result.code !== 0)).toHaveLength(1);
      expect(results.find((result) => result.code !== 0)?.stderr).toContain("at max_running (1)");

      const issues = e2e.world.issues.filter((issue) => issue.identifier === "STA-33" || issue.identifier === "STA-34");
      expect(issues.filter((issue) => issue.stateId === "st-build")).toHaveLength(1);
      expect(issues.filter((issue) => issue.stateId === "st-todo")).toHaveLength(1);
      expect(e2e.workspaces.workspaces.filter((workspace) => !workspace.closed)).toHaveLength(1);
      expect(e2e.workspaces.agents.filter((agent) => agent.name.startsWith("builder-sta-"))).toHaveLength(1);
    });
  });

  test("parallel begin of one ticket creates one workspace and one worker", async () => {
    await withE2E({}, async (e2e) => {
      addTodo(e2e, "STA-35");
      const calls = [e2e.spawnCli(["begin", "STA-35"]), e2e.spawnCli(["begin", "STA-35"])];
      const results = await Promise.all(calls.map((call) => call.done));
      expect(results.filter((result) => result.code === 0)).toHaveLength(1);
      expect(results.filter((result) => result.code !== 0)[0]?.stderr).toContain("already running");
      expect(e2e.workspaces.workspaces.filter((workspace) => !workspace.closed)).toHaveLength(1);
      expect(e2e.workspaces.agents.filter((agent) => agent.name === "builder-sta-35")).toHaveLength(1);
    });
  });

  test("parallel identical submits converge on one receipt", async () => {
    await withE2E({}, async (e2e) => {
      addTodo(e2e, "STA-36");
      expectOk(await e2e.cli(["begin", "STA-36"]));
      const head = commitWorktreeFile(e2e.repoDir, "STA-36", "work.txt", "parallel\n", "parallel work");
      const stdin = JSON.stringify(buildPayload(head));
      const calls = [
        e2e.spawnCli(["submit", "STA-36", "--input", "-"], { stdin }),
        e2e.spawnCli(["submit", "STA-36", "--input", "-"], { stdin }),
      ];
      const results = await Promise.all(calls.map((call) => call.done));
      expect(results.every((result) => result.code === 0)).toBe(true);
      expect(results.some((result) => result.stdout.includes("already submitted build"))).toBe(true);
      const issue = e2e.world.issues.find((candidate) => candidate.identifier === "STA-36")!;
      const receipts = issue.comments.filter((comment) => {
        try {
          return parseReceiptBlock(comment.body) !== null;
        } catch {
          return false;
        }
      });
      expect(receipts).toHaveLength(1);
      expect(issue.stateId).toBe("st-review");
      expect(issue.labelIds).toEqual(["label-pending"]);
    });
  });
});
