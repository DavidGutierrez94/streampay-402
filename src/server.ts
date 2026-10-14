// x402-style paid endpoint metered per second against an on-chain StreamEscrow.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { parseEther, formatEther, parseEventLogs, verifyMessage } from "viem";
import { readWeb, readWebText, type WebName } from "./assets";
import { pub, abi, txUrl, addrUrl, CHAIN_ID, wallet } from "./chain";
import { runProviderClaim } from "./claim";
import { defer, sleep } from "./defer";
import { runDemoAgent } from "./demo-agent";
import { serveMetered } from "./meter";
import { accruedWei, applyEnvPolicy, beginSession, endSession, inferServiceId, policyBlock, publicPolicy } from "./policy";
import { conservationReceipt, settlementReceipt, type Receipt } from "./receipt";
import { registry } from "./registry";
import { getStore, type DemoStream, type StoredReceipt } from "./store";
import { applyEnvWebhook, emitStreamEvent, streamPayload } from "./webhooks";

const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}`;
const PAYEE = process.env.PAYEE_ADDRESS as `0x${string}`;
const RATE = parseEther(process.env.RATE_PER_SEC ?? "0.001"); // MON per second
const PORT = Number(process.env.PORT ?? 4020);
const LOCK_TTL_SEC = 90;
const RUN_TTL_SEC = 300; // matches the Vercel maxDuration; a crashed run releases the gate
const DASH_TTL_SEC = 20;

const push = async (kind: string, msg: string, link?: string) => {
  console.log(`[${kind}] ${msg} ${link ?? ""}`);
  await getStore().pushEvent(link ? { t: Date.now(), kind, msg, link } : { t: Date.now(), kind, msg });
  if (kind === "close") await getStore().markCurrentStopped();
};

const terms = async () => {
  const policy = await publicPolicy({ kind: "key", serviceId: inferServiceId() });
  return {
    x402Version: 1,
    accepts: [{
      scheme: "stream-per-second",
      network: `eip155:${CHAIN_ID}`,
      asset: "native:MON",
      payTo: PAYEE,
      escrow: ESCROW,
      ratePerSec: RATE.toString(),
      minDeposit: (RATE * 10n).toString(),
      resource: "/api/infer",
      description: "LLM-style token stream, billed per second of session time",
      extra: {
        open: "StreamEscrow.open(payee, ratePerSec) payable", proofHeader: "X-PAYMENT-STREAM: <streamId>",
        ...(policy ? { policy } : {}),
      },
    }],
  };
};

async function readStream(id: bigint) {
  const s = (await pub.readContract({ address: ESCROW, abi, functionName: "streams", args: [id] })) as any[];
  const [active, owed] = await Promise.all([
    pub.readContract({ address: ESCROW, abi, functionName: "isActive", args: [id] }) as Promise<boolean>,
    pub.readContract({ address: ESCROW, abi, functionName: "owed", args: [id] }) as Promise<bigint>,
  ]);
  return { payer: s[0], payee: s[1], rate: s[2] as bigint, deposit: s[3] as bigint, start: Number(s[4]), stoppedAt: Number(s[5]), active, owed };
}

const errText = (e: unknown, fallback: string) => {
  if (typeof e === "object" && e !== null && "shortMessage" in e && typeof e.shortMessage === "string" && e.shortMessage) return e.shortMessage;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
};

function asReceipt(stored: StoredReceipt): Receipt {
  return { ...stored, tx: stored.tx as `0x${string}` };
}

// One provider claim per stream id, on this request, then a stream.claimed webhook.
async function claimOnce(id: bigint, sid: string, meta: { payer: string; rate: bigint; deposit: bigint }) {
  const key = process.env.PAYEE_KEY;
  if (!key) return;
  if (!await getStore().tryMarkClaimed(sid)) return;
  try {
    const result = await runProviderClaim({
      serviceId: inferServiceId(),
      streamId: id,
      payee: PAYEE,
      claimKey: key,
      meta: { payer: meta.payer, ratePerSec: meta.rate, deposit: meta.deposit },
    });
    if (result?.status === "success") await push("claim", `provider claimed accrued earnings mid-stream (${formatEther(result.amount)} MON)`, txUrl(result.hash));
    else await push("claim", "claim failed");
  } catch (e: unknown) {
    await push("claim", "claim failed: " + errText(e, "error"));
  }
}

function sseHeaders(c: { header: (name: string, value: string) => void }) {
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");
}

export const app = new Hono();
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
    description: "Pay only for the time you actually use: watch an AI agent open an escrow stream on Monad testnet, stop it whenever you want, and get a receipt for the seconds used, the amount paid, and the unused escrow refunded." },
  dashboard: { path: "/dashboard", title: "Dashboard · Services, streams, and payouts · StreamPay-402",
    description: "Pay only for the time you actually use: see the services, active and closed streams, claimed earnings, and payouts for the wallet you signed in with. Read on Monad testnet." },
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
const page = (file: WebName, key: string) => async (c: any) => {
  const m = PAGES[key];
  if (!m) throw new Error("unknown page");
  return c.html((await readWebText(file)).replace("<!--SEO-->", headTags(baseUrl(c), m)));
};
const asset = (name: WebName, contentType: string) => async () =>
  new Response(await readWeb(name), { headers: { "content-type": contentType, "cache-control": "public, max-age=86400" } });
app.get("/og.png", asset("og.png", "image/png"));
app.get("/favicon.png", asset("favicon.png", "image/png"));
app.get("/apple-touch-icon.png", asset("apple-touch-icon.png", "image/png"));
app.get("/favicon.ico", asset("favicon.ico", "image/x-icon"));
app.get("/robots.txt", (c) => c.text(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${baseUrl(c)}/sitemap.xml\n`));
app.get("/sitemap.xml", (c) => {
  const b = baseUrl(c), d = new Date().toISOString().slice(0, 10);
  const urls = Object.values(PAGES).map((m) => `<url><loc>${b}${m.path}</loc><lastmod>${d}</lastmod><priority>${m.path === "/" ? "1.0" : "0.8"}</priority></url>`).join("");
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, 200, { "content-type": "application/xml" });
});
app.get("/", page("landing.html", "landing"));
app.get("/demo", page("index.html", "demo"));
app.get("/theme.css", asset("theme.css", "text/css"));
app.route("/api/registry", registry);
app.get("/onboard", page("onboard.html", "onboard"));
app.get("/onboard.js", asset("onboard.js", "text/javascript"));
app.get("/dashboard", page("dashboard.html", "dashboard"));
app.get("/dashboard.js", asset("dashboard.js", "text/javascript"));
app.get("/api/dashboard/:address", async (c) => {
  const address = c.req.param("address").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return c.json({ error: "bad address" }, 400);
  const hit = await getStore().getDashboard(address);
  if (!hit) return c.body(null, 204);
  return c.json(hit);
});
app.put("/api/dashboard/:address", async (c) => {
  const address = c.req.param("address").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return c.json({ error: "bad address" }, 400);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || !("snapshot" in body)) return c.json({ error: "bad json" }, 400);
  await getStore().setDashboard(address, body, DASH_TTL_SEC);
  return c.json({ ok: true });
});
app.get("/api/svc/:id", async (c) => {
  const raw = c.req.param("id");
  const id = /^(?:pk_test_)?(\d{1,20})$/.exec(raw)?.[1];
  if (!id) return c.json({ error: "bad service id" }, 400);
  return serveMetered(c, BigInt(id));
});
app.get("/api/terms", async (c) => c.json(await terms()));

export const DEMO_TOKEN = process.env.DEMO_TOKEN ?? crypto.randomUUID();

app.get("/api/infer", async (c) => {
  const sid = c.req.header("X-PAYMENT-STREAM");
  const offered = await terms();
  if (!sid) {
    c.header("X-PAYMENT-REQUIRED", Buffer.from(JSON.stringify(offered)).toString("base64"));
    await push("402", "agent hit /api/infer without payment -> 402 Payment Required with stream terms");
    return c.json(offered, 402);
  }
  if (!/^\d{1,78}$/.test(sid)) return c.json({ error: "bad stream id" }, 400);
  const id = BigInt(sid);
  const s = await readStream(id).catch(() => null);
  if (!s) return c.json({ error: "cannot verify stream (RPC)" }, 503);
  const sig = c.req.header("X-PAYMENT-SIG") as `0x${string}` | undefined;
  const owner = !!sig && (await verifyMessage({ address: s.payer, message: `x402-stream:${ESCROW.toLowerCase()}:${sid}`, signature: sig }).catch(() => false));
  if (!owner) { await push("reject", `stream #${sid}: missing/invalid payer signature`); return c.json({ error: "stream not owned by caller" }, 402); }
  const lockName = `infer:${sid}`;
  const lock = await getStore().tryLock(lockName, LOCK_TTL_SEC);
  if (!lock) return c.json({ error: "stream already in use" }, 409);
  if (!s.active || s.payee.toLowerCase() !== PAYEE.toLowerCase() || s.rate < RATE || s.deposit < RATE * 10n) {
    await getStore().unlock(lockName, lock);
    await push("reject", `stream ${sid} not acceptable (active=${s.active})`);
    return c.json({ error: "stream not funded/active", ...offered }, 402);
  }
  const opened = await beginSession({
    serviceId: inferServiceId(), payer: s.payer, streamId: sid, rate: s.rate, deposit: s.deposit, startSec: s.start, nowMs: Date.now(),
  });
  if (!opened.ok) {
    await getStore().unlock(lockName, lock);
    await push("reject", `stream #${sid}: ${opened.error}`);
    return c.json({ error: opened.error, ...offered }, opened.status);
  }
  const base: DemoStream = { id: sid, ratePerSec: formatEther(s.rate), deposit: formatEther(s.deposit), start: s.start * 1000, tokens: 0 };
  try {
    await push("verify", `stream #${sid} verified on-chain + payer signature: deposit ${formatEther(s.deposit)} MON @ ${formatEther(s.rate)} MON/s`);
    await getStore().setCurrent(base);
  } catch (err) {
    await getStore().unlock(lockName, lock);
    throw err;
  }
  const grant = opened.grant;
  const hookBase = { streamId: sid, payer: s.payer, payee: s.payee, ratePerSec: s.rate, deposit: s.deposit };
  emitStreamEvent(inferServiceId(), { type: "stream.opened", data: streamPayload(hookBase) });
  const words = "the agent is renting inference by the second and every token you see is metered against a live on chain escrow on monad when the agent stops the meter stops and the unused deposit goes straight back".split(" ");
  const endAt = s.start * 1000 + Number((s.deposit * 1000n) / s.rate);
  sseHeaders(c);
  let settled = false;
  const finish = async (reason: string) => {
    if (settled) return;
    settled = true;
    const at = Date.now();
    const actual = accruedWei(s.rate, s.deposit, s.start, at);
    await endSession(grant.sessionKey, actual);
    emitStreamEvent(inferServiceId(), {
      type: "stream.closed",
      data: streamPayload(hookBase, { amount: actual.toString(), reason, elapsedSeconds: Math.max(0, Math.floor(at / 1000) - s.start) }),
    });
  };
  return streamSSE(c, async (st) => {
    let tokens = 0;
    let lastFlush = Date.now();
    const claimAt = Date.now() + 5000;
    let claimP: Promise<void> | undefined;
    const flush = async (stopped?: number) => {
      lastFlush = Date.now();
      const next: DemoStream = stopped === undefined ? { ...base, tokens } : { ...base, tokens, stopped };
      try { await getStore().updateCurrent(sid, next); } catch (e: unknown) { console.log("[state]", errText(e, "current write failed")); }
    };
    const armClaim = () => {
      if (claimP || !process.env.PAYEE_KEY) return;
      const delay = Math.max(0, claimAt - Date.now());
      claimP = sleep(delay).then(() => claimOnce(id, sid, { payer: s.payer, rate: s.rate, deposit: s.deposit }));
    };
    let reason = "ended";
    try {
      let i = 0, lastCheck = 0, fails = 0;
      let aborted = false;
      st.onAbort(() => { aborted = true; reason = "aborted"; });
      while (!aborted) {
        if (Date.now() >= claimAt) armClaim();
        const policyReason = policyBlock(grant, Date.now());
        if (policyReason) {
          reason = policyReason;
          await push("cutoff", `stream #${sid} ${policyReason} -> service cut off`);
          await st.writeSSE({ event: "cutoff", data: policyReason });
          break;
        }
        if (Date.now() >= endAt) {
          reason = "exhausted";
          await push("cutoff", `stream #${sid} balance exhausted -> service cut off`);
          await st.writeSSE({ event: "cutoff", data: "exhausted" });
          break;
        }
        if (Date.now() - lastCheck > 1000) {
          lastCheck = Date.now();
          if (!await getStore().refreshLock(lockName, lock, LOCK_TTL_SEC)) {
            reason = "lock";
            await push("cutoff", `stream #${sid} session lock lost -> service cut off`);
            await st.writeSSE({ event: "cutoff", data: "lock" });
            break;
          }
          const live = await readStream(id).catch(() => null);
          fails = live ? 0 : fails + 1;
          if (fails >= 3) {
            reason = "unverifiable";
            await push("cutoff", `stream #${sid} unverifiable (RPC) -> cut off`);
            await st.writeSSE({ event: "cutoff", data: "unverifiable" });
            break;
          }
          if (live && !live.active) {
            reason = live.stoppedAt ? "closed" : "exhausted";
            await push("cutoff", `stream #${sid} ${live.stoppedAt ? "closed by payer" : "balance exhausted"} -> service cut off`);
            await st.writeSSE({ event: "cutoff", data: reason });
            break;
          }
        }
        await st.writeSSE({ event: "token", data: words[i++ % words.length] ?? "" });
        tokens++;
        if (Date.now() - lastFlush >= 400) await flush();
        await st.sleep(200);
      }
    } finally {
      try {
        armClaim();
        if (claimP) await claimP;
        await flush(Date.now());
        await finish(reason);
      } finally {
        await getStore().unlock(lockName, lock);
      }
    }
  });
});

function receiptFromClose(hash: `0x${string}`, logs: any, stoppedAt: bigint, snap: { rate: bigint; deposit: bigint; start: number }): Receipt | null {
  const ev = parseEventLogs({ abi, logs, eventName: "Closed" })[0] as
    | { args: { paidToPayee: bigint; refunded: bigint } }
    | undefined;
  if (!ev || snap.start <= 0) return null;
  const common = {
    deposit: snap.deposit,
    start: BigInt(snap.start),
    stoppedAt,
    refunded: ev.args.refunded,
    tx: hash,
    chainId: CHAIN_ID,
  };
  return settlementReceipt({ ...common, ratePerSec: snap.rate, paidToPayee: ev.args.paidToPayee })
    ?? conservationReceipt(common);
}

async function receiptFromTx(hash: `0x${string}`): Promise<Receipt | null> {
  const cr = await pub.getTransactionReceipt({ hash });
  if (cr.status !== "success") return null;
  const ev = parseEventLogs({ abi, logs: cr.logs, eventName: "Closed" })[0] as { args: { id: bigint } } | undefined;
  if (!ev) return null;
  const block = await pub.getBlock({ blockNumber: cr.blockNumber });
  let s = await readStream(ev.args.id).catch(() => null);
  for (let i = 0; s && !s.stoppedAt && i < 4; i++) {
    await sleep(400);
    s = await readStream(ev.args.id).catch(() => null);
  }
  if (!s) return null;
  const stoppedAt = s.stoppedAt ? BigInt(s.stoppedAt) : block.timestamp;
  return receiptFromClose(hash, cr.logs, stoppedAt, s);
}

async function publishReceipt(built: Receipt) {
  await getStore().setReceipt(built);
  await getStore().markCurrentStopped();
  const log = await getStore().recentEvents(40);
  if (!log.some((e) => e.kind === "close")) {
    await push("close", `closed: paid ${built.paid} MON to provider, refunded ${built.refunded} MON instantly`, built.txUrl);
  }
}

app.post("/api/log", async (c) => {
  if (c.req.header("x-demo-token") !== DEMO_TOKEN) return c.json({ ok: false }, 403);
  const b = await c.req.json().catch(() => ({}));
  const hash = /^0x[0-9a-fA-F]{64}$/.test(b.hash ?? "") ? b.hash as `0x${string}` : undefined;
  const kind = String(b.kind ?? "").slice(0, 16);
  await push(kind, String(b.msg ?? "").slice(0, 300), hash && txUrl(hash));
  if (kind === "close" && hash && !await getStore().getReceipt()) {
    const built = await receiptFromTx(hash).catch(() => null);
    if (built) await getStore().setReceipt(built);
  }
  return c.json({ ok: true });
});
app.get("/api/state", async (c) => {
  const stored = await getStore().getReceipt();
  return c.json({
    escrow: ESCROW,
    escrowUrl: addrUrl(ESCROW),
    rate: formatEther(RATE),
    current: await getStore().getCurrent(),
    running: await getStore().isRunning(),
    receipt: stored ? asReceipt(stored) : null,
    log: await getStore().recentEvents(40),
  });
});

async function closeActiveStream(): Promise<Receipt | null> {
  const current = await getStore().getCurrent();
  if (!current || current.stopped || !process.env.PAYER_KEY || !ESCROW) return null;
  const id = BigInt(current.id);
  const before = await readStream(id).catch(() => null);
  if (!before || before.stoppedAt) return null;
  const hash = await wallet(process.env.PAYER_KEY).writeContract({
    address: ESCROW, abi, functionName: "close", args: [id], gas: 200000n,
  });
  const cr = await pub.waitForTransactionReceipt({ hash });
  if (cr.status !== "success") return null;
  const block = await pub.getBlock({ blockNumber: cr.blockNumber });
  return receiptFromClose(hash, cr.logs, block.timestamp, before);
}

let stopWait: Promise<Receipt | null> | null = null;

async function performStop(): Promise<Receipt | null> {
  const current = await getStore().getCurrent();
  const willClose = !!(current && !current.stopped && process.env.PAYER_KEY);
  await getStore().setAgentStop({ stop: true, closing: willClose });
  const deadline = Date.now() + 45_000;
  let triedClose = false;
  try {
    while (Date.now() < deadline) {
      const stored = await getStore().getReceipt();
      if (stored) return asReceipt(stored);
      if (!triedClose && willClose) {
        triedClose = true;
        try {
          const built = await closeActiveStream();
          if (built) { await publishReceipt(built); return built; }
        } catch (e) {
          console.log("[stop] close failed", errText(e, "close failed").slice(0, 180));
        }
      }
      const live = await getStore().getCurrent();
      if (!await getStore().isRunning() && !live) return null;
      await sleep(200);
    }
    const stored = await getStore().getReceipt();
    return stored ? asReceipt(stored) : null;
  } finally {
    const flags = await getStore().getAgentStop();
    await getStore().setAgentStop({ stop: flags.stop, closing: false });
  }
}

app.get("/api/agent-stop", async (c) => c.json(await getStore().getAgentStop()));

const COOLDOWN_MS = Number(process.env.RUN_COOLDOWN_MS ?? 30_000);
app.post("/api/run-agent", async (c) => {
  const gate = await getStore().tryStartRun(COOLDOWN_MS, RUN_TTL_SEC);
  if (!gate.ok) return c.json({ ok: false, msg: gate.msg });
  await getStore().clearDemo();
  const job = runDemoAgent(app, async (kind, msg, hash) => {
    await push(kind, msg, hash ? txUrl(hash) : undefined);
    if (kind === "close" && hash && /^0x[0-9a-fA-F]{64}$/.test(hash) && !await getStore().getReceipt()) {
      const built = await receiptFromTx(hash as `0x${string}`).catch(() => null);
      if (built) await getStore().setReceipt(built);
    }
  }).catch((err: unknown) => push("error", errText(err, "agent failed").slice(0, 300)))
    .finally(() => getStore().finishRun());
  defer(job);
  return c.json({ ok: true });
});

app.post("/api/stop-agent", async (c) => {
  const stored = await getStore().getReceipt();
  if (stored) return c.json({ ok: true, receipt: asReceipt(stored) });
  const current = await getStore().getCurrent();
  if (!await getStore().isRunning() && !current) return c.json({ ok: false, msg: "No active stream" }, 409);
  if (!stopWait) stopWait = performStop().finally(() => { stopWait = null; });
  const built = await stopWait;
  const latest = await getStore().getReceipt();
  if (built || latest) return c.json({ ok: true, receipt: built ?? (latest ? asReceipt(latest) : null) });
  const running = await getStore().isRunning();
  return c.json({ ok: false, msg: running ? "Close is still confirming" : "Agent stopped before a stream was open" }, running ? 504 : 409);
});

void applyEnvPolicy();
void applyEnvWebhook();

export default { port: PORT, fetch: app.fetch, idleTimeout: 120 };
const launchedAsServer = (process.argv[1] ?? "").endsWith("server.ts") || (process.argv[1] ?? "").endsWith("server.js");
if (launchedAsServer) console.log(`streampay-402 server on :${PORT}, escrow ${ESCROW}`);
