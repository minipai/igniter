import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ensureProjectConfig } from "./cli/init.ts";
import type { CommandRequest } from "./workflow/request.ts";
import { runCli, type CliRuntime } from "./cli.ts";

const cli = new URL("./cli.ts", import.meta.url).pathname;
const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string };

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runProcess(args: readonly string[], cwd = tmpdir()): Promise<CliResult> {
  const proc = Bun.spawn(["bun", cli, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

function fakeRuntime(input = "{}"): {
  runtime: CliRuntime;
  seen: CommandRequest[];
  output: () => CliResult;
} {
  const seen: CommandRequest[] = [];
  let stdout = "";
  let stderr = "";
  let code = 0;
  const runtime: CliRuntime = {
    run: async (command) => {
      seen.push(command);
      return {
        ok: true,
        text: command.command,
        ...(command.command === "start"
          ? { data: { kind: "commander_foreground", command: ["true"], cwd: tmpdir() } }
          : {}),
      };
    },
    readStdin: async () => input,
    stdout: (text) => {
      stdout += `${text}\n`;
    },
    stderr: (text) => {
      stderr += `${text}\n`;
    },
    launch: async () => 0,
  };
  return { runtime, seen, output: () => ({ stdout, stderr, code }) };
}

async function runInProcess(args: string[], input = "{}"): Promise<CliResult & { seen: CommandRequest[] }> {
  const fake = fakeRuntime(input);
  const code = await runCli(args, fake.runtime);
  return { ...fake.output(), code, seen: fake.seen };
}

describe("project initialization", () => {
  test("an existing project config is reused without prompting", async () => {
    const root = tempGitRepo();
    const nested = join(root, "src", "nested");
    mkdirSync(join(root, ".igniter"));
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, ".igniter", "config.yaml"), "project: existing\n");
    let prompts = 0;

    try {
      expect(await ensureProjectConfig(nested, {
        interactive: true,
        read: async () => {
          prompts += 1;
          return "y";
        },
      })).toEqual({ root, created: false });
      expect(prompts).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("confirmation creates a minimal config at the Git root", async () => {
    const root = tempGitRepo();
    const nested = join(root, "src", "nested");
    mkdirSync(nested, { recursive: true });
    const questions: string[] = [];

    try {
      expect(await ensureProjectConfig(nested, {
        interactive: true,
        read: async (question) => {
          questions.push(question);
          return "yes";
        },
      })).toEqual({ root, created: true });
      expect(questions).toEqual([
        `No .igniter/config.yaml found in ${root}. Initialize Igniter for "${basename(root)}"? [y/N] `,
      ]);
      expect(await Bun.file(join(root, ".igniter", "config.yaml")).text()).toBe(
        `project: ${JSON.stringify(basename(root))}\n`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("declining initialization leaves the repository unchanged", async () => {
    const root = tempGitRepo();

    try {
      await expect(ensureProjectConfig(root, {
        interactive: true,
        read: async () => "n",
      })).rejects.toThrow("initialization cancelled; no files changed");
      expect(await Bun.file(join(root, ".igniter", "config.yaml")).exists()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-interactive startup gives instructions without reading input", async () => {
    const root = tempGitRepo();
    let reads = 0;

    try {
      await expect(ensureProjectConfig(root, {
        interactive: false,
        read: async () => {
          reads += 1;
          return "y";
        },
      })).rejects.toThrow("Run `igniter start` in an interactive terminal");
      expect(reads).toBe(0);
      expect(await Bun.file(join(root, ".igniter", "config.yaml")).exists()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the real CLI exits instead of waiting when startup is non-interactive", async () => {
    const root = tempGitRepo();

    try {
      const result = await runProcess(["start"], root);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Run `igniter start` in an interactive terminal");
      expect(await Bun.file(join(root, ".igniter", "config.yaml")).exists()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function tempGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "igniter-init-"));
  const result = Bun.spawnSync(["git", "init", "-q", "-b", "main"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return realpathSync(root);
}

describe("CLI metadata", () => {
  test.each(["--version", "-v"])("%s prints the package version", async (flag) => {
    const result = await runProcess([flag]);
    expect(result).toEqual({ stdout: `${pkg.version}\n`, stderr: "", code: 0 });
  });

  test("usage groups worker subcommands", async () => {
    const result = await runProcess([]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("igniter <command>");
    expect(result.stdout).toContain("approve <ticket>");
    expect(result.stdout).toContain("worker restart <ticket>");
    expect(result.stdout).not.toContain("serve");
    expect(result.stdout).not.toContain("publish-review");
  });

  test.each(["pause", "resume", "serve", "dev"])("removed %s command is rejected", async (command) => {
    const result = await runProcess([command]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Unknown command: ${command}`);
  });
});

describe("CAC command actions", () => {
  test("each declaration constructs the typed command it owns", async () => {
    const cases: { argv: string[]; request: CommandRequest; input?: string }[] = [
      { argv: ["status"], request: { command: "status" } },
      { argv: ["status", "STA-1", "--json"], request: { command: "status", ticket: "STA-1", json: true } },
      { argv: ["start"], request: { command: "start" } },
      { argv: ["begin", "STA-1"], request: { command: "begin", ticket: "STA-1" } },
      { argv: ["reconcile", "STA-1"], request: { command: "reconcile", ticket: "STA-1" } },
      { argv: ["approve", "STA-1", "--receipt", "r-1"], request: { command: "approve", ticket: "STA-1", receipt: "r-1" } },
      { argv: ["fail", "STA-1", "--reason", "wedged"], request: { command: "fail", ticket: "STA-1", reason: "wedged" } },
      { argv: ["submit", "STA-1", "--input", "-"], request: { command: "submit", ticket: "STA-1", payload: { ok: true } }, input: '{"ok":true}' },
      { argv: ["block", "STA-1", "--reason", "waiting"], request: { command: "block", ticket: "STA-1", reason: "waiting" } },
      { argv: ["unblock", "STA-1"], request: { command: "unblock", ticket: "STA-1" } },
      { argv: ["cancel", "STA-1", "--reason", "owner decided"], request: { command: "cancel", ticket: "STA-1", reason: "owner decided" } },
      { argv: ["worker", "start", "STA-1", "--role", "build"], request: { command: "worker.start", ticket: "STA-1", role: "build" } },
      { argv: ["worker", "send", "STA-1", "--role", "review", "check", "this"], request: { command: "worker.send", ticket: "STA-1", role: "review", text: "check this" } },
      { argv: ["worker", "stop", "STA-1", "--role", "deliver"], request: { command: "worker.stop", ticket: "STA-1", role: "deliver" } },
      { argv: ["worker", "restart", "STA-1", "--profile", "fallback", "--harness", "codex", "--model", "m", "--effort", "high"], request: { command: "worker.restart", ticket: "STA-1", profile: "fallback", harness: "codex", model: "m", effort: "high" } },
      { argv: ["worker", "answer", "STA-1", "y"], request: { command: "worker.answer", ticket: "STA-1", answer: "y" } },
    ];

    for (const testCase of cases) {
      const result = await runInProcess(testCase.argv, testCase.input);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.seen).toEqual([testCase.request]);
    }
  });

  test("a refused command exits 1 with the command result", async () => {
    const fake = fakeRuntime();
    fake.runtime.run = async (command) => {
      fake.seen.push(command);
      return { ok: false, text: "ticket was refused" };
    };
    const code = await runCli(["begin", "STA-9"], fake.runtime);
    expect(code).toBe(1);
    expect(fake.output().stderr).toContain("ticket was refused");
  });

  test("start propagates the foreground Commander's exit code", async () => {
    const fake = fakeRuntime();
    fake.runtime.launch = async () => 7;
    expect(await runCli(["start"], fake.runtime)).toBe(7);
  });
});

describe("CAC validation and help", () => {
  test.each([
    { args: ["--help"], usage: "igniter <command>", option: "--version" },
    { args: ["status", "--help"], usage: "igniter status [ticket]", option: "--json" },
    { args: ["start", "--help"], usage: "igniter start", option: "--help" },
    { args: ["approve", "--help"], usage: "igniter approve <ticket>", option: "--receipt <id>" },
    { args: ["submit", "--help"], usage: "igniter submit <ticket>", option: "--input <source>" },
    { args: ["cancel", "--help"], usage: "igniter cancel <ticket>", option: "--reason <text>" },
    { args: ["worker", "--help"], usage: "igniter worker <command>", option: "restart <ticket>" },
    { args: ["worker", "restart", "--help"], usage: "igniter worker restart <ticket>", option: "--model <model>" },
  ])("help comes from its CAC declaration: $args", async ({ args, usage, option }) => {
    const result = await runProcess(args);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(usage);
    expect(result.stdout).toContain(option);
    expect(result.stderr).toBe("");
  });

  test.each([
    ["begin"], ["approve", "STA-1"], ["fail", "STA-1"], ["submit", "STA-1"],
    ["block", "STA-1"], ["cancel", "STA-1"], ["worker", "send", "STA-1"], ["worker", "answer", "STA-1"],
    ["status", "--bogus"], ["start", "STA-1"], ["start", "STA-1", "--publish-review"],
    ["worker", "start", "STA-1", "--role", "other"],
    ["worker", "restart", "STA-1", "--profile", "other"],
    ["worker", "answer", "STA-1", "yes"],
  ].map((argv) => ({ argv })))("invalid syntax never runs a command: $argv", async ({ argv }) => {
    const result = await runInProcess(argv);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toBe("");
    expect(result.seen).toEqual([]);
  });

  test("submit rejects malformed JSON before dispatch", async () => {
    const result = await runInProcess(["submit", "STA-1", "--input", "-"], "{not-json");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("submit input is not JSON");
    expect(result.seen).toEqual([]);
  });
});
