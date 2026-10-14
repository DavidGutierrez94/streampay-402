// Autonomous agent: hits paid endpoint, gets 402, opens a per-second stream, consumes, stops mid-task, closes, gets refund.
import { formatEther, getAddress } from "viem";
import { pub, wallet, abi, txUrl } from "./chain";

const SERVER = process.env.SERVER ?? "http://localhost:4020";
const TASK_SECONDS = Number(process.env.TASK_SECONDS ?? 12);
const DEPOSIT_SECONDS = BigInt(process.env.DEPOSIT_SECONDS ?? 60);
const w = wallet(process.env.PAYER_KEY!);
const report = (kind: string, msg: string, hash?: string) => {
  console.log(`[agent:${kind}] ${msg} ${hash ? txUrl(hash) : ""}`);
  return fetch(`${SERVER}/api/log`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, msg, hash }) }).catch(() => {});
};

const r1 = await fetch(`${SERVER}/api/infer`);
if (r1.status !== 402) throw new Error("expected 402");
const terms = (await r1.json()).accepts[0];
terms.escrow = getAddress(terms.escrow.toLowerCase()); terms.payTo = getAddress(terms.payTo.toLowerCase());
const rate = BigInt(terms.ratePerSec);
const deposit = rate * DEPOSIT_SECONDS;
await report("plan", `got 402: ${formatEther(rate)} MON/s. Budget ${formatEther(deposit)} MON (${DEPOSIT_SECONDS}s max)`);

const before = await pub.getBalance({ address: w.account.address });
const openHash = await w.writeContract({ address: terms.escrow, abi, functionName: "open", args: [terms.payTo, rate], value: deposit, gas: 200000n });
const rc = await pub.waitForTransactionReceipt({ hash: openHash });
const opened = rc.logs.find((l) => l.address.toLowerCase() === terms.escrow.toLowerCase())!;
const streamId = BigInt(opened.topics[1]!);
await report("open", `opened stream #${streamId} with ${formatEther(deposit)} MON deposit`, openHash);

const r2 = await fetch(`${SERVER}/api/infer`, { headers: { "X-PAYMENT-STREAM": streamId.toString() } });
if (r2.status !== 200) throw new Error("server rejected stream: " + (await r2.text()));
const reader = r2.body!.getReader();
const dec = new TextDecoder();
const t0 = Date.now();
let tokens = 0, text = "";
while (Date.now() - t0 < TASK_SECONDS * 1000) {
  const { value, done } = await reader.read();
  if (done) break;
  for (const m of dec.decode(value).matchAll(/event: token\ndata: (.*)/g)) { tokens++; text += m[1] + " "; }
}
await reader.cancel().catch(() => {});
await report("stop", `task done after ${TASK_SECONDS}s / ${tokens} tokens -> stopping mid-budget`);

const closeHash = await w.writeContract({ address: terms.escrow, abi, functionName: "close", args: [streamId], gas: 150000n });
const cr = await pub.waitForTransactionReceipt({ hash: closeHash });
if (cr.status !== "success") throw new Error("close reverted " + closeHash);
const ev = cr.logs.find((l) => l.address.toLowerCase() === terms.escrow.toLowerCase())!;
const paid = BigInt("0x" + ev.data.slice(2, 66)), refund = BigInt("0x" + ev.data.slice(66, 130));
await report("close", `closed: paid ${formatEther(paid)} MON to provider, refunded ${formatEther(refund)} MON instantly`, closeHash);
const after = await pub.getBalance({ address: w.account.address });
console.log("output:", text.trim().slice(0, 200));
console.log("net cost incl. gas:", formatEther(before - after), "MON");
