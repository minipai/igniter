// CLI control contract through the real dispatch HTTP service. The CLI runs
// as a subprocess; Linear is the stateful memory client and Herdr/agents are
// fakes owned by the temp fixture. No real credentials, provider, or project.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryAddIssue } from "../dispatch/fake-memory-linear.ts";
import {
  E2E,
  CRITERIA,
  buildPayload,
  commitWorktreeFile,
  expectFail,
  expectOk,
} from "./fake-harness.ts";

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

describe("e2e CLI status and workspace state", () => {
  test("ticket status and state --json use Linear truth plus the calling Herdr workspace", async () => {
    await withE2E(async (e2e) => {
      memoryAddIssue(e2e.world, {
        identifier: "STA-20",
        title: "Control contract",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: ["label-pending"],
      });

      const begun = expectOk(await e2e.cli(["begin", "STA-20"]));
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

      const outside = await e2e.cli(["state", "--json"]);
      expectFail(outside, "runs inside a Herdr workspace only");
      expect(outside.stdout).toBe("");
      expect(outside.stderr).toContain("HERDR_ENV=1");

      const state = expectOk(
        await e2e.cli(["state", "--json"], {
          env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: workspace.workspaceId },
        }),
      );
      expect(state.stderr).toBe("");
      const stateJson = JSON.parse(state.stdout) as typeof statusJson & { checkpoint: string | null };
      expect(stateJson).toMatchObject({
        ticket: { identifier: "STA-20", title: "Control contract", criteria: ["works"] },
        status: "build",
        progress: "in_progress",
        checkpoint: null,
        next: ["submit", "block"],
      });
    });
  });
});

describe("e2e CLI pause, resume, block, and unblock", () => {
  test("pause and resume converge through Pending without launching another worker", async () => {
    await withE2E(async (e2e) => {
      memoryAddIssue(e2e.world, {
        identifier: "STA-21",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: ["label-pending"],
      });
      expectOk(await e2e.cli(["begin", "STA-21"]));
      const startsBefore = e2e.workspaces.calls.filter((call) => call.method === "agent.start").length;

      const paused = expectOk(await e2e.cli(["pause", "STA-21"]));
      expect(paused.stdout).toContain("paused STA-21");
      expect(paused.stderr).toBe("");
      let issue = (await e2e.client.fetchIssue("STA-21"))!;
      expect(issue.state.name).toBe("Build");
      expect(progressNames(issue.labels)).toEqual(["Blocked"]);
      expect(e2e.workspaces.tokensFor("STA-21")).toMatchObject({
        paused: "1",
        block_reason: "owner pause",
      });
      expect(e2e.workspaces.promptsFor("builder-sta-21").at(-1)).toContain("owner paused this ticket");

      const resumed = expectOk(await e2e.cli(["resume", "STA-21"]));
      expect(resumed.stdout).toContain("back to pending");
      expect(resumed.stdout).toContain("igniter begin STA-21");
      expect(resumed.stderr).toBe("");
      issue = (await e2e.client.fetchIssue("STA-21"))!;
      expect(progressNames(issue.labels)).toEqual(["Pending"]);
      expect(e2e.workspaces.tokensFor("STA-21")).not.toHaveProperty("paused");
      expect(e2e.workspaces.tokensFor("STA-21")).not.toHaveProperty("block_reason");
      expect(e2e.workspaces.calls.filter((call) => call.method === "agent.start")).toHaveLength(startsBefore);
      expect(e2e.workspaces.calls.filter((call) => call.method === "tab.create")).toHaveLength(0);
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
      expectOk(await e2e.cli(["begin", "STA-22"]));

      const blocked = expectOk(
        await e2e.cli(["block", "STA-22", "--reason", "waiting for owner input"]),
      );
      expect(blocked.stdout).toContain("blocked STA-22: waiting for owner input");
      expect(blocked.stderr).toBe("");
      let issue = (await e2e.client.fetchIssue("STA-22"))!;
      expect(issue.state.name).toBe("Build");
      expect(progressNames(issue.labels)).toEqual(["Blocked"]);
      expect(e2e.workspaces.tokensFor("STA-22")).toMatchObject({
        block_reason: "waiting for owner input",
      });

      const unblocked = expectOk(await e2e.cli(["unblock", "STA-22"]));
      expect(unblocked.stdout).toContain("unblocked STA-22: back to pending");
      expect(unblocked.stdout).toContain("igniter begin STA-22");
      expect(unblocked.stderr).toBe("");
      issue = (await e2e.client.fetchIssue("STA-22"))!;
      expect(issue.state.name).toBe("Build");
      expect(progressNames(issue.labels)).toEqual(["Pending"]);
      expect(e2e.workspaces.tokensFor("STA-22")).not.toHaveProperty("block_reason");
    });
  });
});

describe("e2e CLI recovery controls", () => {
  test("restart records the builder model and fail closes the owned workspace", async () => {
    await withE2E(async (e2e) => {
      memoryAddIssue(e2e.world, {
        identifier: "STA-23",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: ["label-pending"],
      });
      expectOk(await e2e.cli(["begin", "STA-23"]));

      const restarted = expectOk(
        await e2e.cli(["restart", "STA-23", "--builder", "openai/gpt-5.6-sol"]),
      );
      expect(restarted.stdout).toContain("restarted STA-23 with builder openai/gpt-5.6-sol");
      expect(restarted.stderr).toBe("");
      expect(e2e.workspaces.tokensFor("STA-23")).toMatchObject({ builder: "openai/gpt-5.6-sol" });
      expect(e2e.workspaces.promptsFor("builder-sta-23").at(-1)).toContain(
        "restart the Builder with model openai/gpt-5.6-sol",
      );
      expect(e2e.workspaces.promptsFor("builder-sta-23").at(-1)).toContain("read `git diff` first");

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
      expect(e2e.workspaces.workspaces.find((workspace) => workspace.label === "STA-23")?.closed).toBe(true);
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
      expectOk(await e2e.cli(["begin", "STA-24"]));
      const builder = e2e.workspaces.agents.find((agent) => agent.name === "builder-sta-24")!;
      expect(builder.kind).toBe("opencode");

      const allowed = expectOk(await e2e.cli(["answer", "STA-24", "y"]));
      expect(allowed.stdout).toContain("answered y for STA-24 (allowed once, sent y)");
      expect(allowed.stderr).toBe("");
      expect(e2e.workspaces.sentKeys.at(-1)).toEqual({ paneId: builder.paneId, keys: ["y"] });

      const head = commitWorktreeFile(e2e.repoDir, "STA-24", "answer.txt", "mixed harness\n", "answer fixture");
      const submitted = expectOk(
        await e2e.cli(["submit", "STA-24", "--input", "-"], {
          stdin: JSON.stringify(buildPayload(head)),
        }),
      );
      expect(submitted.stdout).toContain(`submitted build ${head} → Review+Pending`);
      expect(submitted.stderr).toBe("");
      expectOk(await e2e.cli(["begin", "STA-24"]));
      const reviewer = e2e.workspaces.agents.find((agent) => agent.name === "reviewer-sta-24")!;
      expect(reviewer.kind).toBe("claude");
      expect(reviewer.paneId).not.toBe(builder.paneId);

      const denied = expectOk(await e2e.cli(["answer", "STA-24", "n"]));
      expect(denied.stdout).toContain("answered n for STA-24 (denied, sent esc)");
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
  test("start connects to the existing service and runs the fake Commander in project context", async () => {
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
