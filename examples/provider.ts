// Example provider: your own service, gated + billed per second with StreamPay-402.
//   PROVIDER_PK=pk_test_<id> PROVIDER_SK=sk_test_... bun run provider
// Optional PROVIDER_KEY (payee wallet private key) lets it claim earnings mid-stream.
// Caps and webhooks for this process: POLICY_* and WEBHOOK_* env, or PUT /api/registry/policy and /webhook.
import { Hono } from "hono";
import { pub } from "../src/chain";
import { serveMetered } from "../src/meter";
import { applyEnvPolicy } from "../src/policy";
import { REGISTRY, registryAbi, hashKey, parsePk, readService, mountBillingAdmin } from "../src/registry";
import { applyEnvWebhook } from "../src/webhooks";

const pk = process.env.PROVIDER_PK ?? "";
const sk = process.env.PROVIDER_SK ?? "";
const id = parsePk(pk);
if (id === null || !sk.startsWith("sk_test_")) throw new Error("set PROVIDER_PK=pk_test_<id> and PROVIDER_SK=sk_test_...");
const ok = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "verifyKey", args: [id, hashKey(sk)] });
if (!ok) throw new Error("secret key does not match the onchain hash for " + pk);
const svc = await readService(id);
console.log(`provider: sk verified onchain for service #${id} "${svc.name}", payee ${svc.payee}`);

applyEnvPolicy(id.toString());
applyEnvWebhook(id.toString());

const app = new Hono();
const admin = new Hono();
mountBillingAdmin(admin, id);
app.route("/api/registry", admin);
app.get("/api/work", (c) => serveMetered(c, id, (i) => `result chunk ${i} from ${svc.name}`, {
  claimKey: process.env.PROVIDER_KEY,
  claimDelayMs: 4000,
}));
const port = Number(process.env.PROVIDER_PORT ?? 4030);
Bun.serve({ port, fetch: app.fetch, idleTimeout: 0 });
console.log(`provider listening on http://localhost:${port}/api/work`);
