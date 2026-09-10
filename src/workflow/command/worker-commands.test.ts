import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workerCommand } from "./worker-commands.ts";
import { type CommandContext } from "./commands.ts";
import { validateStartup } from "../config/claims.ts";
import { parseDispatchConfig } from "../config/config.ts";
import { MemoryLinearClient, memoryAddIssue, standardMemoryWorld } from "../service/linear/fake-memory-linear.ts";
import { FakeWorkspaces } from "../testing/fake-workspaces.ts";
import { FakeGit } from "../testing/fake-git.ts";
import { ticketWorktree } from "../service/worktree/worktrees.ts";
import { receiptBlock } from "./ticket/protocol.ts";
import type { WorkerRequest } from "./command-request.ts";

async function setup(state = "st-todo", labels: string[] = []) {
  const world = standardMemoryWorld();
  const issue = memoryAddIssue(world, { identifier: "STA-244", stateId: state, labelIds: labels, description: "## Acceptance criteria\n- [ ] works\n" });
  const client = new MemoryLinearClient(world);
  const resolved = await validateStartup(client, parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 3 }));
  const workspaces = new FakeWorkspaces();
  const git = new FakeGit();
  const repoRoot = join(mkdtempSync(join(tmpdir(), "igniter-worker-")), "repo");
  const worktree = ticketWorktree(repoRoot, issue.identifier);
  git.worktreeList = `worktree ${worktree.path}\nbranch refs/heads/${worktree.branch}\n`;
  const ctx: CommandContext = {
    client, resolved, workspaces, git, repoRoot, decisions: { record: async () => {} },
    promptDelivery: { maxAttempts: 2, pollAttempts: 1, pollIntervalMs: 0, sleep: async () => {} },
  };
  client.calls = [];
  return { ctx, client, issue, workspaces, git, repoRoot };
}

function readsOnly(client: MemoryLinearClient) {
  expect(client.calls.every((c) => c.method === "fetchIssue")).toBe(true);
}

describe("worker command boundary", () => {
  test("bare Todo creates its stable named worker and titled tab, confirms delivery, and returns effective profile and result", async () => {
    const h = await setup();
    const out = await workerCommand({ command: "worker.start", ticket: "sta-244" }, h.ctx);
    expect(out.ok).toBe(true);
    expect(out.data).toMatchObject({ worker: "builder-sta-244", role: "build", model: h.ctx.resolved.config.commander.agents.builder.model, confirmed: true });
    expect(out.text).toContain("builder/result.md");
    expect(h.issue.stateId).toBe("st-todo");
    expect(h.issue.labelIds).toEqual([]);
    expect(h.workspaces.calls.find((c) => c.method === "tab.create")?.params["title"]).toBe("STA-244 build");
    readsOnly(h.client);
  });

  test("later start retries reuse one worker and one confirmed work order even after HEAD moves", async () => {
    const h = await setup();
    expect((await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    h.git.head = "defaced123";
    h.issue.stateId = "st-build";
    h.issue.labelIds = ["label-in-progress"];
    expect((await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    expect(h.workspaces.calls.filter((c) => c.method === "agent.start")).toHaveLength(1);
    expect(h.workspaces.calls.filter((c) => c.method === "agent.prompt")).toHaveLength(1);
    readsOnly(h.client);
  });

  test("start failure leaves Linear untouched and retries reuse the prepared tab", async () => {
    const h = await setup();
    h.workspaces.failNext("agent.start");
    expect((await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx)).ok).toBe(false);
    expect((await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    expect(h.workspaces.calls.filter((c) => c.method === "tab.create")).toHaveLength(1);
    expect(h.workspaces.agents).toHaveLength(1);
    readsOnly(h.client);
  });

  test("undelivered prompt fails without begin; retry sends the identical work order to the same worker", async () => {
    const h = await setup();
    h.workspaces.promptMode = "input-buffer";
    const failed = await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx);
    expect(failed.ok).toBe(false);
    expect(failed.text).toContain("stalled");
    h.workspaces.promptMode = "consumed";
    h.git.head = "changed123";
    expect((await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    expect(h.workspaces.agents).toHaveLength(1);
    expect(new Set(h.workspaces.promptsFor("builder-sta-244")).size).toBe(1);
    readsOnly(h.client);
  });

  test("prompt lost response converges and another command retry never redelivers", async () => {
    const h = await setup();
    h.workspaces.promptMode = "lost-response";
    expect((await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    expect((await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    expect(h.workspaces.calls.filter((c) => c.method === "agent.prompt")).toHaveLength(1);
    readsOnly(h.client);
  });

  test("workspace metadata failure recovers the initial workspace instead of duplicating it", async () => {
    const h = await setup();
    h.workspaces.failNext("workspace.report_metadata");
    expect((await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx)).ok).toBe(false);
    expect((await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    expect(h.workspaces.workspaces).toHaveLength(1);
    readsOnly(h.client);
  });

  test("restart performs a real rebuild with the effective model, preserves dirty work, and dedupes retries", async () => {
    const h = await setup();
    expect((await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    const oldPane = h.workspaces.agents[0]!.paneId;
    h.git.statusPorcelain = " M unfinished.ts";
    const request: WorkerRequest = {
      command: "worker.restart", ticket: "STA-244", harness: "codex", model: "gpt-5.6-sol", effort: "high",
    };
    const out = await workerCommand(request, h.ctx);
    expect(out.ok).toBe(true);
    expect(out.data).toMatchObject({ model: "gpt-5.6-sol", confirmed: true });
    expect(h.workspaces.agents[0]!.paneId).not.toBe(oldPane);
    const launch = h.workspaces.calls.filter((c) => c.method === "agent.start").at(-1)!;
    expect(launch.params).toMatchObject({ kind: "codex", args: ["-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="high"'] });
    expect((await workerCommand(request, h.ctx)).ok).toBe(true);
    expect(h.workspaces.calls.filter((c) => c.method === "agent.stop")).toHaveLength(1);
    expect(h.git.commands.every((c) => !["reset", "clean"].includes(c.args[0]!) && !(c.args[0] === "worktree" && c.args[1] === "remove"))).toBe(true);
    readsOnly(h.client);
  });

  test("restart validates an incompatible model before touching a live worker", async () => {
    const h = await setup();
    await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx);
    expect((await workerCommand({ command: "worker.restart", ticket: "STA-244", harness: "codex", model: "provider/model" }, h.ctx)).ok).toBe(false);
    expect(h.workspaces.calls.filter((c) => c.method === "agent.stop")).toHaveLength(0);
    readsOnly(h.client);
  });

  test("restart stop failure retries the saved effective profile and actual rebuild", async () => {
    const h = await setup();
    await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx);
    h.workspaces.failNext("agent.stop");
    const request: WorkerRequest = { command: "worker.restart", ticket: "STA-244", harness: "codex", model: "gpt-5.6-sol" };
    expect((await workerCommand(request, h.ctx)).ok).toBe(false);
    expect((await workerCommand(request, h.ctx)).ok).toBe(true);
    expect(h.workspaces.agents).toHaveLength(1);
    expect(h.workspaces.agents[0]!.kind).toBe("codex");
    readsOnly(h.client);
  });

  test("failed cross-harness stop keeps permission answers bound to the live old harness", async () => {
    const h = await setup();
    await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx);
    await workerCommand({ command: "worker.restart", ticket: "STA-244", harness: "claude", model: "sonnet" }, h.ctx);
    const oldPane = h.workspaces.agents[0]!.paneId;
    h.workspaces.failNext("agent.stop");
    const restart: WorkerRequest = { command: "worker.restart", ticket: "STA-244", harness: "codex", model: "gpt-5.6-sol" };
    expect((await workerCommand(restart, h.ctx)).ok).toBe(false);
    expect(h.workspaces.agents[0]!.paneId).toBe(oldPane);
    const reused = await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx);
    expect(reused.ok).toBe(true);
    expect(reused.data).toMatchObject({ model: "sonnet" });
    expect(h.workspaces.agents[0]!.paneId).toBe(oldPane);
    expect((await workerCommand({ command: "worker.answer", ticket: "STA-244", answer: "y" }, h.ctx)).ok).toBe(true);
    expect(h.workspaces.sentKeys.at(-1)?.keys).toEqual(["enter"]);
    expect((await workerCommand(restart, h.ctx)).ok).toBe(true);
    expect(h.workspaces.agents[0]!.paneId).not.toBe(oldPane);
    expect((await workerCommand({ command: "worker.answer", ticket: "STA-244", answer: "y" }, h.ctx)).ok).toBe(true);
    expect(h.workspaces.sentKeys.at(-1)?.keys).toEqual(["y"]);
    readsOnly(h.client);
  });

  test("restart launch and prompt failures retry the intended model without another rebuild", async () => {
    for (const failure of ["agent.start", "input-buffer"]) {
      const h = await setup();
      await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx);
      if (failure === "agent.start") h.workspaces.failNext(failure);
      else h.workspaces.promptMode = "input-buffer";
      const request: WorkerRequest = { command: "worker.restart", ticket: "STA-244", harness: "codex", model: "gpt-5.6-sol" };
      expect((await workerCommand(request, h.ctx)).ok).toBe(false);
      h.workspaces.promptMode = "consumed";
      expect((await workerCommand(request, h.ctx)).ok).toBe(true);
      expect(h.workspaces.calls.filter((c) => c.method === "agent.stop")).toHaveLength(1);
      expect(h.workspaces.agents).toHaveLength(1);
      expect(h.workspaces.agents[0]!.kind).toBe("codex");
      readsOnly(h.client);
    }
  });

  test("a session created by the first prompt is retained as its delivery confirmation", async () => {
    const h = await setup();
    const prompt = h.workspaces.prompt.bind(h.workspaces);
    h.workspaces.prompt = async (worker, text) => {
      await prompt(worker, text);
      h.workspaces.agents.find((a) => a.name === worker)!.session = "created-session";
    };
    expect((await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    expect((await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    expect(h.workspaces.calls.filter((c) => c.method === "agent.prompt")).toHaveLength(1);
    readsOnly(h.client);
  });

  test("Done cleanup is explicit, validates receipt, and retains dirty work after stopping workers", async () => {
    const h = await setup();
    await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx);
    h.issue.stateId = "st-done";
    h.issue.labelIds = [];
    expect((await workerCommand({ command: "worker.stop", ticket: "STA-244" }, h.ctx)).ok).toBe(false);
    expect(h.workspaces.workspaces[0]!.closed).toBe(false);
    h.issue.comments.push({ id: "delivery", body: receiptBlock("deliver", h.git.head, "delivered244", h.git.head), createdAt: "2026-09-09T00:00:00Z" });
    h.git.statusPorcelain = " M unfinished.ts";
    const out = await workerCommand({ command: "worker.stop", ticket: "STA-244" }, h.ctx);
    expect(out.ok).toBe(false);
    expect(out.text).toContain("uncommitted changes");
    expect(h.workspaces.workspaces[0]!.closed).toBe(false);
    expect(h.workspaces.agents).toHaveLength(0);
    expect(h.git.commands.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(false);
    readsOnly(h.client);
  });

  test("Done cleanup preserves extra user panes and their checkout", async () => {
    const h = await setup();
    await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx);
    const workspace = h.workspaces.workspaces[0]!;
    await h.workspaces.createTab({ workspaceId: workspace.workspaceId, title: "user shell" });
    const userPane = workspace.panes.at(-1)!;
    h.issue.stateId = "st-done";
    h.issue.labelIds = [];
    h.issue.comments.push({ id: "delivery", body: receiptBlock("deliver", h.git.head, "delivered244", h.git.head), createdAt: "2026-09-09T00:00:00Z" });
    const beforeGit = h.git.commands.length;
    const result = await workerCommand({ command: "worker.stop", ticket: "STA-244" }, h.ctx);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("non-workflow panes remain");
    expect(workspace.closed).toBe(false);
    expect(workspace.panes).toContain(userPane);
    expect(h.workspaces.agents).toHaveLength(0);
    expect(h.git.commands).toHaveLength(beforeGit);
    readsOnly(h.client);
  });

  test("Done cleanup refuses an invalid landed receipt before touching worker panes", async () => {
    const h = await setup();
    await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx);
    h.issue.stateId = "st-done";
    h.issue.labelIds = [];
    h.issue.comments.push({ id: "invalid", body: receiptBlock("deliver", h.git.head, "invalid244", "--help"), createdAt: "2026-09-09T00:00:00Z" });
    h.workspaces.calls = [];
    h.git.commands = [];
    expect((await workerCommand({ command: "worker.stop", ticket: "STA-244" }, h.ctx)).ok).toBe(false);
    expect(h.workspaces.calls).toEqual([]);
    expect(h.git.commands).toEqual([]);
    expect(h.workspaces.agents).toHaveLength(1);
  });

  test.each(["missing-progress", "conflicting-progress", "canceled"])("existing workers remain controllable when Linear is %s", async (condition) => {
    const h = await setup();
    await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx);
    if (condition === "missing-progress") {
      h.issue.stateId = "st-build";
      h.issue.labelIds = [];
    }
    else if (condition === "conflicting-progress") {
      h.issue.stateId = "st-build";
      h.issue.labelIds = ["label-pending", "label-blocked"];
    } else h.issue.stateId = "st-canceled";
    expect((await workerCommand({ command: "worker.send", ticket: "STA-244", role: "build", text: "keep existing work" }, h.ctx)).ok).toBe(true);
    expect((await workerCommand({ command: "worker.answer", ticket: "STA-244", role: "build", answer: "n" }, h.ctx)).ok).toBe(true);
    expect((await workerCommand({ command: "worker.stop", ticket: "STA-244", role: "build" }, h.ctx)).ok).toBe(true);
    expect(h.workspaces.agents).toHaveLength(0);
    expect((await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx)).ok).toBe(false);
    readsOnly(h.client);
  });

  test("same-ticket multiple roles require explicit targeting for send, answer, restart and stop", async () => {
    const h = await setup();
    await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx);
    h.issue.stateId = "st-review";
    h.issue.labelIds = ["label-pending"];
    expect((await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    const requests: WorkerRequest[] = [
      { command: "worker.send", ticket: "STA-244", text: "hello" },
      { command: "worker.answer", ticket: "STA-244", answer: "y" },
      { command: "worker.restart", ticket: "STA-244" },
      { command: "worker.stop", ticket: "STA-244" },
    ];
    for (const request of requests) {
      const out = await workerCommand(request, h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("multiple workers");
    }
    expect((await workerCommand({ command: "worker.send", ticket: "STA-244", role: "build", text: "keep work" }, h.ctx)).ok).toBe(true);
    expect(h.workspaces.promptsFor("builder-sta-244").at(-1)).toBe("keep work");
    expect((await workerCommand({ command: "worker.answer", ticket: "STA-244", role: "review", answer: "n" }, h.ctx)).ok).toBe(true);
    expect((await workerCommand({ command: "worker.stop", ticket: "STA-244", role: "build" }, h.ctx)).ok).toBe(true);
    expect(h.workspaces.agents.map((a) => a.name)).toEqual(["reviewer-sta-244"]);
    readsOnly(h.client);
  });

  test("answer uses frozen effective harness after model switch and refuses a changing pane", async () => {
    const h = await setup();
    await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx);
    await workerCommand({ command: "worker.restart", ticket: "STA-244", harness: "claude", model: "sonnet" }, h.ctx);
    expect((await workerCommand({ command: "worker.answer", ticket: "STA-244", answer: "y" }, h.ctx)).ok).toBe(true);
    expect(h.workspaces.sentKeys.at(-1)?.keys).toEqual(["enter"]);
    const read = h.workspaces.readPane.bind(h.workspaces);
    let revision = 0;
    h.workspaces.readPane = async (pane, lines) => ({ ...await read(pane, lines), revision: ++revision });
    expect((await workerCommand({ command: "worker.answer", ticket: "STA-244", answer: "y" }, h.ctx)).ok).toBe(false);
    expect(h.workspaces.sentKeys).toHaveLength(1);
    readsOnly(h.client);
  });

  test("blocked and complete stages cannot start or restart workers", async () => {
    for (const progress of ["label-blocked", "label-complete"]) {
      const h = await setup("st-build", [progress]);
      expect((await workerCommand({ command: "worker.start", ticket: "STA-244" }, h.ctx)).ok).toBe(false);
      expect((await workerCommand({ command: "worker.restart", ticket: "STA-244" }, h.ctx)).ok).toBe(false);
      expect(h.workspaces.calls.filter((c) => c.method === "agent.start")).toHaveLength(0);
      readsOnly(h.client);
    }
  });
});
