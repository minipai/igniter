import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MODELS,
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
      maxHours: 4,
      linearOrg: "starcoder",
      listenHost: "127.0.0.1",
      listenPort: 4180,
      states: DEFAULT_STATES,
      herdrRemote: undefined,
      models: DEFAULT_MODELS,
    });
  });

  test("accepts max_hours and linear_org", () => {
    const config = parseDispatchConfig({ project: "x", max_hours: 1.5, linear_org: "acme" });
    expect(config.maxHours).toBe(1.5);
    expect(config.linearOrg).toBe("acme");
  });

  test("rejects bad max_hours values", () => {
    expect(() => parseDispatchConfig({ project: "x", max_hours: 0 })).toThrow('"max_hours"');
    expect(() => parseDispatchConfig({ project: "x", max_hours: -2 })).toThrow('"max_hours"');
    expect(() => parseDispatchConfig({ project: "x", max_hours: "4" })).toThrow('"max_hours"');
  });

  test("accepts a full file", () => {
    const config = parseDispatchConfig({
      project: "igniter",
      team: "Starcoder",
      max_running: 2,
      listen: "192.168.8.8:4180",
      states: {
        queued: "Ready to build",
        building: "Building",
        review: "Ready to review",
        failed: "Todo",
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

  test("states.merge defaults to Ready to merge and must not equal building or review", () => {
    expect(parseDispatchConfig({ project: "x" }).states.merge).toBe("Ready to merge");
    expect(() =>
      parseDispatchConfig({ project: "x", states: { merge: "Building" } }),
    ).toThrow('"states.merge" ("Building") must not equal');
    expect(() =>
      parseDispatchConfig({ project: "x", states: { merge: "Ready to review" } }),
    ).toThrow('"states.merge" ("Ready to review") must not equal');
  });

  test("states.failed equal to states.queued fails startup parsing", () => {
    expect(() =>
      parseDispatchConfig({ project: "x", states: { queued: "Todo", failed: "Todo" } }),
    ).toThrow("must not equal");
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
      'unknown states role "later" (known: queued, building, review, failed, merge)',
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
});

test("omitted models fall back to the built-in role defaults", () => {
  expect(parseDispatchConfig({ project: "x" }).models).toEqual({
    builder: "opencode/muse-spark-1.3-contributor-free",
    reviewer: "claude-sonnet-5",
    escalate: "openai/gpt-5.6-terra",
  });
});
