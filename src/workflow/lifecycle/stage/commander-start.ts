// The CLI launches the Global Commander in its calling terminal.
import { commanderAssetPaths, type CommanderAssetPaths } from "../../../commander/assets.ts";
import { foregroundCommandFor } from "./agents.ts";
import type { ResolvedDispatch } from "../../config/claims.ts";

export interface CommanderStartDeps {
  resolved: ResolvedDispatch;
  repoRoot: string;
  assets?: CommanderAssetPaths;
}

export interface CommanderForegroundLaunch {
  kind: "commander_foreground";
  command: string[];
  cwd: string;
}

export interface CommanderLaunchInput {
  project: string;
  team: string;
  repoRoot: string;
  targetBranch: string;
  globalMd: string;
}

export function buildCommanderLaunchPrompt(input: CommanderLaunchInput): string {
  return (
    `Run the Igniter Global Commander workflow documented at ${input.globalMd}.\n` +
    `Project: ${input.project} (team ${input.team}). Workspace: ${input.repoRoot}. ` +
    `Delivery target branch: \`${input.targetBranch}\`; follow the configured project delivery instructions.\n` +
    `Begin with \`igniter status --json\`.\n` +
    `No ticket is assigned: an active or In-progress ticket in that queue is visibility only, ` +
    `not your assignment, and a missing local worker never makes it yours.\n`
  );
}

/** The configured interactive Commander command for the calling terminal. */
export function prepareCommanderForeground(deps: CommanderStartDeps): CommanderForegroundLaunch {
  const config = deps.resolved.config;
  const assets = deps.assets ?? commanderAssetPaths();
  const profile = config.commander.agents.commander;
  const order = buildCommanderLaunchPrompt({
    project: config.project,
    team: config.team ?? "",
    repoRoot: deps.repoRoot,
    targetBranch: config.targetBranch,
    globalMd: assets.global,
  });
  return {
    kind: "commander_foreground",
    command: foregroundCommandFor(profile, order),
    cwd: deps.repoRoot,
  };
}
