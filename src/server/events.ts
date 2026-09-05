// SSE boundary for dispatch events. The skeleton proves the boundary
// exists: headers, an initial ready event, heartbeats. When a board hub is
// attached, typed board events (pane, workspace, poll, decision, resync)
// are re-broadcast so the page updates without polling.

import type { BoardHub } from "./board.ts";

/** SSE heartbeat: must stay comfortably inside the server idle timeout or
 *  Bun kills the stream before the first beat (default idle is 10s). */
export const SSE_HEARTBEAT_MS = 15_000;

export interface EventStreamOptions {
  heartbeatMs?: number;
}

export function createEventStream(signal?: AbortSignal, hub?: BoardHub, options?: EventStreamOptions): Response {
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const enqueue = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(chunk));
        } catch {
          closed = true;
        }
      };
      const close = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // Already gone.
        }
      };
      enqueue(`retry: 5000\n`);
      enqueue(`event: ready\ndata: {"service":"igniter"}\n\n`);
      const unsubscribe = hub?.subscribe((event) => {
        enqueue(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      });
      const timer = setInterval(() => enqueue(`: heartbeat\n\n`), options?.heartbeatMs ?? SSE_HEARTBEAT_MS);
      if (signal?.aborted) {
        close();
      } else {
        signal?.addEventListener("abort", close);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
