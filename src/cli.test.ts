import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";

const cli = new URL("./cli.ts", import.meta.url).pathname;
const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
  version: string;
};

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runCli(args: string[], cwd?: string): Promise<CliResult> {
  const proc = Bun.spawn(["bun", cli, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("cli --version", () => {
  test("--version prints the package.json version and exits 0", async () => {
    const result = await runCli(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  test("-v behaves identically", async () => {
    const result = await runCli(["-v"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  test("version resolves from any directory", async () => {
    const result = await runCli(["--version"], tmpdir());
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  test("usage with no arguments lists --version and exits 1", async () => {
    const result = await runCli([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--version");
  });
});
