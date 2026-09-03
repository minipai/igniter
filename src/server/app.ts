import { buildHealth } from "./health";
import { createEventStream } from "./events";

export interface AppOptions {
  distDir: string;
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
