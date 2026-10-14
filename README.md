# streampay-402 — per-second metering for x402, on Monad

**Pay while you use.** An x402 add-on scheme (`stream-per-second`) for agent services whose cost scales with *time*: GPU/inference sessions, voice minutes, browser sessions, live data feeds, long agent jobs.

**Live demo:** https://calgary-creativity-creations-courier.trycloudflare.com (landing / dashboard) · sign-up: https://calgary-creativity-creations-courier.trycloudflare.com/onboard
**Videos:** Technical demo: `TODO_DEMO_VIDEO_URL` · Pitch: `TODO_PITCH_VIDEO_URL`
**Track:** Monad Metropolis, Consumer Products & Payments

## Deployed contracts (Monad testnet, chainId 10143)
| Contract | Address | Deploy tx |
|---|---|---|
| StreamEscrow v2 (audited) | [`0x51ff24a504b2f7446df1767fea43063d7dd525eb`](https://testnet.monadscan.com/address/0x51ff24a504b2f7446df1767fea43063d7dd525eb) | [0x560162f0…67b0](https://testnet.monadscan.com/tx/0x560162f0c520ae4fee2e65e886518bbc032639e4aea144a8e4ad6147dfd567b0) |
| ServiceRegistry | [`0xdaeddd6a68bbea02c58dd0349797e8847c3fa797`](https://testnet.monadscan.com/address/0xdaeddd6a68bbea02c58dd0349797e8847c3fa797) | [0x8ec2e134…fc75](https://testnet.monadscan.com/tx/0x8ec2e134564dda5a1a3dfd6ed0115aa770ab62c2a2650397a60feba9cf5ffc75) |
| StreamEscrow v1 (superseded) | `0xda46725e9559d87963349570da491a8f08547d27` | n/a |

## Architecture
```
Provider ──Privy email login → embedded wallet──► ServiceRegistry (Monad): registerService(name, rate, payee, keccak(sk))
                                                    └─► pk_test_<id> / sk_test_… keys
Agent ──GET /api/infer──► Hono server ──402 + X-PAYMENT-REQUIRED (stream-per-second)──► Agent
Agent ──open(payee, rate){deposit}──► StreamEscrow (Monad)
Agent ──retry w/ X-PAYMENT-STREAM + X-PAYMENT-SIG──► server verifies onchain every 1 s, streams SSE, cuts off at exhaustion
Agent ──close()──► payee gets rate×elapsed, payer refunded in same tx
```
Stack: Solidity + Foundry, Bun + Hono, viem, Privy (React SDK, embedded wallets), x402-style 402 headers.

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
- StreamEscrow (v2, audited + H-1 fixed): [`0x51ff24a504b2f7446df1767fea43063d7dd525eb`](https://testnet.monadscan.com/address/0x51ff24a504b2f7446df1767fea43063d7dd525eb)
- Deploy tx: [0x560162f0…67b0](https://testnet.monadscan.com/tx/0x560162f0c520ae4fee2e65e886518bbc032639e4aea144a8e4ad6147dfd567b0)
- Superseded v1 (pre-audit, do not use): `0xda46725e9559d87963349570da491a8f08547d27`

### Live end-to-end run (stream #1, 0.001 MON/s, 0.06 MON budget, agent stopped after 12 s)
| Step | Tx |
| --- | --- |
| Agent opens stream (0.06 MON deposit) | [0x0eafb210…8a34](https://testnet.monadscan.com/tx/0x0eafb210830a49f1eb29f91d9957118be359d1aea856c1d75a2aed018bea8a34) |
| Provider claims accrued earnings mid-stream | [0xccd1ef4f…f4ce](https://testnet.monadscan.com/tx/0xccd1ef4f6784503bca980e3bd1343b551adc2284f63b86ceb18aeebaa0e5f4ce) |
| Agent closes: 0.007 MON more to provider, 0.047 MON refunded in the same tx | [0x74135092…8dfe](https://testnet.monadscan.com/tx/0x74135092040817f4d1f82037045790f3e47795c5489f6d35fea9cd1448c78dfe) |

## Security
Audited (manual review, Oct 13 2026) — full report in [AUDIT.md](AUDIT.md). Fixed before submission:
- **H-1** `close()` can no longer be blocked by the payee: payee leg is gas-capped (30k, no returndata copy) and falls back to pull-payment `credit` + `withdraw()`; the payer refund always lands. Redeployed as v2; tests cover reverting, gas-burning and reentrant payees plus a conservation fuzz (11 tests).
- **H-2** stream bound to requester: payer signs `x402-stream:<escrow>:<id>` (`X-PAYMENT-SIG`), one live session per stream.
- **H-3** agent pins the escrow, allowlists payees, caps rate (`MAX_RATE_PER_SEC`) and deposit (`MAX_DEPOSIT`).
- **M-1** agent always closes (try/finally + SIGINT). **M-2** server fails closed on RPC errors (503 / cutoff after 3 failed checks) and cuts off locally at deposit exhaustion. **M-3** `/api/log` requires `DEMO_TOKEN`, inputs validated, dashboard escapes all output; `/api/run-agent` has a 30 s cooldown. **M-4** one provider claim per stream. **L-1** payee key stripped from the agent process. **L-2/L-4** `minDeposit` enforced, stream id validated.
- Known/accepted for the demo: L-3 timestamp granularity (whole seconds); `claim` still requires the payee key (hot key on server).

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
Security knobs: `DEMO_TOKEN` (random; protects `/api/log`), `MAX_RATE_PER_SEC` (default 0.001), `MAX_DEPOSIT` (default 0.1 MON), `TRUSTED_PAYEES` (comma list; defaults to `PAYEE_ADDRESS`), `RUN_COOLDOWN_MS` (default 30000).

Local: `anvil --block-time 1` with `RPC_URL=http://127.0.0.1:8545 CHAIN_ID=31337`.

## Demo script (90 s)
1. (0–15s) "Agents can pay per request with x402. But GPU, voice and inference sessions are billed by time." Show dashboard.
2. (15–30s) Click **Run agent**. Log shows `402 Payment Required` with stream terms.
3. (30–45s) Agent opens a stream on Monad — click the tx link to the explorer.
4. (45–70s) Tokens stream; the cost counter ticks up every 100 ms at 0.001 MON/s.
5. (70–85s) Agent finishes its task early and closes: provider paid for 12 s, the remaining deposit refunded in the same tx — click the close tx.
6. (85–90s) "Thin layer on x402. Pay while you use. Built on Monad."

## Files
- `contracts/src/StreamEscrow.sol` — escrow (open / owed / claim / close / withdraw) + Foundry tests
- `AUDIT.md` — security audit report
- `src/server.ts` — Hono server: 402 terms, on-chain verification, metered SSE, cutoff, dashboard API
- `src/agent.ts` — autonomous agent client
- `web/index.html` — live per-second cost counter + explorer links

## Attribution
- [x402](https://x402.org) payment-required handshake (this repo adds a `stream-per-second` scheme on top; no x402 code vendored).
- [Foundry](https://getfoundry.sh), [viem](https://viem.sh), [Hono](https://hono.dev), [Bun](https://bun.sh).
- [Privy](https://privy.io) auth + embedded wallets (`@privy-io/react-auth`).
- [impeccable](https://github.com/pbakaus/impeccable) design skill for Claude Code.
- Monad testnet network info from [docs.monad.xyz](https://docs.monad.xyz).

## AI tools disclosure
Built during the Metropolis build window with AI assistance, under the author's direction:
- **Grok Bot** (AI agent): wrote most of the code, contracts, deploy scripts and docs.
- **Claude Code (Opus)**: UI/design pass (with the `impeccable` design skill) and the security audit in [AUDIT.md](AUDIT.md).
All code was reviewed and tested by the author (David Gutierrez); onchain results are verifiable on monadscan.

## License
MIT — see [LICENSE](LICENSE).

## Onboarding (onchain sign-up + API keys)
Privy email sign-up → embedded wallet → `ServiceRegistry` on Monad testnet → `pk_test_` / `sk_test_` keys. See [ONBOARDING.md](ONBOARDING.md). Live at `/onboard`.
