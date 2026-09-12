// Worker artifacts cross the existing Commander stdin submit boundary unchanged.
// Only temporary repositories and the fake Linear/Herdr harness are used.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryAddIssue } from "../../workflow/service/linear/fake-memory-linear.ts";
import { latestValidReceipt } from "../../workflow/lifecycle/ticket/protocol.ts";
import { scratchFor } from "../../workflow/service/worktree/worker-scope.ts";
import {
  buildPayload,
  CRITERIA,
  deliverPayload,
  E2E,
  expectFail,
  expectOk,
  git,
  ownerHandoff,
  acceptancePayload,
  worktreeHeadOf,
} from "../support/fake-harness.ts";

test("each stage's JSON artifact is refused without writes until complete, then submitted unchanged and deduplicated", async () => {
  const e2e = await E2E.boot();
  try {
    const ticket = "STA-239";
    const issue = memoryAddIssue(e2e.world, {
      identifier: ticket,
      stateId: "st-todo",
      description: CRITERIA,
      labelIds: ["label-pending"],
    });
    expectOk(await e2e.startStage(ticket));
    const head = worktreeHeadOf(e2e.repoDir, ticket);
    const stages = [
      { kind: "build", role: "builder", marker: "BUILD_HANDOFF_COMPLETE", payload: buildPayload(head), missing: "checks" },
      { kind: "acceptance", role: "acceptance", marker: "ACCEPTANCE_COMPLETE", payload: acceptancePayload(head, "pass"), missing: "environment" },
      { kind: "deliver", role: "deliverer", marker: "DELIVERY_COMPLETE", payload: deliverPayload(head), missing: "owner_actions" },
    ] as const;

    for (const stage of stages) {
      const dir = scratchFor(e2e.repoDir, ticket, stage.role);
      mkdirSync(dir, { recursive: true });
      const artifactPath = join(dir, "submit.json");
      const resultPath = join(dir, "result.md");
      const before = structuredClone(issue);
      const callsBefore = e2e.client.calls.length;

      // Missing files and absent completion markers remain unfinished worker
      // handoffs. A Commander does not infer completion from a JSON file alone.
      expect(() => readFileSync(artifactPath, "utf8")).toThrow("ENOENT");
      writeFileSync(resultPath, "Still checking the evidence.\n");
      expect(readFileSync(resultPath, "utf8")).not.toContain(stage.marker);
      expect(issue).toEqual(before);
      expect(e2e.client.calls).toHaveLength(callsBefore);

      const missing: Record<string, unknown> = { ...stage.payload };
      delete missing[stage.missing];
      const invalid = [
        { bytes: "", error: "submit input is not JSON" },
        { bytes: JSON.stringify(stage.payload).slice(0, -1), error: "submit input is not JSON" },
        { bytes: JSON.stringify(missing), error: `\"${stage.missing}\"` },
        { bytes: JSON.stringify({ ...stage.payload, kind: "wrong-stage" }), error: `\"kind\":\"${stage.kind}\"` },
        { bytes: JSON.stringify({ ...stage.payload, checkpoint: "0".repeat(40) }), error: "checkpoint" },
      ];
      if (stage.kind !== "deliver") {
        invalid.push({
          bytes: JSON.stringify({ ...stage.payload, results: [{ ...stage.payload.results[0], criterion: "another criterion" }] }),
          error: 'misses 1 acceptance criterion: "works"',
        });
      }
      if (stage.kind === "acceptance") {
        invalid.push({
          bytes: JSON.stringify({ ...stage.payload, results: [{ ...stage.payload.results[0], evidence: "" }] }),
          error: "PASS verdict needs every criterion ok with evidence",
        });
      }

      // Even an incorrect completion signal cannot bypass submit validation.
      writeFileSync(resultPath, `${stage.marker}\n`);
      for (const { bytes, error } of invalid) {
        writeFileSync(artifactPath, bytes);
        expectFail(await e2e.cli(["submit", ticket, "--input", "-"], {
          stdin: readFileSync(artifactPath, "utf8"),
        }), error);
        expect(issue).toEqual(before);
        expect(e2e.client.calls.slice(callsBefore).filter((call) => [
          "setIssueState", "setIssueLabels", "addComment", "createAttachment", "createIssueLabel",
        ].includes(call.method))).toEqual([]);
      }

      // The worker fixes its own artifact. After reviewing completion, content,
      // and evidence, the Commander sends exactly these bytes to --input -.
      const bytes = `${JSON.stringify(stage.payload, null, 2)}\n`;
      writeFileSync(artifactPath, bytes);
      expect(readFileSync(resultPath, "utf8").trimEnd().endsWith(stage.marker)).toBe(true);
      const submit = expectOk(await e2e.cli(["submit", ticket, "--input", "-"], {
        stdin: readFileSync(artifactPath, "utf8"),
      }));
      expect(submit.stdout).toContain(`submitted ${stage.kind}`);
      expect(readFileSync(artifactPath, "utf8")).toBe(bytes);
      expect(issue.stateId).toBe(`st-${stage.kind}`);
      expect(issue.labelIds).toEqual(["label-complete"]);
      expect(latestValidReceipt(issue.comments)?.receipt.checkpoint).toBe(head);
      // Markdown evidence stays in the receipt; Igniter adds no attachment.
      if (stage.kind === "acceptance") expect(issue.attachments).toHaveLength(0);
      if (stage.kind === "deliver") expect(issue.comments.at(-1)?.body).toContain(stage.payload.owner_actions[0]);

      const submitted = structuredClone(issue);
      expectOk(await e2e.cli(["submit", ticket, "--input", "-"], {
        stdin: readFileSync(artifactPath, "utf8"),
      }));
      expect(issue).toEqual(submitted);

      // Every successful stage still waits for its owner gate; the worker files
      // never approve their own result. Only the fake Commander advances here.
      if (stage.kind !== "deliver") {
        await ownerHandoff(e2e, ticket);
        expectOk(await e2e.startStage(ticket));
        if (stage.kind === "acceptance") {
          git(["merge", "feature/sta-239", "--no-ff", "-m", "land STA-239"], e2e.repoDir);
        }
      }
    }
  } finally {
    await e2e.close();
  }
}, 30_000);
