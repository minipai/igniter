import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("the linked CLI entry point is executable", () => {
  expect(statSync(join(import.meta.dir, "cli.ts")).mode & 0o111).toBe(0o111);
});

test("the published package runs outside the checkout with its bundled assets", async () => {
  const root = join(import.meta.dir, "..");
  const temp = mkdtempSync(join(tmpdir(), "igniter-package-"));
  const env = { PATH: process.env.PATH ?? "" };
  const run = (cmd: string[], cwd = temp): string => {
    const result = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString();
  };

  try {
    // Bun's pack command loads .env even with --no-env-file. Pack a source
    // snapshot with only dummy project data, never the checkout's credentials.
    const source = join(temp, "source");
    mkdirSync(source);
    for (const name of ["package.json", "README.md", "LICENSE", "src"]) {
      cpSync(join(root, name), join(source, name), { recursive: true });
    }
    for (const file of [".igniter/config.yaml", ".igniter/serve.out", "docs/test.md", "scripts/test.ts", "skills/example/SKILL.md"]) {
      mkdirSync(join(source, file, ".."), { recursive: true });
      writeFileSync(join(source, file), "packaging fixture\n");
    }
    const tarball = join(temp, "igniter.tgz");
    run([process.execPath, "--no-env-file", "pm", "pack", "--ignore-scripts", "--quiet", "--filename", tarball], source);
    const files = run(["tar", "-tzf", tarball]).trim().split("\n");
    for (const file of files) {
      expect(file).not.toMatch(/(^|\/)(\.igniter|\.env[^/]*|docs|e2e|scripts|skills|node_modules)(\/|$)/);
      expect(file).not.toMatch(/\.test\.[^/]+$/);
      expect(file).not.toMatch(/\/(fake-[^/]+|generate-types\.ts|serve\.out)$/);
    }
    for (const file of [
      "package.json", "README.md", "LICENSE", "src/cli.ts",
      "src/commander/assets.ts", "src/commander/rules.md", "src/commander/config.yaml",
      "src/commander/global.md", "src/commander/stages/build.md",
      "src/commander/stages/review.md", "src/commander/stages/deliver.md",
    ]) {
      expect(files).toContain(`package/${file}`);
    }
    run(["tar", "-xzf", tarball, "-C", temp]);
    const installed = join(temp, "package");
    const pkg = await Bun.file(join(installed, "package.json")).json();
    mkdirSync(join(installed, "node_modules"));
    // Copy installed dependencies so this smoke test needs no registry.
    for (const name of ["cac"]) {
      const source = realpathSync(join(root, "node_modules", name));
      const dependency = await Bun.file(join(source, "package.json")).json();
      expect(pkg.dependencies[name]).toBe(dependency.version);
      cpSync(source, join(installed, "node_modules", name), { recursive: true });
    }
    const bun = [process.execPath, "--no-env-file", "--no-install"];
    expect(run([join(installed, pkg.bin.igniter), "--version"]).trim()).toBe(pkg.version);
    const assetsUrl = pathToFileURL(join(installed, "src/commander/assets.ts")).href;
    const paths = JSON.parse(run([
      ...bun, "--eval",
      `const { assertCommanderAssets } = await import(${JSON.stringify(assetsUrl)}); console.log(JSON.stringify(await assertCommanderAssets()));`,
    ]));
    expect(paths.dir).toBe(`${realpathSync(join(installed, "src/commander"))}/`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
