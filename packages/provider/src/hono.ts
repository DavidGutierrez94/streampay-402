import type { Context, MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import type { Gate } from "./gate";
import { begin, bindGate, meterHeld, resolveTerms, type ServeOptions } from "./serve";

export type HonoStreamPayOptions = ServeOptions;

/** Drop-in Hono middleware. No payment → 402 with x402 terms. Payment → metered SSE. */
export function streamPay(options: HonoStreamPayOptions): MiddlewareHandler {
  const gate = bindGate(options);
  return async (c) => respond(c, gate, options);
}

/** Same gate as `streamPay`, for handlers that already have the Hono context. */
export function honoStreamResponse(c: Context, options: HonoStreamPayOptions): Promise<Response> {
  return respond(c, bindGate(options), options);
}

async function respond(c: Context, gate: Gate, options: ServeOptions): Promise<Response> {
  const terms = await resolveTerms(options.terms, c.req.url);
  const begun = await begin(gate, {
    getHeader: (name) => c.req.header(name),
    terms,
    resourceUrl: c.req.url,
  });
  switch (begun.type) {
    case "http":
      for (const [name, value] of Object.entries(begun.headers)) c.header(name, value);
      return c.json(begun.body, begun.status);
    case "stream": {
      let aborted = false;
      return streamSSE(c, async (stream) => {
        stream.onAbort(() => { aborted = true; });
        await meterHeld(gate, begun, options, {
          sleep: async (ms) => { await stream.sleep(ms); },
          write: async (event, data) => { await stream.writeSSE({ event, data }); },
          isAborted: () => aborted,
        });
      });
    }
    default: {
      const unexpected: never = begun;
      throw new Error(`unexpected gate result: ${String(unexpected)}`);
    }
  }
}
