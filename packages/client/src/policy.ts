import { getAddress, type Address } from "viem";
import {
  SchemeError,
  sameAddress,
  type PaymentRequirements,
} from "@streampay-402/protocol";

export class PaymentPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentPolicyError";
  }
}

export interface SpendPolicy {
  /** Pinned StreamEscrow. Terms that name any other contract are rejected. */
  escrow: Address;
  maxRatePerSec?: bigint;
  maxDeposit?: bigint;
  /** When set, payTo must be one of these addresses. */
  trustedPayees?: readonly Address[];
  /** Budget in seconds. Deposit is rate × this, raised to the server minimum. */
  depositSeconds?: number | bigint;
}

export interface SpendPlan {
  escrow: Address;
  payTo: Address;
  rate: bigint;
  minDeposit: bigint;
  deposit: bigint;
}

export function planSpend(terms: PaymentRequirements, policy: SpendPolicy): SpendPlan {
  let escrow: Address;
  let payTo: Address;
  try {
    escrow = getAddress(terms.extra.escrow);
    payTo = getAddress(terms.payTo);
  } catch {
    throw new SchemeError("invalid_payment_requirements", "escrow or payTo is not an address");
  }
  if (!sameAddress(escrow, policy.escrow)) {
    throw new PaymentPolicyError(`untrusted escrow ${escrow}`);
  }
  if (policy.trustedPayees && !policy.trustedPayees.some((allowed) => sameAddress(allowed, payTo))) {
    throw new PaymentPolicyError(`untrusted payee ${payTo}`);
  }
  const rate = BigInt(terms.extra.ratePerSec);
  const minDeposit = BigInt(terms.extra.minDeposit);
  if (rate <= 0n || minDeposit < rate) {
    throw new SchemeError("invalid_payment_requirements", "rate or minDeposit is not payable");
  }
  if (policy.maxRatePerSec !== undefined && rate > policy.maxRatePerSec) {
    throw new PaymentPolicyError(`rate ${rate} above cap ${policy.maxRatePerSec}`);
  }
  const seconds = policy.depositSeconds === undefined ? 30n : BigInt(policy.depositSeconds);
  if (seconds <= 0n) throw new PaymentPolicyError("depositSeconds must be positive");
  let deposit = rate * seconds;
  if (deposit < minDeposit) deposit = minDeposit;
  if (policy.maxDeposit !== undefined && deposit > policy.maxDeposit) {
    throw new PaymentPolicyError(`deposit ${deposit} above cap ${policy.maxDeposit}`);
  }
  return { escrow, payTo, rate, minDeposit, deposit };
}
