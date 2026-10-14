# `@streampay-402/provider`

Drop-in middleware for the x402 [`stream-per-second`](../../docs/schemes/stream-per-second.md) scheme. No payment header yields `402` with a v2 `PaymentRequired` body (`PAYMENT-REQUIRED` and `X-PAYMENT-REQUIRED`). A valid stream yields a server-sent event body that stops when the escrow stream closes or the deposit runs out.

Not published to npm.

```json
{ "dependencies": { "@streampay-402/provider": "workspace:*" } }
```

Hono:

```typescript
import { Hono } from "hono";
import { paymentRequirements, streamPay } from "@streampay-402/provider";

const app = new Hono();
app.get("/api/work", streamPay({
  publicClient,
  escrow,
  terms: paymentRequirements({
    payTo, escrow, ratePerSec, chainId,
    resourceUrl: "/api/work",
    description: "GPU session",
  }),
  produce: (i) => `chunk ${i}`,
}));
```

Fetch (`Bun.serve`, workers, any `Request` → `Response` host):

```typescript
import { fetchStreamPay, paymentRequirements } from "@streampay-402/provider";

const handler = fetchStreamPay({ publicClient, escrow, terms });
Bun.serve({ fetch: handler, idleTimeout: 0 });
```

Express (structural `req`/`res`, Express is not a dependency):

```typescript
import { expressStreamPay } from "@streampay-402/provider";

app.use("/api/work", expressStreamPay({ publicClient, escrow, terms }));
```

Pass `readStream` instead of `publicClient` to test without a chain. `onAccept` runs once the stream is funded; `examples/provider.ts` uses it to `claimStream` mid-session.

The middleware accepts `PAYMENT-SIGNATURE` and the legacy `X-PAYMENT-STREAM` + `X-PAYMENT-SIG` pair. One live response per stream id. RPC failure on the initial read is `503`. Three failed re-reads during the body cut the stream off.
