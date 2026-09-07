// Agent profiles: one shape everywhere, effort translation per harness,
// and the run-recorded stage profiles retries reuse. No network, no real
// credentials, no real project.

import { describe, expect, test } from "bun:test";
import {
  commanderConfigForRun,
  launchArgsFor,
  launchFor,
  launchProblems,
  recordStageProfiles,
} from "./agents";
import { parseDispatchConfig, STAGE_AGENTS } from "./config";

describe("stage mapping", () => {
  test("Build runs on builder, Acceptance on reviewer, Deliver on deliverer", () => {
    expect(STAGE_AGENTS).toEqual({ build: "builder", review: "reviewer", deliver: "deliverer" });
    const commander = parseDispatchConfig({ project: "x" }).commander;
    for (const stage of ["build", "review", "deliver"] as const) {
      expect(commander.stages[stage].agent).toBe(STAGE_AGENTS[stage]);
    }
    // Deliver no longer reuses Builder.
    expect(commander.stages.deliver.agent).not.toBe("builder");
    expect(commander.agents.deliverer).toEqual({
      harness: "opencode",
      model: "opencode/muse-spark-1.3-contributor-free",
    });
  });
});

describe("launchArgsFor", () => {
  test("the model always rides along, even with no effort", () => {
    expect(launchArgsFor({ harness: "codex", model: "openai/gpt-5.6-sol" })).toEqual([
      "-m",
      "openai/gpt-5.6-sol",
    ]);
    expect(launchArgsFor({ harness: "claude", model: "claude-sonnet-5" })).toEqual([
      "--model",
      "claude-sonnet-5",
    ]);
    expect(launchArgsFor({ harness: "opencode", model: "opencode/muse-spark-1.3-contributor-free" })).toEqual([
      "-m",
      "opencode/muse-spark-1.3-contributor-free",
    ]);
  });

  test("codex effort becomes the model_reasoning_effort config override", () => {
    expect(launchArgsFor({ harness: "codex", model: "openai/gpt-5.6-sol", effort: "high" })).toEqual([
      "-m",
      "openai/gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="high"',
    ]);
    expect(launchArgsFor({ harness: "codex", model: "m", effort: "low" })).toEqual([
      "-m",
      "m",
      "-c",
      'model_reasoning_effort="low"',
    ]);
  });

  test("claude effort becomes the --effort flag", () => {
    expect(launchArgsFor({ harness: "claude", model: "claude-sonnet-5", effort: "high" })).toEqual([
      "--model",
      "claude-sonnet-5",
      "--effort",
      "high",
    ]);
    expect(launchArgsFor({ harness: "claude", model: "m", effort: "max" })).toEqual([
      "--model",
      "m",
      "--effort",
      "max",
    ]);
  });

  test("an unknown effort value fails naming the harness and the value", () => {
    expect(() => launchArgsFor({ harness: "codex", model: "m", effort: "turbo" })).toThrow(
      'unsupported effort "turbo" for harness "codex"',
    );
    expect(() => launchArgsFor({ harness: "claude", model: "m", effort: "turbo" })).toThrow(
      'unsupported effort "turbo" for harness "claude"',
    );
  });

  test("a harness with no effort option fails instead of dropping the effort", () => {
    // The installed opencode TUI (`opencode [project]`, what Herdr starts)
    // documents no effort flag — only `opencode run` has --variant.
    expect(() => launchArgsFor({ harness: "opencode", model: "m", effort: "high" })).toThrow(
      'unsupported effort "high" for harness "opencode"',
    );
  });

  test("a harness with no known model flag fails instead of launching model-less", () => {
    expect(() => launchArgsFor({ harness: "gemini", model: "m" })).toThrow(
      'unsupported harness "gemini"',
    );
  });

  test("launchFor carries the harness as the Herdr kind with model and effort", () => {
    expect(launchFor({ harness: "codex", model: "openai/gpt-5.6-sol", effort: "high" })).toEqual({
      kind: "codex",
      args: ["-m", "openai/gpt-5.6-sol", "-c", 'model_reasoning_effort="high"'],
    });
    // Every stage profile translates too: the helper serves any launch.
    expect(
      launchFor({ harness: "opencode", model: "opencode/muse-spark-1.3-contributor-free" }),
    ).toEqual({ kind: "opencode", args: ["-m", "opencode/muse-spark-1.3-contributor-free"] });
    expect(launchFor({ harness: "claude", model: "claude-sonnet-5", effort: "high" })).toEqual({
      kind: "claude",
      args: ["--model", "claude-sonnet-5", "--effort", "high"],
    });
  });
});

describe("launchProblems", () => {
  test("bundled defaults launch cleanly", () => {
    expect(launchProblems(parseDispatchConfig({ project: "x" }))).toEqual([]);
  });

  test("names every profile whose effort its harness cannot express", () => {
    const config = parseDispatchConfig({
      project: "x",
      agents: {
        deliverer: { effort: "high" },
        builder: { fallback: { effort: "turbo" } },
      },
    });
    const problems = launchProblems(config);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('agents."builder.fallback"');
    expect(problems[0]).toContain('unsupported effort "turbo"');
    expect(problems[1]).toContain('agents."deliverer"');
    expect(problems[1]).toContain('unsupported effort "high" for harness "opencode"');
  });
});

describe("run-recorded stage profiles", () => {
  test("the claim snapshot freezes every stage-agent profile in three tokens", () => {
    const config = parseDispatchConfig({ project: "x" });
    const recorded = recordStageProfiles(config);
    expect(Object.keys(recorded).sort()).toEqual([
      "profile_builder",
      "profile_deliverer",
      "profile_reviewer",
    ]);
    expect(JSON.parse(recorded["profile_builder"]!)).toEqual({
      harness: "opencode",
      model: "opencode/muse-spark-1.3-contributor-free",
      fallback: { harness: "codex", model: "openai/gpt-5.6-terra", effort: "high" },
    });
    expect(JSON.parse(recorded["profile_reviewer"]!)).toEqual({
      harness: "claude",
      model: "claude-sonnet-5",
      effort: "high",
    });
    expect(JSON.parse(recorded["profile_deliverer"]!)).toEqual({
      harness: "opencode",
      model: "opencode/muse-spark-1.3-contributor-free",
    });
    // The freeze round-trips back to the configured profiles.
    expect(commanderConfigForRun(config.commander, recorded).agents).toEqual(config.commander.agents);
  });

  test("a malformed freeze falls back to the live configuration field by field", () => {
    const config = parseDispatchConfig({ project: "x" });
    const rerun = commanderConfigForRun(config.commander, {
      profile_builder: "not json",
      profile_reviewer: JSON.stringify({ harness: 42 }),
      profile_deliverer: JSON.stringify(["array"]),
    });
    expect(rerun.agents.builder).toEqual(config.commander.agents.builder);
    // Invalid fields fall back; absent fields stay absent, not inherited.
    expect(rerun.agents.reviewer).toEqual({ harness: "claude", model: "claude-sonnet-5" });
    expect(rerun.agents.deliverer).toEqual(config.commander.agents.deliverer);
  });

  test("a retry reuses the recorded profiles when the configuration drifts", () => {
    const config = parseDispatchConfig({ project: "x" });
    const recorded = recordStageProfiles(config);
    const edited = parseDispatchConfig({
      project: "x",
      agents: {
        builder: { harness: "gemini", model: "new/builder", effort: "low" },
        reviewer: { harness: "opencode", model: "new/reviewer" },
        deliverer: { harness: "claude", model: "new/deliverer", effort: "max" },
      },
    });
    const rerun = commanderConfigForRun(edited.commander, recorded);
    expect(rerun.agents.builder).toMatchObject({
      harness: "opencode",
      model: "opencode/muse-spark-1.3-contributor-free",
    });
    expect(rerun.agents.builder.effort).toBeUndefined();
    expect(rerun.agents.builder.fallback.effort).toBe("high");
    expect(rerun.agents.reviewer.model).toBe("claude-sonnet-5");
    expect(rerun.agents.deliverer.harness).toBe("opencode");
  });

  test("an effective builder model override still wins for the Build stage", () => {
    const config = parseDispatchConfig({ project: "x" });
    const recorded = { ...recordStageProfiles(config), builder: "custom/builder-x" };
    const rerun = commanderConfigForRun(config.commander, recorded);
    expect(rerun.agents.builder.model).toBe("custom/builder-x");
    expect(rerun.agents.builder.harness).toBe("opencode");
    expect(rerun.agents.deliverer.model).toBe("opencode/muse-spark-1.3-contributor-free");
  });

  test("a run without a record falls back to the live configuration", () => {
    const config = parseDispatchConfig({ project: "x" });
    const rerun = commanderConfigForRun(config.commander, {});
    expect(rerun.agents).toEqual(config.commander.agents);
  });
});
