import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildPaymentPayload,
  clientPaymentHeaders,
  decodeBase64Json,
  paymentRequirements,
  streamProofMessage,
  type PaymentRequired,
  type StreamView,
} from "@streampay-402/protocol";
import type { ExpressLikeResponse } from "../src/express";
import { expressStreamPay } from "../src/express";
import { fetchStreamPay } from "../src/fetch";
import { createGate } from "../src/gate";
import { streamPay } from "../src/hono";

const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const escrow = getAddress("0x1111111111111111111111111111111111111111");
const payee = getAddress("0x2222222222222222222222222222222222222222");

function terms() {
  return paymentRequirements({
    payTo: payee,
    escrow,
    ratePerSec: 1000n,
    chainId: 10143,
    resourceUrl: "http://localhost/work",
    serviceName: "work",
    description: "metered work",
  });
}

function view(): StreamView {
  return {
    payer: account.address,
    payee,
    rate: 1000n,
    deposit: 10_000n,
    start: 1,
    stoppedAt: 0,
    active: true,
  };
}

async function legacyHeaders(streamId = 9n) {
  const signature = await account.signMessage({ message: streamProofMessage(escrow, streamId) });
  return clientPaymentHeaders(buildPaymentPayload({ accepted: terms(), streamId, signature }));
}

describe("http adapters", () => {
  test("hono returns 402 terms, then a cutoff once the deposit is already spent", async () => {
    const app = new Hono();
    app.get("/work", streamPay({
      readStream: async () => view(),
      terms: terms(),
      produce: (index) => `chunk-${index}`,
    }));
    const unpaid = await app.request("http://localhost/work");
    expect(unpaid.status).toBe(402);
    const body = await unpaid.json() as PaymentRequired;
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0]?.scheme).toBe("stream-per-second");
    expect(body.resource.serviceName).toBe("work");
    const encoded = unpaid.headers.get("PAYMENT-REQUIRED");
    expect(encoded).toBeTruthy();
    expect(decodeBase64Json(encoded ?? "")).toEqual(body);
    expect(unpaid.headers.get("X-PAYMENT-REQUIRED")).toBe(encoded);

    const paid = await app.request("http://localhost/work", { headers: await legacyHeaders() });
    expect(paid.status).toBe(200);
    expect(paid.headers.get("content-type")).toContain("text/event-stream");
    expect(await paid.text()).toContain("event: cutoff\ndata: exhausted");
  });

  test("fetch and express adapters accept PAYMENT-SIGNATURE", async () => {
    const headers = await legacyHeaders(3n);
    const signature = headers["PAYMENT-SIGNATURE"];
    if (!signature) throw new Error("missing payload header");
    const handler = fetchStreamPay({ readStream: async () => view(), terms: terms() });
    const unpaid = await handler(new Request("http://localhost/work"));
    expect(unpaid.status).toBe(402);
    const paid = await handler(new Request("http://localhost/work", { headers: { "PAYMENT-SIGNATURE": signature } }));
    expect(paid.status).toBe(200);
    expect(await paid.text()).toContain("cutoff");

    const expressHeaders = await legacyHeaders(5n);
    const chunks: string[] = [];
    let status = 0;
    const jsonBody: { body?: unknown } = {};
    const res: ExpressLikeResponse = {
      setHeader() {},
      status(code) { status = code; return this; },
      json(body) { jsonBody.body = body; },
      write(chunk) { chunks.push(chunk); },
      end() {},
    };
    const middleware = expressStreamPay({
      gate: createGate({ readStream: async () => view() }),
      terms: () => terms(),
    });
    await middleware({ url: "/work", headers: {}, header: () => undefined }, res);
    expect(status).toBe(402);
    expect((jsonBody.body as PaymentRequired).accepts[0]?.extra.paymentFlow).toBe("escrow");

    chunks.length = 0;
    await middleware({
      url: "/work",
      headers: { "x-payment-stream": expressHeaders["X-PAYMENT-STREAM"] ?? "", "x-payment-sig": expressHeaders["X-PAYMENT-SIG"] ?? "" },
    }, res);
    expect(res.statusCode).toBe(200);
    expect(chunks.join("")).toContain("event: cutoff");
  });
});
