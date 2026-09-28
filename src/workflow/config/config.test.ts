import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANONICAL_PROGRESS,
  CANONICAL_STATES,
  DEFAULT_COMMANDER_CONFIG,
  DEFAULT_PROGRESS,
  DEFAULT_STATES,
  findProjectRoot,
  loadDispatchConfig,
  parseDispatchConfig,
} from "./config";
import { commanderAssetPaths } from "../../commander/assets";
import { promptPathForStage } from "../lifecycle/stage/stage-start";

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
      states: DEFAULT_STATES,
      progress: DEFAULT_PROGRESS,
      targetBranch: "main",
      herdrRemote: undefined,
      commander: DEFAULT_COMMANDER_CONFIG,
      delivery: undefined,
      runbooks: {},
    });
  });

  test("the lifecycle and Progress names are fixed protocol constants", () => {
    expect(CANONICAL_STATES).toEqual({
      backlog: "Backlog",
      todo: "Todo",
      build: "Build",
      acceptance: "Acceptance",
      deliver: "Deliver",
      done: "Done",
      canceled: "Canceled",
    });
    expect(CANONICAL_PROGRESS).toEqual({
      group: "Progress",
      pending: "Pending",
      in_progress: "In progress",
      complete: "Complete",
      blocked: "Blocked",
    });
    // Parsing never changes them, whatever a project writes elsewhere.
    const config = parseDispatchConfig({ project: "x" });
    expect(config.states).toEqual(CANONICAL_STATES);
    expect(config.progress).toEqual(CANONICAL_PROGRESS);
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

  test("target_branch defaults to main and accepts an override", () => {
    expect(parseDispatchConfig({ project: "x" }).targetBranch).toBe("main");
    expect(parseDispatchConfig({ project: "x", target_branch: "trunk" }).targetBranch).toBe("trunk");
  });

  test("rejects bad target_branch values", () => {
    expect(() => parseDispatchConfig({ project: "x", target_branch: "" })).toThrow('"target_branch"');
    expect(() => parseDispatchConfig({ project: "x", target_branch: 42 })).toThrow('"target_branch"');
  });

  test("accepts a full file with command profiles and runbooks", () => {
    const config = parseDispatchConfig({
      project: "igniter",
      team: "Starcoder",
      max_running: 2,
      herdr_remote: "art@192.168.88.8",
      agents: {
        builder: { command: "codex -m custom" },
        acceptance: { command: "claude --model custom" },
      },
      runbooks: {
        build: ".igniter/workflow/build.md",
        acceptance: ".igniter/workflow/acceptance.md",
        deliver: ".igniter/workflow/deliver.md",
      },
    });
    expect(config.maxRunning).toBe(2);
    expect(config.commander.agents.builder.command).toBe("codex -m custom");
    expect(config.commander.agents.acceptance.command).toBe("claude --model custom");
    expect(config.runbooks).toEqual({
      build: ".igniter/workflow/build.md",
      acceptance: ".igniter/workflow/acceptance.md",
      deliver: ".igniter/workflow/deliver.md",
    });
  });

  test("runbooks is optional and each entry is independent", () => {
    expect(parseDispatchConfig({ project: "x" }).runbooks).toEqual({});
    expect(parseDispatchConfig({ project: "x", runbooks: { build: "b.md" } }).runbooks).toEqual({ build: "b.md" });
    expect(parseDispatchConfig({ project: "x", runbooks: { acceptance: "a.md" } }).runbooks).toEqual({ acceptance: "a.md" });
  });

  test("rejects bad runbook values and unknown stages", () => {
    expect(() => parseDispatchConfig({ project: "x", runbooks: 42 })).toThrow('"runbooks"');
    expect(() => parseDispatchConfig({ project: "x", runbooks: { build: "" } })).toThrow('runbooks."build"');
    expect(() => parseDispatchConfig({ project: "x", runbooks: { testing: "t.md" } })).toThrow(
      'unknown runbook stage "testing" (known: build, acceptance, deliver)',
    );
  });

  test("loads bundled commands and replaces same-named profiles as a whole", () => {
    const defaults = parseDispatchConfig({ project: "x" }).commander;
    expect(defaults.agents.commander).toEqual({ command: "opencode --prompt {prompt}" });
    expect(defaults.agents.builder).toEqual({ command: "opencode mini -m opencode-go/deepseekflash-4.1" });
    expect(defaults.agents.acceptance).toEqual({ command: "opencode mini -m openai/gpt-6-luna#max" });
    expect(defaults.agents.deliverer).toEqual({ command: "opencode mini -m openai/gpt-6-luna#high" });
    expect(defaults.agents.builder_backup).toEqual({ command: "codex -m gpt-5.6-luna" });
    expect(defaults.agents.builder_expert).toEqual({ command: "codex -m gpt-5.6-sol" });

    const overridden = parseDispatchConfig({ project: "x", agents: {
      commander: { command: "custom commander {prompt}" },
      builder: {},
      builder_daily: { command: "custom worker" },
    } }).commander;
    expect(overridden.agents.commander).toEqual({ command: "custom commander {prompt}" });
    expect(overridden.agents.builder).toEqual(defaults.agents.builder);
    expect(overridden.agents.builder_daily).toEqual({ command: "custom worker" });
    expect(DEFAULT_COMMANDER_CONFIG.agents.builder.command).toBe("opencode mini -m opencode-go/deepseekflash-4.1");
  });

  test("rejects missing, empty, and unknown profile settings", () => {
    expect(() => parseDispatchConfig({ project: "x", agents: { builder_daily: {} } })).toThrow('agents."builder_daily" is a new agent and requires command');
    expect(() => parseDispatchConfig({ project: "x", agents: { builder: { command: "  " } } })).toThrow('"command"');
    expect(() => parseDispatchConfig({ project: "x", agents: { builder: { model: "old" } } })).toThrow('unknown agents."builder" setting "model"');
    expect(() => parseDispatchConfig({ project: "x", agents: { builder: { command: "cmd", effort: "high" } } })).toThrow('unknown agents."builder" setting "effort"');
    expect(() => parseDispatchConfig({ project: "x", models: { builder: "old/model" } })).toThrow('"models" was replaced by "agents"');
  });

  test("rejects reserved and inherited agent names", () => {
    expect(() => parseDispatchConfig({
      project: "x",
      agents: JSON.parse('{"__proto__":{"command":"x"}}'),
    })).toThrow('agents."__proto__" is a reserved agent name');
    expect(() => parseDispatchConfig({
      project: "x",
      agents: { constructor: { command: "x" } },
    })).toThrow('agents."constructor" is a reserved agent name');
    // No inherited name leaked into the prototype.
    expect(({} as Record<string, unknown>)["harness"]).toBeUndefined();
    expect(({} as Record<string, unknown>)["model"]).toBeUndefined();
  });

  test("project is required", () => {
    expect(() => parseDispatchConfig({})).toThrow('"project" is required');
  });

  test("the removed states, progress, and stages maps fail with a migration error", () => {
    expect(() =>
      parseDispatchConfig({ project: "x", states: { backlog: "Backlog" } }),
    ).toThrow('"states" is no longer configurable');
    expect(() =>
      parseDispatchConfig({ project: "x", progress: { group: "Progress" } }),
    ).toThrow('"progress" is no longer configurable');
    expect(() =>
      parseDispatchConfig({ project: "x", stages: { build: { prompt: "b.md", agent: "builder" } } }),
    ).toThrow('"stages" is no longer configurable');
  });

  test("rejects bad max_running", () => {
    expect(() => parseDispatchConfig({ project: "x", max_running: 0 })).toThrow('"max_running"');
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

  test("the bundled stage prompt is always available regardless of runbooks", () => {
    const paths = commanderAssetPaths();
    expect(promptPathForStage(paths, "build")).toBe(paths.prompts.build);
    expect(promptPathForStage(paths, "acceptance")).toBe(paths.prompts.acceptance);
    expect(promptPathForStage(paths, "deliver")).toBe(paths.prompts.deliver);
  });

  test("runbooks resolve to non-empty files under the repo root", async () => {
    const yaml = [
      "project: igniter",
      "runbooks:",
      "  build: .igniter/workflow/build.md",
      "  acceptance: .igniter/workflow/acceptance.md",
      "  deliver: .igniter/workflow/deliver.md",
      "",
    ].join("\n");
    const dir = configDir(yaml);
    mkdirSync(join(dir, ".igniter", "workflow"));
    for (const stage of ["build", "acceptance", "deliver"] as const) {
      writeFileSync(join(dir, ".igniter", "workflow", `${stage}.md`), `# ${stage}\n`);
    }
    const config = await loadDispatchConfig(dir);
    expect(config.runbooks.build).toBe(realpathSync(join(dir, ".igniter", "workflow", "build.md")));
    expect(config.runbooks.acceptance).toBe(realpathSync(join(dir, ".igniter", "workflow", "acceptance.md")));
    expect(config.runbooks.deliver).toBe(realpathSync(join(dir, ".igniter", "workflow", "deliver.md")));

    writeFileSync(join(dir, ".igniter", "workflow", "acceptance.md"), "");
    await expect(loadDispatchConfig(dir)).rejects.toThrow('runbooks."acceptance"');
  });

  test("a partial runbooks map needs no other entries", async () => {
    const dir = configDir("project: igniter\nrunbooks:\n  build: build.md\n");
    writeFileSync(join(dir, "build.md"), "# Build runbook\n");
    const config = await loadDispatchConfig(dir);
    expect(config.runbooks.build).toBe(realpathSync(join(dir, "build.md")));
    expect(config.runbooks.acceptance).toBeUndefined();
    expect(config.runbooks.deliver).toBeUndefined();
  });

  test("runbooks cannot escape the repo root", async () => {
    const dir = configDir("project: igniter\nrunbooks:\n  build: ../build.md\n");
    await expect(loadDispatchConfig(dir)).rejects.toThrow("outside");
  });

  test("an absolute runbook path is refused", async () => {
    const dir = configDir("project: igniter\nrunbooks:\n  build: /etc/passwd\n");
    await expect(loadDispatchConfig(dir)).rejects.toThrow('runbooks."build" must be relative to the repo root');
  });

  test("runbooks cannot escape through a symbolic link", async () => {
    const dir = configDir("project: igniter\nrunbooks:\n  build: .igniter/workflow/build.md\n");
    const workflow = join(dir, ".igniter", "workflow");
    const outside = join(mkdtempSync(join(tmpdir(), "igniter-runbook-outside-")), "outside.md");
    mkdirSync(workflow);
    writeFileSync(outside, "# outside\n");
    symlinkSync(outside, join(workflow, "build.md"));

    await expect(loadDispatchConfig(dir)).rejects.toThrow("through a symbolic link");
  });

  test("a missing runbook is rejected", async () => {
    const dir = configDir("project: igniter\nrunbooks:\n  build: .igniter/workflow/build.md\n");
    await expect(loadDispatchConfig(dir)).rejects.toThrow('runbooks."build"');
  });
});

describe("findProjectRoot", () => {
  test("the project root itself resolves to itself", async () => {
    const dir = configDir("project: igniter\n");
    expect(await findProjectRoot(dir)).toBe(dir);
  });

  test("one and many levels of subdirectory resolve to the enclosing root", async () => {
    const dir = configDir("project: igniter\n");
    mkdirSync(join(dir, "src", "nested"), { recursive: true });
    expect(await findProjectRoot(join(dir, "src"))).toBe(dir);
    expect(await findProjectRoot(join(dir, "src", "nested"))).toBe(dir);
  });

  test("nested projects resolve to the nearest config", async () => {
    const outer = configDir("project: outer\n");
    const inner = join(outer, "inner");
    mkdirSync(join(inner, ".igniter"), { recursive: true });
    writeFileSync(join(inner, ".igniter", "config.yaml"), "project: inner\n");
    mkdirSync(join(inner, "src"), { recursive: true });
    mkdirSync(join(outer, "src"), { recursive: true });
    expect(await findProjectRoot(join(inner, "src"))).toBe(inner);
    expect(await findProjectRoot(join(outer, "src"))).toBe(outer);
  });

  test("no ancestor config fails with a clear search error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "igniter-noroot-"));
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    await expect(findProjectRoot(join(dir, "a", "b"))).rejects.toThrow(
      ".igniter/config.yaml not found from",
    );
  });
});

test("omitted agents fall back to the bundled profiles", () => {
  expect(parseDispatchConfig({ project: "x" }).commander.agents).toEqual(DEFAULT_COMMANDER_CONFIG.agents);
});
