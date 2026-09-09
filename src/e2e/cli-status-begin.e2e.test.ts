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

      const begun = expectOk(await e2e.startStage("STA-1"));
      expect(begun.stdout).toContain("builder-sta-1");
      expect(begun.stdout).toContain("build+in_progress");

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
      expectOk(await e2e.startStage("STA-1"));

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

  test("begin normalizes a bare Todo and enters Build+In progress in one operation", async () => {
    await withE2E(async (e2e) => {
      memoryAddIssue(e2e.world, {
        identifier: "STA-2",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: [],
      });
      const begun = expectOk(await e2e.startStage("STA-2"));
      expect(begun.stdout).toContain("builder-sta-2");
      expect(begun.stdout).toContain("build+in_progress");
      const issue = (await e2e.client.fetchIssue("STA-2"))!;
      expect(issue.state.name).toBe("Build");
      expect((issue.labels ?? []).map((l) => l.name)).toEqual(["In progress"]);
      expect(e2e.workspaces.workspaces.filter((w) => !w.closed)).toHaveLength(1);
      expect(e2e.workspaces.agents.filter((a) => a.name === "builder-sta-2")).toHaveLength(1);
    });
  });

  test("status <ticket> --json on a bare Todo reports an actionable next step with no writes", async () => {
    await withE2E(async (e2e) => {
      memoryAddIssue(e2e.world, {
        identifier: "STA-3",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: [],
      });
      const json = expectOk(await e2e.cli(["status", "STA-3", "--json"]));
      const payload = JSON.parse(json.stdout) as {
        status: string;
        progress: string | null;
        next: string[];
        note: string | null;
      };
      expect(payload.status).toBe("todo");
      expect(payload.progress).toBeNull();
      expect(payload.next).toEqual(["worker start", "begin"]);
      expect(payload.note).toContain("bare Todo");
      expect(payload.note).toContain("confirm worker start delivery before begin");
      const issue = (await e2e.client.fetchIssue("STA-3"))!;
      expect(issue.state.name).toBe("Todo");
      expect(issue.labels ?? []).toEqual([]);
      expect(e2e.workspaces.workspaces).toEqual([]);
    });
  });

  test("begin refuses a conflicting Todo with several Progress labels and starts nothing", async () => {
    await withE2E(async (e2e) => {
      memoryAddIssue(e2e.world, {
        identifier: "STA-4",
        stateId: "st-todo",
        description: CRITERIA,
        labelIds: ["label-pending", "label-blocked"],
      });
      const result = await e2e.cli(["begin", "STA-4"]);
      expectFail(result, "2 Progress labels");
      const issue = (await e2e.client.fetchIssue("STA-4"))!;
      expect(issue.state.name).toBe("Todo");
      expect((issue.labels ?? []).map((l) => l.name)).toEqual(["Pending", "Blocked"]);
      expect(e2e.workspaces.workspaces.filter((w) => !w.closed)).toHaveLength(0);
      expect(e2e.workspaces.agents).toHaveLength(0);
    });
  });
});
