import { describe, expect, test } from "bun:test";

const commonRules = await Bun.file(new URL("./rules.md", import.meta.url)).text();
const commanderConfig = Bun.YAML.parse(
  await Bun.file(new URL("./config.yaml", import.meta.url)).text(),
) as {
  agents: {
    commander: { harness: string; model: string; effort?: string };
    builder: { harness: string; model: string; effort?: string; fallback: { harness: string; model: string; effort?: string } };
    reviewer: { harness: string; model: string; effort?: string };
    deliverer: { harness: string; model: string; effort?: string };
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
    expect(commonRules).toContain("bundled Commander defaults");
    expect(commonRules).toContain("absolute bundled path");
    expect(commonRules).toContain("a repository cannot override them");
    expect(commonRules).toContain("Igniter-owned and pre-authorized read-only");
    expect(commonRules).not.toContain("src/commander/config.yaml");
    expect(commanderConfig.stages.build.prompt).toBe("stages/build.md");
    expect(commanderConfig.stages.review.prompt).toBe("stages/review.md");
    expect(commanderConfig.stages.deliver.prompt).toBe("stages/deliver.md");
    expect(commanderConfig.agents.commander.harness).toBe("codex");
    expect(commanderConfig.agents.commander.model).toBe("gpt-5.6-sol");
    expect(commanderConfig.agents.commander.effort).toBe("high");
    expect(commanderConfig.agents.builder.harness).toBe("opencode");
    expect(commanderConfig.agents.reviewer.harness).toBe("claude");
    expect(commanderConfig.agents.reviewer.effort).toBe("high");
    expect(commanderConfig.agents.deliverer.harness).toBe("opencode");
    expect(commanderConfig.agents.builder.fallback.harness).toBe("codex");
    expect(commanderConfig.agents.builder.fallback.model).toBe("gpt-5.6-sol");
    expect(commanderConfig.agents.builder.fallback.effort).toBe("high");
    expect(commonRules).toContain("builder.fallback");
    expect(stageRules[0]).toStartWith("# Build agent");
    expect(stageRules[1]).toStartWith("# Acceptance agent");
    expect(stageRules[2]).toStartWith("# Deliver agent");
    expect(commonRules).toContain("The Commander does not read stage prompts into its own context.");
    expect(commonRules).toContain("Never\nstart a Claude stage worker with `--remote-control`");
    expect(commonRules).not.toContain("--claude-allow-dir");
    expect(commonRules).not.toContain("--codex-allow-path");
    expect(commonRules).not.toContain("--opencode-allow");
  });

  test("keeps every ticket command with the Global Commander", () => {
    expect(commonRules).toContain("Only the Global Commander runs ticket commands");
    expect(commonRules).toContain("There is no resident commander-ticket agent");
    expect(commonRules).toContain("`igniter start [<ticket>]`");
    for (const command of [
      "`igniter status <ticket> --json`",
      "`igniter begin <ticket>`",
      "`igniter submit <ticket> --input -`",
      "`igniter block <ticket> --reason",
      "`igniter unblock <ticket>`",
      "`igniter reconcile <ticket>`",
    ]) {
      expect(commonRules).toContain(command);
    }
    expect(stageRules[0]).toContain("Do not operate Igniter or Linear; report only to the Commander.");
    expect(stageRules[1]).toContain("Report only to the Commander.");
    expect(stageRules[2]).toContain("Do not operate Igniter or Linear; report only to the Commander.");
    for (const prompt of stageRules) {
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

  test("Build publishes Diffwalk and Deliver merges local main", () => {
    expect(commonRules).toContain("`deliverer-<ticket>`");
    expect(commanderConfig.stages.build.agent).toBe("builder");
    expect(commanderConfig.stages.review.agent).toBe("reviewer");
    expect(commanderConfig.stages.deliver.agent).toBe("deliverer");
    expect(stageRules[0]).toContain("`diffwalk inspect`");
    expect(stageRules[0]).toContain("`diffwalk check`");
    expect(stageRules[0]).toContain("`diffwalk publish`");
    expect(stageRules[0]).toContain("the published Diffwalk link");
    expect(stageRules[2]).not.toContain("diffwalk");
    expect(stageRules[2]).toContain("Merge the accepted checkpoint into the repository's local `main` branch");
    expect(stageRules[2]).toContain("Do not stop after preparing the merge");
    expect(stageRules[2]).not.toContain("required delivery artifact");
  });

  test("names the legal Linear handoffs", () => {
    expect(commonRules).toContain("Build lands in Review + Pending.");
    expect(commonRules).toContain("Review PASS lands in Review + Complete.");
    expect(commonRules).toContain("Review FAIL lands in Build + Pending.");
    expect(commonRules).toContain("Deliver lands in Deliver + Complete.");
    expect(commonRules).toContain("Deliver + Complete to Done");
  });

  test("keeps Linear publication with the Commander", () => {
    expect(commonRules).toContain("call Linear directly or through MCP");
    expect(stageRules[1]).toContain("Report only to the Commander.");
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

  test("asks the owner only from Blocked", () => {
    expect(commonRules).toContain("Ask the owner only from Blocked");
    expect(commonRules).toContain('`igniter block <ticket> --reason "<what you need>"`');
    expect(commonRules).toContain("Review + Blocked");
    expect(commonRules).toContain("`igniter unblock <ticket>`");
    expect(commonRules).toContain("`igniter begin <ticket>`");
  });
});
