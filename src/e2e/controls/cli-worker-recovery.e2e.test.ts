import { describe, expect, test } from "bun:test";
import { memoryAddIssue } from "../../workflow/service/linear/fake-memory-linear.ts";
import { E2E, CRITERIA, expectFail, expectOk } from "../support/fake-harness.ts";

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
      expectFail(await e2e.cli(["worker", "start", "STA-30"]), "worker start failed");
      let issue = e2e.world.issues.find((candidate) => candidate.identifier === "STA-30")!;
      expect(issue.stateId).toBe("st-todo");
      expect(issue.labelIds).toEqual(["label-pending"]);
      expect(e2e.workspaces.workspaces.filter((workspace) => !workspace.closed)).toHaveLength(1);
      expect(e2e.workspaces.agents).toHaveLength(0);

      expectOk(await e2e.startStage("STA-30"));
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
      expectFail(await e2e.cli(["worker", "start", "STA-31"]), "prompt delivery stalled");
      const worker = e2e.workspaces.agents.find((agent) => agent.name === "builder-sta-31")!;
      worker.agentStatus = "idle";
      e2e.workspaces.promptMode = "consumed";
      const recovered = expectOk(await e2e.cli(["worker", "start", "STA-31"]));
      expect(recovered.stdout).toContain("work order confirmed");
      expectOk(await e2e.cli(["begin", "STA-31"]));
      expect(e2e.workspaces.promptsFor("builder-sta-31")).toHaveLength(2);
      expect(new Set(e2e.workspaces.promptsFor("builder-sta-31")).size).toBe(1);
      expect(e2e.workspaces.agents.filter((agent) => agent.name === "builder-sta-31")).toHaveLength(1);
      const issue = e2e.world.issues.find((candidate) => candidate.identifier === "STA-31")!;
      expect(issue.stateId).toBe("st-build");
      expect(issue.labelIds).toEqual(["label-in-progress"]);
    });
  });

  test("a live In-progress worker is reused, never duplicated", async () => {
    await withE2E({}, async (e2e) => {
      addTodo(e2e, "STA-32");
      expectOk(await e2e.startStage("STA-32"));
      expectOk(await e2e.cli(["worker", "start", "STA-32"]));
      expect(e2e.workspaces.agents.filter((agent) => agent.name === "builder-sta-32")).toHaveLength(1);
      const issue = e2e.world.issues.find((candidate) => candidate.identifier === "STA-32")!;
      expect(issue.stateId).toBe("st-build");
      expect(issue.labelIds).toEqual(["label-in-progress"]);
    });
  });

  test("a missing In-progress worker is refused with no local side effects", async () => {
    await withE2E({}, async (e2e) => {
      addTodo(e2e, "STA-33");
      expectOk(await e2e.startStage("STA-33"));
      const workspace = e2e.workspaces.workspaces.find((candidate) => candidate.label === "STA-33")!;
      const panesBefore = workspace.panes.length;
      // Linear says In progress, but this machine no longer runs the worker:
      // another machine may own the ticket, so state alone must not adopt it.
      e2e.workspaces.agents = e2e.workspaces.agents.filter((agent) => agent.name !== "builder-sta-33");
      e2e.workspaces.calls = [];
      expectFail(await e2e.cli(["worker", "start", "STA-33"]), "does not adopt");
      expect(e2e.workspaces.calls).toEqual([]);
      expect(e2e.workspaces.workspaces).toHaveLength(1);
      expect(workspace.panes).toHaveLength(panesBefore);
      const issue = e2e.world.issues.find((candidate) => candidate.identifier === "STA-33")!;
      expect(issue.stateId).toBe("st-build");
      expect(issue.labelIds).toEqual(["label-in-progress"]);
    });
  });
});
