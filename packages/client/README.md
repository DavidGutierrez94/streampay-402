# `@streampay-402/client`

Buyer SDK for the x402 [`stream-per-second`](../../docs/schemes/stream-per-second.md) scheme. A `fetch` that gets `402` opens a `StreamEscrow` stream, retries with `PAYMENT-SIGNATURE` (and the legacy stream headers), and can close the stream when you stop reading.

Not published to npm. From this repo:

```json
{ "dependencies": { "@streampay-402/client": "workspace:*" } }
```

```typescript
import { StreamPayClient } from "@streampay-402/client";

const client = new StreamPayClient({
  escrow: "0x51ff24a504b2f7446df1767fea43063d7dd525eb",
  chain,                 // viem Chain
  privateKey,            // or pass account + walletClient + publicClient
  maxRatePerSec: parseEther("0.001"),
  maxDeposit: parseEther("0.1"),
  depositSeconds: 30,    // deposit = rate × seconds, raised to the server minimum
  trustedPayees: [payee],
  onTerms(terms) {       // throw to refuse before open()
    if (terms.extra.ratePerSec !== expected) throw new Error("rate mismatch");
  },
});

const { result, close } = await client.withStream(url, async (session) => {
  return session.response.text();
});
// close.paidToPayee, close.refunded, close.hash
```

`withStream` closes on success and on throw. `fetch` returns a `PaidSession` whose `close()` is idempotent and safe to call from `finally` or `SIGINT`. `await using` works too (`Symbol.asyncDispose`).

The client refuses a 402 whose `extra.escrow` is not the pinned escrow. It speaks both the v2 body and the original demo body (`accepts[0].ratePerSec` / `escrow` / `minDeposit`).

`examples/agent.ts` is this SDK against a registry service.
