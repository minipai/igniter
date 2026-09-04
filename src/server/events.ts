// Reserved SSE boundary for dispatch events (STA-167+). The skeleton only
// proves the boundary exists: headers, an initial ready event, heartbeats.

export function createEventStream(signal?: AbortSignal): Response {
  const stream = new ReadableStream({
    start(controller) {
      const enqueue = (chunk: string) => controller.enqueue(new TextEncoder().encode(chunk));
      enqueue(`retry: 5000\n`);
      enqueue(`event: ready\ndata: {"service":"igniter"}\n\n`);
      const timer = setInterval(() => enqueue(`: heartbeat\n\n`), 15000);
      signal?.addEventListener("abort", () => {
        clearInterval(timer);
        controller.close();
      });
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
