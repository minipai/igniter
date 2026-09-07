// Stage-aware Linear delivery protocol against a fake Linear endpoint and
// fake Herdr: every legal transition, every refusal without writes,
// idempotent receipts, owner moves, and slot rules. No network, no real
// credentials, no real project, no daemon.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceSink,
  runCommand,
  type CommandContext,
} from "./commands";
import { validateStartup, Watcher, type ResolvedDispatch } from "./claims";
import { parseDispatchConfig } from "./config";
import { LinearClient } from "./linear";
import {
  parseAcceptanceCriteria,
  parseReceiptBlock,
  receiptBlock,
  submissionId,
  type ParsedReceipt,
  type ReceiptKind,
} from "./protocol";
import { addIssue, standardWorld, startFakeLinear } from "./fake-linear";
import { FakeGit } from "./fake-git";
import { FakeWorkspaces } from "./fake-workspaces";
import { ticketWorktree } from "./worktrees";

const BACKLOG = "st-backlog";
const TODO = "st-todo";
const BUILD = "st-build";
const REVIEW = "st-review";
const DELIVER = "st-deliver";
const DONE = "st-done";
const PENDING = "label-pending";
const IN_PROGRESS = "label-in-progress";
const COMPLETE = "label-complete";
const BLOCKED = "label-blocked";
const CRITERIA = "## 驗收條件\n- [ ] works\n- [ ] shines\n";
const HEAD = "deadbeefcafe0001";

interface Harness {
  ctx: CommandContext;
  lines: string[];
  workspaces: FakeWorkspaces;
  git: FakeGit;
  client: LinearClient;
  resolved: ResolvedDispatch;
  world: ReturnType<typeof standardWorld>;
  stop: () => void;
}

async function harness(maxRunning = 3): Promise<Harness> {
  const world = standardWorld("test-key");
  const fake = startFakeLinear(world);
  const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url });
  const resolved = await validateStartup(
    client,
    parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: maxRunning }),
  );
  const lines: string[] = [];
  const workspaces = new FakeWorkspaces();
  const git = new FakeGit();
  git.head = HEAD;
  const repoRoot = join(mkdtempSync(join(tmpdir(), "igniter-proto-root-")), "repo");
  const sink = createWorkspaceSink({ workspaces, config: resolved.config, repoRoot, runGit: git });
  const ctx: CommandContext = {
    client,
    resolved,
    host: "h",
    decisions: {
      record: async (ticket, message) => {
        lines.push(`${ticket} ${message}`);
      },
    },
    workspaces,
    sink,
    repoRoot,
    git,
    lastPollAt: () => null,
  };
  return { ctx, lines, workspaces, git, client, resolved, world, stop: () => fake.stop() };
}

function issueOf(h: Harness, identifier: string) {
  const issue = h.world.issues.find((i) => i.identifier === identifier);
  if (!issue) throw new Error(`no such issue ${identifier}`);
  return issue;
}

function workspaceIdOf(h: Harness, identifier: string): string {
  const workspace = h.workspaces.workspaces.find((w) => w.label === identifier && !w.closed);
  if (!workspace) throw new Error(`no workspace for ${identifier}`);
  return workspace.workspaceId;
}

function wsCmd(h: Harness, identifier: string, argv: string[], input?: string) {
  return runCommand(argv, h.ctx, { workspaceId: workspaceIdOf(h, identifier), input });
}

/**
 * The newest comment carries one human report plus exactly one versioned
 * YAML receipt block — and no hidden HTML marker. Returns the submission
 * identity for retry assertions.
 */
function expectYamlReceipt(body: string, kind: ReceiptKind, checkpoint: string): string {
  expect(body).not.toContain("<!-- igniter:");
  expect(body.match(/```yaml/g)).toHaveLength(1);
  const parsed: ParsedReceipt | null = parseReceiptBlock(body);
  expect(parsed).toMatchObject({ kind, checkpoint });
  expect(parsed?.submission).toMatch(/^[0-9a-f]{16}$/);
  return (parsed as ParsedReceipt).submission;
}

/** Owner-move transitions verify the receipt checkpoint against this lineage. */
function seedLineage(h: Harness, identifier: string, checkpoint = HEAD): void {
  h.git.ancestors.add(`${checkpoint} feature/${identifier.toLowerCase()}`);
}

function buildPayload(head = HEAD) {
  return {
    v: 1,
    kind: "build",
    checkpoint: head,
    checks: ["bun run check"],
    results: [
      { criterion: "works", ok: true, note: "green" },
      { criterion: "shines", ok: true },
    ],
    reproduction: "run bun run check",
  };
}

function reviewPayload(verdict: "pass" | "fail", head = HEAD) {
  return {
    v: 1,
    kind: "review",
    verdict,
    checkpoint: head,
    results: [
      {
        criterion: "works",
        expected: "works",
        actual: verdict === "pass" ? "works" : "broken",
        evidence: "https://example.test/works",
        ok: verdict === "pass",
      },
      {
        criterion: "shines",
        expected: "shines",
        actual: "shines",
        evidence: "https://example.test/shines",
        ok: true,
      },
    ],
    environment: "test lab",
    reproduction: "open the page",
  };
}

function deliverPayload(head = HEAD) {
  return {
    v: 1,
    kind: "deliver",
    checkpoint: head,
    lineage: "abc123 deliver work",
    merge_ready: true,
    owner_actions: ["push the branch"],
  };
}

/** Claim a ticket through `start` and return its workspace id. */
async function claim(h: Harness, identifier: string): Promise<string> {
  addIssue(h.world, { identifier, stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
  const out = await runCommand(["start", identifier], h.ctx);
  expect(out.ok).toBe(true);
  return workspaceIdOf(h, identifier);
}

describe("acceptance criteria", () => {
  test("parses checklist items under the heading only", () => {
    expect(parseAcceptanceCriteria(null)).toEqual([]);
    expect(parseAcceptanceCriteria("nothing")).toEqual([]);
    expect(parseAcceptanceCriteria("## 驗收條件\nnothing")).toEqual([]);
    expect(parseAcceptanceCriteria(CRITERIA)).toEqual(["works", "shines"]);
    expect(parseAcceptanceCriteria("## Acceptance criteria\n- [ ] a\n## Notes\n- [ ] b\n")).toEqual(["a"]);
  });

  test("submission identity is stable and payload-sensitive", () => {
    const a = submissionId({ ticket: "STA-1", v: 1 });
    expect(submissionId({ v: 1, ticket: "STA-1" })).toBe(a);
    expect(submissionId({ ticket: "STA-1", v: 2 })).not.toBe(a);
  });
});

describe("startup validation", () => {
  test("maps the six statuses and the Progress group", async () => {
    const h = await harness();
    try {
      expect(h.resolved.stateIds).toMatchObject({
        backlog: BACKLOG,
        todo: TODO,
        build: BUILD,
        review: REVIEW,
        deliver: DELIVER,
        done: DONE,
      });
      expect(h.resolved.progress).toMatchObject({
        groupId: "label-progress",
        ids: { pending: PENDING, in_progress: IN_PROGRESS, complete: COMPLETE, blocked: BLOCKED },
      });
    } finally {
      h.stop();
    }
  });

  test("a status on the wrong workflow type fails startup", async () => {
    const h = await harness();
    try {
      await expect(
        validateStartup(h.client, parseDispatchConfig({
          project: "igniter",
          team: "Starcoder",
          states: { backlog: "Backlog", todo: "Build", build: "Todo", review: "Review", deliver: "Deliver", done: "Done" },
        })),
      ).rejects.toThrow('must be a unstarted-type state');
    } finally {
      h.stop();
    }
  });

  test("a missing label group fails startup", async () => {
    const h = await harness();
    try {
      await expect(
        validateStartup(h.client, parseDispatchConfig({
          project: "igniter", team: "Starcoder", progress: { group: "Nope" },
        })),
      ).rejects.toThrow('label group "Nope"');
    } finally {
      h.stop();
    }
  });

  test("a label outside the group fails startup", async () => {
    const h = await harness();
    try {
      h.world.labels.push({ id: "label-stray", name: "Stray", teamId: "team-1", parentId: null });
      await expect(
        validateStartup(h.client, parseDispatchConfig({
          project: "igniter", team: "Starcoder", progress: { pending: "Stray" },
        })),
      ).rejects.toThrow('is not in label group "Progress"');
    } finally {
      h.stop();
    }
  });
});

describe("claim", () => {
  test("start claims Todo+Pending into Build+In progress with a workspace", async () => {
    const h = await harness();
    try {
      const wsId = await claim(h, "STA-1");
      const issue = issueOf(h, "STA-1");
      expect(issue.stateId).toBe(BUILD);
      expect(issue.labelIds).toEqual([IN_PROGRESS]);
      const workspace = h.workspaces.workspaces.find((w) => w.workspaceId === wsId)!;
      expect(workspace.tokens).toMatchObject({
        ticket: "STA-1",
        commander: "claude",
        status: "build",
        progress: "in_progress",
      });
      // No secrets ride into the workspace.
      const created = h.workspaces.calls.find((c) => c.method === "workspace.create");
      expect(created?.params).toMatchObject({ label: "STA-1", env: {} });
      expect(JSON.stringify(created?.params)).not.toContain("test-key");
      expect(JSON.stringify(created?.params)).not.toContain("IGNITER_TICKET");
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 claimed: Todo → Build (slot 0)"));
    } finally {
      h.stop();
    }
  });

  test("claim refuses without criteria, leaving a nudge and no workspace", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: "plans only", labelIds: [PENDING] });
      const out = await runCommand(["start", "STA-1"], h.ctx);
      expect(out.ok).toBe(false);
      expect(issueOf(h, "STA-1").stateId).toBe(TODO);
      expect(issueOf(h, "STA-1").comments.some((c) => c.body.includes("<!-- igniter:missing-criteria -->"))).toBe(true);
      expect(h.workspaces.workspaces).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("claim refuses without Pending and outside Todo", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      addIssue(h.world, { identifier: "STA-2", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      expect((await runCommand(["start", "STA-1"], h.ctx)).ok).toBe(false);
      expect((await runCommand(["start", "STA-2"], h.ctx)).ok).toBe(true); // adoption, not claim
      expect(issueOf(h, "STA-1").stateId).toBe(TODO);
    } finally {
      h.stop();
    }
  });

  test("claim refuses at the cap and blocked tickets free slots", async () => {
    const h = await harness(1);
    try {
      await claim(h, "STA-1");
      addIssue(h.world, { identifier: "STA-2", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const full = await runCommand(["start", "STA-2"], h.ctx);
      expect(full.ok).toBe(false);
      expect(full.text).toContain("max_running");
      // Blocking the holder frees its slot for the waiter.
      expect((await wsCmd(h, "STA-1", ["block", "--reason", "waiting on vendor"])).ok).toBe(true);
      expect(issueOf(h, "STA-1").labelIds).toEqual([BLOCKED]);
      expect((await runCommand(["start", "STA-2"], h.ctx)).ok).toBe(true);
      expect(issueOf(h, "STA-2").stateId).toBe(BUILD);
    } finally {
      h.stop();
    }
  });

  test("watcher and start share one claim path", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-9", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const watcher = new Watcher({
        client: h.client,
        resolved: h.resolved,
        host: "h",
        decisions: h.ctx.decisions,
        workspaces: h.workspaces,
        sink: h.ctx.sink,
        git: h.git,
        repoRoot: h.ctx.repoRoot,
      });
      const result = await watcher.pollOnce();
      expect(result.claimed.map((c) => c.identifier)).toEqual(["STA-9"]);
      expect(issueOf(h, "STA-9").stateId).toBe(BUILD);
      expect(issueOf(h, "STA-9").labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("watcher normalizes a bare Todo to Todo+Pending without claiming", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-9", stateId: TODO, priority: 1, description: "plans only" });
      const watcher = new Watcher({
        client: h.client,
        resolved: h.resolved,
        host: "h",
        decisions: h.ctx.decisions,
        workspaces: h.workspaces,
        sink: h.ctx.sink,
        git: h.git,
        repoRoot: h.ctx.repoRoot,
      });
      await watcher.pollOnce();
      expect(issueOf(h, "STA-9").labelIds).toEqual([PENDING]);
      expect(issueOf(h, "STA-9").stateId).toBe(TODO);
      expect(h.workspaces.workspaces).toHaveLength(0);
    } finally {
      h.stop();
    }
  });
});

describe("state --json", () => {
  test("returns ticket, criteria, status, progress, next, and submit schema", async () => {
    const h = await harness();
    try {
      const wsId = await claim(h, "STA-1");
      const out = await runCommand(["state", "--json"], h.ctx, { workspaceId: wsId });
      expect(out.ok).toBe(true);
      const data = out.data as Record<string, unknown>;
      expect(data).toMatchObject({
        status: "build",
        progress: "in_progress",
        checkpoint: null,
        next: ["submit", "block"],
      });
      expect((data["ticket"] as Record<string, unknown>)["criteria"]).toEqual(["works", "shines"]);
      expect((data["submit_schema"] as Record<string, unknown>)["kind"]).toBe("build");
    } finally {
      h.stop();
    }
  });

  test("unknown workspaces and ticket-less workspaces are refused", async () => {
    const h = await harness();
    try {
      expect((await runCommand(["state", "--json"], h.ctx, { workspaceId: "ws-nope" })).ok).toBe(false);
      h.workspaces.seedWorkspace("stray", {}, { commander: false });
      const stray = h.workspaces.workspaces.find((w) => w.label === "stray")!;
      const out = await runCommand(["state", "--json"], h.ctx, { workspaceId: stray.workspaceId });
      expect(out.ok).toBe(false);
      expect(out.text).toContain("no ticket metadata");
    } finally {
      h.stop();
    }
  });

  test("multiple Progress labels refuse every workspace command without writes", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      const issue = issueOf(h, "STA-1");
      issue.labelIds = [PENDING, IN_PROGRESS];
      const before = JSON.stringify({ labels: issue.labelIds, comments: issue.comments.length, state: issue.stateId });
      const metaBefore = JSON.stringify(h.workspaces.tokensFor("STA-1"));
      for (const argv of [
        ["state", "--json"],
        ["begin"],
        ["submit", "--input", "-"],
        ["block", "--reason", "x"],
        ["unblock"],
      ]) {
        const out = await wsCmd(h, "STA-1", argv, JSON.stringify(buildPayload()));
        expect(out.ok).toBe(false);
        expect(out.text).toContain("2 Progress labels");
      }
      expect(JSON.stringify({ labels: issue.labelIds, comments: issue.comments.length, state: issue.stateId })).toBe(before);
      expect(JSON.stringify(h.workspaces.tokensFor("STA-1"))).toBe(metaBefore);
    } finally {
      h.stop();
    }
  });
});

describe("begin", () => {
  test("moves Pending to In progress with the status unchanged", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      // Build+In progress cannot begin again.
      expect((await wsCmd(h, "STA-1", ["begin"])).ok).toBe(false);
      // Drive to Review+Pending, then begin.
      expect((await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(buildPayload()))).ok).toBe(true);
      expect(issueOf(h, "STA-1").stateId).toBe(REVIEW);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect((await wsCmd(h, "STA-1", ["begin"])).ok).toBe(true);
      expect(issueOf(h, "STA-1").stateId).toBe(REVIEW);
      expect(issueOf(h, "STA-1").labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });
});

describe("submit", () => {
  test("build submit publishes a receipt and lands in Review+Pending", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      const out = await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(buildPayload()));
      expect(out.ok).toBe(true);
      const issue = issueOf(h, "STA-1");
      expect(issue.stateId).toBe(REVIEW);
      expect(issue.labelIds).toEqual([PENDING]);
      const receipt = issue.comments.at(-1)!;
      expectYamlReceipt(receipt.body, "build", HEAD);
      expect(receipt.body).toContain("# Build receipt");
      expect(h.workspaces.tokensFor("STA-1")).toMatchObject({
        status: "review",
        progress: "pending",
        checkpoint: HEAD,
        receipt_kind: "build",
      });
      // state --json now offers the review schema and begin.
      const state = (await wsCmd(h, "STA-1", ["state", "--json"])).data as Record<string, unknown>;
      expect(state).toMatchObject({ status: "review", progress: "pending", next: ["begin", "block"] });
      expect((state["submit_schema"] as Record<string, unknown>)["kind"]).toBe("review");
    } finally {
      h.stop();
    }
  });

  test("build submit is idempotent: same payload reuses the receipt", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      const payload = JSON.stringify(buildPayload());
      expect((await wsCmd(h, "STA-1", ["submit", "--input", "-"], payload)).ok).toBe(true);
      const count = issueOf(h, "STA-1").comments.length;
      // Back in Build+In progress with the same checkpoint: resubmit converges.
      issueOf(h, "STA-1").stateId = BUILD;
      issueOf(h, "STA-1").labelIds = [IN_PROGRESS];
      expect((await wsCmd(h, "STA-1", ["submit", "--input", "-"], payload)).ok).toBe(true);
      expect(issueOf(h, "STA-1").comments.length).toBe(count);
    } finally {
      h.stop();
    }
  });

  test("build submit refuses a stale checkpoint, partial coverage, and wrong kinds", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      const before = JSON.stringify(issueOf(h, "STA-1"));
      const stale = { ...buildPayload(), checkpoint: "other" };
      expect((await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(stale))).text).toContain("worktree HEAD");
      const partial = { ...buildPayload(), results: [{ criterion: "works", ok: true }] };
      expect((await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(partial))).text).toContain("misses 1 acceptance criterion");
      const wrong = { ...reviewPayload("pass") };
      expect((await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(wrong))).text).toContain("build submit needs");
      expect((await wsCmd(h, "STA-1", ["submit", "--input", "-"], "not json")).text).toContain("not JSON");
      expect(JSON.stringify(issueOf(h, "STA-1"))).toBe(before);
      expect(issueOf(h, "STA-1").stateId).toBe(BUILD);
    } finally {
      h.stop();
    }
  });

  test("review PASS needs full evidence and lands in Review+Complete", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(buildPayload()));
      await wsCmd(h, "STA-1", ["begin"]);
      const out = await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(reviewPayload("pass")));
      expect(out.ok).toBe(true);
      const issue = issueOf(h, "STA-1");
      expect(issue.stateId).toBe(REVIEW);
      expect(issue.labelIds).toEqual([COMPLETE]);
      const receipt = issue.comments.at(-1)!;
      expect(receipt.body).toContain("Agent acceptance: PASS");
      expectYamlReceipt(receipt.body, "review-pass", HEAD);
      expect(issue.attachments.map((a) => a.url).sort()).toEqual(
        ["https://example.test/shines", "https://example.test/works"],
      );
      expect(h.workspaces.tokensFor("STA-1")).toMatchObject({ receipt_kind: "review-pass", checkpoint: HEAD });
      const state = (await wsCmd(h, "STA-1", ["state", "--json"])).data as Record<string, unknown>;
      expect(state).toMatchObject({ status: "review", progress: "complete", next: [] });
    } finally {
      h.stop();
    }
  });

  test("review PASS refuses without evidence and writes nothing", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(buildPayload()));
      await wsCmd(h, "STA-1", ["begin"]);
      const payload = reviewPayload("pass");
      payload.results[0]!.evidence = "";
      const before = JSON.stringify({ issue: issueOf(h, "STA-1"), meta: h.workspaces.tokensFor("STA-1") });
      const out = await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(payload));
      expect(out.ok).toBe(false);
      expect(out.text).toContain("evidence");
      expect(JSON.stringify({ issue: issueOf(h, "STA-1"), meta: h.workspaces.tokensFor("STA-1") })).toBe(before);
      expect(issueOf(h, "STA-1").labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("review submit refuses non-URL evidence before any Linear write", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(buildPayload()));
      await wsCmd(h, "STA-1", ["begin"]);
      const payload = reviewPayload("pass");
      payload.results[0]!.evidence = "Command output: everything passed";
      const before = JSON.stringify({ issue: issueOf(h, "STA-1"), meta: h.workspaces.tokensFor("STA-1") });
      const out = await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(payload));
      expect(out.ok).toBe(false);
      expect(out.text).toContain("absolute http or https URL");
      expect(JSON.stringify({ issue: issueOf(h, "STA-1"), meta: h.workspaces.tokensFor("STA-1") })).toBe(before);
    } finally {
      h.stop();
    }
  });

  test("review FAIL returns to Build+Pending", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(buildPayload()));
      await wsCmd(h, "STA-1", ["begin"]);
      const out = await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(reviewPayload("fail")));
      expect(out.ok).toBe(true);
      expect(issueOf(h, "STA-1").stateId).toBe(BUILD);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(issueOf(h, "STA-1").comments.at(-1)!.body).toContain("Agent acceptance: FAIL");
      expect(h.workspaces.tokensFor("STA-1")).toMatchObject({ status: "build", progress: "pending" });
      expect(h.workspaces.tokensFor("STA-1")).not.toHaveProperty("receipt_id");
    } finally {
      h.stop();
    }
  });

  test("review submit refuses a checkpoint newer than the build receipt", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(buildPayload()));
      await wsCmd(h, "STA-1", ["begin"]);
      h.git.head = "newcommit0000002";
      const out = await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(reviewPayload("pass", "newcommit0000002")));
      expect(out.ok).toBe(false);
      expect(out.text).toContain("new checkpoint needs a new build submit");
      expect(issueOf(h, "STA-1").labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("deliver submit lands in Deliver+Complete", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      issueOf(h, "STA-1").stateId = DELIVER;
      issueOf(h, "STA-1").labelIds = [IN_PROGRESS];
      // The approval receipt lives in Linear, not in workspace metadata.
      issueOf(h, "STA-1").comments.push({
        id: "comment-pass",
        body: `Agent acceptance: PASS\n\n${receiptBlock("review-pass", HEAD, "abc123abc123abc1")}\n`,
        createdAt: "2026-09-04T00:00:00.000001Z",
      });
      const out = await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(deliverPayload()));
      expect(out.ok).toBe(true);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      expectYamlReceipt(issueOf(h, "STA-1").comments.at(-1)!.body, "deliver", HEAD);
      expect(h.workspaces.tokensFor("STA-1")).toMatchObject({ receipt_kind: "deliver" });
    } finally {
      h.stop();
    }
  });

  test("deliver submit without a review-pass receipt is refused", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      issueOf(h, "STA-1").stateId = DELIVER;
      issueOf(h, "STA-1").labelIds = [IN_PROGRESS];
      const before = JSON.stringify(issueOf(h, "STA-1"));
      const out = await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(deliverPayload()));
      expect(out.ok).toBe(false);
      expect(out.text).toContain("no review-pass receipt");
      expect(JSON.stringify(issueOf(h, "STA-1"))).toBe(before);
    } finally {
      h.stop();
    }
  });

  test("non-progress labels survive every transition", async () => {
    const h = await harness();
    try {
      h.world.labels.push({ id: "label-keep", name: "keep", teamId: "team-1", parentId: null });
      await claim(h, "STA-1");
      issueOf(h, "STA-1").labelIds.push("label-keep");
      await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(buildPayload()));
      expect(new Set(issueOf(h, "STA-1").labelIds)).toEqual(new Set([PENDING, "label-keep"]));
      await wsCmd(h, "STA-1", ["begin"]);
      await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(reviewPayload("pass")));
      expect(new Set(issueOf(h, "STA-1").labelIds)).toEqual(new Set([COMPLETE, "label-keep"]));
    } finally {
      h.stop();
    }
  });
});

describe("block and unblock", () => {
  test("block keeps the status with a reason; unblock returns to Pending", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      expect((await wsCmd(h, "STA-1", ["block", "--reason", "waiting on vendor"])).ok).toBe(true);
      expect(issueOf(h, "STA-1").stateId).toBe(BUILD);
      expect(issueOf(h, "STA-1").labelIds).toEqual([BLOCKED]);
      expect(issueOf(h, "STA-1").comments.at(-1)!.body).toContain("waiting on vendor");
      expect(h.workspaces.tokensFor("STA-1")).toMatchObject({ progress: "blocked", block_reason: "waiting on vendor" });
      // Blocked is not a submit state.
      expect((await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(buildPayload()))).ok).toBe(false);
      expect((await wsCmd(h, "STA-1", ["unblock"])).ok).toBe(true);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(h.workspaces.tokensFor("STA-1")).not.toHaveProperty("block_reason");
      // Unblock never jumps straight to In progress.
      expect((await wsCmd(h, "STA-1", ["begin"])).ok).toBe(true);
    } finally {
      h.stop();
    }
  });

  test("block refuses outside Pending/In progress and unblock outside Blocked", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      expect((await wsCmd(h, "STA-1", ["unblock"])).ok).toBe(false);
      await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(buildPayload()));
      await wsCmd(h, "STA-1", ["begin"]);
      await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(reviewPayload("pass")));
      expect((await wsCmd(h, "STA-1", ["block", "--reason", "x"])).ok).toBe(false);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
    } finally {
      h.stop();
    }
  });
});

describe("owner moves", () => {
  async function toReviewComplete(h: Harness, identifier: string): Promise<void> {
    await claim(h, identifier);
    await wsCmd(h, identifier, ["submit", "--input", "-"], JSON.stringify(buildPayload()));
    await wsCmd(h, identifier, ["begin"]);
    const out = await wsCmd(h, identifier, ["submit", "--input", "-"], JSON.stringify(reviewPayload("pass")));
    expect(out.ok).toBe(true);
    seedLineage(h, identifier);
  }

  function watcherOf(h: Harness): Watcher {
    return new Watcher({
      client: h.client,
      resolved: h.resolved,
      host: "h",
      decisions: h.ctx.decisions,
      workspaces: h.workspaces,
      sink: h.ctx.sink,
      git: h.git,
      repoRoot: h.ctx.repoRoot,
    });
  }

  test("approval normalizes Review+Complete to Deliver+Pending", async () => {
    const h = await harness();
    try {
      await toReviewComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]); // inherited Complete
      await watcherOf(h).pollOnce();
      expect(issueOf(h, "STA-1").stateId).toBe(DELIVER);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(h.workspaces.tokensFor("STA-1")).toMatchObject({ status: "deliver", progress: "pending" });
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 approved: Review+Complete → Deliver+Pending"));
    } finally {
      h.stop();
    }
  });

  test("send-back normalizes Review+Complete to Build+Pending", async () => {
    const h = await harness();
    try {
      await toReviewComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, BUILD);
      await watcherOf(h).pollOnce();
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 sent back: Review+Complete → Build+Pending"));
    } finally {
      h.stop();
    }
  });

  test("approval without a binding PASS receipt is refused, never normalized", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      // Owner hand-moves Build straight to Deliver with a stray Complete label.
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      await h.client.setIssueLabels(issueOf(h, "STA-1").id, [COMPLETE]);
      h.workspaces.reportMetadata(workspaceIdOf(h, "STA-1"), { status: "review", progress: "complete" });
      await watcherOf(h).pollOnce();
      // Left alone: the inherited Complete is not a Deliver completion.
      expect(issueOf(h, "STA-1").stateId).toBe(DELIVER);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      expect(h.lines).toContainEqual(expect.stringContaining("refusing"));
    } finally {
      h.stop();
    }
  });

  test("completion clears Progress and closes the workspace", async () => {
    const h = await harness();
    try {
      await toReviewComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      await watcherOf(h).pollOnce();
      await wsCmd(h, "STA-1", ["begin"]);
      await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(deliverPayload()));
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      await h.client.setIssueState(issueOf(h, "STA-1").id, DONE);
      await watcherOf(h).pollOnce();
      expect(issueOf(h, "STA-1").labelIds).toEqual([]);
      expect(h.workspaces.workspaces.find((w) => w.label === "STA-1")!.closed).toBe(true);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 done: Deliver+Complete → Done"));
    } finally {
      h.stop();
    }
  });

  test("completion removes the ticket worktree and branch after landing", async () => {
    const h = await harness();
    try {
      await toReviewComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      await watcherOf(h).pollOnce();
      await wsCmd(h, "STA-1", ["begin"]);
      await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(deliverPayload()));
      // The checkout the sink opened: listed on the ticket branch, clean,
      // checkpoint landed on the target branch.
      const derived = ticketWorktree(h.ctx.repoRoot, "STA-1");
      h.git.worktreeList =
        `worktree ${derived.path}\nHEAD ${HEAD}\nbranch refs/heads/${derived.branch}\n`;
      h.git.branches = [derived.branch];
      h.git.ancestors = new Set([`${HEAD} main`, `${derived.branch} main`]);
      await h.client.setIssueState(issueOf(h, "STA-1").id, DONE);
      await watcherOf(h).pollOnce();
      expect(issueOf(h, "STA-1").labelIds).toEqual([]);
      expect(h.workspaces.workspaces.find((w) => w.label === "STA-1")!.closed).toBe(true);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 done: Deliver+Complete → Done"));
      expect(h.lines).toContainEqual(expect.stringContaining("removed worktree and merged branch"));
      expect(h.git.worktreeList).not.toContain(derived.path);
      expect(h.git.branches).not.toContain(derived.branch);
      for (const cmd of h.git.commands) {
        expect(cmd.args).not.toContain("--force");
        expect(cmd.args).not.toContain("-D");
      }
    } finally {
      h.stop();
    }
  });

  test("completion keeps a dirty worktree but still lands Done", async () => {
    const h = await harness();
    try {
      await toReviewComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      await watcherOf(h).pollOnce();
      await wsCmd(h, "STA-1", ["begin"]);
      await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(deliverPayload()));
      const derived = ticketWorktree(h.ctx.repoRoot, "STA-1");
      h.git.worktreeList =
        `worktree ${derived.path}\nHEAD ${HEAD}\nbranch refs/heads/${derived.branch}\n`;
      h.git.branches = [derived.branch];
      h.git.ancestors = new Set([`${HEAD} main`, `${derived.branch} main`]);
      h.git.statusPorcelain = " M feature.txt\n";
      await h.client.setIssueState(issueOf(h, "STA-1").id, DONE);
      await watcherOf(h).pollOnce();
      expect(issueOf(h, "STA-1").labelIds).toEqual([]);
      expect(h.workspaces.workspaces.find((w) => w.label === "STA-1")!.closed).toBe(true);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 done: Deliver+Complete → Done"));
      expect(h.lines).toContainEqual(expect.stringContaining("uncommitted changes"));
      expect(h.git.worktreeList).toContain(derived.path);
      expect(h.git.branches).toContain(derived.branch);
    } finally {
      h.stop();
    }
  });
});

describe("dispatch commands", () => {
  test("pause shares the block transition and resume shares unblock", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      expect((await runCommand(["pause", "STA-1"], h.ctx)).ok).toBe(true);
      expect(issueOf(h, "STA-1").labelIds).toEqual([BLOCKED]);
      expect(h.workspaces.tokensFor("STA-1")).toMatchObject({ paused: "1", block_reason: "owner pause" });
      const inbox = h.workspaces.promptsFor("commander-sta-1");
      expect(inbox.at(-1)).toContain("the owner paused this ticket");
      expect((await runCommand(["resume", "STA-1"], h.ctx)).ok).toBe(true);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(h.workspaces.tokensFor("STA-1")).not.toHaveProperty("paused");
    } finally {
      h.stop();
    }
  });

  test("resume on an active ticket with a live commander reports already running", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      const before = h.workspaces.agents.length;
      const out = await runCommand(["resume", "STA-1"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("already running");
      expect(h.workspaces.agents).toHaveLength(before);
      expect(issueOf(h, "STA-1").labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("fail returns the ticket to Backlog with Progress cleared", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      const out = await runCommand(["fail", "STA-1", "--reason", "wedged"], h.ctx);
      expect(out.ok).toBe(true);
      expect(issueOf(h, "STA-1").stateId).toBe(BACKLOG);
      expect(issueOf(h, "STA-1").labelIds).toEqual(
        [h.world.labels.find((l) => l.name === "agent-failed")!.id],
      );
      expect(h.workspaces.workspaces.find((w) => w.label === "STA-1")!.closed).toBe(true);
    } finally {
      h.stop();
    }
  });

  test("status shows slots, status/progress, checkpoint, and receipt", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      const building = await runCommand(["status"], h.ctx);
      expect(building.ok).toBe(true);
      expect(building.text).toContain("1 / 3 slots");
      expect(building.text).toContain("STA-1  Build/In progress");
      await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(buildPayload()));
      // Review holds no Build slot.
      const out = await runCommand(["status"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("0 / 3 slots");
      expect(out.text).toContain("STA-1");
      expect(out.text).toContain("Review");
      const data = out.data as { slots: { used: number; max: number }; tickets: Record<string, unknown>[] };
      expect(data.slots).toEqual({ used: 0, max: 3 });
      expect(data.tickets[0]).toMatchObject({ identifier: "STA-1", progress: "pending", checkpoint: HEAD });
    } finally {
      h.stop();
    }
  });

  test("start and begin do not collide; resume and unblock do not collide", async () => {
    const h = await harness();
    try {
      await claim(h, "STA-1");
      // begin takes no ticket: a ticket argument is a usage error.
      expect((await wsCmd(h, "STA-1", ["begin"])).ok).toBe(false); // Build+In progress: precondition refusal
      const wsId = workspaceIdOf(h, "STA-1");
      expect((await runCommand(["begin", "STA-1"], h.ctx, { workspaceId: wsId })).ok).toBe(false);
      expect((await runCommand(["unblock"], h.ctx, { workspaceId: wsId })).ok).toBe(false);
      expect((await runCommand(["resume"], h.ctx)).ok).toBe(false);
    } finally {
      h.stop();
    }
  });
});
