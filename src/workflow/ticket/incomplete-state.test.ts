// Incomplete active-state diagnosis and safe convergence (STA-190): an
// active Build, Review, or Deliver ticket with zero or several Progress
// labels fails closed on `status`/`reconcile`/`begin`, converges from the
// Linear status plus Progress plus the newest valid YAML receipt alone, and
// never starts a stage agent. No network, no real credentials, no project.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCommand,
  type CommandContext,
} from "../command/commands";
import { validateStartup, type ResolvedDispatch } from "../config/claims";
import { parseDispatchConfig } from "../config/config";
import { LinearClient, LinearError } from "../linear/linear";
import {
  convergeIncompleteState,
  diagnoseIncompleteState,
  receiptBlock,
  type FullIssue,
} from "./protocol";
import { addIssue, standardWorld, startFakeLinear } from "../linear/fake-linear";
import { FakeGit } from "../testing/fake-git";
import { FakeWorkspaces } from "../testing/fake-workspaces";

const TODO = "st-todo";
const BUILD = "st-build";
const REVIEW = "st-review";
const DELIVER = "st-deliver";
const PENDING = "label-pending";
const IN_PROGRESS = "label-in-progress";
const COMPLETE = "label-complete";
const BLOCKED = "label-blocked";
const CRITERIA = "## 驗收條件\n- [ ] works\n- [ ] shines\n";
const HEAD = "deadbeefcafe0001";
const MARKER = "igniter:incomplete-state";

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
  const repoRoot = join(mkdtempSync(join(tmpdir(), "igniter-incomplete-")), "repo");
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

let seedClock = 1000;
function seedReceipt(
  h: Harness,
  identifier: string,
  kind: "build" | "review-pass" | "review-fail" | "deliver",
  checkpoint = HEAD,
  submission = "sub-seed-00000001",
): void {
  seedClock += 1;
  const id = `comment-seed-${issueOf(h, identifier).comments.length + 1}`;
  issueOf(h, identifier).comments.push({
    id,
    body: `prior report\n\n${receiptBlock(kind, checkpoint, submission, kind === "deliver" ? checkpoint : undefined)}\n`,
    createdAt: `2026-09-04T00:00:00.${String(seedClock).padStart(6, "0")}Z`,
  });
}

function seedLineage(h: Harness, identifier: string, checkpoint = HEAD): void {
  h.git.ancestors.add(`${checkpoint} feature/${identifier.toLowerCase()}`);
}

function workspaceWrites(h: Harness): string[] {
  return h.workspaces.calls
    .map((c) => c.method)
    .filter((m) => m === "workspace.create" || m === "agent.start");
}

function markerComments(h: Harness, identifier: string): number {
  return issueOf(h, identifier).comments.filter((c) => c.body.includes(MARKER)).length;
}

describe("missing Progress on active stages", () => {
  for (const [statusId, stage] of [[BUILD, "build"], [REVIEW, "review"], [DELIVER, "deliver"]] as const) {
    test(`${stage} with no Progress and no receipt parks as Blocked with no worker`, async () => {
      const h = await harness();
      try {
        addIssue(h.world, { identifier: "STA-1", stateId: statusId, priority: 1, description: CRITERIA, labelIds: [] });
        const out = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
        expect(out.ok).toBe(false);
        expect(out.text).toContain("parked as");
        expect(out.text).toContain("Blocked");
        expect(issueOf(h, "STA-1").labelIds).toEqual([BLOCKED]);
        // Same stage kept: only the Progress set changed.
        expect(issueOf(h, "STA-1").stateId).toBe(statusId);
        expect(markerComments(h, "STA-1")).toBe(1);
        expect(workspaceWrites(h)).toEqual([]);
        expect(h.workspaces.workspaces).toEqual([]);
      } finally {
        h.stop();
      }
    });
  }
});

describe("multiple Progress labels fail closed", () => {
  test("two labels with no receipt park as Blocked instead of picking one", async () => {
    const h = await harness();
    try {
      addIssue(h.world, {
        identifier: "STA-1",
        stateId: BUILD,
        priority: 1,
        description: CRITERIA,
        labelIds: [IN_PROGRESS, COMPLETE],
      });
      const out = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("parked as");
      expect(issueOf(h, "STA-1").labelIds).toEqual([BLOCKED]);
      expect(markerComments(h, "STA-1")).toBe(1);
      expect(workspaceWrites(h)).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("a receipt-proven repair overwrites the carried set, never selects from it", async () => {
    const h = await harness();
    try {
      // Neither carried label is Pending; only the review-pass receipt
      // proves Deliver+Pending.
      addIssue(h.world, {
        identifier: "STA-1",
        stateId: DELIVER,
        priority: 1,
        description: CRITERIA,
        labelIds: [COMPLETE, IN_PROGRESS],
      });
      seedReceipt(h, "STA-1", "review-pass");
      seedLineage(h, "STA-1");
      const out = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("repaired");
      expect(out.text).toContain("deliver+complete+in_progress → deliver+pending");
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(issueOf(h, "STA-1").stateId).toBe(DELIVER);
      expect(markerComments(h, "STA-1")).toBe(0);
      expect(workspaceWrites(h)).toEqual([]);
    } finally {
      h.stop();
    }
  });
});

describe("receipt-proven repairs keep checkpoint and receipts", () => {
  test("Build missing Progress with an initial build receipt repairs to Complete", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [] });
      seedReceipt(h, "STA-1", "build");
      seedLineage(h, "STA-1");
      const commentsBefore = issueOf(h, "STA-1").comments.length;
      const out = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("build+none → build+complete");
      expect(issueOf(h, "STA-1").stateId).toBe(BUILD);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      // Checkpoint and receipts are untouched: no new comment.
      expect(issueOf(h, "STA-1").comments).toHaveLength(commentsBefore);
      expect(issueOf(h, "STA-1").comments.at(-1)?.body).toContain("sub-seed-00000001");
      expect(workspaceWrites(h)).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("Review missing Progress with a build receipt repairs to Pending", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: REVIEW, priority: 1, description: CRITERIA, labelIds: [] });
      seedReceipt(h, "STA-1", "build");
      seedLineage(h, "STA-1");
      const commentsBefore = issueOf(h, "STA-1").comments.length;
      const out = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("review+none → review+pending");
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(issueOf(h, "STA-1").comments).toHaveLength(commentsBefore);
      expect(workspaceWrites(h)).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("Review missing Progress with a review-pass receipt repairs to Complete", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: REVIEW, priority: 1, description: CRITERIA, labelIds: [] });
      seedReceipt(h, "STA-1", "review-pass");
      seedLineage(h, "STA-1");
      const out = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("review+none → review+complete");
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      expect(workspaceWrites(h)).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("Deliver missing Progress with a deliver receipt repairs to Complete", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: DELIVER, priority: 1, description: CRITERIA, labelIds: [] });
      seedReceipt(h, "STA-1", "deliver");
      // No lineage needed: the landed delivery legitimately rewrote the branch.
      const out = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("deliver+none → deliver+complete");
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      expect(workspaceWrites(h)).toEqual([]);
    } finally {
      h.stop();
    }
  });
});

describe("insufficient or conflicting receipts park with one actionable comment", () => {
  test("Review missing Progress bound to a review-fail receipt parks (failure belongs in Build)", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: REVIEW, priority: 1, description: CRITERIA, labelIds: [] });
      seedReceipt(h, "STA-1", "review-fail");
      seedLineage(h, "STA-1");
      const out = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("parked as");
      expect(issueOf(h, "STA-1").stateId).toBe(REVIEW);
      expect(issueOf(h, "STA-1").labelIds).toEqual([BLOCKED]);
      expect(markerComments(h, "STA-1")).toBe(1);
      const body = issueOf(h, "STA-1").comments.at(-1)?.body ?? "";
      expect(body).toContain("leave exactly one Progress label");
      expect(body).toContain("igniter reconcile STA-1");
      expect(workspaceWrites(h)).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("a correction build receipt on Build parks (the stage moved on, not the label)", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [] });
      seedReceipt(h, "STA-1", "review-pass", HEAD, "sub-old-0000000001");
      seedReceipt(h, "STA-1", "build", HEAD, "sub-new-0000000002");
      seedLineage(h, "STA-1");
      const out = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("belongs in Review+Pending");
      expect(issueOf(h, "STA-1").labelIds).toEqual([BLOCKED]);
      expect(markerComments(h, "STA-1")).toBe(1);
      expect(workspaceWrites(h)).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("a stale checkpoint parks instead of endorsing an old completion", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: REVIEW, priority: 1, description: CRITERIA, labelIds: [] });
      seedReceipt(h, "STA-1", "review-pass", "replaced-commit");
      // No lineage for the receipt checkpoint: the branch moved on.
      const out = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("stale");
      expect(issueOf(h, "STA-1").labelIds).toEqual([BLOCKED]);
      expect(markerComments(h, "STA-1")).toBe(1);
      expect(workspaceWrites(h)).toEqual([]);
    } finally {
      h.stop();
    }
  });
});

describe("repeat reconciles on an unchanged bad state", () => {
  test("park once: no second comment, no label churn, no workspace", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [] });
      const first = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(first.ok).toBe(false);
      expect(markerComments(h, "STA-1")).toBe(1);
      const commentsAfterFirst = issueOf(h, "STA-1").comments.length;
      const linesAfterFirst = h.lines.length;
      // The ticket now reads Build+Blocked: the retry stays quiet without
      // touching Linear or Herdr again.
      const second = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(second.ok).toBe(true);
      expect(second.text).toContain("no owner transition to reconcile (build+blocked)");
      expect(issueOf(h, "STA-1").comments).toHaveLength(commentsAfterFirst);
      expect(issueOf(h, "STA-1").labelIds).toEqual([BLOCKED]);
      expect(markerComments(h, "STA-1")).toBe(1);
      expect(workspaceWrites(h)).toEqual([]);
      expect(h.lines.length).toBe(linesAfterFirst);
    } finally {
      h.stop();
    }
  });
});

describe("Herdr-independent convergence", () => {
  test("repair and park behave the same when no workspace exists", async () => {
    const h = await harness();
    try {
      // STA-1 is receipt-repairable, STA-2 is receipt-less: the pair that
      // would otherwise need a workspace. Every Herdr operation that could
      // open or read one — snapshot, workspace.create, agent.start — throws,
      // so any workspace dependency in convergence fails the command loudly.
      addIssue(h.world, { identifier: "STA-1", stateId: REVIEW, priority: 1, description: CRITERIA, labelIds: [] });
      seedReceipt(h, "STA-1", "build");
      seedLineage(h, "STA-1");
      addIssue(h.world, { identifier: "STA-2", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [] });
      h.workspaces.failMethods.add("snapshot");
      h.workspaces.failMethods.add("workspace.create");
      h.workspaces.failMethods.add("agent.start");
      const repaired = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(repaired.ok).toBe(true);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      const parked = await runCommand({ command: "reconcile", ticket: "STA-2" }, h.ctx);
      expect(parked.ok).toBe(false);
      expect(issueOf(h, "STA-2").labelIds).toEqual([BLOCKED]);
      expect(markerComments(h, "STA-2")).toBe(1);
      // No workspace exists before or after convergence: neither ticket
      // opened one, and no Herdr call — not even a snapshot read — happened.
      expect(h.workspaces.workspaces).toEqual([]);
      expect(workspaceWrites(h)).toEqual([]);
      expect(h.workspaces.calls).toEqual([]);
      expect(h.workspaces.snapshotCalls).toBe(0);
    } finally {
      h.stop();
    }
  });
});

describe("concurrent changes are never clobbered", () => {
  test("an owner fix landing mid-park is kept, not rewritten to Blocked", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [] });
      const stale = (await h.client.fetchIssue(issueOf(h, "STA-1").id)) as FullIssue;
      const diagnosis = diagnoseIncompleteState(h.resolved, stale);
      if (!diagnosis) throw new Error("expected an incomplete diagnosis");
      // The owner leaves exactly one Progress before dispatch converges.
      issueOf(h, "STA-1").labelIds = [IN_PROGRESS];
      const outcome = await convergeIncompleteState(
        {
          client: h.client,
          resolved: h.resolved,
          workspaces: h.workspaces,
          decisions: h.ctx.decisions,
          git: h.git,
          repoRoot: h.ctx.repoRoot,
        },
        stale,
        diagnosis,
      );
      expect(outcome.result?.ok).toBe(true);
      expect(outcome.result?.text).toContain("already converged");
      expect(issueOf(h, "STA-1").labelIds).toEqual([IN_PROGRESS]);
      expect(markerComments(h, "STA-1")).toBe(0);
    } finally {
      h.stop();
    }
  });

  test("an owner fix landing mid-repair is kept, not overwritten", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: REVIEW, priority: 1, description: CRITERIA, labelIds: [] });
      seedReceipt(h, "STA-1", "build");
      seedLineage(h, "STA-1");
      const stale = (await h.client.fetchIssue(issueOf(h, "STA-1").id)) as FullIssue;
      const diagnosis = diagnoseIncompleteState(h.resolved, stale);
      if (!diagnosis) throw new Error("expected an incomplete diagnosis");
      issueOf(h, "STA-1").labelIds = [PENDING];
      const outcome = await convergeIncompleteState(
        {
          client: h.client,
          resolved: h.resolved,
          workspaces: h.workspaces,
          decisions: h.ctx.decisions,
          git: h.git,
          repoRoot: h.ctx.repoRoot,
        },
        stale,
        diagnosis,
      );
      expect(outcome.result?.ok).toBe(true);
      expect(outcome.result?.text).toContain("already converged");
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(markerComments(h, "STA-1")).toBe(0);
    } finally {
      h.stop();
    }
  });

  test("a lost park-comment result is adopted on readback, never duplicated", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [] });
      const realAdd = h.client.addComment.bind(h.client);
      let calls = 0;
      h.client.addComment = (async (issueId: string, body: string) => {
        calls += 1;
        const id = await realAdd(issueId, body);
        if (calls === 1) throw new LinearError(500, "lost result");
        return id;
      }) as typeof h.client.addComment;
      const out = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("parked as");
      expect(markerComments(h, "STA-1")).toBe(1);
      expect(issueOf(h, "STA-1").labelIds).toEqual([BLOCKED]);
      expect(workspaceWrites(h)).toEqual([]);
    } finally {
      h.stop();
    }
  });
});

describe("receipt-kind ownership", () => {
  test("a deliver receipt on Build parks instead of proving Progress", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [] });
      seedReceipt(h, "STA-1", "deliver");
      seedLineage(h, "STA-1");
      const out = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("proves no single Progress");
      expect(issueOf(h, "STA-1").labelIds).toEqual([BLOCKED]);
      expect(markerComments(h, "STA-1")).toBe(1);
    } finally {
      h.stop();
    }
  });

  test("a stale correction receipt parks as stale, not as a Review handoff", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [] });
      seedReceipt(h, "STA-1", "review-pass", HEAD, "sub-old-0000000001");
      seedReceipt(h, "STA-1", "build", "replaced-commit", "sub-new-0000000002");
      // No lineage for the correction checkpoint: stale beats stage-conflict.
      const out = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("stale");
      expect(out.text).not.toContain("belongs in Review");
      expect(issueOf(h, "STA-1").labelIds).toEqual([BLOCKED]);
      expect(markerComments(h, "STA-1")).toBe(1);
    } finally {
      h.stop();
    }
  });
});

describe("bad states stay ticket-targeted", () => {
  test("one bad ticket blocks neither status, reconcile, nor begin of another", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [] });
      addIssue(h.world, { identifier: "STA-2", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const parked = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(parked.ok).toBe(false);
      // The queue overview still lists both tickets.
      const overview = await runCommand({ command: "status" }, h.ctx);
      expect(overview.ok).toBe(true);
      expect(overview.text).toContain("STA-1");
      // The healthy ticket begins normally without worker side effects.
      const begun = await runCommand({ command: "begin", ticket: "STA-2" }, h.ctx);
      expect(begun.ok).toBe(true);
      expect(h.workspaces.workspaces).toHaveLength(0);
      expect(issueOf(h, "STA-2").stateId).toBe(BUILD);
      expect(issueOf(h, "STA-2").labelIds).toEqual([IN_PROGRESS]);
      // The bad ticket is untouched by the good ticket's begin.
      expect(issueOf(h, "STA-1").labelIds).toEqual([BLOCKED]);
    } finally {
      h.stop();
    }
  });

  test("status --json on an incomplete ticket fails closed without writes", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [] });
      const commentsBefore = issueOf(h, "STA-1").comments.length;
      const out = await runCommand({ command: "status", ticket: "STA-1", json: true }, h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("STA-1");
      expect(out.text).toContain("reconcile");
      expect(issueOf(h, "STA-1").comments).toHaveLength(commentsBefore);
      expect(issueOf(h, "STA-1").labelIds).toEqual([]);
      expect(workspaceWrites(h)).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("begin on an incomplete ticket starts no stage agent", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: REVIEW, priority: 1, description: CRITERIA, labelIds: [] });
      seedReceipt(h, "STA-1", "build");
      seedLineage(h, "STA-1");
      const commentsBefore = issueOf(h, "STA-1").comments.length;
      // Even a receipt-repairable ticket starts nothing through begin: only
      // an explicit reconcile converges it.
      const out = await runCommand({ command: "begin", ticket: "STA-1" }, h.ctx);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("reconcile");
      expect(issueOf(h, "STA-1").labelIds).toEqual([]);
      expect(issueOf(h, "STA-1").comments).toHaveLength(commentsBefore);
      expect(h.workspaces.workspaces).toEqual([]);
      expect(workspaceWrites(h)).toEqual([]);
    } finally {
      h.stop();
    }
  });
});
