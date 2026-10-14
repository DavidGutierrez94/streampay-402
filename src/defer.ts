import { waitUntil } from "@vercel/functions";

const pending = new Set<Promise<void>>();

// Keep work alive after the response on Vercel (waitUntil). Locally the
// promise just runs; the Bun process does not freeze between requests.
export function defer(promise: Promise<unknown>): void {
  const tracked = promise.then(
    () => undefined,
    (err: unknown) => {
      console.log("[background]", err instanceof Error ? err.message : err);
    },
  );
  pending.add(tracked);
  tracked.finally(() => pending.delete(tracked));
  waitUntil(tracked);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});
