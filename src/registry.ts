// Onchain sign-up + Stripe-style keys for streampay-402.
//   pk_test_<serviceId>  publishable: agents use it to discover per-second terms
//   sk_test_<64 hex>     secret: shown once; only keccak256(sk) is stored onchain
import { Hono } from "hono";
import { keccak256, toBytes, formatEther, parseEther, isAddress, type Hex } from "viem";
import { pub, CHAIN_ID, addrUrl, wallet as mkWallet, txUrl } from "./chain";
import art from "./registry-artifact.json";
import { getStore } from "./store";

export const registryAbi = art.abi as any;
export const registryBytecode = art.bytecode as Hex;
export const REGISTRY = (process.env.REGISTRY_ADDRESS ?? "0xdaeddd6a68bbea02c58dd0349797e8847c3fa797") as `0x${string}`;
const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;

export const newSecretKey = () => "sk_test_" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
export const hashKey = (sk: string) => keccak256(toBytes(sk));
export const pkFor = (id: bigint | number) => `pk_test_${id}`;
export const parsePk = (pk: string) => (/^pk_test_\d{1,20}$/.test(pk) ? BigInt(pk.slice(8)) : null);

const REGISTRY_CACHE_SEC = 15;

export async function readService(id: bigint) {
  const key = id.toString();
  try {
    const hit = await getStore().getCachedService(key);
    if (hit) return { owner: hit.owner, payee: hit.payee, ratePerSec: BigInt(hit.ratePerSec), active: hit.active, name: hit.name };
  } catch (err) {
    console.log("[registry] cache read failed", err instanceof Error ? err.message : "");
  }
  const s = (await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "service", args: [id] })) as any;
  const service = { owner: s.owner as string, payee: s.payee as string, ratePerSec: s.ratePerSec as bigint, active: s.active as boolean, name: s.name as string };
  try {
    await getStore().setCachedService(key, {
      owner: service.owner, payee: service.payee, ratePerSec: service.ratePerSec.toString(), active: service.active, name: service.name,
    }, REGISTRY_CACHE_SEC);
  } catch (err) {
    console.log("[registry] cache write failed", err instanceof Error ? err.message : "");
  }
  return service;
}

export function termsFor(id: bigint, s: Awaited<ReturnType<typeof readService>>) {
  return {
    x402Version: 1,
    accepts: [{
      scheme: "stream-per-second", network: `eip155:${CHAIN_ID}`, asset: "native:MON",
      payTo: s.payee, escrow: ESCROW, ratePerSec: s.ratePerSec.toString(), minDeposit: (s.ratePerSec * 10n).toString(),
      resource: `registry:${REGISTRY}:${id}`, description: `${s.name} (${formatEther(s.ratePerSec)} MON/s)`,
      extra: { open: "StreamEscrow.open(payTo, ratePerSec) payable", publishableKey: pkFor(id) },
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
registry.get("/me", async (c) => {
  const sk = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const pk = c.req.header("X-Publishable-Key") ?? "";
  const id = parsePk(pk);
  if (!sk.startsWith("sk_test_") || id === null) return c.json({ error: "need Bearer sk_test_ + X-Publishable-Key" }, 401);
  const ok = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "verifyKey", args: [id, hashKey(sk)] }).catch(() => null);
  if (ok === null) return c.json({ error: "cannot verify (RPC)" }, 503);
  if (!ok) return c.json({ error: "invalid secret key" }, 401);
  const s = await readService(id);
  return c.json({ serviceId: id.toString(), ...s, ratePerSec: s.ratePerSec.toString() });
});

// Testnet gas drip so a fresh Privy embedded wallet can pay for its own registration tx.
// One drip per address, global cap, from the demo payer wallet. Testnet only.
const DRIP = parseEther(process.env.DRIP_MON ?? "0.05");
const DRIP_CAP = Number(process.env.DRIP_CAP ?? 100);
registry.post("/drip", async (c) => {
  if (CHAIN_ID !== 10143 || !process.env.PAYER_KEY) return c.json({ error: "drip disabled" }, 403);
  const { address } = await c.req.json().catch(() => ({}));
  if (!isAddress(address ?? "")) return c.json({ error: "bad address" }, 400);
  const a = address.toLowerCase();
  if (await getStore().hasDrip(a)) return c.json({ error: "already dripped / cap reached" }, 429);
  if ((await pub.getBalance({ address })) >= DRIP) return c.json({ error: "you already have gas" }, 409);
  const slot = await getStore().tryDrip(a, DRIP_CAP);
  switch (slot) {
    case "ok":
      break;
    case "dup":
    case "cap":
      return c.json({ error: "already dripped / cap reached" }, 429);
    default: {
      const _never: never = slot;
      return c.json({ error: _never }, 500);
    }
  }
  try {
    const h = await mkWallet(process.env.PAYER_KEY).sendTransaction({ to: address, value: DRIP });
    await pub.waitForTransactionReceipt({ hash: h });
    return c.json({ tx: h, url: txUrl(h) });
  } catch (e: unknown) {
    await getStore().releaseDrip(a);
    const msg = typeof e === "object" && e !== null && "shortMessage" in e && typeof e.shortMessage === "string" ? e.shortMessage : "drip failed";
    return c.json({ error: msg }, 500);
  }
});
