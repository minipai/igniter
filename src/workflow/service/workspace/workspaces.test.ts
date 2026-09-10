import { describe, expect, test } from "bun:test";
import net from "node:net";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHerdrWorkspaces,
  createSocketPathCache,
  extractRunningTickets,
  ticketFromAgentName,
  tokensByTicket,
  type WorkspaceSnapshot,
} from "./workspaces";
import { FakeWorkspaces, MAX_METADATA_TOKENS } from "../../testing/fake-workspaces";

describe("metadata report width", () => {
  test("the fake rejects an over-wide report like the real Herdr", async () => {
    const workspaces = new FakeWorkspaces();
    workspaces.seedWorkspace("STA-1", { ticket: "STA-1" });
    const workspaceId = workspaces.workspaces[0]!.workspaceId;
    const sixteen: Record<string, string> = {};
    for (let i = 0; i < MAX_METADATA_TOKENS; i += 1) sixteen[`k${i}`] = "v";
    await workspaces.reportMetadata(workspaceId, sixteen);
    const seventeen = { ...sixteen, overflow: "v" };
    await expect(workspaces.reportMetadata(workspaceId, seventeen)).rejects.toThrow(
      "may update at most 16 tokens",
    );
  });
});

describe("extractRunningTickets", () => {
  test("agent names and token values map to tickets; everything else is ignored", () => {
    expect(
      extractRunningTickets({
        agents: [
          { name: "deliverer-STA-1" },
          { name: "builder-STA-2" },
          { name: "reviewer-STA-3" },
          { name: "bash" },
          { name: null },
          {},
        ],
        workspaces: [
          { tokens: { source: "igniter", ticket: "STA-4" } },
          { tokens: { source: "other" } },
          {},
        ],
      }),
    ).toEqual(new Set(["STA-1", "STA-2", "STA-3", "STA-4"]));
  });

  test("empty snapshots yield no tickets", () => {
    expect(extractRunningTickets({})).toEqual(new Set());
    expect(extractRunningTickets({ agents: [], workspaces: [] })).toEqual(new Set());
  });

  test("lowercase agent names match and read back uppercased", () => {
    expect(
      extractRunningTickets({ agents: [{ name: "deliverer-sta-1" }, { name: "builder-sta-2" }] }),
    ).toEqual(new Set(["STA-1", "STA-2"]));
    expect(ticketFromAgentName("deliverer-sta-176")).toBe("STA-176");
    expect(ticketFromAgentName("deliverer-STA-176")).toBe("STA-176");
    expect(ticketFromAgentName("bash")).toBeNull();
    expect(ticketFromAgentName("commander-sta-176")).toBeNull();
  });

  test("tokensByTicket matches by label or ticket token", () => {
    const snapshot: WorkspaceSnapshot = {
      workspaces: [
        { workspaceId: "w1", label: "STA-1", tokens: { ticket: "STA-1" } },
        { workspaceId: "w2", label: "STA-2", tokens: { stage: "build" } },
      ],
      agents: [{ name: "deliverer-sta-2", agentStatus: "working", workspaceId: "w2", paneId: "p2", session: null, revision: null }],
      panes: [],
    };
    const byTicket = tokensByTicket(snapshot);
    expect(byTicket.get("STA-1")).toMatchObject({ ticket: "STA-1" });
    expect(byTicket.get("STA-2")).toMatchObject({ stage: "build" });
  });
});

describe("createSocketPathCache", () => {
  test("resolves once and reuses the answer", async () => {
    let calls = 0;
    const path = createSocketPathCache({
      timeoutMs: 100,
      env: {},
      runStatus: async () => {
        calls += 1;
        return "server:\n  socket: /tmp/herdr.sock\n";
      },
    });
    expect(await path()).toBe("/tmp/herdr.sock");
    expect(await path()).toBe("/tmp/herdr.sock");
    expect(calls).toBe(1);
  });

  test("an explicit path never shells out", async () => {
    let calls = 0;
    const path = createSocketPathCache({
      socketPath: "/tmp/herdr.sock",
      timeoutMs: 100,
      runStatus: async () => {
        calls += 1;
        return "";
      },
    });
    expect(await path()).toBe("/tmp/herdr.sock");
    expect(await path()).toBe("/tmp/herdr.sock");
    expect(calls).toBe(0);
  });

  test("a wedged lookup times out instead of holding the event loop", async () => {
    let calls = 0;
    const path = createSocketPathCache({
      timeoutMs: 50,
      env: {},
      runStatus: () => {
        calls += 1;
        return new Promise<string>(() => {});
      },
    });
    const started = Date.now();
    await expect(path()).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(2000);
    // Failures are not cached: the next poll retries.
    await expect(path()).rejects.toThrow("timed out");
    expect(calls).toBe(2);
  });
});

type SocketHandler = (params: Record<string, unknown>, index: number) => unknown;

interface FakeHerdr {
  path: string;
  calls: { method: string; params: unknown }[];
  stop: () => Promise<void>;
}

/** A scripted Herdr daemon speaking the real NDJSON socket protocol. */
async function startFakeHerdr(handlers: Record<string, SocketHandler>): Promise<FakeHerdr> {
  const calls: { method: string; params: unknown }[] = [];
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
        calls.push({ method: request.method, params: request.params });
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
  const path = join(tmpdir(), `fake-herdr-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sock`);
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(path, resolve);
  });
  return {
    path,
    calls,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }).finally(() => unlink(path).catch(() => {})),
  };
}

const AGENT_READY = { type: "agent_info", agent: { interactive_ready: true, launch_pending: false } };

describe("startAgent against a live socket", () => {
  test("retries while the fresh pane's shell is not up yet", async () => {
    let starts = 0;
    const fake = await startFakeHerdr({
      "pane.send_input": () => ({ type: "ok" }),
      "agent.start": () => {
        starts += 1;
        if (starts <= 2) throw new Error("agent target pane pane-1 is not an available shell");
        return { type: "agent_started" };
      },
      "agent.get": () => AGENT_READY,
    });
    try {
      const workspaces = createHerdrWorkspaces({ socketPath: fake.path });
      await workspaces.startAgent({ paneId: "pane-1", kind: "claude", name: "deliverer-sta-1" });
      expect(starts).toBe(3);
      expect(fake.calls[0]).toEqual({
        method: "pane.send_input",
        params: {
          pane_id: "pane-1",
          text: "unset LINEAR_API_KEY RESEND_API_KEY FAL_API_KEY",
          keys: ["Enter"],
        },
      });
      expect(fake.calls.filter((c) => c.method === "agent.get")).toHaveLength(1);
    } finally {
      await fake.stop();
    }
  });

  test("any other start error throws at once", async () => {
    let starts = 0;
    const fake = await startFakeHerdr({
      "pane.send_input": () => ({ type: "ok" }),
      "agent.start": () => {
        starts += 1;
        throw new Error("agent kind hal is unknown");
      },
    });
    try {
      const workspaces = createHerdrWorkspaces({ socketPath: fake.path });
      await expect(
        workspaces.startAgent({ paneId: "pane-1", kind: "hal", name: "x" }),
      ).rejects.toThrow("unknown");
      expect(starts).toBe(1);
    } finally {
      await fake.stop();
    }
  });

  test("waits for interactive_ready past launch_pending before returning", async () => {
    let gets = 0;
    const fake = await startFakeHerdr({
      "pane.send_input": () => ({ type: "ok" }),
      "agent.start": () => ({ type: "agent_started" }),
      "agent.get": () => {
        gets += 1;
        return gets === 1
          ? { type: "agent_info", agent: { interactive_ready: false, launch_pending: true } }
          : AGENT_READY;
      },
    });
    try {
      const workspaces = createHerdrWorkspaces({ socketPath: fake.path });
      await workspaces.startAgent({ paneId: "pane-1", kind: "claude", name: "deliverer-sta-1" });
      expect(gets).toBe(2);
      expect(fake.calls.filter((c) => c.method === "agent.start")).toHaveLength(1);
    } finally {
      await fake.stop();
    }
  });
});
