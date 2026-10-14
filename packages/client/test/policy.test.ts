import { describe, expect, test } from "bun:test";
import { getAddress, parseEther } from "viem";
import { paymentRequirements } from "@streampay-402/protocol";
import { PaymentPolicyError, planSpend } from "../src/policy";

const escrow = getAddress("0x1111111111111111111111111111111111111111");
const payee = getAddress("0x2222222222222222222222222222222222222222");
const other = getAddress("0x3333333333333333333333333333333333333333");

function terms(rate = parseEther("0.001")) {
  return paymentRequirements({
    payTo: payee,
    escrow,
    ratePerSec: rate,
    chainId: 10143,
    resourceUrl: "http://localhost/api/work",
  });
}

describe("planSpend", () => {
  test("deposits rate × seconds and at least the server minimum", () => {
    const plan = planSpend(terms(), { escrow, depositSeconds: 30 });
    expect(plan.deposit).toBe(parseEther("0.03"));
    expect(plan.rate).toBe(parseEther("0.001"));
    const raised = planSpend(terms(), { escrow, depositSeconds: 1 });
    expect(raised.deposit).toBe(parseEther("0.01"));
  });

  test("rejects a different escrow, an over-cap rate, an over-cap deposit, and an unknown payee", () => {
    expect(() => planSpend(terms(), { escrow: other })).toThrow(PaymentPolicyError);
    expect(() => planSpend(terms(), { escrow, maxRatePerSec: parseEther("0.0001") })).toThrow(/above cap/);
    expect(() => planSpend(terms(), { escrow, depositSeconds: 30, maxDeposit: parseEther("0.02") })).toThrow(/deposit/);
    expect(() => planSpend(terms(), { escrow, trustedPayees: [other] })).toThrow(/untrusted payee/);
  });
});
