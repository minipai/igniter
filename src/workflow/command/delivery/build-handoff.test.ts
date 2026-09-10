// First-Build owner handoff and correction auto-return (STA-223).
//
// The first Build submit rests at Build+Complete for owner acceptance;
// only the owner's move to Review plus an explicit reconcile hands
// it to Review+Pending. A correction Build — after a Review FAIL or after
// the owner sends Review+Complete back to Build — returns straight to
// Review+Pending with no further owner step. Classification reads the
// Linear receipt history before the submission itself, so a retry never
// changes it, and reconcile without an owner move keeps Build+Complete
// still. Offline against the fake Linear endpoint: no real credentials, no
// real provider, no real project.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCommand,
  type CommandContext,
} from "../commands";
import { validateStartup, type ResolvedDispatch } from "../../config/claims";
import { parseDispatchConfig } from "../../config/config";
import { LinearClient } from "../../service/linear/linear";
import { latestValidReceipt, parseReceiptBlock } from "../ticket/protocol";
import { addIssue, standardWorld, startFakeLinear } from "../../service/linear/fake-linear";
import { FakeGit } from "../../testing/fake-git";
import { FakeWorkspaces } from "../../testing/fake-workspaces";

const BUILD = "st-build";
const REVIEW = "st-review";
const TODO = "st-todo";
const PENDING = "label-pending";
const IN_PROGRESS = "label-in-progress";
const COMPLETE = "label-complete";
const CRITERIA = "## 驗收條件\n- [ ] works\n- [ ] shines\n";
const HEAD = "deadbeefcafe0001";
const HEAD2 = "cafef00dcafe0002";

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
  const repoRoot = join(mkdtempSync(join(tmpdir(), "igniter-handoff-")), "repo");
  const ctx: CommandContext = {
    client,
    resolved,
    decisions: {
      record: async (ticket, message) => {
        lines.push(`${ticket} ${message}`);
      },
    },
    workspaces,
    repoRoot,
    git,
  };
  return { ctx, lines, workspaces, git, client, resolved, world, stop: () => fake.stop() };
}

function issueOf(h: Harness, identifier: string) {
  const issue = h.world.issues.find((i) => i.identifier === identifier);
  if (!issue) throw new Error(`no such issue ${identifier}`);
  return issue;
}

async function ticketCommand(
  h: Harness,
  identifier: string,
  action: "begin" | "submit" | "status" | "block" | "unblock",
  value?: string,
) {
  if (action === "begin") {
    const started = await runCommand({ command: "worker.start", ticket: identifier }, h.ctx);
    if (!started.ok) return started;
  }
  if (action === "submit") return runCommand({ command: "submit", ticket: identifier, payload: JSON.parse(value!) }, h.ctx);
  if (action === "status") return runCommand({ command: "status", ticket: identifier, json: true }, h.ctx);
  if (action === "block") return runCommand({ command: "block", ticket: identifier, reason: value! }, h.ctx);
  if (action === "unblock") return runCommand({ command: "unblock", ticket: identifier }, h.ctx);
  return runCommand({ command: "begin", ticket: identifier }, h.ctx);
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

function seedLineage(h: Harness, identifier: string, checkpoint = HEAD): void {
  h.git.ancestors.add(`${checkpoint} feature/${identifier.toLowerCase()}`);
  h.git.ancestors.add(`${checkpoint} main`);
}

/** Start a worker, then record Todo+Pending becoming Build+In progress. */
async function startBuild(h: Harness, identifier: string): Promise<void> {
  addIssue(h.world, { identifier, stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
  expect((await runCommand({ command: "worker.start", ticket: identifier }, h.ctx)).ok).toBe(true);
  expect((await runCommand({ command: "begin", ticket: identifier }, h.ctx)).ok).toBe(true);
}

/** First Build submit: rests at Build+Complete with one build receipt. */
async function initialSubmit(h: Harness, identifier: string, head = HEAD): Promise<void> {
  const out = await ticketCommand(h, identifier, "submit", JSON.stringify(buildPayload(head)));
  expect(out.ok).toBe(true);
  expect(out.text).toContain("→ Build+Complete");
  expect(issueOf(h, identifier).stateId).toBe(BUILD);
  expect(issueOf(h, identifier).labelIds).toEqual([COMPLETE]);
}

/** Owner handoff: the owner moves Build+Complete to Review, an explicit reconcile converges it. */
async function ownerHandoff(h: Harness, identifier: string): Promise<void> {
  seedLineage(h, identifier);
  await h.client.setIssueState(issueOf(h, identifier).id, REVIEW);
  expect(issueOf(h, identifier).labelIds).toEqual([COMPLETE]);
  const reconciled = await runCommand({ command: "reconcile", ticket: identifier }, h.ctx);
  expect(reconciled.ok).toBe(true);
  expect(reconciled.text).toContain("Build+Complete → Review+Pending");
  expect(issueOf(h, identifier).stateId).toBe(REVIEW);
  expect(issueOf(h, identifier).labelIds).toEqual([PENDING]);
}

function receiptBodies(h: Harness, identifier: string): string[] {
  return issueOf(h, identifier).comments
    .map((c) => {
      try {
        return parseReceiptBlock(c.body) !== null ? c.body : null;
      } catch {
        return null;
      }
    })
    .filter((b): b is string => b !== null);
}

describe("initial Build handoff", () => {
  test("the first submit publishes its receipt and waits at Build+Complete with no Acceptance agent", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      await initialSubmit(h, "STA-1");
      expect(receiptBodies(h, "STA-1")).toHaveLength(1);
      expect(latestValidReceipt(issueOf(h, "STA-1").comments)).toMatchObject({
        receipt: { kind: "build", checkpoint: HEAD },
      });
      // No Acceptance worker exists and none can start: begin needs Pending.
      expect(h.workspaces.agents.some((a) => a.name === "reviewer-sta-1")).toBe(false);
      expect((await ticketCommand(h, "STA-1", "begin")).ok).toBe(false);
      expect(h.workspaces.agents.some((a) => a.name === "reviewer-sta-1")).toBe(false);
      const state = (await ticketCommand(h, "STA-1", "status")).data as Record<string, unknown>;
      expect(state).toMatchObject({ status: "build", progress: "complete", next: ["approve"] });
    } finally {
      h.stop();
    }
  });

  test("repeated reconciles without the owner move keep Build+Complete still and silent", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      await initialSubmit(h, "STA-1");
      // The submit verified the worktree HEAD, so the branch carries the
      // receipt checkpoint; the handoff gate reads the same lineage.
      seedLineage(h, "STA-1");
      const commentsBefore = issueOf(h, "STA-1").comments.length;
      for (let i = 0; i < 3; i += 1) {
        const reconciled = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
        expect(reconciled.ok).toBe(true);
        expect(reconciled.text).toContain("no owner transition to reconcile (build+complete)");
      }
      expect(issueOf(h, "STA-1").stateId).toBe(BUILD);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      expect(issueOf(h, "STA-1").comments.length).toBe(commentsBefore);
      expect(h.workspaces.agents.some((a) => a.name === "reviewer-sta-1")).toBe(false);
      expect(h.lines.some((l) => /approved|Acceptance|wake/.test(l))).toBe(false);
    } finally {
      h.stop();
    }
  });

  test("the owner handoff converges on explicit reconcile and the Commander can begin Review", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      await initialSubmit(h, "STA-1");
      await ownerHandoff(h, "STA-1");
      expect(h.workspaces.tokensFor("STA-1")).not.toHaveProperty("status");
      expect(h.workspaces.tokensFor("STA-1")).not.toHaveProperty("receipt_kind");
      // Ticket-targeted begin launches the Acceptance worker; the legacy
      // workspace begin only flips the label.
      expect((await runCommand({ command: "worker.start", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
      expect((await runCommand({ command: "begin", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
      expect(issueOf(h, "STA-1").labelIds).toEqual([IN_PROGRESS]);
      expect(h.workspaces.agents.some((a) => a.name === "reviewer-sta-1")).toBe(true);
    } finally {
      h.stop();
    }
  });

  test("the handoff converges after a restart with no workspace metadata, from Linear alone", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      await initialSubmit(h, "STA-1");
      seedLineage(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, REVIEW);
      // Restart: fresh workspaces, fresh git, fresh decisions, same Linear.
      const workspaces = new FakeWorkspaces();
      const git = new FakeGit();
      git.head = HEAD;
      git.ancestors.add(`${HEAD} feature/sta-1`);
      const lines: string[] = [];
      const restarted: CommandContext = {
        ...h.ctx,
        workspaces,
        git,
        decisions: {
          record: async (ticket, message) => {
            lines.push(`${ticket} ${message}`);
          },
        },
      };
      const reconciled = await runCommand({ command: "reconcile", ticket: "STA-1" }, restarted);
      expect(reconciled.ok).toBe(true);
      expect(reconciled.text).toContain("Build+Complete → Review+Pending");
      expect(issueOf(h, "STA-1").stateId).toBe(REVIEW);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(lines).toEqual([]);
      expect(receiptBodies(h, "STA-1")).toHaveLength(1);
    } finally {
      h.stop();
    }
  });

  test("the handoff converges with no workspace at all", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      await initialSubmit(h, "STA-1");
      seedLineage(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, REVIEW);
      h.workspaces.workspaces = [];
      const reconciled = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(reconciled.ok).toBe(true);
      expect(reconciled.text).toContain("Build+Complete → Review+Pending");
      expect(issueOf(h, "STA-1").stateId).toBe(REVIEW);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(h.workspaces.calls.some(call => call.method === "workspace.report_metadata" && call.params["status"] === "review")).toBe(false);
    } finally {
      h.stop();
    }
  });

  test("a block/unblock round trip without any review still classifies as initial", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      expect((await ticketCommand(h, "STA-1", "block", "waiting")).ok).toBe(true);
      expect((await ticketCommand(h, "STA-1", "unblock")).ok).toBe(true);
      expect((await ticketCommand(h, "STA-1", "begin")).ok).toBe(true);
      await initialSubmit(h, "STA-1");
    } finally {
      h.stop();
    }
  });
});

describe("correction Builds return without the owner", () => {
  test("a Review FAIL correction submit lands straight in Review+Pending", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      await initialSubmit(h, "STA-1");
      await ownerHandoff(h, "STA-1");
      expect((await ticketCommand(h, "STA-1", "begin")).ok).toBe(true);
      expect((await ticketCommand(h, "STA-1", "submit", JSON.stringify(reviewPayload("fail")))).ok).toBe(true);
      expect(issueOf(h, "STA-1").stateId).toBe(BUILD);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);

      // The Builder corrects at a new checkpoint: no owner step follows.
      h.git.head = HEAD2;
      expect((await ticketCommand(h, "STA-1", "begin")).ok).toBe(true);
      const corrected = await ticketCommand(h, "STA-1", "submit", JSON.stringify(buildPayload(HEAD2)));
      expect(corrected.ok).toBe(true);
      expect(corrected.text).toContain("→ Review+Pending");
      expect(corrected.text).toContain("correction after review-fail");
      expect(issueOf(h, "STA-1").stateId).toBe(REVIEW);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(receiptBodies(h, "STA-1")).toHaveLength(3);
      expect(latestValidReceipt(issueOf(h, "STA-1").comments)).toMatchObject({
        receipt: { kind: "build", checkpoint: HEAD2 },
      });
    } finally {
      h.stop();
    }
  });

  test("an owner send-back correction submit lands straight in Review+Pending", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      await initialSubmit(h, "STA-1");
      await ownerHandoff(h, "STA-1");
      expect((await ticketCommand(h, "STA-1", "begin")).ok).toBe(true);
      expect((await ticketCommand(h, "STA-1", "submit", JSON.stringify(reviewPayload("pass")))).ok).toBe(true);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);

      // The owner sends Review+Complete back to Build; reconcile converges it.
      seedLineage(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, BUILD);
      const sentBack = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(sentBack.ok).toBe(true);
      expect(sentBack.text).toContain("sent back: Review+Complete → Build+Pending");
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);

      // The original Builder corrects at a new checkpoint: no second approval.
      h.git.head = HEAD2;
      seedLineage(h, "STA-1", HEAD2);
      expect((await ticketCommand(h, "STA-1", "begin")).ok).toBe(true);
      const corrected = await ticketCommand(h, "STA-1", "submit", JSON.stringify(buildPayload(HEAD2)));
      expect(corrected.ok).toBe(true);
      expect(corrected.text).toContain("→ Review+Pending");
      expect(corrected.text).toContain("correction after review-pass");
      expect(issueOf(h, "STA-1").stateId).toBe(REVIEW);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
    } finally {
      h.stop();
    }
  });
});

describe("submission retries keep their classification", () => {
  test("an initial retry creates no second receipt and stays initial", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      const payload = JSON.stringify(buildPayload());
      expect((await ticketCommand(h, "STA-1", "submit", payload)).ok).toBe(true);
      const repeated = await ticketCommand(h, "STA-1", "submit", payload);
      expect(repeated.ok).toBe(true);
      expect(repeated.text).toContain("already submitted build");
      expect(repeated.text).toContain("build+complete");
      expect(receiptBodies(h, "STA-1")).toHaveLength(1);
      expect(issueOf(h, "STA-1").stateId).toBe(BUILD);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
    } finally {
      h.stop();
    }
  });

  test("a correction retry creates no second receipt and stays a correction", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      await initialSubmit(h, "STA-1");
      await ownerHandoff(h, "STA-1");
      expect((await ticketCommand(h, "STA-1", "begin")).ok).toBe(true);
      expect((await ticketCommand(h, "STA-1", "submit", JSON.stringify(reviewPayload("fail")))).ok).toBe(true);
      h.git.head = HEAD2;
      expect((await ticketCommand(h, "STA-1", "begin")).ok).toBe(true);
      const payload = JSON.stringify(buildPayload(HEAD2));
      expect((await ticketCommand(h, "STA-1", "submit", payload)).ok).toBe(true);
      const repeated = await ticketCommand(h, "STA-1", "submit", payload);
      expect(repeated.ok).toBe(true);
      expect(repeated.text).toContain("already submitted build");
      expect(receiptBodies(h, "STA-1")).toHaveLength(3);
      expect(issueOf(h, "STA-1").stateId).toBe(REVIEW);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
    } finally {
      h.stop();
    }
  });

  test("a retry after the publish landed but the move stalled heals without reclassifying", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      const payload = JSON.stringify(buildPayload());
      // The receipt lands, then the move's read-back is lost: the submit fails.
      const realAdd = h.client.addComment.bind(h.client);
      let calls = 0;
      h.client.addComment = (async (issueId: string, body: string) => {
        calls += 1;
        const id = await realAdd(issueId, body);
        if (calls === 1) throw new (await import("../../service/linear/linear")).LinearError(500, "lost result");
        return id;
      }) as typeof h.client.addComment;
      // The lost result never surfaces: the post-write read-back adopts the
      // landed receipt inside the same submit, still as an initial Build.
      const out = await ticketCommand(h, "STA-1", "submit", payload);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("→ Build+Complete");
      expect(receiptBodies(h, "STA-1")).toHaveLength(1);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
    } finally {
      h.stop();
    }
  });
});

describe("protocol vocabulary", () => {
  test("no new Linear status or Progress label was introduced", async () => {
    const h = await harness();
    try {
      expect(Object.keys(h.resolved.stateIds).sort()).toEqual(
        ["backlog", "build", "deliver", "done", "review", "todo"],
      );
      expect(Object.keys(h.resolved.progress.ids).sort()).toEqual(
        ["blocked", "complete", "in_progress", "pending"],
      );
    } finally {
      h.stop();
    }
  });

  test("Acceptance stays black-box, correction-scoped, and never modifies product code", async () => {
    const review = await Bun.file(new URL("../../../commander/stages/review.md", import.meta.url)).text();
    expect(review).toContain("Never modify product code");
    expect(review).toContain("returns to the original\nBuilder");
    expect(review).toContain("recheck the failed criteria plus a short smoke test");
    const rules = await Bun.file(new URL("../../../commander/rules.md", import.meta.url)).text();
    expect(rules).toContain("The Acceptance agent never modifies product code");
    expect(rules).toContain("never fix inside acceptance, never\nopen a second Builder");
  });
});
