// x402-style paid endpoint metered per second against an on-chain StreamEscrow.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { parseEther, formatEther } from "viem";
import { pub, abi, txUrl, addrUrl, CHAIN_ID, wallet } from "./chain";

const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;
const PAYEE = process.env.PAYEE_ADDRESS as `0x${string}`;
const RATE = parseEther(process.env.RATE_PER_SEC ?? "0.001"); // MON per second
const PORT = Number(process.env.PORT ?? 4020);

type Ev = { t: number; kind: string; msg: string; link?: string };
const log: Ev[] = [];
const push = (kind: string, msg: string, link?: string) => { log.push({ t: Date.now(), kind, msg, link }); console.log(`[${kind}] ${msg} ${link ?? ""}`); };
let current: { id: string; ratePerSec: string; deposit: string; start: number; tokens: number; stopped?: number } | null = null;

const terms = () => ({
  x402Version: 1,
  accepts: [{
    scheme: "stream-per-second",          // x402 add-on scheme: pay while you use
    network: `eip155:${CHAIN_ID}`,
    asset: "native:MON",
    payTo: PAYEE,
    escrow: ESCROW,
    ratePerSec: RATE.toString(),
    minDeposit: (RATE * 10n).toString(),
    resource: "/api/infer",
    description: "LLM-style token stream, billed per second of session time",
    extra: { open: "StreamEscrow.open(payee, ratePerSec) payable", proofHeader: "X-PAYMENT-STREAM: <streamId>" },
  }],
});

async function readStream(id: bigint) {
  const s = (await pub.readContract({ address: ESCROW, abi, functionName: "streams", args: [id] })) as any[];
  const [active, owed] = await Promise.all([
    pub.readContract({ address: ESCROW, abi, functionName: "isActive", args: [id] }) as Promise<boolean>,
    pub.readContract({ address: ESCROW, abi, functionName: "owed", args: [id] }) as Promise<bigint>,
  ]);
  return { payer: s[0], payee: s[1], rate: s[2] as bigint, deposit: s[3] as bigint, start: Number(s[4]), stoppedAt: Number(s[5]), active, owed };
}

const app = new Hono();
app.get("/", (c) => c.html(Bun.file("web/index.html").text()));
app.get("/api/terms", (c) => c.json(terms()));

app.get("/api/infer", async (c) => {
  const sid = c.req.header("X-PAYMENT-STREAM");
  if (!sid) {
    c.header("X-PAYMENT-REQUIRED", Buffer.from(JSON.stringify(terms())).toString("base64"));
    push("402", "agent hit /api/infer without payment -> 402 Payment Required with stream terms");
    return c.json(terms(), 402);
  }
  const id = BigInt(sid);
  const s = await readStream(id);
  if (!s.active || s.payee.toLowerCase() !== PAYEE.toLowerCase() || s.rate < RATE) {
    push("reject", `stream ${sid} not acceptable (active=${s.active})`);
    return c.json({ error: "stream not funded/active", ...terms() }, 402);
  }
  push("verify", `stream #${sid} verified on-chain: deposit ${formatEther(s.deposit)} MON @ ${formatEther(s.rate)} MON/s`);
  current = { id: sid, ratePerSec: formatEther(s.rate), deposit: formatEther(s.deposit), start: s.start * 1000, tokens: 0 };
  const words = "the agent is renting inference by the second and every token you see is metered against a live on chain escrow on monad when the agent stops the meter stops and the unused deposit goes straight back".split(" ");
  if (process.env.PAYEE_KEY) setTimeout(async () => {   // provider claims accrued earnings mid-stream
    try {
      const h = await wallet(process.env.PAYEE_KEY!).writeContract({ address: ESCROW, abi, functionName: "claim", args: [id], gas: 120000n });
      const r = await pub.waitForTransactionReceipt({ hash: h });
      push("claim", `provider claimed accrued earnings mid-stream (${r.status})`, txUrl(h));
    } catch (e: any) { push("claim", "claim failed: " + e.shortMessage); }
  }, 5000);
  return streamSSE(c, async (st) => {
    let i = 0, lastCheck = 0;
    let aborted = false;
    st.onAbort(() => { aborted = true; });
    while (!aborted) {
      if (Date.now() - lastCheck > 1000) {
        lastCheck = Date.now();
        const live = await readStream(id).catch(() => null);
        if (live && !live.active) {
          push("cutoff", `stream #${sid} ${live.stoppedAt ? "closed by payer" : "balance exhausted"} -> service cut off`);
          await st.writeSSE({ event: "cutoff", data: live.stoppedAt ? "closed" : "exhausted" });
          break;
        }
      }
      await st.writeSSE({ event: "token", data: words[i++ % words.length] });
      if (current) current.tokens++;
      await st.sleep(200);
    }
    if (current?.id === sid) current.stopped = Date.now();
  });
});

app.post("/api/log", async (c) => {           // agent reports its own tx hashes for the dashboard
  const b = await c.req.json();
  push(b.kind, b.msg, b.hash ? txUrl(b.hash) : undefined);
  if (b.kind === "close" && current) current.stopped = Date.now();
  return c.json({ ok: true });
});
app.get("/api/state", (c) => c.json({ escrow: ESCROW, escrowUrl: addrUrl(ESCROW), rate: formatEther(RATE), current, log: log.slice(-40) }));

let running = false;
app.post("/api/run-agent", (c) => {
  if (running) return c.json({ ok: false, msg: "agent already running" });
  running = true; log.length = 0; current = null;
  const p = Bun.spawn(["bun", "src/agent.ts"], { env: { ...process.env, SERVER: `http://localhost:${PORT}` }, stdout: "inherit", stderr: "inherit" });
  p.exited.then(() => { running = false; });
  return c.json({ ok: true });
});

export default { port: PORT, fetch: app.fetch, idleTimeout: 120 };
console.log(`streampay-402 server on :${PORT}, escrow ${ESCROW}`);
