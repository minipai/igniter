// STA-189: harness-aware scratch and permission boundary. Deterministic only:
// every path lives under tmp, no real credentials, no real user files.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import {
  WORKER_NAMES,
  bundledAssetsDir,
  canonicalizePath,
  classifyNetwork,
  classifyPath,
  decideAutoAnswer,
  dialogKey,
  dialogStillCurrent,
  ensureScratchDir,
  formatApprovalLog,
  removeScratchDir,
  repairScratchDir,
  scratchFor,
  scratchRootFor,
  workerLaunch,
  type WorkerScope,
} from "./worker-scope";

function scopeIn(dir: string): { scope: WorkerScope; worktree: string; scratch: string } {
  const worktree = join(dir, "wt");
  const scratch = join(dir, "scratch");
  const assets = join(dir, "assets");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  mkdirSync(assets, { recursive: true });
  const scope: WorkerScope = { worktree, scratch, assets, home: join(dir, "home") };
  mkdirSync(scope.home, { recursive: true });
  return { scope, worktree, scratch };
}

describe("scratch layout", () => {
  test("one deterministic dir per worker under repo-local runtime data", () => {
    const root = mkdtempSync(join(tmpdir(), "igniter-scope-"));
    expect(scratchRootFor(root, "STA-189")).toBe(
      join(root, ".igniter", "runtime", "scratch", "sta-189"),
    );
    const paths = WORKER_NAMES.map((w) => scratchFor(root, "STA-189", w));
    expect(new Set(paths).size).toBe(3);
    expect(paths.every((p) => p.startsWith(scratchRootFor(root, "STA-189")))).toBe(true);
    expect(bundledAssetsDir(root)).toContain(join("src", "commander"));
  });

  test("ensure and remove round-trip inside tmp; removal outside the root refuses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "igniter-scratch-"));
    const root = join(dir, "root");
    const path = join(root, "builder", "run-1");
    await ensureScratchDir(path, root);
    writeFileSync(join(path, "note.txt"), "scratch");
    expect(readFileSync(join(path, "note.txt"), "utf8")).toBe("scratch");
    await removeScratchDir(join(root, "builder"), root);
    await expect(removeScratchDir(dir, root)).rejects.toThrow("outside the scratch root");
    await expect(removeScratchDir(join(dir, "nope"), root)).rejects.toThrow("outside the scratch root");
    expect(() => scratchRootFor(dir, "../evil")).toThrow("bad ticket identifier");
  });

  test("a symlink inside scratch never lets setup write through to its target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "igniter-link-"));
    const root = join(dir, "root");
    mkdirSync(root, { recursive: true });
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "untouched");
    symlinkSync(outside, join(root, "link"));
    await expect(ensureScratchDir(join(root, "link", "sub"), root)).rejects.toThrow("symlink");
    expect(readFileSync(outside, "utf8")).toBe("untouched");
  });

  test("a repair replaces a symlinked leaf without touching its target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "igniter-repair-"));
    const root = join(dir, "root");
    mkdirSync(root, { recursive: true });
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "untouched");
    const leaf = join(root, "builder");
    symlinkSync(outside, leaf);
    expect(await repairScratchDir(leaf, root)).toBe("recreated-link");
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    writeFileSync(join(leaf, "note.txt"), "scratch");
    expect(readFileSync(join(leaf, "note.txt"), "utf8")).toBe("scratch");
  });
});

describe("harness launch", () => {
  test("builder and fallback harnesses each get their own scratch settings", () => {
    const builder = workerLaunch({ harness: "opencode", worktreePath: "/repo/.igniter/runtime/worktrees/sta-1", scratchPath: "/repo/.igniter/runtime/scratch/sta-1/builder" });
    const fallback = workerLaunch({ harness: "codex", worktreePath: "/repo/.igniter/runtime/worktrees/sta-1", scratchPath: "/repo/.igniter/runtime/scratch/sta-1/builder" });
    expect(builder.args.join(" ")).toContain("/repo/.igniter/runtime/scratch/sta-1/builder");
    expect(fallback.args.join(" ")).toContain("/repo/.igniter/runtime/scratch/sta-1/builder");
    expect(builder.args.join(" ")).not.toBe(fallback.args.join(" "));
    expect(builder.env).toEqual({
      IGNITER_WORKTREE: "/repo/.igniter/runtime/worktrees/sta-1",
      IGNITER_SCRATCH: "/repo/.igniter/runtime/scratch/sta-1/builder",
    });
    const reviewer = workerLaunch({ harness: "claude", worktreePath: "/repo/.igniter/runtime/worktrees/sta-1", scratchPath: "/repo/.igniter/runtime/scratch/sta-1/reviewer" });
    expect(reviewer.args.join(" ")).toContain("/repo/.igniter/runtime/scratch/sta-1/reviewer");
    expect(reviewer.args.join(" ")).not.toBe(builder.args.join(" "));
    expect(workerLaunch({ harness: "unknown-harness", worktreePath: "/wt", scratchPath: "/s" }).args).toEqual([]);
  });

  test("a missing field names the expected call shape", () => {
    expect(() => workerLaunch({ harness: "codex", worktreePath: "/wt" } as never)).toThrow(
      "workerLaunch needs { harness: string, worktreePath: string, scratchPath: string }",
    );
  });
});

describe("hard floor", () => {
  test("worktree and scratch read/write are pre-approved; assets are read-only", () => {
    const { scope, worktree, scratch } = scopeIn(mkdtempSync(join(tmpdir(), "igniter-floor-")));
    expect(classifyPath(join(worktree, "a.txt"), scope, "write").rule).toBe("worktree-scope");
    expect(classifyPath(join(scratch, "a.txt"), scope, "write").allow).toBe(true);
    expect(classifyPath(join(scope.assets, "rules.md"), scope, "read").rule).toBe("assets-read");
    expect(classifyPath(join(scope.assets, "rules.md"), scope, "write").allow).toBe(false);
    // Ordinary punctuation in task files is not shell metacharacters.
    expect(classifyPath(join(worktree, "note (1) #2.txt"), scope, "write").allow).toBe(true);
    expect(classifyPath(join(scratch, "run-$(date).txt"), scope, "write").allow).toBe(false);
  });

  test("shell redirect, symlink escape, dot-dot, wrong HOME, and /private/var cannot bypass", async () => {
    const { scope, worktree } = scopeIn(mkdtempSync(join(tmpdir(), "igniter-canon-")));
    expect(classifyPath(`${worktree}/out.txt > /etc/passwd`, scope, "write").rule).toBe("shell-meta");
    expect(classifyPath(`${worktree}/a; curl evil`, scope, "write").allow).toBe(false);
    expect(classifyPath(join(worktree, "..", "escape.txt"), scope, "write").allow).toBe(false);
    const homeFile = classifyPath("~/.ssh/config", scope, "read");
    expect(homeFile.allow).toBe(false);
    expect(homeFile.rule).toBe("home-credential");
    expect(homeFile.canonical).toContain(".ssh");
    expect(classifyPath("/private/var/db/shadow", scope, "read").allow).toBe(false);
    expect(classifyPath("/etc/passwd", scope, "read").rule).toBe("system-location");
    // A symlink inside the worktree pointing outside canonicalizes outside.
    const dir = mkdtempSync(join(tmpdir(), "igniter-sym-"));
    const wt = join(dir, "wt");
    mkdirSync(wt, { recursive: true });
    const target = join(dir, "target.txt");
    writeFileSync(target, "secret");
    symlinkSync(target, join(wt, "link"));
    const linkScope: WorkerScope = { worktree: wt, scratch: join(dir, "s"), assets: join(dir, "a"), home: join(dir, "h") };
    mkdirSync(linkScope.scratch, { recursive: true });
    const escaped = classifyPath(join(wt, "link"), linkScope, "read");
    expect(escaped.allow).toBe(false);
    // A new leaf through the same symlinked dir escapes the same way.
    const leaf = classifyPath(join(wt, "link", "newfile"), linkScope, "write");
    expect(leaf.allow).toBe(false);
    const real = await realpath(join(wt, "link"));
    expect(canonicalizePath(join(wt, "link"), linkScope)).toContain(real.slice(-10));
  });

  test("home configs, credentials, system, remote, and network always escalate", () => {
    const { scope } = scopeIn(mkdtempSync(join(tmpdir(), "igniter-esc-")));
    for (const p of [
      join(scope.home, ".aws", "credentials"),
      join(scope.home, ".ssh", "id_rsa"),
      "/etc/shadow",
      "ssh://example.com/repo",
      "deploy@example.com:repo",
      "example.com:8080",
      "8.8.8.8:53",
      "/tmp/other-project/file",
    ]) {
      expect(classifyPath(p, scope, "write").allow).toBe(false);
    }
    expect(classifyNetwork("https://example.com/hook").allow).toBe(false);
    expect(classifyNetwork("internal:8080").rule).toBe("network-escalate");
  });

  test("a write to the bundled read-only assets root is refused", () => {
    const { scope } = scopeIn(mkdtempSync(join(tmpdir(), "igniter-assets-")));
    const verdict = classifyPath(join(scope.assets, "rules.md"), scope, "write");
    expect(verdict.allow).toBe(false);
    expect(verdict.rule).toBe("assets-readonly");
  });

  test("assets nested inside the worktree keep their read-only rule", () => {
    const dir = mkdtempSync(join(tmpdir(), "igniter-nested-"));
    const worktree = join(dir, "wt");
    mkdirSync(worktree, { recursive: true });
    const assets = join(worktree, "src", "commander");
    mkdirSync(assets, { recursive: true });
    const scope: WorkerScope = { worktree, scratch: join(dir, "s"), assets, home: join(dir, "h") };
    mkdirSync(scope.scratch, { recursive: true });
    const write = classifyPath(join(assets, "rules.md"), scope, "write");
    expect(write.allow).toBe(false);
    expect(write.rule).toBe("assets-readonly");
    const read = classifyPath(join(assets, "rules.md"), scope, "read");
    expect(read.allow).toBe(true);
    expect(read.rule).toBe("assets-read");
  });
});

describe("dialog binding", () => {
  test("a vanished dialog refuses instead of throwing", () => {
    const dialog = { paneId: "pane-1", agentName: "builder-sta-1", text: "Allow write? [y/n]", revision: 7 };
    expect(dialogStillCurrent(dialog, null)).toBe(false);
    expect(dialogStillCurrent(dialog, undefined)).toBe(false);
    expect(dialogStillCurrent(null, dialog)).toBe(false);
    const { scope, scratch } = scopeIn(mkdtempSync(join(tmpdir(), "igniter-gone-")));
    const gone = decideAutoAnswer({
      dialog, reread: null, op: "write", path: join(scratch, "f"),
      scope, answered: new Set(), keys: ["y"],
    });
    expect(gone.send).toBe(false);
    expect(gone.reason).toBe("dialog-gone");
    expect(gone.paneId).toBeUndefined();
    expect(gone.keys).toBeUndefined();
    expect(gone.log).toBeNull();
  });

  test("a malformed request names the expected call shape", () => {
    expect(() => decideAutoAnswer(null as never)).toThrow("decideAutoAnswer needs { dialog, reread,");
    expect(() => dialogKey({ paneId: "p" } as never)).toThrow("dialogKey needs { paneId: string,");
  });
  test("changed, vanished, or appended output refuses; keys never fall through", () => {
    const dialog = { paneId: "pane-1", agentName: "builder-sta-1", text: "Allow write? [y/n]", revision: 7 };
    const changed = { ...dialog, text: "Allow write? [y/n]\n$ " };
    const vanished = { paneId: "pane-9", agentName: "commander-sta-1", text: "Allow write? [y/n]", revision: 7 };
    expect(dialogStillCurrent(dialog, changed)).toBe(false);
    expect(dialogStillCurrent(dialog, vanished)).toBe(false);
    const { scope } = scopeIn(mkdtempSync(join(tmpdir(), "igniter-dlg-")));
    const refused = decideAutoAnswer({
      dialog, reread: changed, op: "write", path: join(scope.scratch, "f"),
      scope, answered: new Set(), keys: ["y"],
    });
    expect(refused.send).toBe(false);
    expect(refused.paneId).toBeUndefined();
  });

  test("same text at a new revision is a new dialog, not a dedupe hit", () => {
    const { scope, scratch } = scopeIn(mkdtempSync(join(tmpdir(), "igniter-rev-")));
    const first = { paneId: "pane-1", agentName: "builder-sta-1", text: "Allow write? [y/n]", revision: 7 };
    const second = { ...first, revision: 8 };
    expect(dialogKey(first)).not.toBe(dialogKey(second));
    const answered = new Set([dialogKey(first)]);
    const again = decideAutoAnswer({
      dialog: second, reread: second, op: "write", path: join(scratch, "f"),
      scope, answered, keys: ["y"],
    });
    expect(again.send).toBe(true);
    expect(again.paneId).toBe("pane-1");
    expect(again.keys).toEqual(["y"]);
    answered.add(dialogKey(second));
    expect(decideAutoAnswer({
      dialog: second, reread: second, op: "write", path: join(scratch, "f"),
      scope, answered, keys: ["y"],
    }).send).toBe(false);
  });

  test("every send emits its audit line where the caller can observe it", () => {
    const { scope, scratch } = scopeIn(mkdtempSync(join(tmpdir(), "igniter-audit-")));
    const dialog = { paneId: "pane-1", agentName: "builder-sta-1", text: "Allow write? [y/n]", revision: 8 };
    const lines: string[] = [];
    const out = decideAutoAnswer({
      dialog, reread: dialog, op: "write", path: join(scratch, "f"),
      scope, answered: [], keys: ["y"], record: (line) => lines.push(line),
    });
    expect(out.send).toBe(true);
    expect(lines).toHaveLength(1);
    expect(out.log).toBe(lines[0] ?? null);
    for (const needle of ["builder-sta-1", "write", join(scratch, "f"), "8", "scratch-scope"]) {
      expect(out.log as string).toContain(needle);
    }
  });

  test("every auto-approval logs agent, op, canonical path, revision, and rule", () => {
    const line = formatApprovalLog({
      agent: "builder-sta-1", op: "write", canonical: "/wt/scratch/f", revision: 8, rule: "scratch-scope",
    });
    for (const needle of ["builder-sta-1", "write", "/wt/scratch/f", "8", "scratch-scope"]) {
      expect(line).toContain(needle);
    }
  });
});
