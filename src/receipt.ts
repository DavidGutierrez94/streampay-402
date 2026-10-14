// Stop-agent receipt: seconds used, amount paid, unused escrow refunded, Monad testnet tx link.
import { formatEther } from "viem";

export const MONAD_TESTNET_CHAIN_ID = 10143;
export const MONAD_TESTNET_EXPLORER = "https://testnet.monadscan.com";

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const MAX_SECONDS = 86_400n * 30n;

export type Receipt = {
  secondsUsed: number;
  paid: string;
  refunded: string;
  tx: `0x${string}`;
  txUrl: string;
  chainId: number;
};

/** Explorer URL for a close tx. Chain 10143 always uses the Monad testnet explorer. */
export function explorerTxUrl(chainId: number, tx: string): string | null {
  if (!TX_HASH.test(tx)) return null;
  if (chainId !== MONAD_TESTNET_CHAIN_ID) return null;
  return `${MONAD_TESTNET_EXPLORER}/tx/${tx}`;
}

export type CloseSettlement = {
  ratePerSec: bigint;
  deposit: bigint;
  start: bigint;
  stoppedAt: bigint;
  paidToPayee: bigint;
  refunded: bigint;
  tx: string;
  chainId: number;
};

/**
 * Receipt from a StreamEscrow close.
 * Amount paid is the total owed for elapsed seconds (deposit − refund), which
 * still holds when a mid-stream claim already paid part of it.
 * Refund must match the contract: deposit − min(deposit, rate × seconds).
 */
export function settlementReceipt(input: CloseSettlement): Receipt | null {
  const { ratePerSec, deposit, start, stoppedAt, paidToPayee, refunded, tx, chainId } = input;
  if (ratePerSec <= 0n || deposit <= 0n) return null;
  if (stoppedAt < start) return null;
  const seconds = stoppedAt - start;
  if (seconds > MAX_SECONDS) return null;
  const accrued = ratePerSec * seconds;
  const owed = accrued > deposit ? deposit : accrued;
  if (refunded !== deposit - owed) return null;
  if (paidToPayee < 0n || paidToPayee > owed) return null;
  return receiptFromTotals({ seconds, paid: owed, refunded, tx, chainId });
}

/** Same shape when the close event's refund is trusted but the rate cross-check is skipped. */
export function conservationReceipt(input: {
  deposit: bigint;
  start: bigint;
  stoppedAt: bigint;
  refunded: bigint;
  tx: string;
  chainId: number;
}): Receipt | null {
  const { deposit, start, stoppedAt, refunded, tx, chainId } = input;
  if (deposit < 0n || refunded < 0n || refunded > deposit) return null;
  if (stoppedAt < start) return null;
  const seconds = stoppedAt - start;
  if (seconds > MAX_SECONDS) return null;
  return receiptFromTotals({ seconds, paid: deposit - refunded, refunded, tx, chainId });
}

function receiptFromTotals(input: { seconds: bigint; paid: bigint; refunded: bigint; tx: string; chainId: number }): Receipt | null {
  const txUrl = explorerTxUrl(input.chainId, input.tx);
  if (!txUrl) return null;
  return {
    secondsUsed: Number(input.seconds),
    paid: formatEther(input.paid),
    refunded: formatEther(input.refunded),
    tx: input.tx as `0x${string}`,
    txUrl,
    chainId: input.chainId,
  };
}
