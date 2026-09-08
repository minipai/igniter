// The thin `igniter` bootstrap skill: entry and boundaries only. It must
// never copy Commander or stage-prompt content, and it must turn the
// legacy feature-delivery workflow away from Igniter-managed repos.

import { describe, expect, test } from "bun:test";

const skill = await Bun.file(new URL("../../skills/igniter/SKILL.md", import.meta.url)).text();

describe("igniter bootstrap skill", () => {
  test("is installable with a name and a description", () => {
    expect(skill).toStartWith("---\n");
    expect(skill).toContain("name: igniter");
    expect(skill).toContain("description:");
  });

  test("names the Global Commander entry: marker file, serve, ticket commands, owner gates", () => {
    for (const needle of [
      ".igniter/config.yaml",
      "Global Commander",
      "igniter serve",
      "igniter status",
      "igniter start",
      "igniter submit",
      "igniter reconcile",
      "Review + Complete",
      "Deliver + Complete",
      "Done",
    ]) {
      expect(skill).toContain(needle);
    }
    expect(skill).toContain("never inside a ticket workspace");
  });

  test("excludes the legacy feature-delivery workflow", () => {
    expect(skill).toContain("feature-delivery");
    expect(skill).toMatch(/do not use.*feature-delivery/i);
  });

  test("copies no stage report or profile protocol", () => {
    for (const needle of [
      "BUILD_HANDOFF_COMPLETE",
      "ACCEPTANCE_COMPLETE",
      "DELIVERY_COMPLETE",
      "builder.fallback",
      "model_reasoning_effort",
    ]) {
      expect(skill).not.toContain(needle);
    }
  });
});
