import type { CommandRequest, WorkerAnswer, WorkerProfile, WorkerRole } from "../workflow/request.ts";
import type { CliRuntime } from "./runtime.ts";

export function commandActions(runtime: CliRuntime, session: { code: number }) {
  const run = async (command: CommandRequest): Promise<void> => {
    const result = await runtime.run(command);
    if (!result.ok) {
      runtime.stderr(result.text);
      session.code = 1;
      return;
    }
    runtime.stdout(result.text);
    const foreground = commanderForeground(result.data);
    if (command.command === "start" && !foreground) {
      runtime.stderr("dispatch did not return a valid foreground Commander launch");
      session.code = 1;
      return;
    }
    if (foreground) session.code = await runtime.launch(foreground.command, foreground.cwd);
  };

  async function statusCommand(ticket: string | undefined, options: { json?: boolean }): Promise<void> {
    await run({ command: "status", ticket, json: options.json });
  }

  async function startCommand(ticket: string | undefined): Promise<void> {
    await run({ command: "start", ticket });
  }

  async function beginCommand(ticket: string): Promise<void> {
    await run({ command: "begin", ticket });
  }

  async function reconcileCommand(ticket: string): Promise<void> {
    await run({ command: "reconcile", ticket });
  }

  async function approveCommand(ticket: string, options: { receipt?: string }): Promise<void> {
    await run({ command: "approve", ticket, receipt: required(options.receipt, "receipt") });
  }

  async function failCommand(ticket: string, options: { reason?: string }): Promise<void> {
    await run({ command: "fail", ticket, reason: required(options.reason, "reason") });
  }

  async function submitCommand(ticket: string, options: { input?: string }): Promise<void> {
    if (required(options.input, "input") !== "-") throw new Error("--input must be -");
    const input = await runtime.readStdin();
    let payload: unknown;
    try {
      payload = JSON.parse(input);
    } catch {
      throw new Error("submit input is not JSON");
    }
    await run({ command: "submit", ticket, payload });
  }

  async function blockCommand(ticket: string, options: { reason?: string }): Promise<void> {
    await run({ command: "block", ticket, reason: required(options.reason, "reason") });
  }

  async function unblockCommand(ticket: string): Promise<void> {
    await run({ command: "unblock", ticket });
  }

  async function workerStartCommand(ticket: string, options: { role?: string }): Promise<void> {
    await run({ command: "worker.start", ticket, role: workerRole(options.role) });
  }

  async function workerSendCommand(ticket: string, words: string[], options: { role?: string }): Promise<void> {
    await run({ command: "worker.send", ticket, role: workerRole(options.role), text: words.join(" ") });
  }

  async function workerRestartCommand(ticket: string, options: Record<string, unknown>): Promise<void> {
    await run({
      command: "worker.restart",
      ticket,
      role: workerRole(options["role"]),
      profile: workerProfile(options["profile"]),
      harness: options["harness"] as string | undefined,
      model: options["model"] as string | undefined,
      effort: options["effort"] as string | undefined,
    });
  }

  async function workerStopCommand(ticket: string, options: { role?: string }): Promise<void> {
    await run({ command: "worker.stop", ticket, role: workerRole(options.role) });
  }

  async function workerAnswerCommand(ticket: string, answer: string, options: { role?: string }): Promise<void> {
    await run({ command: "worker.answer", ticket, role: workerRole(options.role), answer: workerAnswer(answer) });
  }

  return {
    statusCommand,
    startCommand,
    beginCommand,
    reconcileCommand,
    approveCommand,
    failCommand,
    submitCommand,
    blockCommand,
    unblockCommand,
    workerStartCommand,
    workerSendCommand,
    workerRestartCommand,
    workerStopCommand,
    workerAnswerCommand,
  };
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Required option --${name} is missing`);
  return value;
}

function workerRole(value: unknown): WorkerRole | undefined {
  if (value === undefined) return undefined;
  if (value === "build" || value === "review" || value === "deliver") return value;
  throw new Error("--role must be build, review, or deliver");
}

function workerProfile(value: unknown): WorkerProfile | undefined {
  if (value === undefined) return undefined;
  if (value === "builder" || value === "reviewer" || value === "deliverer" || value === "fallback") return value;
  throw new Error("--profile must be builder, reviewer, deliverer, or fallback");
}

function workerAnswer(value: unknown): WorkerAnswer {
  if (value === "y" || value === "n") return value;
  throw new Error("answer must be y or n");
}

interface CommanderForegroundLaunch {
  kind: "commander_foreground";
  command: string[];
  cwd: string;
}

function commanderForeground(data: unknown): CommanderForegroundLaunch | null {
  if (typeof data !== "object" || data === null) return null;
  const launch = data as Partial<CommanderForegroundLaunch>;
  if (
    launch.kind !== "commander_foreground" ||
    !Array.isArray(launch.command) ||
    launch.command.length === 0 ||
    !launch.command.every((part) => typeof part === "string") ||
    typeof launch.cwd !== "string"
  ) return null;
  return launch as CommanderForegroundLaunch;
}
