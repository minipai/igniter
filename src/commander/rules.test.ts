import { describe, expect, test } from "bun:test";

const rules = await Bun.file(new URL("./rules.md", import.meta.url)).text();

describe("Commander acceptance protocol", () => {
  test("uses independent black-box acceptance instead of default code review", () => {
    expect(rules).toContain("There is no code audit by default.");
    expect(rules).toContain("Instruct it not to inspect source files, git history,\nor git diff.");
    expect(rules).toContain("Each failure must\ncontain the criterion, reproduction steps, expected result, actual result, and\ncaptured evidence.");
  });

  test("requires explicit handoffs instead of trusting Herdr lifecycle state", () => {
    expect(rules).toContain("BUILD_HANDOFF_COMPLETE");
    expect(rules).toContain("ACCEPTANCE_COMPLETE");
    expect(rules).toMatch(/Herdr\s+`done` means only that the current Builder turn ended\./);
    expect(rules).toContain("Treat Herdr `blocked` as a hint, never as proof");
  });

  test("rechecks failed criteria without an acceptance round budget", () => {
    expect(rules).toContain("There is no\nacceptance round budget.");
    expect(rules).toContain("Never turn it into a follow-up ticket and mark the current feature accepted.");
    expect(rules).not.toContain("at most 2\n  review rounds");
    expect(rules).not.toContain('stage failed --reason "round budget spent"');
  });

  test("keeps Builder, Agent, and Owner receipts distinct in Linear", () => {
    expect(rules).toContain("This transition is the Builder's delivery signal");
    expect(rules).toContain("ordinary Markdown Linear comment");
    expect(rules).toContain("Linear does not provide a comment schema for it.");
    expect(rules).toMatch(/Agent\s+acceptance: PASS/);
    expect(rules).toContain("the Linear issue\nremains in the configured review state");
    expect(rules).toContain("Projects that\nname workflow states by phase use `Review`");
    expect(rules).toContain("`Awaiting owner` as the human-visible signal");
    expect(rules).toContain("Do not use `Done` or `Passed` for\nthis handoff");
    expect(rules).toContain("That transition is the Owner receipt.");
  });
});
