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

  test("names the Igniter entry: marker file, serve, status, start, owner gates", () => {
    for (const needle of [
      ".igniter/config.yaml",
      "igniter serve",
      "igniter status",
      "igniter start",
      "Review + Complete",
      "Deliver + Complete",
      "Done",
    ]) {
      expect(skill).toContain(needle);
    }
  });

  test("excludes the legacy feature-delivery workflow", () => {
    expect(skill).toContain("feature-delivery");
    expect(skill).toMatch(/do not use.*feature-delivery/i);
  });

  test("copies no Commander or stage protocol", () => {
    for (const needle of [
      "BUILD_HANDOFF_COMPLETE",
      "ACCEPTANCE_COMPLETE",
      "DELIVERY_COMPLETE",
      "igniter submit",
      "igniter begin",
      "builder.fallback",
      "Progress",
    ]) {
      expect(skill).not.toContain(needle);
    }
  });
});
