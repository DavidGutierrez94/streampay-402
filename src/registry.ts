// Onchain sign-up + Stripe-style keys for streampay-402.
//   pk_test_<serviceId>  publishable: agents use it to discover per-second terms
//   sk_test_<64 hex>     secret: shown once; only keccak256(sk) is stored onchain
import { Hono, type Context } from "hono";
import { keccak256, toBytes, formatEther, getAddress, isAddress, parseEther, type Hex } from "viem";
import { pub, CHAIN_ID, addrUrl, wallet as mkWallet, txUrl } from "./chain";
import { parseLimits, publicPolicy, setPolicy, viewPolicy, type PolicySubject } from "./policy";
import { saveWebhookConfig, viewWebhook } from "./webhooks";
import art from "./registry-artifact.json";

export const registryAbi = art.abi as any;
export const registryBytecode = art.bytecode as Hex;
export const REGISTRY = (process.env.REGISTRY_ADDRESS ?? "0xdaeddd6a68bbea02c58dd0349797e8847c3fa797") as `0x${string}`;
const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;

export const newSecretKey = () => "sk_test_" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
export const hashKey = (sk: string) => keccak256(toBytes(sk));
export const pkFor = (id: bigint | number) => `pk_test_${id}`;
export const parsePk = (pk: string) => (/^pk_test_\d{1,20}$/.test(pk) ? BigInt(pk.slice(8)) : null);

export type ServiceView = {
  owner: `0x${string}`;
  payee: `0x${string}`;
  ratePerSec: bigint;
  active: boolean;
  name: string;
};

export async function readService(id: bigint): Promise<ServiceView> {
  const s = (await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "service", args: [id] })) as any;
  return { owner: s.owner, payee: s.payee, ratePerSec: s.ratePerSec as bigint, active: s.active as boolean, name: s.name as string };
}

export function termsFor(id: bigint, s: Awaited<ReturnType<typeof readService>>) {
  const policy = publicPolicy({ kind: "key", serviceId: id.toString() });
  return {
    x402Version: 1,
    accepts: [{
      scheme: "stream-per-second", network: `eip155:${CHAIN_ID}`, asset: "native:MON",
      payTo: s.payee, escrow: ESCROW, ratePerSec: s.ratePerSec.toString(), minDeposit: (s.ratePerSec * 10n).toString(),
      resource: `registry:${REGISTRY}:${id}`, description: `${s.name} (${formatEther(s.ratePerSec)} MON/s)`,
      extra: {
        open: "StreamEscrow.open(payTo, ratePerSec) payable", publishableKey: pkFor(id),
        ...(policy ? { policy } : {}),
      },
    }],
  };
}

export const registry = new Hono();
registry.get("/config", (c) => c.json({ registry: REGISTRY, registryUrl: REGISTRY && addrUrl(REGISTRY), escrow: ESCROW, chainId: CHAIN_ID, rpc: process.env.RPC_URL, privyAppId: process.env.PRIVY_APP_ID ?? null, abi: registryAbi }));
// Agents: discover terms with a publishable key
registry.get("/terms/:pk", async (c) => {
  const id = parsePk(c.req.param("pk"));
  if (id === null) return c.json({ error: "bad publishable key" }, 400);
  const s = await readService(id).catch(() => null);
  if (!s || !s.active) return c.json({ error: "unknown or inactive service" }, 404);
  return c.json(termsFor(id, s));
});
// Providers: authenticate with a secret key (Authorization: Bearer sk_test_...)
export async function authenticateProvider(c: Context): Promise<{ id: bigint } | Response> {
  const sk = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const pk = c.req.header("X-Publishable-Key") ?? "";
  const id = parsePk(pk);
  if (!sk.startsWith("sk_test_") || id === null) return c.json({ error: "need Bearer sk_test_ + X-Publishable-Key" }, 401);
  const ok = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "verifyKey", args: [id, hashKey(sk)] }).catch(() => null);
  if (ok === null) return c.json({ error: "cannot verify (RPC)" }, 503);
  if (!ok) return c.json({ error: "invalid secret key" }, 401);
  return { id };
}

function policySubject(serviceId: bigint, body: unknown): { ok: true; subject: PolicySubject } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "bad json" };
  const rec = body as Record<string, unknown>;
  const id = serviceId.toString();
  if (rec.subject === "key") return { ok: true, subject: { kind: "key", serviceId: id } };
  if (rec.subject === "agent") {
    if (typeof rec.agent !== "string" || !isAddress(rec.agent)) return { ok: false, error: "bad agent address" };
    return { ok: true, subject: { kind: "agent", serviceId: id, agent: getAddress(rec.agent) } };
  }
  return { ok: false, error: "subject must be key or agent" };
}

registry.get("/me", async (c) => {
  const auth = await authenticateProvider(c);
  if (auth instanceof Response) return auth;
  const s = await readService(auth.id);
  return c.json({ serviceId: auth.id.toString(), ...s, ratePerSec: s.ratePerSec.toString() });
});

/** Policy + webhook routes. `only` pins a process that serves a single service id. */
export function mountBillingAdmin(router: Hono, only?: bigint) {
  const authFor = async (c: Context) => {
    const auth = await authenticateProvider(c);
    if (auth instanceof Response) return auth;
    if (only !== undefined && auth.id !== only) return c.json({ error: "this process serves a different publishable key" }, 403);
    return auth;
  };
  router.get("/policy", async (c) => {
    const auth = await authFor(c);
    if (auth instanceof Response) return auth;
    const agent = c.req.query("agent");
    if (agent) {
      if (!isAddress(agent)) return c.json({ error: "bad agent address" }, 400);
      return c.json(viewPolicy({ kind: "agent", serviceId: auth.id.toString(), agent: getAddress(agent) }));
    }
    return c.json(viewPolicy({ kind: "key", serviceId: auth.id.toString() }));
  });
  router.put("/policy", async (c) => {
    const auth = await authFor(c);
    if (auth instanceof Response) return auth;
    const body = await c.req.json().catch(() => null);
    const subject = policySubject(auth.id, body);
    if (!subject.ok) return c.json({ error: subject.error }, 400);
    const limits = parseLimits(body);
    if (!limits.ok) return c.json({ error: limits.error }, 400);
    setPolicy(subject.subject, limits.limits);
    return c.json(viewPolicy(subject.subject));
  });
  router.get("/webhook", async (c) => {
    const auth = await authFor(c);
    if (auth instanceof Response) return auth;
    return c.json(viewWebhook(auth.id.toString()));
  });
  router.put("/webhook", async (c) => {
    const auth = await authFor(c);
    if (auth instanceof Response) return auth;
    const saved = saveWebhookConfig(auth.id.toString(), await c.req.json().catch(() => null));
    if (!saved.ok) return c.json({ error: saved.error }, 400);
    return c.json(saved.view);
  });
}

mountBillingAdmin(registry);

// Testnet gas drip so a fresh Privy embedded wallet can pay for its own registration tx.
// One drip per address, global cap, from the demo payer wallet. Testnet only.
const dripped = new Set<string>();
const DRIP = parseEther(process.env.DRIP_MON ?? "0.05");
const DRIP_CAP = Number(process.env.DRIP_CAP ?? 100);
registry.post("/drip", async (c) => {
  if (CHAIN_ID !== 10143 || !process.env.PAYER_KEY) return c.json({ error: "drip disabled" }, 403);
  const { address } = await c.req.json().catch(() => ({}));
  if (!isAddress(address ?? "")) return c.json({ error: "bad address" }, 400);
  const a = address.toLowerCase();
  if (dripped.has(a) || dripped.size >= DRIP_CAP) return c.json({ error: "already dripped / cap reached" }, 429);
  if ((await pub.getBalance({ address })) >= DRIP) return c.json({ error: "you already have gas" }, 409);
  dripped.add(a);
  try {
    const h = await mkWallet(process.env.PAYER_KEY).sendTransaction({ to: address, value: DRIP });
    await pub.waitForTransactionReceipt({ hash: h });
    return c.json({ tx: h, url: txUrl(h) });
  } catch (e: any) { dripped.delete(a); return c.json({ error: e.shortMessage ?? "drip failed" }, 500); }
});
