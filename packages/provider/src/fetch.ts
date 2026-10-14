import { formatSse } from "./meter";
import { begin, bindGate, meterHeld, resolveTerms, type ServeOptions } from "./serve";

export type FetchStreamPayOptions = ServeOptions;

function jsonResponse(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Generic fetch handler for Bun.serve, Cloudflare Workers, or any Request → Response host. */
export function fetchStreamPay(options: FetchStreamPayOptions): (request: Request) => Promise<Response> {
  const gate = bindGate(options);
  return async (request) => {
    const terms = await resolveTerms(options.terms, request.url);
    const begun = await begin(gate, {
      getHeader: (name) => request.headers.get(name),
      terms,
      resourceUrl: request.url,
    });
    switch (begun.type) {
      case "http":
        return jsonResponse(begun.status, begun.body, begun.headers);
      case "stream":
        return streamResponse(gate, options, begun);
      default: {
        const unexpected: never = begun;
        throw new Error(`unexpected gate result: ${String(unexpected)}`);
      }
    }
  };
}

function streamResponse(
  gate: ReturnType<typeof bindGate>,
  options: FetchStreamPayOptions,
  begun: Extract<Awaited<ReturnType<typeof begin>>, { type: "stream" }>,
): Response {
  const abort = new AbortController();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await meterHeld(gate, begun, options, {
          sleep: (ms) => sleep(ms, abort.signal),
          write: async (event, data) => { controller.enqueue(encoder.encode(formatSse(event, data))); },
          isAborted: () => abort.signal.aborted,
        });
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() { abort.abort(); },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
