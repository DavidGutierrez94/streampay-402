// In-process demo agent. Calls the Hono app directly (no loopback HTTP, no
// child process) so one Vercel function can open a stream, read the SSE meter,
// and close. Does not read PAYEE_KEY; the server claims with that key itself.
import { formatEther, getAddress, parseEther, parseEventLogs } from "viem";
import { pub, wallet, abi, txUrl } from "./chain";
import { sleep } from "./defer";

export type FetchApp = {
  request: (input: string, init?: RequestInit) => Promise<Response>;
};
export type DemoReport = (kind: string, msg: string, hash?: string) => Promise<void>;

const errText = (e: unknown) => (e instanceof Error ? e.message : "agent failed");

export async function runDemoAgent(app: FetchApp, report: DemoReport) {
  const payerKey = process.env.PAYER_KEY;
  if (!payerKey) throw new Error("PAYER_KEY is not set");
  const escrowEnv = process.env.ESCROW_ADDRESS;
  const payeeEnv = process.env.PAYEE_ADDRESS;
  if (!escrowEnv || !payeeEnv) throw new Error("ESCROW_ADDRESS and PAYEE_ADDRESS are required");

  const TASK_SECONDS = Number(process.env.TASK_SECONDS ?? 12);
  const DEPOSIT_SECONDS = BigInt(process.env.DEPOSIT_SECONDS ?? 60);
  const TRUSTED_ESCROW = getAddress(escrowEnv.toLowerCase());
  const TRUSTED_PAYEES = (process.env.TRUSTED_PAYEES ?? payeeEnv).split(",").map((a) => getAddress(a.trim().toLowerCase()));
  const MAX_RATE = parseEther(process.env.MAX_RATE_PER_SEC ?? "0.001");
  const MAX_DEPOSIT = parseEther(process.env.MAX_DEPOSIT ?? "0.1");
  const w = wallet(payerKey);

  const r1 = await app.request("/api/infer");
  if (r1.status !== 402) throw new Error("expected 402");
  const body = await r1.json() as { accepts?: { escrow?: string; payTo?: string; ratePerSec?: string }[] };
  const terms = body.accepts?.[0];
  if (!terms?.escrow || !terms.payTo || !terms.ratePerSec) throw new Error("402 terms missing");
  const escrow = getAddress(terms.escrow.toLowerCase());
  const payTo = getAddress(terms.payTo.toLowerCase());
  if (escrow !== TRUSTED_ESCROW) throw new Error(`untrusted escrow ${escrow}`);
  if (!TRUSTED_PAYEES.includes(payTo)) throw new Error(`untrusted payee ${payTo}`);
  const rate = BigInt(terms.ratePerSec);
  if (rate <= 0n || rate > MAX_RATE) throw new Error(`rate ${rate} above cap ${MAX_RATE}`);
  const deposit = rate * DEPOSIT_SECONDS;
  if (deposit > MAX_DEPOSIT) throw new Error(`deposit ${formatEther(deposit)} above cap ${formatEther(MAX_DEPOSIT)}`);
  await report("plan", `got 402: ${formatEther(rate)} MON/s (within cap). Budget ${formatEther(deposit)} MON (${DEPOSIT_SECONDS}s max)`);

  const before = await pub.getBalance({ address: w.account.address });
  const openHash = await w.writeContract({ address: TRUSTED_ESCROW, abi, functionName: "open", args: [payTo, rate], value: deposit, gas: 200000n });
  const rc = await pub.waitForTransactionReceipt({ hash: openHash });
  if (rc.status !== "success") throw new Error("open reverted " + openHash);
  const opened = parseEventLogs({ abi, logs: rc.logs, eventName: "Opened" })[0];
  if (!opened) throw new Error("open event missing");
  const streamId = opened.args.id;
  await report("open", `opened stream #${streamId} with ${formatEther(deposit)} MON deposit`, openHash);

  let closed = false;
  let stop = false;
  let watching = true;
  const agentStop = async () => {
    const res = await app.request("/api/agent-stop").catch(() => null);
    if (!res?.ok) return { stop: false, closing: false };
    const body = await res.json().catch(() => ({})) as { stop?: boolean; closing?: boolean };
    return { stop: !!body.stop, closing: !!body.closing };
  };
  const streamInactive = async () => {
    const row = await pub.readContract({ address: TRUSTED_ESCROW, abi, functionName: "streams", args: [streamId] }).catch(() => null) as unknown[] | null;
    return !!row && BigInt((row[5] as bigint | number | undefined) ?? 0) !== 0n;
  };
  const closeNow = async () => {
    if (closed) return;
    const gate = await agentStop();
    if ((stop || gate.stop) && gate.closing) {
      for (let i = 0; i < 80 && !(await streamInactive()); i++) await sleep(250);
    }
    if (await streamInactive()) { closed = true; return; }
    closed = true;
    const closeHash = await w.writeContract({ address: TRUSTED_ESCROW, abi, functionName: "close", args: [streamId], gas: 200000n });
    const cr = await pub.waitForTransactionReceipt({ hash: closeHash });
    if (cr.status !== "success") throw new Error("close reverted " + closeHash);
    const ev = parseEventLogs({ abi, logs: cr.logs, eventName: "Closed" })[0];
    if (!ev) throw new Error("close event missing");
    await report("close", `closed: paid ${formatEther(ev.args.paidToPayee)} MON to provider, refunded ${formatEther(ev.args.refunded)} MON instantly`, closeHash);
  };

  let tokens = 0;
  let text = "";
  try {
    const sig = await w.signMessage({ message: `x402-stream:${TRUSTED_ESCROW.toLowerCase()}:${streamId}` });
    let r2: Response | undefined;
    for (let i = 0; i < 3; i++) {
      r2 = await app.request("/api/infer", { headers: { "X-PAYMENT-STREAM": streamId.toString(), "X-PAYMENT-SIG": sig } });
      if (r2.status === 200) break;
      await sleep(1000);
    }
    if (!r2 || r2.status !== 200) throw new Error("server rejected stream: " + (await r2?.text()));
    const reader = r2.body?.getReader();
    if (!reader) throw new Error("stream body missing");
    const watch = (async () => {
      while (watching && !stop) {
        const gate = await agentStop();
        if (gate.stop) { stop = true; await reader.cancel().catch(() => {}); return; }
        await sleep(250);
      }
    })();
    void watch;
    const dec = new TextDecoder();
    const t0 = Date.now();
    while (!stop && Date.now() - t0 < TASK_SECONDS * 1000) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const m of dec.decode(value).matchAll(/event: token\ndata: (.*)/g)) {
        tokens++;
        text += m[1] + " ";
      }
    }
    await reader.cancel().catch(() => {});
    watching = false;
    await report("stop", stop ? `stop requested after ${tokens} tokens` : `task done after ${TASK_SECONDS}s / ${tokens} tokens -> stopping mid-budget`);
  } finally {
    watching = false;
    try {
      await closeNow();
    } catch (e) {
      await report("close", "close failed: " + errText(e).slice(0, 240));
    }
  }
  const after = await pub.getBalance({ address: w.account.address });
  console.log("output:", text.trim().slice(0, 200));
  console.log("net cost incl. gas:", formatEther(before - after), "MON");
  console.log("open tx:", txUrl(openHash));
}
