#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function attribute(source: string, name: string): string {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(source);
  return decodeXml(match?.[1] ?? "unknown");
}

const temp = mkdtempSync(join(tmpdir(), "igniter-e2e-report-"));
const report = join(temp, "results.xml");
try {
  const child = Bun.spawn([
    process.execPath,
    "test",
    "src/e2e",
    "--timeout",
    "30000",
    "--reporter=junit",
    `--reporter-outfile=${report}`,
  ], {
    cwd: join(import.meta.dir, "..", "..", ".."),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const xml = readFileSync(report, "utf8");
  const cases = [...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)];
  let failed = 0;
  for (const found of cases) {
    const attrs = found[1] ?? "";
    const body = found[2] ?? "";
    const status = body.includes("<failure") || body.includes("<error")
      ? "FAIL"
      : body.includes("<skipped")
        ? "SKIP"
        : "PASS";
    if (status === "FAIL") failed += 1;
    console.log(`${status} ${attribute(attrs, "classname")} > ${attribute(attrs, "name")}`);
  }
  console.log(`E2E ${cases.length - failed} passed, ${failed} failed`);
  if (code !== 0) {
    if (stdout) process.stderr.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (failed === 0) console.error("FAIL e2e runner exited before reporting a test case");
    process.exit(code);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
