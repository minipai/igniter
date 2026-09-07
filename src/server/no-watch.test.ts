// The old UI-only compatibility flag is gone: production serve is always a
// command service and never starts a Linear watch loop.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("../cli.ts", import.meta.url).pathname;

describe("serve --no-watch", () => {
  test("is rejected with the replacement behavior", async () => {
    const proc = Bun.spawn(["bun", cli, "serve", "--no-watch"], {
      cwd: mkdtempSync(join(tmpdir(), "igniter-no-watch-")),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });
    void proc.stdin.end();
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(1);
    expect(stderr).toContain("was removed");
    expect(stderr).toContain("never starts a Linear watch");
  });
});
