import { beforeEach, describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import {
  accruedWei,
  applyEnvPolicy,
  beginSession,
  endSession,
  getLimits,
  ledgerSnapshot,
  parseLimits,
  policyBlock,
  resetPolicyStateForTests,
  setPolicy,
  viewPolicy,
} from "./policy";

const PAYER = "0x00000000000000000000000000000000000000a1";
const OTHER = "0x00000000000000000000000000000000000000a2";
const RATE = parseEther("0.001");
const DEPOSIT = RATE * 30n;
const START = 1_700_000_000;

function open(over: Partial<Parameters<typeof beginSession>[0]> = {}) {
  return beginSession({
    serviceId: "7",
    payer: PAYER,
    streamId: "1",
    rate: RATE,
    deposit: DEPOSIT,
    startSec: START,
    nowMs: START * 1000,
    ...over,
  });
}

beforeEach(() => {
  resetPolicyStateForTests();
  delete process.env.POLICY_MAX_TOTAL_SPEND;
  delete process.env.POLICY_MAX_RATE_PER_SEC;
  delete process.env.POLICY_MAX_SESSION_SECONDS;
  delete process.env.POLICY_SERVICE_ID;
});

describe("parseLimits", () => {
  test("parses decimal MON and whole seconds", () => {
    const parsed = parseLimits({ maxTotalSpend: "0.05", maxRatePerSec: "0.001", maxSessionDuration: 30 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.limits.maxTotalSpend).toBe(parseEther("0.05"));
    expect(parsed.limits.maxRatePerSec).toBe(parseEther("0.001"));
    expect(parsed.limits.maxSessionDuration).toBe(30);
  });

  test("omitted fields are unlimited", () => {
    const parsed = parseLimits({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.limits).toEqual({ maxTotalSpend: null, maxRatePerSec: null, maxSessionDuration: null });
  });

  test("rejects non-decimal amounts and fractional seconds", () => {
    expect(parseLimits({ maxTotalSpend: 0.05 }).ok).toBe(false);
    expect(parseLimits({ maxRatePerSec: "1e-3" }).ok).toBe(false);
    expect(parseLimits({ maxSessionDuration: 1.5 }).ok).toBe(false);
    expect(parseLimits({ maxSessionDuration: 0 }).ok).toBe(false);
  });
});

describe("beginSession", () => {
  test("no policy lets the stream through and tracks nothing", () => {
    const opened = open();
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.grant.spendCap).toBeNull();
    expect(opened.grant.durationCap).toBeNull();
    endSession(opened.grant.sessionKey, RATE);
    expect(ledgerSnapshot({ kind: "key", serviceId: "7" }).spent).toBe(0n);
  });

  test("rejects a rate above the stricter of the key and agent caps", () => {
    setPolicy({ kind: "key", serviceId: "7" }, { maxTotalSpend: null, maxRatePerSec: parseEther("0.01"), maxSessionDuration: null });
    setPolicy({ kind: "agent", serviceId: "7", agent: PAYER as `0x${string}` }, { maxTotalSpend: null, maxRatePerSec: parseEther("0.0005"), maxSessionDuration: null });
    const opened = open();
    expect(opened).toEqual({ ok: false, status: 402, error: "rate exceeds session policy" });
    expect(ledgerSnapshot({ kind: "key", serviceId: "7" }).reserved).toBe(0n);
  });

  test("cuts off at the session duration", () => {
    setPolicy({ kind: "key", serviceId: "7" }, { maxTotalSpend: null, maxRatePerSec: null, maxSessionDuration: 2 });
    const opened = open();
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(policyBlock(opened.grant, START * 1000 + 1999)).toBeNull();
    expect(policyBlock(opened.grant, (START + 2) * 1000)).toBe("policy-duration");
    expect(accruedWei(RATE, DEPOSIT, START, (START + 2) * 1000)).toBe(RATE * 2n);
  });

  test("reserves total spend so a second stream cannot pass the cap", () => {
    setPolicy({ kind: "key", serviceId: "7" }, { maxTotalSpend: RATE * 2n, maxRatePerSec: null, maxSessionDuration: null });
    const first = open();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.grant.spendCap).toBe(RATE * 2n);
    const second = open({ streamId: "2" });
    expect(second).toEqual({ ok: false, status: 402, error: "spend cap exceeded" });
    expect(policyBlock(first.grant, (START + 2) * 1000)).toBe("policy-spend");
    endSession(first.grant.sessionKey, RATE);
    expect(ledgerSnapshot({ kind: "key", serviceId: "7" })).toEqual({ spent: RATE, reserved: 0n });
    const third = open({ streamId: "3", deposit: RATE });
    expect(third.ok).toBe(true);
    const fourth = open({ streamId: "4", deposit: RATE });
    expect(fourth.ok).toBe(false);
  });

  test("agent cap does not apply to another payer or service", () => {
    setPolicy({ kind: "agent", serviceId: "7", agent: PAYER as `0x${string}` }, { maxTotalSpend: RATE, maxRatePerSec: null, maxSessionDuration: null });
    expect(open({ payer: OTHER, deposit: DEPOSIT }).ok).toBe(true);
    expect(open({ serviceId: "8", streamId: "9", deposit: DEPOSIT }).ok).toBe(true);
  });

  test("clearing limits keeps spend already booked", () => {
    setPolicy({ kind: "key", serviceId: "7" }, { maxTotalSpend: RATE * 5n, maxRatePerSec: null, maxSessionDuration: null });
    const opened = open({ deposit: RATE });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    endSession(opened.grant.sessionKey, RATE);
    setPolicy({ kind: "key", serviceId: "7" }, { maxTotalSpend: null, maxRatePerSec: null, maxSessionDuration: null });
    expect(getLimits({ kind: "key", serviceId: "7" })).toBeNull();
    expect(viewPolicy({ kind: "key", serviceId: "7" }).spent).toBe(RATE.toString());
  });

  test("rejects a stream that has already run past the duration", () => {
    setPolicy({ kind: "key", serviceId: "7" }, { maxTotalSpend: null, maxRatePerSec: null, maxSessionDuration: 2 });
    const opened = open({ nowMs: (START + 3) * 1000 });
    expect(opened).toEqual({ ok: false, status: 402, error: "session duration exceeded" });
  });
});

describe("applyEnvPolicy", () => {
  test("loads a key policy for the service id", () => {
    process.env.POLICY_MAX_TOTAL_SPEND = "0.02";
    process.env.POLICY_MAX_SESSION_SECONDS = "15";
    applyEnvPolicy("4");
    const limits = getLimits({ kind: "key", serviceId: "4" });
    expect(limits?.maxTotalSpend).toBe(parseEther("0.02"));
    expect(limits?.maxSessionDuration).toBe(15);
    expect(limits?.maxRatePerSec).toBeNull();
  });
});
