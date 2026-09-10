import { describe, expect, test } from "bun:test";
import { memoryAddIssue, ownerSetProgress, ownerSetState } from "../dispatch/fake-memory-linear.ts";
import { parseReceiptBlock } from "../dispatch/protocol.ts";
import {
  E2E,
  CRITERIA,
  buildPayload,
  commandEvidencePayload,
  commitWorktreeFile,
  deliverPayload,
  expectFail,
  expectOk,
  git,
  ownerHandoff,
  reviewPayload,
} from "./fake-harness.ts";

async function withE2E(fn: (e2e: E2E) => Promise<void>): Promise<void> {
  const e2e = await E2E.boot();
  try {
    await fn(e2e);
  } finally {
    await e2e.close();
  }
}

function addTodo(e2e: E2E, identifier: string): void {
  memoryAddIssue(e2e.world, {
    identifier,
    stateId: "st-todo",
    description: CRITERIA,
    labelIds: ["label-pending"],
  });
}

function receiptCount(e2e: E2E, identifier: string): number {
  const issue = e2e.world.issues.find((candidate) => candidate.identifier === identifier)!;
  return issue.comments.filter((comment) => {
    try {
      return parseReceiptBlock(comment.body) !== null;
    } catch {
      return false;
    }
  }).length;
}

async function beginAndCommit(e2e: E2E, identifier: string): Promise<string> {
  addTodo(e2e, identifier);
  expectOk(await e2e.startStage(identifier));
  return commitWorktreeFile(e2e.repoDir, identifier, "work.txt", `${identifier}\n`, `${identifier} work`);
}

describe("e2e safe submit retries", () => {
  test("fail-before-write and write-success-response-lost converge to one build receipt", async () => {
    await withE2E(async (e2e) => {
      const firstHead = await beginAndCommit(e2e, "STA-20");
      e2e.client.failNext("addComment", { status: 502, message: "failed before write", afterWrite: false });
      expectOk(await e2e.cli(["submit", "STA-20", "--input", "-"], {
        stdin: JSON.stringify(buildPayload(firstHead)),
      }));
      expect(receiptCount(e2e, "STA-20")).toBe(1);

      const secondHead = await beginAndCommit(e2e, "STA-21");
      e2e.client.failNext("addComment", { status: 504, message: "response lost", afterWrite: true });
      expectOk(await e2e.cli(["submit", "STA-21", "--input", "-"], {
        stdin: JSON.stringify(buildPayload(secondHead)),
      }));
      expect(receiptCount(e2e, "STA-21")).toBe(1);
      expect(e2e.world.issues.find((issue) => issue.identifier === "STA-21")?.stateId).toBe("st-build");
      expect(e2e.world.issues.find((issue) => issue.identifier === "STA-21")?.labelIds).toContain("label-complete");
    });
  });

  test("a completed submit can be resent without a second receipt", async () => {
    await withE2E(async (e2e) => {
      const head = await beginAndCommit(e2e, "STA-22");
      const payload = JSON.stringify(buildPayload(head));
      expectOk(await e2e.cli(["submit", "STA-22", "--input", "-"], { stdin: payload }));
      const repeated = expectOk(await e2e.cli(["submit", "STA-22", "--input", "-"], { stdin: payload }));
      expect(repeated.stdout).toContain(`already submitted build ${head}`);
      expect(repeated.stderr).toBe("");
      expect(receiptCount(e2e, "STA-22")).toBe(1);
    });
  });

  test("old build and Review FAIL payloads cannot rewind a newly started round", async () => {
    await withE2E(async (e2e) => {
      const head = await beginAndCommit(e2e, "STA-220");
      const build = JSON.stringify(buildPayload(head));
      expectOk(await e2e.cli(["submit", "STA-220", "--input", "-"], { stdin: build }));
      await ownerHandoff(e2e, "STA-220");
      expectOk(await e2e.startStage("STA-220"));

      const oldBuild = expectOk(await e2e.cli(["submit", "STA-220", "--input", "-"], { stdin: build }));
      expect(oldBuild.stdout).toContain("already submitted build");
      let issue = e2e.world.issues.find((candidate) => candidate.identifier === "STA-220")!;
      expect(issue.stateId).toBe("st-review");
      expect(issue.labelIds).toContain("label-in-progress");

      const failedReview = JSON.stringify(commandEvidencePayload(head, "fail"));
      expectOk(await e2e.cli(["submit", "STA-220", "--input", "-"], { stdin: failedReview }));
      expectOk(await e2e.startStage("STA-220"));
      const oldFail = expectOk(await e2e.cli(["submit", "STA-220", "--input", "-"], { stdin: failedReview }));
      expect(oldFail.stdout).toContain("already submitted review FAIL");
      issue = e2e.world.issues.find((candidate) => candidate.identifier === "STA-220")!;
      expect(issue.stateId).toBe("st-build");
      expect(issue.labelIds).toContain("label-in-progress");
      expect(issue.labelIds).not.toContain("label-pending");
      expect(receiptCount(e2e, "STA-220")).toBe(2);
    });
  });

  test("a failed initial read writes nothing and a retry converges", async () => {
    await withE2E(async (e2e) => {
      const head = await beginAndCommit(e2e, "STA-23");
      e2e.client.failNextReads("fetchIssue", 1, 502, "read unavailable");
      const failed = await e2e.cli(["submit", "STA-23", "--input", "-"], {
        stdin: JSON.stringify(buildPayload(head)),
      });
      expectFail(failed, "read unavailable");
      expect(failed.stdout).toBe("");
      expect(receiptCount(e2e, "STA-23")).toBe(0);
      expect(e2e.world.issues.find((issue) => issue.identifier === "STA-23")?.stateId).toBe("st-build");

      expectOk(await e2e.cli(["submit", "STA-23", "--input", "-"], {
        stdin: JSON.stringify(buildPayload(head)),
      }));
      expect(receiptCount(e2e, "STA-23")).toBe(1);
    });
  });

  test("a lost state-write response and repeated readback failure converge without replay", async () => {
    await withE2E(async (e2e) => {
      const lostHead = await beginAndCommit(e2e, "STA-27");
      e2e.client.failNext("setIssueState", { status: 504, message: "state response lost", afterWrite: true });
      expectOk(await e2e.cli(["submit", "STA-27", "--input", "-"], {
        stdin: JSON.stringify(buildPayload(lostHead)),
      }));
      expect(receiptCount(e2e, "STA-27")).toBe(1);
      expect(e2e.world.issues.find((issue) => issue.identifier === "STA-27")?.labelIds).toContain("label-complete");

      const readHead = await beginAndCommit(e2e, "STA-28");
      const payload = JSON.stringify(buildPayload(readHead));
      // submitForTicket, publishReceipt, and verifyReceipt read first. The
      // next two reads happen after the state write and both fail.
      e2e.client.failAfter("fetchIssue", 3, { status: 502, message: "post-write read unavailable", afterWrite: false });
      e2e.client.failNext("fetchIssue", { status: 502, message: "post-write read still unavailable", afterWrite: false });
      expectFail(await e2e.cli(["submit", "STA-28", "--input", "-"], { stdin: payload }), "post-write read");
      const partial = e2e.world.issues.find((issue) => issue.identifier === "STA-28")!;
      expect(partial.stateId).toBe("st-build");
      expect(partial.labelIds).toContain("label-in-progress");
      expect(receiptCount(e2e, "STA-28")).toBe(1);

      // The first Build never leaves Build: the retry converges through the
      // normal idempotent path (receipt adopted, no duplicate) and rests at
      // Build+Complete for the owner.
      const retry = expectOk(await e2e.cli(["submit", "STA-28", "--input", "-"], { stdin: payload }));
      expect(retry.stdout).toContain(`submitted build ${readHead} → Build+Complete`);
      expect(partial.stateId).toBe("st-build");
      expect(partial.labelIds).toContain("label-complete");
      expect(partial.labelIds).not.toContain("label-in-progress");
      expect(receiptCount(e2e, "STA-28")).toBe(1);
    });
  });

  test("evidence readback failure retries without duplicate attachment or receipt", async () => {
    await withE2E(async (e2e) => {
      const head = await beginAndCommit(e2e, "STA-24");
      expectOk(await e2e.cli(["submit", "STA-24", "--input", "-"], {
        stdin: JSON.stringify(buildPayload(head)),
      }));
      await ownerHandoff(e2e, "STA-24");
      expectOk(await e2e.startStage("STA-24"));
      const payload = JSON.stringify(reviewPayload(head, "pass", "https://example.com/e2e/retry-proof"));
      e2e.client.failNextReads("listAttachments", 1, 502, "attachment readback unavailable");
      expectFail(
        await e2e.cli(["submit", "STA-24", "--input", "-"], { stdin: payload }),
        "attachment readback unavailable",
      );
      expect(e2e.world.issues.find((issue) => issue.identifier === "STA-24")?.attachments).toHaveLength(1);
      expect(receiptCount(e2e, "STA-24")).toBe(1); // build only

      expectOk(await e2e.cli(["submit", "STA-24", "--input", "-"], { stdin: payload }));
      const issue = e2e.world.issues.find((candidate) => candidate.identifier === "STA-24")!;
      expect(issue.attachments).toHaveLength(1);
      expect(receiptCount(e2e, "STA-24")).toBe(2);
      expect(issue.stateId).toBe("st-review");
      expect(issue.labelIds).toContain("label-complete");
    });
  });

});

describe("e2e separate Linear reconciliation and worker cleanup", () => {
  test("reconcile ignores worker metadata failures and performs no worker follow-up", async () => {
    await withE2E(async (e2e) => {
      const head = await beginAndCommit(e2e, "STA-26");
      expectOk(await e2e.cli(["submit", "STA-26", "--input", "-"], {
        stdin: JSON.stringify(buildPayload(head)),
      }));
      await ownerHandoff(e2e, "STA-26");
      expectOk(await e2e.startStage("STA-26"));
      expectOk(await e2e.cli(["submit", "STA-26", "--input", "-"], {
        stdin: JSON.stringify(reviewPayload(head, "pass")),
      }));
      ownerSetState(e2e.world, "STA-26", "Deliver");
      ownerSetProgress(e2e.world, "STA-26", "Complete");
      e2e.workspaces.failNext("workspace.report_metadata");

      const workerCalls = e2e.workspaces.calls.length;
      expectOk(await e2e.cli(["reconcile", "STA-26"]));
      const issue = e2e.world.issues.find((candidate) => candidate.identifier === "STA-26")!;
      expect(issue.stateId).toBe("st-deliver");
      expect(issue.labelIds).toContain("label-pending");
      const retry = expectOk(await e2e.cli(["reconcile", "STA-26"]));
      expect(retry.stdout).toContain("no owner transition to reconcile");
      expect(e2e.workspaces.calls).toHaveLength(workerCalls);
      expect(receiptCount(e2e, "STA-26")).toBe(2);
      expect(e2e.world.issues.find((candidate) => candidate.identifier === "STA-26")?.attachments).toHaveLength(1);
    });
  });

  test("Done reconcile leaves workers alone and explicit worker stop retries a failed close", async () => {
    await withE2E(async (e2e) => {
      const head = await beginAndCommit(e2e, "STA-29");
      expectOk(await e2e.cli(["submit", "STA-29", "--input", "-"], { stdin: JSON.stringify(buildPayload(head)) }));
      await ownerHandoff(e2e, "STA-29");
      expectOk(await e2e.startStage("STA-29"));
      expectOk(await e2e.cli(["submit", "STA-29", "--input", "-"], { stdin: JSON.stringify(reviewPayload(head, "pass")) }));
      ownerSetState(e2e.world, "STA-29", "Deliver");
      ownerSetProgress(e2e.world, "STA-29", "Complete");
      expectOk(await e2e.cli(["reconcile", "STA-29"]));
      expectOk(await e2e.startStage("STA-29"));
      git(["merge", "feature/sta-29", "--no-ff", "-m", "land STA-29"], e2e.repoDir);
      expectOk(await e2e.cli(["submit", "STA-29", "--input", "-"], { stdin: JSON.stringify(deliverPayload(head)) }));
      ownerSetState(e2e.world, "STA-29", "Done");
      ownerSetProgress(e2e.world, "STA-29", "Complete");
      e2e.workspaces.failNext("workspace.close");

      expectOk(await e2e.cli(["reconcile", "STA-29"]));
      expectFail(await e2e.cli(["worker", "stop", "STA-29"]), "fake herdr exploded");
      expect(e2e.world.issues.find((issue) => issue.identifier === "STA-29")?.labelIds).not.toContain("label-complete");
      expect(e2e.workspaces.workspaces.find((workspace) => workspace.label === "STA-29")?.closed).toBe(false);
      const retry = expectOk(await e2e.cli(["worker", "stop", "STA-29"]));
      expect(retry.stdout).toContain("workers stopped");
      expect(e2e.workspaces.workspaces.find((workspace) => workspace.label === "STA-29")?.closed).toBe(true);
    });
  });
});
