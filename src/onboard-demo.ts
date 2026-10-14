// End-to-end onchain onboarding demo: provider signs up -> gets pk/sk -> agent registers
// -> agent discovers terms with pk_ -> streams payment via StreamEscrow -> closes.
import { parseEther, formatEther, decodeEventLog } from "viem";
import { pub, wallet, abi as escrowAbi, txUrl } from "./chain";
import { REGISTRY, registryAbi, newSecretKey, hashKey, pkFor, readService, termsFor } from "./registry";
const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;
const provider = wallet(process.env.PAYEE_KEY!), agentW = wallet(process.env.PAYER_KEY!);
const send = async (w: any, address: `0x${string}`, a: any, functionName: string, args: any[], value?: bigint) => {
  const h = await w.writeContract({ address, abi: a, functionName, args, value, gas: 300000n });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error(functionName + " reverted");
  console.log(`${functionName}: ${txUrl(h)}`); return r;
};
const ev = (r: any, a: any, name: string) => r.logs.map((l: any) => { try { return decodeEventLog({ abi: a, ...l }); } catch { return null; } }).find((e: any) => e?.eventName === name)!.args;

// 1. provider signs up: secret generated locally, only its hash goes onchain
const sk = newSecretKey();
const r1 = await send(provider, REGISTRY, registryAbi, "registerService", [`gpu-session-${Date.now() % 1e5}`, parseEther("0.001"), provider.account.address, hashKey(sk)]);
const id = ev(r1, registryAbi, "ServiceRegistered").serviceId as bigint;
console.log(`service #${id}  publishable=${pkFor(id)}  secret=sk_test_…${sk.slice(-4)} (shown once)`);
console.log("verifyKey(sk):", await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "verifyKey", args: [id, hashKey(sk)] }));
// 2. agent identity (idempotent)
const has = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "agentOf", args: [agentW.account.address] });
if (has === 0n) await send(agentW, REGISTRY, registryAbi, "registerAgent", ["demo-agent"]); else console.log("agent already registered, id", Number(has) - 1);
// 3. agent discovers terms using pk_ only, then is charged per second via StreamEscrow
const t = termsFor(id, await readService(id)).accepts[0];
if (!t) throw new Error("registry returned no stream-per-second terms");
const rate = BigInt(t.extra.ratePerSec), deposit = rate * 20n;
const r3 = await send(agentW, ESCROW, escrowAbi, "open", [t.payTo, rate], deposit);
const sid = ev(r3, escrowAbi, "Opened").id as bigint;
console.log(`stream #${sid} @ ${formatEther(rate)} MON/s, deposit ${formatEther(deposit)}`);
await new Promise((s) => setTimeout(s, 5000));
const r4 = await send(agentW, ESCROW, escrowAbi, "close", [sid]);
const c = ev(r4, escrowAbi, "Closed");
console.log(`closed: paid ${formatEther(c.paidToPayee)} MON to service #${id}, refunded ${formatEther(c.refunded)}`);
