import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

// chain.ts loads the Foundry artifact at import. Tests only need the module to evaluate.
const artifact = "contracts/out/StreamEscrow.sol/StreamEscrow.json";
const createdArtifact = !existsSync(artifact);
if (createdArtifact) {
  mkdirSync("contracts/out/StreamEscrow.sol", { recursive: true });
  writeFileSync(artifact, JSON.stringify({ abi: [], bytecode: { object: "0x" } }));
}
afterAll(() => { if (createdArtifact) rmSync(artifact); });

const { default: server } = await import("./server.ts");

async function hit(path: string, method = "GET") {
  return server.fetch(new Request(`http://localhost${path}`, { method }));
}

test("stop with no active stream does not invent a receipt", async () => {
  const res = await hit("/api/stop-agent", "POST");
  expect(res.status).toBe(409);
  const body = await res.json() as { ok: boolean; msg: string; receipt?: unknown };
  expect(body).toEqual({ ok: false, msg: "No active stream" });
});

test("state includes the running flag and an empty receipt", async () => {
  const body = await (await hit("/api/state")).json() as { running: boolean; receipt: unknown; log: unknown[] };
  expect(body.running).toBe(false);
  expect(body.receipt).toBeNull();
  expect(Array.isArray(body.log)).toBe(true);
});

test("agent stop flag starts clear", async () => {
  const body = await (await hit("/api/agent-stop")).json() as { stop: boolean; closing: boolean };
  expect(body).toEqual({ stop: false, closing: false });
});

test("demo page includes the stop control and receipt", async () => {
  const html = await (await hit("/demo")).text();
  expect(html).toContain(">Stop agent<");
  expect(html).toContain("Seconds used");
  expect(html).toContain("Amount paid");
  expect(html).toContain("Unused escrow refunded");
  expect(html).toContain("Monad testnet");
  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  expect(visible).not.toMatch(/privy|stripe|monadscan/i);
});
