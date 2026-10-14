// Reusable x402 "stream-per-second" gate for ANY service in the ServiceRegistry.
// streamPay(serviceId) -> Hono handler: no payment => 402 + terms from the registry;
// X-PAYMENT-STREAM + X-PAYMENT-SIG => verify escrow stream onchain, then serve a metered SSE response.
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { formatEther, verifyMessage } from "viem";
import { pub, abi } from "./chain";
import { readService, termsFor } from "./registry";
import { getStore } from "./store";

const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;
const LOCK_TTL_SEC = 90;

export async function readStream(id: bigint) {
  const s = (await pub.readContract({ address: ESCROW, abi, functionName: "streams", args: [id] })) as any[];
  const active = (await pub.readContract({ address: ESCROW, abi, functionName: "isActive", args: [id] })) as boolean;
  return { payer: s[0] as `0x${string}`, payee: s[1] as string, rate: s[2] as bigint, deposit: s[3] as bigint, start: Number(s[4]), stoppedAt: Number(s[5]), active };
}

type Produce = (i: number) => string;
const defaultProduce: Produce = (i) => `tick-${i}`;

export async function serveMetered(c: Context, serviceId: bigint, produce: Produce = defaultProduce) {
  const svc = await readService(serviceId).catch(() => null);
  if (!svc || !svc.active || svc.ratePerSec === 0n) return c.json({ error: "unknown or inactive service" }, 404);
  const terms = termsFor(serviceId, svc);
  const sid = c.req.header("X-PAYMENT-STREAM");
  if (!sid) {
    c.header("X-PAYMENT-REQUIRED", Buffer.from(JSON.stringify(terms)).toString("base64"));
    return c.json(terms, 402);
  }
  if (!/^\d{1,78}$/.test(sid)) return c.json({ error: "bad stream id" }, 400);
  const s = await readStream(BigInt(sid)).catch(() => null);
  if (!s) return c.json({ error: "cannot verify stream (RPC)" }, 503);
  const sig = c.req.header("X-PAYMENT-SIG") as `0x${string}` | undefined;
  const owner = !!sig && (await verifyMessage({ address: s.payer, message: `x402-stream:${ESCROW.toLowerCase()}:${sid}`, signature: sig }).catch(() => false));
  if (!owner) return c.json({ error: "stream not owned by caller" }, 402);
  const lockName = `svc:${serviceId}:${sid}`;
  const lock = await getStore().tryLock(lockName, LOCK_TTL_SEC);
  if (!lock) return c.json({ error: "stream already in use" }, 409);
  if (!s.active || s.payee.toLowerCase() !== svc.payee.toLowerCase() || s.rate < svc.ratePerSec || s.deposit < svc.ratePerSec * 10n) {
    await getStore().unlock(lockName, lock);
    return c.json({ error: "stream not funded/active for this service", ...terms }, 402);
  }
  console.log(`[svc ${serviceId}] stream #${sid} verified: ${formatEther(s.deposit)} MON @ ${formatEther(s.rate)} MON/s`);
  const endAt = s.start * 1000 + Number((s.deposit * 1000n) / s.rate);
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (st) => {
    try {
      let i = 0, last = 0, aborted = false;
      st.onAbort(() => { aborted = true; });
      while (!aborted) {
        if (Date.now() >= endAt) { await st.writeSSE({ event: "cutoff", data: "exhausted" }); break; }
        if (Date.now() - last > 1000) {
          last = Date.now();
          if (!await getStore().refreshLock(lockName, lock, LOCK_TTL_SEC)) {
            await st.writeSSE({ event: "cutoff", data: "lock" }); break;
          }
          const live = await readStream(BigInt(sid)).catch(() => null);
          if (live && !live.active) { await st.writeSSE({ event: "cutoff", data: "closed" }); break; }
        }
        await st.writeSSE({ event: "token", data: produce(i++) });
        await st.sleep(250);
      }
    } finally { await getStore().unlock(lockName, lock); }
  });
}
