import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { getAddress, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  encodeBase64Json,
  paymentRequired,
  paymentRequirements,
  streamProofMessage,
  type StreamView,
} from "@streampay-402/protocol";
import { streamPay } from "../../provider/src/hono";
import type { EscrowConnection } from "../src/chain";
import { StreamPayClient } from "../src/client";

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const account = privateKeyToAccount(KEY);
const escrow = getAddress("0x1111111111111111111111111111111111111111");
const payee = getAddress("0x2222222222222222222222222222222222222222");

function terms() {
  return paymentRequirements({
    payTo: payee,
    escrow,
    ratePerSec: 1000n,
    chainId: 10143,
    resourceUrl: "http://localhost/work",
    description: "work",
  });
}

function connection(opened: { streamId: bigint } = { streamId: 8n }): EscrowConnection & { opens: number; closes: number } {
  const state = { opens: 0, closes: 0 };
  return {
    get opens() { return state.opens; },
    get closes() { return state.closes; },
    async open() {
      state.opens += 1;
      return { hash: `0x${"11".repeat(32)}` as Hash, streamId: opened.streamId };
    },
    async close() {
      state.closes += 1;
      return { hash: `0x${"22".repeat(32)}` as Hash, paidToPayee: 0n, refunded: 10_000n };
    },
    signProof(streamId) {
      return account.signMessage({ message: streamProofMessage(escrow, streamId) });
    },
  };
}

function requiredResponse(body: unknown, status = 402): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "PAYMENT-REQUIRED": encodeBase64Json(body) },
  });
}

describe("StreamPayClient", () => {
  test("opens on 402, retries a lagging 402, then closes", async () => {
    const link = connection();
    let calls = 0;
    const seen: Headers[] = [];
    const client = new StreamPayClient({
      escrow,
      connection: link,
      depositSeconds: 10,
      payRetries: 4,
      sleep: async () => {},
      fetch: async (_input, init) => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({
            x402Version: 1,
            accepts: [{
              scheme: "stream-per-second",
              network: "eip155:10143",
              asset: "native:MON",
              payTo: payee,
              escrow,
              ratePerSec: "1000",
              minDeposit: "10000",
              resource: "/work",
              description: "legacy",
            }],
          }), { status: 402, headers: { "content-type": "application/json" } });
        }
        const headers = new Headers(init?.headers);
        seen.push(headers);
        if (calls === 2) return requiredResponse(paymentRequired(terms(), "http://localhost/work"));
        return new Response("event: token\ndata: hi\n\n", { status: 200 });
      },
    });
    const { result, close } = await client.withStream("http://localhost/work", async (session) => {
      expect(session.streamId).toBe(8n);
      expect(session.deposit).toBe(10_000n);
      return session.response.text();
    });
    expect(result).toContain("event: token");
    expect(link.opens).toBe(1);
    expect(link.closes).toBe(1);
    expect(close.refunded).toBe(10_000n);
    expect(seen[1]?.get("X-PAYMENT-STREAM")).toBe("8");
    expect(seen[1]?.get("PAYMENT-SIGNATURE")).toBeTruthy();
  });

  test("does not open when the pinned escrow does not match, and still closes if the consumer throws", async () => {
    const link = connection();
    const client = new StreamPayClient({
      escrow,
      connection: link,
      fetch: async () => requiredResponse(paymentRequired(paymentRequirements({
        payTo: payee,
        escrow: "0x3333333333333333333333333333333333333333",
        ratePerSec: 1000n,
        chainId: 10143,
        resourceUrl: "http://localhost/work",
      }), "http://localhost/work")),
    });
    await expect(client.fetch("http://localhost/work")).rejects.toThrow(/untrusted escrow/);
    expect(link.opens).toBe(0);

    const paying = connection();
    let calls = 0;
    const buyer = new StreamPayClient({
      escrow,
      connection: paying,
      depositSeconds: 10,
      sleep: async () => {},
      fetch: async () => {
        calls += 1;
        if (calls === 1) return requiredResponse(paymentRequired(terms(), "http://localhost/work"));
        return new Response("ok", { status: 200 });
      },
    });
    await expect(buyer.withStream("http://localhost/work", async () => { throw new Error("stop"); })).rejects.toThrow(/stop/);
    expect(paying.opens).toBe(1);
    expect(paying.closes).toBe(1);
  });

  test("pays a hono provider and reads the metered cutoff", async () => {
    const rows = new Map<bigint, StreamView>();
    let next = 1n;
    const link: EscrowConnection = {
      async open({ payee: to, ratePerSec, value }) {
        const streamId = next++;
        rows.set(streamId, {
          payer: account.address,
          payee: to,
          rate: ratePerSec,
          deposit: value,
          start: 1,
          stoppedAt: 0,
          active: true,
        });
        return { hash: `0x${"ab".repeat(32)}` as Hash, streamId };
      },
      async close(streamId) {
        const row = rows.get(streamId);
        if (!row) throw new Error("missing");
        row.active = false;
        row.stoppedAt = 2;
        return { hash: `0x${"cd".repeat(32)}` as Hash, paidToPayee: 0n, refunded: row.deposit };
      },
      signProof: (streamId) => account.signMessage({ message: streamProofMessage(escrow, streamId) }),
    };
    const app = new Hono();
    app.get("/work", streamPay({ readStream: async (id) => rows.get(id) ?? null, terms: terms() }));
    const client = new StreamPayClient({
      escrow,
      connection: link,
      depositSeconds: 10,
      trustedPayees: [payee],
      fetch: async (input, init) => app.request(input, init),
    });
    const { result, close } = await client.withStream("http://localhost/work", async (session) => session.response.text());
    expect(result).toContain("cutoff");
    expect(close.streamId).toBe(1n);
    expect(close.refunded).toBe(10_000n);
    expect(rows.get(1n)?.active).toBe(false);
  });
});
