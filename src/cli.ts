#!/usr/bin/env bun
import { cac, type CAC } from "cac";
import { version } from "../package.json";
import { assertCommanderAssets } from "./commander/assets.ts";
import { createDispatchLog, validateStartup, type CommandResult } from "./workflow/config/claims.ts";
import type { CommandRequest, WorkerAnswer, WorkerProfile, WorkerRole } from "./workflow/command/command-request.ts";
import { runCommand } from "./workflow/command/commands.ts";
import { findProjectRoot, loadDispatchConfig } from "./workflow/config/config.ts";
import { LinearClient, requireLinearApiKey } from "./workflow/service/linear/linear.ts";
import type { LinearClientLike } from "./workflow/service/linear/linear.ts";
import { bunGitRunner } from "./workflow/service/worktree/worktrees.ts";
import { createHerdrWorkspaces, type CommandWorkspaces } from "./workflow/service/workspace/workspaces.ts";
import type { PromptDeliveryPolicy } from "./workflow/command/delivery/prompt-delivery.ts";

export interface CliRuntime {
  run(command: CommandRequest): Promise<CommandResult>;
  readStdin(): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  launch(command: string[], cwd: string): Promise<number>;
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), productionRuntime()).catch((error) => {
    console.error((error as Error).message);
    return 1;
  });
}

export async function runCli(args: string[], runtime: CliRuntime): Promise<number> {
  const session = { code: 0 };
  const actions = commandActions(runtime, session);
  const worker = workerCli(actions, runtime, session);
  const cli = mainCli(worker, actions, runtime, session);

  try {
    if (args[0] === "worker") {
      if (args.length === 1) {
        worker.outputHelp();
        return 1;
      }
      await parse(worker, args.slice(1));
      return session.code;
    }
    if (args.length === 0) {
      cli.outputHelp();
      return 1;
    }
    await parse(cli, normalizeInput(args));
    return session.code;
  } catch (error) {
    runtime.stderr((error as Error).message);
    return 1;
  }
}

function mainCli(
  worker: CAC,
  actions: ReturnType<typeof commandActions>,
  runtime: CliRuntime,
  session: { code: number },
): CAC {
  const cli = cac("igniter");

  cli.command("status [ticket]", "Show dispatch or ticket status")
    .option("--json", "Print JSON status")
    .action(actions.statusCommand);
  cli.command("start [ticket]", "Launch the foreground Commander")
    .action(actions.startCommand);
  cli.command("begin <ticket>", "Record the confirmed stage start")
    .action(actions.beginCommand);
  cli.command("reconcile <ticket>", "Reconcile ticket protocol state")
    .action(actions.reconcileCommand);
  cli.command("approve <ticket>", "Approve a specific receipt")
    .option("--receipt <id>", "Receipt ID (required)")
    .action(actions.approveCommand);
  cli.command("fail <ticket>", "Record a stage failure")
    .option("--reason <text>", "Failure reason (required)")
    .action(actions.failCommand);
  cli.command("submit <ticket>", "Submit a stage result from stdin")
    .option("--input <source>", "Use - to read stdin (required)")
    .action(actions.submitCommand);
  cli.command("block <ticket>", "Block a ticket")
    .option("--reason <text>", "Blocking reason (required)")
    .action(actions.blockCommand);
  cli.command("unblock <ticket>", "Return a blocked ticket to pending")
    .action(actions.unblockCommand);
  cli.command("worker <command>", "Operate a stage worker");

  cli.help((sections) => {
    if (!cli.matchedCommand) {
      sections.push({
        title: "Worker commands",
        body: worker.commands.map((command) => `  worker ${command.rawName}  ${command.description}`).join("\n"),
      });
    }
  });
  configureCli(cli, runtime, session);
  return cli;
}

function workerCli(
  actions: ReturnType<typeof commandActions>,
  runtime: CliRuntime,
  session: { code: number },
): CAC {
  const cli = cac("igniter worker");

  cli.command("start <ticket>", "Start the stage worker")
    .option("--role <role>", "build, review, or deliver")
    .action(actions.workerStartCommand);
  cli.command("send <ticket> <...text>", "Send text to the worker")
    .option("--role <role>", "build, review, or deliver")
    .action(actions.workerSendCommand);
  cli.command("restart <ticket>", "Restart with optional profile overrides")
    .option("--role <role>", "build, review, or deliver")
    .option("--profile <profile>", "builder, reviewer, deliverer, or fallback")
    .option("--harness <harness>", "Agent harness")
    .option("--model <model>", "Agent model")
    .option("--effort <effort>", "Reasoning effort")
    .action(actions.workerRestartCommand);
  cli.command("stop <ticket>", "Stop the stage worker")
    .option("--role <role>", "build, review, or deliver")
    .action(actions.workerStopCommand);
  cli.command("answer <ticket> <answer>", "Answer a permission prompt with y or n")
    .option("--role <role>", "build, review, or deliver")
    .action(actions.workerAnswerCommand);

  cli.help();
  configureCli(cli, runtime, session);
  return cli;
}

function commandActions(runtime: CliRuntime, session: { code: number }) {
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

function configureCli(cli: CAC, runtime: CliRuntime, session: { code: number }): void {
  cli.version(version);
  cli.outputVersion = () => runtime.stdout(version);
  cli.addEventListener("command:*", (event) => {
    if (cli.options.help || cli.options.version) return;
    runtime.stderr(`Unknown command: ${(event as CustomEvent<string>).detail}`);
    session.code = 1;
  });
}

async function parse(cli: CAC, args: string[]): Promise<void> {
  cli.parse([...process.argv.slice(0, 2), ...args], { run: false });
  await cli.runMatchedCommand();
}

function normalizeInput(args: string[]): string[] {
  const normalized = [...args];
  const input = normalized.indexOf("--input");
  if (args[0] === "submit" && input >= 0 && normalized[input + 1] === "-") {
    normalized.splice(input, 2, "--input=-");
  }
  return normalized;
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

function productionRuntime(): CliRuntime {
  return {
    run: executeCommand,
    readStdin: () => new Response(Bun.stdin.stream()).text(),
    stdout: console.log,
    stderr: console.error,
    launch: async (command, cwd) => {
      const agent = Bun.spawn(command, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      return agent.exited;
    },
  };
}

export async function executeCommand(
  command: CommandRequest,
  dependencies: {
    repoRoot?: string;
    client?: LinearClientLike;
    workspaces?: CommandWorkspaces;
    promptDelivery?: PromptDeliveryPolicy;
  } = {},
): Promise<CommandResult> {
  const repoRoot = dependencies.repoRoot ??
    (command.command === "start" ? await findProjectRoot(process.cwd()) : process.cwd());
  const config = await loadDispatchConfig(repoRoot);
  await assertCommanderAssets();
  const client = dependencies.client ?? new LinearClient({ apiKey: requireLinearApiKey() });
  const resolved = await validateStartup(client, config);
  return runCommand(command, {
    client,
    resolved,
    decisions: createDispatchLog(`${repoRoot.replace(/\/+$/, "")}/.igniter/dispatch.log`, () => {}),
    workspaces: dependencies.workspaces ?? createHerdrWorkspaces(),
    repoRoot,
    git: bunGitRunner(),
    promptDelivery: dependencies.promptDelivery,
  });
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
