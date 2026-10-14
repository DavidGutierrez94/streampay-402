/**
 * `stream-per-second` is an x402 v2 payment scheme for time-metered resources.
 * The HTTP envelope (PaymentRequired, PaymentPayload, PAYMENT-* headers) is the
 * spec's. Scheme-specific fields live in `extra` and `payload`. See
 * docs/schemes/stream-per-second.md.
 */

export const X402_VERSION = 2;
export const SCHEME = "stream-per-second";
/** x402 §6.1 flow: lock a deposit, serve, then settle the final charge. */
export const PAYMENT_FLOW = "escrow";
export const ASSET_TRANSFER_METHOD = "stream-escrow";
/** Native gas token. x402 `asset` is a token address; the zero address means the chain native asset. */
export const NATIVE_ASSET = "0x0000000000000000000000000000000000000000";
export const LEGACY_NATIVE_ASSET = "native:MON";

export const HEADER_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_RESPONSE = "PAYMENT-RESPONSE";
/** Pre-v2 demo names. Servers emit both; clients accept both. */
export const LEGACY_HEADER_REQUIRED = "X-PAYMENT-REQUIRED";
export const LEGACY_HEADER_STREAM = "X-PAYMENT-STREAM";
export const LEGACY_HEADER_SIG = "X-PAYMENT-SIG";

export const DEFAULT_MIN_SECONDS = 10;
export const DEFAULT_MAX_TIMEOUT_SECONDS = 120;
const STREAM_ID_RE = /^\d{1,78}$/;

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
}

export interface StreamPerSecondExtra {
  paymentFlow: typeof PAYMENT_FLOW;
  assetTransferMethod: typeof ASSET_TRANSFER_METHOD;
  escrow: string;
  ratePerSec: string;
  minDeposit: string;
  symbol?: string;
  publishableKey?: string;
}

/**
 * x402 PaymentRequirements for this scheme.
 * `amount` is the minimum deposit (atomic native units), not the final charge.
 * Flat `ratePerSec` / `escrow` / `minDeposit` mirror `extra` for the v1 demo body.
 */
export interface PaymentRequirements {
  scheme: typeof SCHEME;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: StreamPerSecondExtra;
  escrow?: string;
  ratePerSec?: string;
  minDeposit?: string;
  resource?: string;
  description?: string;
  serviceName?: string;
}

export interface PaymentRequired {
  x402Version: typeof X402_VERSION;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface StreamPayload {
  streamId: string;
  signature: `0x${string}`;
}

export interface PaymentPayload {
  x402Version: typeof X402_VERSION;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: StreamPayload;
  extensions?: Record<string, unknown>;
}

export interface StreamView {
  payer: `0x${string}`;
  payee: `0x${string}`;
  rate: bigint;
  deposit: bigint;
  start: number;
  stoppedAt: number;
  active: boolean;
}

export class SchemeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SchemeError";
    this.code = code;
  }
}

export function streamProofMessage(escrow: string, streamId: string | bigint): string {
  return `x402-stream:${escrow.toLowerCase()}:${streamId.toString()}`;
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function networkOf(chainId: number): string {
  return `eip155:${chainId}`;
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(encoded, "base64"));
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeBase64Json(value: unknown): string {
  return bytesToBase64(utf8Bytes(JSON.stringify(value)));
}

export function decodeBase64Json(encoded: string): unknown {
  const json = new TextDecoder().decode(base64ToBytes(encoded));
  return JSON.parse(json);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function atomicString(value: unknown, label: string): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  throw new SchemeError("invalid_payment_requirements", `invalid ${label}`);
}

function normalizeAsset(asset: unknown): string {
  if (asset === LEGACY_NATIVE_ASSET || asset === "native") return NATIVE_ASSET;
  if (typeof asset === "string" && asset.length > 0) return asset;
  return NATIVE_ASSET;
}

function normalizeRequirement(raw: unknown): PaymentRequirements {
  if (!isRecord(raw)) throw new SchemeError("invalid_payment_requirements", "accepts entry is not an object");
  if (raw.scheme !== SCHEME) throw new SchemeError("unsupported_scheme", `scheme ${String(raw.scheme)} is not ${SCHEME}`);
  const extra = isRecord(raw.extra) ? raw.extra : {};
  const ratePerSec = atomicString(extra.ratePerSec ?? raw.ratePerSec, "ratePerSec");
  const minDeposit = atomicString(extra.minDeposit ?? raw.minDeposit ?? raw.amount, "minDeposit");
  const escrow = extra.escrow ?? raw.escrow;
  if (typeof escrow !== "string" || !escrow.startsWith("0x")) {
    throw new SchemeError("invalid_payment_requirements", "missing escrow");
  }
  const payTo = raw.payTo;
  if (typeof payTo !== "string" || !payTo.startsWith("0x")) {
    throw new SchemeError("invalid_payment_requirements", "missing payTo");
  }
  const network = raw.network;
  if (typeof network !== "string" || !network.startsWith("eip155:")) {
    throw new SchemeError("invalid_payment_requirements", "network must be a CAIP-2 eip155 id");
  }
  const timeout = raw.maxTimeoutSeconds;
  const maxTimeoutSeconds = typeof timeout === "number" && timeout > 0 ? timeout : DEFAULT_MAX_TIMEOUT_SECONDS;
  const publishableKey = typeof extra.publishableKey === "string" ? extra.publishableKey : undefined;
  const symbol = typeof extra.symbol === "string" ? extra.symbol : "MON";
  const description = typeof raw.description === "string" ? raw.description : undefined;
  const resource = typeof raw.resource === "string" ? raw.resource : undefined;
  const serviceName = printableName(typeof raw.serviceName === "string" ? raw.serviceName : undefined);
  return {
    scheme: SCHEME,
    network,
    amount: minDeposit,
    asset: normalizeAsset(raw.asset),
    payTo,
    maxTimeoutSeconds,
    extra: {
      paymentFlow: PAYMENT_FLOW,
      assetTransferMethod: ASSET_TRANSFER_METHOD,
      escrow,
      ratePerSec,
      minDeposit,
      symbol,
      publishableKey,
    },
    escrow,
    ratePerSec,
    minDeposit,
    description,
    resource,
    serviceName,
  };
}

function normalizeResource(raw: unknown, fallbackUrl: string, terms: PaymentRequirements | undefined): ResourceInfo {
  if (isRecord(raw) && typeof raw.url === "string") {
    const description = typeof raw.description === "string" ? raw.description : terms?.description;
    const mimeType = typeof raw.mimeType === "string" ? raw.mimeType : undefined;
    const serviceName = typeof raw.serviceName === "string" ? raw.serviceName : undefined;
    return { url: raw.url, description, mimeType, serviceName };
  }
  return {
    url: fallbackUrl || terms?.resource || "",
    description: terms?.description,
    mimeType: "text/event-stream",
  };
}

/** Accept a v2 PaymentRequired or the v1 demo body (`accepts[0].ratePerSec` at the top level). */
export function normalizePaymentRequired(raw: unknown, fallbackUrl = ""): PaymentRequired {
  if (!isRecord(raw) || !Array.isArray(raw.accepts) || raw.accepts.length === 0) {
    throw new SchemeError("invalid_payment_requirements", "402 body has no accepts");
  }
  const accepts: PaymentRequirements[] = [];
  for (const entry of raw.accepts) {
    if (!isRecord(entry) || entry.scheme !== SCHEME) continue;
    accepts.push(normalizeRequirement(entry));
  }
  if (accepts.length === 0) throw new SchemeError("unsupported_scheme", `no ${SCHEME} requirement`);
  const first = accepts[0];
  if (!first) throw new SchemeError("unsupported_scheme", `no ${SCHEME} requirement`);
  const extensions = isRecord(raw.extensions) ? raw.extensions : undefined;
  return {
    x402Version: X402_VERSION,
    error: typeof raw.error === "string" ? raw.error : "PAYMENT-SIGNATURE header is required",
    resource: normalizeResource(raw.resource, fallbackUrl, first),
    accepts,
    extensions,
  };
}

export function selectStreamRequirement(required: PaymentRequired): PaymentRequirements {
  const found = required.accepts.find((entry) => entry.scheme === SCHEME);
  if (!found) throw new SchemeError("unsupported_scheme", `no ${SCHEME} requirement`);
  return found;
}

export interface RequirementInput {
  payTo: string;
  escrow: string;
  ratePerSec: bigint;
  chainId: number;
  resourceUrl: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  publishableKey?: string;
  symbol?: string;
  minSeconds?: number;
  maxTimeoutSeconds?: number;
}

function printableName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const cleaned = name.replace(/[^\x20-\x7e]/g, "").slice(0, 32);
  return cleaned.length > 0 ? cleaned : undefined;
}

export function paymentRequirements(input: RequirementInput): PaymentRequirements {
  if (input.ratePerSec <= 0n) throw new SchemeError("invalid_payment_requirements", "ratePerSec must be positive");
  const minSeconds = input.minSeconds ?? DEFAULT_MIN_SECONDS;
  if (!Number.isInteger(minSeconds) || minSeconds < 1) {
    throw new SchemeError("invalid_payment_requirements", "minSeconds must be a positive integer");
  }
  const minDeposit = input.ratePerSec * BigInt(minSeconds);
  const rate = input.ratePerSec.toString();
  const deposit = minDeposit.toString();
  return {
    scheme: SCHEME,
    network: networkOf(input.chainId),
    amount: deposit,
    asset: NATIVE_ASSET,
    payTo: input.payTo,
    maxTimeoutSeconds: input.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
    extra: {
      paymentFlow: PAYMENT_FLOW,
      assetTransferMethod: ASSET_TRANSFER_METHOD,
      escrow: input.escrow,
      ratePerSec: rate,
      minDeposit: deposit,
      symbol: input.symbol ?? "MON",
      publishableKey: input.publishableKey,
    },
    escrow: input.escrow,
    ratePerSec: rate,
    minDeposit: deposit,
    resource: input.resourceUrl,
    description: input.description,
    serviceName: printableName(input.serviceName),
  };
}

export function paymentRequired(terms: PaymentRequirements, resourceUrl: string, mimeType = "text/event-stream"): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: resourceUrl,
      description: terms.description,
      mimeType,
      serviceName: printableName(terms.serviceName),
    },
    accepts: [terms],
  };
}

export function paymentRequiredHeaders(required: PaymentRequired): Record<string, string> {
  const encoded = encodeBase64Json(required);
  return {
    [HEADER_REQUIRED]: encoded,
    [LEGACY_HEADER_REQUIRED]: encoded,
  };
}

export function buildPaymentPayload(args: {
  accepted: PaymentRequirements;
  streamId: bigint;
  signature: `0x${string}`;
  resource?: ResourceInfo;
}): PaymentPayload {
  return {
    x402Version: X402_VERSION,
    resource: args.resource,
    accepted: args.accepted,
    payload: { streamId: args.streamId.toString(), signature: args.signature },
  };
}

export function clientPaymentHeaders(payload: PaymentPayload): Record<string, string> {
  return {
    [HEADER_SIGNATURE]: encodeBase64Json(payload),
    [LEGACY_HEADER_STREAM]: payload.payload.streamId,
    [LEGACY_HEADER_SIG]: payload.payload.signature,
  };
}

export type ProofRead =
  | { ok: true; streamId: string; signature: `0x${string}` }
  | { ok: false; reason: "absent" | "invalid_payload" };

function isSignature(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{130}$/.test(value);
}

export function readPaymentProof(getHeader: (name: string) => string | undefined | null): ProofRead {
  const encoded = getHeader(HEADER_SIGNATURE);
  if (encoded) {
    try {
      const parsed = decodeBase64Json(encoded);
      if (!isRecord(parsed) || !isRecord(parsed.payload)) return { ok: false, reason: "invalid_payload" };
      const streamId = parsed.payload.streamId;
      const signature = parsed.payload.signature;
      if (typeof streamId !== "string" || !isSignature(signature)) return { ok: false, reason: "invalid_payload" };
      return { ok: true, streamId, signature };
    } catch {
      return { ok: false, reason: "invalid_payload" };
    }
  }
  const streamId = getHeader(LEGACY_HEADER_STREAM);
  const signature = getHeader(LEGACY_HEADER_SIG);
  if (!streamId && !signature) return { ok: false, reason: "absent" };
  if (!streamId || !isSignature(signature)) return { ok: false, reason: "invalid_payload" };
  return { ok: true, streamId, signature };
}

export function isStreamId(id: string): boolean {
  return STREAM_ID_RE.test(id);
}

/** Local exhaustion bound: start + deposit/rate, in milliseconds. */
export function exhaustionAtMs(startSec: number, deposit: bigint, rate: bigint): number {
  if (rate <= 0n) return Number.MAX_SAFE_INTEGER;
  const ms = (deposit * 1000n) / rate;
  const cap = BigInt(Number.MAX_SAFE_INTEGER);
  const duration = ms > cap ? Number.MAX_SAFE_INTEGER : Number(ms);
  const startMs = startSec * 1000;
  if (!Number.isFinite(startMs) || startMs < 0) return duration;
  const end = startMs + duration;
  return end > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : end;
}

export async function readPaymentRequired(response: Response, fallbackUrl = ""): Promise<PaymentRequired> {
  const header = response.headers.get(HEADER_REQUIRED) ?? response.headers.get(LEGACY_HEADER_REQUIRED);
  if (header) {
    try {
      return normalizePaymentRequired(decodeBase64Json(header), fallbackUrl || response.url);
    } catch (error) {
      const recoverable = error instanceof SchemeError
        && (error.code === "invalid_payment_requirements" || error.code === "unsupported_scheme");
      if (!recoverable && error instanceof SchemeError) throw error;
    }
  }
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    throw new SchemeError("invalid_payment_requirements", "402 response missing payment requirements");
  }
  return normalizePaymentRequired(body, fallbackUrl || response.url);
}
