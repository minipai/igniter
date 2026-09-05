import { buildHealth } from "./health";
import { createEventStream } from "./events";
import { LinearError } from "../dispatch/linear.ts";
import { type DispatchApi } from "../dispatch/claims.ts";
import { type BoardHub, type BoardSnapshot } from "./board.ts";

export interface AppOptions {
  distDir: string;
  dispatch?: DispatchApi;
  /** Board snapshot for GET /api/board; null while dispatch is starting. */
  board?: () => Promise<BoardSnapshot | null>;
  hub?: BoardHub;
  heartbeatMs?: number;
}

const MEDIA_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

function mediaType(pathname: string): string {
  const dot = pathname.lastIndexOf(".");
  const ext = dot >= 0 ? pathname.slice(dot) : "";
  return MEDIA_TYPES[ext] ?? "application/octet-stream";
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

async function serveFile(path: string, pathname: string): Promise<Response | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return new Response(file, { headers: { "content-type": mediaType(pathname) } });
}

export function createApp(options: AppOptions): (req: Request) => Promise<Response> {
  const distDir = options.distDir.replace(/\/+$/, "");
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
    if (pathname === "/api/queue" && req.method === "GET") {
      if (!dispatch) return json({ error: "dispatch not running" }, 503);
      return json(dispatch.queue());
    }
    if (pathname === "/api/activity" && req.method === "GET") {
      if (!dispatch) return json({ error: "dispatch not running" }, 503);
      const limit = Math.max(1, Math.min(Number(new URL(req.url).searchParams.get("limit") ?? 100) || 100, 1000));
      return json({ lines: await dispatch.activity(limit) });
    }
    if (pathname === "/api/board" && req.method === "GET") {
      if (!options.board) return json({ error: "dispatch not running" }, 503);
      let snapshot: BoardSnapshot | null;
      try {
        snapshot = await options.board();
      } catch (error) {
        return json({ error: (error as Error).message }, 500);
      }
      if (!snapshot) return json({ error: "dispatch still starting; retry shortly" }, 503);
      return json(snapshot);
    }
    if (pathname === "/api/command" && req.method === "POST") {
      if (!dispatch) return json({ ok: false, text: "dispatch not running" }, 503);
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, text: "expected a JSON body { argv: string[] }" }, 400);
      }
      const argv = typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)["argv"]
        : undefined;
      if (!Array.isArray(argv) || !argv.every((entry): entry is string => typeof entry === "string")) {
        return json({ ok: false, text: "expected a JSON body { argv: string[] }" }, 400);
      }
      try {
        const out = await dispatch.command(argv);
        return json({ ok: out.ok, text: out.text, ...(out.data !== undefined ? { data: out.data } : {}) });
      } catch (error) {
        const message = (error as Error).message;
        if (error instanceof LinearError) return json({ ok: false, text: message }, 502);
        return json({ ok: false, text: message }, 500);
      }
    }
    if (pathname === "/events") {
      return createEventStream(req.signal, options.hub, { heartbeatMs: options.heartbeatMs });
    }
    if (pathname === "/api" || pathname === "/api/" || pathname.startsWith("/api/")) {
      return json({ error: "not found" }, 404);
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("not found", { status: 404 });
    }
    const segments = pathname.split("/").filter(Boolean);
    if (segments.includes("..")) {
      return new Response("not found", { status: 404 });
    }

    const direct = await serveFile(`${distDir}${pathname}`, pathname);
    if (direct) return direct;

    // Has a file extension but no such file: a missing asset, not a route.
    const last = segments[segments.length - 1] ?? "";
    if (last.includes(".")) {
      return new Response("not found", { status: 404 });
    }
    const index = await serveFile(`${distDir}/index.html`, "/index.html");
    if (index) return index;
    return new Response("not found", { status: 404 });
  };
}
