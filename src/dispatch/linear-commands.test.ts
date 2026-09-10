// Linear mutation boundaries use an in-memory client and no Worker workspace.
import { describe, expect, test } from "bun:test";
import { validateStartup } from "./claims.ts";
import { runCommand, type CommandContext } from "./commands.ts";
import { parseDispatchConfig } from "./config.ts";
import { MemoryLinearClient, memoryAddIssue, standardMemoryWorld } from "./fake-memory-linear.ts";
import { FakeWorkspaces } from "./fake-workspaces.ts";
import { FakeGit } from "./fake-git.ts";
import { receiptBlock } from "./protocol.ts";

const HEAD = "abcdef1234567890";
const PRIOR = "fedcba1234567890";
const build = (checkpoint = HEAD) => ({
  v: 1, kind: "build", checkpoint, checks: ["bun run check"],
  results: [{ criterion: "works", ok: true }], reproduction: "run the deterministic test",
});
const review = (verdict: "pass" | "fail") => ({
  v: 1, kind: "review", checkpoint: HEAD, verdict,
  environment: "deterministic fake", reproduction: "run the deterministic test",
  results: [{ criterion: "works", expected: "works", actual: verdict === "pass" ? "works" : "broken", evidence: "https://example.test/proof", ok: verdict === "pass" }],
});
const failure = { status: 502, message: "injected failure", afterWrite: false };

async function fixture(stage = "build", comments: { id: string; body: string }[] = []) {
  const world = standardMemoryWorld();
  const issue = memoryAddIssue(world, {
    identifier: "STA-244", stateId: `st-${stage}`, labelIds: ["label-in-progress"],
    description: "## Acceptance criteria\n- [ ] works\n", comments,
  });
  const client = new MemoryLinearClient(world);
  const resolved = await validateStartup(client, parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 2 }));
  const workspaces = new FakeWorkspaces();
  workspaces.failMethods.add("snapshot");
  workspaces.failMethods.add("workspace.report_metadata");
  const git = new FakeGit();
  git.head = HEAD;
  git.ancestors.add(`${HEAD} main`);
  const ctx: CommandContext = {
    client, resolved, workspaces, git, repoRoot: "/fake/sta-244",
    decisions: { record: async () => {} },
  };
  client.calls = [];
  return { ctx, issue, client, workspaces, git };
}

const submit = (ctx: CommandContext, payload: unknown) => runCommand({ command: "submit", ticket: "STA-244", payload }, ctx);
const noWorkers = (workspaces: FakeWorkspaces) => {
  expect(workspaces.calls).toEqual([]);
  expect(workspaces.snapshotCalls).toBe(0);
};

describe("Linear mutations without Worker dependencies", () => {
  test("Build submit and duplicate retry succeed without a workspace or reachable Herdr", async () => {
    const h = await fixture();
    expect((await submit(h.ctx, build())).ok).toBe(true);
    expect(h.issue.stateId).toBe("st-build");
    expect(h.issue.labelIds).toEqual(["label-complete"]);
    h.client.calls = [];
    expect((await submit(h.ctx, build())).text).toContain("already submitted");
    expect(h.client.calls.every((call) => call.method === "fetchIssue")).toBe(true);
    noWorkers(h.workspaces);
  });

  test.each(["pass", "fail"] as const)("Review %s submits receipt and transitions without Herdr", async (verdict) => {
    const h = await fixture("review", [{ id: "build", body: receiptBlock("build", HEAD, "initial") }]);
    expect((await submit(h.ctx, review(verdict))).ok).toBe(true);
    expect(h.issue.stateId).toBe(verdict === "pass" ? "st-review" : "st-build");
    expect(h.issue.labelIds).toEqual([verdict === "pass" ? "label-complete" : "label-pending"]);
    noWorkers(h.workspaces);
  });

  test("Deliver submit validates its checkpoint and reaches Complete without worker cleanup", async () => {
    const h = await fixture("deliver", [
      { id: "build", body: receiptBlock("build", HEAD, "initial") },
      { id: "review", body: receiptBlock("review-pass", HEAD, "passed") },
    ]);
    const result = await submit(h.ctx, { v: 1, kind: "deliver", checkpoint: HEAD, landed: HEAD, lineage: "checkpoint landed", merge_ready: true, owner_actions: ["approve Done"] });
    expect(result.ok).toBe(true);
    expect(h.issue.labelIds).toEqual(["label-complete"]);
    noWorkers(h.workspaces);
  });

  test("block and unblock retain their stage while Herdr is unavailable", async () => {
    const h = await fixture();
    expect((await runCommand({ command: "block", ticket: "STA-244", reason: "waiting for input" }, h.ctx)).ok).toBe(true);
    expect(h.issue.labelIds).toEqual(["label-blocked"]);
    expect((await runCommand({ command: "unblock", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    expect(h.issue.labelIds).toEqual(["label-pending"]);
    expect(h.issue.stateId).toBe("st-build");
    noWorkers(h.workspaces);
  });

  test("begin records one receipt-bound stage boundary before a failing state write and resumes from Linear", async () => {
    const h = await fixture("todo");
    h.issue.labelIds = ["label-pending"];
    h.client.failNext("setIssueState", failure);
    expect((await runCommand({ command: "begin", ticket: "STA-244" }, h.ctx)).ok).toBe(false);
    expect(h.issue.comments.filter((comment) => comment.body.includes("igniter:begin"))).toHaveLength(1);
    expect(h.issue.labelIds).toEqual(["label-pending"]);
    const restarted = { ...h.ctx, client: new MemoryLinearClient(h.client.world) };
    expect((await runCommand({ command: "begin", ticket: "STA-244" }, restarted)).ok).toBe(true);
    expect(h.issue.comments.filter((comment) => comment.body.includes("igniter:begin"))).toHaveLength(1);
    expect(h.issue.labelIds).toEqual(["label-in-progress"]);
    noWorkers(h.workspaces);
  });

  test("a lost begin-comment response converges without duplicate stage markers", async () => {
    const h = await fixture();
    h.issue.labelIds = ["label-pending"];
    h.client.failNext("addComment", { ...failure, afterWrite: true });
    expect((await runCommand({ command: "begin", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    expect((await runCommand({ command: "begin", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    expect(h.issue.comments.filter((comment) => comment.body.includes("igniter:begin"))).toHaveLength(1);
    noWorkers(h.workspaces);
  });

  test("duplicate begin after a receipt-only partial submit does not prevent retry completion", async () => {
    const h = await fixture();
    h.client.failNext("setIssueLabels", failure);
    expect((await submit(h.ctx, build())).ok).toBe(false);
    expect(h.issue.labelIds).toEqual(["label-in-progress"]);
    expect((await runCommand({ command: "begin", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    expect(h.issue.comments.some((comment) => comment.body.includes("igniter:begin"))).toBe(false);
    expect((await submit(h.ctx, build())).ok).toBe(true);
    expect(h.issue.labelIds).toEqual(["label-complete"]);
    noWorkers(h.workspaces);
  });

  test.each(["before-record", "after-record"])("begin preserves an external block %s", async (when) => {
    const h = await fixture();
    h.issue.labelIds = ["label-pending"];
    if (when === "before-record") {
      const fetch = h.client.fetchIssue.bind(h.client);
      let reads = 0;
      h.client.fetchIssue = async (id) => {
        if (++reads === 2) h.issue.labelIds = ["label-blocked"];
        return fetch(id);
      };
    } else {
      const add = h.client.addComment.bind(h.client);
      h.client.addComment = async (id, body) => {
        const result = await add(id, body);
        h.issue.labelIds = ["label-blocked"];
        return result;
      };
    }
    const result = await runCommand({ command: "begin", ticket: "STA-244" }, h.ctx);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("ticket moved");
    expect(h.issue.labelIds).toEqual(["label-blocked"]);
    expect(h.client.calls.some((call) => ["setIssueState", "setIssueLabels"].includes(call.method))).toBe(false);
    noWorkers(h.workspaces);
  });

  test.each(["review-fail", "correction-build"])("%s partial status/label failure resumes from receipt evidence alone", async (kind) => {
    const correction = kind === "correction-build";
    const h = await fixture(correction ? "build" : "review", [
      { id: "build", body: receiptBlock("build", correction ? PRIOR : HEAD, "initial") },
      ...(correction ? [{ id: "fail", body: receiptBlock("review-fail", PRIOR, "failed") }] : []),
    ]);
    const payload = correction ? build() : review("fail");
    h.client.failNext("setIssueLabels", failure);
    expect((await submit(h.ctx, payload)).ok).toBe(false);
    expect(h.issue.stateId).toBe(correction ? "st-review" : "st-build");
    expect(h.issue.labelIds).toEqual(["label-in-progress"]);
    const restarted = { ...h.ctx, client: new MemoryLinearClient(h.client.world) };
    expect((await submit(restarted, payload)).ok).toBe(true);
    expect(h.issue.labelIds).toEqual(["label-pending"]);
    noWorkers(h.workspaces);
  });

  test.each(["review-fail", "correction-build"])("stale %s retry cannot rewind a stage explicitly begun after partial failure", async (kind) => {
    const correction = kind === "correction-build";
    const h = await fixture(correction ? "build" : "review", [
      { id: "build", body: receiptBlock("build", correction ? PRIOR : HEAD, "initial") },
      ...(correction ? [{ id: "fail", body: receiptBlock("review-fail", PRIOR, "failed") }] : []),
    ]);
    const payload = correction ? build() : review("fail");
    h.client.failNext("setIssueLabels", failure);
    expect((await submit(h.ctx, payload)).ok).toBe(false);
    // An explicit reconciliation put the new stage back in Pending before its new start.
    h.issue.labelIds = ["label-pending"];
    expect((await runCommand({ command: "begin", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    const restarted = { ...h.ctx, client: new MemoryLinearClient(h.client.world) };
    const result = await submit(restarted, payload);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("already submitted");
    expect(h.issue.stateId).toBe(correction ? "st-review" : "st-build");
    expect(h.issue.labelIds).toEqual(["label-in-progress"]);
    expect(restarted.client.calls.every((call) => call.method === "fetchIssue")).toBe(true);
    noWorkers(h.workspaces);
  });

  test("same-stage stale Build retry after a later begin does not complete the new round", async () => {
    const h = await fixture();
    expect((await submit(h.ctx, build())).ok).toBe(true);
    h.issue.labelIds = ["label-pending"];
    expect((await runCommand({ command: "begin", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    h.client.calls = [];
    const result = await submit(h.ctx, build());
    expect(result.text).toContain("already submitted");
    expect(h.issue.labelIds).toEqual(["label-in-progress"]);
    expect(h.client.calls.every((call) => call.method === "fetchIssue")).toBe(true);
    noWorkers(h.workspaces);
  });
});
