// Black-box CLI vertical slice: the real CLI subprocess drives the real
// dispatch HTTP service, which drives the stateful memory Linear client, a
// real temp git repo, and fake Herdr. No real credentials, no real Linear.
import { describe, expect, test } from "bun:test";
import { memoryAddIssue } from "../dispatch/fake-memory-linear.ts";
import { latestValidReceipt } from "../dispatch/protocol.ts";
import { E2E, CRITERIA, expectFail, expectOk, worktreeHeadOf, type CliResult } from "./fake-harness.ts";

async function withE2E(fn: (e2e: E2E) => Promise<void>): Promise<void> {
  const e2e = await E2E.boot();
  try {
    await fn(e2e);
  } finally {
    await e2e.close();
  }
}

describe("e2e status/begin vertical slice", () => {
  test("status reports free slots on an empty queue", async () => {
    await withE2E(async (e2e) => {
      const text = expectOk(await e2e.cli(["status"]));
      expect(text.stdout).toContain("0 / 3 slots");
      expect(text.stderr).toBe("");

      const json = expectOk(await e2e.cli(["status", "--json"]));
      const payload = JSON.parse(json.stdout) as { slots: { used: number; max: number }; queue: unknown[] };
      expect(payload.slots).toEqual({ used: 0, max: 3 });
      expect(payload.queue).toEqual([]);
    });
  });

  test("begin moves Todo+Pending to Build+In progress with one Progress label", async () => {
    await withE2E(async (e2e) => {
      memoryAddIssue(e2e.world, {
        identifier: "STA-1",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: ["label-pending"],
      });

      const begun = expectOk(await e2e.cli(["begin", "STA-1"]));
      expect(begun.stdout).toContain("builder-sta-1");
      expect(begun.stdout).toContain("Todo → Build");

      const issue = (await e2e.client.fetchIssue("STA-1"))!;
      expect(issue.state.name).toBe("Build");
      expect((issue.labels ?? []).map((l) => l.name)).toEqual(["In progress"]);

      const head = worktreeHeadOf(e2e.repoDir, "STA-1");
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      const inbox = e2e.workspaces.promptsFor("builder-sta-1");
      expect(inbox.length).toBe(1);
      expect(inbox[0]).toContain(head);
      expect(latestValidReceipt(issue.comments)).toBeNull();
    });
  });

  test("status <ticket> --json reports the live worker and next steps", async () => {
    await withE2E(async (e2e) => {
      memoryAddIssue(e2e.world, {
        identifier: "STA-1",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: ["label-pending"],
      });
      expectOk(await e2e.cli(["begin", "STA-1"]));

      const json = expectOk(await e2e.cli(["status", "STA-1", "--json"]));
      const payload = JSON.parse(json.stdout) as {
        status: string;
        progress: string;
        checkpoint: string | null;
        next: string[];
        submit_schema: { checkpoint: string };
      };
      expect(payload.status).toBe("build");
      expect(payload.progress).toBe("in_progress");
      // Begin writes no receipt, so the checkpoint is still null; the
      // submit schema names the worktree HEAD the submit must bind.
      expect(payload.checkpoint).toBeNull();
      expect(payload.submit_schema.checkpoint).toBe("<worktree HEAD>");
      expect(payload.next).toContain("submit");
    });
  });

  test("begin refuses an unknown ticket with a recognizable error", async () => {
    await withE2E(async (e2e) => {
      const result: CliResult = await e2e.cli(["begin", "STA-9"]);
      expectFail(result, 'ticket "STA-9" was not found in Linear');
      expect(e2e.workspaces.workspaces).toEqual([]);
    });
  });
});
