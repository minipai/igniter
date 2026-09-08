// Running command-service lifecycle: ready/health observability, SIGINT
// and SIGTERM shutdown, startup failure, and kill-during-startup. The child
// runs the formal entry `startDispatchServe` with a real LinearClient whose
// fetch boundary is stubbed (fake key, validation-shaped answers); it is
// never a fake dispatch reply, and no real provider is touched. Every owned
// child is reaped via `exited`; the tests bind port 0, so no existing user
// serve or Herdr process can be disturbed.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDispatchConfig } from "../dispatch/config";
import { FakeGit } from "../dispatch/fake-git";
import { FakeWorkspaces } from "../dispatch/fake-workspaces";
import { LinearClient } from "../dispatch/linear";
import { startDispatchServe } from "./dispatch-serve";

const srcDir = new URL("./", import.meta.url).pathname.replace(/\/+$/, "");

// Validation-shaped answers for validateStartup: one project on one team,
// six correctly-typed states, and the Progress group with four labels.
function validationFetch(): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (_input, init) => {
    const body = JSON.parse((init?.body as string) ?? "{}") as { query?: string };
    const query = body.query ?? "";
    const json = (data: unknown): Response => Response.json({ data });
    if (query.includes("labels(first:")) {
      return json({
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
    }
    if (query.includes("states")) {
      return json({
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
    }
    // The projects query embeds "teams {", so it must match first.
    if (query.includes("projects {")) {
      return json({
        projects: { nodes: [{ id: "p-1", name: "igniter", slugId: "igniter", teams: { nodes: [{ id: "t-1" }] } }] },
      });
    }
    if (query.includes("teams {")) {
      return json({ teams: { nodes: [{ id: "t-1", name: "Starcoder", key: "STA" }] } });
    }
    return Response.json({ errors: [{ message: "unexpected query in lifecycle test" }] });
  };
}

// Isolated child entry: same validation stub, the real startDispatchServe,
// ready-file signalling, and the PRODUCTION shutdown wiring
// (installServeShutdown, shared with cli.ts serve). The child registers no
// shutdown logic of its own: SIGINT/SIGTERM coverage below exercises the
// production stop path. Written to a temp dir by the test; never shipped,
// never a production flag. Payloads are embedded as JSON literals so the
// generated source cannot drift out of balance.
function childSource(): string {
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
  const teams = JSON.stringify({ teams: { nodes: [{ id: "t-1", name: "Starcoder", key: "STA" }] } });
  const projects = JSON.stringify({
    projects: { nodes: [{ id: "p-1", name: "igniter", slugId: "igniter", teams: { nodes: [{ id: "t-1" }] } }] },
  });
  return `import { startDispatchServe } from ${JSON.stringify(`${srcDir}/dispatch-serve.ts`)};
import { LinearClient } from ${JSON.stringify(`${srcDir}/../dispatch/linear.ts`)};
import { parseDispatchConfig } from ${JSON.stringify(`${srcDir}/../dispatch/config.ts`)};
import { FakeGit } from ${JSON.stringify(`${srcDir}/../dispatch/fake-git.ts`)};
import { FakeWorkspaces } from ${JSON.stringify(`${srcDir}/../dispatch/fake-workspaces.ts`)};
import { installServeShutdown, type ServeShutdownState } from ${JSON.stringify(`${srcDir}/serve-startup.ts`)};

const [mode, readyFile, repoRoot] = Bun.argv.slice(2);

function validationFetch(fail: boolean) {
  return async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (fail) return new Response("upstream blew up", { status: 500 });
    const body = JSON.parse(((init?.body as string) ?? "{}")) as { query?: string };
    const query = body.query ?? "";
    const json = (data: unknown): Response => Response.json({ data });
    if (query.includes("labels(first:")) return json(${labels});
    if (query.includes("states")) return json(${states});
    if (query.includes("projects {")) return json(${projects});
    if (query.includes("teams {")) return json(${teams});
    return Response.json({ errors: [{ message: "unexpected query" }] });
  };
}

const shutdown: ServeShutdownState = {};
installServeShutdown(shutdown);

try {
  const handle = await startDispatchServe({
    repoRoot: repoRoot as string,
    config: parseDispatchConfig({ project: "igniter" }),
    client: new LinearClient({
      apiKey: "fake-test-key",
      endpoint: "http://stub.invalid/gql",
      fetchImpl: mode === "slow" ? () => new Promise<Response>(() => {}) : validationFetch(mode === "fail"),
    }),
    workspaces: new FakeWorkspaces(),
    git: new FakeGit(),
    port: 0,
    print: () => {},
    onServer: (server) => { shutdown.server = server; },
  });
  shutdown.handle = handle;
  await Bun.file(readyFile as string).write("ready " + handle.server.port);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
`;
}

interface OwnedChild {
  proc: ReturnType<typeof Bun.spawn>;
  repoRoot: string;
  readyFile: string;
}

function spawnServeChild(mode: "serve" | "slow" | "fail"): OwnedChild {
  const dir = mkdtempSync(join(tmpdir(), "igniter-lifecycle-"));
  const repoRoot = join(dir, "repo");
  mkdirSync(join(repoRoot, ".igniter"), { recursive: true });
  const childPath = join(dir, "child-serve.ts");
  writeFileSync(childPath, childSource());
  const readyFile = join(dir, "ready");
  const proc = Bun.spawn([process.execPath, childPath, mode, readyFile, repoRoot], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env },
  });
  return { proc, repoRoot, readyFile };
}

async function waitReady(readyFile: string, timeoutMs = 20_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await Bun.file(readyFile).exists()) {
      const text = (await Bun.file(readyFile).text()).trim();
      const port = Number(text.replace("ready ", ""));
      if (Number.isInteger(port) && port > 0) return port;
    }
    if (Date.now() >= deadline) throw new Error(`serve child never became ready (no ${readyFile})`);
    await Bun.sleep(25);
  }
}

async function waitExit(proc: OwnedChild["proc"], timeoutMs = 10_000): Promise<number> {
  const code = await Promise.race([
    proc.exited,
    Bun.sleep(timeoutMs).then(() => "timeout" as const),
  ]);
  if (code === "timeout") throw new Error("serve child did not exit in time");
  return code;
}

async function readStderr(proc: OwnedChild["proc"]): Promise<string> {
  return new Response(proc.stderr as ReadableStream<Uint8Array>).text();
}

async function healthOk(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok && (await res.json()).ok === true;
  } catch {
    return false;
  }
}

describe("serve lifecycle", () => {
  test("in-process serve answers health until stopped, then releases its port", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "igniter-lifecycle-local-"));
    mkdirSync(join(repoRoot, ".igniter"), { recursive: true });
    const handle = await startDispatchServe({
      repoRoot,
      config: parseDispatchConfig({ project: "igniter" }),
      client: new LinearClient({ apiKey: "fake-test-key", endpoint: "http://stub.invalid/gql", fetchImpl: validationFetch() }),
      workspaces: new FakeWorkspaces(),
      git: new FakeGit(),
      port: 0,
      print: () => {},
    });
    try {
      const res = await fetch(`${handle.base}/api/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, service: "igniter" });
    } finally {
      await handle.stop();
    }
    expect(await healthOk(handle.server.port ?? -1)).toBe(false);
  });

  test("SIGINT shuts the running service down with exit 0 and frees its port", async () => {
    const child = spawnServeChild("serve");
    try {
      const port = await waitReady(child.readyFile);
      expect(await healthOk(port)).toBe(true);
      child.proc.kill("SIGINT");
      expect(await waitExit(child.proc)).toBe(0);
      expect(await healthOk(port)).toBe(false);
    } finally {
      try { child.proc.kill(9); } catch { /* already reaped */ }
      await child.proc.exited;
    }
  });

  test("SIGTERM shuts the running service down with exit 0 and frees its port", async () => {
    const child = spawnServeChild("serve");
    try {
      const port = await waitReady(child.readyFile);
      expect(await healthOk(port)).toBe(true);
      child.proc.kill("SIGTERM");
      expect(await waitExit(child.proc)).toBe(0);
      expect(await healthOk(port)).toBe(false);
    } finally {
      try { child.proc.kill(9); } catch { /* already reaped */ }
      await child.proc.exited;
    }
  });

  test("a validation failure exits 1 quickly and leaves no process behind", async () => {
    const child = spawnServeChild("fail");
    try {
      expect(await waitExit(child.proc)).toBe(1);
      expect(await Bun.file(child.readyFile).exists()).toBe(false);
      expect(await readStderr(child.proc)).toContain("HTTP 500");
    } finally {
      try { child.proc.kill(9); } catch { /* already reaped */ }
      await child.proc.exited;
    }
  });

  test("killing the service mid-startup leaves no process and no ready signal", async () => {
    const child = spawnServeChild("slow");
    try {
      await Bun.sleep(300);
      expect(await Bun.file(child.readyFile).exists()).toBe(false);
      child.proc.kill("SIGTERM");
      expect(await waitExit(child.proc)).toBe(0);
      expect(await Bun.file(child.readyFile).exists()).toBe(false);
    } finally {
      try { child.proc.kill(9); } catch { /* already reaped */ }
      await child.proc.exited;
    }
  });
});
