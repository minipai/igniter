import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDispatchLog,
  hasAcceptanceCriteria,
  readQueue,
  sortCandidates,
  validateStartup,
  validateWithRetry,
  type ResolvedDispatch,
} from "./claims";
import { parseDispatchConfig } from "./config";
import { LinearClient, requireLinearApiKey, type LinearIssue } from "../service/linear/linear";
import { addIssue, standardProgressLabels, standardWorld, startFakeLinear, type FakeLinearHandle } from "../service/linear/fake-linear";
const BACKLOG = "st-backlog";
const TODO = "st-todo";
const BUILD = "st-build";
const ACCEPTANCE = "st-acceptance";
const DELIVER = "st-deliver";
const DONE = "st-done";
const PENDING = "label-pending";
const IN_PROGRESS = "label-in-progress";
const COMPLETE = "label-complete";
const BLOCKED = "label-blocked";
const CRITERIA = "## 驗收條件\n- [ ] works\n";

interface Setup {
  fake: FakeLinearHandle;
  client: LinearClient;
  resolved: ResolvedDispatch;
}

async function setup(maxRunning = 3): Promise<Setup> {
  const world = standardWorld("test-key");
  const fake = startFakeLinear(world);
  const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url, fetchImpl: fake.fetchImpl });
  const resolved = await validateStartup(
    client,
    parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: maxRunning }),
  );
  return { fake, client, resolved };
}

describe("validateStartup", () => {
  test("maps configured names to Linear state ids", async () => {
    const { fake, resolved } = await setup();
    try {
      expect(resolved.projectId).toBe("proj-1");
      expect(resolved.teamName).toBe("Starcoder");
      expect(resolved.stateIds).toMatchObject({ todo: TODO, build: BUILD, acceptance: ACCEPTANCE, deliver: DELIVER, done: DONE, backlog: BACKLOG, canceled: "st-canceled" });
      expect(resolved.progress.ids).toMatchObject({
        pending: PENDING,
        in_progress: IN_PROGRESS,
        complete: COMPLETE,
        blocked: BLOCKED,
      });
    } finally {
      fake.stop();
    }
  });

  test("unknown status name fails startup with the team in the message", async () => {
    const { fake, client } = await setup();
    try {
      fake.world.statesByTeam["team-1"] = fake.world.statesByTeam["team-1"]!.filter((s) => s.name !== "Todo");
      await expect(
        validateStartup(client, parseDispatchConfig({ project: "igniter", team: "Starcoder" })),
      ).rejects.toThrow('status "Todo" (the canonical todo status) does not exist on team "Starcoder"');
    } finally {
      fake.stop();
    }
  });

  test("a status on the wrong workflow type fails startup", async () => {
    const { fake, client } = await setup();
    try {
      const todo = fake.world.statesByTeam["team-1"]!.find((s) => s.name === "Todo")!;
      todo.type = "started";
      await expect(
        validateStartup(client, parseDispatchConfig({ project: "igniter", team: "Starcoder" })),
      ).rejects.toThrow('status "Todo" (the canonical todo status) must be a unstarted-type state');
    } finally {
      fake.stop();
    }
  });

  test("Canceled must map to a canceled-type Linear workflow state", async () => {
    const { fake, client } = await setup();
    try {
      fake.world.statesByTeam["team-1"]!.forEach((state) => {
        if (state.id === "st-canceled") state.type = "completed";
      });
      await expect(
        validateStartup(client, parseDispatchConfig({ project: "igniter", team: "Starcoder" })),
      ).rejects.toThrow('(states.canceled) must be a canceled-type state');
      fake.world.statesByTeam["team-1"]!.forEach((state) => {
        if (state.id === "st-canceled") state.type = "canceled";
      });
      expect((await validateStartup(client, parseDispatchConfig({ project: "igniter", team: "Starcoder" }))).stateIds.canceled).toBe("st-canceled");
    } finally {
      fake.stop();
    }
  });

  test("a missing Progress group or label fails startup", async () => {
    const { fake, client } = await setup();
    try {
      fake.world.labels = fake.world.labels.filter((l) => l.name !== "Progress");
      await expect(
        validateStartup(client, parseDispatchConfig({ project: "igniter", team: "Starcoder" })),
      ).rejects.toThrow('label group "Progress" (the canonical Progress group) was not found on team "Starcoder"');
      // A label outside the group fails too: restore the group, drop Complete.
      fake.world.labels = [
        ...standardProgressLabels().filter((l) => l.name !== "Complete"),
        { id: "label-stray", name: "Stray", teamId: "team-1", parentId: null },
      ];
      await expect(
        validateStartup(client, parseDispatchConfig({ project: "igniter", team: "Starcoder" })),
      ).rejects.toThrow('label "Complete" (the canonical complete label) is not in label group "Progress"');
    } finally {
      fake.stop();
    }
  });

  test("missing project fails startup", async () => {
    const { fake, client } = await setup();
    try {
      await expect(
        validateStartup(client, parseDispatchConfig({ project: "nope", team: "Starcoder" })),
      ).rejects.toThrow('project "nope" was not found');
    } finally {
      fake.stop();
    }
  });

  test("transient errors retry, config errors throw at once", async () => {
    const world = standardWorld("test-key");
    world.failFirst = 2;
    const fake = startFakeLinear(world);
    try {
      const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url, fetchImpl: fake.fetchImpl });
      const config = parseDispatchConfig({ project: "igniter", team: "Starcoder" });
      let retries = 0;
      const resolved = await validateWithRetry(() => validateStartup(client, config), {
        maxAttempts: 5,
        baseDelayMs: 1,
        onRetry: () => {
          retries += 1;
        },
      });
      expect(resolved.projectId).toBe("proj-1");
      expect(retries).toBe(2);
      await expect(
        validateWithRetry(() => validateStartup(client, parseDispatchConfig({ project: "nope" })), {
          maxAttempts: 3,
          baseDelayMs: 1,
        }),
      ).rejects.toThrow('project "nope" was not found');
    } finally {
      fake.stop();
    }
  });
});

describe("candidate helpers", () => {
  test("hasAcceptanceCriteria needs a checklist under the heading", () => {
    expect(hasAcceptanceCriteria(null)).toBe(false);
    expect(hasAcceptanceCriteria("plans")).toBe(false);
    expect(hasAcceptanceCriteria("## 驗收條件\nnothing")).toBe(false);
    expect(hasAcceptanceCriteria(CRITERIA)).toBe(true);
    expect(hasAcceptanceCriteria("## Acceptance criteria\n- [ ] x\n")).toBe(true);
  });

  test("sortCandidates prefers priority, then waiting time", () => {
    const issue = (identifier: string, priority: number, updatedAt: string): LinearIssue => ({
      id: identifier,
      identifier,
      title: identifier,
      description: null,
      priority,
      updatedAt,
      state: { id: TODO, name: "Todo" },
    });
    const sorted = sortCandidates([
      issue("STA-3", 0, "2026-09-04T00:00:01.000Z"),
      issue("STA-1", 2, "2026-09-04T00:00:03.000Z"),
      issue("STA-2", 1, "2026-09-04T00:00:02.000Z"),
    ]);
    expect(sorted.map((i) => i.identifier)).toEqual(["STA-2", "STA-1", "STA-3"]);
  });

});

describe("readQueue", () => {
  test("ranks available slots without normalizing Todo, claiming tickets, or writing comments", async () => {
    const { fake, client, resolved } = await setup(1);
    try {
      addIssue(fake.world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [BLOCKED] });
      addIssue(fake.world, { identifier: "STA-2", stateId: TODO, priority: 1, description: "plans only" });
      addIssue(fake.world, { identifier: "STA-3", stateId: TODO, priority: 2, description: CRITERIA, labelIds: [BLOCKED] });
      addIssue(fake.world, { identifier: "STA-4", stateId: TODO, priority: 3, description: CRITERIA });
      addIssue(fake.world, { identifier: "STA-5", stateId: TODO, priority: 4, description: CRITERIA, labelIds: [PENDING] });
      const before = structuredClone(fake.world.issues);
      expect(await readQueue(client, resolved)).toMatchObject([
        { identifier: "STA-2", reason: "skipped: no acceptance criteria" },
        { identifier: "STA-3", reason: "parked: blocked" },
        { identifier: "STA-4", reason: "next" },
        { identifier: "STA-5", reason: "waiting, slots full" },
      ]);
      expect(fake.world.issues).toEqual(before);
    } finally {
      fake.stop();
    }
  });
});

describe("dispatch log", () => {
  test("decisions print and append", async () => {
    const dir = mkdtempSync(join(tmpdir(), "igniter-log-"));
    const logPath = join(dir, "dispatch.log");
    const printed: string[] = [];
    const log = createDispatchLog(logPath, (line) => printed.push(line));
    await log.record("STA-1", "started: Todo → Build");
    await log.record("STA-2", "waiting: slots full (1 running)");
    expect(printed).toHaveLength(2);
    expect((await Bun.file(logPath).text()).trim().split("\n")).toHaveLength(2);
  });
});

test("requireLinearApiKey reads the environment only", () => {
  expect(() => requireLinearApiKey({})).toThrow("LINEAR_API_KEY is not set");
  expect(requireLinearApiKey({ LINEAR_API_KEY: "k" })).toBe("k");
});
