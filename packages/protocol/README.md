# `@streampay-402/protocol`

Shared types and HTTP codec for the x402 `stream-per-second` scheme. The scheme itself is specified in [docs/schemes/stream-per-second.md](../../docs/schemes/stream-per-second.md).

This package is private. It is not published to npm. Depend on it from the workspace:

```json
{ "dependencies": { "@streampay-402/protocol": "workspace:*" } }
```

`paymentRequirements` builds an x402 v2 `PaymentRequirements` object (`scheme`, CAIP-2 `network`, `amount` = minimum deposit, `extra.paymentFlow = "escrow"`). `normalizePaymentRequired` also accepts the older demo body where `ratePerSec`, `escrow`, and `minDeposit` sit on the `accepts[]` entry. `PAYMENT-SIGNATURE` and the legacy `X-PAYMENT-STREAM` / `X-PAYMENT-SIG` headers decode through `readPaymentProof`.
