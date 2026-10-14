// x402-style paid endpoint metered per second against an on-chain StreamEscrow.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { parseEther, formatEther, verifyMessage } from "viem";
import { pub, abi, txUrl, addrUrl, CHAIN_ID, wallet } from "./chain";
import { registry } from "./registry";
import { serveMetered } from "./meter";

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
// ---- SEO: per-page head tags; absolute URLs from PUBLIC_URL or the request host ----
const baseUrl = (c: any) => {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, "");
  const u = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? u.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? u.host;
  return `${proto}://${host}`;
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
type Meta = { path: string; title: string; description: string; jsonLd?: boolean };
const PAGES: Record<string, Meta> = {
  landing: { path: "/", title: "StreamPay-402 · Pay only for the time you actually use", jsonLd: true,
    description: "Pay only for the time you actually use: per-second billing for agents, APIs and compute. Open an escrow stream, pay by the second, get the rest refunded. Built on x402 and Monad." },
  onboard: { path: "/onboard", title: "Sign up · Bill your API by the second · StreamPay-402",
    description: "Pay only for the time you actually use: register your agent, API or compute service, set a price per second onchain and get API keys. Email sign-up, no wallet needed." },
  demo: { path: "/demo", title: "Live demo · An AI agent paying by the second · StreamPay-402",
    description: "Pay only for the time you actually use: watch an AI agent open an escrow stream on Monad testnet, pay per second for a service and get unused funds refunded." },
};
function headTags(base: string, m: Meta) {
  const url = base + m.path, img = base + "/og.png", t = esc(m.title), d = esc(m.description);
  let h = `<title>${t}</title>
<meta name="description" content="${d}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${url}">
<link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/png" href="/favicon.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="website"><meta property="og:site_name" content="StreamPay-402">
<meta property="og:title" content="${t}"><meta property="og:description" content="${d}">
<meta property="og:url" content="${url}"><meta property="og:image" content="${img}">
<meta property="og:image:width" content="1024"><meta property="og:image:height" content="1024"><meta property="og:image:alt" content="StreamPay-402 logo">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}"><meta name="twitter:image" content="${img}"><meta name="twitter:image:alt" content="StreamPay-402 logo">`;
  if (m.jsonLd) h += `\n<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org", "@type": "SoftwareApplication", name: "StreamPay-402", url,
    applicationCategory: "FinanceApplication", operatingSystem: "Web", image: img, description: m.description,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    featureList: ["Per-second billing", "x402 HTTP payments", "Onchain escrow streams on Monad", "Automatic refunds", "API keys"],
  })}</script>`;
  return h;
}
const page = (file: string, key: string) => async (c: any) =>
  c.html((await Bun.file(file).text()).replace("<!--SEO-->", headTags(baseUrl(c), PAGES[key])));
const png = (f: string) => () => new Response(Bun.file(f), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
app.get("/og.png", png("web/og.png"));
app.get("/favicon.png", png("web/favicon.png"));
app.get("/apple-touch-icon.png", png("web/apple-touch-icon.png"));
app.get("/favicon.ico", () => new Response(Bun.file("web/favicon.ico"), { headers: { "content-type": "image/x-icon" } }));
app.get("/robots.txt", (c) => c.text(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${baseUrl(c)}/sitemap.xml\n`));
app.get("/sitemap.xml", (c) => {
  const b = baseUrl(c), d = new Date().toISOString().slice(0, 10);
  const urls = Object.values(PAGES).map((m) => `<url><loc>${b}${m.path}</loc><lastmod>${d}</lastmod><priority>${m.path === "/" ? "1.0" : "0.8"}</priority></url>`).join("");
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, 200, { "content-type": "application/xml" });
});
app.get("/", page("web/landing.html", "landing"));
app.get("/demo", page("web/index.html", "demo"));
app.get("/theme.css", () => new Response(Bun.file("web/theme.css"), { headers: { "content-type": "text/css" } }));
app.route("/api/registry", registry);   // onboarding: ServiceRegistry + pk_/sk_ keys
app.get("/onboard", page("web/onboard.html", "onboard"));
app.get("/onboard.js", () => new Response(Bun.file("web/onboard.js"), { headers: { "content-type": "text/javascript" } }));
// Any service registered via /onboard is immediately callable here, metered per second
app.get("/api/svc/:id", (c) => {
  const raw = c.req.param("id"); const m = /^(?:pk_test_)?(\d{1,20})$/.exec(raw);
  if (!m) return c.json({ error: "bad service id" }, 400);
  return serveMetered(c, BigInt(m[1]));
});
app.get("/api/terms", (c) => c.json(terms()));

const sessions = new Set<string>();          // H-2: one live session per stream
const claimScheduled = new Set<string>();    // M-4: at most one provider claim per stream
const DEMO_TOKEN = process.env.DEMO_TOKEN ?? crypto.randomUUID();

app.get("/api/infer", async (c) => {
  const sid = c.req.header("X-PAYMENT-STREAM");
  if (!sid) {
    c.header("X-PAYMENT-REQUIRED", Buffer.from(JSON.stringify(terms())).toString("base64"));
    push("402", "agent hit /api/infer without payment -> 402 Payment Required with stream terms");
    return c.json(terms(), 402);
  }
  if (!/^\d{1,78}$/.test(sid)) return c.json({ error: "bad stream id" }, 400);   // L-4
  const id = BigInt(sid);
  const s = await readStream(id).catch(() => null);
  if (!s) return c.json({ error: "cannot verify stream (RPC)" }, 503);           // M-2 fail closed
  // H-2: caller must prove it is the stream's payer
  const sig = c.req.header("X-PAYMENT-SIG") as `0x${string}` | undefined;
  const owner = !!sig && (await verifyMessage({ address: s.payer, message: `x402-stream:${ESCROW.toLowerCase()}:${sid}`, signature: sig }).catch(() => false));
  if (!owner) { push("reject", `stream #${sid}: missing/invalid payer signature`); return c.json({ error: "stream not owned by caller" }, 402); }
  if (sessions.has(sid)) return c.json({ error: "stream already in use" }, 409);
  if (!s.active || s.payee.toLowerCase() !== PAYEE.toLowerCase() || s.rate < RATE || s.deposit < RATE * 10n) {  // L-2 minDeposit
    push("reject", `stream ${sid} not acceptable (active=${s.active})`);
    return c.json({ error: "stream not funded/active", ...terms() }, 402);
  }
  push("verify", `stream #${sid} verified on-chain + payer signature: deposit ${formatEther(s.deposit)} MON @ ${formatEther(s.rate)} MON/s`);
  current = { id: sid, ratePerSec: formatEther(s.rate), deposit: formatEther(s.deposit), start: s.start * 1000, tokens: 0 };
  const words = "the agent is renting inference by the second and every token you see is metered against a live on chain escrow on monad when the agent stops the meter stops and the unused deposit goes straight back".split(" ");
  if (process.env.PAYEE_KEY && !claimScheduled.has(sid)) {
    claimScheduled.add(sid);
    setTimeout(async () => {   // provider claims accrued earnings mid-stream
      try {
        const h = await wallet(process.env.PAYEE_KEY!).writeContract({ address: ESCROW, abi, functionName: "claim", args: [id], gas: 120000n });
        const r = await pub.waitForTransactionReceipt({ hash: h });
        push("claim", `provider claimed accrued earnings mid-stream (${r.status})`, txUrl(h));
      } catch (e: any) { push("claim", "claim failed: " + (e.shortMessage ?? "error")); }
    }, 5000);
  }
  sessions.add(sid);
  const endAt = s.start * 1000 + Number((s.deposit * 1000n) / s.rate);   // local exhaustion bound (L-2)
  return streamSSE(c, async (st) => {
    try {
      let i = 0, lastCheck = 0, fails = 0;
      let aborted = false;
      st.onAbort(() => { aborted = true; });
      while (!aborted) {
        if (Date.now() >= endAt) {
          push("cutoff", `stream #${sid} balance exhausted -> service cut off`);
          await st.writeSSE({ event: "cutoff", data: "exhausted" }); break;
        }
        if (Date.now() - lastCheck > 1000) {
          lastCheck = Date.now();
          const live = await readStream(id).catch(() => null);
          fails = live ? 0 : fails + 1;
          if (fails >= 3) { push("cutoff", `stream #${sid} unverifiable (RPC) -> cut off`); await st.writeSSE({ event: "cutoff", data: "unverifiable" }); break; }
          if (live && !live.active) {
            push("cutoff", `stream #${sid} ${live.stoppedAt ? "closed by payer" : "balance exhausted"} -> service cut off`);
            await st.writeSSE({ event: "cutoff", data: live.stoppedAt ? "closed" : "exhausted" });
            break;
          }
        }
        await st.writeSSE({ event: "token", data: words[i++ % words.length] });
        if (current?.id === sid) current.tokens++;
        await st.sleep(200);
      }
      if (current?.id === sid) current.stopped = Date.now();
    } finally { sessions.delete(sid); }
  });
});

app.post("/api/log", async (c) => {           // agent reports its own tx hashes; token-protected (M-3)
  if (c.req.header("x-demo-token") !== DEMO_TOKEN) return c.json({ ok: false }, 403);
  const b = await c.req.json().catch(() => ({}));
  const hash = /^0x[0-9a-fA-F]{64}$/.test(b.hash ?? "") ? b.hash : undefined;
  const kind = String(b.kind ?? "").slice(0, 16);
  push(kind, String(b.msg ?? "").slice(0, 300), hash && txUrl(hash));
  if (kind === "close" && current) current.stopped = Date.now();
  return c.json({ ok: true });
});
app.get("/api/state", (c) => c.json({ escrow: ESCROW, escrowUrl: addrUrl(ESCROW), rate: formatEther(RATE), current, log: log.slice(-40) }));

let running = false, lastRun = 0;
const COOLDOWN_MS = Number(process.env.RUN_COOLDOWN_MS ?? 30_000);
app.post("/api/run-agent", (c) => {
  if (running) return c.json({ ok: false, msg: "agent already running" });
  if (Date.now() - lastRun < COOLDOWN_MS) return c.json({ ok: false, msg: `cooling down, try again in ${Math.ceil((COOLDOWN_MS - (Date.now() - lastRun)) / 1000)}s` });
  running = true; lastRun = Date.now(); log.length = 0; current = null;
  const { PAYEE_KEY: _drop, ...childEnv } = process.env;     // L-1: payer process never sees payee key
  const p = Bun.spawn(["bun", "src/agent.ts"], { env: { ...childEnv, DEMO_TOKEN, SERVER: `http://localhost:${PORT}` }, stdout: "inherit", stderr: "inherit" });
  p.exited.then(() => { running = false; });
  return c.json({ ok: true });
});

export default { port: PORT, fetch: app.fetch, idleTimeout: 120 };
console.log(`streampay-402 server on :${PORT}, escrow ${ESCROW}`);
