import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseEther } from "viem";
import { conservationReceipt, explorerTxUrl, MONAD_TESTNET_CHAIN_ID, MONAD_TESTNET_EXPLORER, settlementReceipt } from "./receipt.ts";

const TX = "0x74135092040817f4d1f82037045790f3e47795c5489f6d35fea9cd1448c78dfe" as const;
const RATE = parseEther("0.001");
const DEPOSIT = parseEther("0.06");

describe("settlementReceipt", () => {
  test("12s at 0.001 MON/s against a 0.06 deposit", () => {
    const receipt = settlementReceipt({
      ratePerSec: RATE,
      deposit: DEPOSIT,
      start: 1_000n,
      stoppedAt: 1_012n,
      paidToPayee: parseEther("0.012"),
      refunded: parseEther("0.048"),
      tx: TX,
      chainId: MONAD_TESTNET_CHAIN_ID,
    });
    expect(receipt).toEqual({
      secondsUsed: 12,
      paid: "0.012",
      refunded: "0.048",
      tx: TX,
      txUrl: `${MONAD_TESTNET_EXPLORER}/tx/${TX}`,
      chainId: 10143,
    });
    expect(parseEther(receipt!.paid) + parseEther(receipt!.refunded)).toBe(DEPOSIT);
  });

  test("amount paid is the full session cost when part was already claimed", () => {
    const receipt = settlementReceipt({
      ratePerSec: RATE,
      deposit: DEPOSIT,
      start: 50n,
      stoppedAt: 62n,
      paidToPayee: parseEther("0.007"),
      refunded: parseEther("0.048"),
      tx: TX,
      chainId: 10143,
    });
    expect(receipt?.paid).toBe("0.012");
    expect(receipt?.refunded).toBe("0.048");
    expect(receipt?.secondsUsed).toBe(12);
  });

  test("same-block close refunds the whole deposit", () => {
    const receipt = settlementReceipt({
      ratePerSec: RATE,
      deposit: DEPOSIT,
      start: 10n,
      stoppedAt: 10n,
      paidToPayee: 0n,
      refunded: DEPOSIT,
      tx: TX,
      chainId: 10143,
    });
    expect(receipt).toMatchObject({ secondsUsed: 0, paid: "0", refunded: "0.06" });
  });

  test("rejects a refund that does not match rate × seconds", () => {
    expect(settlementReceipt({
      ratePerSec: RATE,
      deposit: DEPOSIT,
      start: 1_000n,
      stoppedAt: 1_012n,
      paidToPayee: parseEther("0.012"),
      refunded: parseEther("0.04"),
      tx: TX,
      chainId: 10143,
    })).toBeNull();
  });

  test("rejects a close leg larger than the amount owed", () => {
    expect(settlementReceipt({
      ratePerSec: RATE,
      deposit: DEPOSIT,
      start: 1_000n,
      stoppedAt: 1_012n,
      paidToPayee: parseEther("0.02"),
      refunded: parseEther("0.048"),
      tx: TX,
      chainId: 10143,
    })).toBeNull();
  });

  test("rejects a stopped timestamp before start and a bad tx", () => {
    expect(settlementReceipt({
      ratePerSec: RATE,
      deposit: DEPOSIT,
      start: 20n,
      stoppedAt: 19n,
      paidToPayee: 0n,
      refunded: DEPOSIT,
      tx: TX,
      chainId: 10143,
    })).toBeNull();
    expect(explorerTxUrl(10143, "0x1234")).toBeNull();
    expect(explorerTxUrl(1, TX)).toBeNull();
  });
});

describe("conservationReceipt", () => {
  test("paid plus refund equals the deposit", () => {
    const receipt = conservationReceipt({
      deposit: DEPOSIT,
      start: 5n,
      stoppedAt: 9n,
      refunded: parseEther("0.056"),
      tx: TX,
      chainId: 10143,
    });
    expect(receipt).toMatchObject({
      secondsUsed: 4,
      paid: "0.004",
      refunded: "0.056",
      txUrl: `https://testnet.monadscan.com/tx/${TX}`,
      chainId: 10143,
    });
  });

  test("rejects a refund above the deposit", () => {
    expect(conservationReceipt({
      deposit: DEPOSIT,
      start: 5n,
      stoppedAt: 9n,
      refunded: DEPOSIT + 1n,
      tx: TX,
      chainId: 10143,
    })).toBeNull();
  });
});

describe("demo page", () => {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");

  test("has a prominent stop control and a receipt", () => {
    expect(html).toContain('id="stop"');
    expect(html).toContain(">Stop agent<");
    expect(html).toContain('id="receipt"');
    expect(html).toContain("Seconds used");
    expect(html).toContain("Amount paid");
    expect(html).toContain("Unused escrow refunded");
    expect(html).toContain("/api/stop-agent");
    expect(html).toContain("https://testnet.monadscan.com/tx/");
    expect(html).toContain("chainId !== 10143");
    expect(html).toContain(".btn.stop");
    expect(html).toContain("#e8461e");
    expect(html).toContain("@media (max-width:640px)");
  });

  test("visible copy does not name third-party vendors", () => {
    expect(visible).not.toMatch(/privy|stripe|viem|hono|monadscan|ankr|foundry|bun\b/i);
  });
});
