// Formal `igniter serve` startup at an injectable seam: config and key
// loading, port priority, client construction, and starter failure. Tests
// use a fake key and injected fakes; they never touch a real provider.
// See serve-lifecycle.test.ts for the running service (health, signals).

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDispatchConfig } from "../dispatch/config";
import { LinearClient } from "../dispatch/linear";
import { prepareServe, resolveServePort, type ServeStarterArgs } from "./serve-startup";

const FAKE_KEY = "fake-test-key";

function testConfig() {
  return parseDispatchConfig({ project: "igniter" });
}

describe("serve port priority", () => {
  test("--port beats IGNITER_PORT beats config", () => {
    expect(resolveServePort("5001", "5002", 4180)).toBe(5001);
    expect(resolveServePort(undefined, "5002", 4180)).toBe(5002);
    expect(resolveServePort(undefined, undefined, 4180)).toBe(4180);
  });

  test("invalid ports name the offending source", () => {
    expect(() => resolveServePort("abc", undefined, 4180)).toThrow("invalid port: abc");
    expect(() => resolveServePort("0", undefined, 4180)).toThrow("invalid port: 0");
    expect(() => resolveServePort("1.5", undefined, 4180)).toThrow("invalid port: 1.5");
    expect(() => resolveServePort(undefined, "nope", 4180)).toThrow("invalid port: nope");
    expect(() => resolveServePort(undefined, "-3", 4180)).toThrow("invalid port: -3");
  });
});

describe("serve startup wiring", () => {
  test("builds the client from the loaded key and hands it to the starter", async () => {
    const config = testConfig();
    let madeKey: string | undefined;
    let startedArgs: ServeStarterArgs | undefined;
    const result = await prepareServe(
      { repoRoot: "/repo", envPort: "4321" },
      {
        loadConfig: async () => config,
        loadKey: () => FAKE_KEY,
        makeClient: (apiKey) => {
          madeKey = apiKey;
          return new LinearClient({ apiKey, timeoutMs: 1_000 });
        },
        starter: async (args) => {
          startedArgs = args;
          return "handle";
        },
      },
    );

    expect(madeKey).toBe(FAKE_KEY);
    expect(result.port).toBe(4321);
    expect(result.config).toBe(config);
    expect(result.client).toBeInstanceOf(LinearClient);
    expect(startedArgs).toMatchObject({ repoRoot: "/repo", config, port: 4321 });
    expect(startedArgs?.client).toBe(result.client);
    expect(result.handle).toBe("handle");
  });

  test("a missing key fails before the client or starter", async () => {
    let starterCalls = 0;
    await expect(prepareServe(
      { repoRoot: "/repo" },
      {
        loadConfig: async () => testConfig(),
        loadKey: () => { throw new Error("LINEAR_API_KEY is not set"); },
        makeClient: () => { throw new Error("client must not be built without a key"); },
        starter: async () => { starterCalls += 1; return "handle"; },
      },
    )).rejects.toThrow("LINEAR_API_KEY is not set");
    expect(starterCalls).toBe(0);
  });

  test("an invalid config fails before the key or starter", async () => {
    let keyCalls = 0;
    let starterCalls = 0;
    await expect(prepareServe(
      { repoRoot: "/repo" },
      {
        loadConfig: async () => { throw new Error('config error: "listen" must look like "host:port"'); },
        loadKey: () => { keyCalls += 1; return FAKE_KEY; },
        starter: async () => { starterCalls += 1; return "handle"; },
      },
    )).rejects.toThrow('config error: "listen"');
    expect(keyCalls).toBe(0);
    expect(starterCalls).toBe(0);
  });

  test("a starter failure propagates with its message", async () => {
    await expect(prepareServe(
      { repoRoot: "/repo" },
      {
        loadConfig: async () => testConfig(),
        loadKey: () => FAKE_KEY,
        starter: async () => { throw new Error("port 4180 is already in use"); },
      },
    )).rejects.toThrow("port 4180 is already in use");
  });
});

// The formal `igniter serve` binary, subprocess-level. Each case fails
// before the command service starts, so no real provider is touched and no
// port is bound. Env is pinned: a blanked LINEAR_API_KEY simulates a
// missing key even when the developer shell exports a real one.
const cli = new URL("../cli.ts", import.meta.url).pathname;

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runServe(cwd: string, env: Record<string, string | undefined>): Promise<CliResult> {
  const proc = Bun.spawn(["bun", cli, "serve"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: { ...process.env, ...env },
  });
  await proc.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

function repoWithConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "igniter-serve-entry-"));
  mkdirSync(join(dir, ".igniter"), { recursive: true });
  writeFileSync(join(dir, ".igniter", "config.yaml"), contents);
  return dir;
}

describe("serve entry failures", () => {
  test("a missing key exits 1 without starting", async () => {
    const dir = repoWithConfig("project: igniter\n");
    const result = await runServe(dir, { LINEAR_API_KEY: "", IGNITER_PORT: undefined });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("LINEAR_API_KEY is not set");
  });

  test("an invalid config exits 1 without starting", async () => {
    const dir = repoWithConfig('project: igniter\nlisten: "127.0.0.1:notaport"\n');
    const result = await runServe(dir, { LINEAR_API_KEY: "fake-test-key", IGNITER_PORT: undefined });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("config error");
  });

  test("a missing config file exits 1 without starting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "igniter-serve-noconfig-"));
    const result = await runServe(dir, { LINEAR_API_KEY: "fake-test-key", IGNITER_PORT: undefined });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(".igniter/config.yaml not found");
  });
});
