// One git worktree per ticket: two tickets in flight never share a working
// tree, so their Commanders' branches cannot trample each other. The sink
// prepares the worktree before opening the Herdr workspace; the Commander
// works there and never creates another branch or worktree.

import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { WorkspaceError } from "./claims.ts";

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
    throw new WorkspaceError(`git ${args.join(" ")} failed for ${identifier}: ${(error as Error).message}`);
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
 * checkpoint commits. Throws WorkspaceError with git's stderr.
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
    throw new WorkspaceError(`cannot create ${dirname(worktree.path)} for ${identifier}: ${(error as Error).message}`);
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

// ---------------------------------------------------------------------------
// Done-ticket cleanup: give back the worktree and the local feature branch
// once the delivery has landed, without ever dropping unlanded content.
// ---------------------------------------------------------------------------

export interface CleanupOptions {
  /** Delivered checkpoint the receipt binds; must read back from the target branch. */
  checkpoint: string;
  /** Branch the delivery landed on (dispatch `target_branch`). */
  targetBranch: string;
}

export interface CleanupOutcome {
  /** True when nothing remains: removed now, or already gone on a repeat run. */
  ok: boolean;
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  /** True when the worktree and the branch were already gone. */
  alreadyCleaned: boolean;
  /** One Activity-ready line describing what happened and why. */
  detail: string;
}

interface ListedWorktree {
  path: string;
  /** Null for detached or bare checkouts. */
  branch: string | null;
}

function parseWorktreeList(stdout: string): ListedWorktree[] {
  const entries: ListedWorktree[] = [];
  let current: ListedWorktree | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length).trim(), branch: null };
      entries.push(current);
    } else if (current && line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
  }
  return entries.filter((entry) => entry.path !== "");
}

/** Short hash for Activity lines; passes short names through untouched. */
function shortRef(ref: string): string {
  return ref.length > 12 ? ref.slice(0, 12) : ref;
}

function gitError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().split("\n")[0] ?? String(error);
}

/**
 * Tri-state branch probe for cleanup: "absent" only on git's unknown
 * revision answer; any other failure is "unknown", so a transient git
 * error can never read as "already cleaned".
 */
async function probeBranch(git: GitRunner, repoRoot: string, branch: string): Promise<"present" | "absent" | "unknown"> {
  try {
    await git.run(["rev-parse", "--verify", `refs/heads/${branch}`], repoRoot);
    return "present";
  } catch (error) {
    return /needed a single revision|unknown revision/i.test(gitError(error)) ? "absent" : "unknown";
  }
}

/**
 * Remove the ticket's worktree and local feature branch after a Done
 * landing. Safe by construction:
 *
 * - only the derived ticket path is ever removed, and only when it sits
 *   on the derived ticket branch;
 * - a dirty worktree (tracked or untracked changes) is kept as is;
 * - the delivered checkpoint and the ticket branch tip must both read back
 *   from the target branch (`merge-base --is-ancestor`) before the worktree
 *   goes;
 * - the branch goes only after the worktree, with the tip checked again;
 * - removal uses plain `worktree remove` and `branch -d`: both refuse
 *   rather than drop content, and `--force`/`-D` never appear here.
 *
 * Anything unexpected — a missing target branch, a worktree on the wrong
 * branch, a branch checked out elsewhere, any git failure — keeps
 * everything and names the reason in `detail`. A repeat run over an
 * already cleaned ticket reports ok. Never throws: every git failure
 * becomes a keep-reason, so a cleanup failure can never roll back a
 * validated Done.
 */
export async function cleanupTicketCheckout(
  git: GitRunner,
  repoRoot: string,
  identifier: string,
  options: CleanupOptions,
): Promise<CleanupOutcome> {
  const worktree = ticketWorktree(repoRoot, identifier);
  const { checkpoint, targetBranch } = options;
  const kept = (detail: string, extra?: Partial<CleanupOutcome>): CleanupOutcome => ({
    ok: false,
    worktreeRemoved: false,
    branchRemoved: false,
    alreadyCleaned: false,
    detail,
    ...extra,
  });

  if (targetBranch === worktree.branch) {
    return kept(
      `${identifier}: target branch is the ticket branch itself (${targetBranch}); ` +
        `refusing to clean its own landing target`,
    );
  }

  let entries: ListedWorktree[];
  try {
    entries = parseWorktreeList((await git.run(["worktree", "list", "--porcelain"], repoRoot)).stdout);
  } catch (error) {
    return kept(
      `${identifier}: cannot list worktrees (${gitError(error)}); keeping worktree and branch`,
    );
  }
  const mine = entries.find((entry) => entry.path === worktree.path);
  if (mine && mine.branch !== worktree.branch) {
    return kept(
      `${identifier}: worktree at ${worktree.path} is on ${mine.branch ?? "a detached checkout"}, ` +
        `not ${worktree.branch}; refusing to clean a worktree igniter did not derive`,
    );
  }
  const elsewhere = entries.find(
    (entry) => entry.path !== worktree.path && entry.branch === worktree.branch,
  );
  if (elsewhere) {
    return kept(
      `${identifier}: branch ${worktree.branch} is checked out in another worktree at ${elsewhere.path}; ` +
        `keeping worktree and branch`,
    );
  }

  if (!mine) {
    const probed = await probeBranch(git, repoRoot, worktree.branch);
    if (probed === "absent") {
      return {
        ok: true,
        worktreeRemoved: false,
        branchRemoved: false,
        alreadyCleaned: true,
        detail: `${identifier}: worktree and branch already cleaned; nothing to do`,
      };
    }
    if (probed === "unknown") {
      return kept(
        `${identifier}: cannot verify branch ${worktree.branch}; keeping branch`,
      );
    }
    return removeTicketBranch(git, repoRoot, identifier, worktree.branch, targetBranch, {
      worktreeRemoved: false,
      late: true,
    });
  }

  let status: string;
  try {
    status = (await git.run(["status", "--porcelain"], worktree.path)).stdout;
  } catch (error) {
    return kept(
      `${identifier}: cannot read worktree status at ${worktree.path} (${gitError(error)}); ` +
        `keeping worktree and branch`,
    );
  }
  const changed = status.split("\n").map((line) => line.trim()).filter(Boolean);
  if (changed.length > 0) {
    const shown = changed.slice(0, 5).join(", ");
    const more = changed.length > 5 ? ` and ${changed.length - 5} more` : "";
    return kept(
      `${identifier}: worktree at ${worktree.path} has uncommitted changes (${shown}${more}); ` +
        `keeping worktree and branch`,
    );
  }

  try {
    await git.run(["merge-base", "--is-ancestor", checkpoint, targetBranch], repoRoot);
  } catch (error) {
    return kept(
      `${identifier}: checkpoint ${shortRef(checkpoint)} is not reachable from ${targetBranch} ` +
        `(${gitError(error)}); keeping worktree and branch`,
    );
  }

  try {
    await git.run(["merge-base", "--is-ancestor", worktree.branch, targetBranch], repoRoot);
  } catch (error) {
    return kept(
      `${identifier}: branch ${worktree.branch} holds commits not reachable from ${targetBranch} ` +
        `(${gitError(error)}); keeping worktree and branch`,
    );
  }

  try {
    await git.run(["worktree", "remove", worktree.path], repoRoot);
  } catch (error) {
    return kept(
      `${identifier}: cannot remove worktree at ${worktree.path} (${gitError(error)}); ` +
        `keeping worktree and branch`,
    );
  }

  const probed = await probeBranch(git, repoRoot, worktree.branch);
  if (probed === "absent") {
    return {
      ok: true,
      worktreeRemoved: true,
      branchRemoved: false,
      alreadyCleaned: false,
      detail: `${identifier}: removed worktree at ${worktree.path}; branch ${worktree.branch} already gone`,
    };
  }
  if (probed === "unknown") {
    return kept(
      `${identifier}: removed worktree at ${worktree.path}; cannot verify branch ${worktree.branch}; keeping branch`,
      { worktreeRemoved: true },
    );
  }
  return removeTicketBranch(git, repoRoot, identifier, worktree.branch, targetBranch, {
    worktreeRemoved: true,
    late: false,
  });
}

/**
 * Delete the local ticket branch once its tip reads back from the target
 * branch. Plain `branch -d` is the second lock: it refuses when the
 * branch is not fully merged, so even a stale ancestor check cannot drop
 * commits. `late` marks a repeat run whose worktree was already gone.
 */
async function removeTicketBranch(
  git: GitRunner,
  repoRoot: string,
  identifier: string,
  branch: string,
  targetBranch: string,
  state: { worktreeRemoved: boolean; late: boolean },
): Promise<CleanupOutcome> {
  const prefix = state.late ? `${identifier}: worktree already gone; ` : `${identifier}: removed worktree; `;
  try {
    await git.run(["merge-base", "--is-ancestor", branch, targetBranch], repoRoot);
  } catch (error) {
    return {
      ok: false,
      worktreeRemoved: state.worktreeRemoved,
      branchRemoved: false,
      alreadyCleaned: false,
      detail:
        `${prefix}branch ${branch} holds commits not reachable from ${targetBranch} ` +
        `(${gitError(error)}); keeping branch`,
    };
  }
  try {
    await git.run(["branch", "-d", branch], repoRoot);
  } catch (error) {
    return {
      ok: false,
      worktreeRemoved: state.worktreeRemoved,
      branchRemoved: false,
      alreadyCleaned: false,
      detail: `${prefix}cannot delete branch ${branch} (${gitError(error)}); keeping branch`,
    };
  }
  return {
    ok: true,
    worktreeRemoved: state.worktreeRemoved,
    branchRemoved: true,
    alreadyCleaned: false,
    detail: state.late
      ? `${identifier}: worktree already gone; removed merged branch ${branch}`
      : `${identifier}: removed worktree and merged branch ${branch} after landing on ${targetBranch}`,
  };
}
