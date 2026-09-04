// "Is this ticket running?" is a question for Herdr, not for comment
// ordering on a Linear issue: one factory host, workspaces on this machine.
// The snapshot already carries everything needed — agent sessions are named
// `commander|builder|reviewer-<ticket>` (KICKSTART) and workspace tokens may
// carry the identifier too (STA-162 owns that half and can extend matching
// here without touching the dispatch loop).

import { createHerdrSocket } from "../herdr/socket.ts";
import { lookupSocketPath } from "../herdr/socket-path.ts";

export interface RunningWorkspaces {
  runningTickets(): Promise<Set<string>>;
}

export const NoWorkspaces: RunningWorkspaces = {
  runningTickets: async () => new Set<string>(),
};

export interface WorkspaceListing {
  agents?: { name?: string | null }[];
  workspaces?: { tokens?: Record<string, string | null> }[];
}

const AGENT_NAME = /^(?:commander|builder|reviewer)-([A-Z]{2,}-\d+)$/;
const TICKET_TOKEN = /^[A-Z]{2,}-\d+$/;

export function extractRunningTickets(snapshot: WorkspaceListing): Set<string> {
  const tickets = new Set<string>();
  for (const agent of snapshot.agents ?? []) {
    const match = typeof agent.name === "string" ? AGENT_NAME.exec(agent.name) : null;
    if (match?.[1]) tickets.add(match[1]);
  }
  for (const workspace of snapshot.workspaces ?? []) {
    for (const value of Object.values(workspace.tokens ?? {})) {
      if (typeof value === "string" && TICKET_TOKEN.test(value)) tickets.add(value);
    }
  }
  return tickets;
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
export function createHerdrWorkspaces(options: HerdrWorkspacesOptions = {}): RunningWorkspaces {
  const timeoutMs = options.timeoutMs ?? 5000;
  const path = createSocketPathCache({
    socketPath: options.socketPath,
    timeoutMs,
    runStatus: options.runStatus,
    env: options.env,
  });
  return {
    runningTickets: async () => {
      const socketPath = await path();
      const socket = createHerdrSocket({ socketPath });
      try {
        const result = await withTimeout(
          socket.call("session.snapshot", {}),
          timeoutMs,
          "herdr session.snapshot timed out",
        );
        return extractRunningTickets(result.snapshot);
      } finally {
        socket.close();
      }
    },
  };
}
