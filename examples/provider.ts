// Example provider: your own service, gated + billed per second with StreamPay-402.
//   PROVIDER_PK=pk_test_<id> PROVIDER_SK=sk_test_... bun run provider
// Optional PROVIDER_KEY (payee wallet private key) lets it claim earnings mid-stream.
import { Hono } from "hono";
import { getAddress } from "viem";
import { claimStream, paymentRequirements, streamPay } from "@streampay-402/provider";
import { CHAIN_ID, pub, txUrl, wallet } from "../src/chain";
import { REGISTRY, hashKey, parsePk, readService, registryAbi } from "../src/registry";

const pk = process.env.PROVIDER_PK ?? "";
const sk = process.env.PROVIDER_SK ?? "";
const id = parsePk(pk);
if (id === null || !sk.startsWith("sk_test_")) throw new Error("set PROVIDER_PK=pk_test_<id> and PROVIDER_SK=sk_test_...");
const ok = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "verifyKey", args: [id, hashKey(sk)] });
if (!ok) throw new Error("secret key does not match the onchain hash for " + pk);
const svc = await readService(id);
console.log(`provider: sk verified onchain for service #${id} "${svc.name}", payee ${svc.payee}`);

const escrow = getAddress(process.env.ESCROW_ADDRESS!);
const terms = paymentRequirements({
  payTo: getAddress(svc.payee),
  escrow,
  ratePerSec: svc.ratePerSec,
  chainId: CHAIN_ID,
  resourceUrl: "/api/work",
  description: svc.name,
  serviceName: svc.name,
  publishableKey: pk,
});

const app = new Hono();
app.get("/api/work", streamPay({
  publicClient: pub,
  escrow,
  terms,
  produce: (i) => `result chunk ${i} from ${svc.name}`,
  onAccept: ({ streamId }) => {
    const key = process.env.PROVIDER_KEY;
    if (!key) return;
    setTimeout(() => {
      void claimStream({
        walletClient: wallet(key),
        publicClient: pub,
        escrow,
        streamId: BigInt(streamId),
      }).then((hash) => {
        console.log("claim:", txUrl(hash));
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.log("claim failed:", message);
      });
    }, 4000);
  },
}));
const port = Number(process.env.PROVIDER_PORT ?? 4030);
Bun.serve({ port, fetch: app.fetch, idleTimeout: 0 });
console.log(`provider listening on http://localhost:${port}/api/work`);
