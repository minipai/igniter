// Reports Commander stage transitions to the Herdr workspace metadata.
//
// The rules document only names the step (`igniter stage build`); the
// ticket, the source, and the counters live here so the Commander
// cannot mistype them and every behavior below is covered by tests.
//
// - The ticket is resolved from the workspace metadata when present,
//   else from IGNITER_TICKET set by the runner when the run starts. It
//   is written once; later calls carry it through and can never change
//   it, because no subcommand accepts one.
// - review_count is the number of `stage build` calls minus one;
//   verify_count is the number of `stage verify` calls. These reports
//   are not idempotent: report a stage exactly once when entering it.
// - Only igniter-owned keys are written (ticket, stage, the counters,
//   owner_pending, reason, tokens). The snapshot read is a cross-source
//   merged view, so echoing it back would stamp other owners' keys
//   with our source and could breach the 16-keys-per-report cap.
// - `delivered` is never written here; the runner reports it after the
//   owner accepts.
// - A stage report is advisory: lookup and socket work share one
//   deadline, and every failure exits 1 with the socket closed instead
//   of hanging the run.
// - Outside Herdr (HERDR_ENV unset, or no workspace id) the command is
//   a silent no-op and exits 0.

import { join } from "node:path";
import type { HerdrParams, HerdrResults } from "../herdr/herdr-api.js";
import { createHerdrSocket } from "../herdr/socket.ts";
import { lookupSocketPath } from "../herdr/socket-path.ts";

export const STAGE_SOURCE = "igniter";
export const TICKET_ENV = "IGNITER_TICKET";
export const WORKSPACE_ENV = "HERDR_WORKSPACE_ID";
export const HERDR_ENV = "HERDR_ENV";

/** A stage report is advisory: never stall the run past this. */
export const REPORT_TIMEOUT_MS = 10_000;
/** Upper bound for STA-159's usage script; a hung script must not stall the run. */
const USAGE_TIMEOUT_MS = 10_000;

const USAGE_SCRIPT = join("scripts", "opencode-session-usage.sh");

export type StageStep =
  | "plan"
  | "build"
  | "verify"
  | "acceptance"
  | "failed";

const STEPS: StageStep[] = [
  "plan",
  "build",
  "verify",
  "acceptance",
  "failed",
];

type StageCommand = "stage" | "pause" | "resume";

/** Minimal socket surface the stage command needs; the real client satisfies it. */
export interface StageSocket {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export interface StageDeps {
  env: Record<string, string | undefined>;
  cwd: string;
  lookupSocketPath: () => Promise<string>;
  openSocket: (socketPath: string) => StageSocket;
  /** Builder token figure from STA-159's script; undefined when absent or unusable. */
  readUsage: (cwd: string) => Promise<string | undefined>;
  reportTimeoutMs: number;
  log: (message: string) => void;
}

async function defaultReadUsage(cwd: string): Promise<string | undefined> {
  const script = join(cwd, USAGE_SCRIPT);
  const ignore = (why: string): undefined => {
    console.error(`igniter stage: ignoring token count from ${script}: ${why}`);
    return undefined;
  };
  try {
    if (!(await Bun.file(script).exists())) return undefined;
  } catch {
    return undefined;
  }
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    proc = Bun.spawn([script], { stdout: "pipe", stderr: "pipe" });
  } catch {
    return ignore("could not start it");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!(proc.stdout instanceof ReadableStream)) return ignore("its output is unreadable");
    const output = new Response(proc.stdout).text();
    const text = await new Promise<string | undefined>((resolve) => {
      timer = setTimeout(() => {
        proc?.kill();
        resolve(undefined);
      }, USAGE_TIMEOUT_MS);
      output.then(
        (value) => resolve(value),
        () => resolve(undefined),
      );
    });
    if (text === undefined) return ignore("it timed out");
    const value = text.trim();
    await proc.exited;
    if (proc.exitCode !== 0) return ignore(`it exited with ${proc.exitCode}`);
    if (!/^\d+$/.test(value)) return ignore("its output is not a number");
    return value;
  } finally {
    clearTimeout(timer);
  }
}

export function defaultStageDeps(): StageDeps {
  return {
    env: process.env,
    cwd: process.cwd(),
    lookupSocketPath: () => lookupSocketPath(),
    openSocket: (socketPath) => createHerdrSocket({ socketPath }),
    readUsage: defaultReadUsage,
    reportTimeoutMs: REPORT_TIMEOUT_MS,
    log: (message) => console.error(message),
  };
}

interface ParsedArgs {
  command?: StageCommand;
  step?: StageStep;
  reason?: string;
  error?: string;
}

function parseStageArgs(argv: string[]): ParsedArgs {
  const [command, name, ...rest] = argv;
  if (command === "stage") {
    if (name === undefined || !(STEPS as string[]).includes(name)) {
      return { error: `usage: igniter stage <${STEPS.join("|")}> [--reason TEXT]` };
    }
  } else if (command !== "pause" && command !== "resume") {
    return { error: `usage: igniter <stage|pause|resume>` };
  }
  const values = command === "stage" ? rest : [name, ...rest].filter((value): value is string => value !== undefined);
  let reason: string | undefined;
  for (let i = 0; i < values.length; i += 1) {
    const flag = values[i] as string;
    if (flag === "--reason") {
      reason = values[i + 1];
      i += 1;
    } else if (flag.startsWith("--reason=")) {
      reason = flag.slice("--reason=".length);
    } else {
      return { error: `igniter ${command}: unknown flag ${flag}` };
    }
  }
  // The server clears a key whose normalized value is empty, so a blank
  // reason would silently clear instead of naming the stop: reject it.
  const requiresReason = command === "pause" || name === "failed";
  if (requiresReason && (!reason || reason.trim().length === 0)) {
    return { error: `igniter ${command === "stage" ? `stage ${name}` : command}: --reason TEXT is required` };
  }
  if (!requiresReason && reason !== undefined) {
    return { error: `igniter ${command}: --reason is only valid for pause and stage failed` };
  }
  return { command, step: command === "stage" ? (name as StageStep) : undefined, reason };
}

// Deliberately an unguarded read-modify-write: one factory host runs one
// Commander per delivery run, and it issues stage calls sequentially, so
// there is no concurrent writer to guard against. Do not add a lock here
// without a second caller that actually exists.
function nextCount(existing: Record<string, string>, name: string): string {
  const raw = existing[name];
  const current = raw !== undefined && /^\d+$/.test(raw) ? parseInt(raw, 10) : 0;
  return String(current + 1);
}

function nextReviewCount(existing: Record<string, string>): string {
  const raw = existing["review_count"];
  // The first build opens the implementation stage, not a review round.
  if (raw === undefined || !/^\d+$/.test(raw)) return "0";
  return String(parseInt(raw, 10) + 1);
}

/**
 * Igniter-owned keys only; everything else in the snapshot belongs to
 * another owner. Every step starts from a cleared park: a stage the run
 * has left must not keep its `owner_pending` or `reason` behind, so only
 * `pause` sets them and every other step clears what it does not set.
 */
function stepTokens(
  ticket: string,
  existing: Record<string, string>,
  step: StageStep,
  reason: string | undefined,
): Record<string, string | null> {
  const tokens: Record<string, string | null> = { ticket, owner_pending: null, reason: null };
  switch (step) {
    case "plan":
      tokens["stage"] = "plan";
      break;
    case "build":
      tokens["stage"] = "build";
      tokens["review_count"] = nextReviewCount(existing);
      break;
    case "verify":
      tokens["stage"] = "verify";
      tokens["verify_count"] = nextCount(existing, "verify_count");
      break;
    case "acceptance":
      tokens["stage"] = "acceptance";
      tokens["owner_pending"] = "1";
      break;
    case "failed":
      tokens["stage"] = "failed";
      tokens["reason"] = reason as string;
      break;
  }
  return tokens;
}

function actionTokens(ticket: string, command: "pause" | "resume", reason: string | undefined): Record<string, string | null> {
  if (command === "pause") return { ticket, owner_pending: "1", reason: reason as string };
  return { ticket, owner_pending: null, reason: null };
}

async function reportStep(
  socket: StageSocket,
  deps: StageDeps,
  workspaceId: string,
  command: StageCommand,
  step: StageStep,
  reason: string | undefined,
): Promise<void> {
  const envelope = (await socket.call("session.snapshot", {})) as HerdrResults.SessionSnapshot;
  const workspace = envelope.snapshot.workspaces.find(
    (candidate) => candidate.workspace_id === workspaceId,
  );
  if (!workspace) {
    throw new Error(`workspace ${workspaceId} not found in session snapshot`);
  }
  const existing = workspace.tokens ?? {};
  const ticket = existing["ticket"] ?? deps.env[TICKET_ENV];
  if (!ticket) {
    throw new Error(`no ticket in workspace metadata and ${TICKET_ENV} is unset`);
  }
  const tokens = command === "stage"
    ? stepTokens(ticket, existing, step, reason)
    : actionTokens(ticket, command, reason);
  const usage = await deps.readUsage(deps.cwd);
  if (usage !== undefined) tokens["tokens"] = usage;
  const params: HerdrParams.WorkspaceReportMetadataParams = {
    workspace_id: workspaceId,
    source: STAGE_SOURCE,
    tokens,
  };
  await socket.call("workspace.report_metadata", params as unknown as Record<string, unknown>);
}

/**
 * Run `igniter stage <step> [--reason TEXT]`. Returns the process exit
 * code: 0 on success or when skipped outside Herdr, 1 on failure.
 * Lookup and socket work share one deadline; the deadline closes the
 * socket, so no path hangs the run or leaves a connection open.
 */
export async function runStage(argv: string[], over: Partial<StageDeps> = {}): Promise<number> {
  const deps = { ...defaultStageDeps(), ...over };
  const parsed = parseStageArgs(argv);
  if (parsed.error || !parsed.command) {
    deps.log(parsed.error as string);
    return 1;
  }
  const command = parsed.command;
  const step = parsed.step;
  const workspaceId = deps.env[WORKSPACE_ENV];
  if (!deps.env[HERDR_ENV] || !workspaceId) return 0;
  const fail = (error: unknown): number => {
    deps.log(`igniter ${command === "stage" ? `stage ${step}` : command}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  };
  let socket: StageSocket | undefined;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        socket?.close();
        reject(new Error(`herdr did not answer within ${deps.reportTimeoutMs}ms`));
      }, deps.reportTimeoutMs);
      // Attached, so a late settlement after the deadline closes quietly
      // instead of surfacing as an unhandled rejection.
      (async () => {
        const socketPath = await deps.lookupSocketPath();
        if (timedOut) throw new Error(`herdr did not answer within ${deps.reportTimeoutMs}ms`);
        socket = deps.openSocket(socketPath);
        try {
          await reportStep(socket, deps, workspaceId, command, step as StageStep, parsed.reason);
        } finally {
          socket.close();
          socket = undefined;
        }
      })().then(
        () => resolve(),
        (error: unknown) => reject(error),
      );
    });
    return 0;
  } catch (error) {
    return fail(error);
  } finally {
    clearTimeout(timer);
  }
}
