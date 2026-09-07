// Review wake-up against a fake Linear endpoint and fake Herdr: an idle or
// done Commander is prompted once when its Acceptance worker finishes, a
// lost Commander is rebuilt from Review + In progress, one completion never
// wakes twice, and Igniter never judges the report. No network beyond the
// fakes, no real credentials, no real project, no daemon. The last block
// replays the same story through the real Herdr socket client against a
// scripted daemon speaking the NDJSON protocol.

import { describe, expect, test } from "bun:test";
import net from "node:net";
import { unlink } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceSink, type CommandContext } from "./commands";
import { validateStartup, Watcher, type ResolvedDispatch } from "./claims";
import { parseDispatchConfig } from "./config";
import { LinearClient } from "./linear";
import { reviewWakeKey } from "./review-wake";
import { addIssue, standardWorld, startFakeLinear } from "./fake-linear";
import { FakeGit } from "./fake-git";
import { FakeWorkspaces } from "./fake-workspaces";
import { createHerdrWorkspaces } from "./workspaces";
import { reviewerName } from "./workspaces";

const REVIEW = "st-review";
const IN_PROGRESS = "label-in-progress";
const COMPLETE = "label-complete";
const BLOCKED = "label-blocked";
const CRITERIA = "## 驗收條件\n- [ ] works\n- [ ] shines\n";
const HEAD = "deadbeefcafe0001";

interface Harness {
  ctx: CommandContext;
  watcher: Watcher;
  lines: string[];
  workspaces: FakeWorkspaces;
  client: LinearClient;
  resolved: ResolvedDispatch;
  world: ReturnType<typeof standardWorld>;
  stop: () => void;
}

async function harness(): Promise<Harness> {
  const world = standardWorld("test-key");
  const fake = startFakeLinear(world);
  const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url });
  const resolved = await validateStartup(
    client,
    parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 3 }),
  );
  const lines: string[] = [];
  const decisions = {
    record: async (ticket: string, message: string) => {
      lines.push(`${ticket} ${message}`);
    },
  };
  const workspaces = new FakeWorkspaces();
  const git = new FakeGit();
  git.head = HEAD;
  const repoRoot = join(mkdtempSync(join(tmpdir(), "igniter-wake-root-")), "repo");
  const sink = createWorkspaceSink({ workspaces, config: resolved.config, repoRoot, runGit: git });
  const ctx: CommandContext = {
    client,
    resolved,
    host: "h",
    decisions,
    workspaces,
    sink,
    repoRoot,
    git,
    lastPollAt: () => null,
  };
  const watcher = new Watcher({
    client,
    resolved,
    host: "h",
    decisions,
    workspaces,
    sink,
    git,
    repoRoot,
  });
  return { ctx, watcher, lines, workspaces, client, resolved, world, stop: () => fake.stop() };
}

function issueOf(h: Harness, identifier: string) {
  const issue = h.world.issues.find((i) => i.identifier === identifier);
  if (!issue) throw new Error(`no such issue ${identifier}`);
  return issue;
}

/** A Review + In progress ticket with a workspace, commander, and reviewer. */
function seedReview(
  h: Harness,
  identifier: string,
  options: {
    progress?: string;
    commanderStatus?: string;
    reviewerStatus?: string;
    session?: string | null;
    revision?: number | null;
    noCommander?: boolean;
    noReviewer?: boolean;
    paused?: boolean;
  } = {},
): void {
  addIssue(h.world, {
    identifier,
    stateId: REVIEW,
    priority: 1,
    description: CRITERIA,
    labelIds: [options.progress ?? IN_PROGRESS],
  });
  h.workspaces.seedWorkspace(
    identifier,
    {
      ticket: identifier,
      commander: "claude",
      status: "review",
      progress: "in_progress",
      checkpoint: HEAD,
      ...(options.paused ? { paused: "1" } : {}),
    },
    { commander: !options.noCommander, commanderStatus: options.commanderStatus ?? "working" },
  );
  if (!options.noReviewer) {
    h.workspaces.seedAgent(identifier, reviewerName(identifier), "reviewer", {
      agentStatus: options.reviewerStatus ?? "working",
      session: options.session === undefined ? "sess-1" : options.session,
      revision: options.revision === undefined ? 7 : options.revision,
    });
  }
}

function linearSnapshot(h: Harness, identifier: string): string {
  const issue = issueOf(h, identifier);
  return JSON.stringify({ state: issue.stateId, labels: issue.labelIds, comments: issue.comments.length, attachments: issue.attachments.length });
}

describe("reviewWakeKey", () => {
  test("tiles ticket, stage, session, and revision", () => {
    expect(reviewWakeKey("STA-1", "sess-1", 7)).toBe("STA-1|review|sess-1|7");
    expect(reviewWakeKey("STA-1", "sess-1", 7)).not.toBe(reviewWakeKey("STA-1", "sess-1", 8));
    expect(reviewWakeKey("STA-1", "sess-1", 7)).not.toBe(reviewWakeKey("STA-1", "sess-2", 7));
    expect(reviewWakeKey("STA-1", null, null)).toBe("STA-1|review|absent|none");
  });
});

describe("wake on a finished reviewer", () => {
  test("an idle commander is prompted once and reads the reviewer report", async () => {
    const h = await harness();
    try {
      seedReview(h, "STA-1", { commanderStatus: "idle", reviewerStatus: "done" });
      const before = linearSnapshot(h, "STA-1");
      for (let poll = 0; poll < 3; poll += 1) {
        await h.watcher.pollOnce();
      }
      const inbox = h.workspaces.promptsFor("commander-sta-1");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toContain("reviewer-sta-1");
      expect(inbox[0]).toContain("`igniter state --json`");
      expect(inbox[0]).toContain("never submit without a complete report");
      expect(h.lines).toContainEqual(
        expect.stringContaining("STA-1 review wake-up: reviewer-sta-1 done, commander idle prompted to read the report"),
      );
      // The wake-up is Herdr-only: Linear keeps Review + In progress with no
      // comment, no label move, no receipt.
      expect(linearSnapshot(h, "STA-1")).toBe(before);
      expect(issueOf(h, "STA-1").labelIds).toEqual([IN_PROGRESS]);
    } finally {
      h.stop();
    }
  });

  test("a done commander wakes too: Herdr done is not ticket completion", async () => {
    const h = await harness();
    try {
      seedReview(h, "STA-1", { commanderStatus: "done", reviewerStatus: "done" });
      await h.watcher.pollOnce();
      const inbox = h.workspaces.promptsFor("commander-sta-1");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toContain("reviewer-sta-1");
      expect(issueOf(h, "STA-1").stateId).toBe(REVIEW);
      expect(issueOf(h, "STA-1").labelIds).toEqual([IN_PROGRESS]);
      expect(issueOf(h, "STA-1").comments).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("a lost commander is rebuilt from Review + In progress and then nudged", async () => {
    const h = await harness();
    try {
      seedReview(h, "STA-1", { noCommander: true, reviewerStatus: "done" });
      const before = linearSnapshot(h, "STA-1");
      await h.watcher.pollOnce();
      const agent = h.workspaces.agents.find((a) => a.name === "commander-sta-1");
      expect(agent).toBeDefined();
      const inbox = h.workspaces.promptsFor("commander-sta-1");
      expect(inbox).toHaveLength(2);
      expect(inbox[0]).toContain("This is a resumed run.");
      expect(inbox[0]).toContain("`igniter state --json`");
      expect(inbox[1]).toContain("reviewer-sta-1");
      expect(h.lines).toContainEqual(
        expect.stringContaining("STA-1 review wake-up: reviewer-sta-1 done, commander rebuilt at review+in_progress"),
      );
      // The rebuild is Herdr-only, like `igniter resume`: Linear is untouched.
      expect(linearSnapshot(h, "STA-1")).toBe(before);
      // A second poll does not rebuild again.
      await h.watcher.pollOnce();
      expect(h.workspaces.agents.filter((a) => a.name === "commander-sta-1")).toHaveLength(1);
      expect(h.workspaces.promptsFor("commander-sta-1")).toHaveLength(2);
    } finally {
      h.stop();
    }
  });

  test("a new reviewer session wakes again after the first completion", async () => {
    const h = await harness();
    try {
      seedReview(h, "STA-1", { commanderStatus: "idle", reviewerStatus: "done", session: "sess-1", revision: 7 });
      await h.watcher.pollOnce();
      await h.watcher.pollOnce();
      expect(h.workspaces.promptsFor("commander-sta-1")).toHaveLength(1);
      // The next acceptance round runs under a new worker session.
      const reviewer = h.workspaces.agents.find((a) => a.name === "reviewer-sta-1")!;
      reviewer.session = "sess-2";
      reviewer.revision = 1;
      await h.watcher.pollOnce();
      expect(h.workspaces.promptsFor("commander-sta-1")).toHaveLength(2);
      expect(h.lines.filter((l) => l.includes("review wake-up:"))).toHaveLength(2);
    } finally {
      h.stop();
    }
  });

  test("a gone reviewer wakes the commander to handle it, without guessing", async () => {
    const h = await harness();
    try {
      seedReview(h, "STA-1", { commanderStatus: "idle", noReviewer: true });
      const before = linearSnapshot(h, "STA-1");
      await h.watcher.pollOnce();
      await h.watcher.pollOnce();
      const inbox = h.workspaces.promptsFor("commander-sta-1");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toContain("is gone (no live agent)");
      expect(inbox[0]).toContain("Never submit without a complete report");
      expect(linearSnapshot(h, "STA-1")).toBe(before);
    } finally {
      h.stop();
    }
  });

  test("gone, then a session, then gone again wakes every episode", async () => {
    const h = await harness();
    try {
      seedReview(h, "STA-1", { commanderStatus: "idle", noReviewer: true });
      await h.watcher.pollOnce();
      expect(h.workspaces.promptsFor("commander-sta-1")).toHaveLength(1);
      // The Commander recreates the worker; it finishes under a new session.
      h.workspaces.seedAgent("STA-1", reviewerName("STA-1"), "reviewer", {
        agentStatus: "done",
        session: "sess-2",
        revision: 1,
      });
      await h.watcher.pollOnce();
      expect(h.workspaces.promptsFor("commander-sta-1")).toHaveLength(2);
      // That worker vanishes too. Prompting the Commander advanced its
      // revision the way Herdr does, so the new absence wakes again.
      h.workspaces.agents = h.workspaces.agents.filter((a) => a.name !== reviewerName("STA-1"));
      h.workspaces.agents.find((a) => a.name === "commander-sta-1")!.revision = 5;
      await h.watcher.pollOnce();
      expect(h.workspaces.promptsFor("commander-sta-1")).toHaveLength(3);
      await h.watcher.pollOnce();
      expect(h.workspaces.promptsFor("commander-sta-1")).toHaveLength(3);
    } finally {
      h.stop();
    }
  });

  test("a failed prompt keeps its key and retries on the next poll", async () => {
    const h = await harness();
    try {
      seedReview(h, "STA-1", { commanderStatus: "idle", reviewerStatus: "done" });
      h.workspaces.failMethods.add("agent.prompt");
      await h.watcher.pollOnce();
      expect(h.workspaces.promptsFor("commander-sta-1")).toHaveLength(0);
      expect(h.lines).toContainEqual(expect.stringContaining("STA-1 review wake-up failed:"));
      h.workspaces.failMethods.clear();
      await h.watcher.pollOnce();
      expect(h.workspaces.promptsFor("commander-sta-1")).toHaveLength(1);
      await h.watcher.pollOnce();
      expect(h.workspaces.promptsFor("commander-sta-1")).toHaveLength(1);
    } finally {
      h.stop();
    }
  });
});

describe("igniter never judges the report", () => {
  const reports = {
    pass: "ACCEPTANCE_COMPLETE checkpoint deadbeefcafe0001 PASS works shines https://example.test/works",
    fail: "ACCEPTANCE_COMPLETE checkpoint deadbeefcafe0001 FAIL works is broken https://example.test/works",
    thin: "ACCEPTANCE_COMPLETE checkpoint deadbeefcafe0001 PASS works (no evidence recorded)",
    markerless: "done, looks fine to me",
  } as const;

  for (const [kind, report] of Object.entries(reports)) {
    test(`${kind} report wakes identically with no Linear verdict`, async () => {
      const h = await harness();
      try {
        seedReview(h, "STA-1", { commanderStatus: "idle", reviewerStatus: "done" });
        const reviewer = h.workspaces.agents.find((a) => a.name === "reviewer-sta-1")!;
        h.workspaces.paneText[reviewer.paneId] = report;
        const before = linearSnapshot(h, "STA-1");
        await h.watcher.pollOnce();
        const inbox = h.workspaces.promptsFor("commander-sta-1");
        expect(inbox).toHaveLength(1);
        // The prompt carries no verdict: Igniter did not parse the pane.
        expect(inbox[0]).not.toContain("PASS");
        expect(inbox[0]).not.toContain("FAIL");
        expect(linearSnapshot(h, "STA-1")).toBe(before);
        expect(issueOf(h, "STA-1").comments).toHaveLength(0);
      } finally {
        h.stop();
      }
    });
  }
});

describe("stays quiet", () => {
  test("no prompt while the wait is alive or the stage moved on", async () => {
    const h = await harness();
    try {
      seedReview(h, "STA-1", { commanderStatus: "idle", reviewerStatus: "working" });
      seedReview(h, "STA-2", { commanderStatus: "working", reviewerStatus: "done" });
      seedReview(h, "STA-3", { commanderStatus: "blocked", reviewerStatus: "done" });
      seedReview(h, "STA-4", { commanderStatus: "idle", reviewerStatus: "done", progress: BLOCKED });
      seedReview(h, "STA-5", { commanderStatus: "idle", reviewerStatus: "done", progress: COMPLETE });
      seedReview(h, "STA-6", { commanderStatus: "idle", reviewerStatus: "done", paused: true });
      await h.watcher.pollOnce();
      expect(h.workspaces.calls.filter((c) => c.method === "agent.prompt")).toHaveLength(0);
      expect(h.lines.some((l) => l.includes("review wake-up"))).toBe(false);
    } finally {
      h.stop();
    }
  });

  test("a ticket without a workspace is adopted, not woken", async () => {
    const h = await harness();
    try {
      addIssue(h.world, { identifier: "STA-1", stateId: REVIEW, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
      await h.watcher.pollOnce();
      // The orphan path reopens the workspace and keeps the Linear state;
      // the wake-up has no workspace to read and stays out of the way.
      expect(h.workspaces.workspaces.filter((w) => !w.closed)).toHaveLength(1);
      expect(issueOf(h, "STA-1").labelIds).toEqual([IN_PROGRESS]);
      expect(h.lines.some((l) => l.includes("review wake-up"))).toBe(false);
    } finally {
      h.stop();
    }
  });
});

type SocketHandler = (params: Record<string, unknown>, index: number) => unknown;

interface FakeHerdr {
  path: string;
  prompts: { target: string; text: string }[];
  stop: () => Promise<void>;
}

/** A scripted Herdr daemon speaking the real NDJSON socket protocol. */
async function startFakeHerdr(handlers: Record<string, SocketHandler>): Promise<FakeHerdr> {
  const prompts: { target: string; text: string }[] = [];
  const counts: Record<string, number> = {};
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
        const index = counts[request.method] ?? 0;
        counts[request.method] = index + 1;
        const handler = handlers[request.method];
        if (!handler) {
          socket.write(`${JSON.stringify({ id: request.id, error: { code: "unknown", message: `no handler for ${request.method}` } })}\n`);
          continue;
        }
        try {
          socket.write(`${JSON.stringify({ id: request.id, result: handler(request.params, index) })}\n`);
        } catch (error) {
          socket.write(`${JSON.stringify({ id: request.id, error: { code: "handler", message: (error as Error).message } })}\n`);
        }
      }
    });
  });
  const path = join(tmpdir(), `fake-herdr-wake-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sock`);
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(path, resolve);
  });
  return {
    path,
    prompts,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }).finally(() => unlink(path).catch(() => {})),
  };
}

function socketAgent(name: string, status: string, session: string | null, revision: number, paneId: string, workspaceId: string) {
  return {
    name,
    agent_status: status,
    workspace_id: workspaceId,
    pane_id: paneId,
    ...(session ? { agent_session: { agent: "claude", kind: "id", source: "herdr", value: session } } : {}),
    revision,
  };
}

describe("interrupted wait over a real Herdr socket", () => {
  test("the reviewer finishing after the commander's wait died wakes exactly once", async () => {
    const world = standardWorld("test-key");
    addIssue(world, { identifier: "STA-1", stateId: REVIEW, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
    const fakeLinear = startFakeLinear(world);
    const prompts: { target: string; text: string }[] = [];
    const daemon = await startFakeHerdr({
      "session.snapshot": (_params, index) => {
        // First poll: the Commander still waits on a working reviewer.
        // Later polls: the wait died (commander idle) and the reviewer is done.
        const waiting = index === 0;
        return {
          type: "session_snapshot",
          snapshot: {
            workspaces: [
              {
                workspace_id: "ws-1",
                label: "STA-1",
                tokens: { ticket: "STA-1", commander: "claude", status: "review", progress: "in_progress", checkpoint: HEAD },
              },
            ],
            agents: [
              socketAgent("commander-sta-1", waiting ? "working" : "idle", null, waiting ? 3 : 4, "pane-1", "ws-1"),
              socketAgent("reviewer-sta-1", waiting ? "working" : "done", "sess-9", waiting ? 11 : 12, "pane-2", "ws-1"),
            ],
            panes: [
              { pane_id: "pane-1", workspace_id: "ws-1" },
              { pane_id: "pane-2", workspace_id: "ws-1" },
            ],
          },
        };
      },
      "agent.prompt": (params) => {
        prompts.push({ target: String(params["target"]), text: String(params["text"]) });
        return { type: "agent_prompted", agent: { name: String(params["target"]) } };
      },
    });
    try {
      const client = new LinearClient({ apiKey: "test-key", endpoint: fakeLinear.url });
      const resolved = await validateStartup(
        client,
        parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 3 }),
      );
      const lines: string[] = [];
      const workspaces = createHerdrWorkspaces({ socketPath: daemon.path });
      const watcher = new Watcher({
        client,
        resolved,
        host: "h",
        decisions: {
          record: async (ticket, message) => {
            lines.push(`${ticket} ${message}`);
          },
        },
        workspaces,
        git: new FakeGit(),
        repoRoot: join(mkdtempSync(join(tmpdir(), "igniter-wake-sock-")), "repo"),
      });
      const issue = world.issues[0]!;
      const linearBefore = JSON.stringify({ state: issue.stateId, labels: issue.labelIds, comments: issue.comments.length });
      await watcher.pollOnce();
      expect(prompts).toHaveLength(0);
      await watcher.pollOnce();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.target).toBe("commander-sta-1");
      expect(prompts[0]!.text).toContain("reviewer-sta-1");
      expect(lines).toContainEqual(expect.stringContaining("STA-1 review wake-up: reviewer-sta-1 done, commander idle"));
      await watcher.pollOnce();
      expect(prompts).toHaveLength(1);
      const linearAfter = JSON.stringify({ state: issue.stateId, labels: issue.labelIds, comments: issue.comments.length });
      expect(linearAfter).toBe(linearBefore);
    } finally {
      await daemon.stop();
      fakeLinear.stop();
    }
  });

  test("a bare string session still keys the dedup", async () => {
    const world = standardWorld("test-key");
    addIssue(world, { identifier: "STA-1", stateId: REVIEW, priority: 1, description: CRITERIA, labelIds: [IN_PROGRESS] });
    const fakeLinear = startFakeLinear(world);
    const prompts: { target: string; text: string }[] = [];
    const daemon = await startFakeHerdr({
      "session.snapshot": () => ({
        type: "session_snapshot",
        snapshot: {
          workspaces: [
            {
              workspace_id: "ws-1",
              label: "STA-1",
              tokens: { ticket: "STA-1", commander: "claude", status: "review", progress: "in_progress", checkpoint: HEAD },
            },
          ],
          agents: [
            socketAgent("commander-sta-1", "idle", null, 4, "pane-1", "ws-1"),
            {
              name: "reviewer-sta-1",
              agent_status: "done",
              workspace_id: "ws-1",
              pane_id: "pane-2",
              agent_session: "sess-string",
              revision: 3,
            },
          ],
          panes: [
            { pane_id: "pane-1", workspace_id: "ws-1" },
            { pane_id: "pane-2", workspace_id: "ws-1" },
          ],
        },
      }),
      "agent.prompt": (params) => {
        prompts.push({ target: String(params["target"]), text: String(params["text"]) });
        return { type: "agent_prompted", agent: { name: String(params["target"]) } };
      },
    });
    try {
      const client = new LinearClient({ apiKey: "test-key", endpoint: fakeLinear.url });
      const resolved = await validateStartup(
        client,
        parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 3 }),
      );
      const watcher = new Watcher({
        client,
        resolved,
        host: "h",
        decisions: { record: async () => {} },
        workspaces: createHerdrWorkspaces({ socketPath: daemon.path }),
        git: new FakeGit(),
        repoRoot: join(mkdtempSync(join(tmpdir(), "igniter-wake-str-")), "repo"),
      });
      await watcher.pollOnce();
      await watcher.pollOnce();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.text).toContain("reviewer-sta-1");
    } finally {
      await daemon.stop();
      fakeLinear.stop();
    }
  });
});
