import type { CommandResult } from "../config/claims.ts";
import { commandDeps, refuse, ticketIssue, type CommandContext } from "../context.ts";
import {
  bareTodoState,
  countBuildSlots,
  deriveState,
  moveStatus,
  normalizeBareTodo,
  ProtocolError,
} from "../lifecycle/ticket/protocol.ts";

export async function beginCommand(ticket: string, ctx: CommandContext): Promise<CommandResult> {
  const identifier = ticket.toUpperCase();
  try {
    let full = await ticketIssue(ctx, identifier);
    const deps = commandDeps(ctx);
    const bare = bareTodoState(ctx.resolved, full);
    const state = bare ?? deriveState(ctx.resolved, full);
    if (state.progress === "in_progress" && state.status !== "todo") {
      return { ok: true, text: `already began ${full.identifier}: ${state.status}+in_progress` };
    }
    if (!["todo", "build", "acceptance", "deliver"].includes(state.status) || (!bare && state.progress !== "pending")) {
      throw new ProtocolError(`begin needs Todo, Build, Acceptance, or Deliver + Pending; ${state.status}+${state.progress}`);
    }
    if (state.criteria.length === 0) throw new ProtocolError("begin requires acceptance criteria");
    if (state.status === "todo" && await countBuildSlots(ctx.client, ctx.resolved) >= ctx.resolved.config.maxRunning) {
      throw new ProtocolError(`at max_running (${ctx.resolved.config.maxRunning})`);
    }
    if (bare) full = await normalizeBareTodo(deps, full);
    const target = state.status === "todo" ? "build" : state.status;
    const { recordStageStart } = await import("../lifecycle/ticket/protocol.ts");
    full = await recordStageStart(deps, full, target);
    await moveStatus(deps, full, target, "in_progress");
    await ctx.decisions.record(full.identifier, `begin: ${state.status}+pending → ${target}+in_progress`);
    return { ok: true, text: `began ${full.identifier}: ${target}+in_progress` };
  } catch (error) {
    return refuse(ctx, identifier, error);
  }
}
