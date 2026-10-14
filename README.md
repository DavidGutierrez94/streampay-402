# streampay-402 — per-second metering for x402, on Monad

**Pay while you use.** An x402 add-on scheme (`stream-per-second`) for agent services whose cost scales with *time*: GPU/inference sessions, voice minutes, browser sessions, live data feeds, long agent jobs.

## Problem
x402 nails pay-per-request. But time-based services still force a bad choice: prepaid credits (lock-up, leftover balances) or monthly plans (overpay). An agent that rents a GPU for 47 seconds should pay for 47 seconds — and get the rest back the instant it stops.

## How it works
1. Agent calls `GET /api/infer` → **HTTP 402** with an `X-PAYMENT-REQUIRED` header (base64 JSON, x402-style `accepts[]`) offering scheme `stream-per-second`: `payTo`, `escrow`, `ratePerSec`, `minDeposit`.
2. Agent calls `StreamEscrow.open(payee, ratePerSec)` with a capped deposit.
3. Agent retries with `X-PAYMENT-STREAM: <streamId>`. Server verifies the stream on-chain and starts streaming tokens.
4. Server re-checks `isActive` every second; when the deposit is exhausted the service is **cut off**.
5. Agent stops mid-task and calls `close()` → provider gets `rate × elapsed`, payer gets the remainder **in the same tx**.

Owed is computed purely from block timestamps: `owed = min(deposit, rate × (now − start))`. No signatures per tick, no off-chain vouchers.

## Why Monad
Per-second settlement only makes sense if blocks are fast and cheap enough that opening/closing a session costs less than a few seconds of service. Monad's ~400 ms blocks and sub-second finality make `open → use → close` feel instant, so the refund lands before the agent's next step.

## Positioning
Not a new protocol. A thin scheme on top of x402: same 402 handshake, same `accepts[]` shape, one extra scheme for time-metered resources. Per-request stays x402 `exact`; sessions use `stream-per-second`. EVM-generic (runs on any EVM chain).

## Deployment (Monad testnet, chainId 10143)
- StreamEscrow: `DEPLOYED_ADDRESS_TBD`
- Explorer: https://testnet.monadscan.com

## Run
```bash
bun install
cd contracts && forge test && forge build && cd ..
# .env: RPC_URL, CHAIN_ID=10143, PAYER_KEY, PAYEE_ADDRESS, (ESCROW_ADDRESS written by deploy)
bun src/deploy.ts          # deploys StreamEscrow, writes ESCROW_ADDRESS to .env
bun src/server.ts          # http://localhost:4020 dashboard + paid endpoint
bun src/agent.ts           # or click "Run agent" on the dashboard
```
Env knobs: `RATE_PER_SEC` (default 0.001 MON), `TASK_SECONDS` (agent stops after, default 12), `DEPOSIT_SECONDS` (budget, default 60).

Local: `anvil --block-time 1` with `RPC_URL=http://127.0.0.1:8545 CHAIN_ID=31337`.

## Demo script (90 s)
1. (0–15s) "Agents can pay per request with x402. But GPU, voice and inference sessions are billed by time." Show dashboard.
2. (15–30s) Click **Run agent**. Log shows `402 Payment Required` with stream terms.
3. (30–45s) Agent opens a stream on Monad — click the tx link to the explorer.
4. (45–70s) Tokens stream; the cost counter ticks up every 100 ms at 0.001 MON/s.
5. (70–85s) Agent finishes its task early and closes: provider paid for 12 s, the remaining deposit refunded in the same tx — click the close tx.
6. (85–90s) "Thin layer on x402. Pay while you use. Built on Monad."

## Files
- `contracts/src/StreamEscrow.sol` — escrow (open / owed / claim / close) + Foundry tests
- `src/server.ts` — Hono server: 402 terms, on-chain verification, metered SSE, cutoff, dashboard API
- `src/agent.ts` — autonomous agent client
- `web/index.html` — live per-second cost counter + explorer links

## Attribution
- [x402](https://x402.org) payment-required handshake (this repo adds a `stream-per-second` scheme on top; no x402 code vendored).
- [Foundry](https://getfoundry.sh), [viem](https://viem.sh), [Hono](https://hono.dev), [Bun](https://bun.sh).
- Monad testnet network info from [docs.monad.xyz](https://docs.monad.xyz).

## AI tools disclosure
Built during the Monad hackathon (Oct 13, 2026) with AI coding assistants (an AI agent wrote most of the code under the author's direction; architecture review with Claude). All code was reviewed and tested by the author.

## License
MIT — see [LICENSE](LICENSE).
