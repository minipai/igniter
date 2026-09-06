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
  /** HEAD sha served for `git rev-parse HEAD` in any cwd. */
  head = "abc123def456";
  /** Stdout served for `git status --porcelain` in any cwd. */
  statusPorcelain = "";
  /** `merge-base --is-ancestor` pairs that succeed, as "<commit> <target>". */
  ancestors = new Set<string>();
  /** Methods (first arg) that fail, e.g. ["worktree"]. */
  failOn: string[] = [];
  failMessage = "fatal: fake git exploded";

  async run(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    this.commands.push({ args: [...args], cwd });
    if (args.includes("--force") || args.includes("-D")) {
      throw new Error("fake git refuses destructive flags: cleanup never uses --force or -D");
    }
    if (this.failOn.includes(args[0] as string)) {
      throw new Error(this.failMessage);
    }
    if (args[0] === "worktree" && args[1] === "list") {
      return { stdout: this.worktreeList, stderr: "" };
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      const path = String(args[2]);
      if (!this.dropWorktree(path)) {
        throw new Error(`fatal: '${path}' is not a working tree`);
      }
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "branch" && args[1] === "-d") {
      const branch = String(args[2]);
      const at = this.branches.indexOf(branch);
      if (at < 0) {
        throw new Error(`error: branch '${branch}' not found`);
      }
      // Like real `git branch -d`: refuse a branch whose tip is not known
      // merged, so a removed ancestor check fails the tests that rely on it.
      if (![...this.ancestors].some((key) => key.startsWith(`${branch} `))) {
        throw new Error(`error: The branch '${branch}' is not fully merged`);
      }
      this.branches.splice(at, 1);
      return { stdout: `Deleted branch ${branch}\n`, stderr: "" };
    }
    if (args[0] === "status" && args[1] === "--porcelain") {
      return { stdout: this.statusPorcelain, stderr: "" };
    }
    if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
      const key = `${String(args[2])} ${String(args[3])}`;
      if (this.ancestors.has(key)) return { stdout: "", stderr: "" };
      throw new Error(`fatal: '${String(args[2])}' is not an ancestor of '${String(args[3])}'`);
    }
    if (args[0] === "rev-parse") {
      const ref = String(args[args.length - 1]);
      if (ref === "HEAD") return { stdout: `${this.head}\n`, stderr: "" };
      const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      if (this.branches.includes(branch)) return { stdout: "abc123\n", stderr: "" };
      throw new Error(`fatal: Needed a single revision: ${ref}`);
    }
    return { stdout: "", stderr: "" };
  }

  /** Drop one `worktree <path>` block from the listed output. */
  private dropWorktree(path: string): boolean {
    const lines = this.worktreeList.split("\n");
    const kept: string[] = [];
    let dropping = false;
    let dropped = false;
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        dropping = line === `worktree ${path}`;
        if (dropping) dropped = true;
      }
      if (!dropping) kept.push(line);
    }
    if (dropped) this.worktreeList = kept.join("\n");
    return dropped;
  }
}
