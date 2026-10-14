import {
  type Account,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { CLAIM_GAS, streamEscrowAbi } from "@streampay-402/protocol";

export async function claimStream(options: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  escrow: Address;
  streamId: bigint;
  account?: Account;
}): Promise<Hash> {
  const account = options.account ?? options.walletClient.account ?? undefined;
  if (!account) throw new Error("claimStream requires an account");
  const hash = await options.walletClient.writeContract({
    address: options.escrow,
    abi: streamEscrowAbi,
    functionName: "claim",
    args: [options.streamId],
    gas: CLAIM_GAS,
    account,
    chain: options.walletClient.chain ?? null,
  });
  const receipt = await options.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`claim reverted ${hash}`);
  return hash;
}
