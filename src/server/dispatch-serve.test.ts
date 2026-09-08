// Production command-service assembly against fake Linear and Herdr edges.
// The service validates once, then stays completely idle until an explicit
// request names the work to perform.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDispatchConfig } from "../dispatch/config";
import { addIssue, standardWorld, startFakeLinear, type FakeLinearHandle } from "../dispatch/fake-linear";
import { FakeGit } from "../dispatch/fake-git";
import { LinearClient } from "../dispatch/linear";
import { receiptBlock } from "../dispatch/protocol";
import { FakeWorkspaces } from "../dispatch/fake-workspaces";
import { startDispatchServe, type DispatchServeHandle } from "./dispatch-serve";

const TODO = "st-todo";
const PENDING = "label-pending";
const CRITERIA = "## 驗收條件\n- [ ] works\n";

interface Assembly {
  handle: DispatchServeHandle;
  fake: FakeLinearHandle;
  git: FakeGit;
  workspaces: FakeWorkspaces;
  stop: () => Promise<void>;
}

async function assemble(seed?: (world: ReturnType<typeof standardWorld>) => void): Promise<Assembly> {
  const world = standardWorld("test-key");
  seed?.(world);
  const fake = startFakeLinear(world);
  const repoRoot = mkdtempSync(join(tmpdir(), "igniter-dispatch-"));
  mkdirSync(join(repoRoot, ".igniter"), { recursive: true });
  const workspaces = new FakeWorkspaces();
  const git = new FakeGit();
  const handle = await startDispatchServe({
    repoRoot,
    config: parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 2 }),
    client: new LinearClient({ apiKey: "test-key", endpoint: fake.url }),
    workspaces,
    git,
    port: 0,
    print: () => {},
  });
  return {
    handle,
    fake,
    git,
    workspaces,
    stop: async () => {
      await handle.stop();
      fake.stop();
    },
  };
}

async function post(base: string, argv: string[]): Promise<{ status: number; ok: boolean; text: string }> {
  const response = await fetch(`${base}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ argv }),
  });
  const body = (await response.json()) as { ok: boolean; text: string };
  return { status: response.status, ...body };
}

describe("command-driven dispatch serve", () => {
  test("idle time performs no Linear requests or workspace mutations", async () => {
    const assembly = await assemble((world) => {
      addIssue(world, {
        identifier: "STA-1",
        stateId: TODO,
        priority: 1,
        description: CRITERIA,
        labelIds: [PENDING],
      });
    });
    try {
      const requestsAfterValidation = assembly.fake.requests;
      await Bun.sleep(100);
      expect(assembly.fake.requests).toBe(requestsAfterValidation);
      expect(assembly.workspaces.calls).toEqual([]);
      expect(assembly.fake.world.issues[0]).toMatchObject({ stateId: TODO, labelIds: [PENDING] });
    } finally {
      await assembly.stop();
    }
  });

  test("begin names and changes one ticket only", async () => {
    const assembly = await assemble((world) => {
      for (const identifier of ["STA-1", "STA-2"]) {
        addIssue(world, { identifier, stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      }
    });
    try {
      const result = await post(assembly.handle.base, ["begin", "STA-1"]);
      expect(result).toMatchObject({ status: 200, ok: true });
      expect(assembly.fake.world.issues.find((issue) => issue.identifier === "STA-1")).toMatchObject({
        stateId: "st-build",
        labelIds: ["label-in-progress"],
      });
      expect(assembly.fake.world.issues.find((issue) => issue.identifier === "STA-2")).toMatchObject({
        stateId: TODO,
        labelIds: [PENDING],
      });
      expect(assembly.workspaces.workspaces.map((workspace) => workspace.label)).toEqual(["STA-1"]);
    } finally {
      await assembly.stop();
    }
  });

  test("reconcile converges the named owner move only", async () => {
    const checkpoint = "deadbeefcafe0001";
    const assembly = await assemble((world) => {
      for (const identifier of ["STA-1", "STA-2"]) {
        addIssue(world, {
          identifier,
          stateId: "st-deliver",
          priority: 1,
          description: CRITERIA,
          labelIds: ["label-complete"],
          comments: [{
            id: `receipt-${identifier}`,
            body: `Agent acceptance: PASS\n\n${receiptBlock("review-pass", checkpoint, `submission-${identifier}`)}\n`,
          }],
        });
      }
    });
    try {
      assembly.git.ancestors.add(`${checkpoint} feature/sta-1`);
      const result = await post(assembly.handle.base, ["reconcile", "STA-1"]);
      expect(result).toMatchObject({ status: 200, ok: true });
      expect(result.text).toContain("approved: Review+Complete → Deliver+Pending");
      expect(assembly.fake.world.issues.find((issue) => issue.identifier === "STA-1")?.labelIds).toEqual([PENDING]);
      expect(assembly.fake.world.issues.find((issue) => issue.identifier === "STA-2")?.labelIds).toEqual(["label-complete"]);
    } finally {
      await assembly.stop();
    }
  });

  test("reconcile turns an owner-approved Build handoff into Review pending", async () => {
    const checkpoint = "deadbeefcafe0002";
    const assembly = await assemble((world) => {
      addIssue(world, {
        identifier: "STA-1",
        stateId: "st-review",
        priority: 1,
        description: CRITERIA,
        labelIds: ["label-complete"],
        comments: [{
          id: "receipt-build",
          body: `Build handoff\n\n${receiptBlock("build", checkpoint, "submission-build")}\n`,
        }],
      });
    });
    try {
      assembly.git.ancestors.add(`${checkpoint} feature/sta-1`);
      const result = await post(assembly.handle.base, ["reconcile", "STA-1"]);
      expect(result).toMatchObject({ status: 200, ok: true });
      expect(result.text).toContain("approved: Build+Complete → Review+Pending");
      expect(assembly.fake.world.issues[0]?.labelIds).toEqual([PENDING]);
    } finally {
      await assembly.stop();
    }
  });

  test("a Linear failure belongs to the command and is not retried in the background", async () => {
    const assembly = await assemble();
    try {
      assembly.fake.world.failRateLimitFirst = 1;
      const failed = await post(assembly.handle.base, ["status"]);
      expect(failed.status).toBe(502);
      expect(failed.ok).toBe(false);
      expect(failed.text).toContain("HTTP 429");
      const afterFailure = assembly.fake.requests;
      await Bun.sleep(100);
      expect(assembly.fake.requests).toBe(afterFailure);
    } finally {
      await assembly.stop();
    }
  });
});
