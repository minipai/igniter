// `igniter start` from a subdirectory serves the enclosing project.
// Cold-start proof with temp dirs and fake services only: a fake `codex`
// binary records the Commander's launch cwd and prompt, while Bun preload
// answers only the Linear validation queries. No real credentials,
// provider, or project.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
    return Response.json({ errors: [{ message: "unexpected query in start subdir test" }] });
  }
  if (!url.startsWith("http://127.0.0.1:")) {
    throw new Error("unexpected network request in start subdir test: " + url);
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

describe("start from a subdirectory", () => {
  test("cold start uses the enclosing project root for serve, Commander cwd, and prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "igniter-start-subdir-"));
    const repoRoot = join(dir, "repo");
    const subdir = join(repoRoot, "src", "nested");
    const binDir = join(dir, "bin");
    const marker = join(dir, "commander-started");
    const agentPwd = join(dir, "commander-pwd");
    const agentArgs = join(dir, "commander-args");
    const pidFile = join(dir, "serve.pid");
    const preload = join(dir, "linear-preload.ts");
    mkdirSync(subdir, { recursive: true });
    mkdirSync(join(repoRoot, ".igniter"), { recursive: true });
    mkdirSync(binDir, { recursive: true });

    const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
    const port = probe.port;
    probe.stop();
    if (port === undefined) throw new Error("probe has no port");

    writeFileSync(join(repoRoot, ".igniter", "config.yaml"), `project: igniter\nteam: STA\nlisten: "127.0.0.1:${port}"\n`);
    writeFileSync(preload, preloadSource());
    const fakeCodex = join(binDir, "codex");
    writeFileSync(
      fakeCodex,
      `#!/bin/sh\npwd > "$IGNITER_TEST_AGENT_PWD"\nprintf '%s\\n' "$@" > "$IGNITER_TEST_AGENT_ARGS"\nprintf started > "$IGNITER_TEST_AGENT_MARKER"\n`,
    );
    chmodSync(fakeCodex, 0o755);

    try {
      const proc = Bun.spawn([process.execPath, cli, "start"], {
        cwd: subdir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: `${binDir}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
          BUN_OPTIONS: `--preload=${preload}`,
          LINEAR_API_KEY: "fake-test-key",
          IGNITER_TEST_OWNED_PID: pidFile,
          IGNITER_TEST_AGENT_MARKER: marker,
          IGNITER_TEST_AGENT_PWD: agentPwd,
          IGNITER_TEST_AGENT_ARGS: agentArgs,
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
      // Commander runs in the found project root, not the calling subdir
      // (/var is a symlink to /private/var on macOS; compare real paths).
      expect((await Bun.file(agentPwd).text()).trim()).toBe(realpathSync(repoRoot));
      // The prompt names the project root as the workspace (the serve
      // process reports its physically-resolved cwd on macOS).
      const argsText = await Bun.file(agentArgs).text();
      expect(argsText).toContain(`Workspace: ${realpathSync(repoRoot)}`);
      // Bundled prompt still resolves from the Igniter install, never the
      // target repository.
      expect(argsText).toContain("global.md");
      expect(argsText).not.toContain(join(repoRoot, "src", "commander"));
      // The auto-started serve rooted at the project root too.
      expect(await healthOk(port)).toBe(true);
      expect(await Bun.file(join(repoRoot, ".igniter", "dispatch.log")).exists()).toBe(true);
      expect(await Bun.file(join(subdir, ".igniter", "dispatch.log")).exists()).toBe(false);
    } finally {
      await stopOwnedServe(pidFile, port);
    }

    expect(await healthOk(port)).toBe(false);
  }, 15_000);
});
