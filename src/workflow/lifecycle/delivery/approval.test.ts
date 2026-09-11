import { describe, expect, test } from "bun:test";
import { validateStartup } from "../../config/claims.ts";
import { runCommand, type CommandContext } from "../../run.ts";
import { parseDispatchConfig } from "../../config/config.ts";
import { FakeGit } from "../../testing/fake-git.ts";
import { MemoryLinearClient, memoryAddIssue, standardMemoryWorld } from "../../service/linear/fake-memory-linear.ts";
import { FakeWorkspaces } from "../../testing/fake-workspaces.ts";
import { receiptBlock } from "../ticket/protocol.ts";
import { approvalEventBody, parseApprovalEvent } from "../ticket/event.ts";

const HEAD = "abcdef1234567890";
const LANDED = "fedcba1234567890";
const criteria = "## Acceptance criteria\n- [ ] works\n";

async function fixture(stage = "build", receipt = "build") {
  const world = standardMemoryWorld();
  const issue = memoryAddIssue(world, {
    identifier: "STA-244", stateId: `st-${stage}`, labelIds: ["label-complete"], description: criteria,
    comments: [
      { id: "build", body: receiptBlock("build", HEAD, "build-submission") },
      ...(receipt !== "build" ? [{ id: "pass", body: receiptBlock("acceptance-pass", HEAD, "pass-submission") }] : []),
      ...(receipt === "deliver" ? [{ id: "deliver", body: receiptBlock("deliver", HEAD, "deliver-submission", LANDED) }] : []),
    ],
  });
  const client = new MemoryLinearClient(world);
  const resolved = await validateStartup(client, parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 2 }));
  const workspaces = new FakeWorkspaces();
  workspaces.failMethods.add("snapshot");
  const git = new FakeGit();
  git.head = HEAD;
  git.ancestors.add(`${HEAD} feature/sta-244`);
  git.ancestors.add(`${LANDED} main`);
  const ctx: CommandContext = {
    client, resolved, workspaces, git, repoRoot: "/fake/sta-244",
    decisions: { record: async () => {} },
  };
  client.calls = [];
  return { ctx, issue, client, git, workspaces };
}

const fault = (afterWrite = false) => ({ status: 502, message: "injected lost response", afterWrite });
const approve = (ctx: CommandContext, receipt = "build") => runCommand({ command: "approve", ticket: "STA-244", receipt: receipt }, ctx);

describe("receipt-bound approval through the public command entry", () => {
  test.each([
    ["build", "build", "build", "acceptance"],
    ["acceptance", "acceptance-pass", "pass", "deliver"],
    ["deliver", "deliver", "deliver", "done"],
  ])("%s Complete approves exactly one stage", async (stage, kind, receipt, target) => {
    const h = await fixture(stage, kind);
    const result = await approve(h.ctx, receipt);
    expect(result.ok).toBe(true);
    expect(h.issue.stateId).toBe(`st-${target}`);
    expect(h.issue.labelIds).toEqual(target === "done" ? [] : ["label-pending"]);
    const approval = h.issue.comments.at(-1)!;
    expect(approval.body.startsWith(`Approved ${stage}+complete`)).toBe(true);
    expect(approval.body).not.toContain("<!-- igniter:");
    expect(approval.body.match(/```yaml/g)).toHaveLength(1);
    expect(parseApprovalEvent(approval.body)).toEqual({
      ticket: "STA-244",
      receipt,
      submission: `${receipt === "pass" ? "pass" : receipt}-submission`,
      checkpoint: HEAD,
      source: stage as "build" | "acceptance" | "deliver",
      target: target as "acceptance" | "deliver" | "done",
    });
    expect(h.workspaces.calls).toEqual([]);
    expect(h.workspaces.snapshotCalls).toBe(0);
    expect(h.git.commands.every((command) => command.args[0] === "merge-base")).toBe(true);
  });

  test("a repeated approval reuses one durable record and does not start workers", async () => {
    const h = await fixture();
    const results = [await approve(h.ctx), await approve({ ...h.ctx }), await approve(h.ctx)];
    expect(results.every((result) => result.ok)).toBe(true);
    expect(h.issue.comments.filter((comment) => comment.body.includes("kind: approval"))).toHaveLength(1);
    expect(h.client.calls.filter((call) => call.method === "setIssueState")).toHaveLength(1);
    expect(h.workspaces.calls).toEqual([]);
  });

  test.each(["addComment", "setIssueState", "setIssueLabels"] as const)("lost %s response reads back instead of duplicating", async (method) => {
    const h = await fixture();
    h.client.failNext(method, fault(true));
    expect((await approve(h.ctx)).ok).toBe(true);
    expect((await approve({ ...h.ctx })).ok).toBe(true);
    expect(h.issue.comments.filter((comment) => comment.body.includes("kind: approval"))).toHaveLength(1);
    expect(h.issue.stateId).toBe("st-acceptance");
  });

  test.each(["addComment", "setIssueState", "setIssueLabels"] as const)("failed %s resumes safely from a new command context", async (method) => {
    const h = await fixture();
    h.client.failNext(method, fault());
    expect((await approve(h.ctx)).ok).toBe(false);
    // A later CLI call has only Linear's intent, never an in-memory retry flag.
    expect((await approve({ ...h.ctx, client: new MemoryLinearClient(h.client.world) })).ok).toBe(true);
    expect(h.issue.stateId).toBe("st-acceptance");
    expect(h.issue.labelIds).toEqual(["label-pending"]);
    expect(h.issue.comments.filter((comment) => comment.body.includes("kind: approval"))).toHaveLength(1);
  });

  test("Done partial label failure retries without cleanup or a fake Deliver stage", async () => {
    const h = await fixture("deliver", "deliver");
    h.client.failNext("setIssueLabels", fault());
    expect((await approve(h.ctx, "deliver")).ok).toBe(false);
    expect(h.issue.stateId).toBe("st-done");
    expect(h.issue.labelIds).toEqual(["label-complete"]);
    expect((await approve(h.ctx, "deliver")).ok).toBe(true);
    expect(h.issue.labelIds).toEqual([]);
    expect(h.workspaces.calls).toEqual([]);
  });

  test("lost final state readback is acknowledged after a service restart", async () => {
    const h = await fixture();
    h.client.failAfter("fetchIssue", 3, fault());
    expect((await approve(h.ctx)).ok).toBe(false);
    expect(h.issue.stateId).toBe("st-acceptance");
    expect(h.issue.labelIds).toEqual(["label-pending"]);
    const restarted = { ...h.ctx, client: new MemoryLinearClient(h.client.world) };
    expect((await approve(restarted)).ok).toBe(true);
    expect(restarted.client.calls.every((call) => call.method === "fetchIssue")).toBe(true);
    expect(h.issue.comments.filter((comment) => comment.body.includes("kind: approval"))).toHaveLength(1);
  });

  test("old Build approval cannot approve a later completed Acceptance", async () => {
    const h = await fixture();
    expect((await approve(h.ctx)).ok).toBe(true);
    h.issue.labelIds = ["label-complete"];
    await h.client.addComment(h.issue.id, receiptBlock("acceptance-pass", HEAD, "acceptance-pass-new"));
    h.client.calls = [];
    const result = await approve(h.ctx);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("stale approval");
    expect(h.issue.stateId).toBe("st-acceptance");
    expect(h.client.calls.every((call) => call.method === "fetchIssue")).toBe(true);
  });

  test("retry after next stage begins never rewinds it to Pending", async () => {
    const h = await fixture();
    expect((await approve(h.ctx)).ok).toBe(true);
    h.issue.labelIds = ["label-in-progress"];
    h.client.calls = [];
    expect((await approve(h.ctx)).ok).toBe(true);
    expect(h.issue.labelIds).toEqual(["label-in-progress"]);
    expect(h.client.calls.every((call) => call.method === "fetchIssue")).toBe(true);
  });

  test("a later started stage with missing completion receipt cannot replay the previous approval", async () => {
    const h = await fixture();
    expect((await approve(h.ctx)).ok).toBe(true);
    expect((await runCommand({ command: "begin", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    // An owner moved Progress without submitting the new Acceptance receipt.
    h.issue.labelIds = ["label-complete"];
    h.client.calls = [];
    expect((await approve(h.ctx)).ok).toBe(false);
    expect(h.issue.stateId).toBe("st-acceptance");
    expect(h.issue.labelIds).toEqual(["label-complete"]);
    expect(h.client.calls.every((call) => call.method === "fetchIssue")).toBe(true);
  });

  test.each(["pending", "in-progress", "blocked"])("rejects %s rather than treating continue as approval", async (progress) => {
    const h = await fixture();
    h.issue.labelIds = [`label-${progress}`];
    expect((await approve(h.ctx)).ok).toBe(false);
    expect(h.client.calls.every((call) => call.method === "fetchIssue")).toBe(true);
  });

  test("rejects wrong stage, stale checkpoint, invalid PASS and missing receipt", async () => {
    const h = await fixture();
    h.issue.stateId = "st-acceptance";
    expect((await approve(h.ctx)).ok).toBe(false);
    h.issue.stateId = "st-build";
    h.git.ancestors.clear();
    expect((await approve(h.ctx)).ok).toBe(false);
    h.issue.comments = [];
    expect((await approve(h.ctx)).ok).toBe(false);
    await h.client.addComment(h.issue.id, receiptBlock("acceptance-fail", HEAD, "fail-submission"));
    const id = h.issue.comments.at(-1)!.id;
    expect((await approve(h.ctx, id)).ok).toBe(false);
    expect(h.issue.comments.some((comment) => comment.body.includes("kind: approval"))).toBe(false);
  });

  test("a new receipt during approval intent write fails closed", async () => {
    const h = await fixture();
    const gate = h.client.gateNext("addComment");
    const result = approve(h.ctx);
    await gate.entered;
    h.issue.comments.push({ id: "changed", body: receiptBlock("build", "bbbbbbb1234567", "replacement"), createdAt: "2099-01-01" });
    gate.release();
    expect((await result).ok).toBe(false);
    expect(h.issue.stateId).toBe("st-build");
  });

  test.each([
    ["ticket", "  ticket: STA-244", "  ticket: STA-999"],
    ["receipt", "  receipt: build", "  receipt: other"],
    ["submission", "  submission: build-submission", "  submission: other"],
    ["checkpoint", `  checkpoint: ${HEAD}`, "  checkpoint: 1234567"],
    ["source", "  source: build", "  source: acceptance"],
    ["target", "  target: acceptance", "  target: deliver"],
  ])("a prior approval with mismatched %s cannot authorize a lost write", async (_field, from, to) => {
    const h = await fixture();
    const prior = approvalEventBody("STA-244", "build", "build-submission", HEAD, "build", "acceptance").replace(from, to);
    h.issue.comments.push({ id: "prior", body: prior, createdAt: "2099-01-01" });
    h.client.failNext("addComment", fault());
    expect((await approve(h.ctx)).ok).toBe(false);
    expect(h.issue.stateId).toBe("st-build");
    expect(h.issue.labelIds).toEqual(["label-complete"]);
  });
});

describe("Linear and Worker command boundary", () => {
  test("begin normalizes a bare Todo and records a start with zero worker calls", async () => {
    const h = await fixture();
    h.issue.stateId = "st-todo";
    h.issue.labelIds = [];
    h.issue.comments = [];
    expect((await runCommand({ command: "begin", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    expect(h.issue.stateId).toBe("st-build");
    expect(h.issue.labelIds).toEqual(["label-in-progress"]);
    expect(h.workspaces.calls).toEqual([]);
    expect(h.workspaces.snapshotCalls).toBe(0);
    expect(h.git.commands).toEqual([]);
    h.client.calls = [];
    expect((await runCommand({ command: "begin", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    expect(h.client.calls.every((call) => call.method === "fetchIssue")).toBe(true);
  });

  test.each([false, true])("begin status failure afterWrite=%s is retryable without a worker", async (afterWrite) => {
    const h = await fixture();
    h.issue.stateId = "st-todo";
    h.issue.labelIds = ["label-pending"];
    h.client.failNext("setIssueState", fault(afterWrite));
    expect((await runCommand({ command: "begin", ticket: "STA-244" }, h.ctx)).ok).toBe(afterWrite);
    expect((await runCommand({ command: "begin", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    expect(h.workspaces.calls).toEqual([]);
  });

  test("fail and reconcile never close, wake, or create a worker", async () => {
    const h = await fixture();
    expect((await runCommand({ command: "reconcile", ticket: "STA-244" }, h.ctx)).ok).toBe(true);
    expect(h.issue.stateId).toBe("st-build");
    expect((await runCommand({ command: "fail", ticket: "STA-244", reason: "blocked upstream" }, h.ctx)).ok).toBe(true);
    expect(h.issue.stateId).toBe("st-backlog");
    expect(h.workspaces.calls).toEqual([]);
    expect(h.workspaces.snapshotCalls).toBe(0);
  });

});
