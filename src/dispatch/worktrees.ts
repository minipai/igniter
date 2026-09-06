// One git worktree per ticket: two tickets in flight never share a working
// tree, so their Commanders' branches cannot trample each other. The sink
// prepares the worktree before opening the Herdr workspace; the Commander
// works there and never creates another branch or worktree.

import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { WorkspaceSinkError } from "./claims.ts";

/** Base branch every ticket branch starts from. */
export const WORKTREE_BASE = "main";

export interface TicketWorktree {
  path: string;
  branch: string;
}

/**
 * `<repo>/.igniter/runtime/worktrees/<ticket lowercased>` on branch
 * `feature/<ticket lowercased>`. Pure derivation, so resume finds the same
 * checkout without adding project-specific directories beside the repo.
 */
export function ticketWorktree(repoRoot: string, identifier: string): TicketWorktree {
  const ticket = identifier.toLowerCase();
  return {
    path: join(repoRoot, ".igniter", "runtime", "worktrees", ticket),
    branch: `feature/${ticket}`,
  };
}

/** Minimal git surface the worktree prep needs; Bun.spawn in production. */
export interface GitRunner {
  run(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }>;
}

export function bunGitRunner(): GitRunner {
  return {
    run: async (args, cwd) => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        throw new Error(`git ${args.join(" ")} exited with ${code}: ${(stderr || stdout).trim()}`);
      }
      return { stdout, stderr };
    },
  };
}

async function gitRun(git: GitRunner, args: string[], cwd: string, identifier: string): Promise<string> {
  try {
    return (await git.run(args, cwd)).stdout;
  } catch (error) {
    throw new WorkspaceSinkError(`git ${args.join(" ")} failed for ${identifier}: ${(error as Error).message}`);
  }
}

function worktreeListed(stdout: string, path: string): boolean {
  return stdout.split("\n").some((line) => line === `worktree ${path}`);
}

async function branchExists(git: GitRunner, repoRoot: string, branch: string): Promise<boolean> {
  try {
    await git.run(["rev-parse", "--verify", `refs/heads/${branch}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prepare the ticket's worktree, creating it when missing. An already
 * listed path is reused as is, so a resumed or re-run ticket keeps its
 * checkpoint commits. Throws WorkspaceSinkError with git's stderr.
 */
export async function ensureTicketWorktree(
  git: GitRunner,
  repoRoot: string,
  identifier: string,
): Promise<TicketWorktree> {
  const worktree = ticketWorktree(repoRoot, identifier);
  const listed = await gitRun(git, ["worktree", "list", "--porcelain"], repoRoot, identifier);
  if (worktreeListed(listed, worktree.path)) return worktree;
  try {
    await mkdir(dirname(worktree.path), { recursive: true });
  } catch (error) {
    throw new WorkspaceSinkError(`cannot create ${dirname(worktree.path)} for ${identifier}: ${(error as Error).message}`);
  }
  if (await branchExists(git, repoRoot, worktree.branch)) {
    await gitRun(git, ["worktree", "add", worktree.path, worktree.branch], repoRoot, identifier);
  } else {
    await gitRun(
      git,
      ["worktree", "add", "-b", worktree.branch, worktree.path, WORKTREE_BASE],
      repoRoot,
      identifier,
    );
  }
  return worktree;
}
