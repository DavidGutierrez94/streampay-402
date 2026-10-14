// Autonomous agent: hits paid endpoint, gets 402, opens a per-second stream, consumes, stops mid-task, closes, gets refund.
import { formatEther, getAddress, parseEther, parseEventLogs } from "viem";
import { pub, wallet, abi, txUrl } from "./chain";

const SERVER = process.env.SERVER ?? "http://localhost:4020";
const TASK_SECONDS = Number(process.env.TASK_SECONDS ?? 12);
const DEPOSIT_SECONDS = BigInt(process.env.DEPOSIT_SECONDS ?? 60);
// H-3: never trust the 402 terms blindly — pin escrow, allowlist payees, cap rate and budget
const TRUSTED_ESCROW = getAddress(process.env.ESCROW_ADDRESS!.toLowerCase());
const TRUSTED_PAYEES = (process.env.TRUSTED_PAYEES ?? process.env.PAYEE_ADDRESS!).split(",").map((a) => getAddress(a.trim().toLowerCase()));
const MAX_RATE = parseEther(process.env.MAX_RATE_PER_SEC ?? "0.001");
const MAX_DEPOSIT = parseEther(process.env.MAX_DEPOSIT ?? "0.1");
const w = wallet(process.env.PAYER_KEY!);
const report = (kind: string, msg: string, hash?: string) => {
  console.log(`[agent:${kind}] ${msg} ${hash ? txUrl(hash) : ""}`);
  return fetch(`${SERVER}/api/log`, { method: "POST", headers: { "content-type": "application/json", "x-demo-token": process.env.DEMO_TOKEN ?? "" }, body: JSON.stringify({ kind, msg, hash }) }).catch(() => {});
};

let streamId: bigint | undefined;
let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
let stop = false;
const requestStop = () => {
  stop = true;
  reader?.cancel().catch(() => {});
};
// Demo "Stop agent" sends SIGINT; keep the process alive so finally can close the stream (M-1).
process.on("SIGINT", () => { requestStop(); });
const watch = setInterval(() => {
  fetch(`${SERVER}/api/agent-stop`).then((r) => r.json()).then((j: { stop?: boolean }) => { if (j.stop) requestStop(); }).catch(() => {});
}, 250);
watch.unref();

async function streamInactive(id: bigint): Promise<boolean> {
  const s = await pub.readContract({ address: TRUSTED_ESCROW, abi, functionName: "streams", args: [id] }).catch(() => null) as any[] | null;
  return !!s && BigInt(s[5] ?? 0) !== 0n;
}

async function serverIsClosing(): Promise<boolean> {
  const r = await fetch(`${SERVER}/api/agent-stop`).catch(() => null);
  if (!r) return false;
  const j = await r.json().catch(() => ({})) as { closing?: boolean };
  return !!j.closing;
}

const r1 = await fetch(`${SERVER}/api/infer`);
if (r1.status !== 402) throw new Error("expected 402");
const terms = (await r1.json()).accepts[0];
terms.escrow = getAddress(terms.escrow.toLowerCase()); terms.payTo = getAddress(terms.payTo.toLowerCase());
if (terms.escrow !== TRUSTED_ESCROW) throw new Error(`untrusted escrow ${terms.escrow}`);
if (!TRUSTED_PAYEES.includes(terms.payTo)) throw new Error(`untrusted payee ${terms.payTo}`);
const rate = BigInt(terms.ratePerSec);
if (rate <= 0n || rate > MAX_RATE) throw new Error(`rate ${rate} above cap ${MAX_RATE}`);
const deposit = rate * DEPOSIT_SECONDS;
if (deposit > MAX_DEPOSIT) throw new Error(`deposit ${formatEther(deposit)} above cap ${formatEther(MAX_DEPOSIT)}`);
await report("plan", `got 402: ${formatEther(rate)} MON/s (within cap). Budget ${formatEther(deposit)} MON (${DEPOSIT_SECONDS}s max)`);

const before = await pub.getBalance({ address: w.account.address });

// M-1: always close, including when the demo asks the agent to stop early.
let closed = false;
const closeNow = async () => {
  const id = streamId;
  if (closed || id == null) return;
  if (stop && await serverIsClosing()) {
    for (let i = 0; i < 80 && !(await streamInactive(id)); i++) await Bun.sleep(250);
  }
  if (await streamInactive(id)) { closed = true; return; }
  try {
    const closeHash = await w.writeContract({ address: TRUSTED_ESCROW, abi, functionName: "close", args: [id], gas: 200000n });
    const cr = await pub.waitForTransactionReceipt({ hash: closeHash });
    if (cr.status !== "success") throw new Error("close reverted " + closeHash);
    const ev = parseEventLogs({ abi, logs: cr.logs, eventName: "Closed" })[0] as any;
    const refunded = ev.args.refunded as bigint;
    const paid = deposit - refunded;
    closed = true;
    await report("close", `closed: paid ${formatEther(paid)} MON to provider, refunded ${formatEther(refunded)} MON instantly`, closeHash);
  } catch (e) {
    if (await streamInactive(id)) { closed = true; return; }
    throw e;
  }
};

let tokens = 0, text = "";
try {
  if (!stop) {
    const openHash = await w.writeContract({ address: TRUSTED_ESCROW, abi, functionName: "open", args: [terms.payTo, rate], value: deposit, gas: 200000n });
    const rc = await pub.waitForTransactionReceipt({ hash: openHash });
    if (rc.status !== "success") throw new Error("open reverted " + openHash);
    const opened = parseEventLogs({ abi, logs: rc.logs, eventName: "Opened" })[0] as any;
    streamId = BigInt(opened.args.id);
    await report("open", `opened stream #${streamId} with ${formatEther(deposit)} MON deposit`, openHash);
  }
  if (stop || streamId == null) {
    await report("stop", "stopped before the session started");
  } else {
    const sig = await w.signMessage({ message: `x402-stream:${TRUSTED_ESCROW.toLowerCase()}:${streamId}` });  // H-2: prove stream ownership
    let r2: Response | undefined;
    for (let i = 0; i < 3 && !stop; i++) {   // public RPC nodes may lag a moment behind our receipt
      r2 = await fetch(`${SERVER}/api/infer`, { headers: { "X-PAYMENT-STREAM": streamId.toString(), "X-PAYMENT-SIG": sig } });
      if (r2.status === 200) break;
      await Bun.sleep(1000);
    }
    if (stop) {
      await report("stop", "stopped before the session started");
    } else if (!r2 || r2.status !== 200) {
      throw new Error("server rejected stream: " + (await r2?.text()));
    } else {
      reader = r2.body!.getReader();
      const dec = new TextDecoder();
      const t0 = Date.now();
      while (!stop && Date.now() - t0 < TASK_SECONDS * 1000) {
        const { value, done } = await reader.read();
        if (done || stop) break;
        for (const m of dec.decode(value).matchAll(/event: token\ndata: (.*)/g)) { tokens++; text += m[1] + " "; }
      }
      await reader.cancel().catch(() => {});
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      await report("stop", stop
        ? `stopped from the demo after ${elapsed}s / ${tokens} tokens`
        : `task done after ${TASK_SECONDS}s / ${tokens} tokens -> stopping mid-budget`);
    }
  }
} finally {
  clearInterval(watch);
  await closeNow();
}
const after = await pub.getBalance({ address: w.account.address });
console.log("output:", text.trim().slice(0, 200));
console.log("net cost incl. gas:", formatEther(before - after), "MON");
