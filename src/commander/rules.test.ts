import { describe, expect, test } from "bun:test";

const rules = await Bun.file(new URL("./rules.md", import.meta.url)).text();

describe("Commander acceptance protocol", () => {
  test("uses independent black-box acceptance instead of code review", () => {
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
    expect(rules).toContain("There is no acceptance round budget.");
    expect(rules).toContain("Never turn it into a follow-up ticket and mark the current feature accepted.");
    expect(rules).toContain("There are no round budgets, counters, or token reports.");
  });

  test("keeps Builder, Agent, and Owner receipts distinct in Linear", () => {
    expect(rules).toContain("Builder's delivery signal");
    expect(rules).toContain("an ordinary Markdown Linear\ncomment");
    expect(rules).toContain("Linear does not provide\na comment schema for it.");
    expect(rules).toMatch(/Agent\s+acceptance: PASS/);
    expect(rules).toMatch(/Agent\s+acceptance: FAIL/);
    expect(rules).toContain("That move is the Owner receipt.");
  });

  test("only references the workspace commands, never the old stage protocol", () => {
    for (const command of [
      "`igniter state --json`",
      "`igniter begin`",
      "`igniter submit --input -`",
      "`igniter block --reason",
      "`igniter unblock`",
    ]) {
      expect(rules).toContain(command);
    }
    expect(rules).not.toContain("igniter stage build");
    expect(rules).not.toContain("igniter stage verify");
    expect(rules).not.toContain("igniter stage acceptance");
    expect(rules).not.toContain("igniter stage failed");
    expect(rules).not.toContain("review_count");
    expect(rules).not.toContain("verify_count");
    expect(rules).not.toContain("owner_pending");
    expect(rules).not.toContain("opencode-session-usage");
  });

  test("names the Linear handoffs Review+Complete, Deliver, and Done", () => {
    expect(rules).toContain("Review + Complete");
    expect(rules).toContain("Deliver + Complete");
    expect(rules).toContain("Build + Pending");
  });
});
