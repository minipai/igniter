#!/usr/bin/env bun
import { cac, type CAC } from "cac";
import { version } from "../package.json";
import { commandActions } from "./cli/actions.ts";
import { configureCli, runParsedCli } from "./cli/run.ts";
import { productionRuntime, type CliRuntime } from "./cli/runtime.ts";

export { executeCommand, type CliRuntime } from "./cli/runtime.ts";

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
  return runParsedCli(args, runtime, session, cli, worker);
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
  cli.command("start", "Launch the foreground Commander")
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
  configureCli(cli, version, runtime, session);
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
  configureCli(cli, version, runtime, session);
  return cli;
}
