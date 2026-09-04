import { buildHealth } from "./health";
import { createEventStream } from "./events";
import { LinearError } from "../dispatch/linear.ts";
import { MissingCriteriaError, RunningFullError, type DispatchApi } from "../dispatch/claims.ts";

export interface AppOptions {
  distDir: string;
  dispatch?: DispatchApi;
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
    if (pathname === "/api/claims" && req.method === "POST") {
      if (!dispatch) return json({ error: "dispatch not running" }, 503);
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "expected a JSON body" }, 400);
      }
      const identifier = typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)["identifier"]
        : undefined;
      if (typeof identifier !== "string" || identifier.trim() === "") {
        return json({ error: "expected { identifier }" }, 400);
      }
      const agent = (body as Record<string, unknown>)["agent"];
      const builder = (body as Record<string, unknown>)["builder"];
      try {
        const out = await dispatch.claim({
          identifier: identifier.trim(),
          agent: typeof agent === "string" ? agent : undefined,
          builder: typeof builder === "string" ? builder : undefined,
        });
        if (out.already) return json({ status: "already", identifier: out.ticket?.identifier ?? identifier.trim() });
        return json({ status: "claimed", identifier: out.ticket?.identifier, slot: out.ticket?.slot });
      } catch (error) {
        if (error instanceof RunningFullError) {
          return json({ error: error.message, running: error.tickets }, 409);
        }
        if (error instanceof MissingCriteriaError) {
          return json({ error: error.message }, 422);
        }
        const message = (error as Error).message;
        if (/was not found in Linear/i.test(message)) return json({ error: message }, 404);
        if (/is not in project/i.test(message)) return json({ error: message }, 400);
        if (error instanceof LinearError) return json({ error: message }, 502);
        return json({ error: message }, 500);
      }
    }
    if (pathname === "/events") {
      return createEventStream(req.signal);
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
