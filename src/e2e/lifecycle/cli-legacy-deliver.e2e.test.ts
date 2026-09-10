// Upgrade coverage for Deliver receipts written before STA-235 added the
// landed field. Real CLI subprocesses drive production dispatch against the
// stateful memory Linear client and temporary real Git; no provider or fake
// Linear service is involved.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  memoryAddIssue,
  ownerSetProgress,
  ownerSetState,
  type MemoryIssue,
} from "../../workflow/linear/fake-memory-linear.ts";
import { latestValidReceipt, receiptBlock } from "../../workflow/ticket/protocol.ts";
import { CRITERIA, E2E, expectFail, expectOk, git, mainHead } from "../support/fake-harness.ts";

interface LegacyTicket {
  identifier: string;
  branch: string;
  worktree: string;
  checkpoint: string;
  issue: MemoryIssue;
}

async function withE2E(fn: (e2e: E2E) => Promise<void>): Promise<void> {
  const e2e = await E2E.boot({ repoPrefix: "igniter-e2e-legacy-deliver-" });
  try {
    await fn(e2e);
  } finally {
    await e2e.close();
  }
}

function legacyDeliverReceipt(checkpoint: string, submission: string): string {
  return [
    "# Deliver receipt",
    "",
    `Checkpoint: \`${checkpoint}\``,
    "",
    "```yaml",
    "igniter_receipt:",
    "  version: 1",
    "  kind: deliver",
    `  checkpoint: ${checkpoint}`,
    `  submission: ${submission}`,
    "```",
    "",
  ].join("\n");
}

function seedLegacyIssue(
  e2e: E2E,
  identifier: string,
  checkpoint: string,
  stateId = "st-deliver",
  labelIds = ["label-complete"],
): MemoryIssue {
  const suffix = identifier.toLowerCase();
  return memoryAddIssue(e2e.world, {
    identifier,
    stateId,
    description: CRITERIA,
    labelIds,
    comments: [
      {
        id: `review-${suffix}`,
        body: `review\n\n${receiptBlock("review-pass", checkpoint, `review-${suffix}`)}\n`,
        createdAt: "2026-09-01T00:00:00.000001Z",
      },
      {
        id: `legacy-${suffix}`,
        body: legacyDeliverReceipt(checkpoint, `deliver-${suffix}`),
        createdAt: "2026-09-01T00:00:00.000002Z",
      },
    ],
  });
}

function openLegacyTicket(e2e: E2E, identifier: string): LegacyTicket {
  const suffix = identifier.toLowerCase();
  const branch = `feature/${suffix}`;
  const worktree = join(e2e.repoDir, ".igniter", "runtime", "worktrees", suffix);
  mkdirSync(dirname(worktree), { recursive: true });
  git(["worktree", "add", "-b", branch, worktree, "main"], e2e.repoDir);
  writeFileSync(join(worktree, `${suffix}.txt`), `${identifier} legacy delivery\n`);
  git(["add", `${suffix}.txt`], worktree);
  git(["commit", "-m", `${identifier} legacy delivery`], worktree);
  const checkpoint = git(["rev-parse", "HEAD"], worktree).stdout.trim();
  return {
    identifier,
    branch,
    worktree,
    checkpoint,
    issue: seedLegacyIssue(e2e, identifier, checkpoint),
  };
}

function commentsOf(issue: MemoryIssue): { id: string; body: string; createdAt: string }[] {
  return issue.comments.map((comment) => ({ ...comment }));
}

describe("e2e legacy Deliver receipt upgrade", () => {
  test("status and reconcile keep legacy completions authoritative while Done cleanup stays safe", async () => {
    await withE2E(async (e2e) => {
      const clean = openLegacyTicket(e2e, "STA-50");
      const unlanded = openLegacyTicket(e2e, "STA-51");
      const dirty = openLegacyTicket(e2e, "STA-52");
      const untracked = openLegacyTicket(e2e, "STA-53");
      const unmerged = openLegacyTicket(e2e, "STA-54");

      for (const ticket of [clean, dirty, untracked, unmerged]) {
        git(["merge", ticket.branch, "--no-ff", "-m", `land ${ticket.identifier}`], e2e.repoDir);
        expect(git(["merge-base", "--is-ancestor", ticket.checkpoint, "main"], e2e.repoDir).stdout).toBe("");
      }
      writeFileSync(join(dirty.worktree, "sta-52.txt"), "uncommitted tracked edit\n");
      writeFileSync(join(untracked.worktree, "local-only.txt"), "untracked\n");
      writeFileSync(join(unmerged.worktree, "after-delivery.txt"), "post-delivery branch work\n");
      git(["add", "after-delivery.txt"], unmerged.worktree);
      git(["commit", "-m", "post-delivery branch work"], unmerged.worktree);
      const unmergedTip = git(["rev-parse", "HEAD"], unmerged.worktree).stdout.trim();

      const commentsBefore = new Map(
        [clean, unlanded, dirty, untracked, unmerged].map((ticket) => [ticket.identifier, commentsOf(ticket.issue)]),
      );

      // A restarted reader has no workspace metadata. Linear's newest
      // receipt remains the legacy Deliver record, not the older Review PASS.
      const status = expectOk(await e2e.cli(["status", clean.identifier, "--json"]));
      const state = JSON.parse(status.stdout) as {
        status: string;
        progress: string;
        checkpoint: string;
        landed: string;
        receipt: { kind: string; id: string; checkpoint: string; landed: string; submission: string };
      };
      expect(state).toMatchObject({
        status: "deliver",
        progress: "complete",
        checkpoint: clean.checkpoint,
        landed: clean.checkpoint,
        receipt: {
          kind: "deliver",
          id: "legacy-sta-50",
          checkpoint: clean.checkpoint,
          landed: clean.checkpoint,
          submission: "deliver-sta-50",
        },
      });
      expect(latestValidReceipt(clean.issue.comments)?.receipt).toMatchObject({
        kind: "deliver",
        checkpoint: clean.checkpoint,
        landed: clean.checkpoint,
      });
      expect(clean.issue.comments.at(-1)!.body).not.toContain("  landed:");
      expect(e2e.workspaces.workspaces).toEqual([]);

      const held = expectOk(await e2e.cli(["reconcile", clean.identifier]));
      expect(held.stdout).toContain("no owner transition to reconcile (deliver+complete)");
      expect(clean.issue.stateId).toBe("st-deliver");
      expect(clean.issue.labelIds).toEqual(["label-complete"]);
      const cleanComments = commentsBefore.get(clean.identifier);
      if (!cleanComments) throw new Error("clean ticket comments were not captured");
      expect(clean.issue.comments).toEqual(cleanComments);
      expect(e2e.workspaces.workspaces).toEqual([]);

      for (const ticket of [clean, unlanded, dirty, untracked, unmerged]) {
        ownerSetState(e2e.world, ticket.identifier, "Done");
        ownerSetProgress(e2e.world, ticket.identifier, "Complete");
        const done = expectOk(await e2e.cli(["reconcile", ticket.identifier]));
        expect(done.stdout).toContain("done: Deliver+Complete → Done");
        expect(done.stdout).toContain(`worker stop ${ticket.identifier}`);
        expect(git(["worktree", "list", "--porcelain"], e2e.repoDir).stdout).toContain(ticket.worktree);
        const cleanup = await e2e.cli(["worker", "stop", ticket.identifier]);
        if (ticket === clean) expectOk(cleanup);
        else expectFail(cleanup, "keeping worktree and branch");
        expect(ticket.issue.stateId).toBe("st-done");
        expect(ticket.issue.labelIds).toEqual([]);
        const originalComments = commentsBefore.get(ticket.identifier);
        if (!originalComments) throw new Error(`${ticket.identifier} comments were not captured`);
        expect(ticket.issue.comments).toEqual(originalComments);
      }

      const worktrees = git(["worktree", "list", "--porcelain"], e2e.repoDir).stdout;
      expect(worktrees).not.toContain(clean.worktree);
      expect(() => git(["rev-parse", "--verify", `refs/heads/${clean.branch}`], e2e.repoDir)).toThrow();
      for (const ticket of [unlanded, dirty, untracked, unmerged]) {
        expect(worktrees).toContain(ticket.worktree);
        expect(git(["rev-parse", "--verify", `refs/heads/${ticket.branch}`], e2e.repoDir).stdout).toMatch(
          /^[0-9a-f]{40}\n$/,
        );
      }
      expect(() => git(["merge-base", "--is-ancestor", unlanded.checkpoint, "main"], e2e.repoDir)).toThrow();
      expect(git(["status", "--porcelain"], dirty.worktree).stdout).toContain(" M sta-52.txt");
      expect(git(["status", "--porcelain"], untracked.worktree).stdout).toContain("?? local-only.txt");
      expect(() => git(["merge-base", "--is-ancestor", unmergedTip, "main"], e2e.repoDir)).toThrow();
      expect(e2e.client.calls.filter((call) => call.method === "addComment")).toEqual([]);

      // An already-Done legacy record has no checkout or workspace to
      // recover. It stays readable and reconcile remains a no-op.
      const doneCheckpoint = mainHead(e2e.repoDir);
      const alreadyDone = seedLegacyIssue(e2e, "STA-55", doneCheckpoint, "st-done", []);
      const doneComments = commentsOf(alreadyDone);
      const doneStatus = expectOk(await e2e.cli(["status", "STA-55", "--json"]));
      expect(JSON.parse(doneStatus.stdout)).toMatchObject({
        status: "done",
        progress: null,
        checkpoint: doneCheckpoint,
        landed: doneCheckpoint,
        receipt: { kind: "deliver", id: "legacy-sta-55", submission: "deliver-sta-55" },
      });
      const doneHeld = expectOk(await e2e.cli(["reconcile", "STA-55"]));
      expect(doneHeld.stdout).toContain("no owner transition to reconcile (done+none)");
      expect(alreadyDone.comments).toEqual(doneComments);
      expect(e2e.workspaces.workspaces).toEqual([]);
      expect(e2e.client.calls.filter((call) => call.method === "addComment")).toEqual([]);
    });
  });
});
