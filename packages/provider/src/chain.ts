import { getAddress, type Address, type PublicClient } from "viem";
import { streamEscrowAbi, type StreamView } from "@streampay-402/protocol";

export type ReadStream = (id: bigint) => Promise<StreamView | null>;

type StreamTuple = readonly [
  payer: Address,
  payee: Address,
  ratePerSec: bigint,
  deposit: bigint,
  start: bigint,
  stoppedAt: bigint,
  claimed: bigint,
];

export function readOnchainStream(client: PublicClient, escrow: Address, id: bigint): Promise<StreamView | null> {
  const address = getAddress(escrow);
  return Promise.all([
    client.readContract({ address, abi: streamEscrowAbi, functionName: "streams", args: [id] }),
    client.readContract({ address, abi: streamEscrowAbi, functionName: "isActive", args: [id] }),
  ]).then(([stream, active]) => {
    const row = stream as unknown as StreamTuple;
    return {
      payer: row[0],
      payee: row[1],
      rate: row[2],
      deposit: row[3],
      start: Number(row[4]),
      stoppedAt: Number(row[5]),
      active,
    };
  }).catch(() => null);
}
