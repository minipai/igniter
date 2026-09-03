import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { buildHealth } from "./health";

function fixtureDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "igniter-dist-"));
  writeFileSync(join(dir, "index.html"), "<html><body>igniter</body></html>");
  writeFileSync(join(dir, "app.js"), "console.log(1)");
  return dir;
}

describe("health", () => {
  test("builds the versioned payload", () => {
    expect(buildHealth()).toEqual({ ok: true, service: "igniter" });
  });
});

describe("app routes", () => {
  test("/api/health returns Bun JSON", async () => {
    const app = createApp({ distDir: fixtureDist() });
    const res = await app(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "igniter" });
  });

  test("unknown /api paths are JSON 404, never HTML", async () => {
    const app = createApp({ distDir: fixtureDist() });
    const res = await app(new Request("http://localhost/api/tickets"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("/events opens the SSE boundary", async () => {
    const app = createApp({ distDir: fixtureDist() });
    const res = await app(new Request("http://localhost/events"));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (let i = 0; i < 2; i++) {
      const chunk = await reader?.read();
      text += decoder.decode(chunk?.value);
    }
    expect(text).toContain("event: ready");
    reader?.cancel();
  });

  test("client-side route falls back to index.html", async () => {
    const app = createApp({ distDir: fixtureDist() });
    const res = await app(new Request("http://localhost/tickets/STA-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("igniter");
  });

  test("missing assets 404 instead of serving HTML", async () => {
    const app = createApp({ distDir: fixtureDist() });
    const res = await app(new Request("http://localhost/assets/missing.js"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });

  test("path traversal does not escape dist", async () => {
    const app = createApp({ distDir: fixtureDist() });
    const res = await app(new Request("http://localhost/../app.ts"));
    expect(res.status).toBe(404);
  });
});
