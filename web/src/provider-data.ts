// Onchain reads for the provider dashboard. Monad testnet chainId 10143.
// The public RPC rejects eth_getLogs spans over ~100 blocks, so payout
// transactions are located from each stream's timestamps, then scanned in short chunks.
import {
  BaseError,
  createPublicClient,
  decodeEventLog,
  defineChain,
  http,
  isAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { monadTestnet } from "viem/chains";

export const MONAD_TESTNET_RPC = "https://rpc-testnet.monadinfra.com";
export const MONAD_TESTNET_ID = 10143;
export const DEFAULT_REGISTRY = "0xdaeddd6a68bbea02c58dd0349797e8847c3fa797" as const;
export const DEFAULT_ESCROW = "0x51ff24a504b2f7446df1767fea43063d7dd525eb" as const;
/** StreamEscrow v2 deploy block on Monad testnet. */
export const ESCROW_DEPLOY_BLOCK = 70834278n;
export const EXPLORER = "https://testnet.monadscan.com";
const ZERO = "0x0000000000000000000000000000000000000000";
const LOG_CHUNK = 80n;
const MAX_LOG_CHUNKS = 24;

const registryAbi = [
  {
    type: "function",
    name: "servicesOf",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "service",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          { name: "payee", type: "address" },
          { name: "ratePerSec", type: "uint128" },
          { name: "keyHash", type: "bytes32" },
          { name: "active", type: "bool" },
          { name: "name", type: "string" },
        ],
      },
    ],
  },
] as const;

const escrowAbi = [
  {
    type: "function",
    name: "nextId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "credit",
    stateMutability: "view",
    inputs: [{ name: "payee", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "streams",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "payer", type: "address" },
      { name: "payee", type: "address" },
      { name: "ratePerSec", type: "uint128" },
      { name: "deposit", type: "uint128" },
      { name: "start", type: "uint64" },
      { name: "stoppedAt", type: "uint64" },
      { name: "claimed", type: "uint128" },
    ],
  },
  {
    type: "event",
    name: "Opened",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "payee", type: "address", indexed: true },
      { name: "ratePerSec", type: "uint256", indexed: false },
      { name: "deposit", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Closed",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "by", type: "address", indexed: true },
      { name: "paidToPayee", type: "uint256", indexed: false },
      { name: "refunded", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Credited",
    inputs: [
      { name: "payee", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdrawn",
    inputs: [
      { name: "payee", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

export type ServiceRow = {
  id: bigint;
  name: string;
  owner: Address;
  payee: Address;
  ratePerSec: bigint;
  active: boolean;
};

export type StreamRow = {
  id: bigint;
  payer: Address;
  payee: Address;
  ratePerSec: bigint;
  deposit: bigint;
  start: bigint;
  stoppedAt: bigint;
  claimed: bigint;
};

export type PayoutKind = "claim" | "close" | "credit" | "withdraw";

export type Payout = {
  kind: PayoutKind;
  streamId: bigint | null;
  amount: bigint;
  tx: Hex | null;
  blockNumber: bigint;
  time: bigint;
};

export type ProviderSnapshot = {
  address: Address;
  balance: bigint;
  blockNumber: bigint;
  blockTime: bigint;
  services: ServiceRow[];
  streams: StreamRow[];
  /** Pull-payment balance still sitting in escrow for this wallet and its service payees. */
  credit: bigint;
};

export type Activity = {
  payouts: Payout[];
  openTx: Record<string, Hex>;
  closeTx: Record<string, Hex>;
  truncated: boolean;
};

export function makeClient(chainId: number, rpc?: string | null): PublicClient {
  if (chainId === MONAD_TESTNET_ID) {
    return createPublicClient({ chain: monadTestnet, transport: http(MONAD_TESTNET_RPC) });
  }
  const url = rpc && rpc.length > 0 ? rpc : "http://127.0.0.1:8545";
  const chain = defineChain({
    id: chainId,
    name: "Local",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  return createPublicClient({ chain, transport: http(url) });
}

export function asAddress(value: string | null | undefined, fallback: Address): Address {
  return value && isAddress(value) ? value : fallback;
}

export function formatMon(wei: bigint, digits = 6): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, digits).replace(/0+$/, "");
  const s = frac ? `${whole}.${frac}` : whole.toString();
  return neg ? `-${s}` : s;
}

export function shortId(value: string): string {
  if (value.length < 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function owedAt(s: Pick<StreamRow, "ratePerSec" | "deposit" | "start" | "stoppedAt">, now: bigint): bigint {
  const end = s.stoppedAt === 0n ? now : s.stoppedAt;
  if (end <= s.start) return 0n;
  const accrued = s.ratePerSec * (end - s.start);
  return accrued > s.deposit ? s.deposit : accrued;
}

export function streamStatus(s: StreamRow, now: bigint): "active" | "exhausted" | "closed" {
  if (s.stoppedAt !== 0n) return "closed";
  return owedAt(s, now) < s.deposit ? "active" : "exhausted";
}

function isRevert(e: unknown): boolean {
  return e instanceof BaseError && /reverted/i.test(e.shortMessage);
}

function errorText(e: unknown): string {
  if (e instanceof BaseError) return `${e.shortMessage} ${e.message} ${e.details ?? ""}`;
  return e instanceof Error ? e.message : String(e);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let wait = 300;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const text = errorText(e);
      const retry = /rate|429|timeout|temporar/i.test(text);
      if (!retry || attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
  }
  throw new Error("retry exhausted");
}

function sameAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

async function serviceIdsOf(client: PublicClient, registry: Address, owner: Address): Promise<bigint[]> {
  const ids: bigint[] = [];
  for (let i = 0n; i < 200n; i++) {
    try {
      const id = await client.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "servicesOf",
        args: [owner, i],
      });
      ids.push(id);
    } catch (e) {
      if (isRevert(e)) break;
      throw e;
    }
  }
  return ids;
}

function readTuple<T>(raw: T | readonly unknown[]): T {
  return raw as T;
}

export async function loadProvider(
  client: PublicClient,
  wallet: Address,
  contracts: { registry: Address; escrow: Address },
): Promise<ProviderSnapshot> {
  const head = await client.getBlock();
  const blockNumber = head.number ?? 0n;
  const [balance, ids, nextId] = await Promise.all([
    client.getBalance({ address: wallet }),
    serviceIdsOf(client, contracts.registry, wallet),
    client.readContract({ address: contracts.escrow, abi: escrowAbi, functionName: "nextId" }),
  ]);

  const services: ServiceRow[] = [];
  if (ids.length > 0) {
    const rows = await client.multicall({
      allowFailure: false,
      contracts: ids.map((id) => ({
        address: contracts.registry,
        abi: registryAbi,
        functionName: "service" as const,
        args: [id] as const,
      })),
    });
    ids.forEach((id, i) => {
      const raw = rows[i];
      if (!raw) return;
      const s = readTuple(raw);
      services.push({
        id,
        name: s.name,
        owner: s.owner,
        payee: s.payee,
        ratePerSec: s.ratePerSec,
        active: s.active,
      });
    });
  }

  const payees = new Set<string>([wallet.toLowerCase()]);
  for (const s of services) {
    if (s.payee !== ZERO) payees.add(s.payee.toLowerCase());
  }

  const streams: StreamRow[] = [];
  const streamIds: bigint[] = [];
  for (let id = 1n; id < nextId; id++) streamIds.push(id);
  const SIZE = 80;
  for (let i = 0; i < streamIds.length; i += SIZE) {
    const slice = streamIds.slice(i, i + SIZE);
    const rows = await client.multicall({
      allowFailure: false,
      contracts: slice.map((id) => ({
        address: contracts.escrow,
        abi: escrowAbi,
        functionName: "streams" as const,
        args: [id] as const,
      })),
    });
    slice.forEach((id, j) => {
      const raw = rows[j];
      if (!raw) return;
      const payer = raw[0];
      const payee = raw[1];
      if (payer === ZERO || !payees.has(payee.toLowerCase())) return;
      streams.push({
        id,
        payer,
        payee,
        ratePerSec: raw[2],
        deposit: raw[3],
        start: raw[4],
        stoppedAt: raw[5],
        claimed: raw[6],
      });
    });
  }

  let credit = 0n;
  const payeeList = [...payees] as Address[];
  if (payeeList.length > 0) {
    const credits = await client.multicall({
      allowFailure: false,
      contracts: payeeList.map((payee) => ({
        address: contracts.escrow,
        abi: escrowAbi,
        functionName: "credit" as const,
        args: [payee] as const,
      })),
    });
    for (const amt of credits) credit += amt;
  }

  return { address: wallet, balance, blockNumber, blockTime: head.timestamp, services, streams, credit };
}

type Span = [bigint, bigint];

function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (!last || span[0] > last[1] + 1n) out.push([span[0], span[1]]);
    else if (span[1] > last[1]) last[1] = span[1];
  }
  return out;
}

async function blockAt(
  client: PublicClient,
  ts: bigint,
  deployN: bigint,
  deployT: bigint,
  headN: bigint,
  headT: bigint,
): Promise<bigint> {
  if (ts <= deployT) return deployN;
  if (ts >= headT) return headN;
  const ms = ((headT - deployT) * 1000n) / (headN - deployN || 1n);
  let est = deployN + ((ts - deployT) * 1000n) / (ms || 1n);
  if (est < deployN) est = deployN;
  if (est > headN) est = headN;
  const read = (n: bigint) => withRetry(() => client.getBlock({ blockNumber: n }));
  let b = await read(est);
  for (let i = 0; i < 4; i++) {
    const diff = b.timestamp - ts;
    if (diff > -2n && diff < 2n) break;
    let next = b.number! - (diff * 1000n) / (ms || 1n);
    if (next < deployN) next = deployN;
    if (next > headN) next = headN;
    if (next === b.number) break;
    b = await read(next);
  }
  let guard = 0;
  while (b.number! > deployN && b.timestamp >= ts && guard < 16) {
    const prev = await read(b.number! - 1n);
    if (prev.timestamp < ts) break;
    b = prev;
    guard++;
  }
  guard = 0;
  while (b.timestamp < ts && b.number! < headN && guard < 16) {
    b = await read(b.number! + 1n);
    guard++;
  }
  return b.number ?? est;
}

async function logsBetween(client: PublicClient, escrow: Address, from: bigint, to: bigint) {
  const out: Awaited<ReturnType<PublicClient["getLogs"]>> = [];
  for (let start = from; start <= to; start += LOG_CHUNK) {
    const end = start + LOG_CHUNK - 1n > to ? to : start + LOG_CHUNK - 1n;
    const chunk = await withRetry(() => client.getLogs({ address: escrow, fromBlock: start, toBlock: end }));
    out.push(...chunk);
  }
  return out;
}

function capSpans(spans: Span[]): { spans: Span[]; truncated: boolean } {
  let chunks = 0n;
  for (const [a, b] of spans) chunks += (b - a) / LOG_CHUNK + 1n;
  if (chunks <= BigInt(MAX_LOG_CHUNKS)) return { spans, truncated: false };
  const kept: Span[] = [];
  let left = BigInt(MAX_LOG_CHUNKS);
  for (let i = spans.length - 1; i >= 0 && left > 0n; i--) {
    const span = spans[i];
    if (!span) continue;
    const [a, b] = span;
    const need = (b - a) / LOG_CHUNK + 1n;
    if (need <= left) {
      kept.push([a, b]);
      left -= need;
    } else {
      const from = b - left * LOG_CHUNK + 1n;
      kept.push([from > a ? from : a, b]);
      left = 0n;
    }
  }
  return { spans: mergeSpans(kept), truncated: true };
}

/** Claim, close, credit, and withdraw transactions for the wallet's streams. */
export async function loadActivity(
  client: PublicClient,
  escrow: Address,
  streams: StreamRow[],
  payees: Address[],
): Promise<Activity> {
  const empty: Activity = { payouts: [], openTx: {}, closeTx: {}, truncated: false };
  if (streams.length === 0) return empty;
  const known = escrow.toLowerCase() === DEFAULT_ESCROW.toLowerCase();
  if (!known) {
    return {
      ...empty,
      payouts: streams
        .filter((s) => s.claimed > 0n)
        .map((s) => ({
          kind: "claim" as const,
          streamId: s.id,
          amount: s.claimed,
          tx: null,
          blockNumber: 0n,
          time: s.stoppedAt || s.start,
        })),
    };
  }

  const head = await client.getBlock();
  const headN = head.number ?? 0n;
  const deploy = await withRetry(() => client.getBlock({ blockNumber: ESCROW_DEPLOY_BLOCK }));
  const deployN = deploy.number ?? ESCROW_DEPLOY_BLOCK;
  const deployT = deploy.timestamp;
  const ours = new Set(streams.map((s) => s.id.toString()));
  const payeeSet = new Set(payees.map((p) => p.toLowerCase()));
  const spans: Span[] = [];
  let truncated = false;

  for (const s of streams) {
    const startB = await blockAt(client, s.start, deployN, deployT, headN, head.timestamp);
    const endTs = s.stoppedAt === 0n ? head.timestamp : s.stoppedAt;
    let endB = s.stoppedAt === 0n ? headN : await blockAt(client, endTs, deployN, deployT, headN, head.timestamp);
    if (endB < headN) endB = endB + 8n > headN ? headN : endB + 8n;
    if (endB < startB) endB = startB;
    const width = endB - startB;
    if (width / LOG_CHUNK + 1n > BigInt(MAX_LOG_CHUNKS)) {
      truncated = true;
      spans.push([startB, startB + LOG_CHUNK - 1n > headN ? headN : startB + LOG_CHUNK - 1n]);
      const recent = endB - BigInt(MAX_LOG_CHUNKS) * LOG_CHUNK;
      spans.push([recent > startB ? recent : startB, endB]);
    } else {
      spans.push([startB, endB]);
    }
  }

  const capped = capSpans(mergeSpans(spans));
  truncated = truncated || capped.truncated;
  const logs = [];
  for (const [from, to] of capped.spans) {
    logs.push(...(await logsBetween(client, escrow, from, to)));
  }

  const openTx: Record<string, Hex> = {};
  const closeTx: Record<string, Hex> = {};
  const creditedTx = new Set<string>();
  type Raw = { kind: PayoutKind; streamId: bigint | null; amount: bigint; tx: Hex; blockNumber: bigint };
  const raw: Raw[] = [];

  for (const log of logs) {
    if (log.blockNumber == null || !log.transactionHash) continue;
    let decoded: ReturnType<typeof decodeEventLog<typeof escrowAbi>>;
    try {
      decoded = decodeEventLog({ abi: escrowAbi, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    const tx = log.transactionHash;
    const blockNumber = log.blockNumber;
    switch (decoded.eventName) {
      case "Opened": {
        const id = decoded.args.id.toString();
        if (ours.has(id)) openTx[id] = tx;
        break;
      }
      case "Claimed": {
        if (!ours.has(decoded.args.id.toString()) || decoded.args.amount === 0n) break;
        raw.push({ kind: "claim", streamId: decoded.args.id, amount: decoded.args.amount, tx, blockNumber });
        break;
      }
      case "Closed": {
        const id = decoded.args.id.toString();
        if (!ours.has(id)) break;
        closeTx[id] = tx;
        if (decoded.args.paidToPayee > 0n) {
          raw.push({ kind: "close", streamId: decoded.args.id, amount: decoded.args.paidToPayee, tx, blockNumber });
        }
        break;
      }
      case "Credited": {
        if (payeeSet.has(decoded.args.payee.toLowerCase())) creditedTx.add(`${tx}:${decoded.args.amount.toString()}`);
        break;
      }
      case "Withdrawn": {
        if (!payeeSet.has(decoded.args.payee.toLowerCase()) || decoded.args.amount === 0n) break;
        raw.push({ kind: "withdraw", streamId: null, amount: decoded.args.amount, tx, blockNumber });
        break;
      }
      default: {
        const _never: never = decoded;
        void _never;
      }
    }
  }

  const times = new Map<string, bigint>();
  const payouts: Payout[] = [];
  for (const row of raw) {
    const creditKey = `${row.tx}:${row.amount.toString()}`;
    const kind: PayoutKind = row.kind === "close" && creditedTx.has(creditKey) ? "credit" : row.kind;
    let time = times.get(row.blockNumber.toString());
    if (time === undefined) {
      time = row.blockNumber === 0n ? 0n : (await withRetry(() => client.getBlock({ blockNumber: row.blockNumber }))).timestamp;
      times.set(row.blockNumber.toString(), time);
    }
    payouts.push({ kind, streamId: row.streamId, amount: row.amount, tx: row.tx, blockNumber: row.blockNumber, time });
  }
  payouts.sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber < b.blockNumber ? 1 : -1));
  return { payouts, openTx, closeTx, truncated };
}

export function payeeSet(snapshot: ProviderSnapshot): Address[] {
  const set = new Set<string>([snapshot.address.toLowerCase()]);
  for (const s of snapshot.services) if (!sameAddr(s.payee, ZERO)) set.add(s.payee.toLowerCase());
  return [...set] as Address[];
}
