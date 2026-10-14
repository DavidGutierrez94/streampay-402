import { createPublicClient, createWalletClient, http, defineChain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import artifact from "../contracts/out/StreamEscrow.sol/StreamEscrow.json";

export const RPC_URL = process.env.RPC_URL ?? "https://rpc.ankr.com/monad_testnet";
export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
export const EXPLORER = process.env.EXPLORER ?? (CHAIN_ID === 10143 ? "https://testnet.monadscan.com" : "");
export const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 10143 ? "Monad Testnet" : "Local",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
export const abi = artifact.abi as any;
export const bytecode = artifact.bytecode.object as Hex;
export const pub = createPublicClient({ chain, transport: http(RPC_URL) });
export const wallet = (key: string) =>
  createWalletClient({ account: privateKeyToAccount(key as Hex), chain, transport: http(RPC_URL) });
export const txUrl = (h: string) => (EXPLORER ? `${EXPLORER}/tx/${h}` : h);
export const addrUrl = (a: string) => (EXPLORER ? `${EXPLORER}/address/${a}` : a);
