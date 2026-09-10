// Black-box refusal and Git-safety matrix. Every command crosses the real
// CLI subprocess -> command boundary; only Linear, Herdr, and credentials are
// replaced by the stateful in-memory/fake fixtures.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  memoryAddIssue,
  ownerSetProgress,
  ownerSetState,
  type MemoryIssue,
} from "../../workflow/service/linear/fake-memory-linear.ts";
import { latestValidReceipt, parseReceiptBlock } from "../../workflow/command/ticket/protocol.ts";
import {
  buildPayload,
  commandEvidencePayload,
  commitWorktreeFile,
  CRITERIA,
  deliverPayload,
  E2E,
  expectFail,
  expectOk,
  git,
  mainHead,
  ownerHandoff,
  worktreeHeadOf,
} from "../support/fake-harness.ts";

async function withE2E(fn: (e2e: E2E) => Promise<void>): Promise<void> {
  const e2e = await E2E.boot();
  try {
    await fn(e2e);
  } finally {
    await e2e.close();
  }
}

function issueOf(e2e: E2E, identifier: string): MemoryIssue {
  const issue = e2e.world.issues.find((candidate) => candidate.identifier === identifier);
  if (!issue) throw new Error(`missing memory issue ${identifier}`);
  return issue;
}

function progressNames(e2e: E2E, issue: MemoryIssue): string[] {
  return issue.labelIds
    .map((id) => e2e.world.labels.find((label) => label.id === id)?.name ?? id)
    .filter((name) => ["Pending", "In progress", "Complete", "Blocked"].includes(name));
}

function expectNoPublishedResult(issue: MemoryIssue): void {
  expect(latestValidReceipt(issue.comments)).toBeNull();
  expect(issue.attachments).toEqual([]);
}

async function advanceToDeliverComplete(e2e: E2E, identifier: string): Promise<string> {
  memoryAddIssue(e2e.world, {
    identifier,
    stateId: "st-todo",
    description: CRITERIA,
    labelIds: ["label-pending"],
  });
  expectOk(await e2e.startStage(identifier));
  const head = commitWorktreeFile(
    e2e.repoDir,
    identifier,
    `${identifier.toLowerCase()}.txt`,
    `${identifier} delivery\n`,
    `${identifier} delivery`,
  );
  expectOk(await e2e.cli(["submit", identifier, "--input", "-"], {
    stdin: JSON.stringify(buildPayload(head)),
  }));
  await ownerHandoff(e2e, identifier);
  expectOk(await e2e.startStage(identifier));
  expectOk(await e2e.cli(["submit", identifier, "--input", "-"], {
    stdin: JSON.stringify(commandEvidencePayload(head, "pass")),
  }));
  ownerSetState(e2e.world, identifier, "Deliver");
  ownerSetProgress(e2e.world, identifier, "Complete");
  expectOk(await e2e.cli(["reconcile", identifier]));
  expectOk(await e2e.startStage(identifier));
  git(["merge", `feature/${identifier.toLowerCase()}`, "--no-ff", "-m", `land ${identifier}`], e2e.repoDir);
  expectOk(await e2e.cli(["submit", identifier, "--input", "-"], {
    stdin: JSON.stringify(deliverPayload(head)),
  }));
  return head;
}

describe("e2e submit refusal has no workflow side effects", () => {
  test("malformed JSON, missing fields, wrong kind, and wrong stage fail on stderr", async () => {
    await withE2E(async (e2e) => {
      memoryAddIssue(e2e.world, {
        identifier: "STA-20",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: ["label-pending"],
      });
      expectOk(await e2e.startStage("STA-20"));
      const issue = issueOf(e2e, "STA-20");

      const malformed = expectFail(
        await e2e.cli(["submit", "STA-20", "--input", "-"], { stdin: "{not-json" }),
        "submit input is not JSON",
      );
      expect(malformed.stdout).toBe("");
      expect(malformed.stderr).toContain("submit input is not JSON");

      const missing = expectFail(
        await e2e.cli(["submit", "STA-20", "--input", "-"], {
          stdin: JSON.stringify({ v: 1, kind: "build" }),
        }),
        'build submit needs a "checkpoint"',
      );
      expect(missing.stdout).toBe("");
      expect(missing.stderr).toContain('build submit needs a "checkpoint"');

      const wrongKind = expectFail(
        await e2e.cli(["submit", "STA-20", "--input", "-"], {
          stdin: JSON.stringify({ ...buildPayload(worktreeHeadOf(e2e.repoDir, "STA-20")), kind: "review" }),
        }),
        'build submit needs {"v":1,"kind":"build"',
      );
      expect(wrongKind.stdout).toBe("");
      expect(wrongKind.stderr).toContain("refused:");
      expect(issue.stateId).toBe("st-build");
      expect(progressNames(e2e, issue)).toEqual(["In progress"]);
      expectNoPublishedResult(issue);

      const head = worktreeHeadOf(e2e.repoDir, "STA-20");
      expectOk(await e2e.cli(["submit", "STA-20", "--input", "-"], {
        stdin: JSON.stringify(buildPayload(head)),
      }));
      // The first Build waits at Build+Complete: a Review payload is refused
      // without touching Linear, and the owner handoff is still pending.
      const comments = issue.comments.map((comment) => comment.body);
      const wrongStage = expectFail(
        await e2e.cli(["submit", "STA-20", "--input", "-"], {
          stdin: JSON.stringify(commandEvidencePayload(head, "pass")),
        }),
        "submit needs an In progress stage",
      );
      expect(wrongStage.stdout).toBe("");
      expect(wrongStage.stderr).toContain("build+complete");
      expect(issue.stateId).toBe("st-build");
      expect(progressNames(e2e, issue)).toEqual(["Complete"]);
      expect(issue.comments.map((comment) => comment.body)).toEqual(comments);
      expect(issue.attachments).toEqual([]);
    });
  });

  test("HEAD mismatch and a receipt made stale by a new commit cannot submit", async () => {
    await withE2E(async (e2e) => {
      memoryAddIssue(e2e.world, {
        identifier: "STA-21",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: ["label-pending"],
      });
      expectOk(await e2e.startStage("STA-21"));
      const issue = issueOf(e2e, "STA-21");
      const original = worktreeHeadOf(e2e.repoDir, "STA-21");

      const mismatch = expectFail(
        await e2e.cli(["submit", "STA-21", "--input", "-"], {
          stdin: JSON.stringify(buildPayload("0".repeat(40))),
        }),
        `worktree HEAD is ${original}`,
      );
      expect(mismatch.stdout).toBe("");
      expect(mismatch.stderr).toContain(`checkpoint ${"0".repeat(40)}`);
      expectNoPublishedResult(issue);

      expectOk(await e2e.cli(["submit", "STA-21", "--input", "-"], {
        stdin: JSON.stringify(buildPayload(original)),
      }));
      await ownerHandoff(e2e, "STA-21");
      expectOk(await e2e.startStage("STA-21"));
      const moved = commitWorktreeFile(e2e.repoDir, "STA-21", "later.txt", "later\n", "later checkpoint");
      expect(moved).not.toBe(original);
      const receiptBodies = issue.comments.map((comment) => comment.body);

      const stale = expectFail(
        await e2e.cli(["submit", "STA-21", "--input", "-"], {
          stdin: JSON.stringify(commandEvidencePayload(original, "pass")),
        }),
        "a new checkpoint invalidates earlier receipts",
      );
      expect(stale.stdout).toBe("");
      expect(stale.stderr).toContain(`worktree HEAD is ${moved}`);
      expect(issue.stateId).toBe("st-review");
      expect(progressNames(e2e, issue)).toEqual(["In progress"]);
      expect(issue.comments.map((comment) => comment.body)).toEqual(receiptBodies);
      expect(issue.attachments).toEqual([]);
      expect(latestValidReceipt(issue.comments)?.receipt).toMatchObject({ kind: "build", checkpoint: original });
    });
  });
});

describe("e2e rebased approval and scratch boundaries", () => {
  test("a real rebase changes SHA and makes the old Review PASS receipt stale", async () => {
    await withE2E(async (e2e) => {
      memoryAddIssue(e2e.world, {
        identifier: "STA-22",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: ["label-pending"],
      });
      expectOk(await e2e.startStage("STA-22"));
      const approved = commitWorktreeFile(e2e.repoDir, "STA-22", "feature.txt", "before rebase\n", "feature");
      expectOk(await e2e.cli(["submit", "STA-22", "--input", "-"], {
        stdin: JSON.stringify(buildPayload(approved)),
      }));
      await ownerHandoff(e2e, "STA-22");
      expectOk(await e2e.startStage("STA-22"));
      expectOk(await e2e.cli(["submit", "STA-22", "--input", "-"], {
        stdin: JSON.stringify(commandEvidencePayload(approved, "pass")),
      }));

      writeFileSync(join(e2e.repoDir, "main.txt"), "main moved\n");
      git(["add", "main.txt"], e2e.repoDir);
      git(["commit", "-m", "move main"], e2e.repoDir);
      const mainAfter = mainHead(e2e.repoDir);
      const worktree = join(e2e.repoDir, ".igniter", "runtime", "worktrees", "sta-22");
      git(["rebase", "main"], worktree);
      const rebased = worktreeHeadOf(e2e.repoDir, "STA-22");
      expect(rebased).not.toBe(approved);
      expect(() => git(["merge-base", "--is-ancestor", approved, "feature/sta-22"], e2e.repoDir)).toThrow();
      expect(git(["merge-base", "--is-ancestor", mainAfter, rebased], e2e.repoDir).stdout).toBe("");

      const issue = issueOf(e2e, "STA-22");
      const commentsBefore = issue.comments.map((comment) => comment.body);
      const attachmentsBefore = issue.attachments.map((attachment) => attachment.url);
      ownerSetState(e2e.world, "STA-22", "Deliver");
      ownerSetProgress(e2e.world, "STA-22", "Complete");
      const reconcile = expectFail(await e2e.cli(["reconcile", "STA-22"]), "receipt is stale, refusing");
      expect(reconcile.stdout).toBe("");
      expect(reconcile.stderr).toContain(approved);
      expect(issue.stateId).toBe("st-deliver");
      expect(progressNames(e2e, issue)).toEqual(["Complete"]);
      expect(issue.comments.map((comment) => comment.body)).toEqual(commentsBefore);
      expect(issue.attachments.map((attachment) => attachment.url)).toEqual(attachmentsBefore);
      expect(issue.comments.map((comment) => parseReceiptBlock(comment.body)?.kind)).not.toContain("deliver");
      expect(latestValidReceipt(issue.comments)?.receipt).toMatchObject({ kind: "review-pass", checkpoint: approved });
    });
  });

  test("a scratch symlink escaping the ticket root is refused without touching its target", async () => {
    await withE2E(async (e2e) => {
      memoryAddIssue(e2e.world, {
        identifier: "STA-23",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: ["label-pending"],
      });
      const scratchParent = join(e2e.repoDir, ".igniter", "runtime", "scratch");
      mkdirSync(scratchParent, { recursive: true });
      symlinkSync(e2e.stubBin, join(scratchParent, "sta-23"));
      const targetBefore = readdirSync(e2e.stubBin);

      const begun = expectFail(await e2e.startStage("STA-23"), "is a symlink; remove it first");
      expect(begun.stdout).toBe("");
      expect(begun.stderr).toContain("worker start failed: refused: scratch component");
      expect(readdirSync(e2e.stubBin)).toEqual(targetBefore);
      const issue = issueOf(e2e, "STA-23");
      expect(issue.stateId).toBe("st-todo");
      expect(progressNames(e2e, issue)).toEqual(["Pending"]);
      expectNoPublishedResult(issue);
      expect(e2e.workspaces.workspaces).toEqual([]);
      expect(e2e.workspaces.agents).toEqual([]);
    });
  });
});

describe("e2e Done cleanup refuses to discard real Git state", () => {
  test("tracked, untracked, and unmerged ticket checkouts are all kept", async () => {
    await withE2E(async (e2e) => {
      const trackedHead = await advanceToDeliverComplete(e2e, "STA-24");
      const untrackedHead = await advanceToDeliverComplete(e2e, "STA-25");
      await advanceToDeliverComplete(e2e, "STA-26");

      const trackedWorktree = join(e2e.repoDir, ".igniter", "runtime", "worktrees", "sta-24");
      const untrackedWorktree = join(e2e.repoDir, ".igniter", "runtime", "worktrees", "sta-25");
      writeFileSync(join(trackedWorktree, "sta-24.txt"), "uncommitted tracked edit\n");
      writeFileSync(join(untrackedWorktree, "local-only.txt"), "untracked\n");
      const unmergedHead = commitWorktreeFile(
        e2e.repoDir,
        "STA-26",
        "unmerged.txt",
        "post-delivery branch work\n",
        "unmerged ticket work",
      );

      for (const identifier of ["STA-24", "STA-25", "STA-26"]) {
        ownerSetState(e2e.world, identifier, "Done");
        ownerSetProgress(e2e.world, identifier, "Complete");
        expectOk(await e2e.cli(["reconcile", identifier]));
        expectFail(await e2e.cli(["worker", "stop", identifier]), "keeping");
        const issue = issueOf(e2e, identifier);
        expect(issue.stateId).toBe("st-done");
        expect(progressNames(e2e, issue)).toEqual([]);
        expect(git(["worktree", "list", "--porcelain"], e2e.repoDir).stdout).toContain(
          `worktrees/${identifier.toLowerCase()}`,
        );
        expect(git(["rev-parse", "--verify", `refs/heads/feature/${identifier.toLowerCase()}`], e2e.repoDir).stdout)
          .toMatch(/^[0-9a-f]{40}\n$/);
      }

      expect(git(["status", "--porcelain"], trackedWorktree).stdout).toContain(" M sta-24.txt");
      expect(git(["status", "--porcelain"], untrackedWorktree).stdout).toContain("?? local-only.txt");
      expect(git(["merge-base", "--is-ancestor", trackedHead, "main"], e2e.repoDir).stdout).toBe("");
      expect(git(["merge-base", "--is-ancestor", untrackedHead, "main"], e2e.repoDir).stdout).toBe("");
      expect(() => git(["merge-base", "--is-ancestor", unmergedHead, "main"], e2e.repoDir)).toThrow();
    });
  });
});

describe("e2e failure diagnostics", () => {
  test("diagnosis includes CLI transcript, mock Linear/Herdr calls, and Git state", async () => {
    await withE2E(async (e2e) => {
      writeFileSync(join(e2e.repoDir, "diagnostic-untracked.txt"), "diagnostic\n");
      expectFail(await e2e.cli(["submit", "STA-99", "--input", "-"], { stdin: "{" }), "not JSON");
      const diagnosis = await e2e.diagnose();
      expect(diagnosis).toContain("$ igniter submit STA-99 --input - → exit 1");
      expect(diagnosis).toContain("stderr: submit input is not JSON");
      expect(diagnosis).toContain("memory-linear calls:");
      expect(diagnosis).toContain("herdr calls:");
      expect(diagnosis).toContain("git status:");
      expect(diagnosis).toContain("?? diagnostic-untracked.txt");
      expect(diagnosis).toContain("worktrees:");
      expect(diagnosis).toContain("branches:");
    });
  });
});
