// Reusable x402 "stream-per-second" gate for ANY service in the ServiceRegistry.
// streamPay(serviceId) -> Hono handler: no payment => 402 + terms from the registry;
// X-PAYMENT-STREAM + X-PAYMENT-SIG => verify escrow stream onchain, enforce session
// policy, then serve a metered SSE response. Webhooks fire on open, claim, and close.
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { formatEther, verifyMessage } from "viem";
import { scheduleProviderClaim, type ClaimResult } from "./claim";
import { pub, abi } from "./chain";
import { accruedWei, beginSession, endSession, policyBlock } from "./policy";
import { readService, termsFor, type ServiceView } from "./registry";
import { emitStreamEvent, streamPayload } from "./webhooks";

export type StreamView = {
  payer: `0x${string}`;
  payee: string;
  rate: bigint;
  deposit: bigint;
  start: number;
  stoppedAt: number;
  active: boolean;
};

const sessions = new Set<string>();

function escrowAddress(): `0x${string}` {
  const address = process.env.ESCROW_ADDRESS;
  if (!address) throw new Error("ESCROW_ADDRESS is not set");
  return address as `0x${string}`;
}

export async function readStream(id: bigint): Promise<StreamView> {
  const escrow = escrowAddress();
  const s = (await pub.readContract({ address: escrow, abi, functionName: "streams", args: [id] })) as [
    `0x${string}`,
    string,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];
  const active = (await pub.readContract({ address: escrow, abi, functionName: "isActive", args: [id] })) as boolean;
  return { payer: s[0], payee: s[1], rate: s[2], deposit: s[3], start: Number(s[4]), stoppedAt: Number(s[5]), active };
}

export function resetMeterSessionsForTests(): void {
  sessions.clear();
}

type Produce = (i: number) => string;
const defaultProduce: Produce = (i) => `tick-${i}`;

export type ServeOptions = {
  readService?: (id: bigint) => Promise<ServiceView | null>;
  readStream?: (id: bigint) => Promise<StreamView | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  tickMs?: number;
  checkMs?: number;
  claimKey?: string;
  claimDelayMs?: number;
  claim?: (streamId: bigint) => Promise<ClaimResult | null>;
};

export async function serveMetered(c: Context, serviceId: bigint, produce: Produce = defaultProduce, options: ServeOptions = {}) {
  const loadService = options.readService ?? ((id: bigint) => readService(id).catch(() => null));
  const loadStream = options.readStream ?? ((id: bigint) => readStream(id).catch(() => null));
  const now = options.now ?? Date.now;
  const tickMs = options.tickMs ?? 250;
  const checkMs = options.checkMs ?? 1000;
  const svc = await loadService(serviceId);
  if (!svc || !svc.active || svc.ratePerSec === 0n) return c.json({ error: "unknown or inactive service" }, 404);
  const terms = termsFor(serviceId, svc);
  const sid = c.req.header("X-PAYMENT-STREAM");
  if (!sid) {
    c.header("X-PAYMENT-REQUIRED", Buffer.from(JSON.stringify(terms)).toString("base64"));
    return c.json(terms, 402);
  }
  if (!/^\d{1,78}$/.test(sid)) return c.json({ error: "bad stream id" }, 400);
  const s = await loadStream(BigInt(sid));
  if (!s) return c.json({ error: "cannot verify stream (RPC)" }, 503);
  const escrow = escrowAddress();
  const sig = c.req.header("X-PAYMENT-SIG") as `0x${string}` | undefined;
  const owner = !!sig && (await verifyMessage({ address: s.payer, message: `x402-stream:${escrow.toLowerCase()}:${sid}`, signature: sig }).catch(() => false));
  if (!owner) return c.json({ error: "stream not owned by caller" }, 402);
  const key = `${serviceId}:${sid}`;
  if (sessions.has(key)) return c.json({ error: "stream already in use" }, 409);
  if (!s.active || s.payee.toLowerCase() !== svc.payee.toLowerCase() || s.rate < svc.ratePerSec || s.deposit < svc.ratePerSec * 10n)
    return c.json({ error: "stream not funded/active for this service", ...terms }, 402);

  const opened = beginSession({
    serviceId: serviceId.toString(),
    payer: s.payer,
    streamId: sid,
    rate: s.rate,
    deposit: s.deposit,
    startSec: s.start,
    nowMs: now(),
  });
  if (!opened.ok) return c.json({ error: opened.error, ...terms }, opened.status);

  console.log(`[svc ${serviceId}] stream #${sid} verified: ${formatEther(s.deposit)} MON @ ${formatEther(s.rate)} MON/s`);
  sessions.add(key);
  const grant = opened.grant;
  const serviceKey = serviceId.toString();
  const base = { streamId: sid, payer: s.payer, payee: s.payee, ratePerSec: s.rate, deposit: s.deposit };
  emitStreamEvent(serviceKey, { type: "stream.opened", data: streamPayload(base) });
  if (options.claim || options.claimKey) {
    scheduleProviderClaim({
      serviceId: serviceKey,
      streamId: BigInt(sid),
      payee: s.payee,
      claimKey: options.claimKey,
      delayMs: options.claim ? 0 : options.claimDelayMs,
      meta: { payer: s.payer, ratePerSec: s.rate, deposit: s.deposit },
      perform: options.claim,
    });
  }
  const endAt = s.start * 1000 + Number((s.deposit * 1000n) / s.rate);
  let settled = false;
  const finish = (reason: string) => {
    if (settled) return;
    settled = true;
    sessions.delete(key);
    const at = now();
    const actual = accruedWei(s.rate, s.deposit, s.start, at);
    endSession(grant.sessionKey, actual);
    emitStreamEvent(serviceKey, {
      type: "stream.closed",
      data: streamPayload(base, {
        amount: actual.toString(),
        reason,
        elapsedSeconds: Math.max(0, Math.floor(at / 1000) - s.start),
      }),
    });
  };
  try {
    return streamSSE(c, async (st) => {
      let reason = "ended";
      try {
        let i = 0;
        let last = 0;
        let aborted = false;
        st.onAbort(() => { aborted = true; reason = "aborted"; });
        while (!aborted) {
          const policyReason = policyBlock(grant, now());
          if (policyReason) { reason = policyReason; await st.writeSSE({ event: "cutoff", data: policyReason }); break; }
          if (now() >= endAt) { reason = "exhausted"; await st.writeSSE({ event: "cutoff", data: "exhausted" }); break; }
          if (now() - last >= checkMs) {
            last = now();
            const live = await loadStream(BigInt(sid));
            if (live && !live.active) {
              reason = "closed";
              await st.writeSSE({ event: "cutoff", data: "closed" });
              break;
            }
          }
          await st.writeSSE({ event: "token", data: produce(i++) });
          if (options.sleep) await options.sleep(tickMs);
          else await st.sleep(tickMs);
        }
      } finally {
        finish(reason);
      }
    });
  } catch (err) {
    finish("error");
    throw err;
  }
}
