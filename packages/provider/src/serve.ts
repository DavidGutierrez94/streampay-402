import type { Address, PublicClient } from "viem";
import type { PaymentRequirements, StreamView } from "@streampay-402/protocol";
import { readOnchainStream, type ReadStream } from "./chain";
import { createGate, type Gate, type GateDecision } from "./gate";
import { runMeter, type Produce } from "./meter";

export interface OnAccept {
  (info: { streamId: string; stream: StreamView; endAt: number }): void;
}

export interface ServeOptions {
  terms: PaymentRequirements | ((url: string) => PaymentRequirements | Promise<PaymentRequirements>);
  produce?: Produce;
  tickMs?: number;
  recheckMs?: number;
  now?: () => number;
  onAccept?: OnAccept;
  /** Cutoff check before each token. A string stops the meter with that reason. */
  inspect?: () => Promise<string | null> | string | null;
  /** Reuse a gate (one live session per stream). Otherwise one is built from readStream or publicClient. */
  gate?: Gate;
  readStream?: ReadStream;
  publicClient?: PublicClient;
  escrow?: Address;
}

export function bindGate(options: Pick<ServeOptions, "gate" | "readStream" | "publicClient" | "escrow">): Gate {
  if (options.gate) return options.gate;
  if (options.readStream) return createGate({ readStream: options.readStream });
  if (options.publicClient && options.escrow) {
    const client = options.publicClient;
    const escrow = options.escrow;
    return createGate({ readStream: (id) => readOnchainStream(client, escrow, id) });
  }
  throw new Error("pass gate, readStream, or publicClient and escrow");
}

export type HttpStatus = 400 | 402 | 409 | 503;

export type Begun =
  | { type: "http"; status: HttpStatus; headers: Record<string, string>; body: unknown }
  | { type: "stream"; streamId: string; endAt: number; stream: StreamView };

export async function resolveTerms(terms: ServeOptions["terms"], url: string): Promise<PaymentRequirements> {
  return typeof terms === "function" ? terms(url) : terms;
}

export const defaultProduce: Produce = (index) => `tick-${index}`;

/** Run the gate. An accepted stream is held until the caller releases it. */
export async function begin(
  gate: Gate,
  input: { getHeader: (name: string) => string | undefined | null; terms: PaymentRequirements; resourceUrl: string },
): Promise<Begun> {
  const decision = await gate.decide(input);
  switch (decision.type) {
    case "payment-required":
    case "reject":
      return { type: "http", status: decision.status, headers: decision.headers, body: decision.body };
    case "accept":
      if (!gate.tryHold(decision.streamId)) {
        return { type: "http", status: 409, headers: {}, body: { error: "stream already in use" } };
      }
      return { type: "stream", streamId: decision.streamId, endAt: decision.endAt, stream: decision.stream };
    default: {
      const unexpected: never = decision;
      return unexpected;
    }
  }
}

export async function meterHeld(
  gate: Gate,
  begun: Extract<Begun, { type: "stream" }>,
  options: ServeOptions,
  transport: {
    sleep: (ms: number) => Promise<void>;
    write: (event: "token" | "cutoff", data: string) => Promise<void>;
    isAborted: () => boolean;
  },
): Promise<string> {
  try {
    options.onAccept?.({ streamId: begun.streamId, stream: begun.stream, endAt: begun.endAt });
    return await runMeter({
      streamId: begun.streamId,
      endAt: begun.endAt,
      readStream: gate.readStream,
      produce: options.produce ?? defaultProduce,
      tickMs: options.tickMs,
      recheckMs: options.recheckMs,
      now: options.now,
      inspect: options.inspect,
      sleep: transport.sleep,
      write: transport.write,
      isAborted: transport.isAborted,
    });
  } finally {
    gate.release(begun.streamId);
  }
}

export type { GateDecision, ReadStream };
