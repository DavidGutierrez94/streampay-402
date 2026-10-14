import { verifyMessage } from "viem";
import {
  exhaustionAtMs,
  isStreamId,
  paymentRequired,
  paymentRequiredHeaders,
  readPaymentProof,
  sameAddress,
  streamProofMessage,
  type PaymentRequired,
  type PaymentRequirements,
  type StreamView,
} from "@streampay-402/protocol";
import type { ReadStream } from "./chain";

export type GateDecision =
  | { type: "payment-required"; status: 402; body: PaymentRequired; headers: Record<string, string> }
  | { type: "reject"; status: 400 | 402 | 409 | 503; body: Record<string, unknown>; headers: Record<string, string> }
  | { type: "accept"; streamId: string; stream: StreamView; endAt: number };

export interface DecideInput {
  getHeader: (name: string) => string | undefined | null;
  terms: PaymentRequirements;
  resourceUrl: string;
}

export interface Gate {
  readonly sessions: Set<string>;
  readonly readStream: ReadStream;
  decide(input: DecideInput): Promise<GateDecision>;
  tryHold(streamId: string): boolean;
  release(streamId: string): void;
}

export function createGate(options: { readStream: ReadStream; sessions?: Set<string> }): Gate {
  const sessions = options.sessions ?? new Set<string>();
  return {
    sessions,
    readStream: options.readStream,
    tryHold(streamId) {
      if (sessions.has(streamId)) return false;
      sessions.add(streamId);
      return true;
    },
    release(streamId) {
      sessions.delete(streamId);
    },
    async decide(input) {
      const required = paymentRequired(input.terms, input.resourceUrl);
      const proof = readPaymentProof(input.getHeader);
      if (!proof.ok) {
        if (proof.reason === "absent") {
          return { type: "payment-required", status: 402, body: required, headers: paymentRequiredHeaders(required) };
        }
        return { type: "reject", status: 402, body: { error: "invalid payment payload", errorReason: "invalid_payload" }, headers: {} };
      }
      if (!isStreamId(proof.streamId)) {
        return { type: "reject", status: 400, body: { error: "bad stream id" }, headers: {} };
      }
      const stream = await options.readStream(BigInt(proof.streamId));
      if (!stream) {
        return { type: "reject", status: 503, body: { error: "cannot verify stream (RPC)" }, headers: {} };
      }
      const message = streamProofMessage(input.terms.extra.escrow, proof.streamId);
      const owner = await verifyMessage({
        address: stream.payer,
        message,
        signature: proof.signature,
      }).catch(() => false);
      if (!owner) {
        return { type: "reject", status: 402, body: { error: "stream not owned by caller" }, headers: {} };
      }
      if (sessions.has(proof.streamId)) {
        return { type: "reject", status: 409, body: { error: "stream already in use" }, headers: {} };
      }
      const rate = BigInt(input.terms.extra.ratePerSec);
      const minDeposit = BigInt(input.terms.extra.minDeposit);
      const funded = stream.active
        && sameAddress(stream.payee, input.terms.payTo)
        && stream.rate >= rate
        && stream.deposit >= minDeposit
        && stream.rate > 0n;
      if (!funded) {
        return {
          type: "reject",
          status: 402,
          body: { ...required, error: "stream not funded/active for this service" },
          headers: {},
        };
      }
      return {
        type: "accept",
        streamId: proof.streamId,
        stream,
        endAt: exhaustionAtMs(stream.start, stream.deposit, stream.rate),
      };
    },
  };
}
