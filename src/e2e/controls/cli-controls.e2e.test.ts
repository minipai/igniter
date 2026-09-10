// CLI control contract through the real parser and command protocol. Linear
// is the stateful memory client and Herdr/agents are fakes owned by the temp
// fixture. No real credentials, provider, or project.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryAddIssue } from "../../workflow/service/linear/fake-memory-linear.ts";
import {
  E2E,
  CRITERIA,
  buildPayload,
  commitWorktreeFile,
  expectFail,
  expectOk,
  ownerHandoff,
} from "../support/fake-harness.ts";

async function withE2E(
  fn: (e2e: E2E) => Promise<void>,
  options: Parameters<typeof E2E.boot>[0] = {},
): Promise<void> {
  const e2e = await E2E.boot(options);
  try {
    await fn(e2e);
  } finally {
    await e2e.close();
  }
}

function progressNames(labels: { name: string }[] | undefined): string[] {
  return (labels ?? []).map((label) => label.name).sort();
}

describe("e2e CLI explicit ticket status", () => {
  test("ticket status uses Linear truth and removed workspace forms refuse without effects", async () => {
    await withE2E(async (e2e) => {
      memoryAddIssue(e2e.world, {
        identifier: "STA-20",
        title: "Control contract",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: ["label-pending"],
      });

      const begun = expectOk(await e2e.startStage("STA-20"));
      expect(begun.stdout).toContain("builder-sta-20");
      expect(begun.stderr).toBe("");
      const workspace = e2e.workspaces.workspaces.find((candidate) => candidate.label === "STA-20")!;
      const worktree = join(e2e.repoDir, ".igniter", "runtime", "worktrees", "sta-20");
      expect(
        e2e.workspaces.calls.find((call) => call.method === "workspace.create")?.params,
      ).toMatchObject({ cwd: worktree });

      const status = expectOk(await e2e.cli(["status", "STA-20", "--json"]));
      expect(status.stderr).toBe("");
      const statusJson = JSON.parse(status.stdout) as {
        ticket: { identifier: string; title: string; criteria: string[] };
        status: string;
        progress: string;
        next: string[];
        submit_schema: { kind: string; checkpoint: string };
      };
      expect(statusJson).toMatchObject({
        ticket: { identifier: "STA-20", title: "Control contract", criteria: ["works"] },
        status: "build",
        progress: "in_progress",
        next: ["submit", "block"],
        submit_schema: { kind: "build", checkpoint: "<worktree HEAD>" },
      });

      const callsBefore = e2e.client.calls.length;
      const workerCallsBefore = e2e.workspaces.calls.length;
      for (const env of [{}, { HERDR_ENV: "1", HERDR_WORKSPACE_ID: workspace.workspaceId }] as Record<string, string>[]) {
        const removed = await e2e.cli(["state", "--json"], { env });
        expectFail(removed, "Unknown command: state");
        for (const argv of [["begin"], ["submit", "--input", "-"], ["block", "--reason", "waiting"], ["unblock"]]) {
          expectFail(await e2e.cli(argv, { env }), `missing required args for command \`${argv[0]} <ticket>\``);
        }
      }
      expect(e2e.client.calls).toHaveLength(callsBefore);
      expect(e2e.workspaces.calls).toHaveLength(workerCallsBefore);
      const inside = expectOk(await e2e.cli(["status", "STA-20", "--json"], {
        env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "unrelated-workspace" },
      }));
      expect(JSON.parse(inside.stdout)).toEqual(statusJson);
    });
  });
});

describe("e2e CLI removed controls and blockers", () => {
  test("removed pause and resume commands preserve ticket and worker state", async () => {
    await withE2E(async (e2e) => {
      memoryAddIssue(e2e.world, {
        identifier: "STA-21",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: ["label-pending"],
      });
      expectOk(await e2e.startStage("STA-21"));
      const callsBefore = e2e.workspaces.calls.length;
      const writesBefore = e2e.client.calls.filter((call) => call.method === "setIssueState" || call.method === "setIssueLabels").length;
      for (const command of ["pause", "resume"]) {
        expectFail(await e2e.cli([command, "STA-21"]), `Unknown command: ${command}`);
      }
      const issue = (await e2e.client.fetchIssue("STA-21"))!;
      expect(issue.state.name).toBe("Build");
      expect(progressNames(issue.labels)).toEqual(["In progress"]);
      expect(e2e.workspaces.tokensFor("STA-21")).not.toHaveProperty("paused");
      expect(e2e.workspaces.calls).toHaveLength(callsBefore);
      expect(e2e.client.calls.filter((call) => call.method === "setIssueState" || call.method === "setIssueLabels")).toHaveLength(writesBefore);
    });
  });

  test("explicit block and unblock preserve the stage and expose their CLI contract", async () => {
    await withE2E(async (e2e) => {
      memoryAddIssue(e2e.world, {
        identifier: "STA-22",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: ["label-pending"],
      });
      expectOk(await e2e.startStage("STA-22"));
      const workerEffectsBefore = e2e.workspaces.calls.filter((call) => !["workspace.list", "snapshot"].includes(call.method));

      const blocked = expectOk(
        await e2e.cli(["block", "STA-22", "--reason", "waiting for owner input"]),
      );
      expect(blocked.stdout).toContain("blocked STA-22: waiting for owner input");
      expect(blocked.stderr).toBe("");
      let issue = (await e2e.client.fetchIssue("STA-22"))!;
      expect(issue.state.name).toBe("Build");
      expect(progressNames(issue.labels)).toEqual(["Blocked"]);

      const unblocked = expectOk(await e2e.cli(["unblock", "STA-22"]));
      expect(unblocked.stdout).toContain("unblocked STA-22: back to pending");
      expect(unblocked.stdout).toContain("igniter begin STA-22");
      expect(unblocked.stderr).toBe("");
      issue = (await e2e.client.fetchIssue("STA-22"))!;
      expect(issue.state.name).toBe("Build");
      expect(progressNames(issue.labels)).toEqual(["Pending"]);
      expect(e2e.workspaces.tokensFor("STA-22")).not.toHaveProperty("block_reason");
      expect(e2e.workspaces.calls.filter((call) => !["workspace.list", "snapshot"].includes(call.method))).toEqual(workerEffectsBefore);
    });
  });
});

describe("e2e CLI recovery controls", () => {
  test("worker restart changes the real model; fail leaves worker cleanup explicit", async () => {
    await withE2E(async (e2e) => {
      memoryAddIssue(e2e.world, {
        identifier: "STA-23",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: ["label-pending"],
      });
      expectOk(await e2e.startStage("STA-23"));
      const original = e2e.workspaces.agents.find((agent) => agent.name === "builder-sta-23")!;
      const originalPane = original.paneId;
      const writesBefore = e2e.client.calls.filter((call) => call.method === "setIssueState" || call.method === "setIssueLabels").length;

      const restarted = expectOk(
        await e2e.cli(["worker", "restart", "STA-23", "--model", "gpt-5.6-sol"]),
      );
      expect(restarted.stdout).toContain("model gpt-5.6-sol; work order confirmed");
      expect(restarted.stderr).toBe("");
      expect(e2e.workspaces.agents.find((agent) => agent.name === "builder-sta-23")!.paneId).not.toBe(originalPane);
      expect(e2e.client.calls.filter((call) => call.method === "setIssueState" || call.method === "setIssueLabels")).toHaveLength(writesBefore);

      const failed = expectOk(
        await e2e.cli(["fail", "STA-23", "--reason", "worker could not recover"]),
      );
      expect(failed.stdout).toContain("failed STA-23: worker could not recover");
      expect(failed.stderr).toBe("");
      const issue = (await e2e.client.fetchIssue("STA-23"))!;
      expect(issue.state.name).toBe("Backlog");
      expect(progressNames(issue.labels)).toEqual(["agent-failed"]);
      expect(issue.comments.at(-1)?.body).toContain("<!-- igniter:failed -->");
      expect(issue.comments.at(-1)?.body).toContain("worker could not recover");
      expect(e2e.workspaces.workspaces.find((workspace) => workspace.label === "STA-23")?.closed).not.toBe(true);
      expectOk(await e2e.cli(["worker", "stop", "STA-23", "--role", "build"]));
      expect(e2e.workspaces.workspaces.find((workspace) => workspace.label === "STA-23")?.closed).not.toBe(true);
    });
  });
});

describe("e2e CLI permission answers", () => {
  test("answer y/n targets the current stage worker using each stage harness keys", async () => {
    await withE2E(async (e2e) => {
      memoryAddIssue(e2e.world, {
        identifier: "STA-24",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: ["label-pending"],
      });
      expectOk(await e2e.startStage("STA-24"));
      const builder = e2e.workspaces.agents.find((agent) => agent.name === "builder-sta-24")!;
      expect(builder.kind).toBe("opencode");

      const allowed = expectOk(await e2e.cli(["worker", "answer", "STA-24", "--role", "build", "y"]));
      expect(allowed.stdout).toContain("answered y for builder-sta-24");
      expect(allowed.stderr).toBe("");
      expect(e2e.workspaces.sentKeys.at(-1)).toEqual({ paneId: builder.paneId, keys: ["y"] });

      const head = commitWorktreeFile(e2e.repoDir, "STA-24", "answer.txt", "mixed harness\n", "answer fixture");
      const submitted = expectOk(
        await e2e.cli(["submit", "STA-24", "--input", "-"], {
          stdin: JSON.stringify(buildPayload(head)),
        }),
      );
      expect(submitted.stdout).toContain(`submitted build ${head} → Build+Complete`);
      expect(submitted.stderr).toBe("");
      await ownerHandoff(e2e, "STA-24");
      expectOk(await e2e.startStage("STA-24"));
      const reviewer = e2e.workspaces.agents.find((agent) => agent.name === "reviewer-sta-24")!;
      expect(reviewer.kind).toBe("claude");
      expect(reviewer.paneId).not.toBe(builder.paneId);

      const denied = expectOk(await e2e.cli(["worker", "answer", "STA-24", "--role", "review", "n"]));
      expect(denied.stdout).toContain("answered n for reviewer-sta-24");
      expect(denied.stderr).toBe("");
      expect(e2e.workspaces.sentKeys.at(-1)).toEqual({ paneId: reviewer.paneId, keys: ["esc"] });
    }, {
      config: {
        agents: {
          builder: { harness: "opencode", model: "opencode-go/deepseek-v4-flash" },
          reviewer: { harness: "claude", model: "claude-sonnet-5" },
        },
      },
    });
  });
});

describe("e2e CLI foreground start", () => {
  test("start runs the fake Commander in project context", async () => {
    await withE2E(async (e2e) => {
      const marker = join(e2e.repoDir, "fake-commander-started");
      e2e.stubForegroundAgent("codex", marker);

      const started = expectOk(await e2e.cli(["start"], { stdin: "" }));
      expect(started.stdout).toContain("starting Commander with codex in the current terminal");
      expect(started.stdout).toContain("patrolling queue and active tickets");
      expect(started.stderr).toBe("");
      expect(await Bun.file(marker).exists()).toBe(true);
      const args = readFileSync(`${marker}.args`, "utf8");
      expect(args).toContain("-m\ngpt-5.6-sol\n");
      expect(args).toContain('model_reasoning_effort="high"');
      expect(args).toContain("Begin with `igniter status --json`");
      const env = readFileSync(`${marker}.env`, "utf8");
      expect(env).toContain(`PWD=${e2e.repoDir}`);
      expect(env).toContain("LINEAR_API_KEY=e2e-fake-key");
      expect(env).toContain("HERDR_ENV=0");
      expect(e2e.workspaces.workspaces).toHaveLength(0);
      expect(e2e.workspaces.calls).toHaveLength(0);
    });
  });
});
