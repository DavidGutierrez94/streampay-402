// Buyer agent: bun run agent <serviceId | pk_test_N> [url]
// discovers the service in the ServiceRegistry -> hits endpoint -> 402 -> opens escrow stream on Monad
// -> retries with payment headers -> consumes N seconds -> closes -> refund. Prints monadscan links.
import { formatEther, getAddress, parseEther } from "viem";
import { StreamPayClient } from "@streampay-402/client";
import { chain, pub, txUrl, wallet } from "../src/chain";
import { REGISTRY, parsePk, readService } from "../src/registry";

const arg = process.argv[2] ?? "";
const id = arg.startsWith("pk_") ? parsePk(arg) : /^\d+$/.test(arg) ? BigInt(arg) : null;
if (id === null) throw new Error("usage: bun run agent <serviceId|pk_test_N> [url]");
const SERVER = process.env.SERVER ?? "http://localhost:4020";
const URL_ = process.argv[3] ?? `${SERVER}/api/svc/${id}`;
const SECONDS = Number(process.env.TASK_SECONDS ?? 8);
const DEPOSIT_SECONDS = BigInt(process.env.DEPOSIT_SECONDS ?? 30);
const MAX_RATE = parseEther(process.env.MAX_RATE_PER_SEC ?? "0.001");
const ESCROW = getAddress(process.env.ESCROW_ADDRESS!);
const w = wallet(process.env.PAYER_KEY!);

const svc = await readService(id);
if (!svc.active) throw new Error(`service #${id} inactive`);
console.log(`registry ${REGISTRY}: service #${id} "${svc.name}" ${formatEther(svc.ratePerSec)} MON/s -> ${svc.payee}`);

const client = new StreamPayClient({
  escrow: ESCROW,
  chain,
  account: w.account,
  walletClient: w,
  publicClient: pub,
  maxRatePerSec: MAX_RATE,
  maxDeposit: process.env.MAX_DEPOSIT ? parseEther(process.env.MAX_DEPOSIT) : undefined,
  trustedPayees: [getAddress(svc.payee)],
  depositSeconds: DEPOSIT_SECONDS,
  onTerms(terms) {
    console.log(`402 Payment Required: ${terms.scheme} ${terms.extra.ratePerSec} wei/s, payTo ${terms.payTo}`);
    if (getAddress(terms.payTo) !== getAddress(svc.payee) || BigInt(terms.extra.ratePerSec) !== svc.ratePerSec) {
      throw new Error("402 terms do not match registry");
    }
  },
});

const session = await client.fetch(URL_);
if (!session.terms || !session.openHash) throw new Error("expected 402");
console.log(`open   stream #${session.streamId}, deposit ${formatEther(session.deposit)} MON  ${txUrl(session.openHash)}`);

let reported = false;
const finish = async () => {
  const closed = await session.close();
  if (reported || !closed.hash) return;
  reported = true;
  console.log(`close  paid ${formatEther(closed.paidToPayee)} MON, refunded ${formatEther(closed.refunded)} MON  ${txUrl(closed.hash)}`);
};
process.once("SIGINT", () => { void finish().finally(() => process.exit(130)); });

try {
  const reader = session.response.body?.getReader();
  if (!reader) throw new Error("no response body");
  const dec = new TextDecoder();
  const started = Date.now();
  let chunks = 0;
  while (Date.now() - started < SECONDS * 1000) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks += [...dec.decode(value).matchAll(/event: token/g)].length;
  }
  await reader.cancel().catch(() => {});
  console.log(`consumed ${SECONDS}s of service (${chunks} metered chunks), stopping`);
} finally {
  await finish();
}
