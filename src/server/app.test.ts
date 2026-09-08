import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { buildHealth } from "./health";

describe("health", () => {
  test("builds the versioned payload", () => {
    expect(buildHealth()).toEqual({ ok: true, service: "igniter" });
  });
});

describe("app routes", () => {
  test("/api/health returns Bun JSON", async () => {
    const app = createApp();
    const res = await app(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "igniter" });
  });

  test("unknown paths are JSON 404 because the service has no Web UI", async () => {
    const app = createApp();
    const res = await app(new Request("http://localhost/"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "not found" });
  });
});
