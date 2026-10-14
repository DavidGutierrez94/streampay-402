# streampay-402 — submission (Consumer Products & Payments)

## Description (150 words)
streampay-402 lets AI agents pay by the second for time-based services: GPU and inference sessions, voice minutes, browser sessions, live data feeds. x402 solved pay-per-request; time-billed services still force agents into prepaid credits that strand balances or monthly plans that overcharge. streampay-402 is a thin x402 add-on, not a new protocol. An agent calls a paid endpoint and receives HTTP 402 with `stream-per-second` terms. It opens a capped escrow on Monad, and the provider streams the service while verifying the balance on-chain every second. When funds run out, service stops automatically. When the agent finishes early, it closes the stream: the provider receives rate × elapsed and the agent's unused deposit is refunded in the same transaction. Accounting comes straight from block timestamps, with no per-tick signatures or off-chain vouchers. Monad's fast, cheap blocks make opening and closing a session cost less than a few seconds of service, so per-second billing becomes practical for consumers and agents.

## On-chain proof (Monad testnet, chainId 10143)
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

## 3-minute technical demo
1. **0:00–0:20 — Problem.** Dashboard on screen. "x402 lets agents pay per request. But GPU, voice and inference are billed by time. Today that means prepaid credits or subscriptions."
2. **0:20–0:45 — Contract.** Show `StreamEscrow.sol`: `open(payee, rate)` payable, `owed = min(deposit, rate × elapsed)`, `close()` pays provider and refunds payer atomically. Show `forge test` passing (11 tests incl. audit H-1 PoCs).
3. **0:45–1:10 — 402 handshake.** `curl -i localhost:4020/api/infer` → `402 Payment Required` + `X-PAYMENT-REQUIRED` header (x402-style `accepts[]`, scheme `stream-per-second`, escrow, payTo, ratePerSec).
4. **1:10–1:40 — Agent opens stream.** Click **Run agent**. Log: plan → `open` tx. Click the tx link → Monad testnet explorer shows deposit to escrow.
5. **1:40–2:15 — Metered service.** Tokens stream; cost counter ticks at 0.001 MON/s; server re-checks `isActive` on-chain every second.
6. **2:15–2:40 — Stop + refund.** Agent finishes early, calls `close`. Log shows paid vs refunded; click the close tx on explorer: two internal transfers in one tx.
7. **2:40–3:00 — Cutoff + Monad.** Re-run with a tiny budget: server logs "balance exhausted → service cut off". "Monad's fast blocks make open → use → close feel instant. Same scheme drops into any x402 server."

## 2-minute pitch
- **(0:00) Hook.** "Your agent rents a GPU for 47 seconds. Why does it pay for an hour, or prepay credits it never gets back?"
- **(0:20) Problem.** The agent economy is moving to x402 for per-request payments. But the most expensive things agents buy — inference, GPU, voice, browser sessions — are billed by time. Credits strand money; subscriptions overcharge; neither works for an autonomous agent with a budget.
- **(0:45) Solution.** streampay-402: one new x402 scheme, `stream-per-second`. Same 402 handshake. The agent opens a capped escrow, uses the service, and stops whenever it wants. The provider is paid exactly rate × seconds; the rest comes back in the same transaction.
- **(1:10) Why Monad.** Per-second billing only works if opening and closing a session is cheaper and faster than a few seconds of service. Monad's fast blocks and low fees make that true.
- **(1:30) Market + next.** Providers of inference, voice and GPU get pay-as-you-go without card rails or chargebacks; agents get hard budget caps. Next: ERC-20 stablecoins (USDC), an x402 facilitator plugin, and LatAm pay-per-call services.
- **(1:50) Close.** "x402 lets agents pay. streampay-402 lets them pay while they use."
