import { describe, expect, test } from "bun:test";
import {
  HEADER_REQUIRED,
  NATIVE_ASSET,
  PAYMENT_FLOW,
  SCHEME,
  X402_VERSION,
  buildPaymentPayload,
  clientPaymentHeaders,
  decodeBase64Json,
  encodeBase64Json,
  normalizePaymentRequired,
  paymentRequired,
  paymentRequiredHeaders,
  paymentRequirements,
  readPaymentProof,
  selectStreamRequirement,
  streamProofMessage,
} from "../src/index";

const escrow = "0x1111111111111111111111111111111111111111";
const payee = "0x2222222222222222222222222222222222222222";

function terms() {
  return paymentRequirements({
    payTo: payee,
    escrow,
    ratePerSec: 10n ** 15n,
    chainId: 10143,
    resourceUrl: "https://example.test/api/work",
    description: "gpu session",
    serviceName: "gpu",
    publishableKey: "pk_test_2",
  });
}

describe("stream-per-second requirements", () => {
  test("matches the x402 v2 envelope and keeps the v1 field aliases", () => {
    const required = paymentRequired(terms(), "https://example.test/api/work");
    expect(required.x402Version).toBe(X402_VERSION);
    expect(required.resource.url).toBe("https://example.test/api/work");
    expect(required.resource.mimeType).toBe("text/event-stream");
    expect(required.resource.serviceName).toBe("gpu");
    const accept = required.accepts[0];
    expect(accept?.scheme).toBe(SCHEME);
    expect(accept?.network).toBe("eip155:10143");
    expect(accept?.asset).toBe(NATIVE_ASSET);
    expect(accept?.amount).toBe((10n ** 15n * 10n).toString());
    expect(accept?.payTo).toBe(payee);
    expect(accept?.maxTimeoutSeconds).toBe(120);
    expect(accept?.extra.paymentFlow).toBe(PAYMENT_FLOW);
    expect(accept?.extra.assetTransferMethod).toBe("stream-escrow");
    expect(accept?.extra.ratePerSec).toBe(accept?.ratePerSec);
    expect(accept?.extra.minDeposit).toBe(accept?.minDeposit);
    expect(accept?.extra.escrow).toBe(escrow);
    expect(accept?.extra.publishableKey).toBe("pk_test_2");
  });

  test("round-trips PAYMENT-REQUIRED", () => {
    const required = paymentRequired(terms(), "https://example.test/api/work");
    const headers = paymentRequiredHeaders(required);
    expect(decodeBase64Json(headers[HEADER_REQUIRED] ?? "")).toEqual(required);
    expect(headers["X-PAYMENT-REQUIRED"]).toBe(headers[HEADER_REQUIRED]);
  });

  test("normalizes the v1 demo body", () => {
    const normalized = normalizePaymentRequired({
      x402Version: 1,
      accepts: [{
        scheme: "stream-per-second",
        network: "eip155:10143",
        asset: "native:MON",
        payTo: payee,
        escrow,
        ratePerSec: "1000",
        minDeposit: "10000",
        resource: "/api/infer",
        description: "demo",
      }],
    }, "http://localhost/api/infer");
    const accept = selectStreamRequirement(normalized);
    expect(normalized.x402Version).toBe(2);
    expect(accept.asset).toBe(NATIVE_ASSET);
    expect(accept.amount).toBe("10000");
    expect(accept.extra.paymentFlow).toBe("escrow");
    expect(accept.extra.ratePerSec).toBe("1000");
    expect(accept.extra.escrow).toBe(escrow);
    expect(normalized.resource.url).toBe("http://localhost/api/infer");
  });

  test("ignores other schemes and rejects a body with none of ours", () => {
    const mixed = normalizePaymentRequired({
      x402Version: 2,
      resource: { url: "https://example.test/x" },
      accepts: [
        { scheme: "exact", network: "eip155:8453", amount: "1", asset: NATIVE_ASSET, payTo: payee, maxTimeoutSeconds: 60 },
        terms(),
      ],
    });
    expect(mixed.accepts).toHaveLength(1);
    expect(mixed.accepts[0]?.scheme).toBe(SCHEME);
    expect(() => normalizePaymentRequired({ x402Version: 2, accepts: [{ scheme: "exact" }] })).toThrow(/stream-per-second/);
  });

  test("payment payload proves the stream id", () => {
    const signature = `0x${"ab".repeat(65)}` as const;
    const payload = buildPaymentPayload({ accepted: terms(), streamId: 7n, signature });
    const headers = clientPaymentHeaders(payload);
    expect(streamProofMessage(escrow, 7n)).toBe(`x402-stream:${escrow}:7`);
    expect(headers["X-PAYMENT-STREAM"]).toBe("7");
    expect(headers["X-PAYMENT-SIG"]).toBe(signature);
    const proof = readPaymentProof((name) => headers[name]);
    expect(proof).toEqual({ ok: true, streamId: "7", signature });
    expect(readPaymentProof(() => undefined)).toEqual({ ok: false, reason: "absent" });
    expect(readPaymentProof((name) => name === "PAYMENT-SIGNATURE" ? encodeBase64Json({ payload: {} }) : undefined))
      .toEqual({ ok: false, reason: "invalid_payload" });
  });
});
