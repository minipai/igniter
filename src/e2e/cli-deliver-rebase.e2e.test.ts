// Deliver after approval with a mid-flight rebase (STA-235). Two approved
// tickets cross the real CLI -> dispatch HTTP boundary against the stateful
// memory Linear client and a real temp git repo: the first lands and moves
// main forward, the second rebases inside Deliver, lands, and submits the
// approved checkpoint together with the new landed commit. No fake HTTP
// server, no real credentials, only temp dirs.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  memoryAddIssue,
  ownerSetProgress,
  ownerSetState,
} from "../dispatch/fake-memory-linear.ts";
import { latestValidReceipt, parseReceiptBlock } from "../dispatch/protocol.ts";
import {
  buildPayload,
  commitWorktreeFile,
  CRITERIA,
  deliverPayload,
  E2E,
  expectOk,
  git,
  mainHead,
  ownerHandoff,
  reviewPayload,
  worktreeHeadOf,
} from "./fake-harness.ts";

async function withE2E(fn: (e2e: E2E) => Promise<void>): Promise<void> {
  const e2e = await E2E.boot();
  try {
    await fn(e2e);
  } finally {
    await e2e.close();
  }
}

function progressNames(e2e: E2E, identifier: string): string[] {
  const issue = e2e.world.issues.find((candidate) => candidate.identifier === identifier)!;
  return issue.labelIds
    .map((id) => e2e.world.labels.find((label) => label.id === id)?.name ?? id)
    .filter((name) => ["Pending", "In progress", "Complete", "Blocked"].includes(name));
}

function receiptCount(e2e: E2E, identifier: string): number {
  const issue = e2e.world.issues.find((candidate) => candidate.identifier === identifier)!;
  return issue.comments.filter((comment) => parseReceiptBlock(comment.body) !== null).length;
}

/** Drive a ticket from Todo to an approved Deliver+Pending; returns the approved SHA. */
async function approve(e2e: E2E, ticket: string, file: string): Promise<string> {
  memoryAddIssue(e2e.world, {
    identifier: ticket,
    stateId: "st-todo",
    description: CRITERIA,
    labelIds: ["label-pending"],
  });
  expectOk(await e2e.cli(["begin", ticket]));
  const head = commitWorktreeFile(e2e.repoDir, ticket, file, `${ticket} change\n`, `${ticket} change`);
  expectOk(await e2e.cli(["submit", ticket, "--input", "-"], { stdin: JSON.stringify(buildPayload(head)) }));
  await ownerHandoff(e2e, ticket);
  expectOk(await e2e.cli(["begin", ticket]));
  expectOk(
    await e2e.cli(["submit", ticket, "--input", "-"], { stdin: JSON.stringify(reviewPayload(head, "pass")) }),
  );
  ownerSetState(e2e.world, ticket, "Deliver");
  ownerSetProgress(e2e.world, ticket, "Complete");
  const approved = expectOk(await e2e.cli(["reconcile", ticket]));
  expect(approved.stdout).toContain("approved: Review+Complete → Deliver+Pending");
  return head;
}

describe("e2e deliver lands a rebased approval", () => {
  test("first ticket lands, second rebases in Deliver, both reach Done with clean checkouts", async () => {
    await withE2E(async (e2e) => {
      const mainBefore = mainHead(e2e.repoDir);

      // Both tickets reach approval while main still sits at the base.
      const approved40 = await approve(e2e, "STA-40", "forty.txt");
      const approved41 = await approve(e2e, "STA-41", "forty-one.txt");

      // STA-40 lands without a rebase: approved and landed are the same SHA.
      expectOk(await e2e.cli(["begin", "STA-40"]));
      git(["merge", "feature/sta-40", "--no-ff", "-m", "land STA-40"], e2e.repoDir);
      const landed40 = expectOk(
        await e2e.cli(["submit", "STA-40", "--input", "-"], { stdin: JSON.stringify(deliverPayload(approved40)) }),
      );
      expect(landed40.stdout).toContain(
        `submitted deliver approved ${approved40} landed ${approved40} → Deliver+Complete`,
      );
      const mainAfterFirst = mainHead(e2e.repoDir);
      expect(mainAfterFirst).not.toBe(mainBefore);
      expect(git(["merge-base", "--is-ancestor", approved40, "main"], e2e.repoDir).stdout).toBe("");

      // STA-41 enters Deliver after main moved: rebase, land, then submit.
      expectOk(await e2e.cli(["begin", "STA-41"]));
      const worktree41 = join(e2e.repoDir, ".igniter", "runtime", "worktrees", "sta-41");
      git(["rebase", "main"], worktree41);
      const rebased41 = worktreeHeadOf(e2e.repoDir, "STA-41");
      expect(rebased41).not.toBe(approved41);
      // The rebase rewrote history: the approved SHA no longer binds the branch.
      expect(() => git(["merge-base", "--is-ancestor", approved41, "feature/sta-41"], e2e.repoDir)).toThrow();
      git(["merge", "feature/sta-41", "--no-ff", "-m", "land STA-41"], e2e.repoDir);
      const delivered41 = expectOk(
        await e2e.cli(["submit", "STA-41", "--input", "-"], {
          stdin: JSON.stringify(deliverPayload(approved41, rebased41)),
        }),
      );
      expect(delivered41.stdout).toContain(
        `submitted deliver approved ${approved41} landed ${rebased41} → Deliver+Complete`,
      );

      // Status observes both identities: the approval and the landing.
      const status41 = expectOk(await e2e.cli(["status", "STA-41", "--json"]));
      const data41 = JSON.parse(status41.stdout) as {
        checkpoint: string;
        landed: string;
        receipt: { kind: string; checkpoint: string; landed: string };
      };
      expect(data41.checkpoint).toBe(approved41);
      expect(data41.landed).toBe(rebased41);
      expect(data41.receipt).toMatchObject({ kind: "deliver", checkpoint: approved41, landed: rebased41 });

      // The same submission retries without a second receipt.
      const receiptsBefore = receiptCount(e2e, "STA-41");
      const repeated = expectOk(
        await e2e.cli(["submit", "STA-41", "--input", "-"], {
          stdin: JSON.stringify(deliverPayload(approved41, rebased41)),
        }),
      );
      expect(repeated.stdout).toContain(`already submitted deliver approved ${approved41} landed ${rebased41}`);
      expect(receiptCount(e2e, "STA-41")).toBe(receiptsBefore);

      // Main holds both deliveries; the deliver receipts name both SHAs.
      expect(mainHead(e2e.repoDir)).not.toBe(mainAfterFirst);
      expect(git(["merge-base", "--is-ancestor", rebased41, "main"], e2e.repoDir).stdout).toBe("");
      expect(readFileSync(join(e2e.repoDir, "forty.txt"), "utf8")).toContain("STA-40 change");
      expect(readFileSync(join(e2e.repoDir, "forty-one.txt"), "utf8")).toContain("STA-41 change");
      for (const [ticket, approved, landed] of [["STA-40", approved40, approved40], ["STA-41", approved41, rebased41]] as const) {
        const issue = e2e.world.issues.find((candidate) => candidate.identifier === ticket)!;
        expect(latestValidReceipt(issue.comments)?.receipt).toMatchObject({
          kind: "deliver",
          checkpoint: approved,
          landed,
        });
      }

      // Owner confirms both landings: Done clears Progress and cleans the checkouts.
      for (const ticket of ["STA-40", "STA-41"]) {
        ownerSetState(e2e.world, ticket, "Done");
        ownerSetProgress(e2e.world, ticket, "Complete");
        const done = expectOk(await e2e.cli(["reconcile", ticket]));
        expect(done.stdout).toContain("done: Deliver+Complete → Done");
        expect(done.stdout).toContain("checkout cleaned");
        expect(progressNames(e2e, ticket)).toEqual([]);
      }
      await e2e.waitFor("both worktrees removed", () => {
        const listed = git(["worktree", "list", "--porcelain"], e2e.repoDir).stdout;
        return !listed.includes("worktrees/sta-40") && !listed.includes("worktrees/sta-41") ? true : null;
      });
      expect(() => git(["rev-parse", "--verify", "refs/heads/feature/sta-40"], e2e.repoDir)).toThrow();
      expect(() => git(["rev-parse", "--verify", "refs/heads/feature/sta-41"], e2e.repoDir)).toThrow();
      expect(readFileSync(join(e2e.repoDir, "forty.txt"), "utf8")).toContain("STA-40 change");
      expect(readFileSync(join(e2e.repoDir, "forty-one.txt"), "utf8")).toContain("STA-41 change");
    });
  });

  test("an unlanded or unknown landed commit is refused with no receipt", async () => {
    await withE2E(async (e2e) => {
      const approved = await approve(e2e, "STA-42", "forty-two.txt");
      expectOk(await e2e.cli(["begin", "STA-42"]));
      const issue = e2e.world.issues.find((candidate) => candidate.identifier === "STA-42")!;
      const receiptsBefore = receiptCount(e2e, "STA-42");

      // Unknown SHA: never existed.
      const unknown = await e2e.cli(["submit", "STA-42", "--input", "-"], {
        stdin: JSON.stringify(deliverPayload(approved, "0".repeat(40))),
      });
      expect(unknown.code).not.toBe(0);
      expect(`${unknown.stdout}\n${unknown.stderr}`).toContain("is not on local main");
      // Real commit on the branch, but never landed on main.
      const unlanded = await e2e.cli(["submit", "STA-42", "--input", "-"], {
        stdin: JSON.stringify(deliverPayload(approved, approved)),
      });
      expect(unlanded.code).not.toBe(0);
      expect(`${unlanded.stdout}\n${unlanded.stderr}`).toContain("is not on local main");
      expect(receiptCount(e2e, "STA-42")).toBe(receiptsBefore);
      expect(issue.stateId).toBe("st-deliver");
      expect(progressNames(e2e, "STA-42")).toEqual(["In progress"]);
      expect(latestValidReceipt(issue.comments)?.receipt).toMatchObject({ kind: "review-pass", checkpoint: approved });

      // Missing landed field: the schema itself refuses.
      const missing = await e2e.cli(["submit", "STA-42", "--input", "-"], {
        stdin: JSON.stringify({ v: 1, kind: "deliver", checkpoint: approved, lineage: "x", merge_ready: true, owner_actions: ["push"] }),
      });
      expect(missing.code).not.toBe(0);
      expect(`${missing.stdout}\n${missing.stderr}`).toContain('needs a "landed" commit');
      expect(receiptCount(e2e, "STA-42")).toBe(receiptsBefore);
    });
  });
});
