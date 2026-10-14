// Registry-backed x402 stream-per-second handler. The gate and per-second meter
// live in @streampay-402/provider. This binds them to ServiceRegistry and enforces
// session policy, provider claims, and webhooks.
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { formatEther } from "viem";
import type { StreamView } from "@streampay-402/protocol";
import { begin, createGate, paymentRequirements, readOnchainStream, runMeter, type ReadStream } from "@streampay-402/provider";
import { CHAIN_ID, pub } from "./chain";
import { scheduleProviderClaim, type ClaimResult } from "./claim";
import { accruedWei, beginSession, endSession, policyBlock, publicPolicy } from "./policy";
import { pkFor, readService, type ServiceView } from "./registry";
import { emitStreamEvent, streamPayload } from "./webhooks";

export type { StreamView };

const sessions = new Set<string>();

function escrowAddress(): `0x${string}` {
  const address = process.env.ESCROW_ADDRESS;
  if (!address) throw new Error("ESCROW_ADDRESS is not set");
  return address as `0x${string}`;
}

export async function readStream(id: bigint): Promise<StreamView> {
  const stream = await readOnchainStream(pub, escrowAddress(), id);
  if (!stream) throw new Error("cannot verify stream (RPC)");
  return stream;
}

export function resetMeterSessionsForTests(): void {
  sessions.clear();
}

type Produce = (i: number) => string;

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

export async function serveMetered(c: Context, serviceId: bigint, produce: Produce = (i) => `tick-${i}`, options: ServeOptions = {}) {
  const loadService = options.readService ?? ((id: bigint) => readService(id).catch(() => null));
  const loadStream: ReadStream = options.readStream ?? ((id: bigint) => readOnchainStream(pub, escrowAddress(), id));
  const now = options.now ?? Date.now;
  const svc = await loadService(serviceId);
  if (!svc || !svc.active || svc.ratePerSec === 0n) return c.json({ error: "unknown or inactive service" }, 404);

  const resourceUrl = c.req.url;
  const terms = paymentRequirements({
    payTo: svc.payee,
    escrow: escrowAddress(),
    ratePerSec: svc.ratePerSec,
    chainId: CHAIN_ID,
    resourceUrl,
    description: `${svc.name} (${formatEther(svc.ratePerSec)} MON/s)`,
    publishableKey: pkFor(serviceId),
    serviceName: svc.name,
  });
  const policy = publicPolicy({ kind: "key", serviceId: serviceId.toString() });
  if (policy) terms.extra.policy = policy;

  const gate = createGate({ readStream: loadStream, sessions });
  const begun = await begin(gate, {
    getHeader: (name) => c.req.header(name),
    terms,
    resourceUrl,
  });
  if (begun.type === "http") {
    for (const [name, value] of Object.entries(begun.headers)) c.header(name, value);
    return c.json(begun.body, begun.status);
  }

  const opened = beginSession({
    serviceId: serviceId.toString(),
    payer: begun.stream.payer,
    streamId: begun.streamId,
    rate: begun.stream.rate,
    deposit: begun.stream.deposit,
    startSec: begun.stream.start,
    nowMs: now(),
  });
  if (!opened.ok) {
    gate.release(begun.streamId);
    return c.json({ error: opened.error }, opened.status);
  }

  const grant = opened.grant;
  const serviceKey = serviceId.toString();
  const base = {
    streamId: begun.streamId,
    payer: begun.stream.payer,
    payee: begun.stream.payee,
    ratePerSec: begun.stream.rate,
    deposit: begun.stream.deposit,
  };
  console.log(`[svc ${serviceId}] stream #${begun.streamId} verified: ${formatEther(begun.stream.deposit)} MON @ ${formatEther(begun.stream.rate)} MON/s`);
  emitStreamEvent(serviceKey, { type: "stream.opened", data: streamPayload(base) });
  if (options.claim || options.claimKey) {
    scheduleProviderClaim({
      serviceId: serviceKey,
      streamId: BigInt(begun.streamId),
      payee: begun.stream.payee,
      claimKey: options.claimKey,
      delayMs: options.claim ? 0 : options.claimDelayMs,
      meta: { payer: begun.stream.payer, ratePerSec: begun.stream.rate, deposit: begun.stream.deposit },
      perform: options.claim,
    });
  }

  let settled = false;
  const finish = (reason: string) => {
    if (settled) return;
    settled = true;
    gate.release(begun.streamId);
    const at = now();
    const actual = accruedWei(begun.stream.rate, begun.stream.deposit, begun.stream.start, at);
    endSession(grant.sessionKey, actual);
    emitStreamEvent(serviceKey, {
      type: "stream.closed",
      data: streamPayload(base, {
        amount: actual.toString(),
        reason,
        elapsedSeconds: Math.max(0, Math.floor(at / 1000) - begun.stream.start),
      }),
    });
  };

  try {
    return streamSSE(c, async (st) => {
      let reason = "ended";
      let aborted = false;
      st.onAbort(() => { aborted = true; });
      try {
        reason = await runMeter({
          streamId: begun.streamId,
          endAt: begun.endAt,
          readStream: gate.readStream,
          produce,
          tickMs: options.tickMs,
          recheckMs: options.checkMs,
          now,
          inspect: () => policyBlock(grant, now()),
          sleep: options.sleep ?? (async (ms) => { await st.sleep(ms); }),
          write: async (event, data) => { await st.writeSSE({ event, data }); },
          isAborted: () => aborted,
        });
        if (aborted) reason = "aborted";
      } finally {
        finish(reason);
      }
    });
  } catch (err) {
    finish("error");
    throw err;
  }
}
