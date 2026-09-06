// Board snapshot, SSE re-broadcast, and the answer command against fake
// Linear and fake Herdr. No network, no real credentials, no daemon.

import { describe, expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import {
  BOARD_SUBSCRIPTIONS,
  buildBoardSnapshot,
  COMMANDER_RULES_PATH,
  createBoardHub,
  createPaneOutputCache,
  lastLineOf,
  readRulesText,
  startBoardMonitor,
  withBoardEvents,
  type BoardInputs,
} from "./board";
import { createEventStream } from "./events";
import { startServer } from "./serve";
import { answerKeysFor, collectStatus, runCommand, type CommandContext } from "../dispatch/commands";
import { validateStartup } from "../dispatch/claims";
import { parseDispatchConfig } from "../dispatch/config";
import { LinearClient } from "../dispatch/linear";
import { addIssue, standardWorld, startFakeLinear } from "../dispatch/fake-linear";
import { FakeWorkspaces } from "../dispatch/fake-workspaces";

const BUILD = "st-build";
const CRITERIA = "## 驗收條件\n- [ ] works\n";
const NOW = Date.parse("2026-09-05T12:00:00.000Z");
const LAST_POLL = "2026-09-05T11:59:30.000Z";

interface Harness {
  ctx: CommandContext;
  lines: string[];
  workspaces: FakeWorkspaces;
  stop: () => void;
}

async function harness(): Promise<Harness> {
  const world = standardWorld("test-key");
  const fake = startFakeLinear(world);
  const client = new LinearClient({ apiKey: "test-key", endpoint: fake.url });
  const resolved = await validateStartup(
    client,
    parseDispatchConfig({ project: "igniter", team: "Starcoder", max_running: 2 }),
  );
  addIssue(world, { identifier: "STA-1", stateId: BUILD, priority: 1, description: CRITERIA, labelIds: ["label-in-progress"] });
  addIssue(world, { identifier: "STA-2", stateId: BUILD, priority: 2, description: CRITERIA, labelIds: ["label-in-progress"] });
  addIssue(world, { identifier: "STA-3", stateId: BUILD, priority: 3, description: CRITERIA, labelIds: ["label-in-progress"] });
  addIssue(world, { identifier: "STA-9", stateId: BUILD, priority: 4, description: CRITERIA, labelIds: ["label-in-progress"] });
  const lines: string[] = [];
  const workspaces = new FakeWorkspaces();
  // STA-1 waits on a person: commander blocked.
  const ws1 = workspaces.seedWorkspace(
    "STA-1",
    {
      ticket: "STA-1",
      status: "build",
      progress: "in_progress",
      commander: "claude",
      builder: "opencode",
    },
    { commanderStatus: "blocked", paneText: "[commander] holding for approval\n[commander] waiting on owner response…" },
  );
  ws1.panes.push("pane-b1");
  workspaces.agents.push({
    name: "builder-sta-1",
    kind: "opencode",
    agentStatus: "idle",
    workspaceId: ws1.workspaceId,
    paneId: "pane-b1",
    inbox: [],
  });
  workspaces.paneText["pane-b1"] = "[opencode] requesting approval: rm -rf dist";
  // STA-2 is quiet: stalled, commander silent.
  workspaces.seedWorkspace(
    "STA-2",
    {
      ticket: "STA-2",
      status: "build",
      progress: "in_progress",
      commander: "codex",
      stalled: "1",
    },
    { commanderStatus: "working", paneText: "[commander] waiting for selector" },
  );
  // STA-3 is alive.
  workspaces.seedWorkspace(
    "STA-3",
    {
      ticket: "STA-3",
      status: "build",
      progress: "in_progress",
      commander: "claude",
    },
    { commanderStatus: "working", paneText: "[commander] delegating build task" },
  );
  const ctx: CommandContext = {
    client,
    resolved,
    host: "minipc",
    decisions: {
      record: async (ticket, message) => {
        lines.push(`${ticket} ${message}`);
      },
    },
    workspaces,
    sink: () => {},
    repoRoot: "/tmp/igniter-board-test",
    lastPollAt: () => LAST_POLL,
    now: () => NOW,
  };
  return { ctx, lines, workspaces, stop: () => fake.stop() };
}

async function boardInputs(h: Harness): Promise<BoardInputs> {
  const { data, snapshot } = await collectStatus(h.ctx);
  const outputs = new Map<string, { text: string; at: string | null }>();
  if (snapshot) {
    for (const agent of snapshot.agents) {
      const read = await h.workspaces.readPane(agent.paneId, 30);
      outputs.set(agent.paneId, { text: read.text, at: new Date(NOW - 8000).toISOString() });
    }
  }
  return {
    status: data,
    snapshot,
    queue: [
      { identifier: "STA-5", title: "Queued one", priority: 2, reason: "next" },
      { identifier: "STA-6", title: "Queued two", priority: 4, reason: "waiting, slots full" },
    ],
    activity: ["2026-09-05T11:50:00.000Z STA-1 claimed: Todo → Build (slot 0)"],
    rules: "# Commander rules\n",
    host: "minipc",
    linearOrg: "starcoder",
    outputs,
    now: () => NOW,
  };
}

describe("buildBoardSnapshot", () => {
  test("joins status rows with Herdr panes, sorted reply → quiet → alive", async () => {
    const h = await harness();
    try {
      const board = buildBoardSnapshot(await boardInputs(h));
      expect(board.host).toBe("minipc");
      expect(board.usedSlots).toBe(4 - 0);
      expect(board.maxRunning).toBe(2);
      expect(board.lastPollAt).toBe(LAST_POLL);
      expect(board.needsYou).toBe(1);
      expect(board.tickets.map((t) => t.identifier)).toEqual(["STA-1", "STA-2", "STA-3"]);
      expect(board.queue).toHaveLength(2);
      expect(board.activity).toHaveLength(1);
      expect(board.rules).toBe("# Commander rules\n");

      const waiting = board.tickets[0] as (typeof board.tickets)[number];
      expect(waiting.block).toBe("approval");
      expect(waiting.railState).toBe("reply");
      expect(waiting.pulse).toContain("waiting on you");
      expect(waiting.panes.commander.agentStatus).toBe("blocked");
      expect(waiting.panes.commander.kind).toBe("claude");
      expect(waiting.panes.commander.lastLine).toBe("[commander] waiting on owner response…");
      expect(waiting.panes.builder.kind).toBe("opencode");
      expect(waiting.panes.builder.lastLine).toBe("[opencode] requesting approval: rm -rf dist");
      expect(waiting.panes.reviewer.agentStatus).toBe("notstarted");
      expect(waiting.level).toBe("ok");

      const quiet = board.tickets[1] as (typeof board.tickets)[number];
      expect(quiet.block).toBe("quiet");
      expect(quiet.railState).toBe("stalled");
      expect(quiet.pulse).toContain("quiet");
      expect(quiet.level).toBe("ok");

      const alive = board.tickets[2] as (typeof board.tickets)[number];
      expect(alive.block).toBeNull();
      expect(alive.railState).toBe("alive");
      expect(alive.pulse).toContain("alive");
    } finally {
      h.stop();
    }
  });

  test("marks every pane unavailable when Herdr is unreachable", async () => {
    const h = await harness();
    try {
      h.workspaces.failMethods.add("snapshot");
      const inputs = await boardInputs(h);
      // collectStatus swallows the snapshot failure itself.
      expect(inputs.snapshot).toBeNull();
      const board = buildBoardSnapshot(inputs);
      expect(board.tickets).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("lastLineOf takes the last non-empty line", () => {
    expect(lastLineOf("a\nb\n\n")).toBe("b");
    expect(lastLineOf("")).toBe("");
    expect(lastLineOf("  \n ")).toBe("");
  });
});

describe("answer command", () => {
  test("maps y/n to the commander's dialog and logs what was sent", async () => {
    const h = await harness();
    try {
      // STA-1 runs a claude commander: y becomes enter on its dialog.
      const out = await runCommand(["answer", "STA-1", "y"], h.ctx);
      expect(out.ok).toBe(true);
      expect(out.text).toContain("answered y for STA-1");
      const commander = h.workspaces.agents.find((a) => a.name === "commander-sta-1");
      if (!commander) throw new Error("commander agent is missing");
      expect(h.workspaces.sentKeys).toEqual([{ paneId: commander.paneId, keys: ["enter"] }]);
      expect(h.lines.join("\n")).toContain("STA-1 answered y (allowed once, sent enter)");

      const denied = await runCommand(["answer", "STA-3", "n"], h.ctx);
      expect(denied.ok).toBe(true);
      expect(h.lines.join("\n")).toContain("STA-3 answered n (denied, sent esc)");
    } finally {
      h.stop();
    }
  });

  test("other commander kinds get the literal y/n key", async () => {
    const h = await harness();
    try {
      // STA-2 runs a codex commander: the literal key goes through.
      const out = await runCommand(["answer", "STA-2", "y"], h.ctx);
      expect(out.ok).toBe(true);
      const commander = h.workspaces.agents.find((a) => a.name === "commander-sta-2");
      if (!commander) throw new Error("commander agent is missing");
      expect(h.workspaces.sentKeys).toEqual([{ paneId: commander.paneId, keys: ["y"] }]);
      expect(h.lines.join("\n")).toContain("STA-2 answered y (allowed once, sent y)");

      // A missing commander token falls back to the literal key too.
      const workspace = h.workspaces.workspaces.find((w) => w.label === "STA-2");
      if (!workspace) throw new Error("STA-2 workspace is missing");
      delete workspace.tokens["commander"];
      const fallback = await runCommand(["answer", "STA-2", "n"], h.ctx);
      expect(fallback.ok).toBe(true);
      expect(h.workspaces.sentKeys[1]).toEqual({ paneId: commander.paneId, keys: ["n"] });
    } finally {
      h.stop();
    }
  });

  test("answerKeysFor maps by commander kind", () => {
    expect(answerKeysFor("claude", "y")).toEqual(["enter"]);
    expect(answerKeysFor("claude", "n")).toEqual(["esc"]);
    expect(answerKeysFor("Claude", "y")).toEqual(["enter"]);
    expect(answerKeysFor("codex", "y")).toEqual(["y"]);
    expect(answerKeysFor("opencode", "n")).toEqual(["n"]);
    expect(answerKeysFor(undefined, "y")).toEqual(["y"]);
  });

  test("refuses bad keys, unknown tickets, and missing workspaces", async () => {
    const h = await harness();
    try {
      expect((await runCommand(["answer", "STA-1", "x"], h.ctx)).ok).toBe(false);
      expect((await runCommand(["answer", "STA-1"], h.ctx)).text).toContain("usage: igniter answer");
      expect(await runCommand(["answer", "STA-404", "y"], h.ctx)).toMatchObject({ ok: false });
      // STA-9 is building in Linear but has no workspace.
      const orphan = await runCommand(["answer", "STA-9", "y"], h.ctx);
      expect(orphan.ok).toBe(false);
      expect(orphan.text).toContain("no workspace");
      expect(h.workspaces.sentKeys).toEqual([]);
    } finally {
      h.stop();
    }
  });
});

describe("GET /api/board", () => {
  test("serves the snapshot, or 503 while dispatch is starting", async () => {
    const h = await harness();
    try {
      const board = buildBoardSnapshot(await boardInputs(h));
      const server = startServer({ port: 0, board: async () => board });
      try {
        const res = await fetch(`http://localhost:${server.port}/api/board`);
        expect(res.status).toBe(200);
        const payload = (await res.json()) as { tickets: { identifier: string }[]; needsYou: number };
        expect(payload.tickets.map((t) => t.identifier)).toEqual(["STA-1", "STA-2", "STA-3"]);
        expect(payload.needsYou).toBe(1);
      } finally {
        server.stop();
      }
      const starting = startServer({ port: 0, board: async () => null });
      try {
        expect((await fetch(`http://localhost:${starting.port}/api/board`)).status).toBe(503);
      } finally {
        starting.stop();
      }
      const none = startServer({ port: 0 });
      try {
        expect((await fetch(`http://localhost:${none.port}/api/board`)).status).toBe(503);
      } finally {
        none.stop();
      }
    } finally {
      h.stop();
    }
  });

  test("holds the SSE connection past the old 10s idle kill", async () => {
    // Production idle timeout is 60s; a short heartbeat keeps this 11s
    // hold deterministic instead of waiting out the real 15s beat.
    const server = startServer({ port: 0, heartbeatMs: 200 });
    try {
      const controller = new AbortController();
      const res = await fetch(`http://localhost:${server.port}/events`, {
        signal: controller.signal,
      });
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let heartbeats = 0;
      const deadline = Date.now() + 11_000;
      while (Date.now() < deadline) {
        const next = await reader?.read();
        if (!next || next.done) break;
        heartbeats += decoder.decode(next.value).split(": heartbeat").length - 1;
      }
      controller.abort();
      await reader?.cancel();
      expect(heartbeats).toBeGreaterThanOrEqual(5);
    } finally {
      server.stop();
    }
  }, 20_000);
});
describe("SSE hub", () => {
  test("re-broadcasts pane, workspace, poll, and decision events", async () => {
    const hub = createBoardHub();
    const controller = new AbortController();
    const res = createEventStream(controller.signal, hub);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    const readChunk = async (): Promise<string> => {
      const next = await reader?.read();
      return decoder.decode(next?.value);
    };
    let text = (await readChunk()) + (await readChunk());
    expect(text).toContain("event: ready");

    hub.emit("pane", { paneId: "pane-1" });
    hub.emit("workspace", { workspaceId: "ws-1" });
    hub.emit("poll", { lastPollAt: LAST_POLL });
    const logged = withBoardEvents({ record: async () => {} }, hub);
    await logged.record("STA-1", "answered y (allowed once)");
    text = "";
    for (let i = 0; i < 4; i++) text += await readChunk();
    expect(text).toContain("event: pane\ndata: {\"paneId\":\"pane-1\"}");
    expect(text).toContain("event: workspace\ndata: {\"workspaceId\":\"ws-1\"}");
    expect(text).toContain("event: poll");
    expect(text).toContain("event: decision");
    expect(text).toContain("answered y (allowed once)");
    controller.abort();
    reader?.cancel();
    expect(hub.size).toBe(0);
  });
});

describe("commander rules text", () => {
  test("reads the bundled rules by absolute install path, not the target repo", async () => {
    expect(isAbsolute(COMMANDER_RULES_PATH)).toBe(true);
    expect(COMMANDER_RULES_PATH.endsWith("rules.md")).toBe(true);
    expect(await readRulesText()).toStartWith("# Commander rules");
  });
});

describe("board monitor", () => {
  test("subscribes with param-less kinds and maps output/status/metadata events", async () => {
    const h = await harness();
    try {
      const hub = createBoardHub();
      const seen: { type: string; data: unknown }[] = [];
      hub.subscribe((event) => seen.push(event));
      const outputs = createPaneOutputCache({ workspaces: h.workspaces, now: () => NOW });
      const captured: {
        current: {
          onEvent: (event: { event: string; data: unknown }) => void;
          onResync: () => void;
        } | null;
      } = { current: null };
      const monitor = startBoardMonitor({
        hub,
        outputs,
        subscribe: (subscriptions, callbacks) => {
          expect([...subscriptions].map((s) => s.type)).toEqual([...BOARD_SUBSCRIPTIONS].map((s) => s.type));
          captured.current = callbacks;
          return () => {};
        },
        now: () => NOW,
      });
      captured.current?.onEvent({ event: "pane_output_changed", data: { pane_id: "pane-1" } });
      expect(outputs.outputs.get("pane-1")).toMatchObject({ at: new Date(NOW).toISOString() });
      captured.current?.onEvent({ event: "pane.agent_status_changed", data: { pane_id: "pane-1" } });
      captured.current?.onEvent({ event: "workspace_metadata_updated", data: { workspace_id: "ws-1" } });
      captured.current?.onEvent({ event: "pane_exited", data: { pane_id: "pane-9" } });
      captured.current?.onEvent({
        event: "pane_updated",
        data: { pane: { pane_id: "pane-7", workspace_id: "ws-7", agent_status: "blocked", revision: 41 } },
      });
      captured.current?.onEvent({ event: "pane_closed", data: { workspace_id: "ws-8" } });
      captured.current?.onResync();
      expect(seen.map((s) => s.type)).toEqual(["pane", "pane", "workspace", "pane", "pane", "workspace", "resync"]);
      expect(seen[4]).toEqual({ type: "pane", data: { paneId: "pane-7", agentStatus: "blocked" } });
      monitor.stop();
      captured.current?.onEvent({ event: "pane_output_changed", data: { pane_id: "pane-2" } });
      expect(seen).toHaveLength(7);
    } finally {
      h.stop();
    }
  });

  test("stamps last-output time when text changes under a constant revision", async () => {
    const h = await harness();
    try {
      let t = NOW;
      const outputs = createPaneOutputCache({ workspaces: h.workspaces, now: () => t });
      const commander = h.workspaces.agents.find((a) => a.name === "commander-sta-1");
      if (!commander) throw new Error("commander agent is missing");
      // The installed Herdr reports revision 0 on every read.
      h.workspaces.paneText[commander.paneId] = "line one";
      // First sighting proves nothing: no output time is claimed.
      expect((await outputs.refresh(commander.paneId)).at).toBeNull();
      t += 2000;
      expect((await outputs.refresh(commander.paneId)).at).toBeNull();
      // Same constant revision, changed text: stamps the read time.
      h.workspaces.paneText[commander.paneId] = "line one\nline two";
      t += 2000;
      expect((await outputs.refresh(commander.paneId)).at).toBe(new Date(t).toISOString());
      // An advancing revision stamps even when the tail text is identical.
      h.workspaces.paneRevision[commander.paneId] = 1;
      t += 2000;
      expect((await outputs.refresh(commander.paneId)).at).toBe(new Date(t).toISOString());
    } finally {
      h.stop();
    }
  });
  test("pane output cache reads at most once per second per pane", async () => {
    const h = await harness();
    try {
      let t = NOW;
      const outputs = createPaneOutputCache({ workspaces: h.workspaces, now: () => t });
      const commander = h.workspaces.agents.find((a) => a.name === "commander-sta-1");
      if (!commander) throw new Error("commander agent is missing");
      const reads = h.workspaces.calls.filter((c) => c.method === "pane.read").length;
      await outputs.refresh(commander.paneId);
      await outputs.refresh(commander.paneId);
      expect(h.workspaces.calls.filter((c) => c.method === "pane.read").length).toBe(reads + 1);
      t += 2000;
      await outputs.refresh(commander.paneId);
      expect(h.workspaces.calls.filter((c) => c.method === "pane.read").length).toBe(reads + 2);
    } finally {
      h.stop();
    }
  });
});
