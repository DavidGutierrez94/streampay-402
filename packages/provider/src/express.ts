import { formatSse } from "./meter";
import { begin, bindGate, meterHeld, resolveTerms, type ServeOptions } from "./serve";

export interface ExpressLikeRequest {
  url?: string;
  originalUrl?: string;
  protocol?: string;
  headers: Record<string, string | string[] | undefined>;
  header?: (name: string) => string | undefined;
  get?: (name: string) => string | undefined;
}

export interface ExpressLikeResponse {
  statusCode?: number;
  status?: (code: number) => ExpressLikeResponse;
  setHeader: (name: string, value: string) => void;
  json?: (body: unknown) => void;
  end: (chunk?: string) => void;
  write: (chunk: string) => boolean | void;
  flushHeaders?: () => void;
  on?: (event: string, listener: () => void) => void;
}

export type ExpressNext = (error?: unknown) => void;

export type ExpressStreamPayOptions = ServeOptions;

function headerOf(req: ExpressLikeRequest, name: string): string | undefined {
  const fromMethod = req.header?.(name) ?? req.get?.(name);
  if (typeof fromMethod === "string") return fromMethod;
  const raw = req.headers[name.toLowerCase()] ?? req.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === "string" ? raw : undefined;
}

function requestUrl(req: ExpressLikeRequest): string {
  if (req.url?.startsWith("http")) return req.url;
  const path = req.originalUrl ?? req.url ?? "/";
  const host = headerOf(req, "host");
  if (!host) return path;
  return `${req.protocol ?? "http"}://${host}${path}`;
}

function sendJson(res: ExpressLikeResponse, status: number, body: unknown, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  if (res.status && res.json) {
    res.status(status);
    res.json(body);
    return;
  }
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function sleep(ms: number, isAborted: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (isAborted()) { resolve(); return; }
    const timer = setTimeout(() => resolve(), ms);
    if (isAborted()) { clearTimeout(timer); resolve(); }
  });
}

/**
 * Express middleware with the same 402 / per-second meter behavior.
 * Typed against a structural req/res so Express itself is not a dependency.
 */
export function expressStreamPay(options: ExpressStreamPayOptions) {
  const gate = bindGate(options);
  return async (req: ExpressLikeRequest, res: ExpressLikeResponse, next?: ExpressNext): Promise<void> => {
    try {
      const url = requestUrl(req);
      const terms = await resolveTerms(options.terms, url);
      const begun = await begin(gate, {
        getHeader: (name) => headerOf(req, name),
        terms,
        resourceUrl: url,
      });
      switch (begun.type) {
        case "http":
          sendJson(res, begun.status, begun.body, begun.headers);
          return;
        case "stream": {
          let aborted = false;
          res.on?.("close", () => { aborted = true; });
          res.statusCode = 200;
          res.setHeader("content-type", "text/event-stream");
          res.setHeader("cache-control", "no-cache");
          res.setHeader("connection", "keep-alive");
          res.flushHeaders?.();
          await meterHeld(gate, begun, options, {
            sleep: (ms) => sleep(ms, () => aborted),
            write: async (event, data) => { res.write(formatSse(event, data)); },
            isAborted: () => aborted,
          });
          res.end();
          return;
        }
        default: {
          const unexpected: never = begun;
          throw new Error(`unexpected gate result: ${String(unexpected)}`);
        }
      }
    } catch (error) {
      if (next) next(error);
      else throw error;
    }
  };
}
