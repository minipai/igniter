import { describe, expect, test } from "bun:test";
import net from "node:net";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
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
          { name: "acceptance-STA-3" },
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

const AGENT_READY = { type: "agent_info", agent: { agent: "claude", agent_status: "working", interactive_ready: true, launch_pending: false } };
const SHELL_READY = { type: "pane_process_info", process_info: { shell_pid: 123, foreground_process_group_id: 123, foreground_processes: [{ pid: 123, name: "zsh" }] } };

describe("startAgent against a live socket", () => {
  test("agent answers use the agent-aware raw key endpoint", async () => {
    const fake = await startFakeHerdr({
      "agent.send_keys": (params) => ({ type: "agent_keys_sent", ...params }),
    });
    try {
      const workspaces = createHerdrWorkspaces({ socketPath: fake.path });
      await workspaces.sendAgentKeys("builder-sta-1", ["y"]);
      expect(fake.calls[0]).toEqual({ method: "agent.send_keys", params: { target: "builder-sta-1", keys: ["y"] } });
    } finally {
      await fake.stop();
    }
  });

  test("native worktree open sends path-only with explicit repository cwd", async () => {
    const fake = await startFakeHerdr({
      "worktree.open": (params) => {
        if ("branch" in params || params.path !== "/repo/.igniter/runtime/worktrees/sta-1" || params.cwd !== "/repo") {
          throw new Error("worktree.open requires path-only with repository cwd");
        }
        return { type: "worktree_opened", already_open: false, workspace: { workspace_id: "ws-1" }, root_pane: { pane_id: "pane-1" } };
      },
    });
    try {
      const workspaces = createHerdrWorkspaces({ socketPath: fake.path });
      await expect(workspaces.worktreeOpen({ repoRoot: "/repo", path: "/repo/.igniter/runtime/worktrees/sta-1", label: "STA-1" })).resolves.toEqual({ workspaceId: "ws-1", rootPaneId: "pane-1" });
      expect(fake.calls.find((call) => call.method === "worktree.open")?.params).toEqual({ cwd: "/repo", path: "/repo/.igniter/runtime/worktrees/sta-1", label: "STA-1", focus: false, trust_repository: true });
    } finally {
      await fake.stop();
    }
  });

  test("unsets secrets, launches, names the detected agent, then returns when ready", async () => {
    const fake = await startFakeHerdr({
      "pane.process_info": (_params, index) => index === 0
        ? { type: "pane_process_info", process_info: { shell_pid: null, foreground_processes: [] } }
        : SHELL_READY,
      "pane.send_input": () => ({ type: "ok" }),
      "agent.get": (params) => params.target === "pane-1" ? AGENT_READY : { type: "agent_info" },
      "agent.rename": () => ({ type: "ok" }),
    });
    try {
      const workspaces = createHerdrWorkspaces({ socketPath: fake.path });
      await workspaces.startAgent({ paneId: "pane-1", name: "deliverer-sta-1", command: "claude --dangerously-skip-permissions" });
      expect(fake.calls[0]).toEqual({ method: "pane.process_info", params: { pane_id: "pane-1" } });
      expect(fake.calls[1]).toEqual({ method: "pane.process_info", params: { pane_id: "pane-1" } });
      expect(fake.calls[2]).toEqual({
        method: "pane.send_input",
        params: {
          pane_id: "pane-1",
          text: "unset LINEAR_API_KEY RESEND_API_KEY FAL_API_KEY",
          keys: ["Enter"],
        },
      });
      expect(fake.calls[3]).toEqual({ method: "pane.send_input", params: { pane_id: "pane-1", text: "claude --dangerously-skip-permissions", keys: ["Enter"] } });
      expect(fake.calls.find((c) => c.method === "agent.get")?.params).toEqual({ target: "pane-1" });
      expect(fake.calls.at(-1)).toEqual({ method: "agent.rename", params: { target: "pane-1", name: "deliverer-sta-1" } });
    } finally {
      await fake.stop();
    }
  });

  test("a command-send error throws", async () => {
    const fake = await startFakeHerdr({
      "pane.process_info": () => SHELL_READY,
      "pane.send_input": (_params, index) => { if (index === 1) throw new Error("command rejected"); return { type: "ok" }; },
    });
    try {
      const workspaces = createHerdrWorkspaces({ socketPath: fake.path });
      await expect(
        workspaces.startAgent({ paneId: "pane-1", name: "x", command: "broken" }),
      ).rejects.toThrow("command rejected");
      expect(fake.calls.filter((c) => c.method === "pane.send_input")).toHaveLength(2);
    } finally {
      await fake.stop();
    }
  });

  test("does not type a launch into a foreground command or an unobservable shell", async () => {
    let inspections = 0;
    const fake = await startFakeHerdr({
      "pane.process_info": () => {
        inspections++;
        if (inspections === 1) return { process_info: { shell_pid: 123, foreground_processes: [] } };
        if (inspections === 2) return { process_info: { shell_pid: 123, foreground_process_group_id: 123, foreground_processes: [{ pid: 123, name: "vim" }] } };
        return SHELL_READY;
      },
      "pane.send_input": () => {
        expect(inspections).toBe(3);
        return { type: "ok" };
      },
      "agent.get": () => AGENT_READY,
      "agent.rename": () => ({ type: "ok" }),
    });
    try {
      await createHerdrWorkspaces({ socketPath: fake.path }).startAgent({ paneId: "pane-1", name: "builder", command: "opencode2 mini" });
      expect(inspections).toBe(3);
    } finally {
      await fake.stop();
    }
  });

  test("waits for interactive_ready past launch_pending before returning", async () => {
    let gets = 0;
    const fake = await startFakeHerdr({
      "pane.process_info": () => SHELL_READY,
      "pane.send_input": () => ({ type: "ok" }),
      "agent.get": (params) => {
        if (params.target !== "pane-1") throw new Error("expected pane target");
        gets += 1;
        return gets === 1
          ? { type: "agent_info", agent: { agent: "claude", agent_status: "working", interactive_ready: false, launch_pending: true } }
          : AGENT_READY;
      },
      "agent.rename": () => ({ type: "ok" }),
    });
    try {
      const workspaces = createHerdrWorkspaces({ socketPath: fake.path });
      await workspaces.startAgent({ paneId: "pane-1", name: "deliverer-sta-1", command: "claude" });
      expect(gets).toBe(2);
      expect(fake.calls.filter((c) => c.method === "agent.rename")).toHaveLength(1);
      expect(fake.calls.findIndex((call) => call.method === "agent.rename")).toBeLessThan(
        fake.calls.findIndex((call, index) => call.method === "agent.get" && index > fake.calls.findIndex((item) => item.method === "agent.get")),
      );
    } finally {
      await fake.stop();
    }
  });

  test("names a recognized agent before failing blocked startup", async () => {
    let availableName: string | undefined;
    const fake = await startFakeHerdr({
      "pane.process_info": () => SHELL_READY,
      "pane.send_input": () => ({ type: "ok" }),
      "agent.get": () => ({ type: "agent_info", agent: { agent: "claude", agent_status: "blocked", interactive_ready: false, launch_pending: false } }),
      "agent.rename": (params) => {
        availableName = String(params.name);
        return { type: "ok" };
      },
    });
    try {
      const workspaces = createHerdrWorkspaces({ socketPath: fake.path });
      await expect(workspaces.startAgent({ paneId: "pane-1", name: "builder-sta-1", command: "claude" }))
        .rejects.toThrow("blocked during startup");
      expect(availableName).toBe("builder-sta-1");
      expect(fake.calls.filter((call) => call.method === "agent.rename")).toHaveLength(1);
      expect(fake.calls.at(-1)).toEqual({ method: "agent.rename", params: { target: "pane-1", name: "builder-sta-1" } });
    } finally {
      await fake.stop();
    }
  });
});

describe("worker metadata records", () => {
  test("long multiline profile and restart values survive Herdr truncation and a new client", async () => {
    const recordDir = await mkdtemp(join(tmpdir(), "igniter-records-"));
    const tokens: Record<string, string> = {};
    const fake = await startFakeHerdr({
      "workspace.report_metadata": (params) => {
        const patch = params.tokens as Record<string, string | null>;
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete tokens[key];
          else tokens[key] = value.slice(0, 80);
        }
        return { type: "workspace_metadata_reported" };
      },
      "session.snapshot": () => ({
        snapshot: {
          workspaces: [{ workspace_id: "ws-1", label: "STA-1", tokens: { ...tokens } }],
          agents: [],
          panes: [],
        },
      }),
    });
    try {
      const profile = JSON.stringify({ command: "claude --model sonnet\n--dangerously-skip-permissions", prompt: "line one\nline two" });
      const restart = JSON.stringify({ command: `custom --option ${"x".repeat(300)}`, startedAt: "2026-09-28" });
      const firstClient = createHerdrWorkspaces({ socketPath: fake.path, recordDir });
      await firstClient.reportMetadata("ws-1", { profile_builder: profile, restart_build: restart });
      expect(tokens.profile_builder).toMatch(/^igniter:[a-f0-9]{64}$/);
      expect(tokens.restart_build).toMatch(/^igniter:[a-f0-9]{64}$/);
      expect(tokens.profile_builder!.length).toBeLessThanOrEqual(80);

      const secondClient = createHerdrWorkspaces({ socketPath: fake.path, recordDir });
      const snapshot = await secondClient.snapshot();
      expect(snapshot.workspaces[0]?.tokens).toMatchObject({ profile_builder: profile, restart_build: restart });
      const reference = tokens.profile_builder!;
      await writeFile(join(recordDir, `${reference.slice("igniter:".length)}.record`), "damaged");
      expect((await secondClient.snapshot()).workspaces[0]?.tokens.profile_builder).toBe(reference);
      await secondClient.reportMetadata("ws-1", { profile_builder: profile });
      expect((await secondClient.snapshot()).workspaces[0]?.tokens.profile_builder).toBe(profile);
    } finally {
      await fake.stop();
      await rm(recordDir, { recursive: true, force: true });
    }
  });

  test("unresolved references stay raw without blocking healthy workspaces and can be cleared", async () => {
    const recordDir = await mkdtemp(join(tmpdir(), "igniter-records-"));
    const tokens: Record<string, string> = { profile_builder: "igniter:" + "a".repeat(64) };
    const fake = await startFakeHerdr({
      "workspace.report_metadata": (params) => {
        const patch = params.tokens as Record<string, string | null>;
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete tokens[key];
          else tokens[key] = value.slice(0, 80);
        }
        return { type: "workspace_metadata_reported" };
      },
      "session.snapshot": () => ({ snapshot: { workspaces: [
        { workspace_id: "ws-1", label: "STA-1", tokens: { ...tokens } },
        { workspace_id: "ws-2", label: "STA-2", tokens: { profile_builder: "healthy profile" } },
      ], agents: [], panes: [] } }),
    });
    try {
      const workspaces = createHerdrWorkspaces({ socketPath: fake.path, recordDir });
      const snapshot = await workspaces.snapshot();
      const reference = tokens.profile_builder!;
      expect(snapshot.workspaces[0]?.tokens.profile_builder).toBe(reference);
      expect(snapshot.workspaces[1]?.tokens.profile_builder).toBe("healthy profile");
      await workspaces.reportMetadata("ws-1", { restart_build: tokens.profile_builder! });
      expect(tokens.restart_build).toBe(reference);
      const digest = "a".repeat(64);
      await writeFile(join(recordDir, `${digest}.record`), "corrupt", "utf8");
      expect((await workspaces.snapshot()).workspaces[0]?.tokens.profile_builder).toBe(reference);
      await workspaces.reportMetadata("ws-1", { profile_builder: null });
      expect(tokens).toEqual({ restart_build: reference });
      expect((await workspaces.snapshot()).workspaces[0]?.tokens).toEqual({ restart_build: reference });
    } finally {
      await fake.stop();
      await rm(recordDir, { recursive: true, force: true });
    }
  });
});
