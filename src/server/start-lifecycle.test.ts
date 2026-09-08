// Formal `cli.ts start` cold-start success. Bun preload replaces only the
// Linear fetch boundary with validation-shaped answers; localhost health and
// command requests still use the real server. The fake `codex` executable is
// the foreground Commander, while the exact detached serve PID is recorded
// by the preload and stopped in finally. No existing serve or Herdr process
// can be selected or killed by this test.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("../cli.ts", import.meta.url).pathname;

function preloadSource(): string {
  const teams = JSON.stringify({ teams: { nodes: [{ id: "t-1", name: "Starcoder", key: "STA" }] } });
  const projects = JSON.stringify({
    projects: { nodes: [{ id: "p-1", name: "igniter", slugId: "igniter", teams: { nodes: [{ id: "t-1" }] } }] },
  });
  const states = JSON.stringify({
    team: {
      states: {
        nodes: [
          { id: "s-backlog", name: "Backlog", type: "backlog" },
          { id: "s-todo", name: "Todo", type: "unstarted" },
          { id: "s-build", name: "Build", type: "started" },
          { id: "s-review", name: "Review", type: "started" },
          { id: "s-deliver", name: "Deliver", type: "started" },
          { id: "s-done", name: "Done", type: "completed" },
        ],
      },
    },
  });
  const labels = JSON.stringify({
    team: {
      labels: {
        nodes: [
          { id: "g", name: "Progress", parent: null },
          { id: "l-pending", name: "Pending", parent: { id: "g", name: "Progress" } },
          { id: "l-progress", name: "In progress", parent: { id: "g", name: "Progress" } },
          { id: "l-complete", name: "Complete", parent: { id: "g", name: "Progress" } },
          { id: "l-blocked", name: "Blocked", parent: { id: "g", name: "Progress" } },
        ],
      },
    },
  });
  return `import { appendFileSync, writeFileSync } from "node:fs";

if (Bun.argv.at(-1) === "serve") {
  writeFileSync(process.env["IGNITER_TEST_OWNED_PID"] as string, String(process.pid));
  const starts = process.env["IGNITER_TEST_SERVE_STARTS"];
  if (starts) appendFileSync(starts, String(process.pid) + "\\n");
}

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === "https://api.linear.app/graphql") {
    const body = JSON.parse((init?.body as string) ?? "{}") as { query?: string };
    const query = body.query ?? "";
    const json = (data: unknown): Response => Response.json({ data });
    if (query.includes("labels(first:")) return json(${labels});
    if (query.includes("states")) return json(${states});
    if (query.includes("projects {")) return json(${projects});
    if (query.includes("teams {")) return json(${teams});
    return Response.json({ errors: [{ message: "unexpected query in start lifecycle test" }] });
  }
  if (!url.startsWith("http://127.0.0.1:")) {
    throw new Error("unexpected network request in start lifecycle test: " + url);
  }
  return realFetch(input, init);
};
`;
}

async function healthOk(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok && (await response.json()).ok === true;
  } catch {
    return false;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopOwnedServe(pidFile: string, port: number): Promise<void> {
  if (!(await Bun.file(pidFile).exists())) return;
  const pid = Number(await Bun.file(pidFile).text());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid owned serve pid: ${pid}`);
  if (isAlive(pid)) process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 3_000;
  while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(25);
  if (isAlive(pid)) process.kill(pid, "SIGKILL");
  const stoppedDeadline = Date.now() + 3_000;
  while ((isAlive(pid) || await healthOk(port)) && Date.now() < stoppedDeadline) await Bun.sleep(25);
  if (isAlive(pid) || await healthOk(port)) throw new Error(`owned serve ${pid} did not stop`);
}

describe("start lifecycle", () => {
  test("a cold start waits for real serve health, retries the command, then runs the fake foreground agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "igniter-start-lifecycle-"));
    const repoRoot = join(dir, "repo");
    const binDir = join(dir, "bin");
    const marker = join(dir, "commander-started");
    const pidFile = join(dir, "serve.pid");
    const preload = join(dir, "linear-preload.ts");
    mkdirSync(join(repoRoot, ".igniter"), { recursive: true });
    mkdirSync(binDir, { recursive: true });

    const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
    const port = probe.port;
    probe.stop();
    if (port === undefined) throw new Error("probe has no port");

    writeFileSync(join(repoRoot, ".igniter", "config.yaml"), `project: igniter\nteam: STA\nlisten: "127.0.0.1:${port}"\n`);
    writeFileSync(preload, preloadSource());
    const fakeCodex = join(binDir, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh\nprintf started > "$IGNITER_TEST_AGENT_MARKER"\n`);
    chmodSync(fakeCodex, 0o755);

    try {
      const proc = Bun.spawn([process.execPath, cli, "start"], {
        cwd: repoRoot,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: `${binDir}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
          BUN_OPTIONS: `--preload=${preload}`,
          LINEAR_API_KEY: "fake-test-key",
          IGNITER_TEST_OWNED_PID: pidFile,
          IGNITER_TEST_AGENT_MARKER: marker,
          HERDR_ENV: "0",
          HERDR_WORKSPACE_ID: "",
        },
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("starting Commander");
      expect(await Bun.file(marker).text()).toBe("started");
      expect(await healthOk(port)).toBe(true);
      expect(await Bun.file(pidFile).exists()).toBe(true);
    } finally {
      await stopOwnedServe(pidFile, port);
    }

    expect(await healthOk(port)).toBe(false);
    const pid = Number(await Bun.file(pidFile).text());
    expect(isAlive(pid)).toBe(false);
  }, 10_000);

  test("an already healthy owned serve runs the fake foreground agent, propagates exit 7, and spawns no detached serve", async () => {
    const dir = mkdtempSync(join(tmpdir(), "igniter-start-running-"));
    const repoRoot = join(dir, "repo");
    const binDir = join(dir, "bin");
    const marker = join(dir, "commander-started");
    const pidFile = join(dir, "serve.pid");
    const serveStarts = join(dir, "serve-starts");
    const preload = join(dir, "linear-preload.ts");
    mkdirSync(join(repoRoot, ".igniter"), { recursive: true });
    mkdirSync(binDir, { recursive: true });

    const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
    const port = probe.port;
    probe.stop();
    if (port === undefined) throw new Error("probe has no port");

    writeFileSync(join(repoRoot, ".igniter", "config.yaml"), `project: igniter\nteam: STA\nlisten: "127.0.0.1:${port}"\n`);
    writeFileSync(preload, preloadSource());
    const fakeCodex = join(binDir, "codex");
    writeFileSync(fakeCodex, `#!/bin/sh\nprintf started > "$IGNITER_TEST_AGENT_MARKER"\nexit 7\n`);
    chmodSync(fakeCodex, 0o755);
    const env = {
      PATH: `${binDir}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      BUN_OPTIONS: `--preload=${preload}`,
      LINEAR_API_KEY: "fake-test-key",
      IGNITER_TEST_OWNED_PID: pidFile,
      IGNITER_TEST_SERVE_STARTS: serveStarts,
      IGNITER_TEST_AGENT_MARKER: marker,
      HERDR_ENV: "0",
      HERDR_WORKSPACE_ID: "",
    };
    const serve = Bun.spawn([process.execPath, cli, "serve"], {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env,
    });

    try {
      const readyDeadline = Date.now() + 5_000;
      while (!await healthOk(port) && Date.now() < readyDeadline) await Bun.sleep(25);
      expect(await healthOk(port)).toBe(true);
      expect((await Bun.file(serveStarts).text()).trim().split("\n")).toEqual([String(serve.pid)]);

      const start = Bun.spawn([process.execPath, cli, "start"], {
        cwd: repoRoot,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(start.stdout).text(),
        new Response(start.stderr).text(),
        start.exited,
      ]);

      expect(code).toBe(7);
      expect(stderr).toBe("");
      expect(stdout).toContain("starting Commander");
      expect(await Bun.file(marker).text()).toBe("started");
      expect(await healthOk(port)).toBe(true);
      expect((await Bun.file(serveStarts).text()).trim().split("\n")).toEqual([String(serve.pid)]);
    } finally {
      await stopOwnedServe(pidFile, port);
      await serve.exited;
    }

    expect(await healthOk(port)).toBe(false);
  }, 10_000);
});
