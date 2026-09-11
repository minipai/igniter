import type { CommandResult } from "./config/claims.ts";
import { approveCommand } from "./command/approve.ts";
import { beginCommand } from "./command/begin.ts";
import { blockCommand } from "./command/block.ts";
import { cancelCommand } from "./command/cancel.ts";
import { failCommand } from "./command/fail.ts";
import { reconcileCommand } from "./command/reconcile.ts";
import { startCommand } from "./command/start.ts";
import { statusCommand } from "./command/status.ts";
import { submitCommand } from "./command/submit.ts";
import { unblockCommand } from "./command/unblock.ts";
import { answerWorker } from "./command/worker/answer.ts";
import { restartWorker } from "./command/worker/restart.ts";
import { sendWorker } from "./command/worker/send.ts";
import { startWorker } from "./command/worker/start.ts";
import { stopWorker } from "./command/worker/stop.ts";
import type { CommandContext } from "./context.ts";
import type { CommandRequest, WorkerRequest } from "./request.ts";

export type { CommandResult } from "./config/claims.ts";
export type { CommandContext } from "./context.ts";
export { collectStatus, type StatusCollection, type StatusData, type StatusTicketData } from "./command/status.ts";
export { answerKeysFor } from "./command/worker/answer.ts";
export { formatDuration } from "./lifecycle/ticket/recovery.ts";

export function runCommand(command: CommandRequest, ctx: CommandContext): Promise<CommandResult> {
  switch (command.command) {
    case "status":
      return statusCommand(command.ticket, command.json === true, ctx);
    case "start":
      return startCommand(ctx);
    case "begin":
      return beginCommand(command.ticket, ctx);
    case "reconcile":
      return reconcileCommand(command.ticket, ctx);
    case "approve":
      return approveCommand(command.ticket, command.receipt, ctx);
    case "fail":
      return failCommand(command.ticket, command.reason, ctx);
    case "submit":
      return submitCommand(command.ticket, command.payload, ctx);
    case "block":
      return blockCommand(command.ticket, command.reason, ctx);
    case "unblock":
      return unblockCommand(command.ticket, ctx);
    case "cancel":
      return cancelCommand(command.ticket, command.reason, ctx);
    default:
      return workerCommand(command, ctx);
  }
}

export async function workerCommand(request: WorkerRequest, ctx: CommandContext): Promise<CommandResult> {
  const action = request.command.slice("worker.".length);
  try {
    switch (request.command) {
      case "worker.start":
        return await startWorker(request, ctx);
      case "worker.send":
        return await sendWorker(request, ctx);
      case "worker.restart":
        return await restartWorker(request, ctx);
      case "worker.stop":
        return await stopWorker(request, ctx);
      case "worker.answer":
        return await answerWorker(request, ctx);
    }
  } catch (error) {
    return { ok: false, text: `worker ${action} failed: ${(error as Error).message}; Linear unchanged` };
  }
}
