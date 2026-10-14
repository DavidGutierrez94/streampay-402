import { describe, expect, test } from "bun:test";
import { createMemoryStore, createRedisStore, createStoreFromEnv, type DemoStore } from "./store";

const svc = { owner: "0xabc", payee: "0xdef", ratePerSec: "1000", active: true, name: "gpu" };

describe("memory store", () => {
  test("keeps the demo log, trims it, and clears it", async () => {
    const store = createMemoryStore();
    for (let i = 0; i < 205; i++) await store.pushEvent({ t: i, kind: "k", msg: "m" + i });
    const last = await store.recentEvents(2);
    expect(last.map((ev) => ev.t)).toEqual([203, 204]);
    expect((await store.recentEvents(300)).length).toBe(200);
    await store.clearDemo();
    expect(await store.recentEvents(10)).toEqual([]);
  });

  test("current stream updates only the live id and marks stopped once", async () => {
    const store = createMemoryStore();
    const base = { id: "7", ratePerSec: "0.001", deposit: "0.06", start: 5, tokens: 1 };
    await store.setCurrent(base);
    await store.updateCurrent("7", { ...base, tokens: 4 });
    await store.updateCurrent("8", { ...base, id: "8", tokens: 9 });
    expect(await store.getCurrent()).toEqual({ ...base, tokens: 4 });
    await store.markCurrentStopped(50);
    await store.markCurrentStopped(80);
    expect((await store.getCurrent())?.stopped).toBe(50);
    await store.clearDemo();
    expect(await store.getCurrent()).toBeNull();
  });

  test("stream lock is exclusive until refresh expires or the owner unlocks", async () => {
    const store = createMemoryStore();
    const lock = await store.tryLock("infer:1", 10, 1_000);
    expect(lock).not.toBeNull();
    expect(await store.tryLock("infer:1", 10, 2_000)).toBeNull();
    expect(await store.refreshLock("infer:1", { token: "other" }, 10, 2_000)).toBe(false);
    expect(await store.refreshLock("infer:1", lock!, 10, 2_000)).toBe(true);
    expect(await store.tryLock("infer:1", 10, 11_999)).toBeNull();
    const next = await store.tryLock("infer:1", 10, 12_000);
    expect(next).not.toBeNull();
    await store.unlock("infer:1", next!);
    expect(await store.tryLock("infer:1", 10, 12_000)).not.toBeNull();
  });

  test("one claim per stream id", async () => {
    const store = createMemoryStore();
    expect(await store.tryMarkClaimed("4")).toBe(true);
    expect(await store.tryMarkClaimed("4")).toBe(false);
    expect(await store.tryMarkClaimed("5")).toBe(true);
  });

  test("drip list is one slot per address under the cap", async () => {
    const store = createMemoryStore();
    expect(await store.tryDrip("0xaaa", 2)).toBe("ok");
    expect(await store.hasDrip("0xaaa")).toBe(true);
    expect(await store.tryDrip("0xaaa", 2)).toBe("dup");
    expect(await store.tryDrip("0xbbb", 2)).toBe("ok");
    expect(await store.tryDrip("0xccc", 2)).toBe("cap");
    await store.releaseDrip("0xbbb");
    expect(await store.tryDrip("0xccc", 2)).toBe("ok");
  });

  test("run gate is single-flight and then cools down", async () => {
    const store = createMemoryStore();
    expect(await store.tryStartRun(30_000, 300, 10_000)).toEqual({ ok: true });
    expect(await store.tryStartRun(30_000, 300, 11_000)).toEqual({ ok: false, msg: "agent already running" });
    await store.finishRun();
    expect(await store.tryStartRun(30_000, 300, 20_000)).toEqual({ ok: false, msg: "cooling down, try again in 20s" });
    expect(await store.tryStartRun(30_000, 300, 40_000)).toEqual({ ok: true });
  });

  test("receipt, stop flag, policy, webhook, and dashboard cache round-trip", async () => {
    let t = 5_000;
    const store = createMemoryStore(() => t);
    const receipt = { secondsUsed: 3, paid: "1", refunded: "2", tx: "0xabc", txUrl: "https://example/tx", chainId: 10143 };
    await store.setReceipt(receipt);
    await store.setAgentStop({ stop: true, closing: true });
    expect(await store.getReceipt()).toEqual(receipt);
    expect(await store.getAgentStop()).toEqual({ stop: true, closing: true });
    const saved = await store.withPolicy((blob) => {
      blob.policies.key = { maxTotalSpend: "5", maxRatePerSec: null, maxSessionDuration: 2 };
      blob.ledgers.key = { spent: "1", reserved: "4" };
      return blob.policies.key.maxTotalSpend;
    });
    expect(saved).toBe("5");
    expect((await store.withPolicy((blob) => blob.ledgers.key)).reserved).toBe("4");
    await store.putWebhook("7", { url: "https://hooks.example/streampay", secret: "x".repeat(16), enabled: true, maxAttempts: 4 });
    expect((await store.getWebhook("7"))?.url).toBe("https://hooks.example/streampay");
    await store.setDashboard("0xabc", { snapshot: { address: "0xabc" } }, 20);
    expect(await store.getDashboard("0xabc")).toEqual({ snapshot: { address: "0xabc" } });
    t += 20_000;
    expect(await store.getDashboard("0xabc")).toBeNull();
    await store.clearDemo();
    expect(await store.getReceipt()).toBeNull();
    expect(await store.getAgentStop()).toEqual({ stop: false, closing: false });
    expect(await store.getWebhook("7")).not.toBeNull();
  });

  test("registry service cache expires", async () => {
    let t = 1_000;
    const store = createMemoryStore(() => t);
    await store.setCachedService("3", svc, 15);
    expect(await store.getCachedService("3")).toEqual(svc);
    t = 1_000 + 14_999;
    expect(await store.getCachedService("3")).toEqual(svc);
    t = 1_000 + 15_000;
    expect(await store.getCachedService("3")).toBeNull();
  });
});

describe("store backend", () => {
  test("memory when redis env is absent", () => {
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    expect(createStoreFromEnv().kind).toBe("memory");
  });

  test("redis when KV or UPSTASH rest env is set", () => {
    process.env.KV_REST_API_URL = "https://example.upstash.io";
    process.env.KV_REST_API_TOKEN = "token";
    try {
      expect(createStoreFromEnv().kind).toBe("redis");
    } finally {
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;
    }
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    try {
      expect(createStoreFromEnv().kind).toBe("redis");
    } finally {
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
    }
  });
});

describe("redis adapter", () => {
  test("claim, drip, and run gate use shared keys", async () => {
    const calls: { op: string; args: unknown[] }[] = [];
    let claimPuts = 0;
    const redis = {
      async get() { return null; },
      async set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) {
        calls.push({ op: "set", args: [key, value, opts] });
        if (key.includes(":claim:")) {
          claimPuts++;
          return claimPuts === 1 ? "OK" : null;
        }
        return "OK";
      },
      async del(key: string) { calls.push({ op: "del", args: [key] }); return 1; },
      async rpush(key: string, value: unknown) { calls.push({ op: "rpush", args: [key, value] }); return 1; },
      async ltrim() { return "OK"; },
      async lrange() { return [{ t: 1, kind: "open", msg: "hi" }]; },
      async eval<T>(script: string, keys: string[], args: string[]): Promise<T> {
        calls.push({ op: "eval", args: [keys, args, script.slice(0, 24)] });
        if (script.includes("return 'dup'")) return "ok" as T;
        if (script.includes("EXISTS")) return "running" as T;
        return 1 as T;
      },
    };
    const store: DemoStore = createRedisStore(redis);
    expect(await store.tryMarkClaimed("9")).toBe(true);
    expect(await store.tryMarkClaimed("9")).toBe(false);
    expect(calls.some((c) => c.op === "set" && c.args[0] === "sp:v1:claim:9")).toBe(true);
    expect(await store.tryDrip("0xabc", 100)).toBe("ok");
    expect(await store.tryStartRun(30_000, 300, 5)).toEqual({ ok: false, msg: "agent already running" });
    expect(await store.recentEvents(40)).toEqual([{ t: 1, kind: "open", msg: "hi" }]);
    await store.setReceipt({ secondsUsed: 1, paid: "1", refunded: "0", tx: "0x1", txUrl: "u", chainId: 1 });
    await store.setAgentStop({ stop: true, closing: false });
    await store.putWebhook("7", { url: "https://hooks.example", secret: "secret-secret-secret", enabled: true, maxAttempts: 3 });
    await store.setDashboard("0xabc", { snapshot: true }, 20);
    await store.withPolicy((blob) => { blob.policies.k = { maxTotalSpend: null, maxRatePerSec: null, maxSessionDuration: null }; });
    expect(calls.some((c) => c.op === "set" && c.args[0] === "sp:v1:receipt")).toBe(true);
    expect(calls.some((c) => c.op === "set" && c.args[0] === "sp:v1:stop")).toBe(true);
    expect(calls.some((c) => c.op === "set" && c.args[0] === "sp:v1:hook:7")).toBe(true);
    expect(calls.some((c) => c.op === "set" && c.args[0] === "sp:v1:dash:0xabc")).toBe(true);
    expect(calls.some((c) => c.op === "set" && c.args[0] === "sp:v1:policy")).toBe(true);
    await store.finishRun();
    expect(calls.some((c) => c.op === "del" && c.args[0] === "sp:v1:running")).toBe(true);
  });
});
