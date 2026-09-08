// Shared harness for black-box CLI end-to-end tests (test-only fixture).
//
// Shape per test: a real temp git repo, the real dispatch HTTP service in
// this process (real routing, real protocol, real git runner), the stateful
// memory Linear client, and fake Herdr workspaces. The real CLI runs as a
// subprocess with `cwd` set to the temp repo and a whitelisted environment
// (fake key, no real credentials), finding the service through the temp
// repo's `.igniter/config.yaml`.
//
// Rules enforced here, not per test:
// - only temp dirs/ports/processes; everything is tracked and removed;
// - no fixed sleeps for state: `waitFor` polls with a deadline;
// - every CLI result carries stdout/stderr/exit for failure diagnosis.
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parseDispatchConfig } from "../dispatch/config.ts";
import { MemoryLinearClient, ownerSetState, standardMemoryWorld, type MemoryWorld } from "../dispatch/fake-memory-linear.ts";
import { FakeWorkspaces } from "../dispatch/fake-workspaces.ts";
import { startDispatchServe, type DispatchServeHandle } from "../server/dispatch-serve.ts";
import type { PromptDeliveryPolicy } from "../dispatch/prompt-delivery.ts";
import type { DispatchConfig } from "../dispatch/config.ts";

export const CLI_PATH = new URL("../cli.ts", import.meta.url).pathname;

export const CRITERIA = "## 驗收條件\n- [ ] works\n";

export interface CliResult {
  argv: string[];
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

/** Fast confirmation budget: failure paths settle in ~100ms, never 12s. */
export const FAST_DELIVERY: PromptDeliveryPolicy = {
  maxAttempts: 1,
  pollAttempts: 5,
  pollIntervalMs: 15,
};

export function git(args: string[], cwd: string): { stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} exited with ${proc.exitCode}: ${(stderr || stdout).trim()}`);
  }
  return { stdout, stderr };
}

/** A real temp git repo on `main` with one commit, repo-local identity. */
export function initTempRepo(prefix = "igniter-e2e-repo-"): { dir: string } {
  // Git reports canonical worktree paths. macOS exposes /var as a symlink to
  // /private/var, so keep the fixture root canonical too or a second stage
  // would mistake its already-listed worktree for an unlisted directory.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "e2e@example.com"], dir);
  git(["config", "user.name", "e2e"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  writeFileSync(join(dir, "README.md"), "# e2e fixture\n");
  git(["add", "README.md"], dir);
  git(["commit", "-m", "initial"], dir);
  return { dir };
}

export function mainHead(repoDir: string): string {
  return git(["rev-parse", "HEAD"], repoDir).stdout.trim();
}

export function worktreeHeadOf(repoDir: string, ticket: string): string {
  const wt = join(repoDir, ".igniter", "runtime", "worktrees", ticket.toLowerCase());
  return git(["rev-parse", "HEAD"], wt).stdout.trim();
}

export interface E2EOptions {
  maxRunning?: number;
  promptDelivery?: PromptDeliveryPolicy;
  repoPrefix?: string;
  config?: Record<string, unknown>;
}

export interface SpawnedCli {
  proc: ReturnType<typeof Bun.spawn>;
  done: Promise<CliResult>;
  kill: () => void;
}

export class E2E {
  readonly repoDir: string;
  readonly world: MemoryWorld;
  readonly client: MemoryLinearClient;
  readonly workspaces = new FakeWorkspaces();
  readonly decisions: string[] = [];
  readonly transcripts: CliResult[] = [];
  handle!: DispatchServeHandle;
  port = 0;
  readonly stubBin: string;
  readonly config: DispatchConfig;
  private closed = false;

  private constructor(repoDir: string, world: MemoryWorld, stubBin: string, config: DispatchConfig) {
    this.repoDir = repoDir;
    this.world = world;
    this.client = new MemoryLinearClient(world);
    this.stubBin = stubBin;
    this.config = config;
  }

  static async boot(options: E2EOptions = {}): Promise<E2E> {
    const { dir } = initTempRepo(options.repoPrefix);
    const stubBin = mkdtempSync(join(tmpdir(), "igniter-e2e-bin-"));
    const maxRunning = options.maxRunning ?? 3;
    const config = parseDispatchConfig({
      project: "igniter",
      team: "Starcoder",
      max_running: maxRunning,
      ...options.config,
    });
    const e2e = new E2E(dir, standardMemoryWorld(), stubBin, config);
    e2e.handle = await startDispatchServe({
      repoRoot: dir,
      config,
      client: e2e.client,
      workspaces: e2e.workspaces,
      port: 0,
      print: (line: string) => {
        e2e.decisions.push(line);
      },
      promptDelivery: options.promptDelivery ?? FAST_DELIVERY,
    });
    const port = e2e.handle.server.port;
    if (port === undefined) throw new Error("dispatch service has no port");
    e2e.port = port;
    mkdirSync(join(dir, ".igniter"), { recursive: true });
    writeFileSync(
      join(dir, ".igniter", "config.yaml"),
      `project: igniter\nteam: Starcoder\nlisten: "127.0.0.1:${port}"\nmax_running: ${maxRunning}\n`,
    );
    return e2e;
  }

  /** Install a fake foreground agent binary (e.g. `codex`) that records its argv. */
  stubForegroundAgent(binary: string, marker: string): void {
    writeFileSync(
      join(this.stubBin, binary),
      `#!/bin/sh\nprintf '%s\\n' "$@" >> "${marker}.args"\nprintenv > "${marker}.env"\npwd > "${marker}.cwd"\ntouch "${marker}"\n`,
      { mode: 0o755 },
    );
  }

  childEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: `${this.stubBin}${delimiter}${process.env["PATH"] ?? ""}`,
      HOME: process.env["HOME"] ?? "",
      TMPDIR: process.env["TMPDIR"] ?? tmpdir(),
      TZ: "UTC",
      NO_COLOR: "1",
      LINEAR_API_KEY: "e2e-fake-key",
      HERDR_ENV: "0",
      ...extra,
    };
  }

  spawnCli(
    argv: string[],
    options: { stdin?: string; env?: Record<string, string>; timeoutMs?: number; cwd?: string } = {},
  ): SpawnedCli {
    const proc = Bun.spawn([process.execPath, CLI_PATH, ...argv], {
      cwd: options.cwd ?? this.repoDir,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      env: this.childEnv(options.env),
    });
    if (options.stdin !== undefined) {
      proc.stdin.write(options.stdin);
    }
    void proc.stdin.end();
    const timeoutMs = options.timeoutMs ?? 90_000;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const done: Promise<CliResult> = (async () => {
      const settled = new Promise<"exited" | "timeout">((resolve) => {
        killTimer = setTimeout(() => resolve("timeout"), timeoutMs);
        void proc.exited.then(() => resolve("exited"));
      });
      const outcome = await settled;
      if (outcome === "timeout") {
        timedOut = true;
        proc.kill();
      }
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (killTimer) clearTimeout(killTimer);
      const result: CliResult = { argv, stdout, stderr, code, timedOut };
      this.transcripts.push(result);
      return result;
    })();
    return { proc, done, kill: () => proc.kill() };
  }

  /** Run the real CLI to completion and record the transcript. */
  async cli(
    argv: string[],
    options: { stdin?: string; env?: Record<string, string>; timeoutMs?: number; cwd?: string } = {},
  ): Promise<CliResult> {
    return this.spawnCli(argv, options).done;
  }

  /** Poll until `read` returns a value; throw with packed diagnosis past the deadline. */
  async waitFor<T>(label: string, read: () => T | null | undefined, timeoutMs = 15_000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const value = read();
      if (value !== null && value !== undefined && value !== false) return value as T;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for ${label}\n${this.diagnose()}`);
      }
      await Bun.sleep(25);
    }
  }

  async diagnose(): Promise<string> {
    let gitState = "";
    try {
      const status = git(["status", "--porcelain"], this.repoDir).stdout;
      const worktrees = git(["worktree", "list", "--porcelain"], this.repoDir).stdout;
      const branches = git(["branch", "--list"], this.repoDir).stdout;
      gitState = `git status:\n${status}\nworktrees:\n${worktrees}\nbranches:\n${branches}`;
    } catch (error) {
      gitState = `git unreadable: ${(error as Error).message}`;
    }
    const last = this.transcripts.slice(-4).map((t) =>
      `$ igniter ${t.argv.join(" ")} → exit ${t.code}\nstdout: ${t.stdout.slice(-2000)}\nstderr: ${t.stderr.slice(-2000)}`
    ).join("\n---\n");
    const calls = this.client.calls.slice(-20).map((c) => `${c.method} ${JSON.stringify(c.detail)}`).join("\n");
    const herdr = this.workspaces.calls.slice(-20).map((c) => `${c.method} ${JSON.stringify(c.params)}`).join("\n");
    return `transcripts:\n${last}\nmemory-linear calls:\n${calls}\nherdr calls:\n${herdr}\n${gitState}`;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.handle.stop();
    } finally {
      rmSync(this.repoDir, { recursive: true, force: true });
      rmSync(this.stubBin, { recursive: true, force: true });
    }
  }
}

/** Throw an Error packing stdout/stderr when the CLI did not succeed. */
export function expectOk(result: CliResult): CliResult {
  if (result.timedOut || result.code !== 0) {
    throw new Error(
      `expected exit 0 for \`igniter ${result.argv.join(" ")}\` (exit ${result.code}${result.timedOut ? ", timed out" : ""})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return result;
}

/** Throw an Error packing stdout/stderr when the CLI unexpectedly succeeded. */
export function expectFail(result: CliResult, contains: string): CliResult {
  if (result.code === 0) {
    throw new Error(
      `expected failure for \`igniter ${result.argv.join(" ")}\` but exited 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  const haystack = `${result.stdout}\n${result.stderr}`;
  if (!haystack.includes(contains)) {
    throw new Error(
      `expected \`igniter ${result.argv.join(" ")}\` to mention ${JSON.stringify(contains)}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Submit payloads: one acceptance criterion ("works"), matching CRITERIA.
// ---------------------------------------------------------------------------

export function buildPayload(head: string) {
  return {
    v: 1,
    kind: "build",
    checkpoint: head,
    checks: ["bun run check"],
    results: [{ criterion: "works", ok: true, note: "e2e" }],
    reproduction: "run bun run test:e2e in the worktree",
  };
}

export function reviewPayload(
  head: string,
  verdict: "pass" | "fail",
  evidenceUrl = "https://example.com/e2e/evidence-1",
) {
  return {
    v: 1,
    kind: "review",
    verdict,
    checkpoint: head,
    results: [
      {
        criterion: "works",
        expected: "works",
        actual: verdict === "pass" ? "works" : "broken",
        evidence: evidenceUrl,
        ok: verdict === "pass",
      },
    ],
    environment: "e2e temp repo, no network",
    reproduction: "run bun run test:e2e in the worktree",
  };
}

export function commandEvidencePayload(head: string, verdict: "pass" | "fail") {
  return {
    v: 1,
    kind: "review",
    verdict,
    checkpoint: head,
    results: [
      {
        criterion: "works",
        expected: "works",
        actual: verdict === "pass" ? "works" : "broken",
        evidence: {
          kind: "command",
          command: "bun run check",
          exitCode: verdict === "pass" ? 0 : 1,
          stdout: verdict === "pass" ? "all green" : "1 failing",
          stderr: "",
        },
        ok: verdict === "pass",
      },
    ],
    environment: "e2e temp repo, no network",
    reproduction: "run bun run test:e2e in the worktree",
  };
}

export function deliverPayload(head: string, landed: string = head) {
  return {
    v: 1,
    kind: "deliver",
    checkpoint: head,
    landed,
    lineage: `ticket branch contains ${head}, landed as ${landed}`,
    merge_ready: true,
    owner_actions: ["push the branch and confirm the deploy preview"],
  };
}

/** Commit a file on the ticket's worktree branch; returns the new HEAD. */
export function commitWorktreeFile(
  repoDir: string,
  ticket: string,
  name: string,
  content: string,
  message: string,
): string {
  const wt = join(repoDir, ".igniter", "runtime", "worktrees", ticket.toLowerCase());
  writeFileSync(join(wt, name), content);
  git(["add", name], wt);
  git(["commit", "-m", message], wt);
  return git(["rev-parse", "HEAD"], wt).stdout.trim();
}

/**
 * Owner handoff for a first Build: the ticket waits at Build+Complete, the
 * owner moves it to Review in Linear (Complete kept), and an explicit
 * reconcile converges it to Review+Pending.
 */
export async function ownerHandoff(e2e: E2E, ticket: string): Promise<void> {
  ownerSetState(e2e.world, ticket, "Review");
  expectOk(await e2e.cli(["reconcile", ticket]));
}
