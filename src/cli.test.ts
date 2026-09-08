import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("./cli.ts", import.meta.url).pathname;
const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
  version: string;
};

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runCli(args: string[], cwd?: string): Promise<CliResult> {
  return runCliFull(args, { cwd });
}

interface RunCliFullOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
}

async function runCliFull(args: string[], options: RunCliFullOptions = {}): Promise<CliResult> {
  const proc = Bun.spawn(["bun", cli, ...args], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: { ...process.env, ...options.env },
  });
  if (options.stdin !== undefined) {
    proc.stdin.write(options.stdin);
  }
  await proc.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("cli --version", () => {
  test("--version prints the package.json version and exits 0", async () => {
    const result = await runCli(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  test("-v behaves identically", async () => {
    const result = await runCli(["-v"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  test("version resolves from any directory", async () => {
    const result = await runCli(["--version"], tmpdir());
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  test("usage with no arguments lists --version and exits 1", async () => {
    const result = await runCli([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--version");
  });
});

// Black-box forwarding: the CLI is a thin client over POST /api/command.
// A fake dispatch server records what arrived; a temporary repo root points
// the CLI at it through `.igniter/config.yaml`. No Linear key, no daemon.

interface SeenCommand {
  argv: string[];
  workspaceId?: string;
  directStart?: boolean;
  input?: string;
}

function startFakeDispatch(reply: (seen: SeenCommand) => { ok: boolean; text: string; data?: unknown }): {
  port: number;
  seen: SeenCommand[];
  stop: () => void;
} {
  const seen: SeenCommand[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req: Request): Promise<Response> => {
      const body = (await req.json()) as SeenCommand;
      seen.push(body);
      return Response.json(reply(body));
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("fake dispatch has no port");
  return { port, seen, stop: () => server.stop() };
}

/** A repo root whose dispatch config points at the fake dispatch server. */
function repoPointingAt(port: number): string {
  const dir = mkdtempSync(join(tmpdir(), "igniter-cli-"));
  mkdirSync(join(dir, ".igniter"), { recursive: true });
  writeFileSync(join(dir, ".igniter", "config.yaml"), `project: igniter\nlisten: "127.0.0.1:${port}"\n`);
  return dir;
}

function outsideWorkspaceEnv(): Record<string, string> {
  return { HERDR_ENV: "0", HERDR_WORKSPACE_ID: "" };
}

describe("cli dispatch forwarding", () => {
  test("status prints the server text and exits 0", async () => {
    const fake = startFakeDispatch(() => ({ ok: true, text: "1 / 2 slots" }));
    try {
      const result = await runCliFull(["status"], { cwd: repoPointingAt(fake.port), env: outsideWorkspaceEnv() });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("1 / 2 slots");
      expect(result.stderr).toBe("");
      expect(fake.seen).toEqual([{ argv: ["status"] }]);
    } finally {
      fake.stop();
    }
  });

  test("dispatch argv reaches the server verbatim", async () => {
    const fake = startFakeDispatch(() => ({ ok: true, text: "answered y for STA-1" }));
    try {
      const result = await runCliFull(["answer", "STA-1", "y"], {
        cwd: repoPointingAt(fake.port),
        env: outsideWorkspaceEnv(),
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("answered y for STA-1");
      expect(fake.seen).toEqual([{ argv: ["answer", "STA-1", "y"] }]);
    } finally {
      fake.stop();
    }
  });

  test("start runs the prepared Commander in the current terminal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "igniter-cli-foreground-"));
    const marker = join(dir, "commander-started");
    const fake = startFakeDispatch(() => ({
      ok: true,
      text: "starting Commander",
      data: {
        kind: "commander_foreground",
        command: ["/usr/bin/touch", marker],
        cwd: dir,
      },
    }));
    try {
      const result = await runCliFull(["start"], {
        cwd: repoPointingAt(fake.port),
        env: outsideWorkspaceEnv(),
      });
      expect(result.code).toBe(0);
      expect(await Bun.file(marker).exists()).toBe(true);
      expect(fake.seen).toEqual([{ argv: ["start"], directStart: true }]);
    } finally {
      fake.stop();
    }
  });

  test("a refused command prints to stderr and exits 1", async () => {
    const fake = startFakeDispatch(() => ({ ok: false, text: 'ticket "STA-9" was not found in Linear' }));
    try {
      const result = await runCliFull(["start", "STA-9"], {
        cwd: repoPointingAt(fake.port),
        env: outsideWorkspaceEnv(),
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ticket "STA-9" was not found in Linear');
      expect(result.stdout).toBe("");
      expect(fake.seen).toEqual([{ argv: ["start", "STA-9"], directStart: true }]);
    } finally {
      fake.stop();
    }
  });

  test("no server names the address and exits 1", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = probe.port;
    probe.stop();
    if (port === undefined) throw new Error("probe has no port");
    const result = await runCliFull(["status"], { cwd: repoPointingAt(port), env: outsideWorkspaceEnv() });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`no dispatch server at 127.0.0.1:${port}`);
    expect(result.stderr).toContain("igniter serve");
  });

  test("an unknown command never touches the server", async () => {
    const fake = startFakeDispatch(() => ({ ok: true, text: "unreachable" }));
    try {
      const result = await runCliFull(["frobnicate"], {
        cwd: repoPointingAt(fake.port),
        env: outsideWorkspaceEnv(),
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("usage: igniter");
      expect(fake.seen).toEqual([]);
    } finally {
      fake.stop();
    }
  });
});

describe("cli workspace commands", () => {
  test("outside a workspace the CLI refuses before any HTTP", async () => {
    const fake = startFakeDispatch(() => ({ ok: true, text: "unreachable" }));
    try {
      const result = await runCliFull(["state", "--json"], {
        cwd: repoPointingAt(fake.port),
        env: outsideWorkspaceEnv(),
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("runs inside a Herdr workspace only");
      expect(fake.seen).toEqual([]);
    } finally {
      fake.stop();
    }
  });

  test("state forwards the workspace id, never a ticket", async () => {
    const fake = startFakeDispatch((seen) => {
      expect(seen.workspaceId).toBe("ws-7");
      return { ok: true, text: '{"status":"build"}' };
    });
    try {
      const result = await runCliFull(["state", "--json"], {
        cwd: repoPointingAt(fake.port),
        env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "ws-7" },
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('"status":"build"');
      expect(fake.seen).toEqual([{ argv: ["state", "--json"], workspaceId: "ws-7" }]);
    } finally {
      fake.stop();
    }
  });

  test("submit carries stdin to the server verbatim without a workspace id", async () => {
    const payload = JSON.stringify({ version: 1, summary: "done" });
    const fake = startFakeDispatch((seen) => {
      expect(seen.input).toBe(payload);
      expect(seen.workspaceId).toBeUndefined();
      return { ok: true, text: "submitted STA-1" };
    });
    try {
      const result = await runCliFull(["submit", "STA-1", "--input", "-"], {
        cwd: repoPointingAt(fake.port),
        env: outsideWorkspaceEnv(),
        stdin: payload,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("submitted STA-1");
      expect(fake.seen).toEqual([{ argv: ["submit", "STA-1", "--input", "-"], input: payload }]);
    } finally {
      fake.stop();
    }
  });

  test("a refused ticket-targeted command exits 1 with the server text on stderr", async () => {
    const fake = startFakeDispatch(() => ({ ok: false, text: "nothing to submit" }));
    try {
      const result = await runCliFull(["submit", "STA-1", "--input", "-"], {
        cwd: repoPointingAt(fake.port),
        env: outsideWorkspaceEnv(),
        stdin: JSON.stringify({ version: 1 }),
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("nothing to submit");
    } finally {
      fake.stop();
    }
  });
});

describe("cli command coverage", () => {
  test("every dispatch command forwards argv and honors the reply", async () => {
    const fake = startFakeDispatch((seen) => ({
      ok: true,
      text: seen.argv.join(" "),
      ...(seen.argv[0] === "start"
        ? { data: { kind: "commander_foreground", command: ["/usr/bin/true"], cwd: tmpdir() } }
        : {}),
    }));
    try {
      const dir = repoPointingAt(fake.port);
      const cases: string[][] = [
        ["status", "--json"],
        ["status", "STA-1", "--json"],
        ["start"],
        ["start", "STA-1"],
        ["begin", "STA-1"],
        ["submit", "STA-1", "--input", "-"],
        ["block", "STA-1", "--reason", "waiting"],
        ["unblock", "STA-1"],
        ["reconcile", "STA-1"],
        ["pause", "STA-1"],
        ["resume", "STA-1"],
        ["fail", "STA-1", "--reason", "wedged"],
        ["restart", "STA-1", "--builder", "m"],
      ];
      for (const argv of cases) {
        const result = await runCliFull(argv, {
          cwd: dir,
          env: outsideWorkspaceEnv(),
          ...(argv[0] === "submit" ? { stdin: "{}" } : {}),
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(argv.join(" "));
      }
      expect(fake.seen.map((entry) => entry.argv)).toEqual(cases);
      expect(fake.seen.every((entry) => entry.workspaceId === undefined)).toBe(true);
      expect(fake.seen.filter((entry) => entry.argv[0] === "start").every((entry) => entry.directStart === true)).toBe(true);
    } finally {
      fake.stop();
    }
  });

  test("every legacy workspace command forwards the workspace id", async () => {
    const fake = startFakeDispatch((seen) => ({ ok: true, text: seen.argv.join(" ") }));
    try {
      const dir = repoPointingAt(fake.port);
      const env = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "ws-7" };
      const cases: string[][] = [
        ["state", "--json"],
        ["begin"],
      ];
      for (const argv of cases) {
        const result = await runCliFull(argv, { cwd: dir, env });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(argv.join(" "));
      }
      expect(fake.seen.map((entry) => entry.argv)).toEqual(cases);
      expect(fake.seen.every((entry) => entry.workspaceId === "ws-7")).toBe(true);
    } finally {
      fake.stop();
    }
  });
});
