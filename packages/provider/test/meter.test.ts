import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import type { StreamView } from "@streampay-402/protocol";
import { runMeter } from "../src/meter";

const payer = "0x1111111111111111111111111111111111111111" as Address;
const payee = "0x2222222222222222222222222222222222222222" as Address;

function view(active: boolean, stoppedAt = 0): StreamView {
  return { payer, payee, rate: 1000n, deposit: 10_000n, start: 1, stoppedAt, active };
}

describe("runMeter", () => {
  test("emits tokens until the stream is closed, then cuts off", async () => {
    let reads = 0;
    const events: string[] = [];
    let time = 5_000;
    const stop = await runMeter({
      streamId: "1",
      endAt: 60_000,
      readStream: async () => {
        reads += 1;
        return reads < 3 ? view(true) : view(false, 9);
      },
      produce: (index) => `t${index}`,
      tickMs: 1,
      recheckMs: 1000,
      now: () => time,
      sleep: async () => { time += 2_000; },
      write: async (event, data) => { events.push(`${event}:${data}`); },
      isAborted: () => false,
    });
    expect(stop).toBe("closed");
    expect(events.filter((event) => event.startsWith("token:"))).toHaveLength(2);
    expect(events.at(-1)).toBe("cutoff:closed");
  });

  test("cuts off exhausted when the deposit window has passed", async () => {
    const events: string[] = [];
    const stop = await runMeter({
      streamId: "1",
      endAt: 1_000,
      readStream: async () => view(true),
      produce: () => "nope",
      now: () => 5_000,
      sleep: async () => {},
      write: async (event, data) => { events.push(`${event}:${data}`); },
      isAborted: () => false,
    });
    expect(stop).toBe("exhausted");
    expect(events).toEqual(["cutoff:exhausted"]);
  });

  test("fails closed after three unverifiable reads", async () => {
    const events: string[] = [];
    let time = 5_000;
    const stop = await runMeter({
      streamId: "1",
      endAt: 60_000,
      readStream: async () => null,
      produce: (index) => `t${index}`,
      recheckMs: 1000,
      now: () => time,
      sleep: async () => { time += 2_000; },
      write: async (event, data) => { events.push(`${event}:${data}`); },
      isAborted: () => false,
    });
    expect(stop).toBe("unverifiable");
    expect(events.at(-1)).toBe("cutoff:unverifiable");
  });
});
