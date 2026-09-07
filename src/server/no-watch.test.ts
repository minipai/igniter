// `igniter serve --no-watch` as a black box: it serves the UI without any
// credentials, honors `--port` over `IGNITER_PORT` over the config file,
// and releases its port on shutdown. Each test spawns the real CLI in a
// temporary repo root; no Linear key, no daemon, no real project.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("../cli.ts", import.meta.url).pathname;

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const port = probe.port;
  probe.stop();
  if (port === undefined) throw new Error("probe has no port");
  return port;
}

function repoRoot(config?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "igniter-no-watch-"));
  if (config !== undefined) {
    mkdirSync(join(dir, ".igniter"), { recursive: true });
    writeFileSync(join(dir, ".igniter", "config.yaml"), config);
  }
  return dir;
}

function cleanEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  delete env["LINEAR_API_KEY"];
  return env;
}

function spawnServe(dir: string, args: string[], env: Record<string, string | undefined>): {
  proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
} {
  const proc = Bun.spawn(["bun", cli, "serve", "--no-watch", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: env as Record<string, string>,
  });
  void proc.stdin.end();
  return { proc };
}

type ServeProc = ReturnType<typeof spawnServe>["proc"];

async function waitForHealth(port: number, timeoutMs = 10_000): Promise<{ ok: boolean; service: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.status === 200) return (await res.json()) as { ok: boolean; service: string };
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`health never came up on port ${port}`);
    await Bun.sleep(50);
  }
}

async function expectRefused(port: number): Promise<void> {
  await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
}

async function stopAndRead(proc: ServeProc): Promise<{ stdout: string; stderr: string }> {
  proc.kill();
  await proc.exited;
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr };
}

describe("serve --no-watch", () => {
  test("starts with no credentials and no config, serves health, then stops", async () => {
    const port = freePort();
    // A bogus key proves the key is ignored, not merely absent.
    const { proc } = spawnServe(repoRoot(), ["--port", String(port)], cleanEnv({ LINEAR_API_KEY: "bogus-key" }));
    try {
      expect(await waitForHealth(port)).toEqual({ ok: true, service: "igniter" });
      // UI-only mode: no dispatch behind the routes.
      const res = await fetch(`http://127.0.0.1:${port}/api/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ argv: ["status"] }),
      });
      expect(res.status).toBe(503);
      expect((await fetch(`http://127.0.0.1:${port}/api/board`)).status).toBe(503);
    } finally {
      const out = await stopAndRead(proc);
      expect(out.stdout).toContain("(watch disabled)");
    }
    await expectRefused(port);
  });

  test("--port wins over IGNITER_PORT and the config file", async () => {
    const configPort = freePort();
    const envPort = freePort();
    const flagPort = freePort();
    const dir = repoRoot(`project: igniter\nlisten: "127.0.0.1:${configPort}"\n`);
    const { proc } = spawnServe(
      dir,
      ["--port", String(flagPort)],
      cleanEnv({ IGNITER_PORT: String(envPort) }),
    );
    try {
      expect(await waitForHealth(flagPort)).toEqual({ ok: true, service: "igniter" });
      await expectRefused(envPort);
      await expectRefused(configPort);
    } finally {
      await stopAndRead(proc);
    }
  });

  test("IGNITER_PORT wins over the config file", async () => {
    const configPort = freePort();
    const envPort = freePort();
    const dir = repoRoot(`project: igniter\nlisten: "127.0.0.1:${configPort}"\n`);
    const { proc } = spawnServe(dir, [], cleanEnv({ IGNITER_PORT: String(envPort) }));
    try {
      expect(await waitForHealth(envPort)).toEqual({ ok: true, service: "igniter" });
      await expectRefused(configPort);
    } finally {
      await stopAndRead(proc);
    }
  });

  test("the config listen port is the fallback", async () => {
    const configPort = freePort();
    const dir = repoRoot(`project: igniter\nlisten: "127.0.0.1:${configPort}"\n`);
    const env = cleanEnv();
    delete env["IGNITER_PORT"];
    const { proc } = spawnServe(dir, [], env);
    try {
      expect(await waitForHealth(configPort)).toEqual({ ok: true, service: "igniter" });
    } finally {
      await stopAndRead(proc);
    }
  });

  test("an invalid port names itself and exits 1", async () => {
    const proc = Bun.spawn(["bun", cli, "serve", "--no-watch", "--port", "nope"], {
      cwd: repoRoot(),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      env: cleanEnv() as Record<string, string>,
    });
    void proc.stdin.end();
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(1);
    expect(stderr).toContain("invalid port: nope");
  });
});
