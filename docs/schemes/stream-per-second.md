# Scheme: `stream-per-second`

`stream-per-second` is a time-based [x402](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md) v2 scheme. The client locks a native deposit in `StreamEscrow`. The resource server meters the response for as long as that stream is active. When the client closes, the contract pays the provider `min(deposit, ratePerSec × elapsed)` and refunds the remainder in the same transaction.

It uses the standard x402 types and HTTP transport. It does not define a new handshake. Per-request payments stay on the `exact` scheme.

## Payment flow

x402 §6.1 defines an `escrow` flow: a first settlement locks a ceiling, the resource runs, a second settlement records the final charge. This scheme uses that flow with **client-submitted** settlement:

1. The resource server answers `402` with a `PaymentRequired` document (`PAYMENT-REQUIRED`, also mirrored on `X-PAYMENT-REQUIRED`).
2. The client checks the terms (pinned escrow, payee, rate, deposit cap) and calls `StreamEscrow.open(payTo, ratePerSec)` with a deposit of at least `amount`.
3. The client retries with `PAYMENT-SIGNATURE`: a `PaymentPayload` whose `payload` proves it owns the stream. Legacy `X-PAYMENT-STREAM` and `X-PAYMENT-SIG` carry the same proof.
4. The server reads the stream onchain, checks the signature, and serves a `text/event-stream` body. About once a second it re-reads the stream and cuts the response off when the stream is closed or the deposit is exhausted.
5. The client calls `StreamEscrow.close`. That transaction is the second settlement. The server does not broadcast it, so a successful resource response does not include `PAYMENT-RESPONSE`.

There is no facilitator `/verify` or `/settle` call. The escrow contract is the settlement layer. `extra.paymentFlow` is `escrow` so a generic client can see that funds move before the resource runs.

## `PaymentRequirements`

`amount` is the **minimum deposit** in atomic native units (wei of MON), not the final charge. The final charge is computed onchain at `close` and can be anything from `0` up to the deposit. `maxTimeoutSeconds` is the handshake window for opening the stream (default 120), not the metered session length. The session lasts until the deposit is exhausted or the client closes.

| Field | Required | Value |
|---|---|---|
| `scheme` | yes | `"stream-per-second"` |
| `network` | yes | CAIP-2, `eip155:<chainId>` (Monad testnet is `eip155:10143`) |
| `amount` | yes | Minimum deposit, atomic units. Equal to `extra.minDeposit`. |
| `asset` | yes | `0x0000000000000000000000000000000000000000` (chain native). `native:MON` is accepted when reading older bodies. |
| `payTo` | yes | Provider address. The stream's payee must match. |
| `maxTimeoutSeconds` | yes | Time allowed to open the stream and retry. |
| `extra.paymentFlow` | yes | `"escrow"` (x402 §6.1). |
| `extra.assetTransferMethod` | yes | `"stream-escrow"`. |
| `extra.escrow` | yes | `StreamEscrow` address the client must call. |
| `extra.ratePerSec` | yes | Wei per second, decimal string. |
| `extra.minDeposit` | yes | Minimum `msg.value` for `open`. Servers use `ratePerSec × 10` (ten seconds). |
| `extra.symbol` | no | `"MON"` for the native gas token. |
| `extra.publishableKey` | no | `pk_test_<serviceId>` when the service is in `ServiceRegistry`. |

`accepts[]` also echoes `ratePerSec`, `minDeposit`, `escrow`, `resource`, and `description` at the top level so the pre-v2 demo body still parses.

Example:

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "https://example.test/api/work",
    "description": "GPU session",
    "mimeType": "text/event-stream",
    "serviceName": "gpu"
  },
  "accepts": [{
    "scheme": "stream-per-second",
    "network": "eip155:10143",
    "amount": "10000000000000000",
    "asset": "0x0000000000000000000000000000000000000000",
    "payTo": "0x2222222222222222222222222222222222222222",
    "maxTimeoutSeconds": 120,
    "extra": {
      "paymentFlow": "escrow",
      "assetTransferMethod": "stream-escrow",
      "escrow": "0x51ff24a504b2f7446df1767fea43063d7dd525eb",
      "ratePerSec": "1000000000000000",
      "minDeposit": "10000000000000000",
      "symbol": "MON"
    }
  }]
}
```

## `PaymentPayload.payload`

| Field | Required | Description |
|---|---|---|
| `streamId` | yes | Decimal id returned by `open` (`Opened.id`). |
| `signature` | yes | 65-byte EIP-191 `personal_sign` over `x402-stream:<escrow lowercase>:<streamId>`. The recovered address must be the stream's payer. |

`accepted` is the `PaymentRequirements` entry the client selected. `x402Version` is `2`.

## Server verification

Before the response body starts, the server must:

1. Parse `PAYMENT-SIGNATURE`, or the legacy pair `X-PAYMENT-STREAM` + `X-PAYMENT-SIG`.
2. Reject a non-decimal stream id (`400`).
3. Read `streams(id)` and `isActive(id)` from `extra.escrow`. RPC failure fails closed (`503`).
4. `personal_sign` must recover to `streams.payer`. Otherwise `402`.
5. Allow one live response per stream id (`409` on a second one).
6. Require `isActive`, `payee == payTo`, `rate >= extra.ratePerSec`, and `deposit >= extra.minDeposit`. Otherwise `402` with the terms repeated.

While the body is open, re-read the stream about once a second. End it with an SSE `cutoff` event when the stream is inactive, when `now >= start + deposit/rate`, or after three failed reads in a row.

`owed` is not tracked offchain. The contract computes `min(deposit, ratePerSec × (end − start))` from block timestamps.

## Client obligations

- Pin `extra.escrow`. Do not open a stream on an address the 402 response invented.
- Cap `ratePerSec` and the deposit (`rate × depositSeconds`, raised to `amount` / `minDeposit`).
- Optionally allowlist `payTo`.
- Always `close`, including on error and on process interrupt. `close` is what refunds the unused deposit.

## Packages

The codec lives in `@streampay-402/protocol`. The buyer that performs steps 2–5 of the flow is `@streampay-402/client`. The server checks above are `@streampay-402/provider` (`streamPay`, `fetchStreamPay`, `expressStreamPay`). None of them are published to npm; they ship in this repository.
