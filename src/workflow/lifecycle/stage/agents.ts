// Agent commands and the run-recorded profiles used by retries.
import type { CommanderAgentConfig, CommanderConfig, CommanderStage, DispatchConfig } from "../../config/config.ts";
import { agentByName, STAGE_AGENTS } from "../../config/config.ts";

export type { CommanderAgentConfig };

/** Worker commands are submitted unchanged to the pane's shell. */
export function launchFor(profile: CommanderAgentConfig): { command: string } {
  if (!profile.command.trim()) throw new Error("agent command must be non-empty");
  if (profile.command.includes("{prompt}")) {
    throw new Error("worker commands cannot contain {prompt}; Herdr delivers the work order after startup");
  }
  return { command: profile.command };
}

/** The placeholder is a whole, unquoted shell word, replaced with one quoted argument. */
export function foregroundCommandFor(profile: CommanderAgentConfig, workOrder: string): string[] {
  const command = profile.command;
  if (!/(^|\s)\{prompt\}(?=\s|$)/.test(command) || command.split("{prompt}").length !== 2) {
    throw new Error("Commander command requires exactly one unquoted {prompt} argument");
  }
  const index = command.indexOf("{prompt}");
  let quote: string | undefined;
  let comment = false;
  for (let i = 0; i < index; i++) {
    const char = command[i];
    if (comment) {
      if (char === "\n") comment = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (quote === undefined && char === "#" && (i === 0 || /[\s;|&()<>]/.test(command[i - 1]!))) {
      comment = true;
      continue;
    }
    if (char === quote) quote = undefined;
    else if ((char === "'" || char === '"') && quote === undefined) quote = char;
  }
  if (comment) throw new Error("Commander {prompt} argument must not be inside a shell comment");
  if (quote !== undefined) throw new Error("Commander {prompt} argument must not be inside shell quotes");
  const quoted = `'${workOrder.replaceAll("'", "'\\''")}'`;
  return ["sh", "-c", command.slice(0, index) + quoted + command.slice(index + "{prompt}".length)];
}

export const PROFILE_TOKENS = ["profile_builder", "profile_acceptance", "profile_deliverer"] as const;
export const SELECTED_TOKENS = ["agent_builder", "agent_acceptance", "agent_deliverer"] as const;

export function recordStageProfiles(config: DispatchConfig): Record<string, string> {
  const agents = config.commander.agents;
  return {
    profile_builder: JSON.stringify(agents.builder),
    profile_acceptance: JSON.stringify(agents.acceptance),
    profile_deliverer: JSON.stringify(agents.deliverer),
    agent_builder: "builder",
    agent_acceptance: "acceptance",
    agent_deliverer: "deliverer",
  };
}

export function keptStageProfiles(tokens: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const key of [...PROFILE_TOKENS, ...SELECTED_TOKENS]) {
    if (tokens[key] !== undefined) kept[key] = tokens[key];
  }
  return kept;
}

export function selectedAgentToken(stage: CommanderStage): string {
  return `agent_${STAGE_AGENTS[stage]}`;
}

export interface SelectedStageAgent {
  name: string;
  profile: CommanderAgentConfig;
}

/** Explicit selection wins; retries keep the selected command even after config edits. */
export function selectStageAgent(
  commander: CommanderConfig,
  tokens: Record<string, string>,
  stage: CommanderStage,
  requested?: string,
): SelectedStageAgent {
  if (requested !== undefined) return { name: requested, profile: agentByName(commander.agents, requested) };
  const role = STAGE_AGENTS[stage];
  return {
    name: tokens[selectedAgentToken(stage)] ?? role,
    profile: thawProfile(tokens[`profile_${role}`], commander.agents[role]),
  };
}

export function launchProblems(config: DispatchConfig): string[] {
  const problems: string[] = [];
  for (const [name, profile] of Object.entries(config.commander.agents)) {
    try {
      if (name === "commander") foregroundCommandFor(profile, "work order");
      else launchFor(profile);
    } catch (error) {
      problems.push(`agents."${name}": ${(error as Error).message}`);
    }
  }
  return problems;
}

function thawProfile(raw: string | undefined, base: CommanderAgentConfig): CommanderAgentConfig {
  if (raw === undefined) return { ...base };
  if (raw.startsWith("igniter:")) {
    throw new Error("recorded agent command is missing or corrupt; restart with an explicit agent or command");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid recorded agent command; restart with an explicit agent or command");
  }
  if (parsed === null || typeof parsed !== "object" || !("command" in parsed) || typeof parsed.command !== "string" || !parsed.command.trim()) {
    throw new Error("recorded agent profile has no command; restart with an explicit agent or command");
  }
  return { command: parsed.command };
}
