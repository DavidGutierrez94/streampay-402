// Example provider: your own service, gated + billed per second with StreamPay-402.
//   PROVIDER_PK=pk_test_<id> PROVIDER_SK=sk_test_... bun run provider
// Optional PROVIDER_KEY (payee wallet private key) lets it claim earnings mid-stream.
import { Hono } from "hono";
import { pub, wallet, abi, txUrl } from "../src/chain";
import { REGISTRY, registryAbi, hashKey, parsePk, readService } from "../src/registry";
import { serveMetered } from "../src/meter";

const pk = process.env.PROVIDER_PK ?? "", sk = process.env.PROVIDER_SK ?? "";
const id = parsePk(pk);
if (id === null || !sk.startsWith("sk_test_")) throw new Error("set PROVIDER_PK=pk_test_<id> and PROVIDER_SK=sk_test_...");
const ok = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "verifyKey", args: [id, hashKey(sk)] });
if (!ok) throw new Error("secret key does not match the onchain hash for " + pk);
const svc = await readService(id);
console.log(`provider: sk verified onchain for service #${id} "${svc.name}", payee ${svc.payee}`);

const app = new Hono();
app.get("/api/work", (c) => {
  const sid = c.req.header("X-PAYMENT-STREAM");
  if (sid && process.env.PROVIDER_KEY) setTimeout(async () => {   // claim accrued earnings mid-stream
    try {
      const h = await wallet(process.env.PROVIDER_KEY!).writeContract({ address: process.env.ESCROW_ADDRESS as `0x${string}`, abi, functionName: "claim", args: [BigInt(sid)], gas: 120000n });
      await pub.waitForTransactionReceipt({ hash: h }); console.log("claim:", txUrl(h));
    } catch (e: any) { console.log("claim failed:", e.shortMessage ?? e.message); }
  }, 4000);
  return serveMetered(c, id, (i) => `result chunk ${i} from ${svc.name}`);
});
const port = Number(process.env.PROVIDER_PORT ?? 4030);
Bun.serve({ port, fetch: app.fetch, idleTimeout: 0 });
console.log(`provider listening on http://localhost:${port}/api/work`);
