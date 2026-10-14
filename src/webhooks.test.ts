import { beforeEach, describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { runProviderClaim, type ClaimResult } from "./claim";
import {
  emitStreamEvent,
  flushWebhooks,
  resetWebhooksForTests,
  retryDelayMs,
  saveWebhookConfig,
  setWebhook,
  setWebhookDepsForTests,
  signWebhook,
  verifyWebhookSignature,
  viewWebhook,
  type StreamEventData,
} from "./webhooks";

const SECRET = "test-webhook-secret";
const NOW = 1_700_000_000;

const data = (): StreamEventData => ({
  streamId: "9",
  payer: "0x00000000000000000000000000000000000000a1",
  payee: "0x00000000000000000000000000000000000000b0",
  ratePerSec: parseEther("0.001").toString(),
  deposit: parseEther("0.03").toString(),
  amount: null,
  reason: null,
  elapsedSeconds: null,
  txHash: null,
});

beforeEach(async () => {
  await resetWebhooksForTests();
});

describe("signatures", () => {
  test("verifies the exact raw body and rejects tampering or a stale timestamp", () => {
    const body = JSON.stringify({ ok: true });
    const header = `t=${NOW},v1=${signWebhook(SECRET, NOW, body)}`;
    expect(verifyWebhookSignature(SECRET, header, body, NOW)).toBe(true);
    expect(verifyWebhookSignature(SECRET, header, body + " ", NOW)).toBe(false);
    expect(verifyWebhookSignature("other-webhook-secret", header, body, NOW)).toBe(false);
    expect(verifyWebhookSignature(SECRET, header, body, NOW + 301)).toBe(false);
    expect(verifyWebhookSignature(SECRET, "v1=abcd", body, NOW)).toBe(false);
  });
});

describe("delivery", () => {
  test("retries 5xx and network errors, then stops on success", async () => {
    const delays: number[] = [];
    const bodies: string[] = [];
    let calls = 0;
    await setWebhook("7", { url: "https://hooks.example/streampay", secret: SECRET, maxAttempts: 5 });
    setWebhookDepsForTests({
      nowSec: () => NOW,
      sleep: async (ms) => { delays.push(ms); },
      fetch: async (_url, init) => {
        calls += 1;
        bodies.push(String(init?.body));
        if (calls === 1) throw new Error("down");
        if (calls === 2) return new Response("busy", { status: 503 });
        const header = new Headers(init?.headers).get("x-streampay-signature");
        expect(verifyWebhookSignature(SECRET, header, String(init?.body), NOW)).toBe(true);
        expect(new Headers(init?.headers).get("x-streampay-event")).toBe("stream.opened");
        return new Response("ok", { status: 204 });
      },
    });
    emitStreamEvent("7", { type: "stream.opened", data: data() });
    await flushWebhooks();
    expect(calls).toBe(3);
    expect(delays).toEqual([retryDelayMs(0), retryDelayMs(1)]);
    expect(bodies[0]).toBe(bodies[2]);
  });

  test("does not retry a 4xx or a redirect", async () => {
    const calls: number[] = [];
    await setWebhook("7", { url: "https://hooks.example/streampay", secret: SECRET });
    await setWebhook("8", { url: "https://hooks.example/elsewhere", secret: SECRET });
    setWebhookDepsForTests({
      nowSec: () => NOW,
      sleep: async () => { throw new Error("should not sleep"); },
      fetch: async (url) => {
        const status = String(url).includes("elsewhere") ? 302 : 400;
        calls.push(status);
        return new Response("no", { status });
      },
    });
    emitStreamEvent("7", { type: "stream.closed", data: { ...data(), reason: "closed", amount: "1" } });
    emitStreamEvent("8", { type: "stream.opened", data: data() });
    await flushWebhooks();
    expect(calls).toEqual([400, 302]);
  });

  test("gives up after the configured attempts", async () => {
    let calls = 0;
    await setWebhook("7", { url: "https://hooks.example/streampay", secret: SECRET, maxAttempts: 3 });
    setWebhookDepsForTests({
      nowSec: () => NOW,
      sleep: async () => {},
      fetch: async () => {
        calls += 1;
        return new Response("no", { status: 500 });
      },
    });
    emitStreamEvent("7", { type: "stream.opened", data: data() });
    await flushWebhooks();
    expect(calls).toBe(3);
  });

  test("disabled config and a missing config do not send", async () => {
    let calls = 0;
    await setWebhook("7", { url: "https://hooks.example/streampay", secret: SECRET, enabled: false });
    setWebhookDepsForTests({
      nowSec: () => NOW,
      sleep: async () => {},
      fetch: async () => { calls += 1; return new Response("ok"); },
    });
    emitStreamEvent("7", { type: "stream.opened", data: data() });
    emitStreamEvent("8", { type: "stream.opened", data: data() });
    await flushWebhooks();
    expect(calls).toBe(0);
  });

  test("save config hides the secret and rejects link-local urls", async () => {
    const saved = await saveWebhookConfig("7", { url: "https://hooks.example/streampay", secret: SECRET, maxAttempts: 4 });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.view).toEqual({ configured: true, serviceId: "7", url: "https://hooks.example/streampay", enabled: true, maxAttempts: 4 });
    expect(JSON.stringify(saved.view).includes(SECRET)).toBe(false);
    expect((await viewWebhook("7")).configured).toBe(true);
    expect((await saveWebhookConfig("7", { url: "http://169.254.169.254/latest", secret: SECRET })).ok).toBe(false);
    expect((await saveWebhookConfig("7", { url: "https://hooks.example", secret: "short" })).ok).toBe(false);
    expect((await saveWebhookConfig("7", { url: "ftp://hooks.example", secret: SECRET })).ok).toBe(false);
  });
});

describe("claim webhook", () => {
  test("emits stream.claimed only when the claim pays out", async () => {
    const types: string[] = [];
    await setWebhook("7", { url: "https://hooks.example/streampay", secret: SECRET });
    setWebhookDepsForTests({
      nowSec: () => NOW,
      sleep: async () => {},
      fetch: async (_url, init) => {
        types.push(new Headers(init?.headers).get("x-streampay-event") ?? "");
        const body = JSON.parse(String(init?.body)) as { data: { amount: string; txHash: string } };
        expect(body.data.amount).toBe("5");
        expect(body.data.txHash).toBe(`0x${"ab".repeat(32)}`);
        return new Response("ok");
      },
    });
    const paid: ClaimResult = { hash: `0x${"ab".repeat(32)}`, amount: 5n, status: "success" };
    const meta = { payer: data().payer, ratePerSec: parseEther("0.001"), deposit: parseEther("0.03") };
    await runProviderClaim({ serviceId: "7", streamId: 9n, payee: data().payee, meta, perform: async () => paid });
    await runProviderClaim({
      serviceId: "7", streamId: 9n, payee: data().payee, meta,
      perform: async () => ({ hash: paid.hash, amount: 0n, status: "success" }),
    });
    await flushWebhooks();
    expect(types).toEqual(["stream.claimed"]);
  });
});
