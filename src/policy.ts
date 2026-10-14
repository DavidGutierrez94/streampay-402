// Spend caps and session limits, enforced in the metering path before a stream is served.
// Amounts are wei. A null limit means that dimension is not capped.
import { formatEther, getAddress, isAddress, parseEther } from "viem";
import { getStore, type PolicyBlob } from "./store";

export type PolicyLimits = {
  maxTotalSpend: bigint | null;
  maxRatePerSec: bigint | null;
  maxSessionDuration: number | null;
};

export type PolicySubject =
  | { kind: "key"; serviceId: string }
  | { kind: "agent"; serviceId: string; agent: `0x${string}` };

const MAX_DURATION_SEC = 31_536_000;
const AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

type Ledger = { spent: bigint; reserved: bigint };
type OpenSession = { subjects: string[]; reserved: Map<string, bigint> };

const policies = new Map<string, PolicyLimits>();
const ledgers = new Map<string, Ledger>();
const openSessions = new Map<string, OpenSession>();

export function subjectKey(subject: PolicySubject): string {
  switch (subject.kind) {
    case "key":
      return `key:${subject.serviceId}`;
    case "agent":
      return `agent:${subject.serviceId}:${subject.agent.toLowerCase()}`;
    default: {
      const unreachable: never = subject;
      return unreachable;
    }
  }
}

function limitsOf(subject: PolicySubject): PolicyLimits | null {
  return policies.get(subjectKey(subject)) ?? null;
}

function bookOf(subject: PolicySubject): { spent: bigint; reserved: bigint } {
  const row = ledgers.get(subjectKey(subject));
  return { spent: row?.spent ?? 0n, reserved: row?.reserved ?? 0n };
}

function weiOrNull(value: string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

function loadBlob(blob: PolicyBlob): void {
  policies.clear();
  ledgers.clear();
  openSessions.clear();
  for (const [key, limits] of Object.entries(blob.policies)) {
    policies.set(key, {
      maxTotalSpend: weiOrNull(limits.maxTotalSpend),
      maxRatePerSec: weiOrNull(limits.maxRatePerSec),
      maxSessionDuration: limits.maxSessionDuration,
    });
  }
  for (const [key, row] of Object.entries(blob.ledgers)) {
    ledgers.set(key, { spent: BigInt(row.spent), reserved: BigInt(row.reserved) });
  }
  for (const [key, row] of Object.entries(blob.sessions)) {
    const reserved = new Map<string, bigint>();
    for (const [subject, amount] of Object.entries(row.reserved)) reserved.set(subject, BigInt(amount));
    openSessions.set(key, { subjects: [...row.subjects], reserved });
  }
}

function saveBlob(blob: PolicyBlob): void {
  blob.policies = {};
  blob.ledgers = {};
  blob.sessions = {};
  for (const [key, limits] of policies) {
    blob.policies[key] = {
      maxTotalSpend: limits.maxTotalSpend?.toString() ?? null,
      maxRatePerSec: limits.maxRatePerSec?.toString() ?? null,
      maxSessionDuration: limits.maxSessionDuration,
    };
  }
  for (const [key, row] of ledgers) {
    blob.ledgers[key] = { spent: row.spent.toString(), reserved: row.reserved.toString() };
  }
  for (const [key, row] of openSessions) {
    const reserved: Record<string, string> = {};
    for (const [subject, amount] of row.reserved) reserved[subject] = amount.toString();
    blob.sessions[key] = { subjects: [...row.subjects], reserved };
  }
}

function inTxn<T>(fn: () => T): Promise<T> {
  return getStore().withPolicy((blob) => {
    loadBlob(blob);
    const result = fn();
    saveBlob(blob);
    return result;
  });
}

export function resetPolicyStateForTests(): Promise<void> {
  return inTxn(() => {
    policies.clear();
    ledgers.clear();
    openSessions.clear();
  });
}

export function inferServiceId(): string {
  return process.env.POLICY_SERVICE_ID?.trim() || "infer";
}

function setPolicySync(subject: PolicySubject, limits: PolicyLimits): void {
  const key = subjectKey(subject);
  if (limits.maxTotalSpend === null && limits.maxRatePerSec === null && limits.maxSessionDuration === null) {
    policies.delete(key);
    return;
  }
  policies.set(key, { ...limits });
}

export function setPolicy(subject: PolicySubject, limits: PolicyLimits): Promise<void> {
  return inTxn(() => setPolicySync(subject, limits));
}

export function getLimits(subject: PolicySubject): Promise<PolicyLimits | null> {
  return inTxn(() => limitsOf(subject));
}

export function ledgerSnapshot(subject: PolicySubject): Promise<{ spent: bigint; reserved: bigint }> {
  return inTxn(() => bookOf(subject));
}

export type PolicyView = {
  subject: "key" | "agent";
  serviceId: string;
  agent: string | null;
  maxTotalSpend: string | null;
  maxRatePerSec: string | null;
  maxSessionDuration: number | null;
  maxTotalSpendMon: string | null;
  maxRatePerSecMon: string | null;
  spent: string;
  reserved: string;
  spentMon: string;
  reservedMon: string;
};

function mon(wei: bigint | null): string | null {
  return wei === null ? null : formatEther(wei);
}

export function viewPolicy(subject: PolicySubject): Promise<PolicyView> {
  return inTxn(() => viewPolicySync(subject));
}

function viewPolicySync(subject: PolicySubject): PolicyView {
  const limits = limitsOf(subject);
  const book = bookOf(subject);
  return {
    subject: subject.kind,
    serviceId: subject.serviceId,
    agent: subject.kind === "agent" ? subject.agent : null,
    maxTotalSpend: limits?.maxTotalSpend?.toString() ?? null,
    maxRatePerSec: limits?.maxRatePerSec?.toString() ?? null,
    maxSessionDuration: limits?.maxSessionDuration ?? null,
    maxTotalSpendMon: mon(limits?.maxTotalSpend ?? null),
    maxRatePerSecMon: mon(limits?.maxRatePerSec ?? null),
    spent: book.spent.toString(),
    reserved: book.reserved.toString(),
    spentMon: formatEther(book.spent),
    reservedMon: formatEther(book.reserved),
  };
}

/** Caps safe to echo on a public 402. Spend already booked stays on the authenticated GET. */
export function publicPolicy(subject: PolicySubject): Promise<{
  maxTotalSpend: string | null;
  maxRatePerSec: string | null;
  maxSessionDuration: number | null;
} | null> {
  return inTxn(() => publicPolicySync(subject));
}

function publicPolicySync(subject: PolicySubject): {
  maxTotalSpend: string | null;
  maxRatePerSec: string | null;
  maxSessionDuration: number | null;
} | null {
  const limits = limitsOf(subject);
  if (!limits) return null;
  return {
    maxTotalSpend: limits.maxTotalSpend?.toString() ?? null,
    maxRatePerSec: limits.maxRatePerSec?.toString() ?? null,
    maxSessionDuration: limits.maxSessionDuration,
  };
}

export function parseMon(value: unknown): { ok: true; wei: bigint | null } | { ok: false; error: string } {
  if (value === null || value === undefined) return { ok: true, wei: null };
  if (typeof value !== "string" || !AMOUNT.test(value)) return { ok: false, error: "amounts are decimal MON strings" };
  try {
    return { ok: true, wei: parseEther(value) };
  } catch {
    return { ok: false, error: "amounts are decimal MON strings" };
  }
}

export function parseLimits(body: unknown): { ok: true; limits: PolicyLimits } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "bad json" };
  const rec = body as Record<string, unknown>;
  const spend = parseMon(rec.maxTotalSpend);
  if (!spend.ok) return spend;
  const rate = parseMon(rec.maxRatePerSec);
  if (!rate.ok) return rate;
  let duration: number | null = null;
  if (rec.maxSessionDuration !== null && rec.maxSessionDuration !== undefined) {
    const d = rec.maxSessionDuration;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > MAX_DURATION_SEC) {
      return { ok: false, error: "maxSessionDuration must be a whole number of seconds" };
    }
    duration = d;
  }
  return { ok: true, limits: { maxTotalSpend: spend.wei, maxRatePerSec: rate.wei, maxSessionDuration: duration } };
}

export async function applyEnvPolicy(serviceId?: string): Promise<void> {
  const spend = process.env.POLICY_MAX_TOTAL_SPEND?.trim() || null;
  const rate = process.env.POLICY_MAX_RATE_PER_SEC?.trim() || null;
  const durRaw = process.env.POLICY_MAX_SESSION_SECONDS?.trim() || null;
  if (!spend && !rate && !durRaw) return;
  const parsed = parseLimits({
    maxTotalSpend: spend,
    maxRatePerSec: rate,
    maxSessionDuration: durRaw === null ? null : Number(durRaw),
  });
  if (!parsed.ok) {
    console.log(`[policy] ignoring POLICY_* env: ${parsed.error}`);
    return;
  }
  const id = serviceId ?? inferServiceId();
  await setPolicy({ kind: "key", serviceId: id }, parsed.limits);
  console.log(`[policy] caps loaded for service ${id}`);
}

export type SessionGrant = {
  sessionKey: string;
  /** Accrued wei at which the spend cap cuts the session off. Null when the cap is above this deposit. */
  spendCap: bigint | null;
  durationCap: bigint | null;
  durationDeadlineMs: number | null;
  rate: bigint;
  deposit: bigint;
  startSec: number;
};

export type BeginResult =
  | { ok: true; grant: SessionGrant }
  | { ok: false; status: 402 | 409; error: string };

/** Whole seconds from the stream's chain start, capped by the deposit. Matches StreamEscrow.owed. */
export function accruedWei(rate: bigint, deposit: bigint, startSec: number, nowMs: number): bigint {
  const elapsed = BigInt(Math.max(0, Math.floor(nowMs / 1000) - startSec));
  const raw = rate * elapsed;
  return raw > deposit ? deposit : raw;
}

function usedOf(key: string): bigint {
  const row = ledgers.get(key);
  return row ? row.spent + row.reserved : 0n;
}

function book(key: string): Ledger {
  let row = ledgers.get(key);
  if (!row) {
    row = { spent: 0n, reserved: 0n };
    ledgers.set(key, row);
  }
  return row;
}

export function beginSession(input: {
  serviceId: string;
  payer: string;
  streamId: string;
  rate: bigint;
  deposit: bigint;
  startSec: number;
  nowMs: number;
}): Promise<BeginResult> {
  return inTxn(() => beginSessionSync(input));
}

function beginSessionSync(input: {
  serviceId: string;
  payer: string;
  streamId: string;
  rate: bigint;
  deposit: bigint;
  startSec: number;
  nowMs: number;
}): BeginResult {
  if (!isAddress(input.payer, { strict: false })) return { ok: false, status: 402, error: "bad payer" };
  const payer = getAddress(input.payer.toLowerCase() as `0x${string}`);
  const sessionKey = `${input.serviceId}:${input.streamId}`;
  if (openSessions.has(sessionKey)) return { ok: false, status: 409, error: "stream already in use" };

  const subjects: PolicySubject[] = [
    { kind: "key", serviceId: input.serviceId },
    { kind: "agent", serviceId: input.serviceId, agent: payer },
  ];
  const rows: { key: string; limits: PolicyLimits }[] = [];
  for (const subject of subjects) {
    const limits = limitsOf(subject);
    if (limits) rows.push({ key: subjectKey(subject), limits });
  }

  const grant: SessionGrant = {
    sessionKey,
    spendCap: null,
    durationCap: null,
    durationDeadlineMs: null,
    rate: input.rate,
    deposit: input.deposit,
    startSec: input.startSec,
  };
  if (rows.length === 0) return { ok: true, grant };

  let maxRate: bigint | null = null;
  let maxDuration: number | null = null;
  for (const row of rows) {
    const cap = row.limits.maxRatePerSec;
    if (cap !== null && (maxRate === null || cap < maxRate)) maxRate = cap;
    const dur = row.limits.maxSessionDuration;
    if (dur !== null && (maxDuration === null || dur < maxDuration)) maxDuration = dur;
  }
  if (maxRate !== null && input.rate > maxRate) return { ok: false, status: 402, error: "rate exceeds session policy" };

  const durationCap = maxDuration === null ? null : input.rate * BigInt(maxDuration);
  const deadline = maxDuration === null ? null : (input.startSec + maxDuration) * 1000;
  let spendRemaining: bigint | null = null;
  const spendKeys: string[] = [];
  for (const row of rows) {
    const cap = row.limits.maxTotalSpend;
    if (cap === null) continue;
    const remaining = usedOf(row.key) >= cap ? 0n : cap - usedOf(row.key);
    if (spendRemaining === null || remaining < spendRemaining) spendRemaining = remaining;
    spendKeys.push(row.key);
  }

  let billable = input.deposit;
  if (durationCap !== null && durationCap < billable) billable = durationCap;
  if (spendRemaining !== null && spendRemaining < billable) billable = spendRemaining;

  const already = accruedWei(input.rate, input.deposit, input.startSec, input.nowMs);
  if (deadline !== null && input.nowMs >= deadline) return { ok: false, status: 402, error: "session duration exceeded" };
  if (durationCap !== null && already >= durationCap) return { ok: false, status: 402, error: "session duration exceeded" };
  if (spendRemaining !== null && (spendRemaining === 0n || already >= spendRemaining)) {
    return { ok: false, status: 402, error: "spend cap exceeded" };
  }

  grant.durationCap = durationCap;
  grant.durationDeadlineMs = deadline;
  grant.spendCap = spendRemaining !== null && spendRemaining <= input.deposit ? spendRemaining : null;

  const reserved = new Map<string, bigint>();
  for (const row of rows) {
    const holdsSpend = row.limits.maxTotalSpend !== null;
    const amount = holdsSpend ? billable : 0n;
    if (holdsSpend) book(row.key).reserved += amount;
    reserved.set(row.key, amount);
  }
  openSessions.set(sessionKey, { subjects: rows.map((row) => row.key), reserved });
  return { ok: true, grant };
}

export function policyBlock(grant: SessionGrant, nowMs: number): "policy-duration" | "policy-spend" | null {
  if (grant.durationDeadlineMs !== null && nowMs >= grant.durationDeadlineMs) return "policy-duration";
  const accrued = accruedWei(grant.rate, grant.deposit, grant.startSec, nowMs);
  if (grant.durationCap !== null && accrued >= grant.durationCap) return "policy-duration";
  if (grant.spendCap !== null && accrued >= grant.spendCap) return "policy-spend";
  return null;
}

export function endSession(sessionKey: string, actual: bigint): Promise<void> {
  return inTxn(() => endSessionSync(sessionKey, actual));
}

function endSessionSync(sessionKey: string, actual: bigint): void {
  const rec = openSessions.get(sessionKey);
  if (!rec) return;
  openSessions.delete(sessionKey);
  const bill = actual > 0n ? actual : 0n;
  for (const key of rec.subjects) {
    const row = book(key);
    const held = rec.reserved.get(key) ?? 0n;
    row.reserved = row.reserved >= held ? row.reserved - held : 0n;
    row.spent += held === 0n ? bill : bill < held ? bill : held;
  }
}
