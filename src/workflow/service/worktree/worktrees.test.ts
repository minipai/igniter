// Ticket worktrees against a scripted git: derivation, the three prep
// branches, and failures. No real repositories are touched.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceError } from "../../config/claims";
import { FakeGit } from "../../testing/fake-git";
import { ensureTicketWorktree, ticketWorktree, WORKTREE_BASE } from "./worktrees";

describe("ticketWorktree", () => {
  test("derives the repo-local runtime checkout path and the ticket branch", () => {
    expect(ticketWorktree("/Users/art/Dev/igniter", "STA-177")).toEqual({
      path: "/Users/art/Dev/igniter/.igniter/runtime/worktrees/sta-177",
      branch: "feature/sta-177",
    });
    expect(WORKTREE_BASE).toBe("main");
  });
});

describe("ensureTicketWorktree", () => {
  test("an already listed worktree is reused as is", async () => {
    const git = new FakeGit();
    git.worktreeList = "worktree /repo/.igniter/runtime/worktrees/sta-1\nHEAD abc\nbranch refs/heads/feature/sta-1\n";
    const worktree = await ensureTicketWorktree(git, "/repo", "STA-1");
    expect(worktree).toEqual({
      path: "/repo/.igniter/runtime/worktrees/sta-1",
      branch: "feature/sta-1",
    });
    expect(git.commands.map((c) => c.args)).toEqual([["worktree", "list", "--porcelain"]]);
  });

  test("an existing branch is checked out without -b", async () => {
    const root = mkdtempSync(join(tmpdir(), "igniter-runtime-root-"));
    const git = new FakeGit();
    git.branches = ["feature/sta-1"];
    const worktree = await ensureTicketWorktree(git, join(root, "repo"), "STA-1");
    expect(worktree.branch).toBe("feature/sta-1");
    expect(worktree.path).toBe(join(root, "repo", ".igniter", "runtime", "worktrees", "sta-1"));
    expect(git.commands.map((c) => c.args)).toEqual([
      ["worktree", "list", "--porcelain"],
      ["rev-parse", "--verify", "refs/heads/feature/sta-1"],
      ["worktree", "add", worktree.path, "feature/sta-1"],
    ]);
  });

  test("a fresh ticket gets a new branch off main", async () => {
    const root = mkdtempSync(join(tmpdir(), "igniter-runtime-root-"));
    const git = new FakeGit();
    const worktree = await ensureTicketWorktree(git, join(root, "repo"), "STA-1");
    expect(git.commands.map((c) => c.args)).toEqual([
      ["worktree", "list", "--porcelain"],
      ["rev-parse", "--verify", "refs/heads/feature/sta-1"],
      ["worktree", "add", "-b", "feature/sta-1", worktree.path, "main"],
    ]);
  });

  test("a git failure throws WorkspaceError with the stderr", async () => {
    const root = mkdtempSync(join(tmpdir(), "igniter-runtime-root-"));
    const git = new FakeGit();
    git.failOn = ["worktree"];
    git.failMessage = "fatal: not a git repository";
    const error = await ensureTicketWorktree(git, join(root, "repo"), "STA-1").catch((e) => e);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as Error).message).toContain("not a git repository");
  });
});
