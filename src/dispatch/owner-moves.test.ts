// Owner transitions rebuilt on the Linear protocol state (STA-197): every
// legal move converges from Linear status plus Progress plus the newest
// valid YAML receipt alone — no workspace metadata, no Commander session,
// no Herdr snapshot. No network, no real credentials, no real project.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceSink,
  runCommand,
  type CommandContext,
} from "./commands";
import { Watcher, validateStartup, type ResolvedDispatch } from "./claims";
import { parseDispatchConfig } from "./config";
import { LinearClient, LinearError } from "./linear";
import {
  latestValidReceipt,
  normalizeOwnerMove,
  parseReceiptBlock,
  receiptBlock,
} from "./protocol";
import { addIssue, standardWorld, startFakeLinear } from "./fake-linear";
import { FakeGit } from "./fake-git";
import { FakeWorkspaces } from "./fake-workspaces";

const BUILD = "st-build";
const REVIEW = "st-review";
const DELIVER = "st-deliver";
const DONE = "st-done";
const TODO = "st-todo";
const PENDING = "label-pending";
const IN_PROGRESS = "label-in-progress";
const COMPLETE = "label-complete";
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
  const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url, fetchImpl: fake.fetchImpl });
  const resolved = await validateStartup(
    client,
    parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: maxRunning }),
  );
  const lines: string[] = [];
  const workspaces = new FakeWorkspaces();
  const git = new FakeGit();
  git.head = HEAD;
  const repoRoot = join(mkdtempSync(join(tmpdir(), "igniter-owner-")), "repo");
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

function deliverPayload(head = HEAD, landed = head) {
  return {
    v: 1,
    kind: "deliver",
    checkpoint: head,
    landed,
    lineage: "abc123 deliver work",
    merge_ready: true,
    owner_actions: ["push the branch"],
  };
}

/** Seed a Linear-only receipt comment, the way a previous process left it. */
let seedClock = 0;
function seedReceipt(
  h: Harness,
  identifier: string,
  kind: "build" | "review-pass" | "review-fail" | "deliver",
  checkpoint = HEAD,
  submission = "sub-seed-00000001",
): string {
  seedClock += 1;
  const id = `comment-seed-${issueOf(h, identifier).comments.length + 1}`;
  issueOf(h, identifier).comments.push({
    id,
    body: `prior report\n\n${receiptBlock(kind, checkpoint, submission, kind === "deliver" ? checkpoint : undefined)}\n`,
    createdAt: `2026-09-04T00:00:00.${String(seedClock).padStart(6, "0")}Z`,
  });
  return id;
}

function seedLineage(h: Harness, identifier: string, checkpoint = HEAD): void {
  h.git.ancestors.add(`${checkpoint} feature/${identifier.toLowerCase()}`);
  h.git.ancestors.add(`${checkpoint} main`);
}

function wsIdOf(h: Harness, identifier: string): string {
  const workspace = h.workspaces.workspaces.find((w) => w.label === identifier && !w.closed);
  if (!workspace) throw new Error(`no workspace for ${identifier}`);
  return workspace.workspaceId;
}

async function wsCmd(h: Harness, identifier: string, argv: string[], input?: string) {
  if (argv[0] === "begin") {
    const started = await runCommand(["worker", "start", identifier], h.ctx);
    if (!started.ok) return started;
  }
  return runCommand(argv, h.ctx, { workspaceId: wsIdOf(h, identifier), input });
}

/** Claim through `start`, submit the first Build, and hand it to Review: the owner moves Build+Complete to Review and an explicit reconcile converges it. */
async function toReviewComplete(h: Harness, identifier: string): Promise<void> {
  addIssue(h.world, { identifier, stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
  expect((await runCommand(["worker", "start", identifier], h.ctx)).ok).toBe(true);
  expect((await runCommand(["begin", identifier], h.ctx)).ok).toBe(true);
  expect((await wsCmd(h, identifier, ["submit", "--input", "-"], JSON.stringify(buildPayload()))).ok).toBe(true);
  expect(issueOf(h, identifier).stateId).toBe(BUILD);
  expect(issueOf(h, identifier).labelIds).toEqual([COMPLETE]);
  seedLineage(h, identifier);
  await h.client.setIssueState(issueOf(h, identifier).id, REVIEW);
  expect((await runCommand(["reconcile", identifier], h.ctx)).ok).toBe(true);
  expect(issueOf(h, identifier).labelIds).toEqual([PENDING]);
  expect((await wsCmd(h, identifier, ["begin"])).ok).toBe(true);
  expect((await wsCmd(h, identifier, ["submit", "--input", "-"], JSON.stringify(reviewPayload("pass")))).ok).toBe(true);
  seedLineage(h, identifier);
}

describe("owner transitions from Linear state", () => {
  test("Review+Complete with a review-pass receipt waits silently for the owner", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: REVIEW, priority: 1, description: CRITERIA, labelIds: [COMPLETE] });
      seedReceipt(h, "STA-1", "review-pass");
      seedLineage(h, "STA-1");
      await watcherOf(h).pollOnce();
      // Kept as is: the owner still owns it. Adoption may reopen a
      // workspace, but the transition itself records no line.
      expect(issueOf(h, "STA-1").stateId).toBe(REVIEW);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      expect(h.lines.some((l) => /approved|sent back|refusing|failed/.test(l))).toBe(false);
    } finally {
      h.stop();
    }
  });

  test("approval converges with no workspace metadata at all", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: REVIEW, priority: 1, description: CRITERIA, labelIds: [COMPLETE] });
      seedReceipt(h, "STA-1", "review-pass");
      seedLineage(h, "STA-1");
      // A fresh process: empty workspaces, no tokens anywhere.
      h.workspaces.workspaces = [];
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      await watcherOf(h).pollOnce();
      expect(issueOf(h, "STA-1").stateId).toBe(DELIVER);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 approved: Review+Complete → Deliver+Pending"));
    } finally {
      h.stop();
    }
  });

  test("a restarted process converges the approval from Linear alone", async () => {
    const h = await harness();
    try {
      await toReviewComplete(h, "STA-1");
      // Owner approves while dispatch is down.
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      // Restart: fresh workspaces, fresh git, fresh decisions, same Linear.
      const workspaces = new FakeWorkspaces();
      const git = new FakeGit();
      git.head = HEAD;
      git.ancestors.add(`${HEAD} feature/sta-1`);
      const lines: string[] = [];
      const restarted = new Watcher({
        client: h.client,
        resolved: h.resolved,
        host: "h",
        sink: createWorkspaceSink({ workspaces, config: h.resolved.config, repoRoot: h.ctx.repoRoot, runGit: git }),
        decisions: {
          record: async (ticket, message) => {
            lines.push(`${ticket} ${message}`);
          },
        },
        workspaces,
        git,
        repoRoot: h.ctx.repoRoot,
      });
      await restarted.pollOnce();
      expect(issueOf(h, "STA-1").stateId).toBe(DELIVER);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(lines).toContainEqual(expect.stringContaining("STA-1 approved: Review+Complete → Deliver+Pending"));
      // The reopened workspace mirrors the converged Linear state.
      expect(workspaces.tokensFor("STA-1")).toMatchObject({ status: "deliver", progress: "pending", checkpoint: HEAD });
    } finally {
      h.stop();
    }
  });

  test("a missing workspace never blocks convergence", async () => {
    const h = await harness();
    try {
      await toReviewComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      h.workspaces.workspaces = [];
      const failing = new Watcher({
        client: h.client,
        resolved: h.resolved,
        host: "h",
        sink: async () => {
          throw new Error("herdr gone");
        },
        decisions: h.ctx.decisions,
        workspaces: h.workspaces,
        git: h.git,
        repoRoot: h.ctx.repoRoot,
      });
      await failing.pollOnce();
      expect(issueOf(h, "STA-1").stateId).toBe(DELIVER);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 approved: Review+Complete → Deliver+Pending"));
      expect(h.lines).toContainEqual(expect.stringContaining("Linear converged without it"));
    } finally {
      h.stop();
    }
  });

  test("send-back converges to Build+Pending for pass and fail receipts", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [COMPLETE] });
      seedReceipt(h, "STA-1", "review-pass");
      seedLineage(h, "STA-1");
      addIssue(h.world, { identifier: "STA-2", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [COMPLETE] });
      seedReceipt(h, "STA-2", "review-fail", HEAD, "sub-seed-00000002");
      seedLineage(h, "STA-2");
      await watcherOf(h).pollOnce();
      for (const id of ["STA-1", "STA-2"]) {
        expect(issueOf(h, id).stateId).toBe(BUILD);
        expect(issueOf(h, id).labelIds).toEqual([PENDING]);
      }
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 sent back: Review+Complete → Build+Pending"));
      expect(h.lines).toContainEqual(expect.stringContaining("STA-2 sent back: Review+Complete → Build+Pending"));
    } finally {
      h.stop();
    }
  });

  test("Deliver+Complete with a deliver receipt waits; Done clears Progress", async () => {
    const h = await harness();
    try {
      await toReviewComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      await watcherOf(h).pollOnce();
      await wsCmd(h, "STA-1", ["begin"]);
      expect((await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(deliverPayload()))).ok).toBe(true);
      const at = h.lines.length;
      await watcherOf(h).pollOnce();
      // A fresh delivery is never misread as a fresh approval: Linear is kept, no line.
      expect(issueOf(h, "STA-1").stateId).toBe(DELIVER);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      expect(h.lines.slice(at).filter((l) => l.startsWith("STA-1"))).toEqual([]);
      // The owner lands and moves to Done: Progress is removed.
      await h.client.setIssueState(issueOf(h, "STA-1").id, DONE);
      await watcherOf(h).pollOnce();
      expect(issueOf(h, "STA-1").stateId).toBe(DONE);
      expect(issueOf(h, "STA-1").labelIds).toEqual([]);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 done: Deliver+Complete → Done"));
    } finally {
      h.stop();
    }
  });

  test("stale checkpoints refuse with a diagnosis and keep Linear", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: DELIVER, priority: 1, description: CRITERIA, labelIds: [COMPLETE] });
      seedReceipt(h, "STA-1", "review-pass", "replaced-commit");
      // No lineage for the receipt checkpoint: the branch moved on.
      await watcherOf(h).pollOnce();
      expect(issueOf(h, "STA-1").stateId).toBe(DELIVER);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1"));
      expect(h.lines).toContainEqual(expect.stringContaining("stale"));
    } finally {
      h.stop();
    }
  });

  test("a delivered ticket is not judged stale after the rebase rewrote its branch", async () => {
    const h = await harness();
    try {
      await toReviewComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      await watcherOf(h).pollOnce();
      await wsCmd(h, "STA-1", ["begin"]);
      // Deliver rebased and landed the new tip: the approved SHA no longer
      // binds the rewritten branch, but the landed SHA reads back from main.
      const rebased = "bbbbbbbbbbbbbbbb";
      h.git.ancestors.add(`${rebased} main`);
      expect((await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(deliverPayload(HEAD, rebased)))).ok).toBe(true);
      const at = h.lines.length;
      await watcherOf(h).pollOnce();
      // Deliver+Complete with a deliver receipt waits for the owner: no
      // fresh approval, no stale refusal, no label rollback.
      expect(issueOf(h, "STA-1").stateId).toBe(DELIVER);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      expect(h.lines.slice(at).some((l) => l.includes("approved"))).toBe(false);
      expect(h.lines.slice(at).some((l) => l.includes("stale"))).toBe(false);
      // The owner confirms the landing: Done cleanup verifies the landed
      // commit, not the approved checkpoint left behind by the rebase.
      await h.client.setIssueState(issueOf(h, "STA-1").id, DONE);
      await watcherOf(h).pollOnce();
      expect(issueOf(h, "STA-1").stateId).toBe(DONE);
      expect(issueOf(h, "STA-1").labelIds).toEqual([]);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 done: Deliver+Complete → Done"));
      expect(h.lines).toContainEqual(expect.stringContaining(rebased));
    } finally {
      h.stop();
    }
  });

  test("kind mismatches and missing receipts refuse with a diagnosis", async () => {
    const h = await harness();
    try {
      // Deliver+Complete bound to a build receipt: not an approval.
      addIssue(h.world, { identifier: "STA-1", stateId: DELIVER, priority: 1, description: CRITERIA, labelIds: [COMPLETE] });
      seedReceipt(h, "STA-1", "build");
      seedLineage(h, "STA-1");
      // Review+Complete bound to a deliver receipt: not a completed review.
      addIssue(h.world, { identifier: "STA-2", stateId: REVIEW, priority: 1, description: CRITERIA, labelIds: [COMPLETE] });
      seedReceipt(h, "STA-2", "deliver", HEAD, "sub-seed-00000002");
      seedLineage(h, "STA-2");
      // Done still carrying Progress without a delivery receipt.
      addIssue(h.world, { identifier: "STA-3", stateId: DONE, priority: 1, description: CRITERIA, labelIds: [COMPLETE] });
      seedReceipt(h, "STA-3", "review-pass", HEAD, "sub-seed-00000003");
      // Deliver+Complete with no receipt at all.
      addIssue(h.world, { identifier: "STA-4", stateId: DELIVER, priority: 1, description: CRITERIA, labelIds: [COMPLETE] });
      await watcherOf(h).pollOnce();
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      expect(issueOf(h, "STA-2").labelIds).toEqual([COMPLETE]);
      expect(issueOf(h, "STA-3").labelIds).toEqual([COMPLETE]);
      expect(issueOf(h, "STA-4").labelIds).toEqual([COMPLETE]);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1"));
      expect(h.lines).toContainEqual(expect.stringContaining("only a review-pass approval converges here"));
      expect(h.lines).toContainEqual(expect.stringContaining("only a completed Build handoff or passing review belongs here"));
      expect(h.lines).toContainEqual(expect.stringContaining("lands the delivery first"));
      expect(h.lines).toContainEqual(expect.stringContaining("holds no valid Igniter receipt"));
    } finally {
      h.stop();
    }
  });

  test("an invalid newest receipt falls back to the older valid one", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: DELIVER, priority: 1, description: CRITERIA, labelIds: [COMPLETE] });
      seedReceipt(h, "STA-1", "review-pass");
      seedLineage(h, "STA-1");
      // A newer comment with two receipt blocks is invalid and skipped.
      const block = receiptBlock("deliver", HEAD, "sub-broken-0000001", HEAD);
      issueOf(h, "STA-1").comments.push({
        id: "comment-broken",
        body: `note\n\n${block}\n${block}\n`,
        createdAt: "2026-09-04T00:00:00.000099Z",
      });
      await watcherOf(h).pollOnce();
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 approved: Review+Complete → Deliver+Pending"));
    } finally {
      h.stop();
    }
  });

  test("normalizeOwnerMove is quiet on worker-owned states", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      seedReceipt(h, "STA-1", "build");
      const full = await h.client.fetchIssue(issueOf(h, "STA-1").id);
      if (!full) throw new Error("missing issue");
      const outcome = await normalizeOwnerMove(
        {
          client: h.client,
          resolved: h.resolved,
          workspaces: h.workspaces,
          decisions: h.ctx.decisions,
          git: h.git,
          repoRoot: h.ctx.repoRoot,
        },
        full as Parameters<typeof normalizeOwnerMove>[1],
      );
      expect(outcome.result).toBeNull();
      expect(issueOf(h, "STA-1").labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });
});

describe("mirror failures never block convergence", () => {
  test("a failed mirror still converges; the next poll retries it", async () => {
    const h = await harness();
    try {
      await toReviewComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      h.workspaces.failMethods.add("workspace.report_metadata");
      const watcher = watcherOf(h);
      await watcher.pollOnce();
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 approved: Review+Complete → Deliver+Pending"));
      expect(h.lines).toContainEqual(expect.stringContaining("workspace mirror failed"));
      // The failed mirror left the stale tokens behind.
      expect(h.workspaces.tokensFor("STA-1")).not.toHaveProperty("status");
      // Herdr recovers: the next poll heals the mirror without touching Linear.
      h.workspaces.failMethods.clear();
      const at = h.lines.length;
      await watcher.pollOnce();
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(h.lines.slice(at)).toContainEqual(expect.stringContaining("workspace mirror caught up"));
      expect(h.workspaces.tokensFor("STA-1")).toMatchObject({ status: "deliver", progress: "pending" });
    } finally {
      h.stop();
    }
  });

  test("a failed Done close still lands; the next poll retries it", async () => {
    const h = await harness();
    try {
      await toReviewComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      await watcherOf(h).pollOnce();
      await wsCmd(h, "STA-1", ["begin"]);
      expect((await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(deliverPayload()))).ok).toBe(true);
      await h.client.setIssueState(issueOf(h, "STA-1").id, DONE);
      h.workspaces.failMethods.add("workspace.close");
      const watcher = watcherOf(h);
      await watcher.pollOnce();
      expect(issueOf(h, "STA-1").labelIds).toEqual([]);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 done: Deliver+Complete → Done"));
      expect(h.lines).toContainEqual(expect.stringContaining("workspace close failed"));
      const ws = h.workspaces.workspaces.find((w) => w.label === "STA-1")!;
      expect(ws.closed).toBe(false);
      h.workspaces.failMethods.clear();
      const at = h.lines.length;
      await watcher.pollOnce();
      expect(ws.closed).toBe(true);
      expect(h.lines.slice(at)).toContainEqual(expect.stringContaining("workspace closed on retry"));
      expect(issueOf(h, "STA-1").labelIds).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("an unreachable Herdr still converges; the next poll heals mirror and close", async () => {
    const h = await harness();
    try {
      await toReviewComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      h.workspaces.failMethods.add("snapshot");
      const watcher = watcherOf(h);
      await watcher.pollOnce();
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 approved: Review+Complete → Deliver+Pending"));
      expect(h.lines).toContainEqual(expect.stringContaining("mirror deferred: herdr unreachable"));
      // Herdr recovers: the retry locates the workspace by ticket and heals it.
      h.workspaces.failMethods.clear();
      const at = h.lines.length;
      await watcher.pollOnce();
      expect(h.lines.slice(at)).toContainEqual(expect.stringContaining("workspace mirror caught up"));
      expect(h.workspaces.tokensFor("STA-1")).toMatchObject({ status: "deliver", progress: "pending" });
    } finally {
      h.stop();
    }
  });

  test("an owner move converges the mirror with no commander to wake", async () => {
    const h = await harness();
    try {
      await toReviewComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      h.workspaces.failMethods.add("agent.prompt");
      const watcher = watcherOf(h);
      await watcher.pollOnce();
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      // Igniter starts no agents: the mirror converges and notes that no
      // commander exists for a wake-up. The external Global Commander
      // observes the converged state through status/reconcile.
      expect(h.lines).toContainEqual(expect.stringContaining("workspace mirror caught up"));
      expect(h.lines).toContainEqual(expect.stringContaining("no commander to wake"));
      expect(h.workspaces.tokensFor("STA-1")).toMatchObject({ status: "deliver", progress: "pending" });
      h.workspaces.failMethods.clear();
      const at = h.lines.length;
      await watcher.pollOnce();
      expect(h.lines.slice(at)).not.toContainEqual(expect.stringContaining("wake-up"));
    } finally {
      h.stop();
    }
  });

  test("a close retry drops when Linear moved on", async () => {
    const h = await harness();
    try {
      await toReviewComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      await watcherOf(h).pollOnce();
      await wsCmd(h, "STA-1", ["begin"]);
      expect((await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(deliverPayload()))).ok).toBe(true);
      await h.client.setIssueState(issueOf(h, "STA-1").id, DONE);
      h.workspaces.failMethods.add("workspace.close");
      const watcher = watcherOf(h);
      await watcher.pollOnce();
      const ws = h.workspaces.workspaces.find((w) => w.label === "STA-1")!;
      expect(ws.closed).toBe(false);
      // The ticket leaves Done before the retry: the close must not fire.
      issueOf(h, "STA-1").stateId = BUILD;
      issueOf(h, "STA-1").labelIds = [PENDING];
      h.workspaces.failMethods.clear();
      const at = h.lines.length;
      await watcher.pollOnce();
      expect(ws.closed).toBe(false);
      expect(h.lines.slice(at)).toContainEqual(expect.stringContaining("close retry dropped: Linear moved on"));
    } finally {
      h.stop();
    }
  });

  test("an identical refusal records one line, not one per poll", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: DELIVER, priority: 1, description: CRITERIA, labelIds: [COMPLETE] });
      const watcher = watcherOf(h);
      await watcher.pollOnce();
      const first = h.lines.filter((l) => l.includes("holds no valid Igniter receipt"));
      expect(first).toHaveLength(1);
      await watcher.pollOnce();
      await watcher.pollOnce();
      expect(h.lines.filter((l) => l.includes("holds no valid Igniter receipt"))).toHaveLength(1);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
    } finally {
      h.stop();
    }
  });
});

describe("submission retries", () => {
  test("a lost write result converges on retry without a second receipt", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      expect((await runCommand(["worker", "start", "STA-1"], h.ctx)).ok).toBe(true);
      expect((await runCommand(["begin", "STA-1"], h.ctx)).ok).toBe(true);
      const realAdd = h.client.addComment.bind(h.client);
      let calls = 0;
      h.client.addComment = (async (issueId: string, body: string) => {
        calls += 1;
        if (calls <= 2) throw new LinearError(500, "boom");
        return realAdd(issueId, body);
      }) as typeof h.client.addComment;
      const payload = JSON.stringify(buildPayload());
      const first = await wsCmd(h, "STA-1", ["submit", "--input", "-"], payload);
      expect(first.ok).toBe(false);
      const second = await wsCmd(h, "STA-1", ["submit", "--input", "-"], payload);
      expect(second.ok).toBe(true);
      // Mutation front and back both read back: exactly one receipt comment.
      const receipts = issueOf(h, "STA-1").comments.filter((c) => parseReceiptBlock(c.body) !== null);
      expect(receipts).toHaveLength(1);
      expect(parseReceiptBlock(receipts[0]!.body)).toMatchObject({ kind: "build", checkpoint: HEAD });
      expect(issueOf(h, "STA-1").stateId).toBe(BUILD);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
    } finally {
      h.stop();
    }
  });

  test("a landed-but-unconfirmed receipt is adopted on retry, never duplicated", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      expect((await runCommand(["worker", "start", "STA-1"], h.ctx)).ok).toBe(true);
      expect((await runCommand(["begin", "STA-1"], h.ctx)).ok).toBe(true);
      // The comment lands, then the write result is lost: the retry must
      // read it back and adopt it instead of publishing a second receipt.
      const realAdd = h.client.addComment.bind(h.client);
      let calls = 0;
      h.client.addComment = (async (issueId: string, body: string) => {
        calls += 1;
        const id = await realAdd(issueId, body);
        if (calls === 1) throw new LinearError(500, "lost result");
        return id;
      }) as typeof h.client.addComment;
      const payload = JSON.stringify(buildPayload());
      // The lost result never surfaces: the post-write read-back adopts the
      // landed receipt inside the same submit.
      expect((await wsCmd(h, "STA-1", ["submit", "--input", "-"], payload)).ok).toBe(true);
      const repeated = await wsCmd(h, "STA-1", ["submit", "--input", "-"], payload);
      expect(repeated.ok).toBe(true);
      expect(repeated.text).toContain("already submitted build");
      const receipts = issueOf(h, "STA-1").comments.filter((c) => parseReceiptBlock(c.body) !== null);
      expect(receipts).toHaveLength(1);
      expect(issueOf(h, "STA-1").stateId).toBe(BUILD);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
    } finally {
      h.stop();
    }
  });
});

describe("multi-receipt tickets read newest-first", () => {
  const HEAD2 = "cafef00dcafe0002";

  /** Build, hand to Review, fail the review, rebuild at a new checkpoint, pass the review. */
  async function toSecondPass(h: Harness, identifier: string): Promise<void> {
    addIssue(h.world, { identifier, stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
    expect((await runCommand(["worker", "start", identifier], h.ctx)).ok).toBe(true);
    expect((await runCommand(["begin", identifier], h.ctx)).ok).toBe(true);
    expect((await wsCmd(h, identifier, ["submit", "--input", "-"], JSON.stringify(buildPayload()))).ok).toBe(true);
    seedLineage(h, identifier);
    await h.client.setIssueState(issueOf(h, identifier).id, REVIEW);
    expect((await runCommand(["reconcile", identifier], h.ctx)).ok).toBe(true);
    expect((await wsCmd(h, identifier, ["begin"])).ok).toBe(true);
    expect((await wsCmd(h, identifier, ["submit", "--input", "-"], JSON.stringify(reviewPayload("fail")))).ok).toBe(true);
    h.git.head = HEAD2;
    expect((await wsCmd(h, identifier, ["begin"])).ok).toBe(true);
    // The correction submit returns straight to Review+Pending: no owner step.
    const corrected = await wsCmd(h, identifier, ["submit", "--input", "-"], JSON.stringify(buildPayload(HEAD2)));
    expect(corrected.ok).toBe(true);
    expect(corrected.text).toContain("→ Review+Pending");
    expect(issueOf(h, identifier).stateId).toBe(REVIEW);
    expect((await wsCmd(h, identifier, ["begin"])).ok).toBe(true);
    expect((await wsCmd(h, identifier, ["submit", "--input", "-"], JSON.stringify(reviewPayload("pass", HEAD2)))).ok).toBe(true);
    h.git.ancestors.add(`${HEAD2} feature/${identifier.toLowerCase()}`);
    h.git.ancestors.add(`${HEAD2} main`);
  }

  function receiptComments(h: Harness, identifier: string) {
    return issueOf(h, identifier).comments.filter((c) => parseReceiptBlock(c.body) !== null);
  }

  test("fetchIssue normalizes the newest-first wire order to chronological", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: REVIEW, priority: 1, description: CRITERIA, labelIds: [COMPLETE] });
      seedReceipt(h, "STA-1", "build", HEAD, "sub-old-0000000001");
      seedReceipt(h, "STA-1", "review-pass", HEAD, "sub-new-0000000002");
      const read = await h.client.fetchIssue(issueOf(h, "STA-1").id);
      // The wire serves newest first; the client sorts oldest first.
      expect(read!.comments.map((c) => c.id)).toEqual(["comment-seed-1", "comment-seed-2"]);
      expect(latestValidReceipt(read!.comments)).toMatchObject({ receipt: { submission: "sub-new-0000000002" } });
    } finally {
      h.stop();
    }
  });

  test("state reports the newest receipt after build, fail, rebuild", async () => {
    const h = await harness();
    try {
      await toSecondPass(h, "STA-1");
      const newest = receiptComments(h, "STA-1").at(-1)!;
      expect(receiptComments(h, "STA-1")).toHaveLength(4);
      const out = await wsCmd(h, "STA-1", ["state", "--json"]);
      expect(out.ok).toBe(true);
      const data = out.data as Record<string, unknown>;
      expect(data).toMatchObject({ status: "review", progress: "complete", checkpoint: HEAD2 });
      // Not the superseded first build receipt.
      expect(data["receipt"]).toMatchObject({
        kind: "review-pass",
        id: newest.id,
        checkpoint: HEAD2,
      });
    } finally {
      h.stop();
    }
  });

  test("approval converges on a ticket carrying build, fail, and pass receipts", async () => {
    const h = await harness();
    try {
      await toSecondPass(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      await watcherOf(h).pollOnce();
      expect(issueOf(h, "STA-1").stateId).toBe(DELIVER);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 approved: Review+Complete → Deliver+Pending"));
      expect(h.lines).toContainEqual(expect.stringContaining(HEAD2));
    } finally {
      h.stop();
    }
  });

  test("send-back converges on a ticket carrying build, fail, and pass receipts", async () => {
    const h = await harness();
    try {
      await toSecondPass(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, BUILD);
      await watcherOf(h).pollOnce();
      expect(issueOf(h, "STA-1").stateId).toBe(BUILD);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 sent back: Review+Complete → Build+Pending"));
    } finally {
      h.stop();
    }
  });

  test("a delivered ticket is not re-approved; Done clears Progress", async () => {
    const h = await harness();
    try {
      await toSecondPass(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      await watcherOf(h).pollOnce();
      await wsCmd(h, "STA-1", ["begin"]);
      expect((await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(deliverPayload(HEAD2)))).ok).toBe(true);
      const at = h.lines.length;
      await watcherOf(h).pollOnce();
      // The deliver receipt is newest: no fresh approval, no label rollback.
      expect(issueOf(h, "STA-1").stateId).toBe(DELIVER);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      expect(h.lines.slice(at).some((l) => l.includes("approved"))).toBe(false);
      await h.client.setIssueState(issueOf(h, "STA-1").id, DONE);
      await watcherOf(h).pollOnce();
      expect(issueOf(h, "STA-1").stateId).toBe(DONE);
      expect(issueOf(h, "STA-1").labelIds).toEqual([]);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 done: Deliver+Complete → Done"));
    } finally {
      h.stop();
    }
  });
});

describe("owner-move guards", () => {  async function outcomeOf(h: Harness, identifier: string) {
    const full = await h.client.fetchIssue(issueOf(h, identifier).id);
    if (!full) throw new Error("missing issue");
    return normalizeOwnerMove(
      {
        client: h.client,
        resolved: h.resolved,
        workspaces: h.workspaces,
        decisions: h.ctx.decisions,
        git: h.git,
        repoRoot: h.ctx.repoRoot,
      },
      full as Parameters<typeof normalizeOwnerMove>[1],
    );
  }

  test("multiple Progress labels fail closed through receipt convergence, never by picking one", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: DELIVER, priority: 1, description: CRITERIA, labelIds: [COMPLETE, PENDING] });
      seedReceipt(h, "STA-1", "review-pass");
      // No branch lineage for the receipt checkpoint: the repair refuses as
      // stale and the ticket parks as Deliver+Blocked with one diagnosis.
      const outcome = await outcomeOf(h, "STA-1");
      expect(outcome.result?.ok).toBe(false);
      expect(outcome.result?.text).toContain("parked as Deliver+Blocked");
      expect(issueOf(h, "STA-1").labelIds).toEqual(["label-blocked"]);
      const parked = issueOf(h, "STA-1").comments.filter((c) => c.body.includes("igniter:incomplete-state"));
      expect(parked).toHaveLength(1);
    } finally {
      h.stop();
    }
  });

  test("foreign projects and unknown statuses are ignored with a line", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "OTH-1", stateId: DELIVER, priority: 1, description: CRITERIA, projectId: "proj-2", labelIds: [COMPLETE] });
      const foreign = await outcomeOf(h, "OTH-1");
      expect(foreign.result?.text).toContain('not in project "igniter"');
      addIssue(h.world, { identifier: "STA-9", stateId: "st-canceled", priority: 1, description: CRITERIA, labelIds: [COMPLETE] });
      const unknown = await outcomeOf(h, "STA-9");
      expect(unknown.result?.text).toContain("unknown Linear status");
    } finally {
      h.stop();
    }
  });

  test("clean Done and worker-owned states stay quiet", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: DONE, priority: 1, description: CRITERIA, labelIds: [] });
      seedReceipt(h, "STA-1", "deliver");
      addIssue(h.world, { identifier: "STA-2", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      h.workspaces.seedWorkspace("STA-2", { ticket: "STA-2", status: "build", progress: "in_progress" });
      await watcherOf(h).pollOnce();
      expect(h.lines.some((l) => /approved|sent back|refusing|failed|dropped/.test(l))).toBe(false);
      expect(issueOf(h, "STA-1").labelIds).toEqual([]);
      expect(issueOf(h, "STA-2").labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("old HTML-only history never authorizes a transition", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: DELIVER, priority: 1, description: CRITERIA, labelIds: [COMPLETE] });
      issueOf(h, "STA-1").comments.push({
        id: "comment-old",
        body: "<!-- igniter:receipt review-pass head-1 sub-1 -->\nAgent acceptance: PASS\n",
        createdAt: "2026-09-04T00:00:00.000001Z",
      });
      seedLineage(h, "STA-1");
      await watcherOf(h).pollOnce();
      // The ticket must drain through a fresh YAML submit; the owner move waits.
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      expect(h.lines).toContainEqual(expect.stringContaining("holds no valid Igniter receipt"));
    } finally {
      h.stop();
    }
  });

  test("a superseding newer receipt refuses a stale-kind submit", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      expect((await runCommand(["worker", "start", "STA-1"], h.ctx)).ok).toBe(true);
      expect((await runCommand(["begin", "STA-1"], h.ctx)).ok).toBe(true);
      expect((await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(buildPayload()))).ok).toBe(true);
      seedLineage(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, REVIEW);
      expect((await runCommand(["reconcile", "STA-1"], h.ctx)).ok).toBe(true);
      await wsCmd(h, "STA-1", ["begin"]);
      // A planted newer receipt for another checkpoint moves history on. The
      // far-future stamp keeps it newest no matter how many comments earlier
      // tests published through the shared fake clock.
      issueOf(h, "STA-1").comments.push({
        id: "comment-planted",
        body: `note\n\n${receiptBlock("review-fail", "other-checkpoint", "sub-plant-00000001")}\n`,
        createdAt: "2026-09-05T00:00:00.000000Z",
      });
      const out = await wsCmd(h, "STA-1", ["submit", "--input", "-"], JSON.stringify(reviewPayload("pass")));
      expect(out.ok).toBe(false);
      expect(out.text).toContain("history moved on");
    } finally {
      h.stop();
    }
  });
});

describe("cli reads the Linear receipt", () => {
  test("state --json shows the Linear receipt when the workspace cache is empty", async () => {
    const h = await harness();
    try {
      await toReviewComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      await watcherOf(h).pollOnce();
      // Drop the cached receipt: the Linear comment still carries the truth.
      await h.workspaces.reportMetadata(wsIdOf(h, "STA-1"), {
        receipt_id: null,
        receipt_kind: null,
        submission: null,
        checkpoint: null,
      });
      const out = await wsCmd(h, "STA-1", ["state", "--json"]);
      expect(out.ok).toBe(true);
      const data = out.data as Record<string, unknown>;
      expect(data).toMatchObject({ status: "deliver", progress: "pending", checkpoint: HEAD });
      expect(data["receipt"]).toMatchObject({ kind: "review-pass", checkpoint: HEAD });
      expect(typeof (data["receipt"] as Record<string, unknown>)["submission"]).toBe("string");
    } finally {
      h.stop();
    }
  });

  test("state --json prefers the older valid receipt over a malformed newest", async () => {
    const h = await harness();
    try {
      await toReviewComplete(h, "STA-1");
      // A malformed newest comment never shadows the valid receipt beneath it.
      const block = receiptBlock("review-pass", HEAD, "sub-broken-0000001");
      issueOf(h, "STA-1").comments.push({
        id: "comment-broken",
        body: `note\n\n${block}\n${block}\n`,
        createdAt: "2026-09-04T00:00:00.000099Z",
      });
      await h.workspaces.reportMetadata(wsIdOf(h, "STA-1"), {
        receipt_id: null,
        receipt_kind: null,
        submission: null,
        checkpoint: null,
      });
      const out = await wsCmd(h, "STA-1", ["state", "--json"]);
      expect(out.ok).toBe(true);
      const data = out.data as Record<string, unknown>;
      expect(data["receipt"]).toMatchObject({ kind: "review-pass", checkpoint: HEAD });
    } finally {
      h.stop();
    }
  });

  test("status lists the Linear receipt", async () => {
    const h = await harness();
    try {
      await toReviewComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      await watcherOf(h).pollOnce();
      const out = await runCommand(["status"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("STA-1  Deliver/");
      expect(out.text).toContain("receipt review-pass:comment-");
    } finally {
      h.stop();
    }
  });
});
