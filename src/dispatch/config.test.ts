import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MODELS,
  DEFAULT_PROGRESS,
  DEFAULT_STATES,
  loadDispatchConfig,
  parseDispatchConfig,
} from "./config";

function configDir(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "igniter-config-"));
  mkdirSync(join(dir, ".igniter"));
  writeFileSync(join(dir, ".igniter", "config.yaml"), yaml);
  return dir;
}

describe("parseDispatchConfig", () => {
  test("fills every default", () => {
    const config = parseDispatchConfig({ project: "igniter" });
    expect(config).toEqual({
      project: "igniter",
      team: undefined,
      maxRunning: 3,
      linearOrg: "starcoder",
      listenHost: "127.0.0.1",
      listenPort: 4180,
      states: DEFAULT_STATES,
      progress: DEFAULT_PROGRESS,
      herdrRemote: undefined,
      models: DEFAULT_MODELS,
      delivery: undefined,
    });
  });

  test("defaults name the six statuses and the Progress group", () => {
    expect(DEFAULT_STATES).toEqual({
      backlog: "Backlog",
      todo: "Todo",
      build: "Build",
      review: "Review",
      deliver: "Deliver",
      done: "Done",
    });
    expect(DEFAULT_PROGRESS).toEqual({
      group: "Progress",
      pending: "Pending",
      in_progress: "In progress",
      complete: "Complete",
      blocked: "Blocked",
    });
  });

  test("accepts a delivery path, defaulting to absent", () => {
    expect(parseDispatchConfig({ project: "x" }).delivery).toBeUndefined();
    expect(parseDispatchConfig({ project: "x", delivery: "CONTRIBUTING.md" }).delivery).toBe(
      "CONTRIBUTING.md",
    );
  });

  test("rejects bad delivery values", () => {
    expect(() => parseDispatchConfig({ project: "x", delivery: "" })).toThrow('"delivery"');
    expect(() => parseDispatchConfig({ project: "x", delivery: 42 })).toThrow('"delivery"');
  });

  test("accepts max_running and linear_org", () => {
    const config = parseDispatchConfig({ project: "x", max_running: 2, linear_org: "acme" });
    expect(config.maxRunning).toBe(2);
    expect(config.linearOrg).toBe("acme");
  });

  test("accepts a full file", () => {
    const config = parseDispatchConfig({
      project: "igniter",
      team: "Starcoder",
      max_running: 2,
      listen: "192.168.8.8:4180",
      states: {
        backlog: "Backlog",
        todo: "Todo",
        build: "Build",
        review: "Review",
        deliver: "Deliver",
        done: "Done",
      },
      progress: {
        group: "Progress",
        pending: "Pending",
        in_progress: "In progress",
        complete: "Complete",
        blocked: "Blocked",
      },
      herdr_remote: "art@192.168.88.8",
      models: { builder: "custom/builder" },
    });
    expect(config.maxRunning).toBe(2);
    expect(config.listenHost).toBe("192.168.8.8");
    expect(config.models.builder).toBe("custom/builder");
    expect(config.models.reviewer).toBe(DEFAULT_MODELS.reviewer);
  });

  test("project is required", () => {
    expect(() => parseDispatchConfig({})).toThrow('"project" is required');
  });

  test("the old stage roles fail parsing, so an old config cannot start", () => {
    expect(() =>
      parseDispatchConfig({ project: "x", states: { queued: "Ready to build" } }),
    ).toThrow('unknown states role "queued"');
    expect(() =>
      parseDispatchConfig({ project: "x", states: { building: "Building" } }),
    ).toThrow('unknown states role "building"');
    expect(() =>
      parseDispatchConfig({ project: "x", states: { failed: "Todo" } }),
    ).toThrow('unknown states role "failed"');
    expect(() =>
      parseDispatchConfig({ project: "x", states: { merge: "Ready to merge" } }),
    ).toThrow('unknown states role "merge"');
  });

  test("duplicate status names fail parsing", () => {
    expect(() =>
      parseDispatchConfig({ project: "x", states: { todo: "Build" } }),
    ).toThrow("six distinct Linear statuses");
  });

  test("duplicate progress labels fail parsing", () => {
    expect(() =>
      parseDispatchConfig({ project: "x", progress: { complete: "Pending" } }),
    ).toThrow("four distinct Linear labels");
  });

  test("unknown progress roles fail parsing", () => {
    expect(() => parseDispatchConfig({ project: "x", progress: { queued: "Q" } })).toThrow(
      'unknown progress role "queued"',
    );
  });

  test("rejects a 0.0.0.0 bind", () => {
    expect(() => parseDispatchConfig({ project: "x", listen: "0.0.0.0:4180" })).toThrow("0.0.0.0");
  });

  test("rejects bad listen and max_running values", () => {
    expect(() => parseDispatchConfig({ project: "x", listen: "nope" })).toThrow('"listen"');
    expect(() => parseDispatchConfig({ project: "x", max_running: 0 })).toThrow('"max_running"');
    expect(() => parseDispatchConfig({ project: "x", models: { hal: "x" } })).toThrow(
      'unknown models role "hal" (known: builder, reviewer, escalate)',
    );
    expect(() => parseDispatchConfig({ project: "x", states: { later: "Someday" } })).toThrow(
      'unknown states role "later" (known: backlog, todo, build, review, deliver, done)',
    );
  });
});

describe("loadDispatchConfig", () => {
  test("reads YAML from the repo root", async () => {
    const dir = configDir("project: igniter\nteam: Starcoder\nmax_running: 2\n");
    const config = await loadDispatchConfig(dir);
    expect(config.project).toBe("igniter");
    expect(config.team).toBe("Starcoder");
    expect(config.maxRunning).toBe(2);
  });

  test("missing file fails with a clear message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "igniter-noconfig-"));
    await expect(loadDispatchConfig(dir)).rejects.toThrow(".igniter/config.yaml not found");
  });

  test("delivery names a file that must exist under the repo root", async () => {
    const dir = configDir('project: igniter\ndelivery: CONTRIBUTING.md\n');
    await expect(loadDispatchConfig(dir)).rejects.toThrow(
      'config error: "delivery" names "CONTRIBUTING.md"',
    );
    writeFileSync(join(dir, "CONTRIBUTING.md"), "# Contributing\n");
    const config = await loadDispatchConfig(dir);
    expect(config.delivery).toBe("CONTRIBUTING.md");
  });

  test("delivery is optional at load", async () => {
    const dir = configDir("project: igniter\n");
    const config = await loadDispatchConfig(dir);
    expect(config.delivery).toBeUndefined();
  });
});

test("omitted models fall back to the built-in role defaults", () => {
  expect(parseDispatchConfig({ project: "x" }).models).toEqual({
    builder: "opencode/muse-spark-1.3-contributor-free",
    reviewer: "claude-sonnet-5",
    escalate: "openai/gpt-5.6-terra",
  });
});
