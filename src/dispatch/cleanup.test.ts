// Done-ticket cleanup against throwaway git repos: the safe path plus
// every keep-reason. Each test builds its own repo under the OS temp dir,
// so the real checkout is never touched. Runs through the production
// bunGitRunner behind a recorder that bans data-losing flags.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  bunGitRunner,
  cleanupTicketCheckout,
  ensureTicketWorktree,
  ticketWorktree,
  type GitRunner,
} from "./worktrees";

/** Production runner that records every invocation for the force-flag ban. */
class RecordingGit implements GitRunner {
  commands: string[][] = [];
  constructor(private readonly inner: GitRunner) {}
  async run(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    this.commands.push([...args]);
    return this.inner.run(args, cwd);
  }
  cleanOfForce(): boolean {
    return this.commands.every((args) => !args.includes("--force") && !args.includes("-D"));
  }
}

interface TicketRepo {
  root: string;
  git: RecordingGit;
  path: string;
  branch: string;
}

async function initRepo(): Promise<{ root: string; git: RecordingGit }> {
  // Canonicalize: /var on macOS is a symlink to /private/var, while git
  // always reports the real path in `worktree list`.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "igniter-cleanup-")));
  const git = new RecordingGit(bunGitRunner());
  await git.run(["init", "-b", "main", root], tmpdir());
  await git.run(["config", "user.email", "test@example.test"], root);
  await git.run(["config", "user.name", "test"], root);
  await git.run(["config", "commit.gpgsign", "false"], root);
  writeFileSync(join(root, "base.txt"), "base\n");
  await git.run(["add", "base.txt"], root);
  await git.run(["commit", "-m", "base"], root);
  return { root, git };
}

/** A ticket worktree with one commit on its branch; returns the checkpoint. */
async function ticketCommit(repo: TicketRepo, name = "feature.txt"): Promise<string> {
  writeFileSync(join(repo.path, name), "ticket work\n");
  await repo.git.run(["add", name], repo.path);
  await repo.git.run(["commit", "-m", "ticket work"], repo.path);
  return (await repo.git.run(["rev-parse", "HEAD"], repo.path)).stdout.trim();
}

async function openTicket(root: string, git: RecordingGit, identifier: string): Promise<TicketRepo> {
  const derived = ticketWorktree(root, identifier);
  await ensureTicketWorktree(git, root, identifier);
  return { root, git, path: derived.path, branch: derived.branch };
}

async function worktreeListed(git: GitRunner, root: string, path: string): Promise<boolean> {
  const out = (await git.run(["worktree", "list", "--porcelain"], root)).stdout;
  return out.split("\n").some((line) => line === `worktree ${path}`);
}

async function branchExists(git: GitRunner, root: string, branch: string): Promise<boolean> {
  try {
    await git.run(["rev-parse", "--verify", `refs/heads/${branch}`], root);
    return true;
  } catch {
    return false;
  }
}

async function mergeTicket(git: GitRunner, root: string, branch: string): Promise<void> {
  await git.run(["merge", "--no-ff", "-m", `merge ${branch}`, branch], root);
}

describe("cleanupTicketCheckout", () => {
  test("removes a clean worktree and its merged branch", async () => {
    const { root, git } = await initRepo();
    const repo = await openTicket(root, git, "STA-1");
    const checkpoint = await ticketCommit(repo);
    await mergeTicket(git, root, repo.branch);

    const outcome = await cleanupTicketCheckout(git, root, "STA-1", {
      checkpoint,
      targetBranch: "main",
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.worktreeRemoved).toBe(true);
    expect(outcome.branchRemoved).toBe(true);
    expect(outcome.alreadyCleaned).toBe(false);
    expect(await worktreeListed(git, root, repo.path)).toBe(false);
    expect(await branchExists(git, root, repo.branch)).toBe(false);
    expect(git.cleanOfForce()).toBe(true);
  });

  test("keeps a worktree with tracked changes", async () => {
    const { root, git } = await initRepo();
    const repo = await openTicket(root, git, "STA-2");
    const checkpoint = await ticketCommit(repo);
    await mergeTicket(git, root, repo.branch);
    writeFileSync(join(repo.path, "feature.txt"), "uncommitted edit\n");

    const outcome = await cleanupTicketCheckout(git, root, "STA-2", {
      checkpoint,
      targetBranch: "main",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("uncommitted changes");
    expect(await worktreeListed(git, root, repo.path)).toBe(true);
    expect(await branchExists(git, root, repo.branch)).toBe(true);
    expect(git.cleanOfForce()).toBe(true);
  });

  test("keeps a worktree with untracked files", async () => {
    const { root, git } = await initRepo();
    const repo = await openTicket(root, git, "STA-3");
    const checkpoint = await ticketCommit(repo);
    await mergeTicket(git, root, repo.branch);
    writeFileSync(join(repo.path, "scratch.txt"), "untracked\n");

    const outcome = await cleanupTicketCheckout(git, root, "STA-3", {
      checkpoint,
      targetBranch: "main",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("uncommitted changes");
    expect(await worktreeListed(git, root, repo.path)).toBe(true);
    expect(await branchExists(git, root, repo.branch)).toBe(true);
    expect(git.cleanOfForce()).toBe(true);
  });

  test("keeps the worktree and the branch when the branch is not merged", async () => {
    const { root, git } = await initRepo();
    const repo = await openTicket(root, git, "STA-4");
    const checkpoint = await ticketCommit(repo);

    const outcome = await cleanupTicketCheckout(git, root, "STA-4", {
      checkpoint,
      targetBranch: "main",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("not reachable from main");
    expect(await worktreeListed(git, root, repo.path)).toBe(true);
    expect(await branchExists(git, root, repo.branch)).toBe(true);
    expect(git.cleanOfForce()).toBe(true);
  });

  test("keeps everything when the checkpoint never landed on the target", async () => {
    const { root, git } = await initRepo();
    const repo = await openTicket(root, git, "STA-5");
    await ticketCommit(repo);
    await mergeTicket(git, root, repo.branch);
    // A commit on a side branch that never merges: the receipt binds
    // something the target cannot trace.
    await git.run(["branch", "side", "main"], root);
    writeFileSync(join(root, "side.txt"), "side\n");
    await git.run(["checkout", "side"], root);
    await git.run(["add", "side.txt"], root);
    await git.run(["commit", "-m", "side work"], root);
    const stray = (await git.run(["rev-parse", "HEAD"], root)).stdout.trim();
    await git.run(["checkout", "main"], root);

    const outcome = await cleanupTicketCheckout(git, root, "STA-5", {
      checkpoint: stray,
      targetBranch: "main",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("not reachable from main");
    expect(await worktreeListed(git, root, repo.path)).toBe(true);
    expect(await branchExists(git, root, repo.branch)).toBe(true);
    expect(git.cleanOfForce()).toBe(true);
  });

  test("refuses a worktree that sits on a different branch", async () => {
    const { root, git } = await initRepo();
    const derived = ticketWorktree(root, "STA-9");
    mkdirSync(dirname(derived.path), { recursive: true });
    await git.run(["worktree", "add", "--detach", derived.path, "main"], root);
    await git.run(["branch", "feature/sta-9", "main"], root);

    const outcome = await cleanupTicketCheckout(git, root, "STA-9", {
      checkpoint: "deadbeef",
      targetBranch: "main",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("refusing");
    expect(await worktreeListed(git, root, derived.path)).toBe(true);
    expect(await branchExists(git, root, "feature/sta-9")).toBe(true);
    expect(git.cleanOfForce()).toBe(true);
  });

  test("refuses when the branch is checked out in another worktree", async () => {
    const { root, git } = await initRepo();
    await git.run(["branch", "feature/sta-9", "main"], root);
    const other = join(root, "other-wt");
    mkdirSync(other, { recursive: true });
    await git.run(["worktree", "add", other, "feature/sta-9"], root);

    const outcome = await cleanupTicketCheckout(git, root, "STA-9", {
      checkpoint: "deadbeef",
      targetBranch: "main",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("another worktree");
    expect(await branchExists(git, root, "feature/sta-9")).toBe(true);
    expect(git.cleanOfForce()).toBe(true);
  });

  test("a repeat run over a cleaned ticket reports already cleaned", async () => {
    const { root, git } = await initRepo();
    const repo = await openTicket(root, git, "STA-6");
    const checkpoint = await ticketCommit(repo);
    await mergeTicket(git, root, repo.branch);
    const first = await cleanupTicketCheckout(git, root, "STA-6", {
      checkpoint,
      targetBranch: "main",
    });
    expect(first.ok).toBe(true);

    const second = await cleanupTicketCheckout(git, root, "STA-6", {
      checkpoint,
      targetBranch: "main",
    });

    expect(second.ok).toBe(true);
    expect(second.alreadyCleaned).toBe(true);
    expect(second.worktreeRemoved).toBe(false);
    expect(second.branchRemoved).toBe(false);
    expect(second.detail).toContain("already cleaned");
    expect(git.cleanOfForce()).toBe(true);
  });

  test("finishes a leftover merged branch whose worktree is already gone", async () => {
    const { root, git } = await initRepo();
    const repo = await openTicket(root, git, "STA-7");
    const checkpoint = await ticketCommit(repo);
    await mergeTicket(git, root, repo.branch);
    await git.run(["worktree", "remove", repo.path], root);

    const outcome = await cleanupTicketCheckout(git, root, "STA-7", {
      checkpoint,
      targetBranch: "main",
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.worktreeRemoved).toBe(false);
    expect(outcome.branchRemoved).toBe(true);
    expect(await branchExists(git, root, repo.branch)).toBe(false);
    expect(git.cleanOfForce()).toBe(true);
  });

  test("keeps a leftover branch that was never merged", async () => {
    const { root, git } = await initRepo();
    const repo = await openTicket(root, git, "STA-8");
    const checkpoint = await ticketCommit(repo);
    await git.run(["worktree", "remove", repo.path], root);

    const outcome = await cleanupTicketCheckout(git, root, "STA-8", {
      checkpoint,
      targetBranch: "main",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("not reachable from main");
    expect(await branchExists(git, root, repo.branch)).toBe(true);
    expect(git.cleanOfForce()).toBe(true);
  });

  test("keeps everything when the worktree cannot be removed", async () => {
    const { root, git } = await initRepo();
    const repo = await openTicket(root, git, "STA-11");
    const checkpoint = await ticketCommit(repo);
    await mergeTicket(git, root, repo.branch);
    await git.run(["worktree", "lock", repo.path], root);

    const outcome = await cleanupTicketCheckout(git, root, "STA-11", {
      checkpoint,
      targetBranch: "main",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("cannot remove worktree");
    expect(await worktreeListed(git, root, repo.path)).toBe(true);
    expect(await branchExists(git, root, repo.branch)).toBe(true);
    expect(git.cleanOfForce()).toBe(true);
  });

  test("cleans against a non-default target branch", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "igniter-cleanup-")));
    const git = new RecordingGit(bunGitRunner());
    await git.run(["init", "-b", "trunk", root], tmpdir());
    await git.run(["config", "user.email", "test@example.test"], root);
    await git.run(["config", "user.name", "test"], root);
    await git.run(["config", "commit.gpgsign", "false"], root);
    writeFileSync(join(root, "base.txt"), "base\n");
    await git.run(["add", "base.txt"], root);
    await git.run(["commit", "-m", "base"], root);
    const derived = ticketWorktree(root, "STA-12");
    mkdirSync(dirname(derived.path), { recursive: true });
    await git.run(["worktree", "add", "-b", derived.branch, derived.path, "trunk"], root);
    writeFileSync(join(derived.path, "feature.txt"), "ticket work\n");
    await git.run(["add", "feature.txt"], derived.path);
    await git.run(["commit", "-m", "ticket work"], derived.path);
    const checkpoint = (await git.run(["rev-parse", "HEAD"], derived.path)).stdout.trim();
    await git.run(["merge", "--no-ff", "-m", `merge ${derived.branch}`, derived.branch], root);

    const outcome = await cleanupTicketCheckout(git, root, "STA-12", {
      checkpoint,
      targetBranch: "trunk",
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.worktreeRemoved).toBe(true);
    expect(outcome.branchRemoved).toBe(true);
    expect(await worktreeListed(git, root, derived.path)).toBe(false);
    expect(await branchExists(git, root, derived.branch)).toBe(false);
    expect(git.cleanOfForce()).toBe(true);
  });

  test("refuses when the target branch is the ticket branch itself", async () => {
    const { root, git } = await initRepo();

    const outcome = await cleanupTicketCheckout(git, root, "STA-13", {
      checkpoint: "deadbeef",
      targetBranch: "feature/sta-13",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("ticket branch itself");
    expect(git.cleanOfForce()).toBe(true);
  });

  test("keeps everything when the target branch does not exist", async () => {
    const { root, git } = await initRepo();
    const repo = await openTicket(root, git, "STA-10");
    const checkpoint = await ticketCommit(repo);
    await mergeTicket(git, root, repo.branch);

    const outcome = await cleanupTicketCheckout(git, root, "STA-10", {
      checkpoint,
      targetBranch: "trunk",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("trunk");
    expect(await worktreeListed(git, root, repo.path)).toBe(true);
    expect(await branchExists(git, root, repo.branch)).toBe(true);
    expect(git.cleanOfForce()).toBe(true);
  });
});
