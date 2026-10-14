import { describe, expect, test } from "bun:test";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildPaymentPayload,
  clientPaymentHeaders,
  paymentRequirements,
  streamProofMessage,
  type StreamView,
} from "@streampay-402/protocol";
import { createGate } from "../src/gate";

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
    resourceUrl: "http://localhost/api/work",
    description: "work",
  });
}

function view(overrides: Partial<StreamView> = {}): StreamView {
  return {
    payer: account.address,
    payee,
    rate: 1000n,
    deposit: 10_000n,
    start: 1_700_000_000,
    stoppedAt: 0,
    active: true,
    ...overrides,
  };
}

async function proofHeaders(streamId = 4n) {
  const signature = await account.signMessage({ message: streamProofMessage(escrow, streamId) });
  return clientPaymentHeaders(buildPaymentPayload({ accepted: terms(), streamId, signature }));
}

describe("createGate", () => {
  test("402 with both payment headers when no proof is attached", async () => {
    const gate = createGate({ readStream: async () => view() });
    const decision = await gate.decide({ getHeader: () => undefined, terms: terms(), resourceUrl: "http://localhost/api/work" });
    expect(decision.type).toBe("payment-required");
    if (decision.type !== "payment-required") return;
    expect(decision.status).toBe(402);
    expect(decision.headers["PAYMENT-REQUIRED"]).toBe(decision.headers["X-PAYMENT-REQUIRED"]);
    expect(decision.body.accepts[0]?.extra.paymentFlow).toBe("escrow");
    expect(decision.body.accepts[0]?.ratePerSec).toBe("1000");
  });

  test("accepts a signed PAYMENT-SIGNATURE and the legacy headers", async () => {
    const headers = await proofHeaders();
    const gate = createGate({ readStream: async () => view() });
    const fromPayload = await gate.decide({
      getHeader: (name) => name === "PAYMENT-SIGNATURE" ? headers["PAYMENT-SIGNATURE"] : undefined,
      terms: terms(),
      resourceUrl: "http://localhost/api/work",
    });
    expect(fromPayload.type).toBe("accept");
    const fromLegacy = await gate.decide({
      getHeader: (name) => name === "PAYMENT-SIGNATURE" ? undefined : headers[name],
      terms: terms(),
      resourceUrl: "http://localhost/api/work",
    });
    expect(fromLegacy.type).toBe("accept");
  });

  test("rejects a bad id, rpc failure, a foreign signature, an inactive stream, and a second session", async () => {
    const headers = await proofHeaders();
    const foreign = await privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d").signMessage({
      message: streamProofMessage(escrow, 4n),
    });

    const badId = createGate({ readStream: async () => view() });
    const bad = await badId.decide({
      getHeader: (name) => name === "X-PAYMENT-STREAM" ? "nope" : name === "X-PAYMENT-SIG" ? headers["X-PAYMENT-SIG"] : undefined,
      terms: terms(),
      resourceUrl: "http://localhost/api/work",
    });
    expect(bad.type).toBe("reject");
    if (bad.type === "reject") expect(bad.status).toBe(400);

    const down = createGate({ readStream: async () => null });
    const rpc = await down.decide({ getHeader: (name) => headers[name], terms: terms(), resourceUrl: "http://localhost/api/work" });
    expect(rpc.type).toBe("reject");
    if (rpc.type === "reject") expect(rpc.status).toBe(503);

    const stolen = createGate({ readStream: async () => view() });
    const notOwner = await stolen.decide({
      getHeader: (name) => name === "X-PAYMENT-STREAM" ? "4" : name === "X-PAYMENT-SIG" ? foreign : undefined,
      terms: terms(),
      resourceUrl: "http://localhost/api/work",
    });
    expect(notOwner.type).toBe("reject");
    if (notOwner.type === "reject") expect(notOwner.status).toBe(402);

    const inactive = createGate({ readStream: async () => view({ active: false, stoppedAt: 10 }) });
    const closed = await inactive.decide({ getHeader: (name) => headers[name], terms: terms(), resourceUrl: "http://localhost/api/work" });
    expect(closed.type).toBe("reject");
    if (closed.type === "reject") expect(closed.body.error).toBe("stream not funded/active for this service");

    const live = createGate({ readStream: async () => view() });
    expect(live.tryHold("4")).toBe(true);
    const busy = await live.decide({ getHeader: (name) => headers[name], terms: terms(), resourceUrl: "http://localhost/api/work" });
    expect(busy.type).toBe("reject");
    if (busy.type === "reject") expect(busy.status).toBe(409);
  });
});
