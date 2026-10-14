// Provider webhooks for stream open, claim, and close. HMAC-SHA256 over `${timestamp}.${rawBody}`.
import { createHmac, timingSafeEqual } from "node:crypto";

export type StreamEventName = "stream.opened" | "stream.claimed" | "stream.closed";

export type StreamEventData = {
  streamId: string;
  payer: string;
  payee: string;
  ratePerSec: string;
  deposit: string;
  amount: string | null;
  reason: string | null;
  elapsedSeconds: number | null;
  txHash: string | null;
};

export type StreamEvent = {
  id: string;
  type: StreamEventName;
  created: number;
  serviceId: string;
  data: StreamEventData;
};

export type WebhookConfig = {
  url: string;
  secret: string;
  enabled: boolean;
  maxAttempts: number;
};

export type WebhookDeps = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  nowSec: () => number;
};

const configs = new Map<string, WebhookConfig>();
const inflight = new Set<Promise<void>>();
let deps: WebhookDeps | null = null;

export function setWebhookDepsForTests(next: WebhookDeps | null): void {
  deps = next;
}

export function resetWebhooksForTests(): void {
  configs.clear();
  deps = null;
}

export function signWebhook(secret: string, timestamp: string | number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyWebhookSignature(
  secret: string,
  header: string | null,
  body: string,
  nowSec: number,
  toleranceSec = 300,
): boolean {
  if (!header) return false;
  let t: string | undefined;
  let v1: string | undefined;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") t = value;
    else if (key === "v1") v1 = value;
  }
  if (!t || !v1 || !/^\d+$/.test(t) || !/^[0-9a-fA-F]+$/.test(v1)) return false;
  if (Math.abs(nowSec - Number(t)) > toleranceSec) return false;
  const expected = signWebhook(secret, t, body);
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(v1.toLowerCase(), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function streamPayload(
  base: { streamId: string; payer: string; payee: string; ratePerSec: bigint; deposit: bigint },
  extra: Partial<StreamEventData> = {},
): StreamEventData {
  return {
    streamId: base.streamId,
    payer: base.payer,
    payee: base.payee,
    ratePerSec: base.ratePerSec.toString(),
    deposit: base.deposit.toString(),
    amount: extra.amount ?? null,
    reason: extra.reason ?? null,
    elapsedSeconds: extra.elapsedSeconds ?? null,
    txHash: extra.txHash ?? null,
  };
}

function classifyUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "bad webhook url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "webhook url must be http or https" };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "metadata.google.internal" || host.startsWith("169.254.")) return { ok: false, error: "webhook url is not allowed" };
  return { ok: true, url: url.toString() };
}

export function setWebhook(
  serviceId: string,
  input: { url: string; secret: string; enabled?: boolean; maxAttempts?: number },
): { ok: true } | { ok: false; error: string } {
  const url = classifyUrl(input.url);
  if (!url.ok) return url;
  if (input.secret.length < 16 || input.secret.length > 256) return { ok: false, error: "secret must be 16-256 characters" };
  const maxAttempts = input.maxAttempts ?? 5;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) return { ok: false, error: "maxAttempts must be 1-8" };
  configs.set(serviceId, { url: url.url, secret: input.secret, enabled: input.enabled ?? true, maxAttempts });
  return { ok: true };
}

export type WebhookView =
  | { configured: false }
  | { configured: true; serviceId: string; url: string; enabled: boolean; maxAttempts: number };

export function viewWebhook(serviceId: string): WebhookView {
  const cfg = configs.get(serviceId);
  if (!cfg) return { configured: false };
  return { configured: true, serviceId, url: cfg.url, enabled: cfg.enabled, maxAttempts: cfg.maxAttempts };
}

export function saveWebhookConfig(
  serviceId: string,
  body: unknown,
): { ok: true; view: WebhookView } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "bad json" };
  const rec = body as Record<string, unknown>;
  if (typeof rec.url !== "string" || typeof rec.secret !== "string") return { ok: false, error: "url and secret are required" };
  if (rec.enabled !== undefined && typeof rec.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
  if (rec.maxAttempts !== undefined && typeof rec.maxAttempts !== "number") return { ok: false, error: "maxAttempts must be 1-8" };
  const saved = setWebhook(serviceId, {
    url: rec.url,
    secret: rec.secret,
    enabled: typeof rec.enabled === "boolean" ? rec.enabled : undefined,
    maxAttempts: typeof rec.maxAttempts === "number" ? rec.maxAttempts : undefined,
  });
  if (!saved.ok) return saved;
  return { ok: true, view: viewWebhook(serviceId) };
}

export function applyEnvWebhook(serviceId?: string): void {
  const url = process.env.WEBHOOK_URL?.trim();
  const secret = process.env.WEBHOOK_SECRET;
  if (!url && !secret) return;
  if (!url || !secret) {
    console.log("[webhook] set both WEBHOOK_URL and WEBHOOK_SECRET");
    return;
  }
  const rawAttempts = process.env.WEBHOOK_MAX_ATTEMPTS?.trim();
  const maxAttempts = rawAttempts ? Number(rawAttempts) : 5;
  const id = serviceId ?? (process.env.WEBHOOK_SERVICE_ID?.trim() || process.env.POLICY_SERVICE_ID?.trim() || "infer");
  const saved = setWebhook(id, { url, secret, enabled: true, maxAttempts });
  if (!saved.ok) console.log(`[webhook] ${saved.error}`);
  else console.log(`[webhook] configured for service ${id}`);
}

export function retryDelayMs(attempt: number): number {
  return 200 * 2 ** attempt;
}

function shouldRetry(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function deliver(cfg: WebhookConfig, event: StreamEvent): Promise<void> {
  const body = JSON.stringify(event);
  const fetchImpl = deps?.fetch ?? fetch;
  const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowSec = deps?.nowSec ?? (() => Math.floor(Date.now() / 1000));
  let attempts = 0;
  for (let i = 0; i < cfg.maxAttempts; i++) {
    attempts = i + 1;
    const timestamp = String(nowSec());
    const signature = signWebhook(cfg.secret, timestamp, body);
    try {
      const res = await fetchImpl(cfg.url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "user-agent": "streampay-402-webhooks",
          "x-streampay-timestamp": timestamp,
          "x-streampay-signature": `t=${timestamp},v1=${signature}`,
          "x-streampay-event": event.type,
        },
        body,
      });
      console.log(`[webhook] ${event.type} ${cfg.url} -> ${res.status} (attempt ${attempts})`);
      if (res.ok) return;
      if (!shouldRetry(res.status)) return;
    } catch {
      console.log(`[webhook] ${event.type} ${cfg.url} network error (attempt ${attempts})`);
    }
    if (i < cfg.maxAttempts - 1) await sleep(retryDelayMs(i));
  }
  console.log(`[webhook] ${event.type} giving up after ${attempts} attempts`);
}

export function emitStreamEvent(serviceId: string, input: { type: StreamEventName; created?: number; data: StreamEventData }): void {
  const cfg = configs.get(serviceId);
  if (!cfg?.enabled) return;
  const event: StreamEvent = {
    id: `evt_${crypto.randomUUID()}`,
    type: input.type,
    created: input.created ?? (deps?.nowSec() ?? Math.floor(Date.now() / 1000)),
    serviceId,
    data: input.data,
  };
  const task = deliver(cfg, event);
  inflight.add(task);
  void task.finally(() => inflight.delete(task));
}

export async function flushWebhooks(): Promise<void> {
  while (inflight.size > 0) await Promise.all([...inflight]);
}
