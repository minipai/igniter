import { describe, expect, test } from "bun:test";
import {
  markDoneAfterReceipt,
  planDone,
  ticketFromPullRequest,
  type DeliverySnapshot,
  type PullRequest,
} from "./linear-done.ts";

const pending = { id: "label-pending", name: "Pending", parent: { id: "group-progress", name: "Progress" } };
const complete = { id: "label-complete", name: "Complete", parent: { id: "group-progress", name: "Progress" } };
const feature = { id: "label-feature", name: "Feature", parent: null };

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    merged: true,
    base: { ref: "main", repo: { full_name: "minipai/igniter" } },
    head: { ref: "feature/sta-232", repo: { full_name: "minipai/igniter" } },
    ...overrides,
  };
}

function snapshot(stateName = "Deliver", labels = [complete, feature]): DeliverySnapshot {
  const done = { id: "state-done", name: "Done", type: "completed" };
  return {
    issue: {
      id: "issue-232",
      identifier: "STA-232",
      state: stateName === "Done" ? done : { id: "state-deliver", name: stateName, type: "started" },
      team: {
        id: "team-sta",
        key: "STA",
        states: { nodes: [done] },
        labels: { nodes: [pending, complete, feature] },
      },
      labels: { nodes: labels },
    },
  };
}

describe("GitHub delivery ticket", () => {
  test("accepts one merged same-repository feature branch", () => {
    expect(ticketFromPullRequest(pullRequest())).toBe("STA-232");
  });

  test("rejects unmerged, non-main, fork, and ambiguous branches", () => {
    expect(() => ticketFromPullRequest(pullRequest({ merged: false }))).toThrow("not merged");
    expect(() => ticketFromPullRequest(pullRequest({ base: { ref: "next", repo: { full_name: "minipai/igniter" } } })))
      .toThrow("not main");
    expect(() => ticketFromPullRequest(pullRequest({ head: { ref: "feature/sta-232", repo: { full_name: "fork/igniter" } } })))
      .toThrow("does not come from this repository");
    expect(() => ticketFromPullRequest(pullRequest({ head: { ref: "feature/sta-232-extra", repo: { full_name: "minipai/igniter" } } })))
      .toThrow("does not identify one STA ticket");
  });
});

describe("post-merge Linear handoff", () => {
  test("waits for the delivery receipt signal", () => {
    expect(planDone(snapshot("Deliver", [pending, feature]), "STA-232")).toEqual({ kind: "wait" });
  });

  test("moves only Deliver + Complete and retains labels for local reconciliation", () => {
    expect(planDone(snapshot(), "STA-232")).toEqual({
      kind: "move",
      issueId: "issue-232",
      stateId: "state-done",
    });
    expect(snapshot().issue?.labels.nodes).toEqual([complete, feature]);
  });

  test("accepts an idempotent Done readback with or without Complete", () => {
    expect(planDone(snapshot("Done"), "STA-232")).toEqual({ kind: "done" });
    expect(planDone(snapshot("Done", [feature]), "STA-232")).toEqual({ kind: "done" });
  });

  test("fails closed on the wrong ticket, team, state, or Progress labels", () => {
    expect(() => planDone(snapshot(), "STA-999")).toThrow("returned STA-232");
    const team = snapshot();
    team.issue!.team.key = "OTHER";
    expect(() => planDone(team, "STA-232")).toThrow("not STA");
    expect(() => planDone(snapshot("Review"), "STA-232")).toThrow("not Deliver or Done");
    expect(() => planDone(snapshot("Deliver", [pending, complete]), "STA-232")).toThrow("conflicting");
  });

  test("polls, moves, and verifies Done without real Linear access", async () => {
    const calls: string[] = [];
    const responses: unknown[] = [snapshot("Deliver", [pending]), snapshot(), { issueUpdate: { success: true } }, snapshot("Done")];
    await markDoneAfterReceipt(
      "STA-232",
      async <T>(query: string) => {
        calls.push(query.includes("mutation MarkDone") ? "move" : "read");
        return responses.shift() as T;
      },
      { attempts: 3, intervalMs: 0, sleep: async () => {} },
    );
    expect(calls).toEqual(["read", "read", "move", "read"]);
  });

  test("times out without mutating when the receipt signal never arrives", async () => {
    await expect(markDoneAfterReceipt(
      "STA-232",
      async <T>() => snapshot("Deliver", [pending]) as T,
      { attempts: 2, intervalMs: 0, sleep: async () => {} },
    )).rejects.toThrow("did not reach Deliver + Complete");
  });
});
