import { describe, expect, test } from "bun:test";

const commonRules = await Bun.file(new URL("./rules.md", import.meta.url)).text();
const commanderConfig = Bun.YAML.parse(
  await Bun.file(new URL("./config.yaml", import.meta.url)).text(),
) as {
  agents: {
    builder: { harness: string; model: string; fallback: { harness: string; model: string } };
    reviewer: { harness: string; model: string };
  };
  stages: Record<"build" | "review" | "deliver", { prompt: string; agent: string }>;
};
const stageNames = ["build", "review", "deliver"] as const;
const stageDocuments = stageNames.map((stage) => `./${commanderConfig.stages[stage].prompt}`);
const stageRules = await Promise.all(
  stageDocuments.map((path) => Bun.file(new URL(path, import.meta.url)).text()),
);
const rules = [commonRules, ...stageRules].join("\n");

describe("Commander delivery protocol", () => {
  test("passes one prompt to each stage worker", () => {
    expect(commonRules).toContain("src/commander/config.yaml");
    expect(commanderConfig.stages.build.prompt).toBe("stages/build.md");
    expect(commanderConfig.stages.review.prompt).toBe("stages/review.md");
    expect(commanderConfig.stages.deliver.prompt).toBe("stages/deliver.md");
    expect(commanderConfig.agents.builder.harness).toBe("opencode");
    expect(commanderConfig.agents.reviewer.harness).toBe("claude");
    expect(commanderConfig.agents.builder.fallback.harness).toBe("codex");
    expect(commonRules).toContain("builder.fallback");
    expect(stageRules[0]).toStartWith("# Build agent");
    expect(stageRules[1]).toStartWith("# Acceptance agent");
    expect(stageRules[2]).toStartWith("# Deliver agent");
    expect(commonRules).toContain("The Commander does not read stage prompts into its own context.");
  });

  test("keeps every workspace command with the Commander", () => {
    expect(commonRules).toContain("Only the Commander runs workspace commands.");
    for (const command of [
      "`igniter state --json`",
      "`igniter begin`",
      "`igniter submit --input -`",
      "`igniter block --reason",
      "`igniter unblock`",
    ]) {
      expect(commonRules).toContain(command);
    }
    for (const prompt of stageRules) {
      expect(prompt).toContain("Do not operate Igniter or Linear; report only to the Commander.");
      expect(prompt).not.toMatch(/igniter (?:state|begin|submit|block|unblock)/);
    }
  });

  test("uses independent black-box acceptance instead of code review", () => {
    expect(stageRules[1]).toContain("This is black-box acceptance, not code review.");
    expect(stageRules[1]).toContain("Do not inspect source files, git\nhistory, or git diff.");
    expect(stageRules[1]).toContain("Report exactly one\nresult for every observable criterion.");
    expect(commonRules).toContain("There is no code audit by\ndefault.");
  });

  test("requires complete reports instead of trusting Herdr state", () => {
    expect(stageRules[0]).toContain("BUILD_HANDOFF_COMPLETE");
    expect(stageRules[0]).toContain("Do not start a\n  second code-review pass.");
    expect(commonRules).toContain("one-pass code-review result");
    expect(stageRules[1]).toContain("ACCEPTANCE_COMPLETE");
    expect(stageRules[2]).toContain("DELIVERY_COMPLETE");
    expect(commonRules).toContain("A Herdr lifecycle state is not a result.");
    expect(commonRules).toContain("Never infer success from `done`");
  });

  test("runs Deliver in a separate worker without another configured model", () => {
    expect(commonRules).toContain("`deliverer-<ticket>`");
    expect(commanderConfig.stages.build.agent).toBe("builder");
    expect(commanderConfig.stages.review.agent).toBe("reviewer");
    expect(commanderConfig.stages.deliver.agent).toBe("builder");
    expect(stageRules[2]).toContain("`diffwalk inspect`");
    expect(stageRules[2]).toContain("`diffwalk check`");
    expect(stageRules[2]).toContain("`diffwalk publish`");
    expect(stageRules[2]).not.toContain("required delivery artifact");
  });

  test("names the legal Linear handoffs", () => {
    expect(commonRules).toContain("Build lands in Review + Pending.");
    expect(commonRules).toContain("Review PASS lands in Review + Complete.");
    expect(commonRules).toContain("Review FAIL lands in Build + Pending.");
    expect(commonRules).toContain("Deliver lands in Deliver + Complete.");
    expect(commonRules).toContain("Deliver + Complete to Done");
  });

  test("never references the old stage protocol", () => {
    expect(rules).not.toContain("igniter stage build");
    expect(rules).not.toContain("igniter stage verify");
    expect(rules).not.toContain("igniter stage acceptance");
    expect(rules).not.toContain("igniter stage failed");
    expect(rules).not.toContain("review_count");
    expect(rules).not.toContain("verify_count");
    expect(rules).not.toContain("owner_pending");
    expect(rules).not.toContain("opencode-session-usage");
  });
});
