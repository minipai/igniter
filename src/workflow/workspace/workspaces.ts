// "Is this ticket running?" is a question for Herdr, not for comment
// ordering on a Linear issue: one factory host, workspaces on this machine.
// The snapshot already carries everything needed — agent sessions are named
// `commander|builder|reviewer-<ticket>` (lowercased) and workspace tokens
// may carry the identifier too.

import { createHerdrSocket } from "../../herdr/client/socket.ts";
import { lookupSocketPath } from "../../herdr/client/socket-path.ts";

export interface RunningWorkspaces {
  runningTickets(): Promise<Set<string>>;
}

/** One workspace as the dispatch commands see it: label plus igniter tokens. */
export interface SnapshotWorkspace {
  workspaceId: string;
  label: string;
  tokens: Record<string, string>;
}

export interface SnapshotAgent {
  name: string;
  agentStatus: string;
  workspaceId: string;
  paneId: string;
  /** The Herdr agent session value behind this agent; null when unreported. */
  session: string | null;
  /** The Herdr output revision behind this agent; null when unreported. */
  revision: number | null;
}

export interface SnapshotPane {
  paneId: string;
  workspaceId: string;
}

/** One `session.snapshot` call, shaped for the dispatch commands. */
export interface WorkspaceSnapshot {
  workspaces: SnapshotWorkspace[];
  agents: SnapshotAgent[];
  panes: SnapshotPane[];
}

/**
 * Everything the dispatch commands need from Herdr. Reads go through one
 * snapshot per call site; every method below opens one short-lived socket
 * connection per call.
 */
export interface CommandWorkspaces extends RunningWorkspaces {
  snapshot(): Promise<WorkspaceSnapshot>;
  create(input: { label: string; cwd: string; env: Record<string, string> }): Promise<{
    workspaceId: string;
    rootPaneId: string;
  }>;
  close(workspaceId: string): Promise<void>;
  /** Open a fresh tab in a live workspace for an agent that needs its own pane. */
  createTab(input: { workspaceId: string; cwd?: string; title?: string }): Promise<{ tabId: string }>;
  startAgent(input: { paneId: string; kind: string; name: string; args?: string[] }): Promise<void>;
  prompt(agentName: string, text: string): Promise<void>;
  /** Close the worker pane to terminate its process; preserve the checkout. */
  stopAgent?(agentName: string): Promise<void>;
  /** Send raw keys (e.g. y/n answers) straight to a pane. */
  sendKeys(paneId: string, keys: string[]): Promise<void>;
  readPane(paneId: string, lines: number): Promise<PaneRead>;
  reportMetadata(workspaceId: string, tokens: Record<string, string | null>): Promise<void>;
  agentKinds(): Promise<string[]>;
}

/** Recent pane output with the output revision that produced it. A null
 *  revision means the backend did not report one; compare text instead. */
export interface PaneRead {
  text: string;
  revision: number | null;
}

export const NoWorkspaces: CommandWorkspaces = {
  runningTickets: async () => new Set<string>(),
  snapshot: async () => ({ workspaces: [], agents: [], panes: [] }),
  create: async () => {
    throw new Error("herdr is not wired: cannot open a workspace");
  },
  close: async () => {
    throw new Error("herdr is not wired: cannot close a workspace");
  },
  createTab: async () => {
    throw new Error("herdr is not wired: cannot open a tab");
  },
  startAgent: async () => {
    throw new Error("herdr is not wired: cannot start an agent");
  },
  prompt: async () => {
    throw new Error("herdr is not wired: cannot prompt an agent");
  },
  sendKeys: async () => {
    throw new Error("herdr is not wired: cannot send keys to a pane");
  },
  readPane: async () => {
    throw new Error("herdr is not wired: cannot read a pane");
  },
  reportMetadata: async () => {
    throw new Error("herdr is not wired: cannot report metadata");
  },
  agentKinds: async () => [...KNOWN_AGENT_KINDS],
};

export interface WorkspaceListing {
  agents?: { name?: string | null }[];
  workspaces?: { tokens?: Record<string, string | null> }[];
}

const AGENT_NAME = /^(?:builder|reviewer|deliverer)-([a-z]{2,}-\d+)$/i;
const TICKET_TOKEN = /^[A-Z]{2,}-\d+$/;

/** The Build worker for a ticket's current stage. */
export function builderName(identifier: string): string {
  return `builder-${identifier.toLowerCase()}`;
}

/** The Acceptance worker beside a ticket's stage. */
export function reviewerName(identifier: string): string {
  return `reviewer-${identifier.toLowerCase()}`;
}

/** The Deliver worker for a ticket's current stage. */
export function delivererName(identifier: string): string {
  return `deliverer-${identifier.toLowerCase()}`;
}

export type StageWorkerStage = "build" | "review" | "deliver";

/** The stage worker name for one stage: builder/reviewer/deliverer-<ticket>. */
export function stageWorkerName(stage: StageWorkerStage, identifier: string): string {
  if (stage === "build") return builderName(identifier);
  if (stage === "review") return reviewerName(identifier);
  return delivererName(identifier);
}

export function ticketFromAgentName(name: string): string | null {
  const match = AGENT_NAME.exec(name);
  return match?.[1] ? match[1].toUpperCase() : null;
}

export function extractRunningTickets(snapshot: WorkspaceListing): Set<string> {
  const tickets = new Set<string>();
  for (const agent of snapshot.agents ?? []) {
    const ticket = typeof agent.name === "string" ? ticketFromAgentName(agent.name) : null;
    if (ticket) tickets.add(ticket);
  }
  for (const workspace of snapshot.workspaces ?? []) {
    for (const value of Object.values(workspace.tokens ?? {})) {
      if (typeof value === "string" && TICKET_TOKEN.test(value)) tickets.add(value);
    }
  }
  return tickets;
}

/**
 * Per-ticket igniter tokens from one snapshot: the workspace whose label is
 * the ticket as written, or whose tokens name it, wins. Commands read this
 * metadata without a second socket round trip.
 */
export function tokensByTicket(snapshot: WorkspaceSnapshot): Map<string, Record<string, string>> {
  const byTicket = new Map<string, Record<string, string>>();
  for (const workspace of snapshot.workspaces) {
    const ticket = workspace.tokens["ticket"];
    if (ticket && TICKET_TOKEN.test(ticket) && !byTicket.has(ticket)) {
      byTicket.set(ticket, workspace.tokens);
    }
    if (TICKET_TOKEN.test(workspace.label) && !byTicket.has(workspace.label)) {
      byTicket.set(workspace.label, workspace.tokens);
    }
  }
  for (const agent of snapshot.agents) {
    const ticket = ticketFromAgentName(agent.name);
    if (ticket && !byTicket.has(ticket)) {
      const workspace = snapshot.workspaces.find((w) => w.workspaceId === agent.workspaceId);
      byTicket.set(ticket, workspace?.tokens ?? {});
    }
  }
  return byTicket;
}

/** Tickets whose workspace metadata carries `over_budget=1`. */
export function overBudgetTickets(snapshot: WorkspaceSnapshot): Set<string> {
  const overBudget = new Set<string>();
  for (const [ticket, tokens] of tokensByTicket(snapshot)) {
    if (tokens["over_budget"] === "1") overBudget.add(ticket);
  }
  return overBudget;
}

/** The open workspace behind a ticket: label or ticket token, whichever matches first. */
export function workspaceForTicket(
  snapshot: WorkspaceSnapshot,
  identifier: string,
): SnapshotWorkspace | undefined {
  return snapshot.workspaces.find(
    (w) => w.label === identifier || w.tokens["ticket"] === identifier,
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface HerdrWorkspacesOptions {
  socketPath?: string;
  timeoutMs?: number;
  runStatus?: () => Promise<string>;
  env?: Record<string, string | undefined>;
}

/** Igniter agents never inherit these real provider credentials. */
export const AGENT_SECRET_NAMES = ["LINEAR_API_KEY", "RESEND_API_KEY", "FAL_API_KEY"] as const;

/** The socket path resolves once and is cached; only a failure retries. */
export function createSocketPathCache(options: {
  socketPath?: string;
  timeoutMs: number;
  runStatus?: () => Promise<string>;
  env?: Record<string, string | undefined>;
}): () => Promise<string> {
  let cached = options.socketPath;
  return async () => {
    if (cached === undefined) {
      cached = await withTimeout(
        lookupSocketPath({
          ...(options.env ? { env: options.env } : {}),
          runStatus: options.runStatus ?? (() => runHerdrStatus(options.timeoutMs)),
        }),
        options.timeoutMs,
        "herdr socket lookup timed out",
      );
    }
    return cached;
  };
}

/** Async `herdr status` that can actually time out, unlike the spawnSync default. */
async function runHerdrStatus(timeoutMs: number): Promise<string> {
  const proc = Bun.spawn(["herdr", "status"], { stdout: "pipe", stderr: "pipe" });
  const done = (async () => {
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) throw new Error(`herdr status exited with ${code}`);
    return out;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill();
      reject(new Error("herdr status timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([done, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Live Herdr answer, one short-lived connection per call. A missing daemon,
 * a slow snapshot, or a dead socket throws, and the caller treats that as
 * "assume present" — adoption waits instead of opening duplicate workspaces.
 */
export function createHerdrWorkspaces(options: HerdrWorkspacesOptions = {}): CommandWorkspaces {
  const timeoutMs = options.timeoutMs ?? 5000;
  const path = createSocketPathCache({
    socketPath: options.socketPath,
    timeoutMs,
    runStatus: options.runStatus,
    env: options.env,
  });
  async function call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socketPath = await path();
    const socket = createHerdrSocket({ socketPath });
    try {
      return await withTimeout(socket.call(method, params), timeoutMs, `herdr ${method} timed out`);
    } finally {
      socket.close();
    }
  }
  async function waitAgentReady(name: string): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      let ready = false;
      try {
        const got = (await call("agent.get", { target: name })) as {
          agent?: { interactive_ready?: boolean; launch_pending?: boolean };
        };
        ready = got.agent?.interactive_ready === true && got.agent?.launch_pending !== true;
      } catch {
        // The name may not resolve yet right after the start; keep polling
        // until the deadline instead of failing the whole claim on it.
        ready = false;
      }
      if (ready) return;
      if (Date.now() - startedAt >= READY_TIMEOUT_MS) {
        throw new Error(`agent ${name} did not become ready within ${READY_TIMEOUT_MS}ms`);
      }
      await Bun.sleep(READY_POLL_MS);
    }
  }
  return {
    runningTickets: async () => {
      const envelope = (await call("session.snapshot", {})) as {
        snapshot: WorkspaceListing;
      };
      return extractRunningTickets(envelope.snapshot);
    },
    snapshot: async () => shapeSnapshot(await call("session.snapshot", {})),
    create: async (input) => {
      const created = (await call("workspace.create", {
        label: input.label,
        cwd: input.cwd,
        focus: false,
        env: input.env,
      })) as {
        workspace?: { workspace_id?: string };
        root_pane?: { pane_id?: string };
      };
      const workspaceId = created.workspace?.workspace_id;
      const rootPaneId = created.root_pane?.pane_id;
      if (!workspaceId || !rootPaneId) {
        throw new Error("herdr workspace.create answered without a workspace id or root pane");
      }
      return { workspaceId, rootPaneId };
    },
    close: async (workspaceId) => {
      await call("workspace.close", { workspace_id: workspaceId });
    },
    createTab: async (input) => {
      const created = (await call("tab.create", {
        workspace_id: input.workspaceId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.title ? { label: input.title } : {}),
        focus: false,
      })) as {
        tab?: { tab_id?: string };
      };
      const tabId = created.tab?.tab_id;
      if (!tabId) {
        throw new Error("herdr tab.create answered without a tab id");
      }
      return { tabId };
    },
    startAgent: async (input) => {
      await call("pane.send_input", {
        pane_id: input.paneId,
        text: `unset ${AGENT_SECRET_NAMES.join(" ")}`,
        keys: ["Enter"],
      });
      // The root pane's shell needs ~100-300ms after workspace.create; any
      // other error is real and throws at once. The unset above is queued in
      // that same shell, so these retries also wait for it to finish.
      const startedAt = Date.now();
      for (;;) {
        try {
          await call("agent.start", {
            pane_id: input.paneId,
            kind: input.kind,
            name: input.name,
            ...(input.args ? { args: input.args } : {}),
          });
          break;
        } catch (error) {
          const message = (error as Error).message;
          if (!message.includes("is not an available shell") || Date.now() - startedAt >= SHELL_TIMEOUT_MS) {
            throw error;
          }
          await Bun.sleep(SHELL_RETRY_MS);
        }
      }
      // The socket start returns while the agent is still launch_pending;
      // prompting now would fail, so wait the way the herdr CLI does.
      await waitAgentReady(input.name);
    },
    stopAgent: async (agentName) => {
      const snapshot = shapeSnapshot(await call("session.snapshot", {}));
      const agent = snapshot.agents.find((a) => a.name === agentName);
      if (agent) await call("pane.close", { pane_id: agent.paneId });
    },
    prompt: async (agentName, text) => {
      await call("agent.prompt", { target: agentName, text });
    },
    sendKeys: async (paneId, keys) => {
      await call("pane.send_keys", { pane_id: paneId, keys });
    },
    readPane: async (paneId, lines) => {
      const read = (await call("pane.read", {
        pane_id: paneId,
        source: "recent",
        strip_ansi: true,
        lines,
      })) as { read?: { text?: string; revision?: unknown } };
      return {
        text: read.read?.text ?? "",
        revision: typeof read.read?.revision === "number" ? read.read.revision : null,
      };
    },
    reportMetadata: async (workspaceId, tokens) => {
      await call("workspace.report_metadata", {
        workspace_id: workspaceId,
        source: METADATA_SOURCE,
        tokens,
      });
    },
    agentKinds: async () => parseAgentKinds(await call("server.agent_manifests", {})),
  };
}

/** Source stamped on every workspace metadata write igniter owns. */
export const METADATA_SOURCE = "igniter";

/** Shell warm-up after workspace.create: retry agent.start this often… */
const SHELL_RETRY_MS = 250;
/** …for at most this long before the error counts as real. */
const SHELL_TIMEOUT_MS = 10_000;
/** Readiness poll after agent.start returns launch_pending… */
const READY_POLL_MS = 500;
/** …for at most this long before the claim fails. */
const READY_TIMEOUT_MS = 60_000;

/**
 * Known agent kinds from `herdr agent start --help`. The live manifest list
 * wins when Herdr answers; this list is the offline fallback.
 */
export const KNOWN_AGENT_KINDS = [
  "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline",
  "omp", "mastracode", "opencode", "copilot", "kimi", "kiro", "droid",
  "amp", "grok", "hermes", "kilo", "qodercli", "qwen", "maki",
];

function parseAgentKinds(result: unknown): string[] {
  if (result !== null && typeof result === "object" && Array.isArray((result as { manifests?: unknown }).manifests)) {
    const kinds = (result as { manifests: { agent?: unknown }[] }).manifests
      .map((m) => m.agent)
      .filter((agent): agent is string => typeof agent === "string" && agent.length > 0);
    if (kinds.length > 0) return [...new Set(kinds)].sort();
  }
  return [...KNOWN_AGENT_KINDS];
}

function shapeSnapshot(envelope: unknown): WorkspaceSnapshot {
  const snapshot = (envelope as { snapshot?: unknown }).snapshot;
  if (snapshot === null || typeof snapshot !== "object") {
    throw new Error("herdr session.snapshot answered without a snapshot");
  }
  const view = snapshot as {
    workspaces?: { workspace_id?: unknown; label?: unknown; tokens?: unknown }[];
    agents?: { name?: unknown; agent_status?: unknown; workspace_id?: unknown; pane_id?: unknown; agent_session?: unknown; revision?: unknown }[];
    panes?: { pane_id?: unknown; workspace_id?: unknown }[];
  };
  return {
    workspaces: (view.workspaces ?? []).map((w) => ({
      workspaceId: typeof w.workspace_id === "string" ? w.workspace_id : "",
      label: typeof w.label === "string" ? w.label : "",
      tokens: tokensOf(w.tokens),
    })),
    agents: (view.agents ?? []).map((a) => ({
      name: typeof a.name === "string" ? a.name : "",
      agentStatus: typeof a.agent_status === "string" ? a.agent_status : "unknown",
      workspaceId: typeof a.workspace_id === "string" ? a.workspace_id : "",
      paneId: typeof a.pane_id === "string" ? a.pane_id : "",
      session: sessionOf(a.agent_session),
      revision: typeof a.revision === "number" ? a.revision : null,
    })),
    panes: (view.panes ?? []).map((p) => ({
      paneId: typeof p.pane_id === "string" ? p.pane_id : "",
      workspaceId: typeof p.workspace_id === "string" ? p.workspace_id : "",
    })),
  };
}

/** The agent session value behind an agent entry; null when Herdr reports none. */
function sessionOf(session: unknown): string | null {
  if (typeof session === "string") return session === "" ? null : session;
  if (session === null || typeof session !== "object") return null;
  const value = (session as { value?: unknown }).value;
  return typeof value === "string" && value !== "" ? value : null;
}

function tokensOf(tokens: unknown): Record<string, string> {
  if (tokens === null || typeof tokens !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
