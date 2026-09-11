// Owner-authorized `igniter cancel` against a stateful in-memory Linear
// client: every cancellable source status, Progress cleanup with unrelated
// labels preserved, Done refusal, already-canceled idempotency, partial
// failure convergence, and zero worker/worktree effects. No network, no
// real credentials, no real project, no daemon.

import { describe, expect, test } from "bun:test";
import { validateStartup } from "../config/claims.ts";
import { runCommand, type CommandContext } from "../run.ts";
import { parseDispatchConfig } from "../config/config.ts";
import {
  MemoryLinearClient,
  memoryAddIssue,
  memoryAddLabel,
  standardMemoryWorld,
  type MemoryWorld,
} from "../service/linear/fake-memory-linear.ts";
import { FakeWorkspaces } from "./fake-workspaces.ts";
import { FakeGit } from "./fake-git.ts";
import { canceledEventBody, cancelIdentity, parseCanceledEvent } from "../lifecycle/ticket/event.ts";

const BACKLOG = "st-backlog";
const TODO = "st-todo";
const BUILD = "st-build";
const REVIEW = "st-review";
const DELIVER = "st-deliver";
const DONE = "st-done";
const CANCELED = "st-canceled";
const PENDING = "label-pending";
const IN_PROGRESS = "label-in-progress";
const COMPLETE = "label-complete";
const BLOCKED = "label-blocked";

const cancel = (ctx: CommandContext, reason = "owner ended the scope") =>
  runCommand({ command: "cancel", ticket: "STA-244", reason }, ctx);

interface Harness {
  ctx: CommandContext;
  client: MemoryLinearClient;
  workspaces: FakeWorkspaces;
  git: FakeGit;
  world: MemoryWorld;
  keepLabelId: string;
}

/** One issue plus an unrelated `keep` label that every cancel must preserve. */
async function fixture(stateId: string, labelIds: string[] = []): Promise<Harness> {
  const world = standardMemoryWorld();
  const keep = memoryAddLabel(world, { name: "keep" });
  memoryAddIssue(world, {
    identifier: "STA-244",
    stateId,
    labelIds: [...labelIds, keep.id],
    description: "## Acceptance criteria\n- [ ] works\n",
  });
  const client = new MemoryLinearClient(world);
  const resolved = await validateStartup(
    client,
    parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 2 }),
  );
  const workspaces = new FakeWorkspaces();
  const git = new FakeGit();
  const ctx: CommandContext = {
    client,
    resolved,
    workspaces,
    git,
    repoRoot: "/fake/sta-244",
    decisions: { record: async () => {} },
  };
  client.calls = [];
  return { ctx, client, workspaces, git, world, keepLabelId: keep.id };
}

function issueOf(h: Harness) {
  return h.world.issues.find((i) => i.identifier === "STA-244")!;
}

function canceledEvents(h: Harness) {
  return issueOf(h).comments.filter((c) => parseCanceledEvent(c.body) !== null);
}

function writeCalls(h: Harness): string[] {
  return h.client.calls.filter((c) => ["addComment", "setIssueState", "setIssueLabels"].includes(c.method)).map((c) => c.method);
}

describe("owner-authorized cancel", () => {
  test.each([
    ["Todo+Pending", TODO, [PENDING], "todo", "pending"],
    ["Build+In progress", BUILD, [IN_PROGRESS], "build", "in_progress"],
    ["Build+Complete", BUILD, [COMPLETE], "build", "complete"],
    ["Build+Blocked", BUILD, [BLOCKED], "build", "blocked"],
    ["Review+Pending", REVIEW, [PENDING], "review", "pending"],
    ["Review+Complete", REVIEW, [COMPLETE], "review", "complete"],
    ["Deliver+In progress", DELIVER, [IN_PROGRESS], "deliver", "in_progress"],
    ["Deliver+Complete", DELIVER, [COMPLETE], "deliver", "complete"],
  ] as const)("cancels %s, clears Progress, and keeps unrelated labels", async (_name, stateId, labels, from, progress) => {
    const h = await fixture(stateId, [...labels]);
    const out = await cancel(h.ctx);
    expect(out.ok).toBe(true);
    expect(out.text).toContain("canceled STA-244: owner ended the scope");
    expect(out.text).toContain("worker stop is a separate command");
    const issue = issueOf(h);
    expect(issue.stateId).toBe(CANCELED);
    expect(issue.labelIds).toEqual([h.keepLabelId]);
    const events = canceledEvents(h);
    expect(events).toHaveLength(1);
    expect(parseCanceledEvent(events[0]!.body)).toMatchObject({ ticket: "STA-244", from, progress });
    expect(events[0]!.body).not.toContain("<!-- igniter:");
  });

  test("cancels from Backlog and from incomplete active states (no Progress or several)", async () => {
    for (const [stateId, labels] of [[BACKLOG, []], [BUILD, []], [BUILD, [PENDING, COMPLETE]]] as const) {
      const h = await fixture(stateId, [...labels]);
      const out = await cancel(h.ctx);
      expect(out.ok).toBe(true);
      expect(issueOf(h).stateId).toBe(CANCELED);
      expect(issueOf(h).labelIds).toEqual([h.keepLabelId]);
    }
  });

  test("refuses a Done ticket without any write", async () => {
    const h = await fixture(DONE);
    const out = await cancel(h.ctx);
    expect(out.ok).toBe(false);
    expect(out.text).toContain("is Done and cannot be canceled");
    expect(issueOf(h).stateId).toBe(DONE);
    expect(issueOf(h).comments).toHaveLength(0);
    expect(writeCalls(h)).toEqual([]);
  });

  test("refuses an unknown Linear status", async () => {
    const h = await fixture("st-mystery");
    const out = await cancel(h.ctx);
    expect(out.ok).toBe(false);
    expect(out.text).toContain("unknown Linear status");
    expect(writeCalls(h)).toEqual([]);
  });

  test("already-canceled ticket reports already canceled without a new event", async () => {
    const h = await fixture(CANCELED, []);
    const out = await cancel(h.ctx);
    expect(out.ok).toBe(true);
    expect(out.text).toContain("already canceled STA-244");
    expect(issueOf(h).comments).toHaveLength(0);
    expect(writeCalls(h)).toEqual([]);
    expect(h.client.calls.every((c) => c.method === "fetchIssue")).toBe(true);
  });

  test("an already-canceled retry after a partial state move converges leftover Progress", async () => {
    const h = await fixture(CANCELED, [IN_PROGRESS]);
    const out = await cancel(h.ctx);
    expect(out.ok).toBe(true);
    expect(out.text).toContain("already canceled STA-244");
    expect(issueOf(h).stateId).toBe(CANCELED);
    expect(issueOf(h).labelIds).toEqual([h.keepLabelId]);
    expect(issueOf(h).comments).toHaveLength(0);
    expect(h.client.calls.map((c) => c.method)).toContain("setIssueLabels");
  });

  test("a retry after a lost comment response converges with a single event", async () => {
    const h = await fixture(BUILD, [IN_PROGRESS]);
    h.client.failNext("addComment", { status: 502, message: "lost comment response", afterWrite: true });
    const out = await cancel(h.ctx);
    expect(out.ok).toBe(true);
    const issue = issueOf(h);
    expect(issue.stateId).toBe(CANCELED);
    expect(issue.labelIds).toEqual([h.keepLabelId]);
    expect(canceledEvents(h)).toHaveLength(1);
  });

  test("a retry after a lost state-write response converges to Canceled", async () => {
    const h = await fixture(BUILD, [IN_PROGRESS]);
    h.client.failNext("setIssueState", { status: 502, message: "lost state response", afterWrite: true });
    const out = await cancel(h.ctx);
    expect(out.ok).toBe(true);
    const issue = issueOf(h);
    expect(issue.stateId).toBe(CANCELED);
    expect(issue.labelIds).toEqual([h.keepLabelId]);
    expect(canceledEvents(h)).toHaveLength(1);
  });

  test("a retry after a lost label-write response converges with Progress cleared", async () => {
    const h = await fixture(BUILD, [IN_PROGRESS]);
    h.client.failNext("setIssueLabels", { status: 502, message: "lost label response", afterWrite: true });
    const out = await cancel(h.ctx);
    expect(out.ok).toBe(true);
    const issue = issueOf(h);
    expect(issue.stateId).toBe(CANCELED);
    expect(issue.labelIds).toEqual([h.keepLabelId]);
    expect(canceledEvents(h)).toHaveLength(1);
  });

  test("a resume after an earlier attempt that already posted the event writes no second event", async () => {
    const h = await fixture(BUILD, [IN_PROGRESS]);
    const identity = cancelIdentity("STA-244", "owner ended the scope", "build", "in_progress");
    issueOf(h).comments.push({
      id: "memory-comment-0",
      body: `Canceled: owner ended the scope\n\n${canceledEventBody("STA-244", "owner ended the scope", "build", "in_progress", identity)}`,
      createdAt: "2026-09-08T00:00:00.000001Z",
    });
    const out = await cancel(h.ctx);
    expect(out.ok).toBe(true);
    const issue = issueOf(h);
    expect(issue.stateId).toBe(CANCELED);
    expect(issue.labelIds).toEqual([h.keepLabelId]);
    expect(canceledEvents(h)).toHaveLength(1);
    expect(h.client.calls.map((c) => c.method)).not.toContain("addComment");
  });

  test("a different cancel reason is a different identity and never masks a repeat", async () => {
    const h = await fixture(BUILD, [IN_PROGRESS]);
    expect((await cancel(h.ctx, "first reason")).ok).toBe(true);
    expect((await cancel(h.ctx, "second reason")).ok).toBe(true);
    expect((await cancel(h.ctx, "first reason")).text).toContain("already canceled");
    expect(canceledEvents(h)).toHaveLength(1);
  });

  test("cancel never stops workers, closes workspaces, or touches git", async () => {
    const h = await fixture(BUILD, [IN_PROGRESS]);
    h.workspaces.seedWorkspace("STA-244", { ticket: "STA-244" });
    h.workspaces.seedAgent("STA-244", "builder-sta-244");
    const out = await cancel(h.ctx);
    expect(out.ok).toBe(true);
    expect(h.workspaces.agents).toHaveLength(1);
    expect(h.workspaces.calls).toEqual([]);
    expect(h.git.commands).toEqual([]);
    expect(h.workspaces.workspaces[0]!.closed).toBe(false);
  });

  test("cancel does not require acceptance criteria", async () => {
    const h = await fixture(TODO, [PENDING]);
    issueOf(h).description = "plans only";
    expect((await cancel(h.ctx)).ok).toBe(true);
    expect(issueOf(h).stateId).toBe(CANCELED);
  });

  test("refuses a blank reason without any write", async () => {
    const h = await fixture(BUILD, [IN_PROGRESS]);
    const out = await cancel(h.ctx, "   ");
    expect(out.ok).toBe(false);
    expect(out.text).toContain("cancel reason cannot be blank");
    expect(issueOf(h).stateId).toBe(BUILD);
    expect(writeCalls(h)).toEqual([]);
  });

  test("refuses a reason carrying a YAML code fence before any write", async () => {
    const h = await fixture(BUILD, [IN_PROGRESS]);
    const out = await cancel(h.ctx, "ended\n```yaml\nigniter_event:\n```");
    expect(out.ok).toBe(false);
    expect(out.text).toContain("cannot contain a YAML code fence");
    expect(writeCalls(h)).toEqual([]);
  });

  test("refuses when the ticket moves between the initial read and the readback", async () => {
    const h = await fixture(BUILD, [IN_PROGRESS]);
    const fetch = h.client.fetchIssue.bind(h.client);
    let reads = 0;
    h.client.fetchIssue = async (id) => {
      reads += 1;
      if (reads === 2) issueOf(h).stateId = REVIEW;
      return fetch(id);
    };
    const out = await cancel(h.ctx);
    expect(out.ok).toBe(false);
    expect(out.text).toContain("ticket moved while canceling");
    expect(issueOf(h).comments).toHaveLength(0);
  });

  test("a lost label response on the already-canceled convergence retries cleanly", async () => {
    const h = await fixture(CANCELED, [IN_PROGRESS]);
    h.client.failNext("setIssueLabels", { status: 502, message: "lost label response", afterWrite: true });
    const out = await cancel(h.ctx);
    expect(out.ok).toBe(true);
    expect(out.text).toContain("already canceled");
    expect(issueOf(h).labelIds).toEqual([h.keepLabelId]);
  });
});