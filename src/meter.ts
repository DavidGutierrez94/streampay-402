// Registry-backed x402 stream-per-second handler. The gate, 402 terms, and
// per-second meter live in @streampay-402/provider; this binds them to ServiceRegistry.
import type { Context } from "hono";
import { formatEther } from "viem";
import { createGate, honoStreamResponse, paymentRequirements, readOnchainStream } from "@streampay-402/provider";
import { CHAIN_ID, pub } from "./chain";
import { pkFor, readService } from "./registry";

const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;
const gate = createGate({ readStream: (id) => readOnchainStream(pub, ESCROW, id) });

export async function readStream(id: bigint) {
  const stream = await readOnchainStream(pub, ESCROW, id);
  if (!stream) throw new Error("cannot verify stream (RPC)");
  return stream;
}

type Produce = (i: number) => string;

export async function serveMetered(c: Context, serviceId: bigint, produce: Produce = (i) => `tick-${i}`) {
  const svc = await readService(serviceId).catch(() => null);
  if (!svc || !svc.active || svc.ratePerSec === 0n) return c.json({ error: "unknown or inactive service" }, 404);
  const terms = paymentRequirements({
    payTo: svc.payee,
    escrow: ESCROW,
    ratePerSec: svc.ratePerSec,
    chainId: CHAIN_ID,
    resourceUrl: c.req.url,
    description: `${svc.name} (${formatEther(svc.ratePerSec)} MON/s)`,
    publishableKey: pkFor(serviceId),
    serviceName: svc.name,
  });
  return honoStreamResponse(c, {
    gate,
    terms,
    produce,
    onAccept: ({ streamId, stream }) => {
      console.log(`[svc ${serviceId}] stream #${streamId} verified: ${formatEther(stream.deposit)} MON @ ${formatEther(stream.rate)} MON/s`);
    },
  });
}
