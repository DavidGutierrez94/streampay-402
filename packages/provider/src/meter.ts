import type { ReadStream } from "./chain";

export type Produce = (index: number) => string | Promise<string>;
export type MeterStop = "exhausted" | "closed" | "unverifiable" | "aborted";

export interface MeterOptions {
  streamId: string;
  endAt: number;
  readStream: ReadStream;
  produce: Produce;
  tickMs?: number;
  recheckMs?: number;
  now?: () => number;
  sleep: (ms: number) => Promise<void>;
  write: (event: "token" | "cutoff", data: string) => Promise<void>;
  isAborted: () => boolean;
}

function sseData(data: string): string {
  return data.replace(/\r?\n/g, " ");
}

/** Meter one accepted stream. Re-reads the escrow about once a second and cuts off when it dies. */
export async function runMeter(options: MeterOptions): Promise<MeterStop> {
  const tickMs = options.tickMs ?? 250;
  const recheckMs = options.recheckMs ?? 1000;
  const now = options.now ?? Date.now;
  let index = 0;
  let lastCheck = 0;
  let failures = 0;
  while (!options.isAborted()) {
    const time = now();
    if (time >= options.endAt) {
      await options.write("cutoff", "exhausted");
      return "exhausted";
    }
    if (time - lastCheck > recheckMs) {
      lastCheck = time;
      const live = await options.readStream(BigInt(options.streamId)).catch(() => null);
      failures = live ? 0 : failures + 1;
      if (failures >= 3) {
        await options.write("cutoff", "unverifiable");
        return "unverifiable";
      }
      if (live && !live.active) {
        const reason = live.stoppedAt ? "closed" : "exhausted";
        await options.write("cutoff", reason);
        return reason;
      }
    }
    if (options.isAborted()) return "aborted";
    await options.write("token", sseData(await options.produce(index)));
    index += 1;
    await options.sleep(tickMs);
  }
  return "aborted";
}

export function formatSse(event: string, data: string): string {
  return `event: ${event}\ndata: ${sseData(data)}\n\n`;
}
