// Bundled Commander assets resolve from the running Igniter module, never
// from the target repository's cwd or a fixed checkout path. No network,
// no real credentials, no real project.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAbsolute } from "node:path";
import {
  assertCommanderAssets,
  commanderAssetDir,
  commanderAssetPaths,
} from "./assets";

describe("commanderAssetPaths", () => {
  test("derives absolute paths from the module location, not the target repo", async () => {
    // A target repo with no src/commander/ at all.
    const repoRoot = mkdtempSync(join(tmpdir(), "igniter-target-"));
    const paths = commanderAssetPaths();
    const selfDir = commanderAssetDir();
    const { fileURLToPath } = await import("node:url");
    expect(selfDir).toBe(fileURLToPath(new URL(".", import.meta.url)));
    expect(paths.dir).toBe(selfDir);
    for (const path of [paths.rules, paths.config, paths.global, ...Object.values(paths.prompts)]) {
      expect(isAbsolute(path)).toBe(true);
      expect(path.startsWith(repoRoot)).toBe(false);
      expect(await Bun.file(path).exists()).toBe(true);
      expect((await Bun.file(path).text()).length).toBeGreaterThan(0);
    }
  });

  test("names rules, defaults, global instructions, and one prompt per stage", async () => {
    const paths = commanderAssetPaths();
    expect(paths.rules.endsWith("rules.md")).toBe(true);
    expect(paths.config.endsWith("config.yaml")).toBe(true);
    expect(paths.global.endsWith("global.md")).toBe(true);
    expect(paths.prompts.build.endsWith(join("stages", "build.md"))).toBe(true);
    expect(paths.prompts.acceptance.endsWith(join("stages", "acceptance.md"))).toBe(true);
    expect(paths.prompts.deliver.endsWith(join("stages", "deliver.md"))).toBe(true);
    expect(await Bun.file(paths.rules).text()).toStartWith("# Commander rules");
    expect(await Bun.file(paths.global).text()).toStartWith("# Global Commander instructions");
    expect(await Bun.file(paths.prompts.build).text()).toStartWith("# Build agent");
    expect(await Bun.file(paths.prompts.acceptance).text()).toStartWith("# Acceptance agent");
    expect(await Bun.file(paths.prompts.deliver).text()).toStartWith("# Deliver agent");
  });

  test("derives from the module, not a fixed checkout path or cwd", async () => {
    const source = await Bun.file(new URL("./assets.ts", import.meta.url)).text();
    expect(source).not.toContain("/Users/");
    expect(source).not.toContain("/home/");
    expect(source).toContain("import.meta.url");
    expect(source).not.toContain("process.cwd()");
    expect(commanderAssetDir()).not.toBe(process.cwd());
  });
});

describe("assertCommanderAssets", () => {
  function fixture(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "igniter-assets-"));
    for (const [name, body] of Object.entries(files)) {
      const full = join(dir, name);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, body);
    }
    return dir;
  }

  test("passes when every bundled asset exists and is readable", async () => {
    const paths = await assertCommanderAssets();
    expect(isAbsolute(paths.rules)).toBe(true);
  });

  test("a complete fixture validates too", async () => {
    const dir = fixture({
      "rules.md": "# Commander rules\n",
      "config.yaml": "agents: {}\n",
      "global.md": "# Global Commander instructions\n",
      "stages/build.md": "# Build agent\n",
      "stages/acceptance.md": "# Acceptance agent\n",
      "stages/deliver.md": "# Deliver agent\n",
    });
    const paths = await assertCommanderAssets(dir);
    expect(paths.rules).toBe(join(dir, "rules.md"));
  });

  test("a missing global instructions file fails fast naming the absent asset", async () => {
    const dir = fixture({
      "rules.md": "# Commander rules\n",
      "config.yaml": "agents: {}\n",
      "stages/build.md": "# Build agent\n",
      "stages/acceptance.md": "# Acceptance agent\n",
      "stages/deliver.md": "# Deliver agent\n",
    });
    await expect(assertCommanderAssets(dir)).rejects.toThrow(join(dir, "global.md"));
  });

  test("a missing stage prompt fails fast naming the absent asset", async () => {
    const dir = fixture({
      "rules.md": "# Commander rules\n",
      "config.yaml": "agents: {}\n",
      "global.md": "# Global Commander instructions\n",
      "stages/build.md": "# Build agent\n",
      "stages/acceptance.md": "# Acceptance agent\n",
    });
    const missing = join(dir, "stages", "deliver.md");
    await expect(assertCommanderAssets(dir)).rejects.toThrow(missing);
  });

  test("a missing rules.md fails fast naming the absent asset", async () => {
    const dir = fixture({ "config.yaml": "agents: {}\n" });
    await expect(assertCommanderAssets(dir)).rejects.toThrow(join(dir, "rules.md"));
  });

  test("an empty stage prompt fails fast like a missing one", async () => {
    const dir = fixture({
      "rules.md": "# Commander rules\n",
      "config.yaml": "agents: {}\n",
      "global.md": "# Global Commander instructions\n",
      "stages/build.md": "# Build agent\n",
      "stages/acceptance.md": "# Acceptance agent\n",
      "stages/deliver.md": "",
    });
    await expect(assertCommanderAssets(dir)).rejects.toThrow(join(dir, "stages", "deliver.md"));
  });
});
