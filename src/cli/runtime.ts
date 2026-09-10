import { assertCommanderAssets } from "../commander/assets.ts";
import type { CommandRequest } from "../workflow/request.ts";
import { runCommand } from "../workflow/run.ts";
import type { PromptDeliveryPolicy } from "../workflow/lifecycle/delivery/prompt-delivery.ts";
import { createDispatchLog, validateStartup, type CommandResult } from "../workflow/config/claims.ts";
import { findProjectRoot, loadDispatchConfig } from "../workflow/config/config.ts";
import { LinearClient, requireLinearApiKey, type LinearClientLike } from "../workflow/service/linear/linear.ts";
import { createHerdrWorkspaces, type CommandWorkspaces } from "../workflow/service/workspace/workspaces.ts";
import { bunGitRunner } from "../workflow/service/worktree/worktrees.ts";

export interface CliRuntime {
  run(command: CommandRequest): Promise<CommandResult>;
  readStdin(): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  launch(command: string[], cwd: string): Promise<number>;
}

export function productionRuntime(): CliRuntime {
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
