// Full CLI lifecycle through the real service: worker start then begin,
// Build submit, Acceptance PASS, receipt-bound approve, Deliver submit, Done
// approval and explicit worker stop. Submits never
// touch git. A second ticket covers Acceptance FAIL back to Build Pending,
// including a stale ended builder row that is replaced for the new work order.
import { describe, expect, test } from "bun:test";
import { memoryAddIssue, memoryAddLabel } from "../../workflow/service/linear/fake-memory-linear.ts";
import { latestValidReceipt, parseReceiptBlock } from "../../workflow/lifecycle/ticket/protocol.ts";
import {
  E2E,
  CRITERIA,
  buildPayload,
  commandEvidencePayload,
  commitWorktreeFile,
  deliverPayload,
  expectOk,
  git,
  mainHead,
  ownerHandoff,
  acceptancePayload,
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

function progressNames(labels: { name: string }[] | undefined): string[] {
  return (labels ?? []).map((l) => l.name).sort();
}

async function buildSubmit(e2e: E2E, ticket: string): Promise<string> {
  const head = commitWorktreeFile(e2e.repoDir, ticket, "work.txt", `${ticket} work\n`, `${ticket} work`);
  const out = expectOk(await e2e.cli(["submit", ticket, "--input", "-"], { stdin: JSON.stringify(buildPayload(head)) }));
  expect(out.stdout).toContain(`submitted build ${head} → Build+Complete`);
  return head;
}

/** First Build submit plus the owner handoff, ending at Acceptance+Pending. */
async function buildAndHandoff(e2e: E2E, ticket: string): Promise<string> {
  const head = await buildSubmit(e2e, ticket);
  await ownerHandoff(e2e, ticket);
  return head;
}

describe("e2e full lifecycle to Done", () => {
  test("Todo begin, Build submit, Acceptance PASS, owner Deliver, Deliver submit, owner Done", async () => {
    await withE2E(async (e2e) => {
      const mainBefore = mainHead(e2e.repoDir);
      const feature = memoryAddLabel(e2e.world, { name: "Feature" });
      memoryAddIssue(e2e.world, {
        identifier: "STA-10",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: ["label-pending", feature.id],
      });

      const begun = expectOk(await e2e.startStage("STA-10"));
      expect(begun.stdout).toContain("builder-sta-10");
      let issue = (await e2e.client.fetchIssue("STA-10"))!;
      expect(issue.state.name).toBe("Build");
      expect(progressNames(issue.labels)).toEqual(["Feature", "In progress"]);

      const head = await buildSubmit(e2e, "STA-10");
      issue = (await e2e.client.fetchIssue("STA-10"))!;
      expect(issue.state.name).toBe("Build");
      expect(progressNames(issue.labels)).toEqual(["Complete", "Feature"]);
      const buildReceipt = latestValidReceipt(issue.comments)!;
      expect(buildReceipt.receipt.kind).toBe("build");
      expect(buildReceipt.receipt.checkpoint).toBe(head);

      // The first Build waits for the owner: repeated reconciles keep it still.
      const held = expectOk(await e2e.cli(["reconcile", "STA-10"]));
      expect(held.stdout).toContain("no owner transition to reconcile (build+complete)");
      expectOk(await e2e.cli(["reconcile", "STA-10"]));
      issue = (await e2e.client.fetchIssue("STA-10"))!;
      expect(issue.state.name).toBe("Build");
      expect(progressNames(issue.labels)).toEqual(["Complete", "Feature"]);

      // The owner explicitly approves the first Build receipt.
      await ownerHandoff(e2e, "STA-10");
      issue = (await e2e.client.fetchIssue("STA-10"))!;
      expect(issue.state.name).toBe("Acceptance");
      expect(progressNames(issue.labels)).toEqual(["Feature", "Pending"]);

      expectOk(await e2e.startStage("STA-10"));
      expect(e2e.workspaces.promptsFor("acceptance-sta-10")).toHaveLength(1);
      const pass = expectOk(
        await e2e.cli(["submit", "STA-10", "--input", "-"], { stdin: JSON.stringify(acceptancePayload(head, "pass")) }),
      );
      expect(pass.stdout).toContain(`submitted acceptance PASS ${head} → Acceptance+Complete`);
      issue = (await e2e.client.fetchIssue("STA-10"))!;
      expect(progressNames(issue.labels)).toEqual(["Complete", "Feature"]);
      // Markdown evidence lands in the receipt, not as an auto-attached file.
      expect(await e2e.client.listAttachments("STA-10")).toHaveLength(0);
      const receipt = issue.comments.at(-1)?.body ?? "";
      expect(receipt).toContain("**Evidence**");
      expect(receipt).toContain("evidence-1.png");

      // Acceptance PASS waits for the owner: reconcile converges nothing.
      const gate = expectOk(await e2e.cli(["reconcile", "STA-10"]));
      expect(gate.stdout).toContain("no owner transition to reconcile (acceptance+complete)");
      issue = (await e2e.client.fetchIssue("STA-10"))!;
      expect(issue.state.name).toBe("Acceptance");

      // Approval binds the current receipt instead of implicitly continuing.
      const acceptanceStatus = JSON.parse(expectOk(await e2e.cli(["status", "STA-10", "--json"])).stdout) as { receipt: { id: string } };
      const approved = expectOk(await e2e.cli(["approve", "STA-10", acceptanceStatus.receipt.id]));
      expect(approved.stdout).toContain("acceptance+complete → deliver+pending");
      issue = (await e2e.client.fetchIssue("STA-10"))!;
      expect(issue.state.name).toBe("Deliver");
      expect(progressNames(issue.labels)).toEqual(["Feature", "Pending"]);

      expectOk(await e2e.startStage("STA-10"));
      expect(e2e.workspaces.promptsFor("deliverer-sta-10")).toHaveLength(1);
      // Deliver lands the branch with real git first, then submits the
      // approved checkpoint together with the landed commit.
      git(["merge", "feature/sta-10", "--no-ff", "-m", "land STA-10"], e2e.repoDir);
      expect(git(["merge-base", "--is-ancestor", head, "main"], e2e.repoDir).stdout).toBe("");
      const delivered = expectOk(
        await e2e.cli(["submit", "STA-10", "--input", "-"], { stdin: JSON.stringify(deliverPayload(head)) }),
      );
      expect(delivered.stdout).toContain(`submitted deliver approved ${head} landed ${head} → Deliver+Complete`);
      // The landing already happened: main holds the delivery.
      expect(mainHead(e2e.repoDir)).not.toBe(mainBefore);
      expect(git(["rev-parse", "feature/sta-10"], e2e.repoDir).stdout.trim()).toBe(head);

      // Done approval leaves the checkout intact until explicit worker stop.
      const deliverStatus = JSON.parse(expectOk(await e2e.cli(["status", "STA-10", "--json"])).stdout) as { receipt: { id: string } };
      const done = expectOk(await e2e.cli(["approve", "STA-10", deliverStatus.receipt.id]));
      expect(done.stdout).toContain("deliver+complete → done");
      expect(git(["worktree", "list", "--porcelain"], e2e.repoDir).stdout).toContain("worktrees/sta-10");
      expectOk(await e2e.cli(["worker", "stop", "STA-10"]));
      issue = (await e2e.client.fetchIssue("STA-10"))!;
      expect(issue.state.name).toBe("Done");
      expect(progressNames(issue.labels)).toEqual(["Feature"]);
      // Safe cleanup: the worktree and branch are gone, main holds the delivery.
      await e2e.waitFor("worktree removal", () => {
        const listed = git(["worktree", "list", "--porcelain"], e2e.repoDir).stdout;
        return !listed.includes("worktrees/sta-10") ? true : null;
      });
      expect(() => git(["rev-parse", "--verify", "refs/heads/feature/sta-10"], e2e.repoDir)).toThrow();
      expect(git(["merge-base", "--is-ancestor", head, "main"], e2e.repoDir).stdout).toBe("");
      expect(mainHead(e2e.repoDir)).not.toBe(mainBefore);
    });
  });
});

describe("e2e Acceptance FAIL back to Build", () => {
  test("FAIL returns Build Pending, then begin replaces a stale ended builder and Acceptance completes", async () => {
    await withE2E(async (e2e) => {
      const feature = memoryAddLabel(e2e.world, { name: "Feature" });
      memoryAddIssue(e2e.world, {
        identifier: "STA-11",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: ["label-pending", feature.id],
      });

      expectOk(await e2e.startStage("STA-11"));
      const first = await buildAndHandoff(e2e, "STA-11");
      expectOk(await e2e.startStage("STA-11"));
      const fail = expectOk(
        await e2e.cli(["submit", "STA-11", "--input", "-"], {
          stdin: JSON.stringify(commandEvidencePayload(first, "fail")),
        }),
      );
      expect(fail.stdout).toContain(`submitted acceptance FAIL ${first} → Build+Pending`);
      let issue = (await e2e.client.fetchIssue("STA-11"))!;
      expect(issue.state.name).toBe("Build");
      expect(progressNames(issue.labels)).toEqual(["Feature", "Pending"]);
      expect(latestValidReceipt(issue.comments)?.receipt.kind).toBe("acceptance-fail");

      // The old builder ended but its row lingers in the snapshot.
      e2e.workspaces.agents.find((a) => a.name === "builder-sta-11")!.agentStatus = "done";
      const startsBefore = e2e.workspaces.calls.filter((call) => call.method === "agent.start").length;
      const again = expectOk(await e2e.startStage("STA-11"));
      expect(again.stdout).toContain("STA-11: build worker");
      issue = (await e2e.client.fetchIssue("STA-11"))!;
      expect(issue.state.name).toBe("Build");
      expect(progressNames(issue.labels)).toEqual(["Feature", "In progress"]);
      // The replacement worker really receives the new work order/checkpoint.
      const inbox = e2e.workspaces.promptsFor("builder-sta-11");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toContain(first);
      expect(e2e.workspaces.agents.filter((a) => a.name === "builder-sta-11")).toHaveLength(1);
      expect(e2e.workspaces.calls.filter((call) => call.method === "agent.start")).toHaveLength(startsBefore + 1);

      // Round two completes Acceptance: new checkpoint, correction build lands
      // straight back in Acceptance+Pending with no owner step.
      const second = commitWorktreeFile(e2e.repoDir, "STA-11", "work2.txt", "round two\n", "STA-11 round two");
      expect(second).not.toBe(first);
      const corrected = expectOk(
        await e2e.cli(["submit", "STA-11", "--input", "-"], { stdin: JSON.stringify(buildPayload(second)) }),
      );
      expect(corrected.stdout).toContain("→ Acceptance+Pending");
      const rebegin = expectOk(await e2e.startStage("STA-11"));
      expect(rebegin.stdout).toContain("work order confirmed");
      const acceptanceInbox = e2e.workspaces.promptsFor("acceptance-sta-11");
      expect(acceptanceInbox[acceptanceInbox.length - 1]).toContain(second);
      const pass = expectOk(
        await e2e.cli(["submit", "STA-11", "--input", "-"], {
          stdin: JSON.stringify(commandEvidencePayload(second, "pass")),
        }),
      );
      expect(pass.stdout).toContain(`submitted acceptance PASS ${second} → Acceptance+Complete`);
      issue = (await e2e.client.fetchIssue("STA-11"))!;
      const newest = latestValidReceipt(issue.comments)!;
      expect(newest.receipt.kind).toBe("acceptance-pass");
      expect(newest.receipt.checkpoint).toBe(second);
      expect(parseReceiptBlock(issue.comments[issue.comments.length - 1]!.body)?.checkpoint).toBe(second);
    });
  });
});

describe("e2e owner gates", () => {
  test("Acceptance PASS and Deliver Complete wait for the owner; reconcile stays quiet", async () => {
    await withE2E(async (e2e) => {
      memoryAddIssue(e2e.world, {
        identifier: "STA-12",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: ["label-pending"],
      });
      memoryAddIssue(e2e.world, {
        identifier: "STA-13",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: ["label-pending"],
      });

      // STA-12 through real submits to Acceptance+Complete.
      expectOk(await e2e.startStage("STA-12"));
      const head12 = await buildAndHandoff(e2e, "STA-12");
      expectOk(await e2e.startStage("STA-12"));
      expectOk(
        await e2e.cli(["submit", "STA-12", "--input", "-"], { stdin: JSON.stringify(acceptancePayload(head12, "pass")) }),
      );

      // Acceptance PASS alone never advances: the gate holds for the owner.
      const held = expectOk(await e2e.cli(["reconcile", "STA-12"]));
      expect(held.stdout).toContain("no owner transition to reconcile (acceptance+complete)");
      let issue = (await e2e.client.fetchIssue("STA-12"))!;
      expect(issue.state.name).toBe("Acceptance");
      expect(progressNames(issue.labels)).toEqual(["Complete"]);
      expect(e2e.workspaces.workspaces.filter((w) => !w.closed)).toHaveLength(1);

      // STA-13 through real submits to Deliver+Complete.
      expectOk(await e2e.startStage("STA-13"));
      const head13 = await buildAndHandoff(e2e, "STA-13");
      expectOk(await e2e.startStage("STA-13"));
      expectOk(
        await e2e.cli(["submit", "STA-13", "--input", "-"], { stdin: JSON.stringify(acceptancePayload(head13, "pass")) }),
      );
      const acceptanceStatus = JSON.parse(expectOk(await e2e.cli(["status", "STA-13", "--json"])).stdout) as { receipt: { id: string } };
      expectOk(await e2e.cli(["approve", "STA-13", acceptanceStatus.receipt.id]));
      expectOk(await e2e.startStage("STA-13"));
      git(["merge", "feature/sta-13", "--no-ff", "-m", "land STA-13"], e2e.repoDir);
      expectOk(
        await e2e.cli(["submit", "STA-13", "--input", "-"], { stdin: JSON.stringify(deliverPayload(head13)) }),
      );

      // Deliver Complete alone never lands: the gate holds for the owner.
      const landed = expectOk(await e2e.cli(["reconcile", "STA-13"]));
      expect(landed.stdout).toContain("no owner transition to reconcile (deliver+complete)");
      issue = (await e2e.client.fetchIssue("STA-13"))!;
      expect(issue.state.name).toBe("Deliver");
      expect(progressNames(issue.labels)).toEqual(["Complete"]);
      expect(worktreeHeadOf(e2e.repoDir, "STA-13")).toBe(head13);
    });
  });
});
