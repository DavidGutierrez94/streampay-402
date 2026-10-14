import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CLOSE_GAS,
  OPEN_GAS,
  streamEscrowAbi,
  streamProofMessage,
} from "@streampay-402/protocol";

export interface OpenedStream {
  hash: Hash;
  streamId: bigint;
}

export interface ClosedStream {
  hash: Hash;
  paidToPayee: bigint;
  refunded: bigint;
}

/** Chain calls the buyer SDK needs. Tests inject this; production uses viem. */
export interface EscrowConnection {
  open(args: { payee: Address; ratePerSec: bigint; value: bigint }): Promise<OpenedStream>;
  close(streamId: bigint): Promise<ClosedStream>;
  signProof(streamId: bigint): Promise<Hex>;
}

export interface ViemConnectionOptions {
  escrow: Address;
  chain: Chain;
  privateKey?: Hex;
  account?: Account;
  transport?: Transport;
  publicClient?: PublicClient;
  walletClient?: WalletClient;
}

export function createViemConnection(options: ViemConnectionOptions): EscrowConnection {
  const escrow = getAddress(options.escrow);
  const account = options.account ?? (options.privateKey ? privateKeyToAccount(options.privateKey) : undefined);
  if (!account && !options.walletClient) throw new Error("pass account, privateKey, or walletClient");
  const transport = options.transport ?? http();
  const publicClient = options.publicClient ?? createPublicClient({ chain: options.chain, transport });
  const walletClient = options.walletClient ?? createWalletClient({
    account: account!,
    chain: options.chain,
    transport,
  });
  const signer = account ?? walletClient.account;
  if (!signer) throw new Error("wallet client has no account");

  return {
    async open({ payee, ratePerSec, value }) {
      const hash = await walletClient.writeContract({
        address: escrow,
        abi: streamEscrowAbi,
        functionName: "open",
        args: [payee, ratePerSec],
        value,
        gas: OPEN_GAS,
        account: signer,
        chain: options.chain,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`open reverted ${hash}`);
      const opened = parseEventLogs({ abi: streamEscrowAbi, logs: receipt.logs, eventName: "Opened" })[0];
      if (!opened) throw new Error(`open receipt missing Opened event ${hash}`);
      return { hash, streamId: opened.args.id };
    },
    async close(streamId) {
      const hash = await walletClient.writeContract({
        address: escrow,
        abi: streamEscrowAbi,
        functionName: "close",
        args: [streamId],
        gas: CLOSE_GAS,
        account: signer,
        chain: options.chain,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`close reverted ${hash}`);
      const closed = parseEventLogs({ abi: streamEscrowAbi, logs: receipt.logs, eventName: "Closed" })[0];
      if (!closed) throw new Error(`close receipt missing Closed event ${hash}`);
      return { hash, paidToPayee: closed.args.paidToPayee, refunded: closed.args.refunded };
    },
    signProof(streamId) {
      return walletClient.signMessage({
        account: signer,
        message: streamProofMessage(escrow, streamId),
      });
    },
  };
}
