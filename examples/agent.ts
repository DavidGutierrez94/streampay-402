// Buyer agent: bun run agent <serviceId | pk_test_N> [url]
// discovers the service in the ServiceRegistry -> hits endpoint -> 402 -> opens escrow stream on Monad
// -> retries with payment headers -> consumes N seconds -> closes -> refund. Prints monadscan links.
import { formatEther, getAddress, parseEther, parseEventLogs } from "viem";
import { pub, wallet, abi, txUrl } from "../src/chain";
import { REGISTRY, readService, parsePk } from "../src/registry";

const arg = process.argv[2] ?? "";
const id = arg.startsWith("pk_") ? parsePk(arg) : /^\d+$/.test(arg) ? BigInt(arg) : null;
if (id === null) throw new Error("usage: bun run agent <serviceId|pk_test_N> [url]");
const SERVER = process.env.SERVER ?? "http://localhost:4020";
const URL_ = process.argv[3] ?? `${SERVER}/api/svc/${id}`;
const SECONDS = Number(process.env.TASK_SECONDS ?? 8);
const DEPOSIT_SECONDS = BigInt(process.env.DEPOSIT_SECONDS ?? 30);
const MAX_RATE = parseEther(process.env.MAX_RATE_PER_SEC ?? "0.001");
const ESCROW = getAddress(process.env.ESCROW_ADDRESS!.toLowerCase());
const w = wallet(process.env.PAYER_KEY!);

// 1. discovery: read the service straight from the onchain registry
const svc = await readService(id);
if (!svc.active) throw new Error(`service #${id} inactive`);
console.log(`registry ${REGISTRY}: service #${id} "${svc.name}" ${formatEther(svc.ratePerSec)} MON/s -> ${svc.payee}`);

// 2. call without payment -> 402
const r1 = await fetch(URL_);
if (r1.status !== 402) throw new Error(`expected 402, got ${r1.status}`);
const t = (await r1.json()).accepts[0];
console.log(`402 Payment Required: ${t.scheme} ${t.ratePerSec} wei/s, payTo ${t.payTo}`);
// never trust terms blindly: they must match the registry and our pinned escrow
if (getAddress(t.escrow.toLowerCase()) !== ESCROW) throw new Error("untrusted escrow");
if (getAddress(t.payTo.toLowerCase()) !== getAddress(svc.payee.toLowerCase()) || BigInt(t.ratePerSec) !== svc.ratePerSec) throw new Error("402 terms do not match registry");
const rate = svc.ratePerSec; if (rate > MAX_RATE) throw new Error("rate above cap");
const deposit = rate * DEPOSIT_SECONDS;

// 3. open stream
const oh = await w.writeContract({ address: ESCROW, abi, functionName: "open", args: [t.payTo, rate], value: deposit, gas: 200000n });
const orc = await pub.waitForTransactionReceipt({ hash: oh });
if (orc.status !== "success") throw new Error("open reverted");
const sid = BigInt((parseEventLogs({ abi, logs: orc.logs, eventName: "Opened" })[0] as any).args.id);
console.log(`open   stream #${sid}, deposit ${formatEther(deposit)} MON  ${txUrl(oh)}`);

let closed = false;
const close = async () => {
  if (closed) return; closed = true;
  const ch = await w.writeContract({ address: ESCROW, abi, functionName: "close", args: [sid], gas: 200000n });
  const cr = await pub.waitForTransactionReceipt({ hash: ch });
  const ev = parseEventLogs({ abi, logs: cr.logs, eventName: "Closed" })[0] as any;
  console.log(`close  paid ${formatEther(ev.args.paidToPayee)} MON, refunded ${formatEther(ev.args.refunded)} MON  ${txUrl(ch)}`);
};
process.once("SIGINT", async () => { await close().catch(() => {}); process.exit(130); });

try {
  // 4. retry with payment proof, consume for N seconds
  const sig = await w.signMessage({ message: `x402-stream:${ESCROW.toLowerCase()}:${sid}` });
  let r2: Response | undefined;
  for (let i = 0; i < 4; i++) {
    r2 = await fetch(URL_, { headers: { "X-PAYMENT-STREAM": sid.toString(), "X-PAYMENT-SIG": sig } });
    if (r2.status === 200) break; await Bun.sleep(1000);
  }
  if (!r2 || r2.status !== 200) throw new Error("rejected: " + (await r2?.text()));
  const rd = r2.body!.getReader(), dec = new TextDecoder(), t0 = Date.now(); let n = 0;
  while (Date.now() - t0 < SECONDS * 1000) {
    const { value, done } = await rd.read(); if (done) break;
    n += [...dec.decode(value).matchAll(/event: token/g)].length;
  }
  await rd.cancel().catch(() => {});
  console.log(`consumed ${SECONDS}s of service (${n} metered chunks), stopping`);
} finally { await close(); }
