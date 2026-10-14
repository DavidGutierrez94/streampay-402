// One provider claim per stream, then a stream.claimed webhook when MON actually moves.
import { parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { abi, pub, wallet } from "./chain";
import { emitStreamEvent, streamPayload } from "./webhooks";

export type ClaimResult = { hash: Hex; amount: bigint; status: "success" | "reverted" };

const scheduled = new Set<string>();

export function resetClaimsForTests(): void {
  scheduled.clear();
}

function escrow(): `0x${string}` {
  const address = process.env.ESCROW_ADDRESS;
  if (!address) throw new Error("ESCROW_ADDRESS is not set");
  return address as `0x${string}`;
}

export async function claimOnchain(streamId: bigint, claimKey: string): Promise<ClaimResult> {
  const hash = await wallet(claimKey).writeContract({
    address: escrow(),
    abi,
    functionName: "claim",
    args: [streamId],
    gas: 120_000n,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  let amount = 0n;
  for (const ev of parseEventLogs({ abi, logs: receipt.logs, eventName: "Claimed" })) {
    amount = (ev.args as { amount: bigint }).amount;
    break;
  }
  return { hash, amount, status: receipt.status };
}

export async function runProviderClaim(opts: {
  serviceId: string;
  streamId: bigint;
  payee: string;
  claimKey?: string;
  meta: { payer: string; ratePerSec: bigint; deposit: bigint };
  perform?: (streamId: bigint) => Promise<ClaimResult | null>;
}): Promise<ClaimResult | null> {
  try {
    if (!opts.perform) {
      if (!opts.claimKey) return null;
      const account = privateKeyToAccount(opts.claimKey as Hex);
      if (account.address.toLowerCase() !== opts.payee.toLowerCase()) {
        console.log("[claim] signing key does not match stream payee");
        return null;
      }
    }
    const perform = opts.perform ?? ((id: bigint) => claimOnchain(id, opts.claimKey!));
    const result = await perform(opts.streamId);
    if (!result || result.status !== "success" || result.amount === 0n) return result;
    emitStreamEvent(opts.serviceId, {
      type: "stream.claimed",
      data: streamPayload(
        { streamId: opts.streamId.toString(), payer: opts.meta.payer, payee: opts.payee, ratePerSec: opts.meta.ratePerSec, deposit: opts.meta.deposit },
        { amount: result.amount.toString(), txHash: result.hash },
      ),
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "claim failed";
    console.log(`[claim] ${message}`);
    return null;
  }
}

export function scheduleProviderClaim(opts: {
  serviceId: string;
  streamId: bigint;
  payee: string;
  claimKey?: string;
  delayMs?: number;
  meta: { payer: string; ratePerSec: bigint; deposit: bigint };
  perform?: (streamId: bigint) => Promise<ClaimResult | null>;
  onResult?: (result: ClaimResult | null) => void;
}): void {
  const key = `${opts.serviceId}:${opts.streamId}`;
  if (scheduled.has(key)) return;
  scheduled.add(key);
  const run = () => {
    void runProviderClaim(opts).then((result) => opts.onResult?.(result));
  };
  const delay = opts.delayMs ?? 5_000;
  if (delay <= 0) {
    run();
    return;
  }
  const timer = setTimeout(run, delay);
  if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
}
