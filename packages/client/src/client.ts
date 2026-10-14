import { getAddress, type Address, type Chain, type Hash, type Hex } from "viem";
import {
  buildPaymentPayload,
  clientPaymentHeaders,
  readPaymentRequired,
  selectStreamRequirement,
  type PaymentRequirements,
  type ResourceInfo,
} from "@streampay-402/protocol";
import { createViemConnection, type EscrowConnection, type ViemConnectionOptions } from "./chain";
import { planSpend, type SpendPolicy } from "./policy";

export interface CloseResult {
  hash: Hash | null;
  paidToPayee: bigint;
  refunded: bigint;
  streamId: bigint;
}

export interface PaidSession {
  response: Response;
  streamId: bigint;
  openHash: Hash | null;
  deposit: bigint;
  terms: PaymentRequirements | null;
  close: () => Promise<CloseResult>;
  [Symbol.asyncDispose]: () => Promise<void>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface StreamPayClientOptions extends SpendPolicy {
  chain?: Chain;
  connection?: EscrowConnection;
  privateKey?: Hex;
  transport?: ViemConnectionOptions["transport"];
  publicClient?: ViemConnectionOptions["publicClient"];
  walletClient?: ViemConnectionOptions["walletClient"];
  account?: ViemConnectionOptions["account"];
  /** Called with normalized terms before the stream is opened. Throw to refuse. */
  onTerms?: (terms: PaymentRequirements) => void | Promise<void>;
  /** Paid retries while the open transaction is still propagating. Default 4. */
  payRetries?: number;
  retryDelayMs?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

const EMPTY_CLOSE: CloseResult = { hash: null, paidToPayee: 0n, refunded: 0n, streamId: 0n };

function mergeHeaders(base: RequestInit["headers"], extra: Record<string, string>): Headers {
  const headers = new Headers(base);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return headers;
}

function unpaid(response: Response): PaidSession {
  const close = async () => EMPTY_CLOSE;
  return {
    response,
    streamId: 0n,
    openHash: null,
    deposit: 0n,
    terms: null,
    close,
    [Symbol.asyncDispose]: async () => { await close(); },
  };
}

export class StreamPayClient {
  readonly escrow: Address;
  private readonly policy: SpendPolicy;
  private readonly connection: EscrowConnection;
  private readonly onTerms?: StreamPayClientOptions["onTerms"];
  private readonly payRetries: number;
  private readonly retryDelayMs: number;
  private readonly fetcher: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: StreamPayClientOptions) {
    this.escrow = getAddress(options.escrow);
    this.policy = {
      escrow: this.escrow,
      maxRatePerSec: options.maxRatePerSec,
      maxDeposit: options.maxDeposit,
      trustedPayees: options.trustedPayees,
      depositSeconds: options.depositSeconds,
    };
    if (options.connection) {
      this.connection = options.connection;
    } else {
      if (!options.chain) throw new Error("pass chain or connection");
      this.connection = createViemConnection({
        escrow: this.escrow,
        chain: options.chain,
        privateKey: options.privateKey,
        account: options.account,
        transport: options.transport,
        publicClient: options.publicClient,
        walletClient: options.walletClient,
      });
    }
    this.onTerms = options.onTerms;
    this.payRetries = options.payRetries ?? 4;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.fetcher = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Fetch a resource. A 402 selecting `stream-per-second` opens an escrow stream
   * and retries with `PAYMENT-SIGNATURE` (and the legacy stream headers).
   * Call `close()` — or dispose the session — when you stop reading.
   */
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<PaidSession> {
    const first = await this.send(input, init);
    if (first.status !== 402) return unpaid(first);

    const required = await readPaymentRequired(first, typeof input === "string" ? input : first.url);
    const terms = selectStreamRequirement(required);
    const plan = planSpend(terms, this.policy);
    if (this.onTerms) await this.onTerms(terms);

    const opened = await this.connection.open({
      payee: plan.payTo,
      ratePerSec: plan.rate,
      value: plan.deposit,
    });
    try {
      const signature = await this.connection.signProof(opened.streamId);
      const payload = buildPaymentPayload({
        accepted: terms,
        streamId: opened.streamId,
        signature,
        resource: required.resource,
      });
      const headers = mergeHeaders(init?.headers, clientPaymentHeaders(payload));
      const paid = await this.retryPaid(input, init, headers);
      return this.session(paid, opened.streamId, opened.hash, plan.deposit, terms);
    } catch (error) {
      await this.connection.close(opened.streamId).catch(() => {});
      throw error;
    }
  }

  /** Fetch, run `fn`, and close the stream on success or failure. */
  async withStream<T>(input: string | URL | Request, fn: (session: PaidSession) => Promise<T>): Promise<{ result: T; close: CloseResult }>;
  async withStream<T>(input: string | URL | Request, init: RequestInit, fn: (session: PaidSession) => Promise<T>): Promise<{ result: T; close: CloseResult }>;
  async withStream<T>(
    input: string | URL | Request,
    initOrFn: RequestInit | ((session: PaidSession) => Promise<T>),
    maybeFn?: (session: PaidSession) => Promise<T>,
  ): Promise<{ result: T; close: CloseResult }> {
    const init = typeof initOrFn === "function" ? undefined : initOrFn;
    const fn = typeof initOrFn === "function" ? initOrFn : maybeFn;
    if (!fn) throw new Error("withStream requires a callback");
    const session = await this.fetch(input, init);
    try {
      const result = await fn(session);
      return { result, close: await session.close() };
    } catch (error) {
      await session.close().catch(() => {});
      throw error;
    }
  }

  private send(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (typeof input === "string" || input instanceof URL) return this.fetcher(input, init);
    // clone() is typed against undici's Request, which is not the global Request.
    return this.fetcher(input.clone() as Request, init);
  }

  private async retryPaid(input: string | URL | Request, init: RequestInit | undefined, headers: Headers): Promise<Response> {
    let last: Response | undefined;
    for (let attempt = 0; attempt < this.payRetries; attempt++) {
      last = await this.send(input, { ...init, headers });
      if (last.status !== 402) return last;
      if (attempt < this.payRetries - 1) await this.sleep(this.retryDelayMs);
    }
    const detail = await last?.text().catch(() => "");
    throw new Error(`payment rejected: ${last?.status ?? "no response"} ${(detail ?? "").slice(0, 300)}`);
  }

  private session(
    response: Response,
    streamId: bigint,
    openHash: Hash,
    deposit: bigint,
    terms: PaymentRequirements,
  ): PaidSession {
    if (response.status !== 200) {
      throw new Error(`paid request failed: ${response.status}`);
    }
    let pending: Promise<CloseResult> | undefined;
    let settled: CloseResult | undefined;
    const close = (): Promise<CloseResult> => {
      if (settled) return Promise.resolve(settled);
      if (pending) return pending;
      pending = this.connection.close(streamId).then((closed) => {
        settled = {
          hash: closed.hash,
          paidToPayee: closed.paidToPayee,
          refunded: closed.refunded,
          streamId,
        };
        return settled;
      }).finally(() => {
        pending = undefined;
      });
      return pending;
    };
    return {
      response,
      streamId,
      openHash,
      deposit,
      terms,
      close,
      [Symbol.asyncDispose]: async () => { await close(); },
    };
  }
}

export type { ResourceInfo };
