import { describe, expect, test } from "bun:test";
import { foregroundCommandFor, launchFor, launchProblems, recordStageProfiles, selectStageAgent } from "./agents";
import { parseDispatchConfig, STAGE_AGENTS } from "../../config/config";

describe("command launches", () => {
  test("custom executable and shell arguments pass through unchanged", () => {
    const command = 'HERDR_AGENT=opencode /opt/bin/opencode2 mini -m "provider/model#high"';
    expect(launchFor({ command })).toEqual({ command });
    expect(launchFor({ command: "custom-agent --anything" })).toEqual({ command: "custom-agent --anything" });
  });

  test("Commander passes hostile prompt text as one literal shell argument", () => {
    const prompt = "don't execute $(printf INJECTED); `printf INJECTED`\n\"quotes\" $HOME \\";
    const argv = foregroundCommandFor({ command: "printf '%s' {prompt}" }, prompt);
    const result = Bun.spawnSync(argv);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(prompt);
  });

  test("Commander requires one unquoted standalone prompt placeholder", () => {
    for (const command of ["agent", 'agent "{prompt}"', "agent '{prompt}'", "agent --prompt={prompt}", "agent {prompt} {prompt}", 'agent "x {prompt} y"']) {
      expect(() => foregroundCommandFor({ command }, "order")).toThrow();
    }
    expect(foregroundCommandFor({ command: "opencode2 mini --prompt {prompt}" }, "order")).toEqual([
      "sh", "-c", "opencode2 mini --prompt 'order'",
    ]);
  });

  test("workers receive work through Herdr, not a startup placeholder", () => {
    expect(() => launchFor({ command: "agent {prompt}" })).toThrow("worker commands cannot contain {prompt}");
  });

  test("Commander refuses commented prompts but permits model variants and completed comments", () => {
    for (const command of ["codex # {prompt}", "# {prompt}", "codex;# {prompt}"]) {
      expect(() => foregroundCommandFor({ command }, "order")).toThrow("shell comment");
    }
    const command = '# comment with an unmatched quote "\nprintf "%s" {prompt}';
    expect(Bun.spawnSync(foregroundCommandFor({ command }, "literal # text")).stdout.toString()).toBe("literal # text");
    expect(foregroundCommandFor({ command: "opencode mini -m openai/gpt-6-luna#high --prompt {prompt}" }, "order")[2])
      .toContain("openai/gpt-6-luna#high --prompt 'order'");
  });

  test("validation names the invalid command profile", () => {
    expect(launchProblems(parseDispatchConfig({ project: "x" }))).toEqual([]);
    const config = parseDispatchConfig({ project: "x", agents: { commander: { command: "agent" }, builder: { command: "agent {prompt}" } } });
    expect(launchProblems(config)).toEqual([
      expect.stringContaining('agents."commander"'),
      expect.stringContaining('agents."builder"'),
    ]);
  });
});

describe("run-recorded commands", () => {
  test("roles remain fixed and explicit candidates use their own command", () => {
    expect(STAGE_AGENTS).toEqual({ build: "builder", acceptance: "acceptance", deliver: "deliverer" });
    const { commander } = parseDispatchConfig({ project: "x", agents: { specialist: { command: "special-agent --flag" } } });
    expect(selectStageAgent(commander, {}, "build", "specialist")).toEqual({ name: "specialist", profile: { command: "special-agent --flag" } });
    expect(() => selectStageAgent(commander, {}, "build", "missing")).toThrow("missing");
  });

  test("retries preserve complete commands across config changes", () => {
    const config = parseDispatchConfig({ project: "x", agents: { builder: { command: "opencode2 mini -m original" } } });
    const tokens = recordStageProfiles(config);
    const changed = parseDispatchConfig({ project: "x", agents: { builder: { command: "other-agent --new" } } });
    expect(selectStageAgent(changed.commander, tokens, "build").profile.command).toBe("opencode2 mini -m original");
    expect(selectStageAgent(changed.commander, {}, "build").profile.command).toBe("other-agent --new");
    expect(selectStageAgent(changed.commander, { ...tokens, agent_builder: "specialist" }, "build")).toEqual({ name: "specialist", profile: { command: "opencode2 mini -m original" } });
  });

  test("malformed and legacy records cannot silently select a different command", () => {
    const { commander } = parseDispatchConfig({ project: "x" });
    for (const profile_builder of ['{', '{"harness":"codex","model":"old"}', '{"command":""}']) {
      expect(() => selectStageAgent(commander, { profile_builder }, "build")).toThrow("recorded agent");
    }
  });
});
