import { buildHealth } from "./health";
import { LinearError } from "../dispatch/linear.ts";
import { type DispatchApi } from "../dispatch/claims.ts";

export interface AppOptions {
  dispatch?: DispatchApi;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function createApp(options: AppOptions = {}): (req: Request) => Promise<Response> {
  const dispatch = options.dispatch;
  return async (req: Request): Promise<Response> => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url).pathname);
    } catch {
      return new Response("not found", { status: 404 });
    }

    if (pathname === "/api/health") {
      return json(buildHealth());
    }
    if (pathname === "/api/command" && req.method === "POST") {
      if (!dispatch) return json({ ok: false, text: "dispatch not running" }, 503);
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, text: "expected a JSON body { argv: string[] }" }, 400);
      }
      const record = typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)
        : undefined;
      const argv = record?.["argv"];
      if (!Array.isArray(argv) || !argv.every((entry): entry is string => typeof entry === "string")) {
        return json({ ok: false, text: "expected a JSON body { argv: string[] }" }, 400);
      }
      const workspaceId = record?.["workspaceId"];
      if (workspaceId !== undefined && typeof workspaceId !== "string") {
        return json({ ok: false, text: "workspaceId must be a string" }, 400);
      }
      const directStart = record?.["directStart"];
      if (directStart !== undefined && typeof directStart !== "boolean") {
        return json({ ok: false, text: "directStart must be a boolean" }, 400);
      }
      const input = record?.["input"];
      if (input !== undefined && typeof input !== "string") {
        return json({ ok: false, text: "input must be a string" }, 400);
      }
      try {
        const out = await dispatch.command(argv, { workspaceId, directStart, input });
        return json({ ok: out.ok, text: out.text, ...(out.data !== undefined ? { data: out.data } : {}) });
      } catch (error) {
        const message = (error as Error).message;
        if (error instanceof LinearError) return json({ ok: false, text: message }, 502);
        return json({ ok: false, text: message }, 500);
      }
    }
    return json({ error: "not found" }, 404);
  };
}
