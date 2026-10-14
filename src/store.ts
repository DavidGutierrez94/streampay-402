// Shared demo state for Fluid compute. Upstash Redis when the Vercel Marketplace
// KV vars (or UPSTASH_REDIS_REST_*) are set; in-memory otherwise so `bun src/server.ts`
// works with no extra services.
// Secret API keys are never written here. Only the onchain key hash exists.
// Registry `service()` reads are cached for a few seconds.
import { Redis } from "@upstash/redis";

export type DemoEvent = { t: number; kind: string; msg: string; link?: string };
export type DemoStream = {
  id: string;
  ratePerSec: string;
  deposit: string;
  start: number;
  tokens: number;
  stopped?: number;
};
export type CachedService = {
  owner: string;
  payee: string;
  ratePerSec: string;
  active: boolean;
  name: string;
};
export type Lock = { token: string };
export type DripSlot = "ok" | "dup" | "cap";
export type StartRun = { ok: true } | { ok: false; msg: string };
export type StoredReceipt = {
  secondsUsed: number;
  paid: string;
  refunded: string;
  tx: string;
  txUrl: string;
  chainId: number;
};
export type AgentStop = { stop: boolean; closing: boolean };
export type PolicyLimitsJson = {
  maxTotalSpend: string | null;
  maxRatePerSec: string | null;
  maxSessionDuration: number | null;
};
export type PolicyBlob = {
  policies: Record<string, PolicyLimitsJson>;
  ledgers: Record<string, { spent: string; reserved: string }>;
  sessions: Record<string, { subjects: string[]; reserved: Record<string, string> }>;
};
export type StoredWebhook = { url: string; secret: string; enabled: boolean; maxAttempts: number };

export function emptyPolicy(): PolicyBlob {
  return { policies: {}, ledgers: {}, sessions: {} };
}

const idleStop = (): AgentStop => ({ stop: false, closing: false });

export type DemoStore = {
  readonly kind: "memory" | "redis";
  pushEvent(ev: DemoEvent): Promise<void>;
  recentEvents(limit: number): Promise<DemoEvent[]>;
  getCurrent(): Promise<DemoStream | null>;
  setCurrent(stream: DemoStream): Promise<void>;
  updateCurrent(id: string, stream: DemoStream): Promise<void>;
  markCurrentStopped(now?: number): Promise<void>;
  clearDemo(): Promise<void>;
  tryLock(name: string, ttlSec: number, now?: number): Promise<Lock | null>;
  refreshLock(name: string, lock: Lock, ttlSec: number, now?: number): Promise<boolean>;
  unlock(name: string, lock: Lock): Promise<void>;
  tryMarkClaimed(sid: string): Promise<boolean>;
  hasDrip(address: string): Promise<boolean>;
  tryDrip(address: string, cap: number): Promise<DripSlot>;
  releaseDrip(address: string): Promise<void>;
  tryStartRun(cooldownMs: number, ttlSec: number, now?: number): Promise<StartRun>;
  finishRun(): Promise<void>;
  getCachedService(id: string): Promise<CachedService | null>;
  setCachedService(id: string, service: CachedService, ttlSec: number): Promise<void>;
  isRunning(now?: number): Promise<boolean>;
  getReceipt(): Promise<StoredReceipt | null>;
  setReceipt(receipt: StoredReceipt | null): Promise<void>;
  getAgentStop(): Promise<AgentStop>;
  setAgentStop(flags: AgentStop): Promise<void>;
  withPolicy<T>(fn: (blob: PolicyBlob) => T): Promise<T>;
  getWebhook(serviceId: string): Promise<StoredWebhook | null>;
  putWebhook(serviceId: string, config: StoredWebhook | null): Promise<void>;
  getDashboard(address: string): Promise<unknown | null>;
  setDashboard(address: string, value: unknown, ttlSec: number): Promise<void>;
  resetSessionLocks(): Promise<void>;
};

type Clock = () => number;
const LOG_CAP = 200;
const CLAIM_TTL_SEC = 7 * 24 * 60 * 60;
const P = "sp:v1:";

const runningMsg = "agent already running";
const coolMsg = (msLeft: number) => `cooling down, try again in ${Math.max(1, Math.ceil(msLeft / 1000))}s`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

function asEvent(raw: unknown): DemoEvent | null {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v) as unknown; } catch { return null; }
  }
  if (!isRecord(v) || typeof v.t !== "number" || typeof v.kind !== "string" || typeof v.msg !== "string") return null;
  const link = typeof v.link === "string" ? v.link : undefined;
  return link ? { t: v.t, kind: v.kind, msg: v.msg, link } : { t: v.t, kind: v.kind, msg: v.msg };
}

function asStream(raw: unknown): DemoStream | null {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v) as unknown; } catch { return null; }
  }
  if (!isRecord(v) || typeof v.id !== "string" || typeof v.ratePerSec !== "string" || typeof v.deposit !== "string") return null;
  if (typeof v.start !== "number" || typeof v.tokens !== "number") return null;
  const stopped = typeof v.stopped === "number" ? v.stopped : undefined;
  return stopped === undefined
    ? { id: v.id, ratePerSec: v.ratePerSec, deposit: v.deposit, start: v.start, tokens: v.tokens }
    : { id: v.id, ratePerSec: v.ratePerSec, deposit: v.deposit, start: v.start, tokens: v.tokens, stopped };
}

function asService(raw: unknown): CachedService | null {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v) as unknown; } catch { return null; }
  }
  if (!isRecord(v) || typeof v.owner !== "string" || typeof v.payee !== "string" || typeof v.ratePerSec !== "string") return null;
  if (typeof v.active !== "boolean" || typeof v.name !== "string") return null;
  return { owner: v.owner, payee: v.payee, ratePerSec: v.ratePerSec, active: v.active, name: v.name };
}

type MemLock = { token: string; expiresAt: number };

export function createMemoryStore(clock: Clock = Date.now): DemoStore {
  const log: DemoEvent[] = [];
  let current: DemoStream | null = null;
  const locks = new Map<string, MemLock>();
  const claims = new Map<string, number>();
  const dripped = new Set<string>();
  let runningUntil = 0;
  let lastRun = 0;
  const services = new Map<string, { service: CachedService; expiresAt: number }>();
  let receipt: StoredReceipt | null = null;
  let agentStop: AgentStop = idleStop();
  let policyBlob = emptyPolicy();
  let policyChain: Promise<unknown> = Promise.resolve();
  const webhooks = new Map<string, StoredWebhook>();
  const dashboards = new Map<string, { value: unknown; expiresAt: number }>();
  const nowOf = (now?: number) => now ?? clock();

  return {
    kind: "memory",
    async pushEvent(ev) {
      log.push(ev);
      if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
    },
    async recentEvents(limit) {
      return log.slice(-limit);
    },
    async getCurrent() {
      return current ? { ...current } : null;
    },
    async setCurrent(stream) {
      current = { ...stream };
    },
    async updateCurrent(id, stream) {
      if (!current || current.id !== id) return;
      current = { ...stream };
    },
    async markCurrentStopped(now) {
      if (!current || current.stopped) return;
      current = { ...current, stopped: nowOf(now) };
    },
    async clearDemo() {
      log.length = 0;
      current = null;
      receipt = null;
      agentStop = idleStop();
    },
    async tryLock(name, ttlSec, now) {
      const t = nowOf(now);
      const held = locks.get(name);
      if (held && held.expiresAt > t) return null;
      const lock = { token: crypto.randomUUID(), expiresAt: t + ttlSec * 1000 };
      locks.set(name, lock);
      return { token: lock.token };
    },
    async refreshLock(name, lock, ttlSec, now) {
      const t = nowOf(now);
      const held = locks.get(name);
      if (!held || held.token !== lock.token || held.expiresAt <= t) return false;
      held.expiresAt = t + ttlSec * 1000;
      return true;
    },
    async unlock(name, lock) {
      const held = locks.get(name);
      if (held?.token === lock.token) locks.delete(name);
    },
    async tryMarkClaimed(sid) {
      const t = clock();
      const exp = claims.get(sid);
      if (exp && exp > t) return false;
      claims.set(sid, t + CLAIM_TTL_SEC * 1000);
      return true;
    },
    async hasDrip(address) {
      return dripped.has(address);
    },
    async tryDrip(address, cap) {
      if (dripped.has(address)) return "dup";
      if (dripped.size >= cap) return "cap";
      dripped.add(address);
      return "ok";
    },
    async releaseDrip(address) {
      dripped.delete(address);
    },
    async tryStartRun(cooldownMs, ttlSec, now) {
      const t = nowOf(now);
      if (runningUntil > t) return { ok: false, msg: runningMsg };
      if (lastRun > 0 && t - lastRun < cooldownMs) return { ok: false, msg: coolMsg(cooldownMs - (t - lastRun)) };
      runningUntil = t + ttlSec * 1000;
      lastRun = t;
      return { ok: true };
    },
    async finishRun() {
      runningUntil = 0;
    },
    async getCachedService(id) {
      const hit = services.get(id);
      if (!hit || hit.expiresAt <= clock()) {
        if (hit) services.delete(id);
        return null;
      }
      return { ...hit.service };
    },
    async setCachedService(id, service, ttlSec) {
      services.set(id, { service: { ...service }, expiresAt: clock() + ttlSec * 1000 });
    },
    async isRunning(now) {
      return runningUntil > nowOf(now);
    },
    async getReceipt() {
      return receipt ? { ...receipt } : null;
    },
    async setReceipt(next) {
      receipt = next ? { ...next } : null;
    },
    async getAgentStop() {
      return { ...agentStop };
    },
    async setAgentStop(flags) {
      agentStop = { stop: flags.stop, closing: flags.closing };
    },
    async withPolicy(fn) {
      const run = policyChain.then(() => fn(policyBlob));
      policyChain = run.then(() => undefined, () => undefined);
      return run;
    },
    async getWebhook(serviceId) {
      const hit = webhooks.get(serviceId);
      return hit ? { ...hit } : null;
    },
    async putWebhook(serviceId, config) {
      if (!config) webhooks.delete(serviceId);
      else webhooks.set(serviceId, { ...config });
    },
    async getDashboard(address) {
      const hit = dashboards.get(address);
      if (!hit || hit.expiresAt <= clock()) {
        if (hit) dashboards.delete(address);
        return null;
      }
      return hit.value;
    },
    async setDashboard(address, value, ttlSec) {
      dashboards.set(address, { value, expiresAt: clock() + ttlSec * 1000 });
    },
    async resetSessionLocks() {
      locks.clear();
    },
  };
}

type RedisLike = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  rpush(key: string, value: unknown): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<unknown[]>;
  eval<T>(script: string, keys: string[], args: string[]): Promise<T>;
};

const START_RUN = `
local now = tonumber(ARGV[1])
local cool = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
if redis.call('EXISTS', KEYS[1]) == 1 then return 'running' end
local last = redis.call('GET', KEYS[2])
if last then
  local left = cool - (now - tonumber(last))
  if left > 0 then return 'cool:' .. tostring(left) end
end
redis.call('SET', KEYS[1], '1', 'EX', ttl)
redis.call('SET', KEYS[2], tostring(now), 'EX', '86400')
return 'ok'
`;

const REFRESH_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const UNLOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const DRIP = `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 'dup' end
if redis.call('SCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 'cap' end
redis.call('SADD', KEYS[1], ARGV[1])
return 'ok'
`;

const HAS_DRIP = `return redis.call('SISMEMBER', KEYS[1], ARGV[1])`;
const RELEASE_DRIP = `return redis.call('SREM', KEYS[1], ARGV[1])`;

function asReceipt(raw: unknown): StoredReceipt | null {
  const v = asJson(raw);
  if (!isRecord(v) || typeof v.secondsUsed !== "number" || typeof v.paid !== "string" || typeof v.refunded !== "string") return null;
  if (typeof v.tx !== "string" || typeof v.txUrl !== "string" || typeof v.chainId !== "number") return null;
  return { secondsUsed: v.secondsUsed, paid: v.paid, refunded: v.refunded, tx: v.tx, txUrl: v.txUrl, chainId: v.chainId };
}

function asStop(raw: unknown): AgentStop {
  const v = asJson(raw);
  if (!isRecord(v) || typeof v.stop !== "boolean" || typeof v.closing !== "boolean") return idleStop();
  return { stop: v.stop, closing: v.closing };
}

function asPolicy(raw: unknown): PolicyBlob {
  const v = asJson(raw);
  if (!isRecord(v) || !isRecord(v.policies) || !isRecord(v.ledgers) || !isRecord(v.sessions)) return emptyPolicy();
  return v as PolicyBlob;
}

function asWebhook(raw: unknown): StoredWebhook | null {
  const v = asJson(raw);
  if (!isRecord(v) || typeof v.url !== "string" || typeof v.secret !== "string" || typeof v.enabled !== "boolean") return null;
  if (typeof v.maxAttempts !== "number") return null;
  return { url: v.url, secret: v.secret, enabled: v.enabled, maxAttempts: v.maxAttempts };
}

function asJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw) as unknown; } catch { return raw; }
}

function redisFromEnv(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export function createRedisStore(redis: RedisLike, clock: Clock = Date.now): DemoStore {
  const k = (suffix: string) => P + suffix;
  return {
    kind: "redis",
    async pushEvent(ev) {
      await redis.rpush(k("log"), ev);
      await redis.ltrim(k("log"), -LOG_CAP, -1);
    },
    async recentEvents(limit) {
      const rows = await redis.lrange(k("log"), -limit, -1);
      return rows.map(asEvent).filter((ev): ev is DemoEvent => ev !== null);
    },
    async getCurrent() {
      return asStream(await redis.get(k("current")));
    },
    async setCurrent(stream) {
      await redis.set(k("current"), stream);
    },
    async updateCurrent(id, stream) {
      const cur = asStream(await redis.get(k("current")));
      if (!cur || cur.id !== id) return;
      await redis.set(k("current"), stream);
    },
    async markCurrentStopped(now) {
      const cur = asStream(await redis.get(k("current")));
      if (!cur || cur.stopped) return;
      await redis.set(k("current"), { ...cur, stopped: now ?? clock() });
    },
    async clearDemo() {
      await redis.del(k("log"));
      await redis.del(k("current"));
      await redis.del(k("receipt"));
      await redis.del(k("stop"));
    },
    async tryLock(name, ttlSec) {
      const token = crypto.randomUUID();
      const res = await redis.set(k("lock:" + name), token, { nx: true, ex: ttlSec });
      return res === "OK" ? { token } : null;
    },
    async refreshLock(name, lock, ttlSec) {
      const n = await redis.eval<number>(REFRESH_LOCK, [k("lock:" + name)], [lock.token, String(ttlSec)]);
      return Number(n) === 1;
    },
    async unlock(name, lock) {
      await redis.eval(UNLOCK, [k("lock:" + name)], [lock.token]);
    },
    async tryMarkClaimed(sid) {
      const res = await redis.set(k("claim:" + sid), "1", { nx: true, ex: CLAIM_TTL_SEC });
      return res === "OK";
    },
    async hasDrip(address) {
      const n = await redis.eval<number>(HAS_DRIP, [k("drip")], [address]);
      return Number(n) === 1;
    },
    async tryDrip(address, cap) {
      const slot = await redis.eval<string>(DRIP, [k("drip")], [address, String(cap)]);
      if (slot === "ok" || slot === "dup" || slot === "cap") return slot;
      throw new Error("drip slot");
    },
    async releaseDrip(address) {
      await redis.eval(RELEASE_DRIP, [k("drip")], [address]);
    },
    async tryStartRun(cooldownMs, ttlSec, now) {
      const result = await redis.eval<string>(START_RUN, [k("running"), k("lastRun")], [String(now ?? clock()), String(cooldownMs), String(ttlSec)]);
      if (result === "ok") return { ok: true };
      if (result === "running") return { ok: false, msg: runningMsg };
      if (result.startsWith("cool:")) return { ok: false, msg: coolMsg(Number(result.slice(5))) };
      throw new Error("run gate");
    },
    async finishRun() {
      await redis.del(k("running"));
    },
    async getCachedService(id) {
      return asService(await redis.get(k("reg:" + id)));
    },
    async setCachedService(id, service, ttlSec) {
      await redis.set(k("reg:" + id), service, { ex: ttlSec });
    },
    async isRunning() {
      return (await redis.get(k("running"))) != null;
    },
    async getReceipt() {
      return asReceipt(await redis.get(k("receipt")));
    },
    async setReceipt(receipt) {
      if (!receipt) await redis.del(k("receipt"));
      else await redis.set(k("receipt"), receipt);
    },
    async getAgentStop() {
      return asStop(await redis.get(k("stop")));
    },
    async setAgentStop(flags) {
      await redis.set(k("stop"), flags);
    },
    async withPolicy(fn) {
      const token = crypto.randomUUID();
      let locked = false;
      for (let i = 0; i < 8 && !locked; i++) {
        const res = await redis.set(k("lock:policy"), token, { nx: true, ex: 5 });
        if (res === "OK") locked = true;
        else await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (!locked) throw new Error("policy lock");
      try {
        const blob = asPolicy(await redis.get(k("policy")));
        const result = fn(blob);
        await redis.set(k("policy"), blob);
        return result;
      } finally {
        await redis.eval(UNLOCK, [k("lock:policy")], [token]);
      }
    },
    async getWebhook(serviceId) {
      return asWebhook(await redis.get(k("hook:" + serviceId)));
    },
    async putWebhook(serviceId, config) {
      if (!config) await redis.del(k("hook:" + serviceId));
      else await redis.set(k("hook:" + serviceId), config);
    },
    async getDashboard(address) {
      return asJson(await redis.get(k("dash:" + address)));
    },
    async setDashboard(address, value, ttlSec) {
      await redis.set(k("dash:" + address), value, { ex: ttlSec });
    },
    async resetSessionLocks() {
      return undefined;
    },
  };
}

export function createStoreFromEnv(clock?: Clock): DemoStore {
  const redis = redisFromEnv();
  if (!redis) return createMemoryStore(clock);
  return createRedisStore(redis, clock);
}

let singleton: DemoStore | undefined;

export function getStore(): DemoStore {
  singleton ??= createStoreFromEnv();
  return singleton;
}
