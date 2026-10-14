import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resetClaimsForTests } from "./claim";
import { resetMeterSessionsForTests, serveMetered, type StreamView } from "./meter";
import { resetPolicyStateForTests, setPolicy } from "./policy";
import type { ServiceView } from "./registry";
import { flushWebhooks, resetWebhooksForTests, setWebhook, verifyWebhookSignature } from "./webhooks";

const ESCROW = "0x1111111111111111111111111111111111111111";
const payer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const payee = "0x00000000000000000000000000000000000000b0" as `0x${string}`;
const RATE = parseEther("0.001");
const START = 1_700_000_000;
const SECRET = "meter-webhook-secret";

let clock = START * 1000;
let reads = 0;
let activeFor = Number.POSITIVE_INFINITY;

function stream(over: Partial<StreamView> = {}): StreamView {
  const active = reads <= activeFor;
  return {
    payer: payer.address,
    payee,
    rate: RATE,
    deposit: RATE * 30n,
    start: START,
    stoppedAt: active ? 0 : START + 1,
    active,
    ...over,
  };
}

const svc: ServiceView = { owner: payee, payee, ratePerSec: RATE, active: true, name: "test" };

function app(extra: Parameters<typeof serveMetered>[3] = {}) {
  const h = new Hono();
  h.get("/paid", (c) => serveMetered(c, 7n, (i) => `w${i}`, {
    readService: async () => svc,
    readStream: async () => { reads += 1; return stream(); },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    tickMs: 1000,
    checkMs: 60_000,
    ...extra,
  }));
  return h;
}

async function paid(streamId = "1", h = app()) {
  const sig = await payer.signMessage({ message: `x402-stream:${ESCROW}:${streamId}` });
  return h.request("/paid", { headers: { "X-PAYMENT-STREAM": streamId, "X-PAYMENT-SIG": sig } });
}

beforeEach(async () => {
  process.env.ESCROW_ADDRESS = ESCROW;
  clock = START * 1000;
  reads = 0;
  activeFor = Number.POSITIVE_INFINITY;
  await resetPolicyStateForTests();
  await resetWebhooksForTests();
  await resetMeterSessionsForTests();
  resetClaimsForTests();
});

describe("serveMetered", () => {
  test("402 without a stream, then metered output that stops on the duration cap", async () => {
    const bare = await app().request("/paid");
    expect(bare.status).toBe(402);
    await setPolicy({ kind: "key", serviceId: "7" }, { maxTotalSpend: null, maxRatePerSec: null, maxSessionDuration: 2 });
    const res = await paid();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("data: w0");
    expect(body).toContain("data: w1");
    expect(body).toContain("data: policy-duration");
    expect(body).not.toContain("data: w2");
  });

  test("rejects a stream priced above the rate cap and does not open a webhook", async () => {
    const hits: string[] = [];
    await setPolicy({ kind: "key", serviceId: "7" }, { maxTotalSpend: null, maxRatePerSec: parseEther("0.0001"), maxSessionDuration: null });
    await setWebhook("7", { url: "https://hooks.example/streampay", secret: SECRET });
    const res = await paid("4", app({
      sleep: async () => {},
      claim: async () => { hits.push("claim"); return null; },
    }));
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "rate exceeds session policy" });
    await flushWebhooks();
    expect(hits).toEqual([]);
  });

  test("spend cap stops the stream and blocks a second one while the first is reserved", async () => {
    await setPolicy({ kind: "key", serviceId: "7" }, { maxTotalSpend: RATE * 2n, maxRatePerSec: null, maxSessionDuration: null });
    const firstApp = app();
    const res = await paid("11", firstApp);
    expect(res.status).toBe(200);
    const blocked = await paid("12", firstApp);
    expect(blocked.status).toBe(402);
    expect(await blocked.json()).toMatchObject({ error: "spend cap exceeded" });
    expect(await res.text()).toContain("data: policy-spend");
  });

  test("signs open, claim, and close webhooks for the service", async () => {
    const seen: { event: string; body: string; sig: string }[] = [];
    const receiver = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.text();
        seen.push({ event: req.headers.get("x-streampay-event") ?? "", body, sig: req.headers.get("x-streampay-signature") ?? "" });
        return new Response("ok");
      },
    });
    await setWebhook("7", { url: `http://127.0.0.1:${receiver.port}/hook`, secret: SECRET });
    activeFor = 1;
    try {
      const res = await paid("20", app({
        checkMs: 0,
        claim: async () => ({ hash: `0x${"cd".repeat(32)}`, amount: 7n, status: "success" as const }),
      }));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("data: closed");
      await flushWebhooks();
      const events = seen.map((hit) => hit.event).sort();
      expect(events).toEqual(["stream.claimed", "stream.closed", "stream.opened"]);
      for (const hit of seen) expect(verifyWebhookSignature(SECRET, hit.sig, hit.body, Math.floor(Date.now() / 1000))).toBe(true);
      const closed = seen.find((hit) => hit.event === "stream.closed");
      expect(JSON.parse(closed?.body ?? "{}")).toMatchObject({ type: "stream.closed", serviceId: "7", data: { streamId: "20", reason: "closed" } });
    } finally {
      receiver.stop();
    }
  });

  test("registry policy route requires a provider key", async () => {
    const { registry } = await import("./registry");
    const res = await registry.request("/policy");
    expect(res.status).toBe(401);
    const hook = await registry.request("/webhook", { method: "PUT", body: "{}" });
    expect(hook.status).toBe(401);
  });
});
