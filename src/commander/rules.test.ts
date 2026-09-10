import { describe, expect, test } from "bun:test";
import { buildCommanderLaunchPrompt } from "../workflow/lifecycle/stage/commander-start.ts";

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
  test.each([undefined, { identifier: "STA-1", title: "Build a feature" }])("foreground launch points to Global Commander instructions and explicit status: %j", (assignment) => {
    const order = buildCommanderLaunchPrompt({
      project: "fixture", team: "STA", repoRoot: "/fixture", targetBranch: "main",
      globalMd: "/fixture/global.md",
      assignment,
    });
    expect(order).toContain("/fixture/global.md");
    expect(order).toContain(assignment ? "igniter status STA-1 --json" : "igniter status --json");

  });

  test("the startup document loads complete Commander rules", async () => {
    const globalUrl = new URL("./global.md", import.meta.url);
    const global = await Bun.file(globalUrl).text();
    const rulesLink = global.match(/\[Commander rules\]\(([^)]+)\)/);
    expect(rulesLink).not.toBeNull();
    const linkedRules = await Bun.file(new URL(rulesLink![1]!, globalUrl)).text();
    expect(linkedRules).toBe(commonRules);
    expect(global).toContain("Before any ticket action");
    expect(linkedRules).toContain("Deliver + Complete to Done only after");
    expect(linkedRules).toContain("If integration moves the ticket to Done first");
    expect(linkedRules).toContain("the change has landed");
  });

  test("passes one prompt to each stage worker", () => {
    expect(commonRules).toContain("bundled Commander defaults");
    expect(commonRules).toContain("completely replaces the bundled Build, Review, and Deliver");
    expect(commonRules).toContain("absolute configured path");
    expect(commonRules).toContain("repository stage prompts named by absolute");
    expect(commonRules).not.toContain("src/commander/config.yaml");
    expect(commanderConfig.stages.build.prompt).toBe("stages/build.md");
    expect(commanderConfig.stages.review.prompt).toBe("stages/review.md");
    expect(commanderConfig.stages.deliver.prompt).toBe("stages/deliver.md");
    expect(commanderConfig.agents.commander.harness).toBe("codex");
    expect(commanderConfig.agents.commander.model).toBe("gpt-6-astra");
    expect(commanderConfig.agents.commander.effort).toBe("medium");
    expect(commanderConfig.agents.builder.harness).toBe("codex");
    expect(commanderConfig.agents.builder.model).toBe("gpt-5.6-terra");
    expect(commanderConfig.agents.builder.effort).toBeUndefined();
    expect(commanderConfig.agents.reviewer.harness).toBe("codex");
    expect(commanderConfig.agents.reviewer.model).toBe("gpt-5.6-sol");
    expect(commanderConfig.agents.reviewer.effort).toBe("high");
    expect(commanderConfig.agents.deliverer.harness).toBe("codex");
    expect(commanderConfig.agents.deliverer.model).toBe("gpt-5.6-luna");
    expect(commanderConfig.agents.deliverer.effort).toBe("high");
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
      "`igniter approve <ticket> --receipt <id>`",
      "`igniter worker start <ticket>`",
      "`igniter block <ticket> --reason",
      "`igniter unblock <ticket>`",
      "`igniter reconcile <ticket>`",
    ]) {
      expect(commonRules).toContain(command);
    }
    expect(commonRules).toContain("Workers never run Igniter commands");
    for (const prompt of stageRules) {
      expect(prompt).not.toMatch(/igniter (?:state|begin|submit|block|unblock)/);
    }
  });

  test("separates worker delivery, Linear start, and explicit approval", async () => {
    const global = await Bun.file(new URL("./global.md", import.meta.url)).text();
    expect(commonRules).toContain("status -> worker start -> confirmed -> begin");
    expect(commonRules).toContain("owner approval -> approve -> worker start -> confirmed -> begin");
    expect(commonRules).toContain("only validates and records the current stage start");
    expect(commonRules).toContain("Worker commands may read ticket context but never write Linear");
    expect(global).toContain("do not create or prompt another worker");
    expect(global).toContain("retry only with the original receipt identity");
    expect(global).toContain("explicitly stop workers for safe");
    expect(commonRules).toContain("Ordinary sync, status,");
    expect(commonRules).toContain("or a request to continue is not approval");
    for (const text of [commonRules, global]) {
      expect(text).not.toMatch(/igniter (?:pause|resume|restart|answer)\b/);
      expect(text).not.toContain("begin <ticket>` launches");
      expect(text).toContain("--receipt <id>");
      for (const action of ["start", "send", "restart", "stop", "answer"]) {
        expect(text).toContain(`igniter worker ${action} <ticket>`);
      }
    }
  });

  test("uses independent black-box acceptance instead of code review", () => {
    expect(stageRules[1]).toContain("This is black-box acceptance, not code review.");
    expect(stageRules[1]).toContain("Do not inspect source files, git history, or diffs.");
    expect(stageRules[1]).toContain("Report one PASS or FAIL for every observable acceptance criterion.");
    expect(commonRules).toContain("There is no code audit by\ndefault.");
  });

  test("requires complete reports instead of trusting Herdr state", () => {
    expect(commonRules).toContain("BUILD_HANDOFF_COMPLETE");
    expect(stageRules[0]).toContain("evidence");
    expect(commonRules).toContain("ACCEPTANCE_COMPLETE");
    expect(commonRules).toContain("DELIVERY_COMPLETE");
    for (const prompt of stageRules) {
      expect(prompt).not.toMatch(/(?:BUILD_HANDOFF|ACCEPTANCE|DELIVERY)_COMPLETE/);
    }
    expect(commonRules).toContain("A Herdr lifecycle state is not a result.");
    expect(commonRules).toContain("Never infer success from `done`");
  });

  test("reviews worker artifacts without rewriting their submission payload", async () => {
    const global = await Bun.file(new URL("./global.md", import.meta.url)).text();
    for (const document of [commonRules, global]) {
      expect(document).toContain("`submit.json`");
      expect(document).toContain("`result.md`");
      expect(document).toContain("same canonical source as status");
      expect(document).toContain("code-review");
      expect(document).toContain("unresolved concerns");
      expect(document).toContain("`owner_actions`");
      expect(document).toContain('igniter submit <ticket> --input - < "/absolute/scratch/submit.json"');
      expect(document).toContain("unchanged");
      expect(document).toContain("same worker");
      expect(document).toContain("do not prove");
      expect(document).not.toContain("converts the report to JSON");
    }
    expect(commonRules).toContain("marker as the final line of `result.md`");
    expect(commonRules).toContain("absent, unfinished, malformed, schema-invalid, or stale artifact");
    expect(commonRules).toContain("Never supply missing results yourself");
    expect(global).toContain("Both files are required");
    expect(global).toContain("Missing files or markers");
    expect(global).toContain("parse errors, schema omissions, and checkpoint mismatches");
  });

  test("keeps workflow-specific artifacts out of the bundled stages", () => {
    expect(commonRules).toContain("`deliverer-<ticket>`");
    expect(commanderConfig.stages.build.agent).toBe("builder");
    expect(commanderConfig.stages.review.agent).toBe("reviewer");
    expect(commanderConfig.stages.deliver.agent).toBe("deliverer");
    expect(rules.toLowerCase()).not.toContain("diffwalk");
    expect(rules).not.toContain("--publish-review");
    expect(stageRules[0]).toContain("repository instructions");
    expect(stageRules[0]).toContain("evidence");
    expect(stageRules[2]).toContain("Complete the configured landing procedure");
    expect(stageRules[2]).not.toContain("required delivery artifact");
  });

  test("names the legal Linear handoffs", () => {
    expect(commonRules).toContain("The first Build lands in Build + Complete and waits there");
    expect(commonRules).toContain("A correction Build (after a Review FAIL or after the owner sends Review");
    expect(commonRules).toContain("Review PASS lands in Review + Complete.");
    expect(commonRules).toContain("Review FAIL lands in Build + Pending.");
    expect(commonRules).toContain("Deliver lands in Deliver + Complete.");
    expect(commonRules).toContain("Deliver + Complete to Done");
    expect(commonRules).toContain("The Acceptance agent never modifies product code");
    expect(stageRules[1]).toContain("Never modify product code");
  });

  test("keeps Linear publication with the Commander", () => {
    expect(commonRules).toContain("call Linear directly or through MCP");
    expect(commonRules).toContain("The only process allowed to move its Igniter and Linear state.");
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
