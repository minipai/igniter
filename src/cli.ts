#!/usr/bin/env bun
import { API_PORT, WEB_PORT } from "./server/ports.ts";
import { startServer } from "./server/serve.ts";

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const raw = index >= 0 ? process.argv[index + 1] : undefined;
  return raw && !raw.startsWith("--") ? raw : undefined;
}

function resolvePort(): number {
  const fromFlag = flagValue("--port");
  const fromEnv = process.env["IGNITER_PORT"];
  const parsed = Number(fromFlag ?? fromEnv ?? API_PORT);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid port: ${fromFlag ?? fromEnv}`);
  }
  return parsed;
}

function serveCommand(): void {
  const port = resolvePort();
  const server = startServer({ port });
  console.log(`igniter serving on http://localhost:${server.port}`);
}

function devCommand(): void {
  const port = resolvePort();
  const api = Bun.spawn(["bun", "src/cli.ts", "serve", "--port", String(port)], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  const web = Bun.spawn(["bun", "vite", "--port", String(WEB_PORT), "--strictPort"], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  const stop = () => {
    api.kill();
    web.kill();
  };
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
}

const command = process.argv[2];
if (command === "serve") {
  serveCommand();
} else if (command === "dev") {
  devCommand();
} else {
  console.error("usage: igniter <serve|dev> [--port N]");
  process.exit(1);
}
