// Bundled Commander assets: rules, defaults, and stage prompts.
//
// These files ship with the Igniter module itself, not with the target
// repository. Every path here derives from this module's own
// `import.meta.url`, so a Commander work order stays valid when Igniter
// runs against a repository that contains no `src/commander/` directory.
// Never resolve these against the target repository's cwd, and never
// hard-code a checkout path.

import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { CommanderStage } from "../dispatch/config.ts";

export interface CommanderAssetPaths {
  /** Directory holding the bundled assets (the `src/commander/` install dir). */
  dir: string;
  /** Absolute path of the bundled Commander rules. */
  rules: string;
  /** Absolute path of the bundled Commander defaults. */
  config: string;
  /** Absolute bundled stage prompt path per stage. */
  prompts: Record<CommanderStage, string>;
}

/** Install dir of the bundled Commander assets, from this module's location. */
export function commanderAssetDir(): string {
  return fileURLToPath(new URL(".", import.meta.url));
}

/** Absolute bundled asset paths. Pass `dir` only to point at a fixture. */
export function commanderAssetPaths(dir: string = commanderAssetDir()): CommanderAssetPaths {
  return {
    dir,
    rules: join(dir, "rules.md"),
    config: join(dir, "config.yaml"),
    prompts: {
      build: join(dir, "stages", "build.md"),
      review: join(dir, "stages", "review.md"),
      deliver: join(dir, "stages", "deliver.md"),
    },
  };
}

function missingAssetError(path: string): Error {
  return new Error(`config error: bundled Commander asset missing: ${path}`);
}

/**
 * Fail fast when any bundled Commander asset is absent or unreadable.
 * Call once at startup; the error names the missing asset. Pass `dir`
 * only to validate a fixture.
 */
export async function assertCommanderAssets(
  dir: string = commanderAssetDir(),
): Promise<CommanderAssetPaths> {
  const paths = commanderAssetPaths(dir);
  const candidates = [paths.rules, paths.config, ...Object.values(paths.prompts)];
  for (const path of candidates) {
    const file = Bun.file(path);
    let text: string | null = null;
    try {
      // Empty reads as missing too: a truncated install must fail here,
      // not later when the Commander opens blank rules or prompts.
      if (await file.exists()) text = await file.text();
    } catch {
      text = null;
    }
    if (!text) throw missingAssetError(path);
  }
  return paths;
}
