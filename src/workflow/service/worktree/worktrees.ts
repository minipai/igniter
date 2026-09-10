// One git worktree per ticket: two tickets in flight never share a working
// tree, so their Commanders' branches cannot trample each other. The sink
// prepares the worktree before opening the Herdr workspace; the Commander
// works there and never creates another branch or worktree.

import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { WorkspaceError } from "../../config/claims.ts";

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
  /** Landed commit the receipt binds; must read back from the target branch. */
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
 * How the local ticket branch relates to the target branch. `ancestor` is
 * the ordinary merge. `equivalent` is GitHub's native rebase merge: the
 * target holds the branch tip's exact tree under a rewritten SHA, so the
 * content is fully landed even though the commit is not; it carries the
 * exact tip OID the proof covers, so the later delete can bind to it.
 * `unlanded` means the tip carries content the target cannot trace.
 * `unknown` is any git failure, which never authorizes a delete.
 *
 * The tree comparison is deliberately conservative: if the target advanced
 * with other changes after the branch was cut, the rebased tree no longer
 * matches the local tip and cleanup keeps the checkout. That is a
 * false-negative, never a false-positive, so it can never drop content.
 */
type BranchLanding =
  | { kind: "ancestor" }
  | { kind: "equivalent"; tip: string }
  | { kind: "unlanded" }
  | { kind: "unknown" };

async function branchLanding(
  git: GitRunner,
  repoRoot: string,
  branch: string,
  landed: string,
  targetBranch: string,
): Promise<BranchLanding> {
  try {
    await git.run(["merge-base", "--is-ancestor", branch, targetBranch], repoRoot);
    return { kind: "ancestor" };
  } catch {
    // Not an ancestor: a native rebase merge rewrites the SHA but keeps the
    // tree, so fall through to the content comparison below.
  }
  try {
    await git.run(["merge-base", "--is-ancestor", landed, targetBranch], repoRoot);
  } catch {
    // The landed commit itself is not on the target: nothing landed.
    return { kind: "unlanded" };
  }
  try {
    // Resolve the tip once and read its tree from that exact OID: the value
    // bound to the delete is the one this proof covers, so a ref that moves
    // after the proof cannot slip a different tree past the guard.
    const tip = (await git.run(["rev-parse", branch], repoRoot)).stdout.trim();
    if (tip === "") return { kind: "unknown" };
    const branchTree = (await git.run(["rev-parse", `${tip}^{tree}`], repoRoot)).stdout.trim();
    const landedTree = (await git.run(["rev-parse", `${landed}^{tree}`], repoRoot)).stdout.trim();
    return branchTree !== "" && branchTree === landedTree
      ? { kind: "equivalent", tip }
      : { kind: "unlanded" };
  } catch {
    return { kind: "unknown" };
  }
}

/**
 * Remove the ticket's worktree and local feature branch after a Done
 * landing. Safe by construction:
 *
 * - only the derived ticket path is ever removed, and only when it sits
 *   on the derived ticket branch;
 * - a dirty worktree (tracked or untracked changes) is kept as is;
 * - the delivered checkpoint must read back from the target branch
 *   (`merge-base --is-ancestor`) before the worktree goes;
 * - the ticket branch tip must either be an ancestor of the target or carry
 *   the exact tree of the landed commit, which is how GitHub's native rebase
 *   merge lands a branch under a rewritten SHA;
 * - the branch goes only after the worktree, with the tip checked again;
 * - removal uses plain `worktree remove` and `branch -d` for an ordinary
 *   merge; a content-equivalent rebase landing deletes the ref only after
 *   proving the tip's tree already sits on the target under the landed
 *   commit, and binds the delete to that exact tip OID so a ref that moved
 *   after the proof fails closed. `--force` and `-D` never appear here.
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
  const { checkpoint: landed, targetBranch } = options;
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
    return removeTicketBranch(git, repoRoot, identifier, worktree.branch, landed, targetBranch, {
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
    await git.run(["merge-base", "--is-ancestor", landed, targetBranch], repoRoot);
  } catch (error) {
    return kept(
      `${identifier}: landed commit ${shortRef(landed)} is not reachable from ${targetBranch} ` +
        `(${gitError(error)}); keeping worktree and branch`,
    );
  }

  const landing = await branchLanding(git, repoRoot, worktree.branch, landed, targetBranch);
  if (landing.kind === "unlanded") {
    return kept(
      `${identifier}: branch ${worktree.branch} holds commits not reachable from ${targetBranch}; ` +
        `keeping worktree and branch`,
    );
  }
  if (landing.kind === "unknown") {
    return kept(
      `${identifier}: cannot verify branch ${worktree.branch}; keeping worktree and branch`,
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
  return removeTicketBranch(git, repoRoot, identifier, worktree.branch, landed, targetBranch, {
    worktreeRemoved: true,
    late: false,
  });
}

/**
 * Delete the local ticket branch once its content reads back from the
 * target branch. Plain `branch -d` is the second lock on the ordinary
 * merge: it refuses when the branch is not fully merged, so even a stale
 * landing check cannot drop commits. A content-equivalent rebase landing
 * has no shared ancestry for that lock to see — and a pushed branch's stale
 * upstream would refuse `-d` anyway — so the ref is deleted with the tip OID
 * the equivalence proof covered as its expected old value: a ref that moved
 * after the proof fails the delete closed instead of dropping new content.
 * `late` marks a repeat run whose worktree was already gone.
 */
async function removeTicketBranch(
  git: GitRunner,
  repoRoot: string,
  identifier: string,
  branch: string,
  landed: string,
  targetBranch: string,
  state: { worktreeRemoved: boolean; late: boolean },
): Promise<CleanupOutcome> {
  const prefix = state.late ? `${identifier}: worktree already gone; ` : `${identifier}: removed worktree; `;
  const landing = await branchLanding(git, repoRoot, branch, landed, targetBranch);
  if (landing.kind === "unlanded") {
    return {
      ok: false,
      worktreeRemoved: state.worktreeRemoved,
      branchRemoved: false,
      alreadyCleaned: false,
      detail:
        `${prefix}branch ${branch} holds commits not reachable from ${targetBranch}; keeping branch`,
    };
  }
  if (landing.kind === "unknown") {
    return {
      ok: false,
      worktreeRemoved: state.worktreeRemoved,
      branchRemoved: false,
      alreadyCleaned: false,
      detail: `${prefix}cannot verify branch ${branch}; keeping branch`,
    };
  }
  // An `equivalent` landing already proved the tip's exact tree sits on the
  // target under the landed commit, so deleting that exact ref drops nothing.
  const remove: string[] = landing.kind === "equivalent"
    ? ["update-ref", "-d", `refs/heads/${branch}`, landing.tip]
    : ["branch", "-d", branch];
  try {
    await git.run(remove, repoRoot);
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
