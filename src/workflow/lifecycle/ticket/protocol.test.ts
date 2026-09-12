// Stage-aware Linear delivery protocol against a fake Linear endpoint and
// fake Herdr: every legal transition, every refusal without writes,
// idempotent receipts, owner moves, and slot rules. No network, no real
// credentials, no real project, no daemon.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCommand,
  type CommandContext,
} from "../../run";
import { validateStartup, type ResolvedDispatch } from "../../config/claims";
import { parseDispatchConfig } from "../../config/config";
import { LinearClient } from "../../service/linear/linear";
import {
  normalizeBareTodo,
  parseAcceptanceCriteria,
  parseReceiptBlock,
  receiptBlock,
  submissionId,
  type FullIssue,
  type ParsedReceipt,
  type ReceiptKind,
} from "./protocol";
import { addIssue, standardWorld, startFakeLinear } from "../../service/linear/fake-linear";
import { FakeGit } from "../../testing/fake-git";
import { FakeWorkspaces } from "../../testing/fake-workspaces";
import { ticketWorktree } from "../../service/worktree/worktrees";

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
const CRITERIA = "## 驗收條件\n- [ ] works\n- [ ] shines\n";
const HEAD = "deadbeefcafe0001";

interface Harness {
  ctx: CommandContext;
  lines: string[];
  workspaces: FakeWorkspaces;
  git: FakeGit;
  client: LinearClient;
  resolved: ResolvedDispatch;
  world: ReturnType<typeof standardWorld>;
  stop: () => void;
}

async function harness(maxRunning = 3): Promise<Harness> {
  const world = standardWorld("test-key");
  const fake = startFakeLinear(world);
  const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url, fetchImpl: fake.fetchImpl });
  const resolved = await validateStartup(
    client,
    parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: maxRunning }),
  );
  const lines: string[] = [];
  const workspaces = new FakeWorkspaces();
  const git = new FakeGit();
  git.head = HEAD;
  const repoRoot = join(mkdtempSync(join(tmpdir(), "igniter-proto-root-")), "repo");
  const ctx: CommandContext = {
    client,
    resolved,
    decisions: {
      record: async (ticket, message) => {
        lines.push(`${ticket} ${message}`);
      },
    },
    workspaces,
    repoRoot,
    git,
  };
  return { ctx, lines, workspaces, git, client, resolved, world, stop: () => fake.stop() };
}

function issueOf(h: Harness, identifier: string) {
  const issue = h.world.issues.find((i) => i.identifier === identifier);
  if (!issue) throw new Error(`no such issue ${identifier}`);
  return issue;
}

function workspaceIdOf(h: Harness, identifier: string): string {
  const workspace = h.workspaces.workspaces.find((w) => w.label === identifier && !w.closed);
  if (!workspace) throw new Error(`no workspace for ${identifier}`);
  return workspace.workspaceId;
}

async function ticketCommand(
  h: Harness,
  identifier: string,
  action: "begin" | "submit" | "status" | "block" | "unblock",
  value?: string,
) {
  if (action === "begin") {
    const started = await runCommand({ command: "worker.start", ticket: identifier }, h.ctx);
    if (!started.ok) return started;
  }
  if (action === "submit") return runCommand({ command: "submit", ticket: identifier, payload: JSON.parse(value!) }, h.ctx);
  if (action === "status") return runCommand({ command: "status", ticket: identifier, json: true }, h.ctx);
  if (action === "block") return runCommand({ command: "block", ticket: identifier, reason: value! }, h.ctx);
  if (action === "unblock") return runCommand({ command: "unblock", ticket: identifier }, h.ctx);
  return runCommand({ command: "begin", ticket: identifier }, h.ctx);
}

/**
 * The newest comment carries one human report plus exactly one versioned
 * YAML receipt block — and no hidden HTML marker. Returns the submission
 * identity for retry assertions.
 */
function expectYamlReceipt(body: string, kind: ReceiptKind, checkpoint: string): string {
  expect(body).not.toContain("<!-- igniter:");
  expect(body.match(/```yaml/g)).toHaveLength(1);
  const parsed: ParsedReceipt | null = parseReceiptBlock(body);
  expect(parsed).toMatchObject({ kind, checkpoint });
  expect(parsed?.submission).toMatch(/^[0-9a-f]{16}$/);
  return (parsed as ParsedReceipt).submission;
}

/** Owner-move transitions verify the receipt checkpoint against this lineage; the landed check reads the same target. */
function seedLineage(h: Harness, identifier: string, checkpoint = HEAD): void {
  h.git.ancestors.add(`${checkpoint} feature/${identifier.toLowerCase()}`);
  h.git.ancestors.add(`${checkpoint} main`);
}

function buildPayload(head = HEAD) {
  return {
    v: 1,
    kind: "build",
    checkpoint: head,
    checks: ["bun run check"],
    results: [
      { criterion: "works", ok: true, note: "green" },
      { criterion: "shines", ok: true },
    ],
    reproduction: "run bun run check",
  };
}

function acceptancePayload(verdict: "pass" | "fail", head = HEAD) {
  return {
    v: 1,
    kind: "acceptance",
    verdict,
    checkpoint: head,
    results: [
      {
        criterion: "works",
        expected: "works",
        actual: verdict === "pass" ? "works" : "broken",
        evidence: "https://example.test/works",
        ok: verdict === "pass",
      },
      {
        criterion: "shines",
        expected: "shines",
        actual: "shines",
        evidence: "https://example.test/shines",
        ok: true,
      },
    ],
    environment: "test lab",
    reproduction: "open the page",
  };
}

function deliverPayload(head = HEAD, landed = head) {
  return {
    v: 1,
    kind: "deliver",
    checkpoint: head,
    landed,
    lineage: "abc123 deliver work",
    merge_ready: true,
    owner_actions: ["push the branch"],
  };
}

/** Start a worker, confirm delivery, and record Build with an explicit ticket. */
async function startBuild(h: Harness, identifier: string): Promise<string> {
  addIssue(h.world, { identifier, stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
  expect((await runCommand({ command: "worker.start", ticket: identifier }, h.ctx)).ok).toBe(true);
  const out = await runCommand({ command: "begin", ticket: identifier }, h.ctx);
  expect(out.ok).toBe(true);
  return workspaceIdOf(h, identifier);
}

/**
 * Drive a started ticket through the first Build plus the owner handoff:
 * the initial submit rests at Build+Complete, the owner moves it to
 * Acceptance, and an explicit reconcile converges it to Acceptance+Pending.
 */
async function toAcceptancePending(h: Harness, identifier: string): Promise<void> {
  expect((await ticketCommand(h, identifier, "submit", JSON.stringify(buildPayload()))).ok).toBe(true);
  expect(issueOf(h, identifier).stateId).toBe(BUILD);
  expect(issueOf(h, identifier).labelIds).toEqual([COMPLETE]);
  seedLineage(h, identifier);
  await h.client.setIssueState(issueOf(h, identifier).id, ACCEPTANCE);
  const reconciled = await runCommand({ command: "reconcile", ticket: identifier }, h.ctx);
  expect(reconciled.ok).toBe(true);
  expect(issueOf(h, identifier).stateId).toBe(ACCEPTANCE);
  expect(issueOf(h, identifier).labelIds).toEqual([PENDING]);
}

describe("acceptance criteria", () => {
  test("parses checklist items under the heading only", () => {
    expect(parseAcceptanceCriteria(null)).toEqual([]);
    expect(parseAcceptanceCriteria("nothing")).toEqual([]);
    expect(parseAcceptanceCriteria("## 驗收條件\nnothing")).toEqual([]);
    expect(parseAcceptanceCriteria(CRITERIA)).toEqual(["works", "shines"]);
    expect(parseAcceptanceCriteria("## Acceptance criteria\n- [ ] a\n## Notes\n- [ ] b\n")).toEqual(["a"]);
  });

  test("submission identity is stable and payload-sensitive", () => {
    const a = submissionId({ ticket: "STA-1", v: 1 });
    expect(submissionId({ v: 1, ticket: "STA-1" })).toBe(a);
    expect(submissionId({ ticket: "STA-1", v: 2 })).not.toBe(a);
  });
});

describe("startup validation", () => {
  test("maps the seven statuses and the Progress group", async () => {
    const h = await harness();
    try {
      expect(h.resolved.stateIds).toMatchObject({
        backlog: BACKLOG,
        todo: TODO,
        build: BUILD,
        acceptance: ACCEPTANCE,
        deliver: DELIVER,
        done: DONE,
        canceled: "st-canceled",
      });
      expect(h.resolved.progress).toMatchObject({
        groupId: "label-progress",
        ids: { pending: PENDING, in_progress: IN_PROGRESS, complete: COMPLETE, blocked: BLOCKED },
      });
    } finally {
      h.stop();
    }
  });

  test("a status on the wrong workflow type fails startup", async () => {
    const h = await harness();
    try {
      const todo = h.world.statesByTeam["team-1"]!.find((s) => s.name === "Todo")!;
      todo.type = "started";
      await expect(
        validateStartup(h.client, parseDispatchConfig({ project: "igniter", team: "Starcoder" })),
      ).rejects.toThrow('status "Todo" (the canonical todo status) must be a unstarted-type state');
    } finally {
      h.stop();
    }
  });

  test("a missing label group fails startup", async () => {
    const h = await harness();
    try {
      h.world.labels = h.world.labels.filter((l) => l.name !== "Progress");
      await expect(
        validateStartup(h.client, parseDispatchConfig({ project: "igniter", team: "Starcoder" })),
      ).rejects.toThrow('label group "Progress"');
    } finally {
      h.stop();
    }
  });

  test("a label outside the group fails startup", async () => {
    const h = await harness();
    try {
      const pending = h.world.labels.find((l) => l.name === "Pending")!;
      pending.parentId = null;
      await expect(
        validateStartup(h.client, parseDispatchConfig({ project: "igniter", team: "Starcoder" })),
      ).rejects.toThrow('label "Pending" (the canonical pending label) is not in label group "Progress"');
    } finally {
      h.stop();
    }
  });
});

describe("explicit worker start and begin", () => {
  test("worker start and begin move Todo+Pending into Build+In progress with a workspace", async () => {
    const h = await harness();
    try {
      const wsId = await startBuild(h, "STA-1");
      const issue = issueOf(h, "STA-1");
      expect(issue.stateId).toBe(BUILD);
      expect(issue.labelIds).toEqual([IN_PROGRESS]);
      const workspace = h.workspaces.workspaces.find((w) => w.workspaceId === wsId)!;
      // Linear is the authority; workspace metadata carries identity plus
      // the run's frozen profiles, never the protocol transition.
      expect(workspace.tokens).toMatchObject({ ticket: "STA-1" });
      expect(JSON.parse(workspace.tokens["profile_builder"]!)).toMatchObject({ harness: "codex", model: "gpt-5.6-terra" });
      expect(JSON.parse(workspace.tokens["profile_acceptance"]!)).toMatchObject({ harness: "codex", model: "gpt-5.6-sol" });
      expect(JSON.parse(workspace.tokens["profile_deliverer"]!)).toMatchObject({ harness: "codex", model: "gpt-5.6-luna" });
      expect(workspace.tokens).not.toHaveProperty("commander");
      expect(h.workspaces.agents.find((a) => a.name.startsWith("commander-"))).toBeUndefined();
      expect(h.workspaces.agents.find((a) => a.name === "builder-sta-1")).toBeDefined();
      // No secrets ride into the workspace.
      const created = h.workspaces.calls.find((c) => c.method === "workspace.create");
      expect(created?.params).toMatchObject({ label: "STA-1", env: {} });
      expect(JSON.stringify(created?.params)).not.toContain("test-key");
      expect(JSON.stringify(created?.params)).not.toContain("IGNITER_TICKET");
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 begin: todo+pending → build+in_progress"));
    } finally {
      h.stop();
    }
  });

  test("begin refuses without criteria or worker effects", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: "plans only", labelIds: [PENDING] });
      const out = await runCommand({ command: "begin", ticket: "STA-1" }, h.ctx);
      expect(out.ok).toBe(false);
      expect(issueOf(h, "STA-1").stateId).toBe(TODO);
      expect(issueOf(h, "STA-1").comments).toHaveLength(0);
      expect(h.workspaces.workspaces).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("begin refuses without Pending; an In progress ticket with no local worker is never adopted", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      addIssue(h.world, { identifier: "STA-2", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      expect((await runCommand({ command: "begin", ticket: "STA-1" }, h.ctx)).ok).toBe(false);
      // Linear says In progress, but this machine has no workspace or worker:
      // the ticket belongs to another machine, not to this session.
      const refused = await runCommand({ command: "worker.start", ticket: "STA-2" }, h.ctx);
      expect(refused.ok).toBe(false);
      expect(refused.text).toContain("In progress");
      expect(refused.text).toContain("does not adopt");
      expect(h.workspaces.workspaces).toHaveLength(0);
      expect(h.workspaces.agents).toHaveLength(0);
      expect(h.workspaces.calls).toHaveLength(0);
      expect(h.git.commands).toHaveLength(0);
      expect(issueOf(h, "STA-1").stateId).toBe(TODO);
      expect(issueOf(h, "STA-2").stateId).toBe(BUILD);
      expect(issueOf(h, "STA-2").labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("begin refuses at the cap and blocked tickets free slots", async () => {
    const h = await harness(1);
    try {
      await startBuild(h, "STA-1");
      addIssue(h.world, { identifier: "STA-2", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING] });
      const full = await runCommand({ command: "begin", ticket: "STA-2" }, h.ctx);
      expect(full.ok).toBe(false);
      expect(full.text).toContain("max_running");
      // Blocking the holder frees its slot for the waiter.
      expect((await ticketCommand(h, "STA-1", "block", "waiting on vendor")).ok).toBe(true);
      expect(issueOf(h, "STA-1").labelIds).toEqual([BLOCKED]);
      expect((await runCommand({ command: "worker.start", ticket: "STA-2" }, h.ctx)).ok).toBe(true);
      expect((await runCommand({ command: "begin", ticket: "STA-2" }, h.ctx)).ok).toBe(true);
      expect(issueOf(h, "STA-2").stateId).toBe(BUILD);
    } finally {
      h.stop();
    }
  });

  test("explicit begin normalizes a bare Todo and records Build after worker delivery", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-9", stateId: TODO, priority: 1, description: CRITERIA });
      expect((await runCommand({ command: "worker.start", ticket: "STA-9" }, h.ctx)).ok).toBe(true);
      expect(issueOf(h, "STA-9").labelIds).toEqual([]);
      expect((await runCommand({ command: "begin", ticket: "STA-9" }, h.ctx)).ok).toBe(true);
      expect(issueOf(h, "STA-9").labelIds).toEqual([IN_PROGRESS]);
      expect(issueOf(h, "STA-9").stateId).toBe(BUILD);
    } finally {
      h.stop();
    }
  });
});

describe("status <ticket> --json", () => {
  test("returns ticket, criteria, status, progress, next, and submit schema", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      const out = await runCommand({ command: "status", ticket: "STA-1", json: true }, h.ctx);
      expect(out.ok).toBe(true);
      const data = out.data as Record<string, unknown>;
      expect(data).toMatchObject({
        status: "build",
        progress: "in_progress",
        checkpoint: null,
        next: ["submit", "block"],
      });
      expect((data["ticket"] as Record<string, unknown>)["criteria"]).toEqual(["works", "shines"]);
      expect((data["submit_schema"] as Record<string, unknown>)["kind"]).toBe("build");
    } finally {
      h.stop();
    }
  });

  test("a Linear receipt cannot inherit a stale landed commit from workspace metadata", async () => {
    const h = await harness();
    try {
      const wsId = await startBuild(h, "STA-1");
      issueOf(h, "STA-1").comments.push({
        id: "comment-pass",
        body: `Agent acceptance: PASS\n\n${receiptBlock("acceptance-pass", HEAD, "abc123abc123abc1")}\n`,
        createdAt: "2026-09-04T00:00:00.000001Z",
      });
      await h.workspaces.reportMetadata(wsId, {
        checkpoint: "cached-checkpoint",
        landed: "stale-landed",
        receipt_id: "cached-receipt",
        receipt_kind: "deliver",
        submission: "cached-submission",
      });

      const out = await runCommand({ command: "status", ticket: "STA-1", json: true }, h.ctx);
      expect(out.ok).toBe(true);
      expect(out.data).toMatchObject({
        checkpoint: HEAD,
        landed: null,
        receipt: {
          kind: "acceptance-pass",
          id: "comment-pass",
          checkpoint: HEAD,
          landed: null,
          submission: "abc123abc123abc1",
        },
      });
    } finally {
      h.stop();
    }
  });

  test("multiple Progress labels refuse every ticket command without writes", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      const issue = issueOf(h, "STA-1");
      issue.labelIds = [PENDING, IN_PROGRESS];
      const before = JSON.stringify({ labels: issue.labelIds, comments: issue.comments.length, state: issue.stateId });
      const metaBefore = JSON.stringify(h.workspaces.tokensFor("STA-1"));
      for (const command of [
        { command: "status", ticket: "STA-1", json: true },
        { command: "begin", ticket: "STA-1" },
        { command: "submit", ticket: "STA-1", payload: buildPayload() },
        { command: "block", ticket: "STA-1", reason: "x" },
        { command: "unblock", ticket: "STA-1" },
      ] as const) {
        const out = await runCommand(command, h.ctx);
        expect(out.ok).toBe(false);
        expect(out.text).toContain("2 Progress labels");
      }
      expect(JSON.stringify({ labels: issue.labelIds, comments: issue.comments.length, state: issue.stateId })).toBe(before);
      expect(JSON.stringify(h.workspaces.tokensFor("STA-1"))).toBe(metaBefore);
    } finally {
      h.stop();
    }
  });
});

describe("begin", () => {
  test("normalizeBareTodo adds Pending to a bare Todo and keeps non-Progress labels", async () => {
    const h = await harness();
    try {
      h.world.labels.push({ id: "label-blue", name: "blue", teamId: "team-1", parentId: null });
      addIssue(h.world, {
        identifier: "STA-1",
        stateId: TODO,
        priority: 1,
        description: CRITERIA,
        labelIds: ["label-blue"],
      });
      const full = (await h.client.fetchIssue("STA-1")) as FullIssue;
      const deps = {
        client: h.client,
        resolved: h.resolved,
        workspaces: h.workspaces,
        decisions: h.ctx.decisions,
        git: h.git,
        repoRoot: h.ctx.repoRoot,
      };
      const normalized = await normalizeBareTodo(deps, full);
      expect(normalized.state.name).toBe("Todo");
      expect((normalized.labels ?? []).map((l) => l.name)).toEqual(["blue", "Pending"]);
    } finally {
      h.stop();
    }
  });

  test("normalizeBareTodo refuses unknown or conflicting Progress combinations", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: TODO, priority: 1, description: CRITERIA, labelIds: [PENDING, BLOCKED] });
      const deps = {
        client: h.client,
        resolved: h.resolved,
        workspaces: h.workspaces,
        decisions: h.ctx.decisions,
        git: h.git,
        repoRoot: h.ctx.repoRoot,
      };
      const conflicted = (await h.client.fetchIssue("STA-1")) as FullIssue;
      await expect(normalizeBareTodo(deps, conflicted)).rejects.toThrow("bare Todo");
      addIssue(h.world, { identifier: "STA-2", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: [] });
      const active = (await h.client.fetchIssue("STA-2")) as FullIssue;
      await expect(normalizeBareTodo(deps, active)).rejects.toThrow("bare Todo");
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING, BLOCKED]);
      expect(issueOf(h, "STA-2").labelIds).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("moves Pending to In progress with the status unchanged", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      // Repeated begin acknowledges the same stage without restarting it.
      expect((await ticketCommand(h, "STA-1", "begin")).ok).toBe(true);
      // Drive through the first Build plus the owner handoff, then begin.
      await toAcceptancePending(h, "STA-1");
      expect(issueOf(h, "STA-1").stateId).toBe(ACCEPTANCE);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect((await ticketCommand(h, "STA-1", "begin")).ok).toBe(true);
      expect(issueOf(h, "STA-1").stateId).toBe(ACCEPTANCE);
      expect(issueOf(h, "STA-1").labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("an In-progress Deliver retry keeps the approved checkpoint after the worktree was rebased", async () => {
    const h = await harness();
    try {
      addIssue(h.world, {
        identifier: "STA-1",
        stateId: DELIVER,
        priority: 1,
        description: CRITERIA,
        labelIds: [IN_PROGRESS],
      });
      issueOf(h, "STA-1").comments.push({
        id: "comment-pass",
        body: `Agent acceptance: PASS\n\n${receiptBlock("acceptance-pass", HEAD, "abc123abc123abc1")}\n`,
        createdAt: "2026-09-04T00:00:00.000001Z",
      });
      h.workspaces.seedWorkspace("STA-1", { ticket: "STA-1" });
      // A same-machine retry reuses the live worker instead of adopting a
      // ticket from Linear state alone.
      h.workspaces.seedAgent("STA-1", "deliverer-sta-1", "deliver");
      const rebased = "bbbbbbbbbbbbbbbb";
      h.git.head = rebased;

      const retried = await runCommand({ command: "worker.start", ticket: "STA-1" }, h.ctx);
      expect(retried.ok).toBe(true);
      expect(retried.text).toContain("confirmed");
      const order = h.workspaces.promptsFor("deliverer-sta-1").at(-1)!;
      expect(order).toContain(`Checkpoint to work from: \`${HEAD}\``);
      expect(order).not.toContain(`Checkpoint to work from: \`${rebased}\``);
      expect(issueOf(h, "STA-1").stateId).toBe(DELIVER);
      expect(issueOf(h, "STA-1").labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });
});

describe("submit", () => {
  test("initial build submit publishes a receipt and waits at Build+Complete", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      const out = await ticketCommand(h, "STA-1", "submit", JSON.stringify(buildPayload()));
      expect(out.ok).toBe(true);
      expect(out.text).toContain("→ Build+Complete");
      const issue = issueOf(h, "STA-1");
      expect(issue.stateId).toBe(BUILD);
      expect(issue.labelIds).toEqual([COMPLETE]);
      const receipt = issue.comments.at(-1)!;
      expectYamlReceipt(receipt.body, "build", HEAD);
      expect(receipt.body).toContain("# Build receipt");
      expect(h.workspaces.tokensFor("STA-1")).not.toHaveProperty("receipt_kind");
      // status <ticket> --json waits on the owner: no workspace command applies.
      const state = (await ticketCommand(h, "STA-1", "status")).data as Record<string, unknown>;
      expect(state).toMatchObject({ status: "build", progress: "complete", next: ["approve"] });
      expect(state["note"]).toContain("approve <ticket> <receipt.id>");
      expect((state["submit_schema"] as Record<string, unknown>)["kind"]).toBe("build");
      // No Acceptance worker can start while the owner has not moved it.
      expect((await ticketCommand(h, "STA-1", "begin")).ok).toBe(false);
    } finally {
      h.stop();
    }
  });

  test("owner handoff converges Build+Complete to Acceptance+Pending on explicit reconcile", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      await ticketCommand(h, "STA-1", "submit", JSON.stringify(buildPayload()));
      seedLineage(h, "STA-1");
      // The owner moves the first Build to Acceptance in Linear (Complete kept).
      await h.client.setIssueState(issueOf(h, "STA-1").id, ACCEPTANCE);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      const reconciled = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(reconciled.ok).toBe(true);
      expect(reconciled.text).toContain("Build+Complete → Acceptance+Pending");
      expect(issueOf(h, "STA-1").stateId).toBe(ACCEPTANCE);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      // status <ticket> --json now offers the acceptance schema and begin.
      const state = (await ticketCommand(h, "STA-1", "status")).data as Record<string, unknown>;
      expect(state).toMatchObject({ status: "acceptance", progress: "pending", next: ["worker start", "begin", "block"] });
      expect((state["submit_schema"] as Record<string, unknown>)["kind"]).toBe("acceptance");
      expect((await ticketCommand(h, "STA-1", "begin")).ok).toBe(true);
    } finally {
      h.stop();
    }
  });

  test("build submit is idempotent: same payload reuses the receipt", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      const payload = JSON.stringify(buildPayload());
      expect((await ticketCommand(h, "STA-1", "submit", payload)).ok).toBe(true);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      const count = issueOf(h, "STA-1").comments.length;
      // Back in Build+In progress with the same checkpoint: resubmit converges.
      issueOf(h, "STA-1").stateId = BUILD;
      issueOf(h, "STA-1").labelIds = [IN_PROGRESS];
      const repeated = await ticketCommand(h, "STA-1", "submit", payload);
      expect(repeated.ok).toBe(true);
      expect(issueOf(h, "STA-1").comments.length).toBe(count);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
    } finally {
      h.stop();
    }
  });

  test("build submit refuses a stale checkpoint, partial coverage, and wrong kinds", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      const before = JSON.stringify(issueOf(h, "STA-1"));
      const stale = { ...buildPayload(), checkpoint: "other" };
      expect((await ticketCommand(h, "STA-1", "submit", JSON.stringify(stale))).text).toContain("worktree HEAD");
      const partial = { ...buildPayload(), results: [{ criterion: "works", ok: true }] };
      expect((await ticketCommand(h, "STA-1", "submit", JSON.stringify(partial))).text).toContain("misses 1 acceptance criterion");
      const wrong = { ...acceptancePayload("pass") };
      expect((await ticketCommand(h, "STA-1", "submit", JSON.stringify(wrong))).text).toContain("build submit needs");
      expect(JSON.stringify(issueOf(h, "STA-1"))).toBe(before);
      expect(issueOf(h, "STA-1").stateId).toBe(BUILD);
    } finally {
      h.stop();
    }
  });

  test("acceptance PASS needs full evidence and lands in Acceptance+Complete", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      await toAcceptancePending(h, "STA-1");
      await ticketCommand(h, "STA-1", "begin");
      const out = await ticketCommand(h, "STA-1", "submit", JSON.stringify(acceptancePayload("pass")));
      expect(out.ok).toBe(true);
      const issue = issueOf(h, "STA-1");
      expect(issue.stateId).toBe(ACCEPTANCE);
      expect(issue.labelIds).toEqual([COMPLETE]);
      const receipt = issue.comments.at(-1)!;
      expect(receipt.body).toContain("Agent acceptance: PASS");
      expectYamlReceipt(receipt.body, "acceptance-pass", HEAD);
      expect(issue.attachments.map((a) => a.url).sort()).toEqual(
        ["https://example.test/shines", "https://example.test/works"],
      );
      expect(h.workspaces.tokensFor("STA-1")).not.toHaveProperty("receipt_kind");
      const state = (await ticketCommand(h, "STA-1", "status")).data as Record<string, unknown>;
      expect(state).toMatchObject({ status: "acceptance", progress: "complete", next: ["approve"] });
      expect(state["note"]).toContain("approve <ticket> <receipt.id>");
    } finally {
      h.stop();
    }
  });

  test("acceptance PASS refuses without evidence and writes nothing", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      await toAcceptancePending(h, "STA-1");
      await ticketCommand(h, "STA-1", "begin");
      const payload = acceptancePayload("pass");
      payload.results[0]!.evidence = "";
      const before = JSON.stringify({ issue: issueOf(h, "STA-1"), meta: h.workspaces.tokensFor("STA-1") });
      const out = await ticketCommand(h, "STA-1", "submit", JSON.stringify(payload));
      expect(out.ok).toBe(false);
      expect(out.text).toContain("evidence");
      expect(JSON.stringify({ issue: issueOf(h, "STA-1"), meta: h.workspaces.tokensFor("STA-1") })).toBe(before);
      expect(issueOf(h, "STA-1").labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("acceptance submit refuses non-URL evidence before any Linear write", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      await toAcceptancePending(h, "STA-1");
      await ticketCommand(h, "STA-1", "begin");
      const payload = acceptancePayload("pass");
      payload.results[0]!.evidence = "Command output: everything passed";
      const before = JSON.stringify({ issue: issueOf(h, "STA-1"), meta: h.workspaces.tokensFor("STA-1") });
      const out = await ticketCommand(h, "STA-1", "submit", JSON.stringify(payload));
      expect(out.ok).toBe(false);
      expect(out.text).toContain("absolute http or https URL");
      expect(JSON.stringify({ issue: issueOf(h, "STA-1"), meta: h.workspaces.tokensFor("STA-1") })).toBe(before);
    } finally {
      h.stop();
    }
  });

  test("acceptance FAIL returns to Build+Pending", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      await toAcceptancePending(h, "STA-1");
      await ticketCommand(h, "STA-1", "begin");
      const out = await ticketCommand(h, "STA-1", "submit", JSON.stringify(acceptancePayload("fail")));
      expect(out.ok).toBe(true);
      expect(issueOf(h, "STA-1").stateId).toBe(BUILD);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(issueOf(h, "STA-1").comments.at(-1)!.body).toContain("Agent acceptance: FAIL");
      expect(h.workspaces.tokensFor("STA-1")).not.toHaveProperty("status");
      expect(h.workspaces.tokensFor("STA-1")).not.toHaveProperty("receipt_id");
    } finally {
      h.stop();
    }
  });

  test("acceptance submit refuses a checkpoint newer than the build receipt", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      await toAcceptancePending(h, "STA-1");
      await ticketCommand(h, "STA-1", "begin");
      h.git.head = "newcommit0000002";
      const out = await ticketCommand(h, "STA-1", "submit", JSON.stringify(acceptancePayload("pass", "newcommit0000002")));
      expect(out.ok).toBe(false);
      expect(out.text).toContain("new checkpoint needs a new build submit");
      expect(issueOf(h, "STA-1").labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("deliver submit lands in Deliver+Complete", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      issueOf(h, "STA-1").stateId = DELIVER;
      issueOf(h, "STA-1").labelIds = [IN_PROGRESS];
      // The approval receipt lives in Linear, not in workspace metadata.
      issueOf(h, "STA-1").comments.push({
        id: "comment-pass",
        body: `Agent acceptance: PASS\n\n${receiptBlock("acceptance-pass", HEAD, "abc123abc123abc1")}\n`,
        createdAt: "2026-09-04T00:00:00.000001Z",
      });
      seedLineage(h, "STA-1");
      const out = await ticketCommand(h, "STA-1", "submit", JSON.stringify(deliverPayload()));
      expect(out.ok).toBe(true);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      expectYamlReceipt(issueOf(h, "STA-1").comments.at(-1)!.body, "deliver", HEAD);
      expect(parseReceiptBlock(issueOf(h, "STA-1").comments.at(-1)!.body)).toMatchObject({ landed: HEAD });
      expect(h.workspaces.tokensFor("STA-1")).not.toHaveProperty("receipt_kind");
    } finally {
      h.stop();
    }
  });

  test("deliver submit finishes a ticket Linear's GitHub integration already moved to Done", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      issueOf(h, "STA-1").stateId = DONE;
      issueOf(h, "STA-1").labelIds = [IN_PROGRESS];
      issueOf(h, "STA-1").comments.push({
        id: "comment-pass",
        body: `Agent acceptance: PASS\n\n${receiptBlock("acceptance-pass", HEAD, "abc123abc123abc1")}\n`,
        createdAt: "2026-09-04T00:00:00.000001Z",
      });
      seedLineage(h, "STA-1");

      const status = await runCommand({ command: "status", ticket: "STA-1", json: true }, h.ctx);
      expect(status.ok).toBe(true);
      expect(status.data).toMatchObject({ status: "deliver", progress: "in_progress", next: ["submit", "block"] });

      const out = await ticketCommand(h, "STA-1", "submit", JSON.stringify(deliverPayload()));
      expect(out.ok).toBe(true);
      expect(out.text).toContain("→ Done");
      expect(issueOf(h, "STA-1").stateId).toBe(DONE);
      expect(issueOf(h, "STA-1").labelIds).toEqual([]);
      expectYamlReceipt(issueOf(h, "STA-1").comments.at(-1)!.body, "deliver", HEAD);
      expect(h.workspaces.workspaces.find((workspace) => workspace.label === "STA-1")?.closed).toBe(false);
    } finally {
      h.stop();
    }
  });

  test("Done with Progress still refuses without a acceptance-pass delivery handoff", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      issueOf(h, "STA-1").stateId = DONE;
      issueOf(h, "STA-1").labelIds = [IN_PROGRESS];
      const status = await runCommand({ command: "status", ticket: "STA-1", json: true }, h.ctx);
      expect(status.ok).toBe(false);
      expect(status.text).toContain("Done but still carries Progress");
      expect(issueOf(h, "STA-1").comments.filter(comment => parseReceiptBlock(comment.body))).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("deliver submit accepts a rebased HEAD when the approval still binds", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      issueOf(h, "STA-1").stateId = DELIVER;
      issueOf(h, "STA-1").labelIds = [IN_PROGRESS];
      issueOf(h, "STA-1").comments.push({
        id: "comment-pass",
        body: `Agent acceptance: PASS\n\n${receiptBlock("acceptance-pass", HEAD, "abc123abc123abc1")}\n`,
        createdAt: "2026-09-04T00:00:00.000001Z",
      });
      // Deliver rebased the branch: HEAD moved on, the approval still binds
      // the old checkpoint, and the new tip already landed on main.
      const rebased = "bbbbbbbbbbbbbbbb";
      h.git.head = rebased;
      h.git.ancestors.add(`${rebased} main`);
      const out = await ticketCommand(h, "STA-1", "submit", JSON.stringify(deliverPayload(HEAD, rebased)));
      expect(out.ok).toBe(true);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      expect(parseReceiptBlock(issueOf(h, "STA-1").comments.at(-1)!.body)).toMatchObject({
        kind: "deliver",
        checkpoint: HEAD,
        landed: rebased,
      });
    } finally {
      h.stop();
    }
  });

  test("deliver submit refuses a missing, unknown, or unlanded commit", async () => {
    for (const landed of ["", "main", "f".repeat(40), "e".repeat(40)]) {
      const h = await harness();
      try {
        await startBuild(h, "STA-1");
        issueOf(h, "STA-1").stateId = DELIVER;
        issueOf(h, "STA-1").labelIds = [IN_PROGRESS];
        issueOf(h, "STA-1").comments.push({
          id: "comment-pass",
          body: `Agent acceptance: PASS\n\n${receiptBlock("acceptance-pass", HEAD, "abc123abc123abc1")}\n`,
          createdAt: "2026-09-04T00:00:00.000001Z",
        });
        seedLineage(h, "STA-1");
        const before = JSON.stringify(issueOf(h, "STA-1"));
        const raw = deliverPayload() as Record<string, unknown>;
        const out = await ticketCommand(h, "STA-1", "submit", JSON.stringify({ ...raw, landed }));
        expect(out.ok).toBe(false);
        expect(out.text).toMatch(
          landed === ""
            ? /needs a "landed" commit/
            : landed === "main"
              ? /is not a Git hash/
              : /is not on local main/,
        );
        expect(JSON.stringify(issueOf(h, "STA-1"))).toBe(before);
      } finally {
        h.stop();
      }
    }
  });

  test("deliver submit refuses a checkpoint the approval does not bind", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      issueOf(h, "STA-1").stateId = DELIVER;
      issueOf(h, "STA-1").labelIds = [IN_PROGRESS];
      issueOf(h, "STA-1").comments.push({
        id: "comment-pass",
        body: `Agent acceptance: PASS\n\n${receiptBlock("acceptance-pass", HEAD, "abc123abc123abc1")}\n`,
        createdAt: "2026-09-04T00:00:00.000001Z",
      });
      seedLineage(h, "STA-1");
      const other = "other000000000005";
      h.git.ancestors.add(`${other} main`);
      const out = await ticketCommand(h, "STA-1", "submit", JSON.stringify(deliverPayload(other, other)));
      expect(out.ok).toBe(false);
      expect(out.text).toContain("approval binds");
      expect(issueOf(h, "STA-1").labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("deliver submit without a acceptance-pass receipt is refused", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      issueOf(h, "STA-1").stateId = DELIVER;
      issueOf(h, "STA-1").labelIds = [IN_PROGRESS];
      const before = JSON.stringify(issueOf(h, "STA-1"));
      const out = await ticketCommand(h, "STA-1", "submit", JSON.stringify(deliverPayload()));
      expect(out.ok).toBe(false);
      expect(out.text).toContain("no acceptance-pass receipt");
      expect(JSON.stringify(issueOf(h, "STA-1"))).toBe(before);
    } finally {
      h.stop();
    }
  });

  test("non-progress labels survive every transition", async () => {
    const h = await harness();
    try {
      h.world.labels.push({ id: "label-keep", name: "keep", teamId: "team-1", parentId: null });
      await startBuild(h, "STA-1");
      issueOf(h, "STA-1").labelIds.push("label-keep");
      await ticketCommand(h, "STA-1", "submit", JSON.stringify(buildPayload()));
      expect(new Set(issueOf(h, "STA-1").labelIds)).toEqual(new Set([COMPLETE, "label-keep"]));
      seedLineage(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, ACCEPTANCE);
      expect((await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
      expect(new Set(issueOf(h, "STA-1").labelIds)).toEqual(new Set([PENDING, "label-keep"]));
      await ticketCommand(h, "STA-1", "begin");
      await ticketCommand(h, "STA-1", "submit", JSON.stringify(acceptancePayload("pass")));
      expect(new Set(issueOf(h, "STA-1").labelIds)).toEqual(new Set([COMPLETE, "label-keep"]));
    } finally {
      h.stop();
    }
  });
});

describe("block and unblock", () => {
  test("block keeps the status with a reason; unblock returns to Pending", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      expect((await ticketCommand(h, "STA-1", "block", "waiting on vendor")).ok).toBe(true);
      expect(issueOf(h, "STA-1").stateId).toBe(BUILD);
      expect(issueOf(h, "STA-1").labelIds).toEqual([BLOCKED]);
      expect(issueOf(h, "STA-1").comments.at(-1)!.body).toContain("waiting on vendor");
      expect(h.workspaces.tokensFor("STA-1")).not.toHaveProperty("progress");
      expect(h.workspaces.tokensFor("STA-1")).not.toHaveProperty("block_reason");
      // Blocked is not a submit state.
      expect((await ticketCommand(h, "STA-1", "submit", JSON.stringify(buildPayload()))).ok).toBe(false);
      expect((await ticketCommand(h, "STA-1", "unblock")).ok).toBe(true);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(h.workspaces.tokensFor("STA-1")).not.toHaveProperty("block_reason");
      // Unblock never jumps straight to In progress.
      expect((await ticketCommand(h, "STA-1", "begin")).ok).toBe(true);
    } finally {
      h.stop();
    }
  });

  test("block refuses outside Pending/In progress and unblock outside Blocked", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      expect((await ticketCommand(h, "STA-1", "unblock")).ok).toBe(false);
      await toAcceptancePending(h, "STA-1");
      await ticketCommand(h, "STA-1", "begin");
      await ticketCommand(h, "STA-1", "submit", JSON.stringify(acceptancePayload("pass")));
      expect((await ticketCommand(h, "STA-1", "block", "x")).ok).toBe(false);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
    } finally {
      h.stop();
    }
  });
});

describe("owner moves", () => {
  async function toAcceptanceComplete(h: Harness, identifier: string): Promise<void> {
    await startBuild(h, identifier);
    await toAcceptancePending(h, identifier);
    await ticketCommand(h, identifier, "begin");
    const out = await ticketCommand(h, identifier, "submit", JSON.stringify(acceptancePayload("pass")));
    expect(out.ok).toBe(true);
    seedLineage(h, identifier);
  }

  test("approval normalizes Acceptance+Complete to Deliver+Pending", async () => {
    const h = await harness();
    try {
      await toAcceptanceComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]); // inherited Complete
      const reconciled = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(issueOf(h, "STA-1").stateId).toBe(DELIVER);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(h.workspaces.tokensFor("STA-1")).not.toHaveProperty("status");
      expect(reconciled.text).toContain("approved: Acceptance+Complete → Deliver+Pending");
    } finally {
      h.stop();
    }
  });

  test("send-back normalizes Acceptance+Complete to Build+Pending", async () => {
    const h = await harness();
    try {
      await toAcceptanceComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, BUILD);
      const reconciled = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(issueOf(h, "STA-1").labelIds).toEqual([PENDING]);
      expect(reconciled.text).toContain("sent back: Acceptance+Complete → Build+Pending");
    } finally {
      h.stop();
    }
  });

  test("approval without a binding PASS receipt is refused, never normalized", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      // Owner hand-moves Build straight to Deliver with a stray Complete label.
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      await h.client.setIssueLabels(issueOf(h, "STA-1").id, [COMPLETE]);
      h.workspaces.reportMetadata(workspaceIdOf(h, "STA-1"), { status: "acceptance", progress: "complete" });
      const reconciled = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      // Left alone: the inherited Complete is not a Deliver completion.
      expect(issueOf(h, "STA-1").stateId).toBe(DELIVER);
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      expect(reconciled.text).toContain("refusing");
    } finally {
      h.stop();
    }
  });

  test("completion clears Progress and closes the workspace", async () => {
    const h = await harness();
    try {
      await toAcceptanceComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      expect((await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
      await ticketCommand(h, "STA-1", "begin");
      await ticketCommand(h, "STA-1", "submit", JSON.stringify(deliverPayload()));
      expect(issueOf(h, "STA-1").labelIds).toEqual([COMPLETE]);
      await h.client.setIssueState(issueOf(h, "STA-1").id, DONE);
      const reconciled = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(reconciled.ok).toBe(true);
      expect(h.workspaces.workspaces.find((w) => w.label === "STA-1")!.closed).toBe(false);
      const stopped = await runCommand({ command: "worker.stop", ticket: "STA-1" }, h.ctx);
      expect(stopped.ok).toBe(true);
      expect(issueOf(h, "STA-1").labelIds).toEqual([]);
      expect(h.workspaces.workspaces.find((w) => w.label === "STA-1")!.closed).toBe(true);
      expect(reconciled.text).toContain("done: Deliver+Complete → Done");
    } finally {
      h.stop();
    }
  });

  test("completion removes the ticket worktree and branch after landing", async () => {
    const h = await harness();
    try {
      await toAcceptanceComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      expect((await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
      await ticketCommand(h, "STA-1", "begin");
      await ticketCommand(h, "STA-1", "submit", JSON.stringify(deliverPayload()));
      // The checkout worker start opened: listed on the ticket branch, clean,
      // checkpoint landed on the target branch.
      const derived = ticketWorktree(h.ctx.repoRoot, "STA-1");
      h.git.worktreeList =
        `worktree ${derived.path}\nHEAD ${HEAD}\nbranch refs/heads/${derived.branch}\n`;
      h.git.branches = [derived.branch];
      h.git.ancestors = new Set([`${HEAD} main`, `${derived.branch} main`]);
      await h.client.setIssueState(issueOf(h, "STA-1").id, DONE);
      const reconciled = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(reconciled.ok).toBe(true);
      expect(h.workspaces.workspaces.find((w) => w.label === "STA-1")!.closed).toBe(false);
      const stopped = await runCommand({ command: "worker.stop", ticket: "STA-1" }, h.ctx);
      expect(stopped.ok).toBe(true);
      expect(issueOf(h, "STA-1").labelIds).toEqual([]);
      expect(h.workspaces.workspaces.find((w) => w.label === "STA-1")!.closed).toBe(true);
      expect(reconciled.text).toContain("done: Deliver+Complete → Done");
      expect(stopped.text).toContain("removed worktree and merged branch");
      expect(h.git.worktreeList).not.toContain(derived.path);
      expect(h.git.branches).not.toContain(derived.branch);
      for (const cmd of h.git.commands) {
        expect(cmd.args).not.toContain("--force");
        expect(cmd.args).not.toContain("-D");
      }
    } finally {
      h.stop();
    }
  });

  test("completion keeps a dirty worktree but still lands Done", async () => {
    const h = await harness();
    try {
      await toAcceptanceComplete(h, "STA-1");
      await h.client.setIssueState(issueOf(h, "STA-1").id, DELIVER);
      expect((await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
      await ticketCommand(h, "STA-1", "begin");
      await ticketCommand(h, "STA-1", "submit", JSON.stringify(deliverPayload()));
      const derived = ticketWorktree(h.ctx.repoRoot, "STA-1");
      h.git.worktreeList =
        `worktree ${derived.path}\nHEAD ${HEAD}\nbranch refs/heads/${derived.branch}\n`;
      h.git.branches = [derived.branch];
      h.git.ancestors = new Set([`${HEAD} main`, `${derived.branch} main`]);
      h.git.statusPorcelain = " M feature.txt\n";
      await h.client.setIssueState(issueOf(h, "STA-1").id, DONE);
      const reconciled = await runCommand({ command: "reconcile", ticket: "STA-1" }, h.ctx);
      expect(reconciled.ok).toBe(true);
      expect(h.workspaces.workspaces.find((w) => w.label === "STA-1")!.closed).toBe(false);
      const stopped = await runCommand({ command: "worker.stop", ticket: "STA-1" }, h.ctx);
      expect(stopped.ok).toBe(false);
      expect(issueOf(h, "STA-1").labelIds).toEqual([]);
      expect(h.workspaces.workspaces.find((w) => w.label === "STA-1")!.closed).toBe(false);
      expect(reconciled.text).toContain("done: Deliver+Complete → Done");
      expect(stopped.text).toContain("uncommitted changes");
      expect(h.git.worktreeList).toContain(derived.path);
      expect(h.git.branches).toContain(derived.branch);
    } finally {
      h.stop();
    }
  });
});

describe("dispatch commands", () => {
  test("fail returns the ticket to Backlog with Progress cleared", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      const out = await runCommand({ command: "fail", ticket: "STA-1", reason: "wedged" }, h.ctx);
      expect(out.ok).toBe(true);
      expect(issueOf(h, "STA-1").stateId).toBe(BACKLOG);
      expect(issueOf(h, "STA-1").labelIds).toEqual(
        [h.world.labels.find((l) => l.name === "agent-failed")!.id],
      );
      expect(h.workspaces.workspaces.find((w) => w.label === "STA-1")!.closed).toBe(false);
    } finally {
      h.stop();
    }
  });

  test("status shows slots, status/progress, checkpoint, and receipt", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      const building = await runCommand({ command: "status" }, h.ctx);
      expect(building.ok).toBe(true);
      expect(building.text).toContain("1 / 3 slots");
      expect(building.text).toContain("STA-1  Build/In progress");
      await ticketCommand(h, "STA-1", "submit", JSON.stringify(buildPayload()));
      // Build+Complete still holds its Build slot while the owner reviews.
      const out = await runCommand({ command: "status" }, h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("1 / 3 slots");
      expect(out.text).toContain("STA-1");
      expect(out.text).toContain("Build/");
      const data = out.data as { slots: { used: number; max: number }; tickets: Record<string, unknown>[] };
      expect(data.slots).toEqual({ used: 1, max: 3 });
      expect(data.tickets[0]).toMatchObject({ identifier: "STA-1", progress: "complete", checkpoint: HEAD });
    } finally {
      h.stop();
    }
  });

  test("begin retries are idempotent", async () => {
    const h = await harness();
    try {
      await startBuild(h, "STA-1");
      // Repeated explicit begin acknowledges the already recorded stage.
      expect((await ticketCommand(h, "STA-1", "begin")).ok).toBe(true); // Repeated begin is idempotent.
      expect((await runCommand({ command: "begin", ticket: "STA-1" }, h.ctx)).ok).toBe(true);
      expect((await runCommand({ command: "unblock", ticket: "STA-1" }, h.ctx)).ok).toBe(false);
    } finally {
      h.stop();
    }
  });
});
