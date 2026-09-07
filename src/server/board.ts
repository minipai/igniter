// Board snapshot: the dispatch's own viewpoint for the web page.
//
// Joins dispatch state (status rows, queue, activity tail, Commander rules)
// with Herdr (workspace tokens plus the three agent panes per ticket) into
// one JSON document for GET /api/board. Pane output is read through a small
// throttled cache so one output event storm cannot flood the socket with
// pane.read calls. Everything here degrades: Herdr unreachable marks panes
// unavailable, missing dispatch data renders empty, nothing throws.

import type { DecisionLog, QueueEntry } from "../dispatch/claims.ts";
import { commanderAssetPaths } from "../commander/assets.ts";
import { formatDuration, type StatusData } from "../dispatch/commands.ts";
import type { CommandWorkspaces, WorkspaceSnapshot } from "../dispatch/workspaces.ts";
import type { HerdrSocket } from "../herdr/socket.ts";
import { lookupSocketPath } from "../herdr/socket-path.ts";
import { createHerdrSocket } from "../herdr/socket.ts";

/** Absolute path of the bundled Commander rules shown by the Workflow view.
 *  Derived from the running Igniter module, never the target repository. */
export const COMMANDER_RULES_PATH = commanderAssetPaths().rules;

export async function readRulesText(): Promise<string> {
  try {
    return await Bun.file(COMMANDER_RULES_PATH).text();
  } catch {
    return "";
  }
}

/** Agent pane as the board shows it. agentStatus is the Herdr status, plus
 *  "notstarted" (no reviewer agent yet), "missing" (agent gone), and
 *  "unavailable" (Herdr unreachable or the read failed). */
export interface BoardPane {
  name: string;
  kind: string | null;
  agentStatus: string;
  lastOutputAt: string | null;
  lastLine: string;
  /** Recent output tail (up to the cached read size) for the enlarged pane. */
  text: string;
  paneId: string | null;
}

export interface BoardTicketPanes {
  commander: BoardPane;
  builder: BoardPane;
  reviewer: BoardPane;
}

/** One rail row + stage view. block is the only thing that needs a person:
 *  "approval" (a pane is blocked) wins over "quiet" (stalled=1). */
export interface BoardTicket {
  identifier: string;
  title: string;
  state: string;
  workspaceId: string | null;
  elapsedMs: number | null;
  budgetMs: number;
  /** ok: under 80% of budget; near: past 80%; over: past budget. */
  level: "ok" | "near" | "over";
  stage: string | null;
  stageAgeMs: number | null;
  stalled: boolean;
  paused: boolean;
  block: "approval" | "quiet" | null;
  /** Rail sort key group: reply (needs a person) → stalled → alive. */
  railState: "reply" | "stalled" | "alive";
  pulse: string;
  panes: BoardTicketPanes;
}

export interface BoardSnapshot {
  host: string;
  usedSlots: number;
  maxRunning: number;
  linearOrg: string;
  lastRefreshAt: string | null;
  needsYou: number;
  queue: QueueEntry[];
  activity: string[];
  rules: string;
  tickets: BoardTicket[];
}

export interface PaneOutput {
  text: string;
  at: string | null;
}

export interface BoardInputs {
  status: StatusData;
  /** Null when Herdr is unreachable: every pane renders unavailable. */
  snapshot: WorkspaceSnapshot | null;
  queue: QueueEntry[];
  activity: string[];
  rules: string;
  host: string;
  linearOrg: string;
  /** Commander harness from the resolved configuration: no per-ticket
   *  Commander is stored in workspace metadata. */
  commanderKind: string;
  outputs: Map<string, PaneOutput>;
  now?: () => number;
}

function agentName(role: string, identifier: string): string {
  return `${role}-${identifier.toLowerCase()}`;
}

/** Last non-empty line of pane output, capped for the rail and peek rows. */
export function lastLineOf(text: string): string {
  const lines = text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() !== "");
  const last = lines[lines.length - 1] ?? "";
  return last.length > 160 ? last.slice(0, 160) : last;
}

function ageText(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "?";
  return formatDuration(ms);
}

interface PaneLookup {
  agentStatus: string;
  paneId: string;
}

function lookupAgent(snapshot: WorkspaceSnapshot | null, name: string): PaneLookup | null {
  const agent = snapshot?.agents.find((a) => a.name === name);
  if (!agent) return null;
  return { agentStatus: agent.agentStatus, paneId: agent.paneId };
}

function toBoardPane(input: {
  name: string;
  kind: string | null;
  found: PaneLookup | null;
  snapshot: WorkspaceSnapshot | null;
  outputs: Map<string, PaneOutput>;
}): BoardPane {
  if (!input.snapshot) {
    return { name: input.name, kind: input.kind, agentStatus: "unavailable", lastOutputAt: null, lastLine: "", text: "", paneId: null };
  }
  if (!input.found) {
    return { name: input.name, kind: input.kind, agentStatus: "notstarted", lastOutputAt: null, lastLine: "", text: "", paneId: null };
  }
  const output = input.outputs.get(input.found.paneId);
  const text = output?.text ?? "";
  return {
    name: input.name,
    kind: input.kind,
    agentStatus: input.found.agentStatus,
    lastOutputAt: output?.at ?? null,
    lastLine: lastLineOf(text),
    text,
    paneId: input.found.paneId,
  };
}

export function buildBoardSnapshot(inputs: BoardInputs): BoardSnapshot {
  const now = inputs.now?.() ?? Date.now();
  const { snapshot } = inputs;
  const tickets: BoardTicket[] = [];

  for (const row of inputs.status.tickets) {
    if (!row.hasWorkspace) continue;
    const workspace = snapshot?.workspaces.find(
      (w) => w.label === row.identifier || w.tokens["ticket"] === row.identifier,
    );
    const tokens = workspace?.tokens ?? {};
    const commanderFound = lookupAgent(snapshot, agentName("commander", row.identifier));
    const builderFound = lookupAgent(snapshot, agentName("builder", row.identifier));
    const reviewerFound = lookupAgent(snapshot, agentName("reviewer", row.identifier));
    const panes: BoardTicketPanes = {
      commander: toBoardPane({
        name: agentName("commander", row.identifier),
        kind: inputs.commanderKind,
        found: commanderFound,
        snapshot,
        outputs: inputs.outputs,
      }),
      builder: toBoardPane({
        name: agentName("builder", row.identifier),
        kind: tokens["builder"] ?? null,
        found: builderFound,
        snapshot,
        outputs: inputs.outputs,
      }),
      reviewer: toBoardPane({
        name: agentName("reviewer", row.identifier),
        kind: null,
        found: reviewerFound,
        snapshot,
        outputs: inputs.outputs,
      }),
    };

    const blocked = [panes.commander, panes.builder, panes.reviewer].some((p) => p.agentStatus === "blocked");
    const block: BoardTicket["block"] = blocked ? "approval" : row.stalled ? "quiet" : null;
    const railState: BoardTicket["railState"] = blocked ? "reply" : row.stalled ? "stalled" : "alive";

    const level: BoardTicket["level"] = row.over
      ? "over"
      : row.elapsedMs !== null && row.elapsedMs > row.budgetMs * 0.8
        ? "near"
        : "ok";

    const stageMs = row.stageAt ? Date.parse(row.stageAt) : NaN;
    const stageAgeMs = Number.isFinite(stageMs) ? Math.max(0, now - stageMs) : null;
    const commanderMs = panes.commander.lastOutputAt ? Date.parse(panes.commander.lastOutputAt) : NaN;
    const commanderAgeMs = Number.isFinite(commanderMs) ? Math.max(0, now - commanderMs) : null;

    const pulse = railState === "reply"
      ? `waiting on you · ${ageText(commanderAgeMs ?? stageAgeMs)}`
      : railState === "stalled"
        ? `quiet ${ageText(stageAgeMs)}`
        : `alive · output ${ageText(commanderAgeMs ?? stageAgeMs)} ago`;

    tickets.push({
      identifier: row.identifier,
      title: row.title,
      state: row.state,
      workspaceId: workspace?.workspaceId ?? null,
      elapsedMs: row.elapsedMs,
      budgetMs: row.budgetMs,
      level,
      stage: row.stage,
      stageAgeMs,
      stalled: row.stalled,
      paused: row.paused,
      block,
      railState,
      pulse,
      panes,
    });
  }

  const rank = (state: BoardTicket["railState"]): number =>
    state === "reply" ? 0 : state === "stalled" ? 1 : 2;
  tickets.sort((a, b) => rank(a.railState) - rank(b.railState) || (a.identifier < b.identifier ? -1 : 1));

  return {
    host: inputs.host,
    usedSlots: inputs.status.slots.used,
    maxRunning: inputs.status.slots.max,
    linearOrg: inputs.linearOrg,
    lastRefreshAt: inputs.status.lastPollAt,
    needsYou: tickets.filter((t) => t.block === "approval").length,
    queue: inputs.queue,
    activity: inputs.activity,
    rules: inputs.rules,
    tickets,
  };
}

// ---------------------------------------------------------------------------
// In-process event hub: the SSE layer re-broadcasts these compactly.
// ---------------------------------------------------------------------------

export interface BoardEvent {
  type: string;
  data: unknown;
}

export function createBoardHub() {
  const listeners = new Set<(event: BoardEvent) => void>();
  return {
    emit(type: string, data: unknown = {}): void {
      for (const listener of [...listeners]) listener({ type, data });
    },
    subscribe(listener: (event: BoardEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get size(): number {
      return listeners.size;
    },
  };
}

export type BoardHub = ReturnType<typeof createBoardHub>;

// ---------------------------------------------------------------------------
// Pane output cache: at most one pane.read per pane per second.
// ---------------------------------------------------------------------------

export interface PaneOutputCache {
  /** Cached outputs keyed by pane id, for the snapshot builder. */
  outputs: Map<string, PaneOutput>;
  /** Refresh one pane through Herdr unless read within the last second. */
  refresh(paneId: string): Promise<PaneOutput>;
  /** Stamp a pane's last-output time from a pane_output_changed event. */
  note(paneId: string, at: string): void;
}

export function createPaneOutputCache(options: {
  workspaces: Pick<CommandWorkspaces, "readPane">;
  now?: () => number;
  readLines?: number;
}): PaneOutputCache {
  const outputs = new Map<string, PaneOutput>();
  const lastReadAt = new Map<string, number>();
  const revisions = new Map<string, number | null>();
  const now = options.now ?? Date.now;
  const lines = options.readLines ?? 30;
  return {
    outputs,
    async refresh(paneId: string): Promise<PaneOutput> {
      const at = now();
      if (at - (lastReadAt.get(paneId) ?? 0) < 1000) {
        return outputs.get(paneId) ?? { text: "", at: null };
      }
      lastReadAt.set(paneId, at);
      try {
        const read = await options.workspaces.readPane(paneId, lines);
        const previous = outputs.get(paneId);
        let changed: boolean;
        if (!revisions.has(paneId)) {
          changed = false;
        } else {
          // The installed Herdr reports revision 0 on every read, so a
          // revision is only a signal when it actually advances; the text
          // comparison below is what catches output in practice.
          const prevRevision = revisions.get(paneId);
          const advanced =
            read.revision !== null && prevRevision !== null && read.revision !== prevRevision;
          changed = advanced || read.text !== (previous?.text ?? "");
        }
        revisions.set(paneId, read.revision);
        // First sighting carries no timing: only an advancing revision or
        // changed text proves fresh output.
        const entry = { text: read.text, at: changed ? new Date(at).toISOString() : (previous?.at ?? null) };
        outputs.set(paneId, entry);
        return entry;
      } catch {
        return outputs.get(paneId) ?? { text: "", at: null };
      }
    },
    note(paneId: string, stamp: string): void {
      const cached = outputs.get(paneId);
      outputs.set(paneId, { text: cached?.text ?? "", at: stamp });
    },
  };
}

// ---------------------------------------------------------------------------
// Herdr subscription: one long-lived connection, calls stay on fresh ones.
// ---------------------------------------------------------------------------

/**
 * Subscription kinds for the board monitor. Every entry here takes no
 * params, so one global subscription covers all workspaces. Verified against
 * the installed Herdr (protocol 20):
 * - `events.subscribe` NEVER streams `pane_output_changed`; it is only
 *   reachable via the one-shot `events.wait`. The monitor treats output
 *   events as opportunistic and stamps last-output time from read revisions
 *   instead (see createPaneOutputCache).
 * - `pane_updated` DOES stream and carries agent_status changes
 *   (`data.pane.{pane_id, workspace_id, agent_status, revision}`), so it is
 *   the live-push path for the rail order and the block bar. There is
 *   deliberately no `pane.agent_status_changed` entry: it requires a pane_id
 *   param, so a param-less subscription to it would be useless.
 */
export const BOARD_SUBSCRIPTIONS = [
  { type: "workspace.metadata_updated" },
  { type: "workspace.updated" },
  { type: "pane.exited" },
  { type: "pane.updated" },
  { type: "pane.created" },
  { type: "pane.closed" },
] as const;

export interface BoardMonitorCallbacks {
  onEvent: (event: { event: string; data: unknown }) => void;
  onResync: () => void;
}

export function startBoardMonitor(options: {
  hub: BoardHub;
  outputs: PaneOutputCache;
  subscribe: (
    subscriptions: readonly { type: string }[],
    callbacks: BoardMonitorCallbacks,
  ) => () => void;
  now?: () => number;
  retryMs?: number;
}): { stop: () => void } {
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? 10_000;
  let stopped = false;
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function paneIdOf(data: unknown): string | null {
    if (data !== null && typeof data === "object") {
      const nested = (data as { pane?: unknown }).pane;
      if (nested !== null && typeof nested === "object" && typeof (nested as { pane_id?: unknown }).pane_id === "string") {
        return (nested as { pane_id: string }).pane_id;
      }
      if (typeof (data as { pane_id?: unknown }).pane_id === "string") {
        return (data as { pane_id: string }).pane_id;
      }
    }
    return null;
  }

  function workspaceIdOf(data: unknown): string | null {
    if (data !== null && typeof data === "object" && typeof (data as { workspace_id?: unknown }).workspace_id === "string") {
      return (data as { workspace_id: string }).workspace_id;
    }
    return null;
  }

  function onEvent(event: { event: string; data: unknown }): void {
    if (stopped) return;
    // Streamed frames use underscores (pane_agent_status_changed); the
    // subscription table names the same kinds with dots.
    const name = event.event.replace(/\./g, "_");
    if (name === "pane_output_changed") {
      const paneId = paneIdOf(event.data);
      if (paneId) {
        options.outputs.note(paneId, new Date(now()).toISOString());
        options.hub.emit("pane", { paneId });
      }
      return;
    }
    if (name === "pane_agent_status_changed" || name === "pane_exited") {
      options.hub.emit("pane", { paneId: paneIdOf(event.data) });
      return;
    }
    if (name === "pane_updated" || name === "pane_created" || name === "pane_closed") {
      const paneId = paneIdOf(event.data);
      if (paneId) {
        const nested = (event.data as { pane?: unknown }).pane;
        const agentStatus = nested !== null && typeof nested === "object"
          ? (nested as { agent_status?: unknown }).agent_status ?? null
          : null;
        options.hub.emit("pane", { paneId, agentStatus });
      } else {
        // Pane frames always name the pane, but never drop a workspace
        // reference when they do not.
        options.hub.emit("workspace", { workspaceId: workspaceIdOf(event.data) });
      }
      return;
    }
    if (name === "workspace_metadata_updated" || name === "workspace_updated") {
      options.hub.emit("workspace", { workspaceId: workspaceIdOf(event.data) });
      return;
    }
  }

  function connect(): void {
    if (stopped) return;
    try {
      unsubscribe = options.subscribe(BOARD_SUBSCRIPTIONS, {
        onEvent,
        onResync: () => {
          if (!stopped) options.hub.emit("resync", {});
        },
      });
    } catch {
      // Herdr down: retry without crashing the serve process.
      if (!stopped) {
        timer = setTimeout(connect, retryMs);
      }
    }
  }

  connect();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

/** Decisions print and append as usual, and also reach SSE subscribers. */
export function withBoardEvents(log: DecisionLog, hub: BoardHub): DecisionLog {
  return {
    record: async (ticket, message) => {
      await log.record(ticket, message);
      hub.emit("decision", { ticket, message });
    },
  };
}

/** Production subscribe: one long-lived connection on the Herdr socket. */
export function createHerdrBoardSubscription(socket: HerdrSocket) {
  return (
    subscriptions: readonly { type: string }[],
    callbacks: BoardMonitorCallbacks,
  ): (() => void) => socket.subscribe(
    subscriptions as Parameters<HerdrSocket["subscribe"]>[0],
    {
      onEvent: (event) => callbacks.onEvent({ event: event.event, data: event.data }),
      onResync: () => callbacks.onResync(),
    },
  );
}

/**
 * Background Herdr feed for the serve process: looks the socket path up,
 * opens one long-lived subscription, and retries without ever crashing the
 * server when Herdr is down. The socket layer reconnects internally once
 * the first subscription succeeds.
 */
export function startHerdrBoardFeed(options: {
  hub: BoardHub;
  outputs: PaneOutputCache;
  lookupPath?: () => Promise<string>;
  openSocket?: (socketPath: string) => { subscribe: HerdrSocket["subscribe"]; close: () => void };
  retryMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
}): { stop: () => void } {
  const lookupPath = options.lookupPath ?? lookupSocketPath;
  const openSocket = options.openSocket ?? ((socketPath: string) => createHerdrSocket({ socketPath }));
  const retryMs = options.retryMs ?? 10_000;
  const sleep = options.sleep ?? Bun.sleep;
  let stopped = false;
  let monitor: { stop: () => void } | null = null;
  let socket: { close: () => void } | null = null;
  void (async () => {
    while (!stopped) {
      try {
        const socketPath = await lookupPath();
        if (stopped) return;
        socket = openSocket(socketPath);
        monitor = startBoardMonitor({
          hub: options.hub,
          outputs: options.outputs,
          subscribe: createHerdrBoardSubscription(socket as HerdrSocket),
        });
        return;
      } catch {
        if (stopped) return;
        await sleep(retryMs);
      }
    }
  })();
  return {
    stop: () => {
      stopped = true;
      monitor?.stop();
      socket?.close();
    },
  };
}
