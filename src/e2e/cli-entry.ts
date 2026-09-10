#!/usr/bin/env bun
import { executeCommand, runCli } from "../cli.ts";
import { LinearError, type LinearClientLike } from "../dispatch/linear.ts";
import type { CommandWorkspaces } from "../dispatch/workspaces.ts";
import type { PromptDeliveryPolicy } from "../dispatch/prompt-delivery.ts";

const rpcUrl = process.env["IGNITER_E2E_RPC"];
if (!rpcUrl) throw new Error("IGNITER_E2E_RPC is missing");

const client = remote<LinearClientLike>(rpcUrl, "linear");
const workspaces = remote<CommandWorkspaces>(rpcUrl, "workspaces");
const promptDelivery = JSON.parse(process.env["IGNITER_E2E_PROMPT_DELIVERY"] ?? "{}") as PromptDeliveryPolicy;

process.exitCode = await runCli(process.argv.slice(2), {
  run: (command) => executeCommand(command, {
    client,
    workspaces,
    promptDelivery,
  }),
  readStdin: () => new Response(Bun.stdin.stream()).text(),
  stdout: console.log,
  stderr: console.error,
  launch: async (command, cwd) => {
    const agent = Bun.spawn(command, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return agent.exited;
  },
});

function remote<T extends object>(url: string, target: "linear" | "workspaces"): T {
  return new Proxy({}, {
    get: (_object, method) => async (...args: unknown[]) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, method: String(method), args }),
      });
      const reply = await response.json() as {
        ok: boolean;
        value?: unknown;
        error?: string;
        status?: number;
      };
      if (!reply.ok) {
        if (target === "linear" && typeof reply.status === "number") {
          throw new LinearError(reply.status, reply.error ?? "fake Linear failed");
        }
        throw new Error(reply.error ?? `fake ${target} failed`);
      }
      return revive(reply.value);
    },
  }) as T;
}

function revive(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "__set" in value) {
    return new Set((value as { __set: unknown[] }).__set);
  }
  return value;
}
