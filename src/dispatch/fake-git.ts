// Scripted git for worktree tests: records commands, answers worktree
// lists and branch lookups from scripted state, fails on demand.

import type { GitRunner } from "./worktrees.ts";

export interface GitCommand {
  args: string[];
  cwd: string;
}

export class FakeGit implements GitRunner {
  commands: GitCommand[] = [];
  /** Stdout served for `git worktree list --porcelain`. */
  worktreeList = "";
  /** Branches `rev-parse --verify refs/heads/<branch>` answers for. */
  branches: string[] = [];
  /** Methods (first arg) that fail, e.g. ["worktree"]. */
  failOn: string[] = [];
  failMessage = "fatal: fake git exploded";

  async run(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    this.commands.push({ args: [...args], cwd });
    if (this.failOn.includes(args[0] as string)) {
      throw new Error(this.failMessage);
    }
    if (args[0] === "worktree" && args[1] === "list") {
      return { stdout: this.worktreeList, stderr: "" };
    }
    if (args[0] === "rev-parse") {
      const ref = String(args[args.length - 1]);
      const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      if (this.branches.includes(branch)) return { stdout: "abc123\n", stderr: "" };
      throw new Error(`fatal: Needed a single revision: ${ref}`);
    }
    return { stdout: "", stderr: "" };
  }
}
